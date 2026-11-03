import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {STICKER_CANDIDATE_LIMIT,STICKER_CANDIDATE_MAX,stickerPolicy,stickerPolicyKey,validateStickerSettings,selectStickerChoices} from '../components/qq-bridge/src/core/sticker-policy.js';
import {parseSocialDecision,resolveSocialDecision} from '../components/qq-bridge/src/core/decision-format.js';
import {SocialEngine} from '../components/qq-bridge/src/core/social-engine.js';
import {MessageBuffer} from '../components/qq-bridge/src/core/message-buffer.js';
import {WechatOneBotAdapter} from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';
const catalog=()=>Array.from({length:20},(_,i)=>({id:(i+1).toString(16).padStart(64,'0'),description:'候选表情 '+(i+1),tags:['表情']}));
const key='wechat:private:123',message={platform:'wechat',kind:'private',conversation_id:'123',sender_id:'123',sender_wxid:'wxid_fixture',self_id:'99',message_id:'fixture',text:'来个表情',timestamp:Date.now()/1000};
async function until(check,details=()=>({})){for(let i=0;i<500;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,4));}assert.fail('sticker candidate fixture timed out: '+JSON.stringify(details()));}

test('candidate selection offers eight distinct labelled resources and retains relevance ordering',()=>{
 const items=catalog();items[15].tags.push('特别匹配');const selected=selectStickerChoices([...items,items[0]],'特别匹配',new Set());assert.equal(STICKER_CANDIDATE_LIMIT,8);assert.equal(selected.length,8);assert.equal(new Set(selected.map(item=>item.id)).size,8);assert.equal(selected[0].id,items[15].id);
 assert.equal(selectStickerChoices(items.slice(0,4),'表情',new Set()).length,4);
});

test('candidate count accepts integers one through twenty, defaults to eight, and is not an in-flight permission change',()=>{
 const items=catalog();assert.equal(STICKER_CANDIDATE_MAX,20);assert.equal(stickerPolicy({},key).candidateLimit,8);
 for(const limit of [1,3,8,12,20]){const w={stickers:{candidateLimit:limit}};validateStickerSettings(w.stickers);const policy=stickerPolicy(w,key);assert.equal(policy.candidateLimit,limit);assert.equal(selectStickerChoices(items,'表情',new Set(),policy).length,limit);}
 for(const candidateLimit of [0,21,-1,1.5,'8',null,true])assert.throws(()=>validateStickerSettings({candidateLimit}));
 assert.equal(stickerPolicyKey(stickerPolicy({stickers:{candidateLimit:1}},key)),stickerPolicyKey(stickerPolicy({stickers:{candidateLimit:20}},key)));
});

test('references above three work only when supplied in this turn, including captions and lowercase shorthand',()=>{
 const items=catalog(),refs=Object.fromEntries(items.slice(0,8).map((item,i)=>['S'+(i+1),item.id]));
 for(const ref of ['S4','S5','S6','S7','S8']){assert.equal(parseSocialDecision('RESPOND: [STICKER:'+ref+']',refs).stickerId,refs[ref]);assert.equal(parseSocialDecision('['+ref.toLowerCase()+']',refs).stickerId,refs[ref]);assert.deepEqual(parseSocialDecision('RESPOND: 收到\n[STICKER:'+ref+']',refs,{allowStickerCaption:true}),{decision:'RESPOND',text:'收到',stickerId:refs[ref]});}
 for(const value of ['S0','S01','S9','S99','S8junk'])assert.equal(parseSocialDecision('RESPOND: [STICKER:'+value+']',refs).decision,'INVALID');
 assert.equal(parseSocialDecision('RESPOND: [S8]',Object.create({S8:items[7].id})).decision,'INVALID');assert.equal(parseSocialDecision('RESPOND: 收到\n[STICKER:S8]',Object.create({S8:items[7].id}),{allowStickerCaption:true}).decision,'INVALID');
 assert.equal(parseSocialDecision('RESPOND: [S12]',{S12:items[11].id}).stickerId,items[11].id);
});

