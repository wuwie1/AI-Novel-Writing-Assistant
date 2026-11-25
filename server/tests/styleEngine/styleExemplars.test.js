const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseStyleExemplarSet,
  styleExemplarSetSchema,
  STYLE_EXEMPLAR_MAX_COUNT,
  WRITER_STYLE_EXEMPLAR_CHAR_BUDGET,
} = require("@ai-novel/shared/types/styleEngine");
const {
  findLeakedSourceEntities,
  findStyleExemplarOverlaps,
  maskSourceEntities,
  parseStoredStyleExemplars,
  resolveWriterStyleExemplars,
} = require("../../dist/services/styleEngine/exemplars");
const {
  detectForbiddenStyleEntities,
  sanitizeStyleContextForGeneration,
} = require("../../dist/services/styleEngine/styleGenerationSanitizer.js");
const { StyleCompiler } = require("../../dist/services/styleEngine/StyleCompiler.js");
const {
  detectNewSevereProseFindings,
  detectProseQuality,
  resolveProseQualityOptions,
} = require("../../dist/services/novel/runtime/proseQuality/ProseQualityDetector.js");
const { NATURAL_PAUSE_PUNCTUATION_CONTRACT_LINE } = require("@ai-novel/shared/types/chapterProseContract");
const { setup } = require("../production/persistence/sqliteFixture.cjs");
const { loadRuntimeSource } = require("../novelProduction/sourceHarness.cjs");
const helpers = require("../../dist/services/styleEngine/helpers");
const { buildStyleExemplarText } = require("../../dist/prompting/prompts/novel/context/chapterContextBlocks.js");
const { createContextBlock } = require("../../dist/prompting/core/contextBudget");
const { selectContextBlocks } = require("../../dist/prompting/core/contextSelection");
const { NOVEL_PROMPT_BUDGETS } = require("../../dist/prompting/prompts/novel/promptBudgetProfiles.js");

const PASSAGE = "韩立蹲在墙根下数铜板，数到第七枚的时候停了手。巷口有人喊他的名字，他没有抬头，只把铜板一枚一枚收回袖子里，"
  + "又等了三息才站起来。喊他的人已经走到跟前，手里拎着半只烧鸡，油纸包得严严实实。";

function exemplar(id, overrides = {}) {
  return { id, sceneFunction: "旁人起笔的亮相", text: PASSAGE, learn: ["短段先落地"], doNotCarry: ["铜板和烧鸡"], enabled: true, ...overrides };
}

function binding(targetType, exemplars, sourceEntities = ["韩立"]) {
  return {
    id: `binding-${targetType}`, styleProfileId: `profile-${targetType}`, targetType, targetId: "book", priority: 1, weight: 1,
    enabled: true, createdAt: "2026-11-25T00:00:00.000Z", updatedAt: "2026-11-25T00:00:00.000Z",
    styleProfile: { id: `profile-${targetType}`, name: targetType, styleExemplars: { exemplars, sourceEntities } },
  };
}

function codes(report) {
  return report.findings.map((finding) => finding.code);
}

test("an exemplar set is a short reading list with unique ids", () => {
  assert.equal(styleExemplarSetSchema.safeParse({ exemplars: [exemplar("EX-001")] }).success, true);
  assert.equal(styleExemplarSetSchema.safeParse({ exemplars: [exemplar("EX-001"), exemplar("EX-001")] }).success, false);
  assert.equal(styleExemplarSetSchema.safeParse({ exemplars: [exemplar("EX-001", { text: "太短" })] }).success, false);
  assert.equal(styleExemplarSetSchema.safeParse({ exemplars: [exemplar("EX-001", { text: "长".repeat(1201) })] }).success, false);
  // Notes are one short sentence each; a long commentary would crowd the chapter prompt.
  for (const overrides of [{ learn: ["短"].concat(Array(4).fill("短")) }, { doNotCarry: ["长".repeat(81)] }, { sceneFunction: "长".repeat(81) }]) {
    assert.equal(styleExemplarSetSchema.safeParse({ exemplars: [exemplar("EX-001", overrides)] }).success, false);
  }
  assert.equal(styleExemplarSetSchema.safeParse({ exemplars: [exemplar("EX-001", { learn: Array(4).fill("长".repeat(80)) })] }).success, true);
  const tooMany = Array.from({ length: STYLE_EXEMPLAR_MAX_COUNT + 1 }, (_, index) => exemplar(`EX-${index}`));
  assert.equal(styleExemplarSetSchema.safeParse({ exemplars: tooMany }).success, false);
  // The export of the Skill's register carries bookkeeping fields the profile does not store.
  const fromExport = parseStyleExemplarSet({ schemaVersion: 1, source: { title: "样书" }, sourceEntities: ["韩立"], exemplars: [exemplar("EX-001")] });
  assert.deepEqual(Object.keys(fromExport).sort(), ["exemplars", "sourceEntities"]);
});

