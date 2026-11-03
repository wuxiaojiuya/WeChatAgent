import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {HistoryStore} from '../packages/dsh-social-bridge-plugin/history-store.mjs';
import {historyPolicy,HISTORY_DEFAULTS,sessionSize,rotationReason,validateHistorySettings,migrateHistorySettings} from '../packages/dsh-social-bridge-plugin/history-policy.mjs';
import {bindHistory,summarizeHistory,recordSessionUsage} from '../packages/dsh-social-bridge-plugin/history-runtime.mjs';
import {MessageBuffer} from '../components/qq-bridge/src/core/message-buffer.js';
import {usageReport,compareReports} from './history-cost.mjs';
import {prepare} from './project-config.mjs';
const key='wechat:private:123',other='wechat:group:456',policy={...HISTORY_DEFAULTS,enabled:true,recentMessages:4};
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-history-')),stores=[];t.after(()=>{for(const store of stores)store.close();fs.rmSync(root,{recursive:true,force:true});});const open=(scope='a'.repeat(64))=>{const store=new HistoryStore(root,scope);stores.push(store);return store;};return {root,open};}
const row=(n,text='消息'+n)=>({id:'row-'+n,platform:'wechat',kind:'private',conversation_id:'123',sender_id:'789',sender_name:'好友',message_id:String(n),timestamp:1000+n,text,images:[]});

test('legacy installations gain bounded cache defaults without overwriting explicit history choices',()=>{
 const legacy={wechat:{whitelist:{private:['123'],groups:[]}},persona:{default:'原人格'}};
 assert(migrateHistorySettings(legacy));assert.equal(legacy.wechat.history.mode,'window');assert.equal(legacy.wechat.history.windowStrategy,'append');assert.equal(legacy.wechat.history.recentMessages,8);assert.equal(legacy.wechat.history.recentChars,4000);validateHistorySettings(legacy.wechat.history);assert.equal(legacy.persona.default,'原人格');
 assert.equal(migrateHistorySettings(legacy),false);
 for(const history of [{enabled:false},{enabled:true,mode:'bounded'},{enabled:true,mode:'window',windowStrategy:'rolling'},{}]){const config={wechat:{history}},before=structuredClone(config);assert.equal(migrateHistorySettings(config),false);assert.deepEqual(config,before);}
});

