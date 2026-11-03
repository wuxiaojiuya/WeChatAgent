import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {assistantGroupChatAllowed,assistantSenderAllowed,verifiedAssistantSender} from '../packages/dsh-social-bridge-plugin/assistant-policy.mjs';
import {MessageBuffer} from '../components/qq-bridge/src/core/message-buffer.js';
import {SocialEngine,assistantChatRequest} from '../components/qq-bridge/src/core/social-engine.js';
import {DshPluginClient} from '../components/qq-bridge/src/dsh/plugin-client.js';
import {HistoryStore} from '../packages/dsh-social-bridge-plugin/history-store.mjs';
import {scopeHistory} from '../packages/dsh-social-bridge-plugin/work-modes.mjs';
const key='wechat:group:456',admin='wxid_admin',member='wxid_member';
const id=value=>String(Number(crypto.createHash('sha256').update(value).digest().readBigUInt64BE(0)%2147483647n+1n));
const settings=()=>({whitelist:{private:['123'],groups:['456']},assistant:{administrators:[admin],adminOnlyGroups:{[key]:false}}});
test('an admin may explicitly choose read-only group chat without changing natural task commands',()=>{
 for(const text of ['聊天：你好','聊天: 你好','助手，聊天：你好','@机器人 聊天：你好'])assert(assistantChatRequest({text},['助手']));
 assert(assistantChatRequest({text:'@蓝色 大肥鱼 聊天：你好',segments:[{type:'at',data:{id:'self'}},{type:'text',data:{text:'聊天：你好'}}]},['助手']));
 for(const text of ['帮我整理文件','新任务 处理数据','继续任务 T0123456789abcdef','聊天：','引用中写着聊天：内容'])assert(!assistantChatRequest({text},['助手']));
});
const msg=(text='助手 你好')=>({platform:'wechat',kind:'group',conversation_id:'456',sender_id:id(member),sender_wxid:member,sender_name:'管理员',message_id:crypto.randomUUID(),text,timestamp:Date.now()/1000});
const until=async fn=>{for(let i=0;i<600;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('member chat fixture timed out');};
const cleanups=new WeakMap();
function root(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-members-'));cleanups.set(t,[]);t.after(()=>{for(const close of cleanups.get(t))close();assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});});return dir;}
test('member archive append and restart backfill never enter administrator task history',t=>{
 const dir=root(t),store=new HistoryStore(dir,'a'.repeat(64));cleanups.get(t).push(()=>store.close());
 const task=scopeHistory(store,()=> 'assistant'),chat=scopeHistory(store,()=> 'assistant-chat',{fixedMode:'assistant-chat'});
 const row={...msg('member-only record'),id:'first',work_mode:'assistant',outgoing:false};chat.append(key,row);chat.backfill(key,[row]);
 assert.equal(chat.rows(key).length,1);assert.equal(task.rows(key).length,0);assert.equal(store.rows(key).length,0);
});
test('an immutable old member message cannot become work after promotion, even after buffer trimming',t=>{
 const dir=root(t),store=new HistoryStore(dir,'b'.repeat(64));cleanups.get(t).push(()=>store.close());const chat=scopeHistory(store,()=> 'assistant-chat',{fixedMode:'assistant-chat'});
 const original=msg('old request');chat.append(key,{...original,id:'original',outgoing:false});
 assert(chat.hasIncoming(key,{...original,text:'changed display after role update'}));assert(!chat.hasIncoming(key,{...original,message_id:'a-new-real-message'}));
 const w=settings();w.assistant.administrators.push(member);assert(assistantSenderAllowed(w,key,member));assert(chat.hasIncoming(key,original));
});
test('a member can chat without an admin list but cannot execute or access private assistant chats',()=>{
 const w=settings();w.assistant.administrators=[];assert(assistantGroupChatAllowed(w,key,member));assert(assistantGroupChatAllowed(w,key,''));assert(!assistantSenderAllowed(w,key,member));assert(!assistantGroupChatAllowed(w,'wechat:private:123',admin));assert(!assistantGroupChatAllowed(w,'wechat:group:999',member));
});
test('member chat cannot invoke task controls or hand files or searches to the model task gateway',async t=>{
 const dir=root(t),w=settings(),calls=[],sent=[];let controls=0,searches=0;
 const master=new SocialEngine({buffer:new MessageBuffer(path.join(dir,'tasks.json')),workModeFor:()=> 'assistant',assistantAccess:(key,m)=>assistantSenderAllowed(w,key,verifiedAssistantSender(m)),assistantControl:async()=>{controls++;return {};},wakeWords:['助手'],batchMs:1,minIntervalMs:0,maxPerMinute:100,maxPerTenMinutes:1000,stickerPolicyFor:()=>({enabled:false}),searchFor:async()=>{searches++;},decide:async(key,prompt,meta)=>{calls.push({key,prompt,meta});return 'RESPOND: 这是普通聊天';},send:async(_target,text)=>{sent.push(text);return {confirmed:true};}});t.after(()=>master.stop());
 const chat=master.createGroupChat({buffer:new MessageBuffer(path.join(dir,'members.json')),assistantAccess:(key,m)=>assistantGroupChatAllowed(w,key,verifiedAssistantSender(m))});t.after(()=>chat.stop());
 chat.receive({...msg('助手 继续任务 T0123456789abcdef'),files:[{id:'a'.repeat(64),name:'fixture.pdf',size:1}]});await until(()=>sent.length===1);
 assert.equal(controls,0);assert.equal(searches,0);assert.equal(calls[0].meta.assistantChatOnly,true);assert.equal(calls[0].meta.assistantParentId,undefined);assert.deepEqual(calls[0].meta.files,[]);assert(calls[0].meta.searchOptOut);assert(!calls[0].prompt.includes('新的微信助手任务'));
});
test('read-only group chat uses a dedicated RPC and never falls back to task submission on old plugins',async t=>{
 const paths=[],server=http.createServer(async(req,res)=>{paths.push(req.url);for await(const _ of req){}res.writeHead(404,{'content-type':'application/json',connection:'close'});res.end('{"error":"not_found"}');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const client=new DshPluginClient({url:'http://127.0.0.1:'+server.address().port,token:'fixture'});await assert.rejects(client.followup(key,'plain chat',{workMode:'assistant',assistantChatOnly:true,assistantSender:member}));assert.deepEqual(paths,['/assistant-chat']);
});
test('ordinary group members can share one bounded chat batch without merging administrator work',async t=>{
 const dir=root(t),w=settings(),calls=[],sent=[];
 const master=new SocialEngine({buffer:new MessageBuffer(path.join(dir,'tasks.json')),workModeFor:()=> 'assistant',assistantAccess:()=>false,assistantBatchMs:5,wakeWords:['助手'],batchMs:1,minIntervalMs:0,stickerPolicyFor:()=>({enabled:false}),decide:async(key,prompt,meta)=>{calls.push({prompt,meta});return 'RESPOND: 群聊回复';},send:async()=>{sent.push(true);return {confirmed:true};}});cleanups.get(t).push(()=>master.stop());
 const chat=master.createGroupChat({buffer:new MessageBuffer(path.join(dir,'members.json')),assistantAccess:(key,m)=>assistantGroupChatAllowed(w,key,verifiedAssistantSender(m))});cleanups.get(t).push(()=>chat.stop());
 chat.receive(msg('助手 第一位的聊天'));chat.receive({...msg('助手 第二位的聊天'),sender_id:id('wxid_second'),sender_wxid:'wxid_second'});await until(()=>sent.length===1&&!chat.running.size);
 assert.equal(calls.length,1);assert(calls[0].prompt.includes('第一位'));assert(calls[0].prompt.includes('第二位'));assert(calls[0].meta.assistantChatOnly);
});
