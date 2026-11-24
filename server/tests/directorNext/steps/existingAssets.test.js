const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'director-assets-'));
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'file:' + path.join(dir, 'assets.db').replace(/\\/g, '/');
const {prisma} = require('../../../dist/db/prisma');
const {readExistingAssets} = require('../../../dist/app/director/existingAssets');
const {StoryMacroPlanService} = require('../../../dist/services/novel/storyMacro/StoryMacroPlanService');
const {inferExistingAssets} = require('../../../dist/modules/director/application/assetInference');
const {createGateOrchestrator} = require('../../../dist/modules/director/domain/gateOrchestrator');
const {directorProductionPlan} = require('../../../dist/modules/director/steps/planDefinition');
const contract = {runId:'run', novelId:'book', scope:'book', driver:'assisted', chapterRange:null,
  stepIdsInScope:['volume_strategy','volume_beat_sheet'], modelConfig:{route:'openai',model:'stub'},
  launchInput:{storyInput:'测试',estimatedChapterCount:10,worldMode:'skip',targetMode:'opening'}};

test('takeover does not confirm an existing skeleton without a strategy or skip its prerequisite', async () => {
  const methods = [[prisma.novel,'findUniqueOrThrow'],[prisma.bookContract,'findUnique'],
    [prisma.character,'findMany'],[prisma.volumePlanVersion,'findFirst'],[prisma.chapter,'findMany'],
    [StoryMacroPlanService.prototype,'getPlan']];
  const originals = methods.map(([owner,key]) => owner[key]);
  let strategyPlan = null;
  prisma.novel.findUniqueOrThrow = async () => ({worldId:null});
  prisma.bookContract.findUnique = async () => ({id:'contract'});
  prisma.character.findMany = async () => [{id:'character'}];
  prisma.chapter.findMany = async () => [{id:'body',order:1,content:'保留已有正文'}];
  StoryMacroPlanService.prototype.getPlan = async () => null;
  prisma.volumePlanVersion.findFirst = async () => ({id:'version',contentJson:JSON.stringify({
    volumes:[{id:'volume',sortOrder:1,title:'保留的卷',chapters:[]}],strategyPlan})});
  try {
    const assets = await inferExistingAssets(contract,{read:readExistingAssets,contentHash:()=> 'saved'});
    assert.equal(assets.some(asset => asset.type === 'volume_strategy' && asset.status === 'confirmed'),false);
    assert.equal(assets.find(asset => asset.type === 'chapter_draft').protectedUserContent,true);
    const facts = {artifacts:[...assets,{type:'story_macro',scope:'book',status:'confirmed'}].map(a=>({...a,version:1})),debts:[],stopSignal:null};
    assert.deepEqual(createGateOrchestrator().next({plan:directorProductionPlan,contract,facts}),{kind:'run_step',stepId:'volume_strategy'});
    strategyPlan = {volumes:[]};
    assert.equal((await readExistingAssets(contract)).some(asset => asset.type === 'volume_strategy'),false);
    strategyPlan = {volumes:[{sortOrder:1,planningMode:'hard',roleLabel:'开篇',coreReward:'回报',escalationFocus:'压力',uncertaintyLevel:'low'}]};
    assert.equal((await readExistingAssets(contract)).find(asset => asset.type === 'volume_strategy').usable,true);
  } finally {methods.forEach(([owner,key],i)=>{owner[key]=originals[i];});}
});

