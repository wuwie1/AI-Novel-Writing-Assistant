const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRuntimeSource } = require('./sourceHarness.cjs');
const { setup } = require('../production/persistence/sqliteFixture.cjs');

test('generating a summary updates observed events without changing the approved goal or editor version', async t => {
  const { db } = await setup(t);
  const original = await db.chapter.update({ where: { id: 'chapter-1' }, data: { expectation: '在城门完成一次交接。' } });
  const queued = [], facts = [];
  const { NovelChapterSummaryService } = loadRuntimeSource('../NovelChapterSummaryService.ts', {
    '../../db/prisma': { prisma: db },
    '../rag': { ragServices: { ragIndexService: { enqueueUpsert: async (...args) => queued.push(args) } } },
    '../../prompting/core/promptRunner': { runStructuredPrompt: async () => ({ output: {
      summary: '主角把铜钥匙交给守卫。', concreteFacts: [{ text: '钥匙已交付。', category: 'completed' }],
    } }) },
    '../../prompting/prompts/novel/review.prompts': { chapterSummaryPrompt: {} },
    './fact/NovelFactService': { novelFactService: { writeFacts: async (...args) => facts.push(args) } },
  });
  const result = await new NovelChapterSummaryService().generateChapterSummary('novel-1', 'chapter-1');
  const chapter = await db.chapter.findUniqueOrThrow({ where: { id: 'chapter-1' } });
  assert.equal(chapter.expectation, original.expectation);
  assert.equal(chapter.updatedAt.getTime(), original.updatedAt.getTime());
  assert.equal(result.expectation, original.expectation, 'the response must not cause clients to replace the goal');
  assert.equal(result.summary, '主角把铜钥匙交给守卫。');
  assert.equal((await db.chapterSummary.findUniqueOrThrow({ where: { chapterId: chapter.id } })).summary, result.summary);
  assert.equal(facts.length, 1);
  assert.deepEqual(queued, [['chapter', 'chapter-1'], ['chapter_summary', 'chapter-1']]);
});

test('saving or clearing only prose cannot mirror stale metadata into the volume plan; explicit planning edits still mirror', async t => {
  const { db } = await setup(t);
  await db.chapter.update({ where: { id: 'chapter-1' }, data: { expectation: '旧版本的摘要误占了目标' } });
  const store = loadRuntimeSource('../chapterEditor/persistence/ManualChapterStore.ts', {
    '../../../../db/prisma': { prisma: db },
    '../../../../middleware/errorHandler': { AppError: class extends Error {} },
    '../../../../modules/timeline': { queueManualChapterTimeline: async () => {} },
    '../domain/manualChapterPolicy': {},
    '../synchronization/ManualChapterSyncStore': { queueManualChapterSync: async () => {} },
  });
  const queued = [], mirrored = [];
  const { ManualChapterService } = loadRuntimeSource('../chapterEditor/application/ManualChapterService.ts', {
    '../../novelCoreSupport': { queueRagUpsert: (...args) => queued.push(args), queueRagDelete: () => {} },
    '../persistence/ManualChapterStore': store,
  });
  const service = new ManualChapterService({ mirrorChapterIntoWorkspace: async (...args) => mirrored.push(args) });
  await service.updateChapter('novel-1', 'chapter-1', { content: '正文新版本' });
  await service.updateChapter('novel-1', 'chapter-1', { content: '', chapterStatus: 'pending_generation', qualityScore: null });
  assert.equal(mirrored.length, 0);
  assert.equal((await db.chapter.findUniqueOrThrow({ where: { id: 'chapter-1' } })).content, '');
  await service.updateChapter('novel-1', 'chapter-1', { expectation: '作者修订的城门交接目标' });
  assert.equal(mirrored.length, 1);
  assert.equal(mirrored[0][1].expectation, '作者修订的城门交接目标');
  await service.updateChapter('novel-1', 'chapter-1', { taskSheet: null });
  assert.equal(mirrored.length, 2, 'explicitly clearing a planning field is also a planning edit');
  await service.createChapter('novel-1', { title: '新章', order: 2, expectation: '新章目标' });
  assert.equal(mirrored.length, 3);
  assert.equal(mirrored[2][1].expectation, '新章目标');
  assert.equal(queued.length, 5, 'prose-only saves still refresh the text index');
});
