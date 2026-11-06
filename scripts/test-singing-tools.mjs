import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {bindSingingTools,SINGING_POLICY,voiceReplyOutcome,singingReplyOutcome} from '../packages/dsh-social-bridge-plugin/singing-tools.mjs';
import {consoleClient,consolePort} from '../packages/dsh-social-bridge-plugin/console-client.mjs';

const key='wechat:private:123';
const plan={version:'score-performance-v1',emotion:'warm',intention:'结合歌词从容起句，后半句稍加强，再自然收尾。',phrases:[{start:0,end:20,articulation:'flowing',timingMs:10,tail:'hold',gainDb:.5,contour:'build'}]};
function fixture(t,options={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'singing-tools-')),tools=new Map();
  fs.mkdirSync(path.join(root,'config'),{recursive:true});fs.mkdirSync(path.join(root,'state/voice-output'),{recursive:true});
  fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify({wechat:{whitelist:{private:['123','456'],groups:[]}}}));
  const save=value=>fs.writeFileSync(path.join(root,'state/voice-output/capabilities.json'),JSON.stringify({singing:{provider:'feiyu-rvc',enabled:true,chats:[key],...value}}));save();
  let turn={controller:new AbortController(),calls:0};
  const ctx={tools:{register(tool){tools.set(tool.name,tool);return()=>tools.delete(tool.name);}}};
  const binding=bindSingingTools(ctx,root,key,()=>turn,options);
  t.after(()=>{binding.dispose();fs.rmSync(root,{recursive:true,force:true});});
  return {root,ctx,tools,binding,save,setTurn:value=>turn={controller:new AbortController(),calls:0,...value}};
}

test('singing tools require the live enabled chat scope and disappear after revocation',async t=>{
  const f=fixture(t,{fetchImpl:async()=>assert.fail('disabled tools must not call the console')});
  assert.equal(f.ctx[SINGING_POLICY].names().size,2);assert.match(f.binding.instructions(),/DJ版/);
  f.save({enabled:false});assert.equal(f.ctx[SINGING_POLICY].names().size,0);assert.equal(f.binding.instructions(),'');
  await assert.rejects(f.tools.get('wechat_sing_song').execute({title:'朋友的酒'}),/未开启/);
  f.save({chats:['wechat:private:456']});assert.equal(f.ctx[SINGING_POLICY].names().size,0);
});

test('chat model supplies song metadata, retries reuse the job, and status never claims delivery',async t=>{
  const calls=[];let f;
  f=fixture(t,{fetchImpl:async(url,options)=>{
    if(url.endsWith('/api/info'))return Response.json({project:'WeChatAgent Console',root:f.root,token:'fixture-token'});
    assert.equal(options.headers['X-Console-Token'],'fixture-token');calls.push({url,body:options.body&&JSON.parse(options.body)});
    return Response.json(url.endsWith('/request')?{id:'job-fixture',state:'running'}:{id:'job-fixture',state:'success',seconds:30});
  }});
  const sing=f.tools.get('wechat_sing_song'),status=f.tools.get('wechat_singing_status');
  const empty=JSON.parse((await status.execute({})).content);assert.equal(empty.state,'none');
  f.setTurn({networkOptOut:true});
  const first=JSON.parse((await sing.execute({title:'朋友的酒',version:'DJ版'})).content);
  await sing.execute({title:'朋友的酒',version:'DJ版'});assert.equal(calls.length,1);assert.equal(first.sent,false);
  assert.deepEqual(calls[0].body,{title:'朋友的酒',version:'DJ版',conversationKey:key,localOnly:true});
  f.setTurn();const ready=JSON.parse((await status.execute({})).content);assert.equal(ready.state,'success');assert.equal(ready.sent,false);
  assert.match(ready.notice,/不代表微信已发送/);assert.ok(!JSON.stringify(ready).includes('fixture-token'));
});

test('a different local project cannot receive song requests or the console token',async t=>{
  let calls=0;const f=fixture(t,{fetchImpl:async()=>{calls++;return Response.json({project:'WeChatAgent Console',root:'Z:/another-project',token:'must-not-use'});}});
  const result=await f.tools.get('wechat_sing_song').execute({title:'朋友的酒'});assert.equal(result.isError,true);assert.equal(calls,1);
  assert.ok(!result.content.includes('must-not-use'));
});

