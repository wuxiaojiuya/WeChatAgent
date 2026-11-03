import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {AssistantTasks} from '../packages/dsh-social-bridge-plugin/assistant-tasks.mjs';
import {AssistantThinkingFeedback,AssistantFeedback,feedbackSnapshot,saveFeedback,createProgressWriter,parseProgressPool} from '../packages/dsh-social-bridge-plugin/assistant-feedback.mjs';
import {BlockAssembler,createUserMessage} from '../packages/dsh-social-bridge-plugin/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
const key='wechat:private:123',phrases=['鱼还在认真琢磨，成果还没出锅。','脑袋里的小齿轮还在转，稍等鱼一会儿。','还没收工，鱼会把结果端过来。'];
async function fixture(t,{generate=async()=>phrases,timeoutMs=30}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'thinking-feedback-'));let now=100000,allowed=true,calls=0,finish;const timers=new Set(),sent=[];
 const tasks=new AssistantTasks({file:path.join(root,'tasks.json'),now:()=>now,allowed:()=>allowed,execute:(_body,signal)=>new Promise((resolve,reject)=>{finish=resolve;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})});
 const job=tasks.submit({conversationKey:key,assistantSender:'wxid_admin',batchId:'a'.repeat(64),message:'PRIVATE_TASK_TEXT_MUST_NOT_GO_TO_FEEDBACK'});await new Promise(resolve=>setImmediate(resolve));
 const beat=new AssistantThinkingFeedback({root,tasks,now:()=>now,timeoutMs,generate:async input=>{calls++;assert(!JSON.stringify(input).includes('PRIVATE_TASK_TEXT'));return generate(input);},styleFor:()=> '轻松俏皮的蓝色大肥鱼',isAllowed:()=>allowed,setTimer:(fn,ms)=>{const value={fn,ms,unref(){}};timers.add(value);return value;},clearTimer:value=>timers.delete(value)}),feedback=new AssistantFeedback({root,now:()=>now});
 const controller=new AbortController(),stop=beat.start(job.id,controller.signal);t.after(()=>{beat.close();tasks.close();fs.rmSync(root,{recursive:true,force:true});});
 return {root,tasks,beat,job,controller,stop,timers,sent,get calls(){return calls;},advance:ms=>now+=ms,allowed:value=>allowed=value,finish:output=>finish(output),tick:()=>beat.tick(job.id),deliver:()=>feedback.notify(tasks.view(tasks.get(job.id)),async(job,text)=>{sent.push({job,text});return {confirmed:true};}),save(change){const snap=feedbackSnapshot(root),settings=structuredClone(snap.settings);change(settings);saveFeedback(root,{revision:snap.revision,settings});}};
}

test('pure thinking produces periodic public feedback without any assistant message or tool call; one small request supplies the whole pool',async t=>{
 const f=await fixture(t);assert.equal([...f.timers][0].ms,15000);f.advance(14999);await f.tick();assert.equal(f.calls,0);assert.equal(f.tasks.get(f.job.id).feedback,undefined);
 f.advance(1);await f.tick();await f.deliver();assert.equal(f.calls,1);assert.equal(f.sent[0].text,'🐟 '+phrases[0]);assert.equal(f.sent[0].job.feedback.source,'heartbeat');assert.equal(f.tasks.get(f.job.id).steps,undefined);
 f.advance(15000);await f.tick();await f.deliver();f.advance(15000);await f.tick();await f.deliver();f.advance(15000);await f.tick();await f.deliver();assert.equal(f.calls,1);assert.equal(f.sent.length,3);assert.equal(new Set(f.sent.map(item=>item.text)).size,3);assert(f.sent.every(item=>!item.text.includes('排队中')&&!item.text.includes(f.job.id)));
});

test('normal model progress delays the heartbeat and both sources obey the same delivery cap',async t=>{
 const f=await fixture(t);f.save(s=>s.maxUpdates=1);f.advance(14000);f.tasks.progressMessage(f.job.id,{content:[{type:'text',text:'WECHAT_PROGRESS: 鱼先去找可靠来源。'},{type:'tool-call',name:'web_search'}]});await f.deliver();f.advance(1000);await f.tick();assert.equal(f.calls,0);f.advance(14000);await f.tick();await f.deliver();assert.equal(f.sent.length,1);
});

test('no heartbeat is generated for disabled, basic, custom-quote or approval-wait states',async t=>{
 const f=await fixture(t);for(const mode of ['off','basic','quotes']){f.save(s=>s.mode=mode);f.advance(20000);await f.tick();assert.equal(f.calls,0);}f.save(s=>s.mode='playful');f.tasks.update(f.job.id,{state:'waiting_approval',approval:{id:'A0123456789abcdef',action:'真实审批'}});f.advance(20000);await f.tick();assert.equal(f.calls,0);assert.equal(f.tasks.get(f.job.id).feedback,undefined);
});

test('a stalled noncooperative phrase request times out into truthful elapsed feedback and is never retried for the task',async t=>{
 let release;const f=await fixture(t,{generate:()=>new Promise(resolve=>release=resolve),timeoutMs:20});f.advance(15000);const at=Date.now();await f.tick();assert(Date.now()-at<1000);await f.deliver();assert.equal(f.sent[0].text,'🐟 还在处理这项任务，已用时 15 秒。');f.advance(15000);await f.tick();await f.deliver();assert.equal(f.calls,1);assert.equal(f.sent[1].text,'🐟 还在处理这项任务，已用时 30 秒。');release(phrases);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.tasks.get(f.job.id).feedback.text,'还在处理这项任务，已用时 30 秒。');
});

