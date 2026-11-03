import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {createMemberMemory,bindMemberMemory,memberObservations} from '../packages/dsh-social-bridge-plugin/member-memory.mjs';
import {memberMemoryEnabled,validateMemberMemory,MEMBER_MEMORY_POLICY} from '../packages/dsh-social-bridge-plugin/member-memory-policy.mjs';
import {HookOneBot} from './hook-onebot.mjs';import{normalizeOneBotEvent}from'../components/qq-bridge/src/onebot/normalize.js';import{MessageBuffer}from'../components/qq-bridge/src/core/message-buffer.js';
import{applyBuiltinUpdate,builtinCatalog}from'./extension-status.mjs';
const group='wechat:group:123',otherGroup='wechat:group:456',member='a'.repeat(64),other='b'.repeat(64),account='c'.repeat(64);
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-member-memory-'));t.after(()=>{assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});fs.mkdirSync(path.join(root,'config'));let clock=Date.now(),active=true;
const config={wechat:{whitelist:{groups:['123','456'],private:['789']},memberMemory:{enabled:true}}};const save=()=>fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify(config));save();
const make=scope=>createMemberMemory({root,accountScope:scope,isAllowed:()=>active,now:()=>clock});const memory=make(account);
const row=(n,id=member,name='同名群友')=>({memberId:id,senderId:id===member?'111':'222',name,evidenceId:n.toString(16).padStart(32,'0'),text:'这里是本人的实际发言 '+n,at:clock-100});
const turn=(rows,key=group)=>memory.openTurn(key,rows,new AbortController());return {root,config,save,memory,make,row,turn,file:path.join(root,'state/member-memory',account,'123.json'),advance:ms=>clock+=ms,revoke:()=>active=false};}
test('stable full member identifiers survive renaming and are preserved through OneBot and buffering',t=>{
 const f=fixture(t),host={reload(){},allowed:()=>true,ownWxid:'wxid_self',project:{account:{nicknames:[]}}};
 const payload={event:'message.new',type:1,sessionId:'group@chatroom',talkerId:'wxid_user_a',content:'你好',rawid:'first',sourceName:'原昵称'};
 const first=HookOneBot.prototype.incoming.call(host,payload),renamed=HookOneBot.prototype.incoming.call(host,{...payload,rawid:'second',sourceName:'新昵称'}),different=HookOneBot.prototype.incoming.call(host,{...payload,talkerId:'wxid_user_b'});
 assert.equal(first.wechatagent.memberId,renamed.wechatagent.memberId);assert.notEqual(first.wechatagent.memberId,different.wechatagent.memberId);
 const normalized=normalizeOneBotEvent('wechat','wechat-onebot',first),buffer=new MessageBuffer(path.join(f.root,'messages.json'));buffer.append(normalized);
 assert.equal(buffer.recent('wechat:group:'+first.group_id)[0].sender_key,first.wechatagent.memberId);
});
test('JSON records distinguish same nicknames, retain aliases, and never copy raw messages',t=>{
 const f=fixture(t);f.turn([f.row(1),f.row(2,other)]);f.turn([f.row(3,member,'改名后')]);
 const saved=JSON.parse(fs.readFileSync(f.file,'utf8'));assert.equal(Object.keys(saved.members).length,2);assert.deepEqual(saved.members[member].names,['改名后','同名群友']);
 assert(!fs.readFileSync(f.file,'utf8').includes('实际发言'));assert.equal(saved.accountScope,account);
});
test('tags require three distinct authored evidence references and duplicate reads do not reinforce them',t=>{
 const f=fixture(t);let turn=f.turn([f.row(1)]);const update={memberId:member,tags:[{label:'语气温和',evidenceIds:[f.row(1).evidenceId]}]};
 f.memory.update(turn,update);f.memory.update(turn,update);assert.equal(f.memory.lookup(turn,{memberId:member})[0].tags[0].status,'tentative');
 turn=f.turn([f.row(2),f.row(3)]);f.memory.update(turn,{memberId:member,tags:[{label:'语气温和',evidenceIds:[f.row(2).evidenceId,f.row(3).evidenceId]}]});
 const tag=f.memory.lookup(turn,{memberId:member})[0].tags[0];assert.equal(tag.evidenceCount,3);assert.equal(tag.status,'observed');
});
test('forged, quoted and other members evidence cannot assign arbitrary or sensitive labels',t=>{
 const f=fixture(t),turn=f.turn([f.row(1),f.row(2,other)]),before=fs.readFileSync(f.file,'utf8');
 for(const tags of [[{label:'语气温和',evidenceIds:[f.row(2).evidenceId]}],[{label:'政治倾向',evidenceIds:[f.row(1).evidenceId]}],[{label:'语气温和',evidenceIds:['f'.repeat(32)]}]])assert.throws(()=>f.memory.update(turn,{memberId:member,tags}),/EVIDENCE_INVALID/);
 assert.equal(fs.readFileSync(f.file,'utf8'),before);
 const rows=memberObservations(group,[{sender_key:member,sender_id:'111',message_id:'quote',text:'转发他人的话',forwardedRecord:{},timestamp:Date.now()/1000}]);assert.equal(rows.length,0);
});
test('accounts, groups, private chats and live feature revocation remain isolated',t=>{
 const f=fixture(t),turn=f.turn([f.row(1)]);f.memory.update(turn,{memberId:member,tags:[{label:'爱玩梗',evidenceIds:[f.row(1).evidenceId]}]});
 assert.deepEqual(f.memory.lookup(f.turn([],otherGroup),{memberId:member}),[]);
 const second=f.make('d'.repeat(64)),secondTurn=second.openTurn(group,[],new AbortController());assert.deepEqual(second.lookup(secondTurn,{memberId:member}),[]);
 assert.equal(f.turn([f.row(2)],'wechat:private:789').available,false);
 f.config.wechat.memberMemory.enabled=false;f.save();assert.throws(()=>f.memory.lookup(turn),/NOT_ALLOWED/);
 f.config.wechat.memberMemory.enabled=true;f.save();f.revoke();assert.throws(()=>f.memory.lookup(turn),/NOT_ALLOWED/);
});
test('stale traits expire and malformed JSON is preserved rather than overwritten',t=>{
 const f=fixture(t),turn=f.turn([f.row(1)]);f.memory.update(turn,{memberId:member,tags:[{label:'喜欢提问',evidenceIds:[f.row(1).evidenceId]}]});f.advance(91*86400000);
 assert.deepEqual(f.memory.lookup(turn,{memberId:member})[0].tags,[]);
 fs.writeFileSync(f.file,'{broken');assert.equal(f.turn([f.row(2)]).available,false);assert.equal(fs.readFileSync(f.file,'utf8'),'{broken');
});
test('model tools are current-group scoped, bounded, and disappear after cancellation',async t=>{
 const f=fixture(t),tools=new Map(),ctx={tools:{register(def){tools.set(def.name,def);return()=>tools.delete(def.name);}}};let turn=f.turn([f.row(1)]);
 const dispose=bindMemberMemory(ctx,f.memory,group,()=>turn);assert(ctx[MEMBER_MEMORY_POLICY].names().has('wechat_member_memory_read'));assert(dispose.instructions().includes(f.row(1).evidenceId));
 const updated=await tools.get('wechat_member_memory_update').execute({memberId:member,tags:[{label:'表达简短',evidenceIds:[f.row(1).evidenceId]}]});assert.equal(updated.isError,false);
 const result=JSON.parse((await tools.get('wechat_member_memory_read').execute({memberId:member})).content);assert.equal(result.members[0].tags[0].status,'tentative');
 turn.controller.abort();assert.equal(ctx[MEMBER_MEMORY_POLICY].names().size,0);assert.equal((await tools.get('wechat_member_memory_read').execute({})).isError,true);dispose();assert.equal(tools.size,0);
});
test('extension controls offer only allowed groups and reject private configuration',t=>{
 const f=fixture(t),catalog=builtinCatalog(f.config,'revision',true),card=catalog.extensions.find(item=>item.id==='native-member-memory');assert(card.groupOnly);assert.equal(card.featureState.totalCount,2);
 const changed=applyBuiltinUpdate(f.config,'native-member-memory',{enabled:true,chatSettings:{[group]:false}});assert(!memberMemoryEnabled(changed.wechat,group));assert(memberMemoryEnabled(changed.wechat,otherGroup));
 assert.throws(()=>applyBuiltinUpdate(f.config,'native-member-memory',{enabled:true,chatSettings:{'wechat:private:789':true}}));assert.throws(()=>validateMemberMemory({enabled:'true'}));
});

test('stable member guidance excludes observations and never extends tool access beyond the current turn',t=>{
 const f=fixture(t),tools=new Map(),ctx={tools:{register(def){tools.set(def.name,def);return()=>tools.delete(def.name);}}};let turn=f.turn([f.row(1)]);
 const dispose=bindMemberMemory(ctx,f.memory,group,()=>turn),stable=dispose.instructions({stable:true});
 assert(stable.includes('本轮实际提供'));assert(!stable.includes(f.row(1).evidenceId));assert(!stable.includes('实际发言'));
 turn=f.turn([]);assert.equal(dispose.instructions({stable:true}),stable);assert.equal(dispose.context(),'');
 turn.controller.abort();assert.equal(dispose.instructions({stable:true}),stable);assert.equal(ctx[MEMBER_MEMORY_POLICY].names().size,0);
 f.config.wechat.memberMemory.enabled=false;f.save();assert.equal(dispose.instructions({stable:true}),'');dispose();
});
