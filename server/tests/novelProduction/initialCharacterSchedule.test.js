const test = require('node:test');
const assert = require('node:assert/strict');
const {createVolumeChapterListPrompt} = require('../../dist/prompting/prompts/novel/volume/chapterList.prompts');
const {buildVolumeWorkspaceDocument, normalizeVolumeWorkspaceDocument} = require('../../dist/services/novel/volume/volumeWorkspaceDocument');
const {mergeChapterList} = require('../../dist/services/novel/volume/volumeGenerationHelpers');

const config = {targetChapterCount:1,targetBeatKey:'open_hook',targetBeatLabel:'开卷抓手'};
const output = {beatKey:'open_hook',beatLabel:'开卷抓手',chapterCount:1,
  chapters:[{beatKey:'open_hook',title:'药铺开门',summary:'青禾拒绝交出药方，选择留下救治伤者。',plannedCharacterIds:['qing']}]};

test('V2 chapter split requires a known character schedule while V1 retains its output contract', () => {
  const asset = createVolumeChapterListPrompt({...config,characterIds:['qing','master']});
  assert.deepEqual(asset.outputSchema.parse(output).chapters[0].plannedCharacterIds,['qing']);
  assert.equal(asset.outputSchema.safeParse({...output,chapters:[{...output.chapters[0],plannedCharacterIds:['foreign']}]}).success,false);
  const {plannedCharacterIds,...old}=output.chapters[0];
  assert.equal(asset.outputSchema.safeParse({...output,chapters:[old]}).success,false);
  assert.deepEqual(asset.outputSchema.parse({...output,chapters:[{...old,plannedCharacterIds:[]}]}).chapters[0].plannedCharacterIds,[]);
  const legacy=createVolumeChapterListPrompt(config);
  assert.equal(legacy.version,'v9');
  assert.equal(legacy.outputSchema.safeParse({...output,chapters:[old]}).success,true);
  assert.equal(Object.hasOwn(legacy.outputSchema.parse(output).chapters[0],'plannedCharacterIds'),false);
});

test('initial schedules survive chapter merge and version serialization without filling unknown chapters', () => {
  const document=buildVolumeWorkspaceDocument({novelId:'book',volumes:[{id:'v',title:'第一卷',sortOrder:1,chapters:[]}],
    beatSheets:[{volumeId:'v',volumeSortOrder:1,status:'generated',beats:[{key:'open_hook',label:'开卷抓手',summary:'开门',chapterSpanHint:'1章',mustDeliver:['开门']}]}]});
  const merged=mergeChapterList(document,'v',document.beatSheets[0],[output]);
  const restored=normalizeVolumeWorkspaceDocument('book',JSON.stringify(merged));
  assert.deepEqual(restored.volumes[0].chapters[0].plannedCharacterIds,['qing']);
  const unknown=normalizeVolumeWorkspaceDocument('book',{volumes:[{id:'v',title:'卷',chapters:[{id:'p',title:'药铺',summary:'青禾走来'}]}]});
  assert.equal(Object.hasOwn(unknown.volumes[0].chapters[0],'plannedCharacterIds'),false);
});

test('V2 different beats share the same stable rules and character catalog before dynamic chapter context', () => {
  const {preparePromptExecution}=require('../../dist/prompting/core/promptRunner');
  const characters=[{id:'master',name:'师父',role:'导师',castRole:'mentor'},{id:'qing',name:'青禾',role:'药师',castRole:'protagonist'}];
  const promptInput={novel:{characters},retryReason:null};
  const first=preparePromptExecution({asset:createVolumeChapterListPrompt({...config,characterIds:['qing','master']}),promptInput});
  const later=preparePromptExecution({asset:createVolumeChapterListPrompt({targetChapterCount:3,targetBeatKey:'climax',targetBeatLabel:'卷末决战',characterIds:['qing','master'],isBookFinale:true}),promptInput:{...promptInput,novel:{characters:characters.slice().reverse().map(c=>({...c,currentState:'后来变化'}))}}});
  assert.deepEqual(first.messages.slice(0,2).map(m=>m.content),later.messages.slice(0,2).map(m=>m.content));
  assert.notEqual(first.messages[2].content,later.messages[2].content);
});

test('chapter task context carries the initial schedule as a refinable plan with identity mapping', () => {
  const {buildVolumeChapterDetailContextBlocks}=require('../../dist/prompting/prompts/novel/volume/contextBlocks');
  const chapter={id:'p',chapterOrder:1,title:'开门',summary:'救治伤者',payoffRefs:[],plannedCharacterIds:['qing']};
  const volume={id:'v',title:'第一卷',chapters:[chapter],openPayoffs:[]};
  const input={novel:{characters:[{id:'qing',name:'青禾',role:'药师'}]},workspace:{volumes:[volume]},
    storyMacroPlan:null,strategyPlan:null,targetVolume:volume,targetChapter:chapter,targetBeatSheet:null,detailMode:'task_sheet'};
  const blocks=buildVolumeChapterDetailContextBlocks(input);
  const schedule=blocks.find(block=>block.id==='character_initial_schedule');
  assert.ok(schedule); assert.equal(schedule.required,true);
  assert.match(schedule.content,/qing/); assert.match(schedule.content,/青禾/); assert.match(schedule.content,/细化/);
  assert.equal(buildVolumeChapterDetailContextBlocks({...input,targetChapter:{...chapter,plannedCharacterIds:undefined}}).some(b=>b.id==='character_initial_schedule'),false);
});

