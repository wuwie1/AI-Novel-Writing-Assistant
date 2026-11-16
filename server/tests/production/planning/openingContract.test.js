const test = require('node:test');
const assert = require('node:assert/strict');
const {generationInput, candidate, safe} = require('./contractFixture.cjs');
const {generateChapterTaskSheetDetail} = require('../../../dist/services/novel/volume/chapterDetail');
const {prepareStoryPlanRecord} = require('../../../dist/services/planner/persistence/storyPlanStore');
const {buildChapterExecutionContractHash} = require('../../../dist/services/planner/persistence/contract');
const {buildPlannerStyleContractSummaryText} = require('../../../dist/services/styleEngine/styleContractText');
const {buildChapterPlanContextBlocks} = require('../../../dist/services/planner/plannerContextBlocks');
const {plannerChapterPlanPrompt} = require('../../../dist/prompting/prompts/planner/plannerPlan.prompts');
const {buildCompressionLog} = require('../../../dist/prompting/core/contextBudget');

test('chapter planner retains rhythm under a crowded context budget', () => {
  const contract = Object.fromEntries(['narrative','character','language','rhythm','antiAi'].map(key => [key,
    {key, summary: key, lines: [key === 'rhythm' ? '每章完成一次可见回报，不拖延本章结果' : '规则一', '规则二']} ]));
  const styleEngine = buildPlannerStyleContractSummaryText(contract);
  assert.match(styleEngine, /每章完成一次可见回报/);
  const defaults = Object.fromEntries(['stateDrivenDirective','defaultMetadata','bookPlan','arcPlans','characters','recentSummaries','plotBeats','stateSnapshot','openAuditIssues','recentDecisions','characterDynamicsSummary','characterVolumeAssignments','characterRelationStages','characterCandidateGuards','stateDrivenGoal','replanContext'].map(k=>[k,'']));
  const blocks = buildChapterPlanContextBlocks({...defaults,novelTitle:'测试',chapterTitle:'出生',chapterOrder:1,
    expectation:'完成救治',mappedVolumes:[],styleEngine,bible:'大量设定'.repeat(6000),recentSummaries:'',
    stateSnapshot:'',chapterTaskSheet:'完成救治',chapterSceneCards:'',defaultMetadata:'',characters:'',
    novelOverview:'背景'.repeat(6000)});
  const style = blocks.find(block => block.id === 'style_engine');
  assert.equal(style.required, true);
  assert.equal(style.allowSummary, false);
  assert.ok(plannerChapterPlanPrompt.contextPolicy.requiredGroups.includes('style_engine'));
  const compressed = buildCompressionLog(blocks, 10);
  assert.ok(!compressed.dropped.includes('style_engine'));
  assert.ok(!compressed.summarized.includes('style_engine'));
});

test('planner persistence preserves rich execution scenes, reward and canonical hash', () => {
  const base = {expectation:'完成救治',hook:'下次能主动使用吗',targetWordCount:2600,
    taskSheet:'主动调整一次呼吸，成人完成泄压，必须脱险',
    sceneCards:JSON.stringify({targetWordCount:2600,readerExperience:{promisedReward:'真正脱险'},
      scenes:[{key:'rescue',resistance:'回流',turn:'捕捉间隙',readerValue:'脱险'}]})};
  const record = prepareStoryPlanRecord({novelId:'n',chapterId:'c',level:'chapter',title:'救治',
    objective:'只让祖母抬手',targetWordCount:2600,hookTarget:'继续观察',baseExecutionContract:base,
    participants:[],reveals:[],riskNotes:[],mustAdvance:[],mustPreserve:[],sourceIssueIds:[],replannedFromPlanId:null,
    scenes:[1,2,3].map(i=>({title:String(i),objective:'等待',reveal:'仍在等待'}))});
  assert.equal(record.taskSheet,base.taskSheet);
  assert.equal(record.sceneCards,base.sceneCards);
  assert.equal(record.expectation,base.expectation);
  assert.equal(record.hook,base.hook);
  assert.equal(JSON.parse(record.serializedRawPlan).executionContractHash,buildChapterExecutionContractHash(base));
});

