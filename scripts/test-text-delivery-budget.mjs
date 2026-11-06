import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {SocialEngine} from '../components/qq-bridge/src/core/social-engine.js';
import {MessageBuffer} from '../components/qq-bridge/src/core/message-buffer.js';

const key='wechat:private:123',texts=['凌晨两点半点歌','行吧，我自己挑了首','在弄了，慢'];
const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
async function until(check){for(let index=0;index<500;index++){if(check())return;await wait(2);}assert.fail('text delivery fixture timed out');}
function fixture(t,{send,timeoutMs,maxTextParts=3}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'text-delivery-budget-')),buffer=new MessageBuffer(path.join(root,'messages.json')),sent=[],logs=[];let modelCalls=0;
  const engine=new SocialEngine({buffer,workModeFor:()=> 'assistant',assistantAccess:()=>true,assistantBatchMs:1,batchMs:1,minIntervalMs:0,privateMinIntervalMs:0,maxPerMinute:100,maxPerTenMinutes:100,maxTextPartsFor:()=>maxTextParts,stickerPolicyFor:()=>({enabled:false}),
    deliveryRetry:timeoutMs===undefined?{}:{textCallTimeoutMs:timeoutMs},decide:async()=>{modelCalls++;return 'RESPOND: '+texts.join('\n\n');},send:async(message,text,options)=>{sent.push({text,id:options.deliveryId});return send?send(message,text,options,sent.length):{delivered:'database-confirmed'};},log:line=>logs.push(line)});
  t.after(()=>{engine.stop();fs.rmSync(root,{recursive:true,force:true});});
  const receive=()=>engine.receive({platform:'wechat',kind:'private',conversation_id:'123',sender_id:'123',sender_wxid:'wxid_fixture',self_id:'99',message_id:crypto.randomUUID(),text:'唱首歌',timestamp:Date.now()/1000});
  const settled=()=>until(()=>sent.length>0&&!engine.running.has(key)&&buffer.unread(key).length===0);
  return {root,buffer,engine,sent,logs,receive,settled,modelCalls:()=>modelCalls};
}

test('text delivery waits beyond the production 45 second OneBot action without exposing a user setting',t=>{
  const f=fixture(t);assert.equal(f.engine.deliveryRetry.textCallTimeoutMs,50000);assert(f.engine.deliveryRetry.textCallTimeoutMs>45000);
  for(const textCallTimeoutMs of [0,-1,0.5,NaN,60001])assert.throws(()=>new SocialEngine({buffer:f.buffer,deliveryRetry:{textCallTimeoutMs}}),/Invalid delivery retry limit/);
});

test('a delayed confirmed first receipt allows every paragraph to send once under the injected text budget',async t=>{
  const f=fixture(t,{timeoutMs:300,send:async(message,text,options,index)=>{if(index===1)await wait(35);return {confirmed:true,delivered:'database-confirmed'};}});
  f.receive();await f.settled();assert.deepEqual(f.sent.map(item=>item.text),texts);assert.equal(new Set(f.sent.map(item=>item.id)).size,3);assert.equal(f.modelCalls(),1);
  assert.deepEqual(f.buffer.recent(key).filter(row=>row.outgoing).map(row=>({text:row.text,status:row.delivery_status})),texts.map(text=>({text,status:'confirmed'})));assert.equal(f.buffer.contextNotices.has(key),false);
});

test('an actual text deadline cancels remaining paragraphs, preserves the uncertain first record and ignores a late success',async t=>{
  let release;const late=new Promise(resolve=>release=resolve),f=fixture(t,{timeoutMs:12,send:()=>late});
  f.receive();await f.settled();assert.deepEqual(f.sent.map(item=>item.text),[texts[0]]);assert.match(f.buffer.contextNotices.get(key).text,/响应超时/);
  const outgoing=f.buffer.recent(key).filter(row=>row.outgoing);assert.equal(outgoing.length,1);assert.equal(outgoing[0].delivery_status,'unconfirmed');assert.equal(f.buffer.pendingReplies.size,0);
  release({confirmed:true,delivered:'database-confirmed'});await wait(25);f.engine.replay(key);await wait(10);
  assert.equal(f.sent.length,1);assert.equal(f.modelCalls(),1);assert.equal(f.buffer.recent(key).filter(row=>row.outgoing).length,1);
});

test('an explicit unconfirmed first receipt stops all later paragraphs and never automatically resubmits',async t=>{
  const f=fixture(t,{timeoutMs:300,send:async()=>({confirmed:false,attempted:true,delivered:'unconfirmed'})});
  f.receive();await f.settled();assert.deepEqual(f.sent.map(item=>item.text),[texts[0]]);assert.match(f.buffer.contextNotices.get(key).text,/后续 2 条没有发送/);
  assert.equal(f.buffer.recent(key).filter(row=>row.outgoing)[0].delivery_status,'unconfirmed');f.engine.replay(key);await wait(15);assert.equal(f.sent.length,1);assert.equal(f.modelCalls(),1);
});

test('the existing two-message cap merges extra paragraphs without dropping their contents',async t=>{
  const f=fixture(t,{timeoutMs:300,maxTextParts:2});f.receive();await f.settled();assert.deepEqual(f.sent.map(item=>item.text),[texts[0],texts.slice(1).join('\n\n')]);
  assert.equal(f.buffer.recent(key).filter(row=>row.outgoing).map(row=>row.text).join('\n\n'),texts.join('\n\n'));
});