test('schedule schema exposes its allowed IDs to native output and JSON repair', () => {
  const {toJSONSchema} = require('zod');
  const asset = createVolumeChapterListPrompt({...config, characterIds:['qing','master']});
  const schema = toJSONSchema(asset.outputSchema);
  const schedule = schema.properties.chapters.items.properties.plannedCharacterIds;
  assert.deepEqual(schedule.items.enum, ['qing','master']);
  assert.equal(schedule.maxItems, 2);
  for (const ids of [['qing','qing'], ['qing7'], ['foreign']]) {
    assert.equal(asset.outputSchema.safeParse({
      ...output, chapters:[{...output.chapters[0], plannedCharacterIds:ids}],
    }).success, false);
  }
});

test('an empty catalog requires explicit empty schedules and remains JSON-schema serializable', () => {
  const {toJSONSchema} = require('zod');
  const asset = createVolumeChapterListPrompt({...config, characterCatalog:[]});
  assert.equal(toJSONSchema(asset.outputSchema).properties.chapters.items.properties.plannedCharacterIds.maxItems, 0);
  assert.equal(asset.outputSchema.safeParse(output).success, false);
  const empty = {...output, chapters:[{...output.chapters[0], plannedCharacterIds:[]}]};
  assert.deepEqual(asset.outputSchema.parse(empty), empty);
});

test('catalog identity is shared by generation, validation and repair', () => {
  const {preparePromptExecution} = require('../../dist/prompting/core/promptRunner');
  const catalog = [{id:'qing', name:'青禾', role:'药师', castRole:'protagonist'}];
  const asset = createVolumeChapterListPrompt({...config, characterCatalog:catalog});
  // A later render input cannot silently substitute a different catalog for the schema snapshot.
  const prepared = preparePromptExecution({asset, promptInput:{novel:{characters:[{id:'foreign',name:'别书人物'}]}}});
  assert.deepEqual(JSON.parse(prepared.messages[1].content.split('\n')[1]), catalog);
  assert.ok(asset.repairPolicy.guidance.includes(JSON.stringify(catalog)));
  assert.equal(asset.outputSchema.safeParse(output).success, true);
  assert.equal(asset.outputSchema.safeParse({...output, chapters:[{...output.chapters[0],plannedCharacterIds:['foreign']}]}).success, false);
});

test('chapter-list repair receives identities and corrects both ID typos without changing chapter content', async () => {
  const factory = require('../../dist/llm/factory');
  const {parseStructuredLlmRawContentDetailed} = require('../../dist/llm/structuredInvoke');
  const {runStructuredPrompt, setPromptRunnerStructuredInvokerForTests} = require('../../dist/prompting/core/promptRunner');
  const originalGetLLM = factory.getLLM;
  const catalog = [
    {id:'character-main-29w', name:'青禾', role:'主角'},
    {id:'character-ally-n3x', name:'白露', role:'盟友'},
  ];
  const asset = createVolumeChapterListPrompt({...config, targetChapterCount:4, characterCatalog:catalog});
  const expected = {...output, chapterCount:4, chapters:['撤离口封锁','林中会合','归还信物','城外坐标'].map((title,index) => ({
    ...output.chapters[0], title, summary:'青禾选择交换线索，白露交出信物，但城外留下新的威胁。',
    plannedCharacterIds:index % 2 ? catalog.map(c => c.id) : [catalog[0].id],
  }))};
  const malformed = structuredClone(expected);
  for (const index of [1,3]) malformed.chapters[index].plannedCharacterIds[1] += '7';
  let repairs = 0;
  factory.getLLM = async () => ({stream:async function* (messages) {
    repairs += 1;
    const system = messages[0].content;
    const human = messages[1].content;
    assert.ok(system.includes(JSON.stringify(catalog)), 'repair must retain the ID/name mapping');
    const schemaText = human.split('目标 JSON Schema（字段名、类型、必填项与长度约束以此为准）：\n')[1].split('\n\n原始模型输出')[0];
    const schema = JSON.parse(schemaText);
    assert.deepEqual(schema.properties.chapters.items.properties.plannedCharacterIds.items.enum, catalog.map(c => c.id));
    assert.match(human, /chapters\.1\.plannedCharacterIds\.1/);
    assert.match(human, /chapters\.3\.plannedCharacterIds\.1/);
    yield {content:JSON.stringify(expected)};
  }});
  setPromptRunnerStructuredInvokerForTests(input => parseStructuredLlmRawContentDetailed({
    ...input, rawContent:JSON.stringify(malformed),
  }));
  try {
    const result = await runStructuredPrompt({asset, promptInput:{novel:{characters:catalog}}, contextBlocks:[],
      options:{provider:'deepseek',model:'deepseek-chat'}});
    assert.deepEqual(result.output, expected);
    assert.equal(repairs, 1);
    assert.equal(result.meta.invocation.repairUsed, true);
  } finally {
    setPromptRunnerStructuredInvokerForTests(null);
    factory.getLLM = originalGetLLM;
  }
});

test('repair cannot accept a remaining unknown ID or silently discard its planned appearance', async () => {
  const factory = require('../../dist/llm/factory');
  const {parseStructuredLlmRawContentDetailed} = require('../../dist/llm/structuredInvoke');
  const originalGetLLM = factory.getLLM;
  const asset = createVolumeChapterListPrompt({...config, characterIds:['qing']});
  const malformed = {...output, chapters:[{...output.chapters[0], plannedCharacterIds:['qing7']}]};
  factory.getLLM = async () => ({stream:async function* () {yield {content:JSON.stringify(malformed)};}});
  try {
    await assert.rejects(parseStructuredLlmRawContentDetailed({
      rawContent:JSON.stringify(malformed), schema:asset.outputSchema, repairGuidance:asset.repairPolicy.guidance,
      label:`${asset.id}@${asset.version}`, provider:'deepseek', model:'deepseek-chat', maxRepairAttempts:1,
    }), /plannedCharacterIds/);
  } finally {
    factory.getLLM = originalGetLLM;
  }
});