test('video requests use only current-turn references, reuse submissions and share real delivery status',async t=>{
  const videoId='b'.repeat(64),calls=[];let f;
  f=fixture(t,{fetchImpl:async(url,options)=>{
    if(url.endsWith('/api/info'))return Response.json({project:'WeChatAgent Console',root:f.root,token:'fixture-token'});
    calls.push({url,body:options.body&&JSON.parse(options.body)});
    if(url.endsWith('/video-reference'))return Response.json({referenceId:'ref-fixture',videoId,startSeconds:4,seconds:20,analysis:{phrases:[{start:0,end:20}]}});
    return Response.json({id:'11111111-1111-1111-1111-111111111111',state:'running'});
  }});
  const tool=f.tools.get('wechat_sing_video');
  assert(!f.ctx[SINGING_POLICY].names().has('wechat_sing_video'));
  f.setTurn({videos:[{id:videoId}],networkOptOut:true});
  assert(f.ctx[SINGING_POLICY].names().has('wechat_sing_video'));
  assert.match(f.binding.instructions(),/先理解.*wechat_analyze_singing/);
  assert.equal((await tool.execute({videoId:'a'.repeat(64)})).isError,true);assert.equal(calls.length,0);
  await f.tools.get('wechat_analyze_singing').execute({videoId,startSeconds:4});
  const result=JSON.parse((await tool.execute({videoId,referenceId:'ref-fixture',performance:plan})).content);
  await tool.execute({videoId,referenceId:'ref-fixture',performance:plan});assert.equal(calls.length,2);assert.equal(result.sent,false);
  assert(calls[1].url.endsWith('/music/video-request'));
  assert.deepEqual(calls[1].body,{videoId,referenceId:'ref-fixture',performance:plan,startSeconds:4,conversationKey:key,localOnly:true});
  f.setTurn();assert(!f.ctx[SINGING_POLICY].names().has('wechat_sing_video'));
  assert.equal(JSON.parse((await tool.execute({videoId})).content).state,'failed');
});

test('the model cannot skip reference analysis or submit overlapping expressive phrases',async t=>{
 const videoId='c'.repeat(64);let calls=0;
 const f=fixture(t,{fetchImpl:async url=>{if(url.endsWith('/api/info'))return Response.json({project:'WeChatAgent Console',root:f.root,token:'fixture-token'});calls++;return Response.json({referenceId:'ref',videoId,startSeconds:0,seconds:20,analysis:{phrases:[{start:0,end:20}]}});}});
 const turn=f.setTurn({videos:[{id:videoId}]}),sing=f.tools.get('wechat_sing_video');
 assert((await sing.execute({videoId,referenceId:'forged',performance:plan})).isError);assert.equal(calls,0);
 await f.tools.get('wechat_analyze_singing').execute({videoId});
 const invalid={...plan,phrases:[...plan.phrases,{...plan.phrases[0],start:10}]};
 assert((await sing.execute({videoId,referenceId:'ref',performance:invalid})).isError);assert.equal(calls,1);
 assert.equal(turn.singingOutcome.sent,false);
});

test('voice-only scope exposes AI voice tools, preserves one request per turn and reports real delivery status',async t=>{
  const calls=[];let f;
  f=fixture(t,{fetchImpl:async(url,options)=>{
    if(url.endsWith('/api/info'))return Response.json({project:'WeChatAgent Console',root:f.root,token:'fixture-token'});
    calls.push({url,body:options.body&&JSON.parse(options.body)});
    return Response.json({id:'a'.repeat(64),state:url.includes('/deliveries/')?'confirmed':'queued',sent:url.includes('/deliveries/')});
  }});
  fs.writeFileSync(path.join(f.root,'state/voice-output/capabilities.json'),JSON.stringify({voice:{provider:'feiyu',endpoint:'http://127.0.0.1:9880',enabled:true,chats:[key],mode:'ai-choice'},singing:{enabled:false}}));
  assert.deepEqual([...f.ctx[SINGING_POLICY].names()],['wechat_voice_reply','wechat_voice_status']);assert.match(f.binding.instructions(),/自然决定/);
  let starts=0;f.setTurn({onVoiceStart:()=>starts++});const send=f.tools.get('wechat_voice_reply');
  assert.equal(JSON.parse((await send.execute({text:'你好'})).content).sent,false);
  await send.execute({text:'你好'});assert.equal(calls.length,1);assert.equal(starts,1);assert.equal(calls[0].body.conversationKey,key);assert.match(calls[0].body.requestId,/^[a-f0-9-]{36}$/);
  f.setTurn();const status=JSON.parse((await f.tools.get('wechat_voice_status').execute({})).content);assert.equal(status.sent,true);
  assert.match(calls[1].url,/conversationKey=wechat%3Aprivate%3A123/);
});