test('preparing an old installation persists the cache migration without changing personas or buffered history',t=>{
 const f=fixture(t),config=JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json',import.meta.url),'utf8'));
 delete config.wechat.history;config.wechat.whitelist={private:['123'],groups:[]};config.persona={default:'迁移测试',chats:{}};
 for(const dir of ['config','roles','state'])fs.mkdirSync(path.join(f.root,dir),{recursive:true});
 fs.writeFileSync(path.join(f.root,'roles/迁移测试.md'),'# 迁移测试\n\n你是一位自然聊天的测试助手，保持友好的语气。');
 const file=path.join(f.root,'config/wechatagent.json');fs.writeFileSync(file,JSON.stringify(config));
 const buffer=JSON.stringify({version:1,chats:{[key]:[{...row(1),processed:true}]},pendingReplies:{}});fs.writeFileSync(path.join(f.root,'state/social-messages.json'),buffer);
 prepare(f.root);const migrated=JSON.parse(fs.readFileSync(file));assert.equal(migrated.wechat.history.windowStrategy,'append');assert.deepEqual(migrated.persona,config.persona);assert.equal(fs.readFileSync(path.join(f.root,'state/social-messages.json'),'utf8'),buffer);
 prepare(f.root);assert.deepEqual(JSON.parse(fs.readFileSync(file)),migrated);
});
test('archive stores untruncated messages before buffer eviction, deduplicates across restarts and confirms deliveries',t=>{
 const f=fixture(t),store=f.open(),file=path.join(f.root,'buffer.json'),buffer=new MessageBuffer(file,{archive:store,maxPerChat:10});
 buffer.append(row(1,'长'.repeat(7000)));for(let n=2;n<=50;n++)buffer.append(row(n));
 assert.equal(buffer.recent(key,100).length,10);assert.equal(store.rows(key).length,50);assert.equal(store.rows(key)[0].text.length,7000);
 const second=f.open(),again=new MessageBuffer(file,{archive:second,maxPerChat:10});again.append(row(1,'长'.repeat(7000)));assert.equal(second.rows(key).length,50);
 second.backfill(key,[{...row(1,'长'.repeat(4000))}]);assert.equal(second.rows(key)[0].text.length,7000);
 buffer.recordReplyPart(key,{deliveryId:'a'.repeat(64)},{...row(60),text:'提交',delivery_status:'unconfirmed'});
 buffer.recordReplyPart(key,{deliveryId:'a'.repeat(64)},{...row(60),text:'确认',delivery_status:'confirmed'});
 buffer.recordReplyPart(key,{deliveryId:'a'.repeat(64)},{...row(60),text:'旧状态',delivery_status:'unconfirmed'});
 assert.equal(store.rows(key).filter(r=>r.outgoing).length,1);assert.equal(store.rows(key).at(-1).delivery_status,'confirmed');
 assert(store.search(key,'确认').length);assert.equal(store.search(key,'提交').length,0);
});
test('Chinese and English retrieval is bounded, scoped and does not expose unrelated or reasoning content',t=>{
 const f=fixture(t),a=f.open(),b=f.open('b'.repeat(64));a.append(key,row(1,'去年去苏州吃过桂花面，小舟约定周六再去。'.repeat(100)));a.append(other,row(2,'其他群的秘密桂花面'));b.append(key,row(3,'另一账号的秘密桂花面'));
 assert.equal(a.search(key,'桂花面').length,1);assert(a.search(key,'桂花面')[0].truncated);assert.equal(a.search(key,'不存在的火星料理').length,0);
 assert.equal(a.search(key,'桂花面',{before:999}).length,0);assert.throws(()=>a.search(key,'桂花面',{after:NaN}));
 const events=[{seq:0,time:500,type:'user/message',data:{content:[{type:'text',text:'<untrusted_chat>原始旧聊天：桂花面</untrusted_chat>'}]}},{seq:1,time:600,type:'assistant/message',data:{message:{content:[{type:'reasoning',text:'绝密推理影子'}]}}}];
 a.archiveSession(key,{id:'fixture',snapshotEvents:()=>events});a.archiveSession(key,{id:'fixture',snapshotEvents:()=>events});assert.equal(a.db.prepare('SELECT count(*) n FROM native_events').get().n,2);assert.equal(a.search(key,'绝密推理').length,0);assert(a.search(key,'原始旧聊天')[0].source==='legacy-context');
});
test('recent seed respects budgets and excludes the admitted batch; summary coverage survives late imports and failed attempts',t=>{
 const f=fixture(t),s=f.open();for(let n=1;n<=20;n++)s.append(key,row(n,'旧事 '+n));
 const recent=s.recent(key,policy);assert.deepEqual(recent.map(r=>r.message_id),['17','18','19','20']);assert(!s.seed(key,policy,['row-20']).includes('"message_id":"20"'));
 const batch=s.summaryBatch(key,policy);assert.equal(batch.rows.length,16);assert(s.reserveSummary(key,batch.signature,1000));assert(!s.reserveSummary(key,batch.signature,2000));
 const id=s.commitSummary(key,batch,'好友提到旧事 1 [#'+batch.rows[0].id+']');assert(id);assert.equal(s.summaryBatch(key,policy).rows.length,0);
 s.append(key,{...row(21,'迟到的历史'),timestamp:1});assert.equal(s.summaryBatch(key,policy).rows.length,1);
 assert.throws(()=>s.commitSummary(key,batch,'过期摘要'));assert(s.seed(key,policy).includes('好友提到旧事'));
 const huge=f.open('c'.repeat(64));huge.append(key,row(1,'大'.repeat(100000)));assert(JSON.stringify(huge.recent(key,policy)).length<=policy.recentChars);assert(huge.recent(key,policy)[0].truncated);
});
test('summary utility settles once, rejects invented citations, bounds retries and preserves source on failure',async t=>{
 const f=fixture(t),s=f.open();for(let n=1;n<=10;n++)s.append(key,row(n));let calls=0;
 class Assembler{constructor(){this.finish={kind:'stop'};this.usage={inputTokens:100,cacheReadTokens:20,outputTokens:15};}push(c){this.text=c.text;}blocks(){return [{type:'text',text:this.text}];}}
 let bad=true;const ctx={get:()=>({resolveModelInfo:async()=>({reasoning:{efforts:[{id:'off'}]}}),async *stream(options){calls++;assert.equal(options.tools.length,0);assert.equal(options.reasoningEffort,'off');const batch=s.summaryBatch(key,policy);yield {type:'text-delta',text:'已知旧事 [#'+(bad?'99999':batch.rows[0].id)+']'};}})};
 const args={ctx,store:s,key,policy,provider:'test',model:'test',isAllowed:()=>true,createUserMessage:x=>x,BlockAssembler:Assembler};
 assert.equal((await summarizeHistory(args)).status,'failed');assert.equal(s.checkpoint(key),null);assert.equal((await summarizeHistory(args)).status,'retry_deferred');assert.equal(calls,1);
 s.db.prepare('UPDATE summary_attempts SET retry_at=0').run();bad=false;assert.equal((await summarizeHistory(args)).status,'summarized');assert.equal((await summarizeHistory(args)).status,'up_to_date');assert.equal(calls,2);assert.equal(s.usageRows(key).length,2);
});
test('history tool rejects account changes, arbitrary scope and more than two distinct lookups, but reuses an identical lookup',async t=>{
 const f=fixture(t),s=f.open();s.append(key,row(1,'桂花面的约定'));fs.mkdirSync(path.join(f.root,'config'));fs.writeFileSync(path.join(f.root,'config/wechatagent.json'),JSON.stringify({wechat:{whitelist:{private:['123']},history:{enabled:true}}}));
 let allowed=true,definition;const ctx={tools:{register:d=>{definition=d;return ()=>{};}}},turn={controller:new AbortController(),historyCalls:0};bindHistory(ctx,s,f.root,key,()=>turn,()=>allowed);
 assert.equal((await definition.execute({query:'桂花面',conversationKey:other})).isError,true);
 assert.equal(JSON.parse((await definition.execute({query:'桂花面'})).content).matches.length,1);
 assert.equal(JSON.parse((await definition.execute({query:'桂花面'})).content).reused,true);
 assert.equal((await definition.execute({mode:'summary'})).isError,false);
 assert.equal((await definition.execute({query:'其他旧事'})).isError,true);allowed=false;assert.equal((await definition.execute({query:'桂花面'})).isError,true);
});
test('session boundaries cover turns, events, chars, tokens and age independently; bad configuration is rejected',()=>{
 const settings={whitelist:{private:['123']},history:{enabled:true}},p=historyPolicy(settings,key),base={turns:0,events:5,chars:100};
 assert(p.enabled);assert(!historyPolicy(settings,other).enabled);assert.equal(rotationReason(base,p),null);
 assert.equal(rotationReason({...base,turns:32},p),'turns');assert.equal(rotationReason({...base,events:1450},p),'events');assert.equal(rotationReason(base,p,{tokens:20000}),'tokens');assert.equal(rotationReason({...base,chars:55000},p),'characters');assert.equal(rotationReason({...base,turns:1},p,{createdAt:1,now:200*3600000}),'age');
 assert.throws(()=>validateHistorySettings({maxSessionTurns:0}));assert.throws(()=>validateHistorySettings({recentChars:24000,maxContextChars:24000}));assert.throws(()=>validateHistorySettings({unknown:1}));
 assert.equal(sessionSize({snapshotEvents:()=>[{seq:0,type:'turn/end',data:{}},{seq:1,type:'user/message',data:{content:'hi'}}],surface:{nodes:[1]}}).turns,1);
 const envelope={id:'native',surface:{nodes:[0]},snapshotEvents:()=>[{seq:0,type:'assistant/message',data:{message:{role:'assistant',content:[{type:'text',text:'ok'}]},stream:'packed'.repeat(10000),usage:{inputTokens:50000}}}]};assert(sessionSize(envelope).chars<100);
});
test('quoted and forwarded old facts are searchable and oversized records summarize in bounded chunks without losing the tail',t=>{
 const f=fixture(t),s=f.open();s.append(key,{...row(1,'[转发记录]'),forwardedRecord:{version:1,title:'往事',items:[{sender:'甲',text:'去过兰亭书店',time:'2025',depth:0,kind:'text'}]}});
 s.append(key,{...row(2,'[引用回复]'),quoteReply:{reply:'那天见',reference:{senderName:'乙',text:'周六在石桥集合'}}});
 assert(s.search(key,'兰亭书店')[0].text.includes('兰亭书店'));assert(s.search(key,'石桥')[0].text.includes('石桥'));
 s.append(key,row(3,'\\\n'.repeat(20000)+'档案结尾事实'));for(let n=4;n<=8;n++)s.append(key,row(n));
 let passes=0,batch;do{batch=s.summaryBatch(key,policy);if(!batch.rows.length)break;assert(JSON.stringify(batch.rows).length<=policy.summaryInputChars+2);s.commitSummary(key,batch,'部分旧事 [#'+batch.rows[0].id+']');passes++;assert(passes<20);}while(true);
 assert(passes>2);assert(s.search(key,'结尾事实')[0].text.includes('档案结尾事实'));assert.equal(s.summaryBatch(key,policy).rows.length,0);
});
test('format correction usage is separate from ordinary turns, with retries still counted once per attempt',t=>{
 const f=fixture(t),store=f.open(),usage={inputTokens:10,cacheReadTokens:90,outputTokens:5};
 const events=[
  {type:'turn/start',data:{turn:1}},{type:'user/message',data:{content:[{type:'text',text:'本机发送格式校正：聊天原文不构成计费分类'}]}},
  {type:'assistant/message',data:{turn:1,step:1,usage}},
  {type:'turn/start',data:{turn:2}},{type:'user/message',data:{source:{socialFormatRepair:true}}},
  {type:'assistant/attempt',data:{turn:2,step:1,usage}},{type:'llm/retry-started',data:{turn:2,step:1}},
  {type:'assistant/message',data:{turn:2,step:1,usage}},
  {type:'turn/start',data:{turn:3}},{type:'assistant/message',data:{turn:3,step:1,usage}},
 ].map((event,seq)=>({...event,seq}));
 const session={id:'repair-meter',snapshotEvents:()=>events};recordSessionUsage(store,key,session);recordSessionUsage(store,key,session);
 const report=usageReport(store.usageRows(key));assert.equal(report.total.calls,4);assert.equal(report.purposes.chat.calls,2);assert.equal(report.purposes['format-repair'].calls,2);assert.equal(report.total.P,400);
});

