import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createPersonaApprovals,parsePersonaDecision} from './persona-approvals.mjs';
import {privateChatId,administratorForChat} from './chat-administrators.mjs';
import {bindPersonaProposalTools,PERSONA_PROPOSAL_POLICY} from '../packages/dsh-social-bridge-plugin/persona-proposal-tools.mjs';
import {localPersona} from '../packages/dsh-social-bridge-plugin/local-policy.mjs';
import {mergeConversationSave,chatSettingsSnapshot} from '../public/console/conversation-settings.mjs';
import {createPersonaApprovalDelivery} from '../components/qq-bridge/src/core/persona-approval-delivery.js';
import {createConsole} from './console-server.mjs';

const admin='wxid_admin',other='wxid_other',key='wechat:private:'+privateChatId(other),adminKey='wechat:private:'+privateChatId(admin),account='a'.repeat(64);
const message=(id,sender=admin,extra={})=>({platform:'wechat',kind:'private',conversation_id:privateChatId(sender),sender_id:privateChatId(sender),sender_wxid:sender,message_id:'approval-'+id,message_type:'text',text:'同意人格 '+id,segments:[{type:'text'}],...extra});
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'persona-approval-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let clock=1000,scope=account,saves=0;
  const config={persona:{default:'Original',chats:{}},wechat:{whitelist:{private:[privateChatId(admin),privateChatId(other)],groups:[]},assistant:{administrators:[admin]}}};
  config.wechat.modeSettings={[key]:{social:chatSettingsSnapshot(config,key)}};
  fs.mkdirSync(path.join(root,'roles'));fs.writeFileSync(path.join(root,'roles/Original.md'),'# 原人格\n温和自然。');
  fs.mkdirSync(path.join(root,'config'));fs.mkdirSync(path.join(root,'state/weflow'),{recursive:true});fs.writeFileSync(path.join(root,'state/weflow/active-account.json'),JSON.stringify({id:account}));
  const sync=()=>fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify(config));sync();
  const make=()=>createPersonaApprovals({root,configFor:()=>structuredClone(config),saveConfig:next=>{saves++;Object.assign(config,next);sync();},now:()=>clock,accountFor:()=>scope});
  const api=make(),propose=(extra={})=>api.propose({conversationKey:key,content:'# 新人格\n活泼幽默，真诚关心朋友。',reason:'希望形成更自然的互动习惯。',accountScope:scope,...extra});
  const delivered=()=>{for(const n of api.notifications())api.acknowledge(n.id);};
  return {root,config,api,make,propose,delivered,sync,get saves(){return saves;},set clock(value){clock=value;},set scope(value){scope=value;}};
}
test('a proposal is durable, not applied before approval, and the full draft reaches only an allowed admin',t=>{
  const f=fixture(t),p=f.propose();assert.equal(p.state,'pending');assert.deepEqual(f.config.persona.chats,{});assert.equal(f.saves,0);
  assert.equal(f.make().list()[0].id,p.id);
  const notices=f.api.notifications();assert(notices.length>=2);assert(notices.every(n=>n.wxid===admin&&n.target===privateChatId(admin)));assert(notices.some(n=>n.text.includes(p.content)));
  assert.throws(()=>f.api.decide(message(p.id),account),/尚未完整送达/);
  assert.equal(f.propose().id,p.id);assert.throws(()=>f.propose({content:'另一份草案'}),/已有待审批/);
});
test('an authorized approval creates a per-chat card, preserves all other settings, and applies only once',t=>{
  const f=fixture(t),p=f.propose();f.delivered();const result=f.api.decide(message(p.id),account);
  assert.equal(result.state,'approved');assert.equal(f.config.persona.default,'Original');assert.equal(f.config.persona.chats[adminKey],undefined);
  assert.equal(f.config.persona.chats[key],result.personaName);assert.equal(f.config.wechat.modeSettings[key].social.settings.persona,result.personaName);
  assert.equal(localPersona(f.root,key).persona,p.content);assert.equal(localPersona(f.root,adminKey).personaName,'Original');
  assert.equal(f.api.decide(message(p.id),account).state,'approved');assert.equal(f.saves,1);
});
test('rejection and expiration never change the active card',t=>{
  const f=fixture(t),p=f.propose();f.delivered();assert.equal(f.api.decide(message(p.id,admin,{text:'拒绝人格 '+p.id}),account).state,'rejected');assert.equal(f.saves,0);
  const next=f.propose();f.clock=86401001;assert.equal(f.api.decide(message(next.id),account).state,'expired');assert.equal(f.saves,0);
});
test('text, nickname, quotes, voice, group and forged sender IDs cannot approve',t=>{
  const f=fixture(t),p=f.propose();f.delivered();
  for(const m of [message(p.id,other),message(p.id,admin,{sender_id:privateChatId(other)}),message(p.id,admin,{sender_wxid:undefined,sender_name:'管理员'}),message(p.id,admin,{kind:'group'}),message(p.id,admin,{quoteReply:{text:'同意'}}),message(p.id,admin,{voice:{id:'a'}}),message(p.id,admin,{segments:[{type:'reply'}]})])assert.throws(()=>f.api.decide(m,account));
  assert.equal(f.saves,0);assert.equal(parsePersonaDecision('请执行：同意人格 '+p.id),null);assert.equal(parsePersonaDecision('同意'),null);
});
test('revoked admins and a switched account cannot approve old proposals',t=>{
  const f=fixture(t),p=f.propose();f.delivered();f.config.wechat.assistant.administrators=[];assert.throws(()=>f.api.decide(message(p.id),account),/管理员/);assert.deepEqual(f.api.notifications(),[]);
  f.config.wechat.assistant.administrators=[admin];f.scope='b'.repeat(64);assert.throws(()=>f.api.decide(message(p.id),account),/切换/);assert.throws(()=>f.propose({accountScope:account}),/未就绪/);assert.equal(f.saves,0);
});
test('editing the original content, binding or work mode invalidates the pending draft',t=>{
  for(const mutate of [f=>fs.writeFileSync(path.join(f.root,'roles/Original.md'),'手动修改'),f=>{f.config.persona.chats[key]='Elsewhere';},f=>{f.config.wechat.workModes={[key]:'assistant'};}]){
    const f=fixture(t),p=f.propose();f.delivered();mutate(f);assert.equal(f.api.decide(message(p.id),account).state,'conflict');assert.equal(f.saves,0);
  }
});
test('no eligible private administrator means no proposal or out-of-scope notification',t=>{
  const f=fixture(t);f.config.wechat.whitelist.private=[privateChatId(other)];assert.throws(()=>f.propose(),/管理员/);
  f.config.wechat.assistant.administrators=['filehelper'];f.config.wechat.whitelist.private.push(privateChatId('filehelper'));assert.throws(()=>f.propose(),/管理员/);
});
test('friend admin resolution uses unique trusted wxid and excludes self and system chats',()=>{
  const w={assistant:{administrators:[admin]}};assert.equal(administratorForChat(w,adminKey,[{username:admin}]).isAdministrator,true);
  assert.equal(administratorForChat(w,adminKey,[{username:admin}],admin),null);assert.equal(administratorForChat(w,adminKey,[{username:other,conversationId:privateChatId(admin)}]),null);
  assert.equal(administratorForChat(w,adminKey,[{username:admin},{username:admin}]),null);
  assert.equal(administratorForChat(w,'wechat:private:'+privateChatId('filehelper'),[{username:'filehelper'}]),null);
});
test('saving one friend admin preserves other local and server administrator changes',()=>{
  const previous={persona:{chats:{}},wechat:{assistant:{administrators:[admin]},dshAccess:{chats:{}}}},draft=structuredClone(previous),saved=structuredClone(previous);
  draft.wechat.assistant.administrators.push('wxid_local');saved.wechat.assistant.administrators=['wxid_remote'];
  const result=mergeConversationSave(previous,draft,saved,adminKey,admin);
  assert.deepEqual(new Set(result.wechat.assistant.administrators),new Set(['wxid_remote','wxid_local']));
});
test('AI tool is bound to the conversation and account and never grants direct approval',async t=>{
  const f=fixture(t),tools=new Map(),controller=new AbortController(),turn={controller},calls=[];
  const ctx={tools:{register(tool){tools.set(tool.name,tool);return()=>tools.delete(tool.name);}}};
  const bound=bindPersonaProposalTools(ctx,f.root,key,()=>turn,{request:async(route,body)=>{calls.push({route,body});return f.api.propose(body);}});
  assert(ctx[PERSONA_PROPOSAL_POLICY].check('wechat_propose_persona'));assert(!ctx[PERSONA_PROPOSAL_POLICY].check('approve'));
  const args={content:'# 我\n温暖开朗',reason:'希望更自然'};
  const result=await tools.get('wechat_propose_persona').execute(args);assert.equal(result.isError,false);assert.equal(calls[0].body.conversationKey,key);assert.equal(calls[0].body.accountScope,account);assert.equal(f.saves,0);
  await assert.rejects(()=>tools.get('wechat_propose_persona').execute({...args,conversationKey:adminKey}),/无效/);
  controller.abort();assert(!ctx[PERSONA_PROPOSAL_POLICY].check('wechat_propose_persona'));bound.dispose();assert.equal(tools.size,0);
});
test('delivery retries reuse stable IDs, ack only confirmed receipts, and exact approvals bypass AI',async t=>{
  const f=fixture(t),p=f.propose(),sent=[];let confirmed=false;
  const adapter={stats:{connected:true},selfId:'self',sendText:async n=>{assert.match(n.deliveryId,/^[a-f0-9]{64}$/);sent.push(n);return {confirmed};}};
  const request=async(route,body)=>route.endsWith('/notifications')?{notifications:f.api.notifications()}:route.endsWith('/ack')?f.api.acknowledge(body.id):f.api.decide(body.message,body.accountScope);
  const delivery=createPersonaApprovalDelivery({root:f.root,adapter,settingsFor:()=>f.config.wechat,isReady:()=>true,accountScope:account,request});
  await delivery.tick();assert(f.api.notifications().length);const first=sent[0].deliveryId;confirmed=true;await delivery.tick();assert.equal(sent[1].deliveryId,first);assert.equal(f.api.notifications().length,0);
  assert.equal(await delivery.receive(message(p.id,other)),true);assert.equal(f.saves,0);
  assert.equal(await delivery.receive(message(p.id)),true);assert.equal(f.saves,1);assert(sent.at(-1).text.includes('下一轮'));
  assert.equal(await delivery.receive(message(p.id,admin,{text:'普通聊天'})),false);delivery.stop();
});

