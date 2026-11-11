const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Database = require("better-sqlite3");
const {initializeTemporarySqliteDatabase} = require("./testInfrastructure/tempSqliteDatabase.cjs");

// The normal service, migrations, foreign keys and worker all use this fresh fixture.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "novel-delete-"));
process.env.AI_NOVEL_RUNTIME = "desktop";
process.env.AI_NOVEL_APP_DATA_DIR = root;
process.env.DATABASE_URL = initializeTemporarySqliteDatabase(root, "fixture.sqlite");
const db = new Database(path.join(root, "fixture.sqlite"));
const {prisma} = require("../dist/db/prisma");
const {NovelCoreCrudService} = require("../dist/services/novel/novelCoreCrudService");
const {PrismaRunRepository} = require("../dist/modules/director");
const {registerTaskCancellation} = require("../dist/platform/runtime/execution");
const {NovelSideEffectWorker} = require("../dist/events/sideEffects/NovelSideEffectWorker");
const {reserveStoredAsset, publishStoredAssets} = require("../dist/events/sideEffects/StoredAssetCleanup");
const {ragServices} = require("../dist/services/rag");
const service = new NovelCoreCrudService();
test.after(async () => {await prisma.$disconnect(); db.close(); fs.rmSync(root, {recursive: true});});

test("unfinished short stories retain the correct deletion order in every workflow status", async t => {
  for (const status of ["failed", "running", "waiting_approval", "succeeded"]) {
    await t.test(status, async () => {
      db.exec(`
        INSERT INTO Novel(id, title, narrativeForm, updatedAt) VALUES ('story', 'Unfinished story', 'short_story', CURRENT_TIMESTAMP);
        INSERT OR IGNORE INTO Novel(id, title, updatedAt) VALUES ('keep-short', 'Keep this novel', CURRENT_TIMESTAMP);
        INSERT INTO NovelWorkflowTask(id, novelId, lane, title, updatedAt) VALUES ('workflow', 'story', 'creation_studio', 'Story task', CURRENT_TIMESTAMP);
        INSERT INTO NovelIntentVersion(id, novelId, workflowTaskId, version, originalExpression, structuredIntentJson, updatedAt)
          VALUES ('intent', 'story', 'workflow', 1, 'Story idea', '{}', CURRENT_TIMESTAMP);
        INSERT INTO ShortStoryPlan(id, novelId, intentVersionId, targetWordCount, endingPromise, structureJson, updatedAt)
          VALUES ('plan', 'story', 'intent', 3000, 'An ending', '{}', CURRENT_TIMESTAMP);
        INSERT INTO ShortStorySegment(id, novelId, planId, "order", targetWordCount, updatedAt)
          VALUES ('segment', 'story', 'plan', 1, 1000, CURRENT_TIMESTAMP);
        INSERT INTO ShortStoryRevisionJob(id, novelId, workflowTaskId, intentVersionId, strategy, baselineJson, updatedAt)
          VALUES ('revision', 'story', 'workflow', 'intent', 'revise', '{}', CURRENT_TIMESTAMP);
        INSERT INTO TaskCenterArchive(id, taskKind, taskId) VALUES ('archive', 'novel_workflow', 'workflow');
      `);
      db.prepare("UPDATE NovelWorkflowTask SET status = ? WHERE id = 'workflow'").run(status);
      // The old failed-task pre-cleanup cascades intent versions while the plan
      // still references them. Deleting the novel directly can use another cascade order.
      assert.throws(() => db.prepare("DELETE FROM NovelWorkflowTask WHERE id = 'workflow'").run(), /FOREIGN KEY constraint failed/);

      await service.deleteNovel("story");
      for (const table of ["NovelWorkflowTask", "NovelIntentVersion", "ShortStoryPlan", "ShortStorySegment", "ShortStoryRevisionJob", "TaskCenterArchive"]) {
        assert.equal(db.prepare(`SELECT count(*) FROM "${table}"`).pluck().get(), 0, table);
      }
      assert.equal(await prisma.novel.count({where: {id: "keep-short"}}), 1);
    });
  }
});

