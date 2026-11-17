const test=require('node:test');const assert=require('node:assert/strict');
const {setup}=require('../production/persistence/sqliteFixture.cjs');
const {loadRuntimeSource}=require('../novelProduction/sourceHarness.cjs');
const {StyleRulePolicyService,styleRulePolicySchema}=require('../../dist/services/styleEngine/policy/StyleRulePolicyService');
const helpers=require('../../dist/services/styleEngine/helpers');
async function fixture(t){
 const {db}=await setup(t);
 await db.antiAiRule.create({data:{id:'psych',key:'psych',name:'心理限制',description:'测试',type:'forbidden',severity:'high',enabled:true,globalBaselineEnabled:true}});
 for(const id of ['novel','chapter','task','other'])await db.styleProfile.create({data:{id,name:id,sourceType:'manual'}});
 const {AntiAiPolicyResolver}=loadRuntimeSource('../../styleEngine/AntiAiPolicyResolver.ts',{'../../db/prisma':{prisma:db},'./StyleEngineSeedService':{ensureStyleEngineSeedData:async()=>{}},'./helpers':helpers});
 return {db,service:new StyleRulePolicyService(db),resolver:new AntiAiPolicyResolver()};
}
const binding=(id,targetType)=>({id,styleProfileId:id,targetType,targetId:'book',priority:1,weight:1,enabled:true,styleProfile:{id,name:id,antiAiRules:[]}});
test('explicit rule choices inherit by scope and never disable the global rule for another book',async t=>{
 const h=await fixture(t);
 await h.service.update('novel',{rules:[{ruleId:'psych',mode:'disabled'}]});
 const resolve=bindings=>h.resolver.resolveFromBindings({matchedBindings:bindings});
 assert.equal((await resolve([binding('novel','novel'),binding('chapter','chapter')])).effectiveRules.length,0);
 assert.equal((await resolve([binding('other','novel')])).effectiveRules.length,1);
 await h.service.update('chapter',{rules:[{ruleId:'psych',mode:'enabled'}]});
 assert.equal((await resolve([binding('novel','novel'),binding('chapter','chapter')])).effectiveRules.length,1);
 await h.service.update('task',{rules:[{ruleId:'psych',mode:'disabled'}]});
 assert.equal((await resolve([binding('novel','novel'),binding('chapter','chapter'),binding('task','task')])).effectiveRules.length,0);
 await h.service.update('chapter',{rules:[{ruleId:'psych',mode:'inherit'}]});
 assert.equal((await resolve([binding('novel','novel'),binding('chapter','chapter')])).effectiveRules.length,0);
 assert.equal((await h.db.antiAiRule.findUnique({where:{id:'psych'}})).globalBaselineEnabled,true);
});
test('ordinary profile save preserves disabled exceptions, unknown and duplicate policy writes are atomic',async t=>{
 const h=await fixture(t);
 await h.service.update('novel',{rules:[{ruleId:'psych',mode:'disabled'}]});
 const {StyleProfileService}=loadRuntimeSource('../../styleEngine/StyleProfileService.ts',{
  '../../db/prisma':{prisma:h.db},'../../prompting/core/promptRunner':{},'../../prompting/prompts/style/style.prompts':{},
  './StyleEngineSeedService':{ensureStyleEngineSeedData:async()=>{}},'./helpers':helpers,'./styleCreation':{},'./styleExtraction':{},
 });
 await new StyleProfileService().updateProfile('novel',{name:'updated',antiAiRuleIds:['psych']});
 assert.equal((await h.service.read('novel')).rules[0].mode,'disabled');
 await assert.rejects(h.service.update('novel',{rules:[{ruleId:'psych',mode:'inherit'},{ruleId:'missing',mode:'disabled'}]}),/无法识别/);
 assert.equal((await h.service.read('novel')).rules[0].mode,'disabled');
 assert.equal(styleRulePolicySchema.safeParse({rules:[{ruleId:'psych',mode:'inherit'},{ruleId:'psych',mode:'enabled'}]}).success,false);
});