test("stored exemplars that no longer fit the limits read as none", () => {
  assert.deepEqual(parseStoredStyleExemplars(null), { exemplars: [], sourceEntities: [] });
  assert.deepEqual(parseStoredStyleExemplars("{not json"), { exemplars: [], sourceEntities: [] });
  assert.deepEqual(parseStoredStyleExemplars(JSON.stringify({ exemplars: [exemplar("EX-001", { text: "短" })] })).exemplars, []);
  assert.equal(parseStoredStyleExemplars(JSON.stringify({ exemplars: [exemplar("EX-001")] })).exemplars.length, 1);
});

test("source names are masked in order of appearance, longest name first", () => {
  assert.equal(maskSourceEntities("韩立看了看韩立家的门，又看了看厉飞雨。", ["厉飞雨", "韩立", "韩立家"]), "〔甲〕看了看〔乙〕的门，又看了看〔丙〕。");
  assert.equal(maskSourceEntities("没有专名。", ["韩立"]), "没有专名。");
});

test("the writer gets exemplars from the most specific profile only, masked and within budget", () => {
  const novel = binding("novel", [exemplar("EX-NOVEL")]);
  const chapter = binding("chapter", [exemplar("EX-OFF", { enabled: false }), exemplar("EX-CHAPTER")]);
  const resolved = resolveWriterStyleExemplars([chapter, novel]);
  assert.deepEqual(resolved.map((item) => item.id), ["EX-CHAPTER"]);
  assert.doesNotMatch(resolved[0].text, /韩立/);
  assert.match(resolved[0].text, /^〔甲〕蹲在墙根下/);
  assert.deepEqual(Object.keys(resolved[0]).sort(), ["doNotCarry", "id", "learn", "sceneFunction", "text"]);

  // A binding whose exemplars are all disabled falls through to the broader profile.
  assert.deepEqual(resolveWriterStyleExemplars([binding("chapter", [exemplar("EX-OFF", { enabled: false })]), novel]).map((item) => item.id), ["EX-NOVEL"]);
  assert.deepEqual(resolveWriterStyleExemplars([binding("novel", [])]), []);
  assert.deepEqual(resolveWriterStyleExemplars([{ ...novel, styleProfile: { id: "legacy", name: "legacy" } }]), []);

});