test('format repair lists every offered reference and never guesses an unavailable ninth option',async()=>{
 const refs=Object.fromEntries(catalog().slice(0,8).map((item,i)=>['S'+(i+1),item.id]));let calls=0;
 const result=await resolveSocialDecision({key,rawOutput:'RESPOND: [S9]',stickerRefs:refs,metadata:{batchId:'a'.repeat(64)},decide:async(_key,prompt)=>{calls++;assert(prompt.includes('本轮允许 S1、S2、S3、S4、S5、S6、S7、S8'));return 'RESPOND: [STICKER:S8]';}});assert.equal(calls,1);assert.equal(result.result.stickerId,refs.S8);
});

function fixture(t,{caption=false,rejectFirst=false,unlabelled=false,requestText='来个表情',candidateLimit=8,pickLast=false}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sticker-candidates-')),file=path.join(root,'messages.json'),offered=catalog().map(item=>unlabelled?{id:item.id}:item),adapter=new WechatOneBotAdapter(),packets=[],inputs=[],engines=[],logs=[];let calls=0,offers=0,limit=candidateLimit;
 adapter.server.action=async(action,params)=>{packets.push({action,params});return {data:{receipt:'wechat-server-id',media_type:params.message[0].type==='wechat_sticker'?'wechat-sticker':undefined}};};
 const make=(buffer=new MessageBuffer(file))=>{const engine=new SocialEngine({buffer,workModeFor:()=> 'assistant',assistantAccess:()=>true,assistantBatchMs:1,batchMs:1,privateMinIntervalMs:0,minIntervalMs:0,maxPerMinute:100,maxPerTenMinutes:100,stickerPolicyFor:()=>({enabled:true,labelCache:true,candidateLimit:limit}),stickerChoicesFor:async()=>{offers++;return offered;},decide:async(_key,prompt,metadata)=>{calls++;inputs.push({prompt,metadata:structuredClone({...metadata,onTaskUpdate:undefined})});if(rejectFirst&&calls===1)throw Object.assign(Error('fixture transport unavailable'),{admitted:false});const ref=pickLast?[...prompt.matchAll(/^S([1-9]\d*)：/gm)].at(-1)?.[1]:'8';return unlabelled?'RESPOND: 先正常回复':!ref?'RESPOND: 收到长消息':caption?'RESPOND: 好呀\n[STICKER:S'+ref+']':'RESPOND: [STICKER:S'+ref+']';},send:(row,text,opts)=>adapter.sendText({kind:row.kind,target:row.conversation_id,text,deliveryId:opts.deliveryId}),sendSticker:(row,id,opts)=>adapter.sendSticker({kind:row.kind,target:row.conversation_id,id,...opts}),log:line=>logs.push(line)});engines.push(engine);return engine;};
 const engine=make();t.after(()=>{for(const item of engines)item.stop();fs.rmSync(root,{recursive:true,force:true});});return {engine,make,offered,packets,inputs,logs,file,setLimit:value=>limit=value,message:{...message,text:requestText},get calls(){return calls;},get offers(){return offers;}};
}

test('an eighth option reaches native WeChat sticker delivery without extra model calls or candidate image previews',async t=>{
 const f=fixture(t);f.engine.receive(f.message);await until(()=>f.engine.buffer.unread(key).length===0&&f.engine.buffer.mediaReplies.size===0,()=>({calls:f.calls,offers:f.offers,logs:f.logs}));assert.equal(f.calls,1);assert(f.inputs[0].prompt.includes('S8：'));assert(!f.inputs[0].prompt.includes('S9：'));assert.equal(f.inputs[0].metadata.images.length,0);assert.equal(f.packets.length,1);assert.deepEqual(f.packets[0].params.message,[{type:'wechat_sticker',data:{id:catalog()[7].id}}]);
});

test('caption plus eighth sticker still sends only one text and one sticker',async t=>{
 const f=fixture(t,{caption:true});f.engine.receive(f.message);await until(()=>f.engine.buffer.unread(key).length===0&&f.engine.buffer.mediaReplies.size===0);assert.equal(f.calls,1);assert.equal(f.packets.length,2);assert.equal(f.packets[0].params.message[0].data.text,'好呀');assert.equal(f.packets[1].params.message[0].data.id,catalog()[7].id);
});

test('pending candidate IDs are frozen across retries even when the available catalog changes order',async t=>{
 const f=fixture(t,{rejectFirst:true});f.engine.receive(f.message);await until(()=>f.calls===1&&!f.engine.running.has(key));f.engine.stop();f.offered.reverse();const restored=f.make();restored.replay(key);await until(()=>restored.buffer.unread(key).length===0&&restored.buffer.mediaReplies.size===0);assert.equal(f.calls,2);assert.equal(f.offers,1);assert.equal(f.inputs[0].metadata.batchId,f.inputs[1].metadata.batchId);assert.equal(f.packets[0].params.message[0].data.id,catalog()[7].id);
});

