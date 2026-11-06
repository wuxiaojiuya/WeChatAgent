import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SocialEngine,buildSocialPrompt,isDirectMention} from '../components/qq-bridge/src/core/social-engine.js';
import {MessageBuffer} from '../components/qq-bridge/src/core/message-buffer.js';
import {stableChatInstructions,GROUP_PARTICIPATION_NOTICE,dedupePreviousReply} from '../packages/dsh-social-bridge-plugin/prompt-context.mjs';

const key='wechat:group:123';
const message=(id,extra={})=>({platform:'wechat',kind:'group',conversation_id:'123',self_id:'self',sender_id:'friend',message_id:id,text:'今天晚上吃什么',timestamp:Date.now()/1000,...extra});
function fixture(t,options={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-group-participation-'));
  const buffer=new MessageBuffer(path.join(root,'messages.json')),prompts=[],sent=[],logs=[];
  const engine=new SocialEngine({buffer,batchMs:1,minIntervalMs:0,privateMinIntervalMs:0,maxPerMinute:100,maxPerTenMinutes:100,
    wakeWords:['小鲸鱼'],stickerPolicyFor:()=>({enabled:false}),
    decide:async(_key,prompt)=>{prompts.push(prompt);return 'SILENT';},send:async(_message,text)=>{sent.push(text);return {delivered:'confirmed'};},log:line=>logs.push(line),...options});
  t.after(()=>{engine.stop();fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  return {root,buffer,engine,prompts,sent,logs};
}
async function until(check){const end=Date.now()+3000;while(!check()&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,5));assert(check(),'isolated group processing timed out');}
const quoteReply=(reply,relation='other')=>({version:1,reply,reference:{senderId:'other',senderName:'群友',conversationId:'123',messageId:'9',time:'',kind:'1',text:'小鲸鱼说过这个',senderRelation:relation}});

test('group participation policy applies to social groups while private chats and assistant tasks retain their own rules',t=>{
  const f=fixture(t);fs.mkdirSync(path.join(f.root,'config'));const config={wechat:{whitelist:{groups:['123'],private:['123']},workModes:{}}};
  const write=()=>fs.writeFileSync(path.join(f.root,'config/wechatagent.json'),JSON.stringify(config));write();
  const group=stableChatInstructions(f.root,key);
  assert.equal(group.split(GROUP_PARTICIPATION_NOTICE).length-1,1);
  assert(!stableChatInstructions(f.root,'wechat:private:123').includes(GROUP_PARTICIPATION_NOTICE));
  config.wechat.workModes[key]='assistant';write();assert(!stableChatInstructions(f.root,key).includes(GROUP_PARTICIPATION_NOTICE));
});

test('current text, real mentions and self quotations wake the bot, names in other peoples quoted or forwarded history do not',()=>{
  assert(isDirectMention(message('name',{text:'小鲸鱼你怎么看'}),['小鲸鱼']));
  assert(isDirectMention(message('at',{self_id:99,segments:[{type:'at',data:{id:'99'}}]})));
  assert(!isDirectMention(message('other-at',{segments:[{type:'at',data:{id:'other'}}]})));
  assert(!isDirectMention(message('quote',{text:'小鲸鱼说过这个',quoteReply:quoteReply('确实')}),['小鲸鱼']));
  assert(isDirectMention(message('quote-name',{quoteReply:quoteReply('小鲸鱼你觉得呢')}),['小鲸鱼']));
  assert(isDirectMention(message('quote-self',{quoteReply:quoteReply('那怎么办','self')})));
  assert(!isDirectMention(message('forward',{text:'小鲸鱼的聊天记录',forwardedRecord:{items:[]}}),['小鲸鱼']));
});

test('a recent reply and multiple speakers raise the participation threshold without treating an unmentioned follow-up as an invitation',()=>{
  const now=Date.now(),previous={...message('self'),outgoing:true,text:'我觉得先看看具体情况',timestamp:(now-10000)/1000};
  const rows=[message('a'),message('b',{sender_id:'another',text:'[图片]',images:[{id:'a'.repeat(64)}]})];
  const prompt=buildSocialPrompt({key,rows,history:[previous,...rows],previousReply:previous,lastReplyAt:now-10000,now});
  assert.match(prompt,/没有明确唤醒/);assert.match(prompt,/本轮只回应明确接你话、追问你的内容/);assert.match(prompt,/已有 2 位其他成员/);
  const direct=buildSocialPrompt({key,rows,direct:true,lastReplyAt:now-10000,now});assert.match(direct,/有明确唤醒信号/);assert(!direct.includes('本轮只回应明确接你话'));
  const event={seq:1,type:'assistant/message',data:{message:{content:[{type:'text',text:'RESPOND: '+previous.text}]}}};
  const deduped=dedupePreviousReply({surface:{nodes:[1]},snapshotEvents:()=>[event]},{source:{kind:'wechat-social-bridge'},content:[{type:'text',text:prompt}]});
  assert(!deduped.content[0].text.includes('<previous_reply>'));assert(deduped.content[0].text.includes('没有明确唤醒'));
});

test('ordinary chatter and pictures can remain silent; an unmentioned follow-up still reaches the model with participation context',async t=>{
  const f=fixture(t);f.engine.receive(message('ordinary',{text:'[图片]',images:[{id:'a'.repeat(64)}]}));
  await until(()=>f.buffer.unread(key).length===0&&!f.engine.running.has(key));assert.equal(f.prompts.length,1);assert.deepEqual(f.sent,[]);
  f.buffer.append(message('self',{sender_id:'self',text:'先确认一下设备型号',timestamp:Date.now()/1000}),{outgoing:true});f.engine.noteOutgoing(key,Date.now());
  f.engine.decide=async(_key,prompt)=>{assert.match(prompt,/先确认一下设备型号/);assert.match(prompt,/只回应明确接你话/);return 'RESPOND: 那就按这个型号来';};
  f.engine.receive(message('followup',{text:'就是你说的那个型号'}));
  await until(()=>f.buffer.unread(key).length===0&&!f.engine.running.has(key));assert.deepEqual(f.sent,['那就按这个型号来']);
});

test('expired ordinary messages remain in history without late replies or model calls',async t=>{
  const f=fixture(t);f.engine.receive(message('expired',{timestamp:(Date.now()-95000)/1000}));
  await until(()=>f.buffer.unread(key).length===0&&!f.engine.running.has(key));
  assert.equal(f.prompts.length,0);assert.deepEqual(f.sent,[]);assert.equal(f.buffer.recent(key).length,1);assert(f.logs.some(line=>line.includes('group_topic_expired')));
});

test('a long group quota observes unsolicited messages immediately and keeps explicit invitations queued',async t=>{
  const f=fixture(t,{maxPerMinute:1});f.engine.noteOutgoing(key,Date.now());f.engine.receive(message('chatter'));
  await until(()=>f.buffer.unread(key).length===0&&!f.engine.running.has(key));
  assert.equal(f.prompts.length,0);assert(!f.engine.timers.has(key));assert(f.logs.some(line=>line.includes('group_observe_rate_limit')));
  f.engine.receive(message('invitation',{text:'小鲸鱼你怎么看'}));
  await until(()=>!f.engine.running.has(key)&&f.engine.timers.has(key));assert.equal(f.buffer.unread(key).length,1);
});

test('stale direct mentions and private messages are still answered normally',async t=>{
  for(const extra of [{text:'小鲸鱼你怎么看'},{kind:'private'}]){
    const f=fixture(t,{decide:async()=> 'RESPOND: 我在'}),chat=extra.kind==='private'?'wechat:private:123':key;
    f.engine.receive(message('addressed',{timestamp:(Date.now()-95000)/1000,...extra}));
    await until(()=>f.buffer.unread(chat).length===0&&!f.engine.running.has(chat));assert.deepEqual(f.sent,['我在']);
  }
});

test('an already admitted group request is retried with its original identity even after the topic ages',async t=>{
  let calls=0;const f=fixture(t,{decide:async()=>{if(++calls===1)throw Error('temporary failure');return 'RESPOND: 继续这次已受理的回复';}});
  f.engine.receive(message('admitted'));await until(()=>calls===1&&!f.engine.running.has(key));assert(f.buffer.pendingRequests.has(key));
  const admitted=f.buffer.pendingRequests.get(key),stored=f.buffer.unread(key)[0];stored.timestamp-=100;
  f.engine.replay(key);await until(()=>f.buffer.unread(key).length===0&&!f.engine.running.has(key));
  assert.equal(calls,2);assert.equal(admitted.rowIds[0],stored.id);assert.deepEqual(f.sent,['继续这次已受理的回复']);
});