test("the whole exemplar block stays within its share of the chapter prompt", () => {
  const optional = () => ["recent_chapters", "open_conflicts", "character_dynamics"].map((id, index) => (
    createContextBlock({ id, group: id, priority: 80 - index, content: "近况。".repeat(200) })
  ));
  const render = (exemplars) => {
    const picked = resolveWriterStyleExemplars([binding("novel", exemplars, ["韩立", "厉飞雨"])]);
    const content = buildStyleExemplarText(picked);
    const block = createContextBlock({ id: "style_exemplars", group: "style_exemplars", priority: 73, required: true, allowSummary: false, content });
    const kept = selectContextBlocks([block, ...optional()], { maxTokensBudget: NOVEL_PROMPT_BUDGETS.chapterWriter });
    return { picked, content, block, kept };
  };

  // Long passages: as many as fit, and one more would not.
  const long = "他把门推开一条缝，往里看了一眼。".repeat(70);
  const passages = render(Array.from({ length: 5 }, (_, index) => exemplar(`EX-${index}`, { text: long })));
  assert.equal(passages.picked.length, 3);
  assert.ok(passages.content.length <= WRITER_STYLE_EXEMPLAR_CHAR_BUDGET);
  assert.ok(passages.content.length + long.length > WRITER_STYLE_EXEMPLAR_CHAR_BUDGET);

  // Short passages with the longest notes the profile accepts: the notes count against the budget too.
  const note = "说".repeat(80);
  const heavy = Array.from({ length: 12 }, (_, index) => exemplar(`EX-${index}`, {
    text: "韩立推开门看了一眼。".repeat(8), sceneFunction: note, learn: Array(4).fill(note), doNotCarry: Array(4).fill(note),
  }));
  assert.equal(styleExemplarSetSchema.safeParse({ exemplars: heavy }).success, true);
  const notes = render(heavy);
  assert.ok(notes.picked.length >= 1 && notes.picked.length < heavy.length);
  assert.ok(notes.content.length <= WRITER_STYLE_EXEMPLAR_CHAR_BUDGET, `${notes.content.length} characters`);
  assert.ok(notes.block.estimatedTokens <= NOVEL_PROMPT_BUDGETS.chapterWriter / 4);
  assert.deepEqual(notes.kept.droppedBlockIds, []);
  // What the limit prevents: a required block larger than the chapter budget leaves room for nothing else.
  const oversized = createContextBlock({ id: "style_exemplars", group: "style_exemplars", priority: 73, required: true, allowSummary: false, content: "字".repeat(30000) });
  assert.deepEqual(selectContextBlocks([oversized, ...optional()], { maxTokensBudget: NOVEL_PROMPT_BUDGETS.chapterWriter }).droppedBlockIds,
    ["recent_chapters", "open_conflicts", "character_dynamics"]);
  // A two-character name becomes a three-character placeholder; the count uses what is shown.
  assert.match(notes.picked[0].text, /^〔甲〕推开门/);
});

test("registered source names become forbidden entities for the generated chapter", () => {
  const context = sanitizeStyleContextForGeneration({
    matchedBindings: [binding("novel", [exemplar("EX-001")], ["韩立", "厉飞雨"])],
    compiledBlocks: null, effectiveStyleProfileId: "profile-novel", taskStyleProfileId: null,
    activeSourceTargets: ["novel"], activeSourceLabels: ["NOVEL"], maturity: "summary_only",
    usesGlobalAntiAiBaseline: false, globalAntiAiRuleIds: [], styleAntiAiRuleIds: [],
  });
  assert.deepEqual(context.sanitizedGenerationProfile.forbiddenEntities.slice(0, 2), ["韩立", "厉飞雨"]);
  assert.deepEqual(detectForbiddenStyleEntities("少年抬头，看见厉飞雨站在门口。", context), ["厉飞雨"]);
  assert.deepEqual(detectForbiddenStyleEntities("少年抬头，看见门口站着一个人。", context), []);
});

test("a book that allows pause punctuation states it as a contract sentence, not a generic rule line", () => {
  const compile = (languageRules) => new StyleCompiler().compile({
    styleProfile: { narrativeRules: {}, characterRules: {}, languageRules, rhythmRules: {} }, antiAiRules: [],
  }).contract.language;
  const natural = compile({ register: "口语", pausePunctuation: "natural" });
  assert.ok(natural.lines.includes(NATURAL_PAUSE_PUNCTUATION_CONTRACT_LINE));
  assert.doesNotMatch(natural.text, /pausePunctuation/);
  assert.match(natural.text, /language\.register/);
  for (const rules of [{ register: "口语" }, { register: "口语", pausePunctuation: "avoid" }, { pausePunctuation: "anything" }]) {
    const section = compile(rules);
    assert.equal(section.lines.includes(NATURAL_PAUSE_PUNCTUATION_CONTRACT_LINE), false);
    assert.doesNotMatch(section.text, /pausePunctuation/);
  }
});