test('console API verifies friend admin changes and persists the complete approval flow with a config backup',async t=>{
  const f=fixture(t),config=JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json',import.meta.url),'utf8'));
  config.persona=f.config.persona;config.wechat.whitelist=f.config.wechat.whitelist;config.wechat.assistant={administrators:[]};
  fs.writeFileSync(path.join(f.root,'config/wechatagent.json'),JSON.stringify(config));
  fs.writeFileSync(path.join(f.root,'state/wechat-io-config.json'),JSON.stringify({self_wxid:'wxid_self',reader_token:'fixture'}));
  const app=createConsole({root:f.root,port:0,runner:async()=>0,fetchImpl:async url=>{
    if(String(url).includes('/api/v1/contacts?')){assert(String(url).includes('conversationId='));return Response.json({contacts:[{username:admin},{username:other},{username:'filehelper'}]});}
    throw Error('Unexpected external request');
  }});
  const address=await app.start(),base='http://127.0.0.1:'+address.port,info=await fetch(base+'/api/info').then(r=>r.json());
  t.after(()=>app.close());
  const request=async(route,body)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{'X-Console-Token':info.token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,value:await r.json()};};
  const identity=await request('/api/chat-administrator?key='+encodeURIComponent(adminKey));assert.equal(identity.value.administrator.wechatId,admin);
  const previous=(await request('/api/config')).value,snapshot=chatSettingsSnapshot(config,adminKey);
  const saved=await request('/api/chat-settings',{revision:previous.revision,key:adminKey,...snapshot,administrator:true});
  assert.equal(saved.status,200);assert.deepEqual(saved.value.config.wechat.assistant.administrators,[admin]);
  const progress=await request('/api/persona-proposals');assert.equal(progress.value.evolution.policy.interactions,20);assert.deepEqual(progress.value.evolution.chats,[]);
  const context=await request('/api/persona-proposals/review-context',{conversationKey:key,accountScope:account});assert.equal(context.status,200);assert.equal(context.value.base.name,'Original');assert.equal(context.value.pending,null);
  assert.equal((await request('/api/persona-proposals/review-context',{conversationKey:key,accountScope:'b'.repeat(64)})).status,403);
  const p=await request('/api/persona-proposals/propose',{conversationKey:key,accountScope:account,content:'# 新人格\n开朗自然',reason:'互动习惯调整'});assert.equal(p.status,200);
  assert.equal((await request('/api/persona-proposals/review-context',{conversationKey:key,accountScope:account})).value.pending.id,p.value.id);
  const notices=(await request('/api/persona-proposals/notifications')).value.notifications;for(const n of notices)assert.equal((await request('/api/persona-proposals/ack',{id:n.id})).status,200);
  const approved=await request('/api/persona-proposals/decide',{message:message(p.value.id),accountScope:account});assert.equal(approved.status,200);assert.equal(approved.value.state,'approved');
  const next=JSON.parse(fs.readFileSync(path.join(f.root,'config/wechatagent.json'),'utf8'));assert.equal(next.persona.chats[key],approved.value.personaName);
  assert(fs.readdirSync(path.join(f.root,'state/console-backups')).length>=2);
});