test('voice and shared console clients discover the live project port again after the desktop changes port',async t=>{
  const calls=[];let f;
  f=fixture(t,{fetchImpl:async(url,options)=>{
    calls.push(url);
    if(url.endsWith('/api/info'))return Response.json({project:'WeChatAgent Console',root:f.root,token:'fixture-token'});
    assert.equal(options.headers['X-Console-Token'],'fixture-token');return Response.json({state:'queued',sent:false});
  }});
  const runtime=path.join(f.root,'state/console-runtime.json');
  fs.writeFileSync(runtime,JSON.stringify({root:f.root,port:47441}));
  fs.writeFileSync(path.join(f.root,'state/voice-output/capabilities.json'),JSON.stringify({voice:{provider:'feiyu',enabled:true,chats:[key]}}));
  assert.equal((await f.tools.get('wechat_voice_reply').execute({text:'测试'})).isError,false);
  assert(calls.every(url=>url.startsWith('http://127.0.0.1:47441/')));
  fs.writeFileSync(runtime,JSON.stringify({root:f.root,port:47442}));calls.length=0;f.setTurn();
  await f.tools.get('wechat_voice_reply').execute({text:'再次测试'});assert(calls.every(url=>url.startsWith('http://127.0.0.1:47442/')));
  const client=consoleClient(f.root,{fetchImpl:async url=>{calls.push(url);return Response.json(url.endsWith('/api/info')?{project:'WeChatAgent Console',root:f.root,token:'fixture-token'}:{ok:true});}});
  calls.length=0;await client('/api/status');assert(calls.every(url=>url.startsWith('http://127.0.0.1:47442/')));
  fs.writeFileSync(runtime,JSON.stringify({root:'Z:/other-project',port:47443}));assert.notEqual(consolePort(f.root),47443);assert.equal(consolePort(f.root,47444),47444);
});

test('voice connection errors name the failed local stage instead of reporting a singing failure',async t=>{
  const f=fixture(t,{fetchImpl:async()=>{throw Error('ECONNREFUSED');}});
  fs.writeFileSync(path.join(f.root,'state/voice-output/capabilities.json'),JSON.stringify({voice:{provider:'feiyu',enabled:true,chats:[key]}}));
  const turn=f.setTurn(),result=await f.tools.get('wechat_voice_reply').execute({text:'测试'});assert(result.isError);assert.match(result.content,/语音控制台连接失败/);assert(!result.content.includes('唱歌'));
  assert.equal(turn.voiceOutcome.sent,false);assert.equal(turn.voiceOutcome.state,'failed');
  assert.match(voiceReplyOutcome('RESPOND: 语音发了',turn),/没发出去/);
});

test('voice receipts override false success claims without carrying failure into an unrelated turn',async t=>{
  let f,outcome={state:'unconfirmed',sent:false};
  f=fixture(t,{fetchImpl:async url=>Response.json(url.endsWith('/api/info')?{project:'WeChatAgent Console',root:f.root,token:'fixture-token'}:outcome)});
  fs.writeFileSync(path.join(f.root,'state/voice-output/capabilities.json'),JSON.stringify({voice:{provider:'feiyu',enabled:true,chats:[key]}}));
  const tool=f.tools.get('wechat_voice_reply'),claim='RESPOND: 语音在发了，自己听';
  for(const state of ['queued','unconfirmed','failed','confirmed']){
    outcome={state,sent:state==='confirmed'};const turn=f.setTurn();await tool.execute({text:'你好'});
    const text=voiceReplyOutcome(claim,turn);if(state==='confirmed')assert.equal(text,claim);else{assert.notEqual(text,claim);assert.match(text,/没发出去|还没确认|没有确认发出/);}
  }
  assert.equal(voiceReplyOutcome('RESPOND: 普通文字',f.setTurn()),'RESPOND: 普通文字');
});

test('a disconnected voice submission remains uncertain rather than being reported as definitely unsent',async t=>{
 let f;f=fixture(t,{fetchImpl:async url=>{if(url.endsWith('/api/info'))return Response.json({project:'WeChatAgent Console',root:f.root,token:'fixture-token'});throw Error('socket lost');}});
 fs.writeFileSync(path.join(f.root,'state/voice-output/capabilities.json'),JSON.stringify({voice:{provider:'feiyu',enabled:true,chats:[key]}}));
 const turn=f.setTurn(),result=await f.tools.get('wechat_voice_reply').execute({text:'你好'});
 assert(result.isError);assert.equal(JSON.parse(result.content).state,'unconfirmed');assert.match(voiceReplyOutcome('RESPOND: 发了',turn),/送达情况还没确认/);
});

