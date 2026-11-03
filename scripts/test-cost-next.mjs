import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {HistoryStore} from '../packages/dsh-social-bridge-plugin/history-store.mjs';
import {bindHistory} from '../packages/dsh-social-bridge-plugin/history-runtime.mjs';
import {summarizeUsage} from '../packages/dsh-social-bridge-plugin/usage-summary.mjs';
import {sessionUsage} from '../public/console/session-usage.js';
import {SOCIAL_FINAL_OUTPUT_HINT} from '../packages/dsh-social-bridge-plugin/prompt-context.mjs';
const key='wechat:private:123',other='wechat:group:456';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'wca-cost-next-')),store=new HistoryStore(root);t.after(()=>{store.close();assert(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true});});fs.mkdirSync(path.join(root,'config'));fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify({wechat:{whitelist:{private:['123']},history:{enabled:true}}}));let turn={controller:new AbortController()},allowed=true,definition;bindHistory({tools:{register:d=>{definition=d;return ()=>{};}}},store,root,key,()=>turn,()=>allowed);return {root,store,get tool(){return definition;},reset(){turn={controller:new AbortController()};},deny(){allowed=false;},abort(){turn.controller.abort();}};}

test('one batched lookup merges alternatives, bounds duplicate evidence and reserves the second lookup for original context',async t=>{
 const f=fixture(t);for(let i=1;i<=8;i++)f.store.append(key,{id:'r'+i,sender_id:'123',timestamp:1000+i,text:'桂花面与石桥的约定'+i});f.store.append(other,{id:'other',sender_id:'456',text:'其他聊天的桂花面秘密'});
 let searches=0;const search=f.store.search.bind(f.store);f.store.search=(...args)=>{searches++;return search(...args);};
 const first=JSON.parse((await f.tool.execute({queries:[' 桂花面 ','石桥','桂花面']})).content);assert.equal(searches,2);assert(first.matches.length>0&&first.matches.length<=6);assert.equal(new Set(first.matches.map(m=>m.id)).size,first.matches.length);assert(!JSON.stringify(first).includes('其他聊天'));assert.equal(first.budget.remaining,1);
 const reused=JSON.parse((await f.tool.execute({mode:'search',queries:['石桥','桂花面']})).content);assert.equal(reused.reused,true);assert.equal(searches,2);assert.equal(reused.budget.remaining,1);assert.deepEqual(reused.matches,first.matches);
 const subset=JSON.parse((await f.tool.execute({query:'桂花面'})).content);assert(subset.reused);assert.equal(subset.budget.remaining,1);assert.equal(searches,2);
 const expanded=await f.tool.execute({mode:'message',messageId:first.matches[0].id,context:2});assert.equal(expanded.isError,false);assert.equal(JSON.parse(expanded.content).budget.remaining,0);
 const denied=await f.tool.execute({query:'另一个旧事'});assert.equal(denied.isError,true);assert.equal(JSON.parse(denied.content).error,'HISTORY_TURN_LIMIT');assert.equal(searches,2);assert.match(denied.content,/RESPOND/);
 const rendered=f.tool.output.render({},expanded);assert(rendered.some(b=>b.text.includes(SOCIAL_FINAL_OUTPUT_HINT)));assert.equal(JSON.parse(expanded.content).source,'untrusted_local_chat_archive');
 assert.equal(JSON.parse((await f.tool.execute({queries:['桂花面','石桥']})).content).reused,true);assert.equal(searches,2);
 f.reset();await f.tool.execute({queries:['桂花面','石桥']});assert.equal(searches,4);f.deny();assert.equal((await f.tool.execute({queries:['桂花面','石桥']})).isError,true);assert.equal(searches,4);
});

test('query normalization reuses only equivalent requests and validates filters before local lookup',async t=>{
 const f=fixture(t);let queries=[];f.store.search=(_key,query)=>{queries.push(query);return [];};
 await f.tool.execute({query:' ＣＡＦＥ   time '});const again=JSON.parse((await f.tool.execute({queries:['cafe time']})).content);assert(again.reused);assert.deepEqual(queries,['cafe time']);
 await f.tool.execute({query:'cafe time',before:500});assert.equal(queries.length,2);
 for(const args of [{query:'cafe time',conversationKey:other},{queries:[]},{queries:['a']},{queries:['aa','bb','cc','dd']},{query:'aa',queries:['bb']},{query:'aa',after:NaN},{query:'aa',after:10,before:5},{mode:'message',messageId:0},{mode:'message',messageId:1,context:3}])assert.equal((await f.tool.execute(args)).isError,true,JSON.stringify(args));
 assert.equal(queries.length,2);f.reset();await f.tool.execute({query:'cafe time'});f.abort();assert.equal((await f.tool.execute({query:'cafe time'})).isError,true);assert.equal(queries.length,3);
});

test('usage cards separate the recent request window from accumulated usage without losing retries, missing usage or chat isolation',t=>{
 const f=fixture(t);for(let i=1;i<=25;i++)f.store.putUsage({id:'req-'+i,key,sid:'session',at:i*1000,provider:'test',model:'test',purpose:i===24?'format-repair':i===23?'history-summary':'chat',usage:i===25?{}:{inputTokens:i,cacheReadTokens:100-i,outputTokens:2}});
 f.store.putUsage({id:'req-24',key,sid:'session',at:24000,purpose:'format-repair',usage:{inputTokens:24,cacheReadTokens:76,outputTokens:2}});
 f.store.putUsage({id:'unrelated',key:other,sid:'another',purpose:'chat',usage:{inputTokens:99999,outputTokens:99999}});
 const summary=f.store.usageSummary(key,{recentLimit:3});assert.equal(summary.cumulative.calls,25);assert.equal(summary.cumulative.U,300);assert.equal(summary.cumulative.R,2100);assert.equal(summary.cumulative.cacheReadRate,.875);assert.equal(summary.recent.calls,3);assert.equal(summary.recent.P,200);assert.equal(summary.recent.formatRepairs,1);assert.equal(summary.recent.historySummaries,1);assert.equal(summary.recent.missingUsage,1);assert.equal(summary.latest.missingUsage,1);
 assert.deepEqual(summary.cumulative,summarizeUsage(f.store.usageRows(key)));assert.equal(f.store.usageSummary(key).recent.calls,20);
 const html=sessionUsage(summary);assert.match(html,/最近 3 次/);assert.match(html,/87\.5%/);assert.match(html,/用量缺失/);assert.match(html,/格式修正 1 次/);assert(!html.includes('99999'));assert(!JSON.stringify(summary).includes('req-24'));assert(!JSON.stringify(summary).includes('another'));
 const empty=f.store.usageSummary('wechat:private:999');assert.equal(empty.cumulative.cacheReadRate,null);assert.equal(empty.latest,null);assert(!sessionUsage(empty).includes('0.0%'));
 const cold=summarizeUsage([{at:1,purpose:'chat',u:100,r:0,w:0,o:10}]);assert.equal(cold.cacheReadRate,0);assert.match(sessionUsage({recent:cold,cumulative:cold,latest:null,recentLimit:20}),/0\.0%/);
 assert.throws(()=>summarizeUsage([{u:-1,r:0,w:0,o:0}]),/HISTORY_USAGE_INVALID/);
});