async function seedBook(novelId) {
  const tag = name => name + "-" + novelId;
  await prisma.novel.create({data: {id: novelId, title: "Test book", directorVersion: "v2"}});
  const chapterId = tag("chapter"), taskId = tag("image"), runId = tag("run");
  await prisma.chapter.create({data: {id: chapterId, novelId, title: "Chapter", order: 1}});
  await prisma.directorNextRun.create({data: {id: runId, novelId, driver: "auto", planVersion: "test", contractJson: "{}",
    control: {create: {novelId, status: "running"}}, events: {create: {id: tag("event"), type: "start", seq: 1, payloadJson: "{}"}},
    commands: {create: {id: tag("command"), type: "open_run", idempotencyKey: tag("key"), payloadJson: "{}"}},
    qualityDebts: {create: {id: tag("debt"), novelId, chapterOrder: 1, code: "warning", action: "defer"}}}});
  // An imported artifact need not have a producing run.
  await prisma.directorNextArtifact.create({data: {id: tag("artifact"), novelId, type: "novel_seed", scope: "book",
    version: 1, status: "confirmed", protectedUserContent: true, contentRef: "seed"}});
  await prisma.storyTimelineEvent.create({data: {novelId, chapterId, eventOrder: 1, title: "E", summary: "", type: "event", status: "saved", visibility: "open", source: "test"}});
  await prisma.chapterTimeAnchor.create({data: {novelId, chapterId, chapterIndex: 1, timeLabel: "now"}});
  await prisma.timelineHook.create({data: {novelId, createdInChapterId: chapterId, createdInChapterIndex: 1, title: "H", description: "", status: "open", priority: "low"}});
  await prisma.timelineConstraint.create({data: {novelId, type: "time", severity: "low", description: ""}});
  await prisma.timelineCheckReport.create({data: {novelId, chapterId, chapterIndex: 1, status: "done", score: 1}});
  await prisma.agentRun.create({data: {id: tag("agent"), novelId, sessionId: "s", goal: "g", entryAgent: "a"}});
  await prisma.generationJob.create({data: {id: tag("pipeline"), novelId, startOrder: 1, endOrder: 1}});
  await prisma.imageGenerationTask.create({data: {id: taskId, novelId, sceneType: "novel_cover", provider: "p", model: "m", prompt: ""}});
  for (const [kind, id] of [["agent_run", tag("agent")], ["novel_pipeline", tag("pipeline")], ["image_generation", taskId]]) {
    await prisma.taskCenterArchive.create({data: {taskKind: kind, taskId: id}});
  }
  const relativePath = `novel-covers/${novelId}/${taskId}/image-01.png`;
  const localPath = path.join(root, "storage/generated-images", relativePath);
  fs.mkdirSync(path.dirname(localPath), {recursive: true});
  fs.writeFileSync(localPath, "synthetic cover");
  await prisma.imageAsset.create({data: {id: tag("cover"), taskId, novelId, sceneType: "novel_cover",
    url: localPath, provider: "p", model: "m", metadata: JSON.stringify({relativePath, localPath})}});
  // Include a legacy chunk missing novelId and a running job with no chunk yet.
  await prisma.knowledgeChunk.create({data: {id: tag("point"), ownerType: "chapter", ownerId: chapterId,
    chunkText: "test", chunkHash: "h", chunkOrder: 1, embedProvider: "p", embedModel: "m",
    metadataJson: JSON.stringify({vectorCollection: "book-archive"})}});
  await prisma.ragIndexJob.create({data: {id: tag("index"), ownerType: "chapter_summary", ownerId: chapterId, jobType: "upsert", status: "running"}});
  return {runId, localPath};
}