test("pause punctuation is flagged by presence by default and by density when the book allows it", () => {
  const line = "“线是齐源画的，你看封面……”她把本子递过去。";
  assert.deepEqual(codes(detectProseQuality(line)), ["prose_dash_or_ellipsis"]);
  assert.equal(detectProseQuality(line).hasBlockingFindings, true);

  const natural = { pausePunctuation: "natural" };
  assert.deepEqual(codes(detectProseQuality(line, natural)), []);

  const stacked = detectProseQuality("“我……我不是……我真的没有……”他往后退了一步。", natural);
  assert.deepEqual(codes(stacked), ["prose_pause_punctuation_dense"]);
  assert.equal(stacked.hasBlockingFindings, false);

  const dense = detectProseQuality(Array.from({ length: 10 }, (_, index) => `第${index}个人看了他一眼……没有说话。`).join("\n"), natural);
  assert.deepEqual(codes(dense), ["prose_pause_punctuation_dense"]);
  assert.match(dense.findings[0].message, /共 10 处/);

  const sparse = detectProseQuality(Array.from({ length: 10 }, (_, index) => (
    `第${index}个人看了他一眼……没有说话。他把第${index}只箱子放下，转身朝巷子另一头走过去，一路上没有回头，也没有人叫住他。`
    + `脚步声在第${index}道墙根下响了很久才散，巷口卖炊饼的老头探出头来看了看，又缩了回去。`
  )).join("\n"), natural);
  assert.deepEqual(codes(sparse), []);
});

test("the detector reads a book's choices from the style context it was generated with", () => {
  assert.deepEqual(resolveProseQualityOptions(null), { pausePunctuation: "avoid", styleExemplars: [], sourceEntities: [] });
  const options = resolveProseQualityOptions({
    compiledBlocks: { mergedRules: { languageRules: { pausePunctuation: "natural" } } },
    exemplars: [{ id: "EX-001", text: PASSAGE }],
    sourceEntities: ["韩立"],
  });
  assert.equal(options.pausePunctuation, "natural");
  assert.equal(options.styleExemplars.length, 1);
  assert.deepEqual(options.sourceEntities, ["韩立"]);
});

test("reusing a run of an exemplar is a severe finding; ordinary shared phrases are not", () => {
  const options = { styleExemplars: [{ id: "EX-001", text: PASSAGE }] };
  const copied = "陆昊没有抬头，只把铜板一枚一枚，收回袖子里，然后才开口。";
  assert.deepEqual(findStyleExemplarOverlaps(copied, options.styleExemplars), [
    { exemplarId: "EX-001", sharedChars: 17, shared: "没有抬头只把铜板一枚一枚收回袖子里" },
  ]);
  const report = detectProseQuality(`开场一句。\n${copied}`, options);
  assert.deepEqual(codes(report), ["prose_exemplar_overlap"]);
  assert.equal(report.findings[0].severity, "high");
  assert.equal(report.findings[0].line, 2);

  const original = "陆昊没有抬头，把银角子一枚一枚排在桌上，然后才开口。";
  assert.deepEqual(codes(detectProseQuality(original, options)), []);
  assert.deepEqual(codes(detectProseQuality(copied)), []);
  // A repair that introduces a reused passage is rejected like any other new severe defect.
  assert.deepEqual(detectNewSevereProseFindings(original, copied, options).map((finding) => finding.code), ["prose_exemplar_overlap"]);
});

test("a copied passage is found whatever the writer did with the names", () => {
  const raw = Array.from({ length: 5 }, (_, index) => `韩立抬头看了第${index + 1}面旗，韩立把账册收进怀里，韩立转身往回走。`).join("\n");
  const [shown] = resolveWriterStyleExemplars([binding("novel", [exemplar("EX-001", { text: raw })])]);
  assert.match(shown.text, /^〔甲〕抬头看了第1面旗，〔甲〕把账册收进怀里，〔甲〕转身往回走。/);
  for (const copied of [shown.text, shown.text.replaceAll("〔甲〕", "沈舟"), shown.text.replaceAll("〔甲〕", "")]) {
    const overlaps = findStyleExemplarOverlaps(copied, [shown]);
    assert.equal(overlaps.length, 1, copied.slice(0, 20));
    assert.equal(overlaps[0].sharedChars, 100);
  }
  const report = detectProseQuality(`开场一句。\n${shown.text.replaceAll("〔甲〕", "沈舟").split("\n")[1]}`, { styleExemplars: [shown] });
  assert.deepEqual(codes(report), ["prose_exemplar_overlap"]);
  assert.equal(report.findings[0].line, 2);
  assert.equal(report.findings[0].excerpt, "抬头看了第2面旗…把账册收进怀里…转身往回走");
  // The same ordinary actions, two in a row or all three in another order, are the book's own prose.
  for (const original of ["沈舟把账册收进怀里，沈舟转身往回走。", "沈舟转身往回走，接着沈舟把账册收进怀里，最后才抬头看了第9面旗。"]) {
    assert.deepEqual(findStyleExemplarOverlaps(original, [shown]), [], original);
  }
});