test('a cleared chapter supersedes old protected completion facts and reaches writing in the same scope', async () => {
 const methods=[[prisma.novel,'findUniqueOrThrow'],[prisma.bookContract,'findUnique'],[prisma.character,'findMany'],
  [prisma.volumePlanVersion,'findFirst'],[prisma.chapter,'findMany'],[StoryMacroPlanService.prototype,'getPlan']];
 const originals=methods.map(([owner,key])=>owner[key]);
 prisma.novel.findUniqueOrThrow=async()=>({worldId:null});prisma.bookContract.findUnique=async()=>null;
 prisma.character.findMany=async()=>[];prisma.volumePlanVersion.findFirst=async()=>null;
 prisma.chapter.findMany=async()=>[{id:'one',order:1,content:''},{id:'two',order:2,content:'保留相邻正文'}];
 StoryMacroPlanService.prototype.getPlan=async()=>null;
 try{
  const run={...contract,scope:'chapters:1-1',chapterRange:{from:1,to:1},stepIdsInScope:['chapter_batch']};
  const assets=await inferExistingAssets(run,{read:readExistingAssets,contentHash:()=> 'current'});
  const empty=assets.find(a=>a.type==='chapter_draft'&&a.scope==='chapter:1');
  assert.equal(empty.status,'stale');assert.equal(empty.protectedUserContent,false);
  assert.equal(assets.find(a=>a.type==='chapter_draft'&&a.scope==='chapter:2').protectedUserContent,true);
  const old=[{type:'chapter_draft',scope:'chapter:1',status:'user_edited',protectedUserContent:true,version:1},
   {type:'chapter_batch_closed',scope:run.scope,status:'confirmed',protectedUserContent:true,version:1}];
  const facts={artifacts:[...old,...assets.map(a=>({...a,version:2})),{type:'chapter_execution_contract',scope:run.scope,status:'confirmed',version:1}],debts:[],stopSignal:null};
  assert.deepEqual(createGateOrchestrator().next({plan:directorProductionPlan,contract:run,facts}),{kind:'run_step',stepId:'chapter_batch'});
  assert.equal(old[0].status,'user_edited');
 }finally{methods.forEach(([owner,key],i)=>{owner[key]=originals[i];});}
});

test('takeover and writer verification share a receipt for all saved chapters in the range', async (t) => {
  const {artifactContentHash, savedExecutionContract, verifyConfirmedExecutionContract} = require('../../../dist/modules/director');
  const chapters = [1, 2, 3].map(order => ({
    id: 'c' + order, order, taskSheet: '取证' + order, sceneCards: '核对' + order,
    targetWordCount: 2400, conflictLevel: order, revealLevel: null, mustAvoid: '勿提前揭示', content: '',
  }));
  const planned = chapters.map(({id, order, ...fields}) => ({
    ...fields, id: 'p' + order, chapterId: id, chapterOrder: order, title: '章节' + order, summary: '逐份取证',
  }));
  const version = {volumes: [{id: 'v', sortOrder: 1, title: '首卷', chapters: planned}]};
  // Prisma delegates expose their methods through a proxy.
  const mockMethod = (owner, key, implementation) => {
    const original = owner[key];
    owner[key] = implementation;
    t.after(() => { owner[key] = original; });
  };
  mockMethod(prisma.novel, 'findUniqueOrThrow', async () => ({worldId: null}));
  mockMethod(prisma.bookContract, 'findUnique', async () => null);
  mockMethod(prisma.character, 'findMany', async () => []);
  mockMethod(prisma.volumePlanVersion, 'findFirst', async () => ({id: 'version', contentJson: JSON.stringify(version)}));
  mockMethod(prisma.chapter, 'findMany', async () => chapters);
  mockMethod(StoryMacroPlanService.prototype, 'getPlan', async () => null);
  const run = {...contract, scope: 'chapters:1-3', chapterRange: {from: 1, to: 3},
    launchInput: {...contract.launchInput, targetVolumeId: 'v'}};
  const receipts = await inferExistingAssets(run, {read: readExistingAssets, contentHash: artifactContentHash});
  const receipt = receipts.find(item => item.type === 'chapter_execution_contract');
  assert.equal(receipt?.status, 'confirmed');
  assert.equal(receipt.contentHash, artifactContentHash(chapters.map(savedExecutionContract)));
  const db = {chapter: prisma.chapter,
    directorNextRun: {findFirst: async () => ({contractJson: JSON.stringify(run)})},
    directorNextArtifact: {findFirst: async () => receipt}};
  assert.equal(await verifyConfirmedExecutionContract(() => false, db, run.novelId, run.runId, 'c2'), true);
});