test("deletion removes only the selected book, fences publishers and retries external cleanup", async t => {
  const book = await seedBook("deleted"), keep = await seedBook("kept");
  const repository = new PrismaRunRepository();
  const stopped = [];
  for (const key of ["director:" + book.runId, "novel:deleted", "director:" + keep.runId]) {
    t.after(registerTaskCancellation(key, () => stopped.push(key)));
  }
  const reservation = await reserveStoredAsset(prisma, "deleted", {collection: "writing", points: ["in-flight"]});
  // Fail at the last database write. The original book, running work and files must still be intact.
  db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON Novel WHEN OLD.id='deleted' BEGIN SELECT RAISE(ABORT, 'forced rollback'); END");
  await assert.rejects(service.deleteNovel("deleted"));
  assert.deepEqual(stopped, []);
  assert.ok(fs.existsSync(book.localPath));
  assert.equal(await prisma.directorNextRun.count({where: {novelId: "deleted"}}), 1);
  assert.equal(await prisma.novelSideEffectJob.count({where: {status: "pending"}}), 0);
  db.exec("DROP TRIGGER fail_delete");

  await service.deleteNovel("deleted");
  assert.deepEqual(stopped.sort(), ["director:" + book.runId, "novel:deleted"].sort());
  assert.deepEqual(await repository.listRunIds({limit: 50}), [keep.runId]);
  assert.deepEqual(await repository.listLeaseCandidates(new Date(), 50), [keep.runId]);
  assert.equal(await repository.acquireLease(book.runId, "late", new Date(Date.now() + 10000), new Date()), false);
  await assert.rejects(prisma.$transaction(tx => publishStoredAssets(tx, [reservation])));
  await assert.rejects(reserveStoredAsset(prisma, "deleted", {points: ["late"]}));
  for (const model of ["chapter", "agentRun", "generationJob", "imageAsset", "imageGenerationTask", "storyTimelineEvent",
    "chapterTimeAnchor", "timelineHook", "timelineConstraint", "timelineCheckReport", "directorNextRunControl", "directorNextArtifact", "directorNextQualityDebt"]) {
    assert.equal(await prisma[model].count({where: {novelId: "deleted"}}), 0, model);
    assert.equal(await prisma[model].count({where: {novelId: "kept"}}), 1, model);
  }
  for (const model of ["directorNextEvent", "directorNextCommand"]) {
    assert.equal(await prisma[model].count({where: {runId: book.runId}}), 0, model);
    assert.equal(await prisma[model].count({where: {runId: keep.runId}}), 1, model);
  }
  assert.equal(await prisma.taskCenterArchive.count(), 3);
  assert.deepEqual(await prisma.knowledgeChunk.findMany({select: {id: true}}), [{id: "point-kept"}]);
  assert.deepEqual(await prisma.ragIndexJob.findMany({select: {id: true}}), [{id: "index-kept"}]);

  let unavailable = true;
  const removedPoints = [];
  t.mock.method(ragServices.vectorStoreService, "deletePoints", async (points, collection) => {
    if (unavailable) throw new Error("storage unavailable");
    for (const point of points) removedPoints.push([collection, point]);
  });
  const worker = new NovelSideEffectWorker();
  for (let i = 0; i < 3; i++) await worker.tick();
  assert.equal(await prisma.novelSideEffectJob.count({where: {status: "failed"}}), 2);
  assert.equal(fs.existsSync(book.localPath), false);
  assert.ok(fs.existsSync(keep.localPath));
  unavailable = false;
  await prisma.novelSideEffectJob.updateMany({where: {status: "failed"}, data: {runAfter: new Date(0)}});
  await worker.tick();
  await worker.tick();
  assert.deepEqual(removedPoints.sort(), [["book-archive", "point-deleted"], ["writing", "in-flight"]]);
});

test("a legacy object-storage cover is deleted by its own task key", async t => {
  const objects = require("../dist/services/image/objectImageStorage");
  const novelId = "s3-book", taskId = "s3-task", key = `novel-covers/${novelId}/${taskId}/image-01.png`;
  await prisma.novel.create({data: {id: novelId, title: "Object cover"}});
  await prisma.imageGenerationTask.create({data: {id: taskId, novelId, sceneType: "novel_cover", provider: "p", model: "m", prompt: "test"}});
  await prisma.imageAsset.create({data: {taskId, sceneType: "novel_cover", url: key, provider: "p", model: "m", metadata: JSON.stringify({storageKey: key})}});
  const removed = [];
  t.mock.method(objects, "deleteImageObject", async object => removed.push(object.key));
  await service.deleteNovel(novelId);
  await new NovelSideEffectWorker().tick();
  assert.deepEqual(removed, [key]);
});

