const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRuntimeSource } = require('./sourceHarness.cjs');

test('chapter 17 continuation gets only the remaining character and output allowance', () => {
  const { buildContinuationBudget } = loadRuntimeSource('writing/ContinuationBudget.ts', {});
  const budget = buildContinuationBudget(2315, { targetWordCount: 3200, minWordCount: 2720, maxWordCount: 3680 });
  assert.equal(budget.minAdditionalCharacters, 405);
  assert.equal(budget.targetAdditionalCharacters, 885);
  assert.equal(budget.maxAdditionalCharacters, 1365);
  assert.ok(budget.maxOutputTokens < 2500);
});

test('adequate drafts and unspecified or invalid ranges need no paid extension', () => {
  const { buildContinuationBudget } = loadRuntimeSource('writing/ContinuationBudget.ts', {});
  const range = { targetWordCount: 3200, minWordCount: 2720, maxWordCount: 3680 };
  for (const current of [2720, 3200, 7906, NaN, -1]) assert.equal(buildContinuationBudget(current, range), null);
  assert.equal(buildContinuationBudget(2315, { targetWordCount: null, minWordCount: null, maxWordCount: null }), null);
});

test('long continuation allowance grows with the remaining chapter range', () => {
  const { buildContinuationBudget } = loadRuntimeSource('writing/ContinuationBudget.ts', {});
  const budget = buildContinuationBudget(0, { targetWordCount: 10000, minWordCount: 8500, maxWordCount: 11500 });
  assert.equal(budget.maxAdditionalCharacters, 11500);
  assert.equal(budget.maxOutputTokens, 14439);
});

function graphFixture(output, streaming = false) {
  const calls = [], warnings = [], progress = [];
  const { ChapterWritingGraph } = loadRuntimeSource('../chapterWritingGraph.ts', {
    '../../prompting/core/contextBudget': { createContextBlock: value => value },
    '../../prompting/core/promptRunner': {
      runTextPrompt: async request => { calls.push(request); return { output }; },
      streamTextPrompt: async request => { calls.push(request); return {
        complete: Promise.resolve({ output }),
        stream: (async function* () { yield { content: output }; })(),
      }; },
    },
    '../../prompting/context/promptContextResolution': { resolvePromptContextBlocksForAsset: async input => ({ blocks: input.fallbackBlocks }) },
    '../../prompting/prompts/novel/chapterLayeredContext': {
      resolveTargetWordRange: target => target ? { targetWordCount: target, minWordCount: Math.floor(target * .85), maxWordCount: Math.floor(target * 1.15) } : { targetWordCount: null, minWordCount: null, maxWordCount: null },
      buildChapterWriterContextBlocks: () => [], sanitizeWriterContextBlocks: blocks => ({ allowedBlocks: blocks, removedBlockIds: [] }),
    },
    '../../prompting/prompts/novel/chapterWriter.prompts': { chapterWriterPrompt: {} },
    '../../llm/modelRouter': { resolveModel: async () => ({ routeMaxTokens: undefined, maxTokens: 16384 }) },
    './NovelContinuationService': { NovelContinuationService: class {} },
    './runtime/chapterEmptyContentError': {},
    '../../db/prisma': { prisma: { novel: { findUnique: async () => null } } },
    './novelP0Utils': { toText: value => value },
    './runtime/writing': {...loadRuntimeSource('writing/ContinuationBudget.ts', {}), ...loadRuntimeSource('writing/continuationNovelty.ts', {})},
  });
  const graph = new ChapterWritingGraph({ logInfo: () => {}, logWarn: (...args) => warnings.push(args) });
  const original = '字'.repeat(2315);
  const input = { novelId: 'n', novelTitle: '本书', chapter: { id: 'c', order: 17, title: '封城令下' }, content: original,
    contextPackage: { chapter: {}, chapterWriteContext: { chapterMission: { targetWordCount: 3200 } } }, options: {},
    ...(streaming ? { onDraftProgress: (content, state) => progress.push({ content, state }) } : {}),
  };
  return { graph, calls, warnings, progress, original, input, run: () => graph.enforceTargetLength(input) };
}

test('bounded extension appends to the draft and receives a small output allowance', async () => {
  const h = graphFixture('续'.repeat(885));
  assert.equal(await h.run(), `${h.original}\n\n${'续'.repeat(885)}`);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].promptInput.continuationBudget.targetAdditionalCharacters, 885);
  assert.ok(h.calls[0].options.maxTokens < 2500);
});

test('chapter 17 overshoot is rejected without truncating, saving or calling another model', async () => {
  for (const streaming of [false, true]) {
    const h = graphFixture('续'.repeat(5533), streaming);
    assert.equal(await h.run(), h.original);
    assert.equal(h.calls.length, 1);
    assert.equal(h.warnings[0][1].additionalCharacters, 5533);
    if (streaming) assert.deepEqual(h.progress.at(-1), { content: h.original, state: 'checking' });
  }
});

test('already adequate drafts skip continuation completely', async () => {
  const h = graphFixture('unused'); h.input.content = '字'.repeat(2720);
  assert.equal(await h.run(), h.input.content);
  assert.equal(h.calls.length, 0);
});

test('initial Writer request uses the resolved mission target even when chapter metadata is empty', async () => {
  const h = graphFixture('正文');
  h.input.contextPackage.chapterWriteContext.chapterMission.targetWordCount = 1800;
  h.input.contextPackage.continuation = {};
  await h.graph.createChapterStream(h.input);
  assert.equal(h.calls[0].promptInput.targetWordCount, 1800);
  assert.equal(h.calls[0].promptInput.minWordCount, 1530);
  assert.equal(h.calls[0].promptInput.maxWordCount, 2070);
  assert.equal(h.calls[0].options.maxTokens, undefined);
});

for (const streaming of [false, true]) {
  test('replayed suffix is rejected before save/review without another request; streaming=' + streaming, async () => {
    const h = graphFixture('字'.repeat(349), streaming);
    assert.equal(await h.run(), h.original);
    assert.equal(h.calls.length, 1);
    assert.equal(h.warnings[0][1].repeatedCharacters, 349);
    if (streaming) assert.deepEqual(h.progress.at(-1), {content: h.original, state: 'checking'});
  });
}

test('overlap guard catches whitespace-only replay and long repeated paragraphs but allows brief echoes', () => {
  const {validateContinuationNovelty: check} = loadRuntimeSource('writing/continuationNovelty.ts', {});
  const paragraph = '祖母收起短尺，母亲终于松开肩膀，哥哥把叠好的棉帕垫进父亲臂弯。'.repeat(4);
  assert.equal(check('开场。'+paragraph, paragraph.split('').join(' ')).accepted, false);
  assert.equal(check(paragraph+'原文另有收尾。', '新变化。\n\n'+paragraph).accepted, false);
  assert.equal(check('他点了点头。', '他点了点头，伸手推开房门。').accepted, true);
  assert.equal(check(paragraph, '他拉住哥哥衣袖，第一次笑出了声。').accepted, true);
  assert.equal(check(paragraph, '').accepted, true);
});

 test('new introductory words cannot disguise a replay inside the same continuation paragraph', () => {
  const {validateContinuationNovelty} = loadRuntimeSource('writing/continuationNovelty.ts', {});
  const previous = '门外的脚步越来越近。他抓住窗沿，手指被碎木刺破，仍然没有松开。'.repeat(5);
  assert.equal(validateContinuationNovelty(previous, '他又向前挪动。' + previous + '随后关上了门。').accepted, false);
 });