test("a registered source name in the chapter is reported by the acceptance both pipelines share", async () => {
  assert.deepEqual(findLeakedSourceEntities("韩立老祖看了厉飞雨一眼。", ["韩立", "韩立老祖", "厉飞雨", "墨大夫"]), ["韩立老祖", "厉飞雨"]);
  assert.deepEqual(findLeakedSourceEntities("  ", ["韩立"]), []);

  const options = { sourceEntities: ["韩立", "厉飞雨"] };
  const leaked = detectProseQuality("他把门关上……\n少年抬头，看见厉飞雨站在门口。", options);
  assert.deepEqual(codes(leaked), ["prose_source_entity_leak", "prose_dash_or_ellipsis"]);
  assert.deepEqual([leaked.findings[0].severity, leaked.findings[0].line, leaked.findings[0].column], ["critical", 2, 8]);
  assert.match(leaked.findings[0].message, /“厉飞雨”/);
  assert.deepEqual(codes(detectProseQuality("少年抬头，看见门口站着一个人。", options)), []);
  assert.deepEqual(codes(detectProseQuality("少年抬头，看见厉飞雨站在门口。")), []);

  // The production kernel calls this service directly, without the legacy chapter pipeline around it.
  const accepted = {
    status: "accepted", score: { coherence: 90, pacing: 90, repetition: 90, engagement: 90, voice: 90, overall: 90 },
    summary: "验收完成", blockingIssues: [], repairDirectives: [], missingObligations: [], repairability: "none",
    decisionReason: "可继续", riskTags: [], continuePolicy: "continue",
    assetSyncRecommendation: { priority: "normal", reason: "同步", requiresFullPayoffReconcile: false },
    styleReview: { riskScore: 0, summary: "写法规则已检查", issueCodes: [] },
  };
  const { ChapterAcceptanceAssessmentService } = loadRuntimeSource("ChapterAcceptanceAssessmentService.ts", {
    "@ai-novel/shared/types/directorIssue": require("@ai-novel/shared/types/directorIssue"),
    "../../../db/prisma": { prisma: {} },
    "../director/issues/DirectorIssuePolicyService": { directorIssuePolicyService: { getNovelPolicy: async () => ({ effectivePolicy: { maxAutomaticRetries: 1, issueActions: {} } }) } },
    "../../../prompting/core/promptRunner": { runStructuredPrompt: async () => ({ output: accepted }) },
    "../../../prompting/context/promptContextResolution": { resolvePromptContextBlocksForAsset: async ({ fallbackBlocks }) => ({ blocks: fallbackBlocks }) },
    "../../../prompting/prompts/novel/chapterLayeredContext": { buildChapterReviewContextBlocks: () => [] },
    "../../../prompting/prompts/novel/chapterLayeredContextShared": { resolveTargetWordRange: () => ({ minWordCount: null, maxWordCount: null }) },
    "../../../prompting/prompts/novel/chapterAcceptance.prompts": require("../../dist/prompting/prompts/novel/chapterAcceptance.prompts"),
    "../../state/OpenConflictService": { openConflictService: {} },
    "../novelP0Utils": { normalizeScore: (score) => score, ruleScore: () => accepted.score },
    "./proseQuality/ProseQualityDetector": require("../../dist/services/novel/runtime/proseQuality/ProseQualityDetector.js"),
    "./acceptance": require("../../dist/services/novel/runtime/acceptance"),
  });
  const compiledBlocks = new StyleCompiler().compile({
    styleProfile: { narrativeRules: {}, characterRules: {}, languageRules: {}, rhythmRules: {} }, antiAiRules: [],
  });
  const assess = (content) => new ChapterAcceptanceAssessmentService().assess({
    novelId: "n", chapterId: "c", novelTitle: "书", chapterTitle: "章", chapterOrder: 1, content, persist: false,
    contextPackage: { chapter: { id: "c", title: "章", order: 1 }, postGenerationStyleReviewEnabled: false,
      styleContext: { compiledBlocks, sourceEntities: ["韩立", "厉飞雨"] } },
  });
  const result = await assess("少年抬头，看见厉飞雨站在门口。");
  assert.equal(result.assessment.status, "repairable");
  assert.deepEqual(result.assessment.blockingIssues.map((issue) => [issue.code, issue.severity]), [["prose_source_entity_leak", "critical"]]);
  assert.ok(result.assessment.riskTags.includes("prose_source_entity_leak"));
  assert.equal((await assess("少年抬头，看见门口站着一个人。")).assessment.status, "accepted");
});