test("deleting a book interrupts the active director step before its next write", {timeout: 8000}, async () => {
  const {createDirectorNextServices} = require("../dist/modules/director");
  const {StepRegistry} = require("../dist/modules/director/application");
  const {executionSignal} = require("../dist/platform/runtime/execution");
  const {contract, plan} = require("./directorNext/fixtures");
  const novelId = "active";
  await prisma.novel.create({data: {id: novelId, title: "Active book", directorVersion: "v2"}});
  const registry = new StepRegistry();
  const entered = Promise.withResolvers();
  registry.register("story_macro", async () => {
    const signal = executionSignal();
    entered.resolve(signal);
    await new Promise(resolve => signal.addEventListener("abort", resolve, {once: true}));
    await prisma.storyTimelineEvent.create({data: {novelId, eventOrder: 1, title: "Late", summary: "Late",
      type: "event", status: "saved", visibility: "open", source: "test"}});
    throw new Error("The cancelled step reached its write");
  });
  let targetRun;
  const services = createDirectorNextServices({
    stepRegistry: registry, plan,
    executionBoundary: {beforeOpen: async () => 0, assertRun: async () => {}, canRun: async id => id === targetRun},
    contractFactory: input => contract({...input, planVersion: plan.version}),
    prepareOpen: async () => [{type: "novel_seed", scope: "book", status: "confirmed", protectedUserContent: true, contentRef: "seed", contentHash: "seed"}],
  });
  const opened = await services.http.commandService.execute({type: "open_run", novelId, driver: "auto",
    stepIdsInScope: ["story_macro"], idempotencyKey: "open-active"});
  targetRun = opened.runId;
  const tick = services.worker.tick();
  const signal = await entered.promise;
  await service.deleteNovel(novelId);
  assert.ok(signal.aborted);
  assert.equal(await tick, false);
  assert.equal(await prisma.storyTimelineEvent.count({where: {novelId}}), 0);
});

test("a vector write returning after deletion cannot publish or leave searchable points", {timeout: 8000}, async t => {
  const {RagIndexService} = require("../dist/services/rag/RagIndexService");
  const {HybridRetrievalService} = require("../dist/services/rag/HybridRetrievalService");
  const {RagJobCancelledError} = require("../dist/services/rag/RagIndexService");
  const settings = require("../dist/services/settings/RagSettingsService");
  t.mock.method(settings, "getRagEmbeddingSettings", async () => ({embeddingProvider: "test", embeddingModel: "test"}));
  const novelId = "index-race";
  await prisma.novel.create({data: {id: novelId, title: "Synthetic source"}});
  const sending = Promise.withResolvers(), finish = Promise.withResolvers();
  const embedding = {embedTexts: async texts => ({vectors: texts.map(() => [1]), model: "test", provider: "test"})};
  const stored = new Map();
  const vectors = {
    ensureCollection: async () => {},
    upsertPoints: async points => {sending.resolve(points); await finish.promise; for (const point of points) stored.set(point.id, point);},
    deletePoints: async ids => {for (const id of ids) stored.delete(id);},
    search: async () => [...stored.values()],
  };
  const index = new RagIndexService(embedding, vectors, {applyToCandidates: async () => {}});
  const job = await index.enqueueUpsert("novel", novelId);
  const process = index.processJob(job);
  const points = await sending.promise;
  await service.deleteNovel(novelId);
  await assert.rejects(index.enqueueUpsert("novel", novelId));
  // Model a search while the external point is visible but its metadata was removed.
  for (const point of points) stored.set(point.id, point);
  const retrieval = new HybridRetrievalService(embedding, vectors);
  assert.deepEqual(await retrieval.vectorSearch("test", {tenantId: "default", novelId}), []);
  finish.resolve();
  await assert.rejects(process, error => error instanceof RagJobCancelledError || error.statusCode === 404);
  assert.equal(stored.size, 0);
  assert.equal(await prisma.knowledgeChunk.count({where: {novelId}}), 0);
});

