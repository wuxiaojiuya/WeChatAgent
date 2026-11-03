import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {bindSingingTools,SINGING_POLICY} from '../packages/dsh-social-bridge-plugin/singing-tools.mjs';

const key='wechat:private:123';
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
    return Response.json({id:'11111111-1111-1111-1111-111111111111',state:'running'});
  }});
  const tool=f.tools.get('wechat_sing_video');
  assert(!f.ctx[SINGING_POLICY].names().has('wechat_sing_video'));
  f.setTurn({videos:[{id:videoId}],networkOptOut:true});
  assert(f.ctx[SINGING_POLICY].names().has('wechat_sing_video'));
  assert.match(f.binding.instructions(),/直接使用对应视频音轨/);
  assert.equal((await tool.execute({videoId:'a'.repeat(64)})).isError,true);assert.equal(calls.length,0);
  const result=JSON.parse((await tool.execute({videoId,startSeconds:4})).content);
  await tool.execute({videoId,startSeconds:4});assert.equal(calls.length,1);assert.equal(result.sent,false);
  assert(calls[0].url.endsWith('/music/video-request'));
  assert.deepEqual(calls[0].body,{videoId,startSeconds:4,conversationKey:key,localOnly:true});
  f.setTurn();assert(!f.ctx[SINGING_POLICY].names().has('wechat_sing_video'));
  assert.equal(JSON.parse((await tool.execute({videoId})).content).state,'failed');
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
  const send=f.tools.get('wechat_voice_reply');
  assert.equal(JSON.parse((await send.execute({text:'你好'})).content).sent,false);
  await send.execute({text:'你好'});assert.equal(calls.length,1);assert.equal(calls[0].body.conversationKey,key);assert.match(calls[0].body.requestId,/^[a-f0-9-]{36}$/);
  f.setTurn();const status=JSON.parse((await f.tools.get('wechat_voice_status').execute({})).content);assert.equal(status.sent,true);
  assert.match(calls[1].url,/conversationKey=wechat%3Aprivate%3A123/);
});