test("a profile keeps its exemplars across ordinary saves and clears them only when told to", async (t) => {
  const { db } = await setup(t);
  const { StyleProfileService } = loadRuntimeSource("../../styleEngine/StyleProfileService.ts", {
    "../../db/prisma": { prisma: db }, "../../prompting/core/promptRunner": {}, "../../prompting/prompts/style/style.prompts": {},
    "./StyleEngineSeedService": { ensureStyleEngineSeedData: async () => {} }, "./helpers": helpers, "./styleCreation": {}, "./styleExtraction": {},
  });
  const service = new StyleProfileService();
  const styleExemplars = { exemplars: [exemplar("EX-001")], sourceEntities: ["韩立"] };
  const created = await service.createManualProfile({ name: "本书写法", styleExemplars });
  assert.deepEqual(created.styleExemplars, { exemplars: [{ ...exemplar("EX-001") }], sourceEntities: ["韩立"] });

  const renamed = await service.updateProfile(created.id, { name: "本书写法二版", languageRules: { pausePunctuation: "natural" } });
  assert.equal(renamed.styleExemplars.exemplars.length, 1);
  assert.equal(renamed.languageRules.pausePunctuation, "natural");

  const cleared = await service.updateProfile(created.id, { name: "本书写法二版", styleExemplars: { exemplars: [], sourceEntities: [] } });
  assert.deepEqual(cleared.styleExemplars, { exemplars: [], sourceEntities: [] });

  const plain = await service.createManualProfile({ name: "没有样例" });
  assert.deepEqual(plain.styleExemplars, { exemplars: [], sourceEntities: [] });
});

test("the writer prompt carries exemplars as their own context group and lets the book's contract outrank general rules", () => {
  const { chapterWriterPrompt } = require("../../dist/prompting/prompts/novel/chapterWriter.prompts.js");
  const { chapterAcceptanceAssessmentPrompt } = require("../../dist/prompting/prompts/novel/chapterAcceptance.prompts.js");
  const { CHAPTER_STYLE_CONTRACT_PRECEDENCE_RULE } = require("@ai-novel/shared/types/chapterProseContract");
  assert.equal(chapterWriterPrompt.version, "v12");
  assert.equal(chapterAcceptanceAssessmentPrompt.version, "v25");
  assert.ok(chapterWriterPrompt.contextRequirements.some((item) => item.group === "style_exemplars"));
  const context = {
    blocks: [], selectedBlockIds: [], droppedBlockIds: [], summarizedBlockIds: [], estimatedInputTokens: 0,
    slots: { text: () => undefined, choiceCopy: () => undefined, enabled: () => false, token: () => undefined },
  };
  const [system] = chapterWriterPrompt.render({ novelTitle: "测试", chapterOrder: 1, chapterTitle: "第一章", targetWordCount: 3000 }, context);
  assert.ok(system.content.includes(CHAPTER_STYLE_CONTRACT_PRECEDENCE_RULE));
  assert.match(system.content, /文笔样例（style_exemplars）/);
  assert.match(system.content, /只学读感，不搬样例的句子、专名和情节/);
  assert.match(system.content, /\(1\) 结尾是否符合【结构要求】第 4 条的章末要求？/);
});
