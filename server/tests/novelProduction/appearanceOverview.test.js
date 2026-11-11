const {test}=require('node:test');const assert=require('node:assert/strict');
const {summarizeAppearanceCoverage:summarize}=require('../../dist/services/novel/characters/appearances/overview');
const c=(order,coverage,events=[])=>({chapterOrder:order,coverage,events});
const event=(id,kind)=>({characterId:id,kind});
test('uses positive V2 appearances, deduplicates events and ignores future chapters',()=>{
 assert.deepEqual(summarize([c(1,'untracked',[event('a','present'),event('a','flashback')]),c(2,'recorded',[event('a','present')]),c(3,'recorded',[event('a','present')])],'a',new Set([1,2,3]),2),{orders:[1,2],hasUnverifiedAbsence:false});
});
test('unknown coverage cannot establish absence and mentions are not scene presence',()=>{
 assert.deepEqual(summarize([c(1,'recorded',[event('a','present')]),c(2,'untracked',[event('a','mention')])],'a',new Set([1,2]),2),{orders:[1],hasUnverifiedAbsence:true});
 assert.deepEqual(summarize([c(1,'recorded',[event('a','dream')])],'a',new Set([1]),1),{orders:[],hasUnverifiedAbsence:false});
});
const {payoffLedgerSyncPrompt:prompt}=require('../../dist/prompting/prompts/payoff/payoffLedgerSync.prompts');
const item=(key,extra={})=>({ledgerKey:key,scopeType:'book',currentStatus:'pending_payoff',sourceRefs:[{kind:'major_payoff',refId:'book_contract.chapter10Payoff'}],evidence:[],targetEndChapterOrder:10,...extra});
test('rejects duplicated fixed source and future payoff evidence',()=>{
 const input={bookContractPayoffs:[{refId:'book_contract.chapter10Payoff',targetEndChapterOrder:10}],latestWrittenChapterOrder:3};
 assert.throws(()=>prompt.postValidate({items:[item('a'),item('b')]},input,{}),/重复拆分/);
 assert.throws(()=>prompt.postValidate({items:[item('a',{currentStatus:'paid_off',payoffChapterOrder:10})]},input,{}),/未写章节/);
 assert.equal(prompt.postValidate({items:[item('a')]},input,{}).items.length,1);
});