test('contract refinement retries drift against independent source and preserves milestones', async () => {
  const requests=[], reviews=[];
  const input=generationInput({forceRegenerate:true,chapterTaskSheetQualityMode:'full_book_autopilot',
    chapterContractPorts:{invokePrompt:async request=>{requests.push(request);const output=candidate();return {output:{...output,
      exclusiveEvent:'仅观察，不调查',endingState:'还没拿到证据',sceneCards:JSON.parse(output.sceneCards).scenes}};},
      semanticAssessor:async review=>{reviews.push(review);return reviews.length===1 ? {...safe,
        sourceContractAlignment:'drifted',verdict:'unusable',safeToSync:false,recommendedHandling:'repair_contract',
        repairGuidance:['场景必须实际取得证据，不得全部等待']} : {...safe,sourceContractAlignment:'aligned'};}}});
  input.promptInput.targetChapter.styleContract='本章兑现成果，脱险后安排一句家庭反差。';
  const result=await generateChapterTaskSheetDetail(input);
  assert.equal(requests.length,2);
  assert.match(requests[1].promptInput.guidance,/场景必须实际取得证据/);
  assert.equal(reviews[0].candidate.sourceChapterContract.endingState,'拿到第一份证据。');
  assert.equal(reviews[0].candidate.endingState,'拿到第一份证据。');
  assert.equal(result.exclusiveEvent,'首次确认危机来自内部。');
  for (const id of ['source_chapter_contract','chapter_style_contract']) {
    const block=requests[0].contextBlocks.find(b=>b.id===id);
    assert.equal(block.required,true);assert.equal(block.allowSummary,false);
  }
});

test('persistent source drift cannot be downgraded into an autopilot warning', async () => {
  let calls=0;
  await assert.rejects(()=>generateChapterTaskSheetDetail(generationInput({forceRegenerate:true,
    chapterTaskSheetQualityMode:'full_book_autopilot',chapterContractPorts:{invokePrompt:async()=>{
      calls++;const output=candidate();return {output:{...output,sceneCards:JSON.parse(output.sceneCards).scenes}};},
    semanticAssessor:async()=>({...safe,sourceContractAlignment:'drifted',repairGuidance:['恢复本章救治结果']})}})),
    error=>error.result.issues.some(issue=>issue.id==='source_contract_drift'));
  assert.equal(calls,2);
});

 test('semantic review must explicitly compare a provided source contract', () => {
  const {chapterTaskSheetQualityPrompt:asset}=require('../../../dist/prompting/prompts/novel/volume/chapterTaskSheetQuality.prompts');
  assert.throws(()=>asset.postValidate(safe,{candidate:{sourceChapterContract:{summary:'本章完成救治'}}}),/sourceContractAlignment/);
  assert.doesNotThrow(()=>asset.postValidate({...safe,sourceContractAlignment:'aligned'},{candidate:{sourceChapterContract:{summary:'本章完成救治'}}}));
});

 test('compiled summaries do not consume the planner slot reserved for a concrete rule', () => {
  const {StyleCompiler}=require('../../../dist/services/styleEngine/StyleCompiler');
  const profile=Object.fromEntries(['narrativeRules','characterRules','languageRules','rhythmRules'].map(key=>[key,{summary:'章节摘要',action:'本章必须完成救治'}]));
  const {contract}=new StyleCompiler().compile({styleProfile:profile,antiAiRules:[]});
  assert.equal(contract.rhythm.lines.length,2);
  assert.match(buildPlannerStyleContractSummaryText(contract),/rhythm.action.*本章必须完成救治/);
});

 test('writer mission keeps execution outcomes when a supplemental plan narrows them', () => {
  const {buildChapterMissionContext}=require('../../../dist/prompting/prompts/novel/chapterLayeredContext');
  const mission=buildChapterMissionContext({chapter:{id:'c',order:1,title:'出生',expectation:'本章完成救治',taskSheet:'救治当章完成',targetWordCount:2600,hook:'学会小方法'},
    plan:{objective:'只抬手不救治',hookTarget:'继续窒息',mustAdvance:['等待下一章'],mustPreserve:[],riskNotes:[]},
    chapterStateGoal:{summary:'观察',targetConflicts:['继续等待'],targetRelationships:[]}},
    {scenes:[{mustAdvance:['成人撤阵片，呼吸稳定'],mustPreserve:['无前世修为']}],readerExperience:{endingHook:'方法可以主动重现'}});
  assert.equal(mission.objective,'本章完成救治');
  assert.equal(mission.hookTarget,'方法可以主动重现');
  assert.deepEqual(mission.mustAdvance,['成人撤阵片，呼吸稳定']);
  assert.deepEqual(mission.mustPreserve,['无前世修为']);
});
