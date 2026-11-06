import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createVoiceExecutor} from '../packages/dsh-capabilities-plugin/voice.mjs';
import {createAudioCapabilities,audioDefaults} from './audio-capabilities.mjs';

const wav=Buffer.alloc(48);wav.write('RIFF');wav.write('WAVE',8);
const payload=()=>({settings:{endpoint:'http://127.0.0.1:9882',style:'cute',voiceId:'FeiyuVoice-RVC-v1',emotionMode:'auto',emotionStrength:'natural'},credential:{mode:'custom',key:'fixture-private-key'},useRvc:false});
function fixture(t,options={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-voice-executor-')),calls=[];
  const executor=createVoiceExecutor({root,fetchImpl:async(url,request)=>{
    calls.push({url,request});
    if(url.endsWith('/health'))return Response.json({status:'ok',version:'fixture'});
    if(url.endsWith('/v1/capabilities'))return Response.json({tts:[{voice:'feiyu',available:true,styles:['cute']}]});
    if(url.endsWith('/v1/speech'))return Response.json({id:'fixture-job'});
    return url.endsWith('/audio')?new Response(wav):Response.json({status:'success'});
  },...options});
  t.after(()=>{executor.close();fs.rmSync(root,{recursive:true,force:true});});return {root,executor,calls};
}
const config={wechat:{whitelist:{private:[],groups:[]}}};
function savedService(t,options={}){
  const {root}=fixture(t),service=createAudioCapabilities({root,...options});t.after(()=>service.close());
  const save=()=>service.save('voice',{revision:service.snapshot().revision,settings:{...audioDefaults().voice,endpoint:'http://127.0.0.1:9882',apiKey:'fixture-private-key'}},config);
  save();return {root,service,save};
}

test('the WeChatAgent settings facade cannot synthesize or contact a provider without DSH execution',async t=>{
  let requests=0;const {service}=savedService(t,{fetchImpl:async()=>{requests++;assert.fail('the console must not use provider fetch');}});
  const check=await service.checkVoice({revision:service.snapshot().revision});assert.equal(check.code,'DSH_CAPABILITY_NOT_READY');
  await assert.rejects(service.preview({revision:service.snapshot().revision,text:'你好'}),error=>error.code==='DSH_CAPABILITY_NOT_READY');
  assert.equal(requests,0);assert.equal(service.isBusy(),false);
});

test('the DSH voice plugin validates its fixed execution contract before contacting providers',async t=>{
  const {executor,calls}=fixture(t);
  for(const change of [
    {settings:{...payload().settings,apiKey:'model-supplied-key'}},
    {settings:{...payload().settings,endpoint:'http://remote.invalid'}},
    {credential:{mode:'custom',key:'private\nheader'}},
    {useRvc:'yes'},
    {conversationKey:'wechat:private:999'},
    {text:'',emotion:'happy'},
    {emotion:'untrusted'},
  ])await assert.rejects(executor.generate({...payload(),text:'你好',...change}));
  assert.equal(calls.length,0);
  const checked=await executor.check(payload());assert.equal(checked.code,'TTS_CONFIGURED');
  assert(!JSON.stringify(checked).includes('fixture-private-key'));assert.equal(checked.sent,false);
  const generated=await executor.generate({...payload(),text:'你好',emotion:'happy'});
  assert.deepEqual(Buffer.from(generated.audio,'base64'),wav);assert.equal(generated.emotion,'happy');assert.equal(generated.sent,false);
});

test('missing RVC execution never falls back to the base speech voice',async t=>{
  const {executor,calls}=fixture(t,{models:{get:()=>({id:'selected-model'})},speechRvc:{available:()=>false,convert:()=>assert.fail('unavailable converter')}});
  const value={...payload(),useRvc:true,rvcModelId:'selected-model'};
  assert.equal((await executor.check(value)).code,'RVC_NOT_CONFIGURED');
  await assert.rejects(executor.generate({...value,text:'你好'}),/RVC 换声环境/);assert.equal(calls.length,0);
});

test('plugin close cancels generation and rejects a late response from a provider that ignored abort',async t=>{
  let release,entered;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve);
  const {executor}=fixture(t,{fetchImpl:async()=>{entered();await gate;return Response.json({id:'late-job'});}});
  const running=executor.generate({...payload(),text:'你好'});await ready;
  await assert.rejects(executor.generate({...payload(),text:'重复请求'}),error=>error.status===429);
  executor.close();release();await assert.rejects(running,/关闭|取消/);
});

test('settings changes during DSH generation invalidate the result and retain the new saved settings',async t=>{
  let release,entered;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve);
  const {service}=savedService(t,{execution:async(operation,value)=>{
    assert.equal(operation,'voice.generate');assert.equal(value.credential.key,'fixture-private-key');entered();await gate;
    return {audio:wav.toString('base64'),mime:'audio/wav',voiceId:value.settings.voiceId,emotion:'neutral',sent:false};
  }});
  const running=service.preview({revision:service.snapshot().revision,text:'你好'});await ready;
  service.save('voice',{revision:service.snapshot().revision,settings:{...audioDefaults().voice,endpoint:'http://127.0.0.1:9882',apiKey:'fixture-new-key',style:'gentle'}},config);
  release();await assert.rejects(running,error=>error.status===409);assert.equal(service.snapshot().settings.voice.style,'gentle');assert.equal(service.catalog(config)[0].ready,false);
});

test('the settings facade rejects an execution result for another selected voice',async t=>{
  const {service}=savedService(t,{execution:async()=>({audio:wav.toString('base64'),mime:'audio/wav',voiceId:'other-voice',emotion:'neutral',sent:true})});
  await assert.rejects(service.preview({revision:service.snapshot().revision,text:'你好'}),/返回结果无效/);assert.equal(service.isBusy(),false);
});
