import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {HookOneBot} from './hook-onebot.mjs';
import {conversationSnapshot} from '../components/qq-bridge/src/core/proactive-policy.js';

const target=123,account='fixture-account',wxid='wxid_fixture_peer',text='fixture proactive text';
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'text-api-proactive-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const contextId=conversationSnapshot([]),now=Date.now();
  const clock=offset=>{const date=new Date(now+8*3600000+offset*60000);return date.toISOString().slice(11,16);};
  const preceding={state:'confirmed',account,wxid,text,baseline:['50'],startedAt:now-2000,confirmedAt:now-1000,
    proactiveContextId:contextId,response:{receipt:'supplier-api',delivered:'api-acknowledged',message_id:'api-text:'+'a'.repeat(64)}};
  const context={directory,reload(){},project:{wechat:{proactive:{enabled:true,idleMinutes:5,startTime:clock(-2),endTime:clock(2),chats:{'wechat:private:123':true}}}},
    textDeliveries:{key:()=> 'preceding',get:()=>preceding,put(){}}};
  const row={isSend:true,localType:1,localId:51,serverId:'123456789',createTime:Math.floor(now/1000),fullText:text};
  const check=(rows,options={})=>HookOneBot.prototype.assertProactive.call(context,'private',target,rows,{contextId,precedingDeliveryId:'preceding',...options},{account},wxid);
  return {preceding,context,row,check};
}

test('an API-acknowledged proactive part continues using project operation context',t=>{
  const f=fixture(t);assert.doesNotThrow(()=>f.check([f.row]));
  assert.match(f.preceding.response.message_id,/^api-text:/);
});

test('API success never bypasses the changed-conversation guard for incoming messages',t=>{
  const f=fixture(t);
  for(const extra of [{...f.row,isSend:false,localId:52,fullText:'new incoming'}]){
    assert.throws(()=>f.check([f.row,extra]),/PROACTIVE_CONTEXT_CHANGED/);
  }
});


test('an ordinary API reply or a preceding part from another proactive context cannot suppress a recent row',t=>{
  const f=fixture(t);
  for(const contextId of [undefined,'b'.repeat(64)]){
    f.preceding.proactiveContextId=contextId;
    assert.throws(()=>f.check([f.row]),/INVALID_PROACTIVE_CONTEXT/);
  }
});

test('first proactive sends still reject recent messages and disabled policy',t=>{
  const f=fixture(t);
  assert.throws(()=>f.check([f.row],{precedingDeliveryId:undefined}),/PROACTIVE_CONTEXT_CHANGED/);
  assert.doesNotThrow(()=>f.check([],{precedingDeliveryId:undefined}));
  f.context.project.wechat.proactive.enabled=false;
  assert.throws(()=>f.check([],{precedingDeliveryId:undefined}),/PROACTIVE_NOT_ALLOWED/);
});