test("a cover returning from storage after the book is deleted is cleaned on retry", {timeout: 8000}, async t => {
  const storage = require("../dist/services/image/imageAssetStorage");
  const provider = require("../dist/services/image/provider");
  const {executeImageGenerationTask} = require("../dist/services/image/ImageGenerationTaskExecutor");
  const novelId = "cover-race", taskId = "writing-cover";
  await prisma.novel.create({data: {id: novelId, title: "Cover race"}});
  await prisma.imageGenerationTask.create({data: {id: taskId, novelId, sceneType: "novel_cover", provider: "test", model: "test", prompt: "Test"}});
  t.mock.method(provider, "generateImagesByProvider", async () => ({
    provider: "test", model: "test", images: [{url: "data:image/png;base64,YQ=="}],
  }));
  const sending = Promise.withResolvers(), finish = Promise.withResolvers();
  const write = storage.persistGeneratedImageAsset;
  t.mock.method(storage, "persistGeneratedImageAsset", input => write({...input, beforeCoverWrite: async cover => {
    await input.beforeCoverWrite(cover);
    sending.resolve();
    await finish.promise;
  }}));
  const executing = executeImageGenerationTask(taskId, {requeueTask: () => assert.fail("deleted task was requeued")});
  await sending.promise;
  await service.deleteNovel(novelId);
  // Drain earlier point cleanup without contacting a real service.
  t.mock.method(ragServices.vectorStoreService, "deletePoints", async () => {});
  const worker = new NovelSideEffectWorker();
  while (await prisma.novelSideEffectJob.count({where: {status: "pending"}})) await worker.tick();
  finish.resolve();
  await executing;
  const file = path.join(root, "storage/generated-images/novel-covers", novelId, taskId, "image-01.png");
  assert.ok(fs.existsSync(file));
  assert.equal(await prisma.imageAsset.count({where: {novelId}}), 0);
  await worker.tick();
  assert.equal(fs.existsSync(file), false);
});

test("stopping an in-flight cover request cancels it without requeueing or deleting the book", {timeout: 8000}, async t => {
  const provider = require("../dist/services/image/provider");
  const {executeImageGenerationTask} = require("../dist/services/image/ImageGenerationTaskExecutor");
  const novelId = "cover-stop", taskId = "stopping-cover";
  await prisma.novel.create({data: {id: novelId, title: "Cover stop"}});
  await prisma.imageGenerationTask.create({data: {id: taskId, novelId, sceneType: "novel_cover", provider: "test", model: "test", prompt: "Test"}});
  const started = Promise.withResolvers();
  let calls = 0;
  t.mock.method(provider, "generateImagesByProvider", async ({signal}) => {
    calls++;
    assert.ok(signal);
    started.resolve();
    await new Promise((_, reject) => {
      const timeout = setTimeout(() => reject(new Error("Cancellation timed out")), 3000);
      signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        reject(signal.reason);
      }, {once: true});
    });
  });
  const executing = executeImageGenerationTask(taskId, {requeueTask: () => assert.fail("stopped task was requeued")});
  await started.promise;
  await prisma.imageGenerationTask.update({where: {id: taskId}, data: {cancelRequestedAt: new Date()}});
  await executing;
  const task = await prisma.imageGenerationTask.findUniqueOrThrow({where: {id: taskId}});
  assert.equal(task.status, "cancelled");
  assert.equal(task.retryCount, 0);
  assert.equal(calls, 1);
  assert.equal(await prisma.imageAsset.count({where: {taskId}}), 0);
  assert.equal(await prisma.novel.count({where: {id: novelId}}), 1);
});
