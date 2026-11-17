const test=require('node:test');const assert=require('node:assert/strict');
const {setup}=require('../production/persistence/sqliteFixture.cjs');
const {queueManualChapterSync}=require('../../dist/services/novel/chapterEditor/synchronization/ManualChapterSyncStore');
test('clearing a draft invalidates derived plans atomically while preserving written neighbors and author contracts',async t=>{
 const {db}=await setup(t);
 await db.chapter.update({where:{id:'chapter-1'},data:{taskSheet:'作者细纲',sceneCards:'原场景'}});
 await db.chapter.createMany({data:[{id:'empty',novelId:'novel-1',order:2,title:'未写',content:''},{id:'written',novelId:'novel-1',order:3,title:'已写',content:'已确认正文'}]});
 await db.storyStateSnapshot.create({data:{id:'old',novelId:'novel-1',sourceChapterId:'chapter-1'}});
 for(const [id,chapterId,sourceStateSnapshotId]of [['current','chapter-1',null],['dependent','empty','old'],['protected','written','old']]){
  await db.storyPlan.create({data:{id,novelId:'novel-1',chapterId,sourceStateSnapshotId,level:'chapter',title:'历史计划',objective:'旧稿事件',status:'active'}});
 }
 const clear=async(fail)=>db.$transaction(async tx=>{
  const chapter=await tx.chapter.update({where:{id:'chapter-1'},data:{content:''}});
  await queueManualChapterSync(tx,chapter);if(fail)throw Error('rollback');
 });
 await assert.rejects(clear(true),/rollback/);
 assert.equal(await db.storyPlan.count({where:{status:'active'}}),3);
 assert.ok((await db.chapter.findUnique({where:{id:'chapter-1'}})).content);
 await clear(false);
 assert.equal((await db.storyPlan.findUnique({where:{id:'current'}})).status,'stale');
 assert.equal((await db.storyPlan.findUnique({where:{id:'dependent'}})).status,'stale');
 assert.equal((await db.storyPlan.findUnique({where:{id:'protected'}})).status,'active');
 const c=await db.chapter.findUnique({where:{id:'chapter-1'}});assert.equal(c.taskSheet,'作者细纲');assert.equal(c.sceneCards,'原场景');
 assert.equal((await db.chapter.findUnique({where:{id:'written'}})).content,'已确认正文');
 assert.equal(await db.storyPlan.count(),3);
});