test('eight-candidate pending requests survive reload, legacy requests still load, and image annotations retain their separate cap',async t=>{
 const f=fixture(t,{rejectFirst:true});f.engine.receive(f.message);await until(()=>f.calls===1&&!f.engine.running.has(key));f.engine.stop();const buffer=new MessageBuffer(f.file),item=buffer.pendingRequests.get(key);assert.equal(item.stickerChoices.length,8);assert.equal(Object.keys(item.stickerRefs).length,8);const unchanged=fs.readFileSync(f.file);
 for(const mutate of [value=>value.stickerChoices=Array(21).fill(catalog()[0]),value=>value.stickerRefs=Object.fromEntries(Array.from({length:21},(_,i)=>['S'+(i+1),String(i+1).padStart(64,'0')])),value=>value.annotationRefs=Object.fromEntries(catalog().slice(0,5).map((row,i)=>['I'+(i+1),row.id]))]){const invalid=structuredClone(item);mutate(invalid);assert.throws(()=>buffer.rememberRequest(key,invalid),/invalid pending model request/);assert.deepEqual(fs.readFileSync(f.file),unchanged);}
 const legacy=structuredClone(item);legacy.stickerChoices=legacy.stickerChoices.slice(0,3);legacy.stickerRefs=Object.fromEntries(Object.entries(legacy.stickerRefs).slice(0,3));legacy.prompt='legacy three-candidate request';buffer.rememberRequest(key,legacy);assert.equal(new MessageBuffer(f.file).pendingRequests.get(key).stickerChoices.length,3);
});

test('unknown resources keep the two-preview limit and ordinary chat never loads images just to fill eight slots',async t=>{
 const explicit=fixture(t,{unlabelled:true});explicit.engine.receive(explicit.message);await until(()=>explicit.engine.buffer.unread(key).length===0);assert.equal(explicit.inputs[0].metadata.images.length,2);assert(!explicit.inputs[0].prompt.includes('S3：'));
 const ordinary=fixture(t,{unlabelled:true,requestText:'你好'});ordinary.engine.receive(ordinary.message);await until(()=>ordinary.engine.buffer.unread(key).length===0);assert.equal(ordinary.inputs[0].metadata.images.length,0);assert(!ordinary.inputs[0].prompt.includes('S1：'));
});

test('lowering the limit preserves a submitted twenty-candidate table and applies immediately to the next batch',async t=>{
 const f=fixture(t,{candidateLimit:20,pickLast:true,rejectFirst:true});f.engine.receive(f.message);await until(()=>f.calls===1&&!f.engine.running.has(key));assert.equal(new MessageBuffer(f.file).pendingRequests.get(key).stickerChoices.length,20);f.setLimit(1);f.engine.replay(key);await until(()=>f.engine.buffer.unread(key).length===0&&f.engine.buffer.mediaReplies.size===0);assert.equal(f.inputs[0].metadata.batchId,f.inputs[1].metadata.batchId);assert.equal(f.packets[0].params.message[0].data.id,catalog()[19].id);
 f.engine.receive({...f.message,message_id:'next-batch',text:'再换个表情'});await until(()=>f.calls===3&&f.engine.buffer.unread(key).length===0&&f.engine.buffer.mediaReplies.size===0);assert(f.inputs[2].prompt.includes('S1：'));assert(!f.inputs[2].prompt.includes('S2：'));assert.equal(f.packets[1].params.message[0].data.id,catalog()[0].id);
});

test('large candidate settings yield space to a long text batch instead of rejecting or blocking it',async t=>{
 const f=fixture(t,{candidateLimit:20,pickLast:true});for(let i=0;i<4;i++)f.engine.receive({...f.message,message_id:'long-'+i,text:'长'.repeat(4000)});await until(()=>f.engine.buffer.unread(key).length===0);assert.equal(f.calls,1);assert(f.inputs[0].prompt.length<=18000);assert(!f.inputs[0].prompt.includes('S1：'));assert.equal(f.packets[0].params.message[0].data.text,'收到长消息');assert(!f.logs.some(line=>line.includes('invalid pending model request')));
});
