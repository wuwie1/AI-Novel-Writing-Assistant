const test = require('node:test');
const assert = require('node:assert/strict');
const {setup} = require('../production/persistence/sqliteFixture.cjs');
const {CanonicalStateService} = require('../../dist/services/novel/state/CanonicalStateService');
const {buildChapterArtifactContentHash: hash} = require('../../dist/services/novel/runtime/artifactSync/ChapterArtifactContentVersion');
const boundary = require('../../dist/services/novel/state/context/ChapterStateBoundary');
async function receipt(db, chapterId, content) {
  await db.chapterArtifactSyncCheckpoint.create({data: {novelId:'novel-1', chapterId,
    contentHash: hash(content), artifactType:'artifact_sync_boundary:v1', syncMode:'unified', status:'succeeded', metadataJson:JSON.stringify({outcome:'completed'})}});
}
test('opening excludes old body knowledge and projected future relationships without deleting history', async t => {
  const {db} = await setup(t);
  await db.character.createMany({data:[{id:'hero', novelId:'novel-1', name:'主角',role:'主角',currentState:'出生时体弱\n【信息边界】旧稿第三章认出敌人',currentGoal:'活下来'},
    {id:'other',novelId:'novel-1',name:'同伴',role:'配角',currentState:'已掌握未来秘术',currentGoal:'未来目标',lastEvolvedAt:new Date()}]});
  await db.chapter.create({data:{id:'chapter-3',novelId:'novel-1',order:3,title:'旧稿第三章',content:''}});
  await db.storyStateSnapshot.create({data:{id:'old-state',novelId:'novel-1',sourceChapterId:'chapter-3',summary:'旧稿终局',characterStates:{create:{characterId:'hero',knownFactsJson:'["敌人真身"]',summary:'已能战斗'}}}});
  await db.characterRelationStage.create({data:{novelId:'novel-1',sourceCharacterId:'hero',targetCharacterId:'other',chapterOrder:30,stageLabel:'决战与封镇',stageSummary:'未来发展',sourceType:'volume_projection',isCurrent:true}});
  const before = await new CanonicalStateService().getSnapshot('novel-1',{chapterOrder:1},db);
  assert.equal(before.sourceSnapshotId,null);
  assert.equal(before.characters.find(c=>c.characterId==='hero').currentState,'出生时体弱');
  assert.equal(before.characters.find(c=>c.characterId==='other').currentState,null);
  assert.deepEqual(before.characters.flatMap(c=>c.relationStageLabels),[]);
  assert.doesNotMatch(JSON.stringify(before),/敌人真身|旧稿第三章|决战与封镇|未来秘术/);
  assert.equal(await db.storyStateSnapshot.count(),1);
  assert.match((await db.character.findUnique({where:{id:'hero'}})).currentState,/旧稿第三章/);
});
test('only a prior synchronized source with a matching snapshot revision enters chapter context', async t=>{
  const {db,context}=await setup(t);
  await db.character.create({data:{id:'hero',novelId:'novel-1',name:'主角',role:'主角',currentState:'初始状态'}});
  await receipt(db,'chapter-1',context.content);
  await db.storyStateSnapshot.create({data:{id:'s1',novelId:'novel-1',sourceChapterId:'chapter-1',rawStateJson:JSON.stringify({sourceContentHash:hash(context.content)}),
    characterStates:{create:{characterId:'hero',summary:'已交出钥匙',knownFactsJson:'["城门关闭"]',currentGoal:'返回'}}}});
  const service=new CanonicalStateService();
  const valid=await service.getSnapshot('novel-1',{chapterOrder:2},db);
  assert.equal(valid.sourceSnapshotId,'s1');assert.match(valid.characters[0].currentState,/已交出钥匙.*城门关闭/);
  assert.equal((await service.getSnapshot('novel-1',{chapterOrder:1},db)).sourceSnapshotId,null);
  await db.chapter.update({where:{id:'chapter-1'},data:{content:'重写后完全不同的事件'}});
  assert.equal((await service.getSnapshot('novel-1',{chapterOrder:2},db)).sourceSnapshotId,null);
  await receipt(db,'chapter-1','重写后完全不同的事件');
  assert.equal((await service.getSnapshot('novel-1',{chapterOrder:2},db)).sourceSnapshotId,null,'new receipt cannot bless old snapshot');
  assert.equal(await db.storyStateSnapshot.count(),1);
});
test('extraction projects prior snapshot over clean baseline and scopes resource/payoff changes',()=>{
  const projected=boundary.projectChapterCharacters([{id:'a',currentState:'基线\n【信息边界】旧认知',currentGoal:'存活'}],
    [{characterId:'a',summary:'本轮前章状态',knownFactsJson:'["本轮事实"]',currentGoal:'求助'}]);
  assert.deepEqual(projected,[{id:'a',currentState:'本轮前章状态；已知：本轮事实',currentGoal:'求助'}]);
  const sources=new Set(['valid']);
  assert.equal(boundary.payoffVisibleBeforeChapter({lastTouchedChapterId:'old',lastTouchedChapterOrder:1},2,sources),false);
  assert.equal(boundary.payoffVisibleBeforeChapter({lastTouchedChapterId:'valid',lastTouchedChapterOrder:3},2,sources),false);
  assert.equal(boundary.resourceVisibleBeforeChapter({lastTouchedChapterId:'valid',lastTouchedChapterOrder:1},2,sources),true);
});

test('native production receipts establish the same state boundary without legacy checkpoints',async t=>{
 const {db,context,kernel}=await setup(t);
 assert.deepEqual(await boundary.readChapterStateSources('novel-1',2,db),[],'commit alone is not reconciliation');
 const progress={...context.run.progress, completed:['prepare','draft','accept','select','commit','reconcile'],reconcileStatus:'completed'};
 await db.productionUnitRun.update({where:{id:context.run.id},data:{progressJson:JSON.stringify(progress)}});
 assert.equal((await boundary.readChapterStateSources('novel-1',2,db))[0].id,'chapter-1');
 await db.chapter.update({where:{id:'chapter-1'},data:{content:'替换稿'}});
 assert.deepEqual(await boundary.readChapterStateSources('novel-1',2,db),[]);
});