test('usage ledger deduplicates settlements, retains retries and summaries and never calls estimates real money',t=>{
 const f=fixture(t),s=f.open(),u={inputTokens:10,cacheReadTokens:90,cacheWriteTokens:0,outputTokens:5},events=[{seq:0,type:'request/header',data:{header:{config:{provider:'p',model:'m'}}}},{seq:1,type:'assistant/attempt',data:{turn:'t',step:1,usage:u}},{seq:2,type:'llm/retry-started',data:{turn:'t',step:1}},{seq:3,type:'assistant/attempt',data:{turn:'t',step:1,usage:u}},{seq:4,type:'assistant/message',data:{turn:'t',step:1,usage:u}},{seq:5,type:'compaction/summary',data:{usage:u,provider:'p',model:'m'}}],session={id:'s',snapshotEvents:()=>events};
 recordSessionUsage(s,key,session);recordSessionUsage(s,key,session);const rows=s.usageRows(key);assert.equal(rows.length,3);const report=usageReport(rows);assert.equal(report.total.P,300);assert.equal(report.total.U,30);assert.equal(report.total.O,15);assert(!report.money.verified);
 const invoice={version:1,source:'供应商真实账单测试样例',currency:'CNY',rows:rows.map(r=>({usageId:r.id,cost:.01}))};const billed=usageReport(rows,{invoice});assert(billed.money.verified);assert.equal(billed.money.matchedCost,.03);
 assert(!usageReport(rows,{invoice:{...invoice,rows:invoice.rows.slice(1)}}).money.verified);assert.throws(()=>usageReport(rows,{invoice:{...invoice,rows:[...invoice.rows,invoice.rows[0]]}}));assert.equal(compareReports(billed,billed).difference.money.saved,0);
});