test('failed singing status replaces invented progress while confirmed delivery and unrelated turns retain their text',async t=>{
 let f,outcome={id:'job-fixture',state:'running',sent:false};
 f=fixture(t,{fetchImpl:async url=>Response.json(url.endsWith('/api/info')?{project:'WeChatAgent Console',root:f.root,token:'fixture-token'}:outcome)});
 await f.tools.get('wechat_sing_song').execute({title:'朋友的酒'});
 const claim='RESPOND: 正在录，等几分钟出片';
 for(const state of ['failed','running','success','confirmed']){
   outcome={id:'job-fixture',state:state==='confirmed'?'success':state,sent:state==='confirmed'};
   const turn=f.setTurn();await f.tools.get('wechat_singing_status').execute({});
   assert.equal(turn.singingOutcome.state,outcome.state);
   const text=singingReplyOutcome(claim,turn);
   if(state==='failed'){assert.match(text,/生成失败/);assert(!text.includes('正在录'));}
   if(state==='success'){assert.match(text,/已生成.*还没有确认送达/);assert.notEqual(text,claim);}
   if(state==='running'||state==='confirmed')assert.equal(text,claim);
 }
 assert.equal(singingReplyOutcome('RESPOND: 普通文字',f.setTurn()),'RESPOND: 普通文字');
 const other=fixture(t),turn=other.setTurn();await other.tools.get('wechat_singing_status').execute({});
 assert.match(singingReplyOutcome(claim,turn),/没有已启动/);
});

test('a truthful singing failure keeps the persona wording and next step instead of a canned receipt',async t=>{
 let f;
 f=fixture(t,{fetchImpl:async url=>Response.json(url.endsWith('/api/info')?{project:'WeChatAgent Console',root:f.root,token:'fixture-token'}:{error:'这首歌未提供可下载音频，可能需要登录、购买或受版权限制。'},{status:url.endsWith('/api/info')?200:422})});
 const turn=f.setTurn(),result=JSON.parse((await f.tools.get('wechat_sing_song').execute({title:'偏向'})).content);
 assert.equal(result.state,'failed');assert(!/版权|购买/.test(result.message));
 assert.match(result.notice,/自然口语/);
 const text='RESPOND: 哎，这歌的音源没拿到，还没唱成。\n你直接把视频发微信里，我再试试？';
 assert.equal(singingReplyOutcome(text,turn),text);
 assert.equal(singingReplyOutcome('RESPOND: 链接我这边打不开，你下载好发我，我就唱',turn),'RESPOND: 链接我这边打不开，你下载好发我，我就唱');
 const invented=singingReplyOutcome('RESPOND: 音源下不来，被版权挡了，得开会员',turn);
 assert(!/版权|会员/.test(invented));assert.match(invented,/音乐平台没有返回可用音源/);
});

test('preserved failure explanations cannot smuggle success or progress past the receipt check',()=>{
 const turn={singingOutcome:{state:'failed',sent:false,message:'音源暂时不可用。'}};
 for(const text of ['RESPOND: 没唱成，但已经发给你了','RESPOND: 音源下不来，我正在录，马上就好','RESPOND: 还没有生成好，不过已经发送了',
   'RESPOND: 这次生成失败了，不过音频发送成功了。','RESPOND: 这次没唱成，我正在处理，稍等就发给你。',
   'RESPOND: 这次没拿到新音源，语音送到你微信了。','RESPOND: 音源暂时不可用，稍等就发给你。',
   'RESPOND: 没唱成，不过微信语音投递成功。','RESPOND: 这次没有发送成功，但现在发送成功了。']){
   const guarded=singingReplyOutcome(text,turn);assert.notEqual(guarded,text);assert(!/已经发|正在录/.test(guarded));
 }
 for(const text of ['RESPOND: 音源没拿到，这次没有发送成功，你给我视频后我再试试。',
   'RESPOND: 这次没唱成，目前并不是正在处理，也没有发送成功。',
   'RESPOND: 这次没生成好，语音没有投递成功。',
   'RESPOND: 音频没发出去，还不能说发送成功。'])assert.equal(singingReplyOutcome(text,turn),text);
 const uncertain={singingOutcome:{state:'unconfirmed',sent:false}};
 const pending='RESPOND: 这条我还没确认送达，先不重复发啦。';assert.equal(singingReplyOutcome(pending,uncertain),pending);
 const unverified='RESPOND: 我还无法确认是否发送成功，先不重复发啦。';assert.equal(singingReplyOutcome(unverified,uncertain),unverified);
 assert.notEqual(singingReplyOutcome('RESPOND: 这条没有发出去，你再让我发一次',uncertain),'RESPOND: 这条没有发出去，你再让我发一次');
 const generated={singingOutcome:{state:'success',sent:false,deliveryState:'failed'}};
 const explain='RESPOND: 唱好了，可惜发送失败了，音频还没发出去。';assert.equal(singingReplyOutcome(explain,generated),explain);
 const unsent='RESPOND: 唱好了，但没有发送成功，音频还没发出去。';assert.equal(singingReplyOutcome(unsent,generated),unsent);
});