test('completion, cancellation and permission revocation discard late auxiliary results',async t=>{
 for(const action of ['complete','cancel','revoke']){
  let release,started;const gate=new Promise(resolve=>started=resolve),f=await fixture(t,{generate:()=>{started();return new Promise(resolve=>release=resolve);},timeoutMs:1000});f.advance(15000);const tick=f.tick();await gate;
  if(action==='complete'){f.finish({text:'RESPOND: 最终答案'});await new Promise(resolve=>setImmediate(resolve));}else if(action==='cancel')f.tasks.cancel(f.job.id);else f.allowed(false);
  release(phrases);await tick;assert.equal(f.tasks.get(f.job.id).feedback,undefined);await f.deliver();assert.equal(f.sent.length,0);
 }
});

test('new public output or a feedback-off setting during generation prevents a stale heartbeat',async t=>{
 for(const action of ['model','off']){
  let release,started;const gate=new Promise(resolve=>started=resolve),f=await fixture(t,{generate:()=>{started();return new Promise(resolve=>release=resolve);},timeoutMs:1000});f.advance(15000);const tick=f.tick();await gate;
  if(action==='model')f.tasks.progressMessage(f.job.id,{content:[{type:'text',text:'WECHAT_PROGRESS: 刚核对到一个关键线索。'},{type:'tool-call',name:'read'}]});else f.save(s=>s.mode='off');release(phrases);await tick;assert.equal(f.tasks.get(f.job.id).feedback?.source,action==='model'?'model':undefined);
 }
});

test('shutdown and main-task abort clear timers and abort auxiliary requests without affecting the final task output',async t=>{
 let entered,aborted=false;const gate=new Promise(resolve=>entered=resolve),f=await fixture(t,{generate:({signal})=>new Promise((resolve,reject)=>{entered();signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});}),timeoutMs:1000});f.advance(15000);const tick=f.tick();await gate;f.controller.abort();await tick;assert(aborted);assert.equal(f.beat.watches.size,0);assert.equal(f.timers.size,0);f.beat.close();assert.equal(f.beat.active,0);f.finish({text:'RESPOND: 主任务照常完成'});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.tasks.get(f.job.id).output.text,'RESPOND: 主任务照常完成');
});

test('phrase generation uses a short tool-free SDK request with no main history or reasoning and records its own token usage',async()=>{
 const requests=[],usage=[];const llm={resolveModelInfo:async()=>({reasoning:{efforts:[{id:'off'},{id:'high'}]}}),async *stream(options){requests.push(options);yield {type:'reasoning-delta',index:1,text:'AUXILIARY_PRIVATE_REASONING'};yield {type:'text-delta',index:0,text:JSON.stringify(phrases)};yield {type:'usage',usage:{inputTokens:100,outputTokens:50,cacheReadTokens:0}};yield {type:'finish',reason:{kind:'stop'}};}};
 const write=createProgressWriter({ctx:{get:()=>llm},provider:'fixture-provider',model:'fixture-model',createUserMessage,BlockAssembler,recordUsage:row=>usage.push(row)}),signal=new AbortController().signal;
 assert.deepEqual(await write({style:'蓝色大肥鱼，俏皮一点',count:3,key,signal}),phrases);assert.equal(requests.length,1);assert.deepEqual(requests[0].tools,[]);assert.equal(requests[0].maxTokens,384);assert.equal(requests[0].reasoningEffort,'off');assert.equal(requests[0].messages.length,1);assert(!JSON.stringify(requests[0].messages).includes('AUXILIARY_PRIVATE_REASONING'));assert(requests[0].sessionId.startsWith('assistant-feedback-'));assert.equal(usage[0].purpose,'assistant-feedback');assert.equal(usage[0].status,'settled');assert.equal(usage[0].usage.outputTokens,50);
});

test('invalid, multiline and control-protocol phrase pools are rejected, and unsupported reasoning-off is omitted',async()=>{
 for(const raw of ['not json','[]','["RESPOND: 错误"]','["第一行\\n第二行"]','["排队中"]','["'+ 'a'.repeat(81)+'"]'])assert.throws(()=>parseProgressPool(raw));
 assert.deepEqual(parseProgressPool(JSON.stringify([phrases[0],phrases[0]])),[phrases[0]]);
 let call;const llm={resolveModelInfo:async()=>({reasoning:{efforts:[{id:'high'}]}}),async *stream(options){call=options;yield {type:'text-delta',index:0,text:JSON.stringify([phrases[0]])};}};
 const write=createProgressWriter({ctx:{get:()=>llm},provider:'p',model:'m',createUserMessage,BlockAssembler});await write({style:'简短',count:1,key,signal:new AbortController().signal});assert(!Object.hasOwn(call,'reasoningEffort'));
});

test('auxiliary requests are concurrency-limited and another active task can still receive elapsed feedback',async t=>{
 let release,entered;const gate=new Promise(resolve=>entered=resolve),f=await fixture(t,{generate:()=>{entered();return new Promise(resolve=>release=resolve);},timeoutMs:1000});
 const other=f.tasks.submit({conversationKey:'wechat:private:456',assistantSender:'wxid_admin',batchId:'b'.repeat(64),message:'另一项任务'});await new Promise(resolve=>setImmediate(resolve));f.beat.start(other.id);f.advance(15000);const first=f.tick();await gate;await f.beat.tick(other.id);assert.equal(f.calls,1);assert.equal(f.tasks.get(other.id).feedback.source,'heartbeat');release(phrases);await first;assert.equal(f.beat.active,0);
});
