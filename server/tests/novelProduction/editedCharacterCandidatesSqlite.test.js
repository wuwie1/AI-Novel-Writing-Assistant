const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {initializeTemporarySqliteDatabase} = require('../testInfrastructure/tempSqliteDatabase.cjs');

test('edited prose replaces obsolete candidate gates in projections and both recovery engines without approving history', () => {
  const server = path.resolve(__dirname, '../..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edited-v2-candidates-'));
  const databaseUrl = initializeTemporarySqliteDatabase(dir, 'test.db');
  const script = path.join(dir, 'check.cjs');
  fs.writeFileSync(script, String.raw`
const assert = require('node:assert/strict');
const path = require('node:path');
const load = p => require(path.join(process.env.TEST_SERVER_ROOT, 'dist', p));
const {prisma} = load('db/prisma');
const {DirectorCharacterCandidateService} = load('services/novel/characters/candidates');
const {chapterArtifactDeltaOutputSchema} = load('prompting/prompts/novel/chapterArtifactDelta.prompts');
const {buildChapterArtifactContentHash: hash} = load('services/novel/runtime/artifactSync/ChapterArtifactContentVersion');
const {resumeBusiness} = load('app/director/savedContent');
const {assertKernelCharacterReviewsResolved} = load('app/director/productionKernel/recovery/characterReviews');
load('prompting/core/promptRunner').runStructuredPrompt = async () => {throw Error('No model calls allowed');};
const service = new DirectorCharacterCandidateService();
const original = '阵仆在门外守候。';
const revised = '阵仆在门外守候。母亲握住孩子的小手。';
const contract = {runId: 'run', novelId: 'book', driver: 'assisted', executionEpoch: 2,
  chapterRange: {from: 1, to: 1}, issuePolicy: {mode: 'completion_first'}};
const output = chapterArtifactDeltaOutputSchema.parse({summary: '母亲救子', stateDeltas: {},
  syncPlan: {reason: '正文回填'}, characterCandidates: [{proposedName: '阵仆', evidence: ['阵仆在门外守候。'],
    identityDecision: 'defer', decisionReason: '身份未明确'}], confidence: .9});
const baseInput = {novelId: 'book', chapterId: 'chapter', directorRunId: 'run'};
async function pausedJob(oldId) {
  const payload = JSON.stringify({directorNext: {runId: 'run', decisions: [], pendingCharacterReviewId: oldId}});
  await prisma.generationJob.upsert({where: {id: 'job'},
    create: {id: 'job', novelId: 'book', startOrder: 1, endOrder: 1, status: 'queued', pendingManualRecovery: true, payload},
    update: {pendingManualRecovery: true, payload}});
}
async function bothBlocked(pattern) {
  await assert.rejects(prisma.$transaction(tx => resumeBusiness(contract, tx)), pattern);
  await assert.rejects(prisma.$transaction(tx => assertKernelCharacterReviewsResolved(tx, contract)), pattern);
  assert.equal((await prisma.generationJob.findUniqueOrThrow({where: {id: 'job'}})).pendingManualRecovery, true);
}
(async () => {try {
  await prisma.novel.create({data: {id: 'book', title: '作者的书', description: '既有设定', directorVersion: 'v2', directorEpoch: 2}});
  await prisma.chapter.create({data: {id: 'chapter', novelId: 'book', order: 1, title: '第一章', content: original,
    taskSheet: '既有任务', sceneCards: '既有场景'}});
  await prisma.character.create({data: {id: 'mother', novelId: 'book', name: '母亲', role: '配角', background: '既有人设'}});
  await prisma.directorNextRun.create({data: {id: 'run', novelId: 'book', driver: 'assisted', planVersion: 'test', contractJson: JSON.stringify(contract)}});
  await prisma.directorNextRunControl.create({data: {runId: 'run', novelId: 'book', status: 'running'}});
  await assert.rejects(service.prepare({...baseInput, content: original}, output), {name: 'CharacterCandidateReviewRequiredError'});
  const oldReview = (await service.read('run')).reviews[0];
  const oldRow = await prisma.chapterArtifactSyncCheckpoint.findUniqueOrThrow({where: {id: oldReview.id}});
  await pausedJob(oldReview.id);
  await prisma.directorNextEvent.create({data: {id: 'binding', runId: 'run', seq: 1, type: 'chapter_batch_job', payloadJson: JSON.stringify({jobId: 'job'})}});
  await prisma.directorNextRunControl.update({where: {runId: 'run'}, data: {status: 'paused'}});
  await prisma.chapter.update({where: {id: 'chapter'}, data: {content: revised}});
  const controlBefore = await prisma.directorNextRunControl.findUniqueOrThrow({where: {runId: 'run'}});
  assert.deepEqual((await service.read('run')).reviews, [], 'old prose cannot produce a visible pending review');
  await bothBlocked(/尚未同步/);
  await assert.rejects(service.resolve('run', {reviewId: oldReview.id, revision: oldReview.revision,
    contentHash: oldReview.contentHash, decisions: [{candidateId: oldReview.items[0].id, action: 'ignore'}]}), /正文已修改/);
  // Model extraction for a manual edit is authorized while the director stays paused.
  const revision = 'author-revision';
  const metadataJson = JSON.stringify({...baseInput, contentHash: hash(revised), revision, attemptId: 'attempt'});
  const marker = await prisma.chapterArtifactSyncCheckpoint.create({data: {novelId: 'book', chapterId: 'chapter',
    contentHash: hash(revised), artifactType: 'manual_chapter_sync:v1', syncMode: 'manual', status: 'running', metadataJson}});
  await assert.rejects(service.prepare({...baseInput, content: revised, manualRevision: revision,
    revisionGuard: {id: marker.id, metadataJson, novel: {directorVersion: 'v2', directorEpoch: 2}}}, output),
    {name: 'CharacterCandidateReviewRequiredError'});
  let page = await service.read('run');
  assert.equal(page.reviews.length, 1);
  const current = page.reviews[0];
  assert.notEqual(current.id, oldReview.id);
  assert.equal(current.contentHash, hash(revised));
  assert.equal(current.blocking, true);
  await bothBlocked(/先确认本章人物/);
  await service.resolve('run', {reviewId: current.id, revision: current.revision, contentHash: current.contentHash,
    decisions: [{candidateId: current.items[0].id, action: 'ignore'}]});
  const afterConfirmation = await prisma.directorNextRunControl.findUniqueOrThrow({where: {runId: 'run'}});
  assert.equal(afterConfirmation.status, controlBefore.status);
  assert.equal(afterConfirmation.version, controlBefore.version);
  await prisma.$transaction(tx => assertKernelCharacterReviewsResolved(tx, contract));
  await prisma.$transaction(tx => resumeBusiness(contract, tx));
  const job = await prisma.generationJob.findUniqueOrThrow({where: {id: 'job'}});
  assert.equal(job.pendingManualRecovery, false);
  assert.equal(JSON.parse(job.payload).directorNext.pendingCharacterReviewId, undefined);
  assert.deepEqual(await prisma.chapterArtifactSyncCheckpoint.findUniqueOrThrow({where: {id: oldReview.id}}), oldRow,
    'historical pending decisions are neither deleted nor implicitly approved');
  page = await service.read('run');
  assert.equal(page.reviews.length, 1);
  assert.equal(page.reviews[0].blocking, false);
  assert.equal(await prisma.characterCandidate.count({where: {novelId: 'book'}}), 2);
  assert.equal(await prisma.character.count({where: {novelId: 'book'}}), 1);
  assert.equal((await prisma.character.findUniqueOrThrow({where: {id: 'mother'}})).background, '既有人设');
  const chapter = await prisma.chapter.findUniqueOrThrow({where: {id: 'chapter'}});
  assert.equal(chapter.content, revised); assert.equal(chapter.taskSheet, '既有任务'); assert.equal(chapter.sceneCards, '既有场景');
  // A later revision can intentionally have no candidates. Neither a missing review
  // nor an old or degraded boundary alone is sufficient permission to continue.
  const noCandidates = '母亲抱着孩子入睡。';
  await prisma.chapter.update({where: {id: 'chapter'}, data: {content: noCandidates}});
  await pausedJob(oldReview.id);
  await prisma.chapterArtifactSyncCheckpoint.create({data: {novelId: 'book', chapterId: 'chapter', contentHash: hash(revised),
    artifactType: 'artifact_sync_boundary:v1', syncMode: 'manual:old', status: 'succeeded', metadataJson: JSON.stringify({outcome: 'completed'})}});
  await bothBlocked(/尚未同步/);
  const boundary = await prisma.chapterArtifactSyncCheckpoint.create({data: {novelId: 'book', chapterId: 'chapter', contentHash: hash(noCandidates),
    artifactType: 'artifact_sync_boundary:v1', syncMode: 'manual:new', status: 'succeeded', metadataJson: JSON.stringify({outcome: 'degraded', completedArtifacts: []})}});
  await bothBlocked(/尚未同步/);
  await prisma.chapterArtifactSyncCheckpoint.update({where: {id: boundary.id},
    data: {metadataJson: JSON.stringify({outcome: 'completed', completedArtifacts: ['artifact_delta']})}});
  await prisma.$transaction(tx => assertKernelCharacterReviewsResolved(tx, contract));
  await prisma.$transaction(tx => resumeBusiness(contract, tx));
  assert.equal((await prisma.chapter.findUniqueOrThrow({where: {id: 'chapter'}})).content, noCandidates);
  assert.deepEqual((await service.read('run')).reviews, []);
  assert.deepEqual(await prisma.chapterArtifactSyncCheckpoint.findUniqueOrThrow({where: {id: oldReview.id}}), oldRow);
  console.log('edited candidate checks passed');
} finally {await prisma.$disconnect();}})().catch(error => {console.error(error); process.exitCode = 1;});
`);
  try {
    const output = execFileSync(process.execPath, [script], {cwd: server, encoding: 'utf8', timeout: 90000,
      env: {...process.env, DATABASE_PROVIDER: 'sqlite', DATABASE_URL: databaseUrl, TEST_SERVER_ROOT: server, DIRECTOR_NEXT_ENABLED: 'true'}});
    if (!output.includes('edited candidate checks passed')) throw new Error(output);
  } finally {
    const resolved = path.resolve(dir);
    if (fs.realpathSync(path.dirname(resolved)) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('edited-v2-candidates-')) throw Error('Unsafe cleanup path');
    fs.rmSync(resolved, {recursive: true, force: true});
  }
});
