import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {WECHAT_MESSAGE_LAYOUT_NOTICE,assistantInstructions,assistantChatInstructions} from '../packages/dsh-social-bridge-plugin/work-modes.mjs';
import {stableChatInstructions,CHAT_MESSAGE_LAYOUT_NOTICE} from '../packages/dsh-social-bridge-plugin/prompt-context.mjs';
import {MessageBuffer} from '../components/qq-bridge/src/core/message-buffer.js';
import {SocialEngine} from '../components/qq-bridge/src/core/social-engine.js';
import {WechatOneBotAdapter} from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';
const key='wechat:private:123',message={platform:'wechat',kind:'private',conversation_id:'123',sender_id:'123',sender_wxid:'wxid_fixture',self_id:'99',message_id:'request',text:'给我结论和补充说明',timestamp:Date.now()/1000};
async function until(check){for(let i=0;i<400;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,4));}assert.fail('assistant layout fixture timed out');}
function fixture(t,{output='RESPOND: 已经处理好了。\n\n补充说明在这里。',failSecond=false,chatOnly=false}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-layout-')),file=path.join(root,'messages.json'),adapter=new WechatOneBotAdapter(),sent=[],attempts=[],engines=[];let modelCalls=0,failed=false;
 adapter.server.action=async(action,params)=>{const text=params.message[0].data.text,id=params.wechatagent_delivery_id;attempts.push({action,text,id});if(failSecond&&text==='补充说明在这里。'&&!failed){failed=true;throw Object.assign(Error('fixture disconnected'),{code:'FIXTURE_OFFLINE'});}sent.push({text,id});return {data:{receipt:'wechat-server-id'}};};
 const make=(buffer=new MessageBuffer(file))=>{const engine=new SocialEngine({buffer,workModeFor:()=> 'assistant',assistantChatOnly:chatOnly,assistantAccess:()=>true,assistantBatchMs:1,batchMs:1,minIntervalMs:0,privateMinIntervalMs:0,maxPerMinute:100,maxPerTenMinutes:100,layoutEnabledFor:()=>false,stickerPolicyFor:()=>({enabled:false}),decide:async()=>{modelCalls++;return output;},send:(row,text,options)=>adapter.sendText({kind:row.kind,target:row.conversation_id,text,deliveryId:options.deliveryId})});engines.push(engine);return engine;};
 t.after(()=>{for(const engine of engines)engine.stop();fs.rmSync(root,{recursive:true,force:true});});const engine=make();return {root,file,engine,make,sent,attempts,get failed(){return failed;},get modelCalls(){return modelCalls;}};
}

test('the stronger shared rule appears once in assistant and member-chat prompts without requiring a social layout plugin',t=>{
 const f=fixture(t);fs.mkdirSync(path.join(f.root,'config'));fs.writeFileSync(path.join(f.root,'config/wechatagent.json'),JSON.stringify({wechat:{whitelist:{private:['123'],groups:[]},workModes:{[key]:'assistant'}}}));assert.equal(CHAT_MESSAGE_LAYOUT_NOTICE,WECHAT_MESSAGE_LAYOUT_NOTICE);for(const prompt of [assistantInstructions,assistantChatInstructions,stableChatInstructions(f.root,key)]){assert.equal(prompt.split(WECHAT_MESSAGE_LAYOUT_NOTICE).length-1,1);assert(prompt.includes('优先分成多条微信消息'));assert(prompt.includes('一次最多两条'));}
});

test('assistant conclusions and explanations become two real adapter sends with separate receipts and history rows',async t=>{
 const f=fixture(t);f.engine.receive(message);await until(()=>f.engine.buffer.unread(key).length===0);assert.deepEqual(f.sent.map(item=>item.text),['已经处理好了。','补充说明在这里。']);assert.equal(new Set(f.sent.map(item=>item.id)).size,2);assert.equal(f.modelCalls,1);assert.deepEqual(f.engine.buffer.recent(key).filter(row=>row.outgoing).map(row=>row.text),['已经处理好了。','补充说明在这里。']);
});

test('group-member chat uses the same message boundary without acquiring task execution capability',async t=>{
 const f=fixture(t,{chatOnly:true}),group={...message,kind:'group',conversation_id:'456'};f.engine.receive(group);await until(()=>f.engine.buffer.unread('wechat:group:456').length===0);assert.deepEqual(f.sent.map(item=>item.text),['已经处理好了。','补充说明在这里。']);assert(f.engine.assistantChatOnly);assert.equal(f.engine.assistantControl,undefined);
});

test('short answers, continuous lines and fenced code stay whole, while paragraph overflow keeps the existing two-message cap',async t=>{
 for(const [output,expected]of [['RESPOND: 好的。',['好的。']],['RESPOND: 1. 第一步\n2. 第二步',['1. 第一步\n2. 第二步']],['RESPOND: 代码如下：\n\n```js\nconst a = 1;\n\nconsole.log(a);\n```',['代码如下：\n\n```js\nconst a = 1;\n\nconsole.log(a);\n```']],['RESPOND: 结论\n\n说明一\n\n说明二',['结论','说明一\n\n说明二']]]){const f=fixture(t,{output});f.engine.receive(message);await until(()=>f.engine.buffer.unread(key).length===0);assert.deepEqual(f.sent.map(item=>item.text),expected);}
});

test('restarting after a second-part failure retries only that part with its original delivery ID',async t=>{
 const f=fixture(t,{failSecond:true});f.engine.receive(message);await until(()=>f.failed&&!f.engine.running.has(key));f.engine.stop();assert.equal(f.engine.buffer.pendingReplies.size,1);const failedId=f.attempts.find(item=>item.text==='补充说明在这里。').id;
 const restored=f.make();restored.replay(key);await until(()=>restored.buffer.unread(key).length===0);assert.equal(f.modelCalls,1);assert.equal(f.sent.filter(item=>item.text==='已经处理好了。').length,1);assert.equal(f.sent.find(item=>item.text==='补充说明在这里。').id,failedId);
});
