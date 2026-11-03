import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {MessageBuffer,replyDeliveryParts} from '../components/qq-bridge/src/core/message-buffer.js';
import {SocialEngine} from '../components/qq-bridge/src/core/social-engine.js';
import {DshConnectionGuard} from '../components/qq-bridge/src/core/dsh-connection.js';
import {DshPluginClient} from '../components/qq-bridge/src/dsh/plugin-client.js';
import {AssistantTasks} from '../packages/dsh-social-bridge-plugin/assistant-tasks.mjs';

const key='wechat:private:123',sticker='a'.repeat(64);
const incoming=(id,time,kind='private')=>({platform:'wechat',kind,conversation_id:'123',sender_id:'fixture',sender_wxid:'fixture-admin',sender_name:'Fixture',self_id:'self',message_id:id,text:id,timestamp:time/1000});
const until=async predicate=>{for(let i=0;i<600;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Reconnect fixture timed out');};
function fixture(t,options={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-reconnect-')),file=path.join(root,'messages.json'),engines=[],guards=[],sent=[],calls=[],logs=[];
  let now=2000000000000,health={ready:true,instanceId:'instance-a',startedAt:now-10000};
  const make=(buffer=new MessageBuffer(file))=>{
    const guard=new DshConnectionGuard({buffer,now:()=>now,probe:async()=>typeof health==='function'?health():health,log:line=>logs.push(line)});
    const engine=new SocialEngine({buffer,connection:guard,batchMs:1,privateMinIntervalMs:0,minIntervalMs:0,maxPerMinute:100,maxPerTenMinutes:1000,assistantAccess:()=>true,workModeFor:()=>options.assistant?'assistant':'social',
      stickerPolicyFor:()=>({enabled:false,labelCache:false}),
      decide:async(...args)=>{calls.push(args);return options.decide?options.decide(...args):'RESPOND: fixture response';},
      send:async(...args)=>{sent.push(args);return {delivered:'database-confirmed'};},log:line=>logs.push(line)});
    engines.push(engine);guards.push(guard);return {buffer,guard,engine};
  };
  t.after(()=>{for(const e of engines)e.stop();for(const g of guards)g.stop();assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});
  return {...make(),make,root,file,sent,calls,logs,get now(){return now;},advance:ms=>now+=ms,setHealth:value=>health=value};
}
test('legacy pending input is archived on initial readiness and never replayed',async t=>{
 const f=fixture(t);f.buffer.append(incoming('old',f.now-3600000));await f.guard.check();f.engine.replay(key);await new Promise(resolve=>setTimeout(resolve,30));
 assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);assert.equal(f.buffer.unread(key).length,0);assert.equal(f.buffer.recent(key)[0].reply_skip_reason,'dsh_reconnected');
});
test('offline input is retained in history but a reconnect replies only to new input',async t=>{
 const f=fixture(t);await f.guard.check();f.setHealth({ready:false});await f.guard.check({force:true});
 for(let i=0;i<60;i++)f.engine.receive(incoming('offline-'+i,f.now));
 assert.equal(f.buffer.unread(key).length,0);assert.equal(f.buffer.recent(key,300).length,60);
 f.advance(60000);f.setHealth({ready:true,instanceId:'instance-b',startedAt:f.now});await f.guard.check({force:true});
 f.engine.replay(key);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(f.calls.length,0);
 f.engine.receive(incoming('fresh',f.now+1000));await until(()=>f.sent.length===1&&!f.engine.running.size);
 assert.equal(f.calls.length,1);assert.match(f.calls[0][1],/fresh/);assert.doesNotMatch(f.calls[0][1],/offline-0/);assert.equal(f.calls[0][2].dshInstanceId,'instance-b');
});
test('queued offline inputs and their no-replay boundary survive a bridge restart',async t=>{
 const f=fixture(t);await f.guard.check();f.setHealth({ready:false});await f.guard.check({force:true});f.engine.receive(incoming('offline',f.now));f.engine.stop();f.guard.stop();
 f.advance(30000);f.setHealth({ready:true,instanceId:'instance-b',startedAt:f.now});const restored=f.make();await restored.guard.check();restored.engine.replay(key);await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(f.sent.length,0);assert.equal(restored.buffer.unread(key).length,0);assert(restored.buffer.recent(key)[0].processed);
});
test('an instance change is detected even when the offline polling gap was missed',async t=>{
 const f=fixture(t);await f.guard.check();f.buffer.append(incoming('old-queued',f.now));f.advance(5000);f.setHealth({ready:true,instanceId:'instance-b',startedAt:f.now});await f.guard.check({force:true});
 assert.equal(f.buffer.unread(key).length,0);f.engine.receive(incoming('new',f.now+1000));await until(()=>f.sent.length===1);assert.equal(f.calls.length,1);
});
test('a late reader event from before reconnect cannot create a new model turn',async t=>{
 const f=fixture(t);await f.guard.check();f.setHealth({ready:false});await f.guard.check({force:true});f.advance(5000);f.setHealth({ready:true,instanceId:'instance-b',startedAt:f.now});await f.guard.check({force:true});
 f.engine.receive(incoming('late-offline-event',f.now-10000));f.engine.replay(key);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(f.calls.length,0);assert.equal(f.buffer.recent(key)[0].reply_skip_reason,'before_dsh_reconnect');
});
test('a temporary outage of the same instance still advances the late-input boundary',async t=>{
 const f=fixture(t);await f.guard.check();const startedAt=f.now-10000;f.setHealth({ready:false});await f.guard.check({force:true});f.advance(5000);f.setHealth({ready:true,instanceId:'instance-a',startedAt});await f.guard.check({force:true});
 f.engine.receive(incoming('late outage input',f.now-3000));await new Promise(resolve=>setTimeout(resolve,20));assert.equal(f.calls.length,0);assert.equal(f.buffer.unread(key).length,0);
});
test('a restart in the same timestamp second retires a saved old-instance batch',async t=>{
 let finish;const f=fixture(t,{decide:()=>new Promise(resolve=>finish=resolve)});await f.guard.check();f.engine.receive(incoming('same-second',f.now));await until(()=>finish);assert.equal(f.buffer.pendingRequests.size,1);
 f.advance(100);f.setHealth({ready:true,instanceId:'instance-b',startedAt:f.now});await f.guard.check({force:true});assert.equal(f.buffer.unread(key).length,0);assert.equal(f.buffer.pendingRequests.size,0);finish('RESPOND: old');await until(()=>!f.engine.running.size);assert.equal(f.sent.length,0);
});
test('an old model result arriving after a reconnect is discarded before sending',async t=>{
 let finish;const f=fixture(t,{decide:()=>new Promise(resolve=>finish=resolve)});await f.guard.check();f.engine.receive(incoming('original',f.now+1000));await until(()=>finish);
 f.setHealth({ready:false});await f.guard.check({force:true});f.advance(10000);f.setHealth({ready:true,instanceId:'instance-b',startedAt:f.now});await f.guard.check({force:true});finish('RESPOND: stale result');await until(()=>!f.engine.running.size);
 assert.equal(f.sent.length,0);assert.equal(f.buffer.pendingRequests.size,0);
});
test('an unsent old draft cannot be delivered after recovery and cannot block fresh input',async t=>{
 const f=fixture(t);await f.guard.check();const row=f.buffer.append(incoming('draft',f.now));const result={decision:'RESPOND',text:'old draft'},deliveryId='c'.repeat(64);
 const item={result,throughId:row.id,message:{...incoming('draft',f.now),work_mode:'social'},deliveryId,parts:replyDeliveryParts(result,deliveryId),connectionEpoch:f.guard.epoch,sending:true};f.buffer.rememberReply(key,item);f.engine.decisions.set(key,item);
 f.setHealth({ready:false});await f.guard.check({force:true});assert.equal(item.parts[0].state,'cancelled');assert.equal(f.buffer.pendingReplies.size,0);
 f.advance(5000);f.setHealth({ready:true,instanceId:'instance-b',startedAt:f.now});await f.guard.check({force:true});f.engine.receive(incoming('fresh',f.now+1000));await until(()=>f.sent.length===1);assert.notEqual(f.sent[0][1],'old draft');
});
test('queued old media is retired without a native submission on a connection boundary',async t=>{
 const f=fixture(t);await f.guard.check();let submissions=0;f.engine.sendSticker=async()=>{submissions++;};
 const deliveryId='d'.repeat(64),result={decision:'STICKER',stickerId:sticker},item={result,deliveryId,message:incoming('media',f.now)};
 f.engine.media.enqueue(key,item,replyDeliveryParts(result,deliveryId)[0]);f.setHealth({ready:false});await f.guard.check({force:true});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(submissions,0);assert.equal(f.buffer.mediaReplies.size,0);
});
test('submitted old media releases only its receipt reservation during disconnect',async t=>{
 const f=fixture(t);await f.guard.check();let lookups=0,submissions=0;f.engine.sendSticker=async(_message,_id,options)=>{if(options.receiptOnly&&options.abandon)lookups++;else submissions++;return {released:true};};
 const deliveryId='e'.repeat(64),message=incoming('submitted media',f.now);f.buffer.mediaReplies.set(deliveryId,{key,message,part:{stickerId:sticker,deliveryId,state:'submitted'},createdAt:Date.now(),expiresAt:Date.now()+30000});f.buffer.saveMedia();
 f.setHealth({ready:false});await f.guard.check({force:true});await until(()=>lookups===1);assert.equal(submissions,0);assert.equal(f.buffer.mediaReplies.size,0);
});
test('offline drafts are cancelled while uncertain submitted text stays recorded as uncertain',async t=>{
 const f=fixture(t);await f.guard.check();const row=f.buffer.append(incoming('draft',f.now));const result={decision:'RESPOND',text:'old draft'},deliveryId='b'.repeat(64);
 const item={result,throughId:row.id,message:{...incoming('draft',f.now),work_mode:'social'},deliveryId,parts:replyDeliveryParts(result,deliveryId),connectionEpoch:f.guard.epoch,sending:true};item.parts[0].state='sending';f.buffer.rememberReply(key,item);f.engine.decisions.set(key,item);
 f.setHealth({ready:false});await f.guard.check({force:true});
 assert.equal(f.buffer.pendingReplies.size,0);assert.equal(f.buffer.recent(key).find(row=>row.outgoing).delivery_status,'unconfirmed');assert.equal(f.sent.length,0);
});
test('fresh input after a recovered instance is not dropped by a second request in flight',async t=>{
 let finish;const f=fixture(t,{decide:(_key,prompt)=>prompt.includes('original')?new Promise(resolve=>finish=resolve):'RESPOND: fresh result'});await f.guard.check();f.engine.receive(incoming('original',f.now+1000));await until(()=>finish);
 f.setHealth({ready:false});await f.guard.check({force:true});f.advance(5000);f.setHealth({ready:true,instanceId:'instance-b',startedAt:f.now});await f.guard.check({force:true});f.engine.receive(incoming('fresh',f.now+1000));finish('RESPOND: stale');await until(()=>f.sent.length===1&&!f.engine.running.size);assert.equal(f.sent[0][1],'fresh result');
});
test('ordinary model errors do not mark a healthy plugin offline or erase queued input',async t=>{
 const f=fixture(t,{decide:async()=>{throw Error('fixture model error');}});await f.guard.check();f.engine.receive(incoming('retryable',f.now+1000));await until(()=>f.calls.length===1&&!f.engine.running.size);assert.equal(f.guard.ready,true);assert.equal(f.buffer.unread(key).length,1);
});
test('an assistant message received offline is archived for review and never automatically submitted',async t=>{
 const f=fixture(t,{assistant:true});f.setHealth({ready:false});await f.guard.check();f.engine.receive(incoming('new task',f.now));f.advance(5000);f.setHealth({ready:true,instanceId:'instance-b',startedAt:f.now});await f.guard.check({force:true});f.engine.replay(key);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(f.calls.length,0);assert(f.buffer.recent(key)[0].reply_review_required);
});
test('corrupt persisted connection boundaries fail without overwriting the saved queue',t=>{
 const f=fixture(t);fs.writeFileSync(f.file,JSON.stringify({version:1,chats:{},dshConnection:{version:1,ready:true,epoch:-1}}));const original=fs.readFileSync(f.file);assert.throws(()=>new MessageBuffer(f.file),/invalid DSH connection/);assert.deepEqual(fs.readFileSync(f.file),original);
});
test('pending and active assistant tasks become review-required after a host restart',async t=>{
 const f=fixture(t),file=path.join(f.root,'tasks.json');let executions=0;
 const jobs=new AssistantTasks({file,concurrency:1,allowed:()=>true,execute:async()=>{executions++;return new Promise(()=>{});}});t.after(()=>jobs.close());
 const request=batch=>({conversationKey:key,assistantSender:'fixture-admin',batchId:batch.repeat(64)});
 const a=jobs.submit(request('a')),b=jobs.submit(request('b'));await until(()=>jobs.get(a.id).state==='running');
 const restored=new AssistantTasks({file,allowed:()=>true,execute:async()=>{executions++;}});t.after(()=>restored.close());restored.pump();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(executions,1);assert.equal(restored.get(a.id).state,'interrupted');assert.equal(restored.get(b.id).state,'interrupted');
 const continued=restored.submit({...request('c'),assistantParentId:b.id});await until(()=>restored.get(continued.id).state==='completed');assert.equal(executions,2);assert.equal(restored.get(b.id).state,'interrupted');
});
test('health readiness requires the authenticated bridge contract and exposes the instance identity',async t=>{
 let health={ok:true,project:'WeChatAgent',contextMode:'native-session-v1',instanceId:'instance-one',instanceStartedAt:123};
 const server=http.createServer((req,res)=>{assert.equal(req.url,'/health');assert.equal(req.headers.authorization,'Bearer fixture');res.setHeader('Content-Type','application/json');res.end(JSON.stringify(health));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const client=new DshPluginClient({url:'http://127.0.0.1:'+server.address().port,token:'fixture'});assert.deepEqual(await client.connectionHealth(),{ready:true,instanceId:'instance-one',startedAt:123});
 assert.equal((await client.connectionHealth({projectRoot:'fixture-project'})).ready,false);assert.equal((await client.connectionHealth({accountScope:'fixture-account'})).ready,false);
 health={...health,ok:false};assert.equal((await client.connectionHealth()).ready,false);health={...health,ok:true,project:'another'};assert.equal((await client.connectionHealth()).ready,false);
});
