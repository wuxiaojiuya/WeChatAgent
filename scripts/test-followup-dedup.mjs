import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {MessageBuffer} from '../components/qq-bridge/src/core/message-buffer.js';import {SocialEngine} from '../components/qq-bridge/src/core/social-engine.js';
const key='wechat:private:123',firstId='a'.repeat(64),laterId='b'.repeat(64);
const message=(id,text)=>({platform:'wechat',kind:'private',conversation_id:'123',self_id:'99',sender_id:'123',message_id:id,text,timestamp:Date.now()/1000});
async function until(check){for(let i=0;i<500;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('followup fixture timeout');}
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-followup-dedup-'));t.after(()=>{assert(dir.startsWith(os.tmpdir()+path.sep));fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});});const file=path.join(dir,'messages.json');return {dir,file,buffer:new MessageBuffer(file)};}
function create(t,buffer,options){const engine=new SocialEngine({buffer,batchMs:1,privateMinIntervalMs:0,maxPerMinute:100,maxPerTenMinutes:100,stickerPolicyFor:()=>({enabled:true,labelCache:true}),send:async()=>{},...options});t.after(()=>engine.stop());return engine;}

test('a lost decision response survives restart with the exact prompt, batch and sticker binding',async t=>{
 const f=fixture(t),requests=[],cache=new Map(),sent=[];let pool=firstId,modelCalls=0,lose=true;
 const decide=async(_key,prompt,metadata)=>{requests.push({prompt,metadata:structuredClone(metadata)});if(!cache.has(metadata.batchId)){modelCalls++;cache.set(metadata.batchId,'RESPOND: [STICKER:S1]');}if(lose){lose=false;throw Error('simulated response lost after model completion');}return cache.get(metadata.batchId);};
 const options={stickerChoicesFor:async()=>[{id:pool,description:'测试表情',tags:['问候']}],decide,sendSticker:async(_message,id)=>{sent.push(id);return {delivered:'database-confirmed'};}};
 const first=create(t,f.buffer,options);first.receive(message('first','早上好'));await until(()=>requests.length===1&&!first.running.has(key));first.stop();
 pool=laterId;const restored=new MessageBuffer(f.file),second=create(t,restored,options);second.replay(key);await until(()=>!restored.unread(key).length&&!second.running.has(key));
 await until(()=>sent.length===1);assert.equal(requests.length,2);assert.equal(requests[1].metadata.batchId,requests[0].metadata.batchId);assert.equal(requests[1].prompt,requests[0].prompt);assert.equal(modelCalls,1);assert.deepEqual(sent,[firstId]);
 assert.equal(restored.pendingRequests.size,0);
});

test('new arrivals wait behind a saved batch instead of resubmitting the old rows together',async t=>{
 const f=fixture(t),requests=[];let calls=0;
 const engine=create(t,f.buffer,{stickerPolicyFor:()=>({enabled:false}),decide:async(_key,prompt,metadata)=>{requests.push({prompt,ids:[...metadata.historyExcludeIds],batchId:metadata.batchId});if(++calls===1)throw Error('simulated connection reset');return 'SILENT';}});
 engine.receive(message('first','第一条独立消息'));await until(()=>requests.length===1&&!engine.running.has(key));engine.receive(message('second','第二条独立消息'));await until(()=>!f.buffer.unread(key).length&&!engine.running.has(key));
 assert.equal(requests.length,3);assert.equal(requests[1].batchId,requests[0].batchId);assert.deepEqual(requests[1].ids,requests[0].ids);assert.equal(requests[1].prompt,requests[0].prompt);assert.equal(requests[2].ids.length,1);assert.notEqual(requests[2].ids[0],requests[0].ids[0]);assert(!requests[2].prompt.includes('第一条独立消息'));
});

test('an admitted terminal failure releases only its own batch and leaves the next real message usable',async t=>{
 const f=fixture(t);let calls=0;const sent=[];
 const engine=create(t,f.buffer,{stickerPolicyFor:()=>({enabled:false}),decide:async()=>{if(++calls===1)throw Object.assign(Error('DSH plugin: turn_failed'),{admitted:true});return 'RESPOND: 后续消息正常';},send:async(_message,text)=>{sent.push(text);return {delivered:'database-confirmed'};}});
 engine.receive(message('first','失败的批次'));await until(()=>calls===1&&!engine.running.has(key));assert.equal(f.buffer.unread(key).length,0);assert.equal(f.buffer.pendingRequests.size,0);assert.equal(sent.length,0);
 engine.replay(key);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(calls,1);
 engine.receive(message('second','后续消息'));await until(()=>sent.length===1&&!engine.running.has(key));assert.equal(calls,2);assert.equal(f.buffer.unread(key).length,0);
});

test('different real message IDs with identical text are never collapsed',async t=>{
 const f=fixture(t);let calls=0;const engine=create(t,f.buffer,{stickerPolicyFor:()=>({enabled:false}),decide:async()=>{calls++;return 'SILENT';}});
 engine.receive(message('one','一样的文字'));await until(()=>calls===1&&!engine.running.has(key));engine.receive(message('two','一样的文字'));await until(()=>calls===2&&!engine.running.has(key));assert.equal(f.buffer.recent(key).filter(row=>!row.outgoing).length,2);
});
test('a malformed answer after its bounded repair cannot poison the persisted batch or later messages',async t=>{
 const f=fixture(t);let calls=0;const sent=[];const engine=create(t,f.buffer,{stickerPolicyFor:()=>({enabled:false}),decide:async()=>++calls<=2?'INVALID_OUTPUT_WITHOUT_PROTOCOL':'RESPOND: 后续仍可回复',send:async(_message,text)=>{sent.push(text);return{delivered:'database-confirmed'};}});
 engine.receive(message('bad-format','格式失败的消息'));await until(()=>calls===2&&!engine.running.has(key));assert.equal(f.buffer.unread(key).length,0);assert.equal(f.buffer.pendingRequests.size,0);assert.equal(sent.length,0);
 engine.replay(key);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(calls,2);engine.receive(message('after-bad-format','后续正常消息'));await until(()=>sent.length===1&&!engine.running.has(key));assert.equal(calls,3);
});
