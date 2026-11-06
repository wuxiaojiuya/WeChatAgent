import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {createVoiceProfiles,DEFAULT_VOICE} from './voice-profiles.mjs';
import {createRvcModels} from './rvc-models.mjs';
import {createAudioCapabilities,audioDefaults} from './audio-capabilities.mjs';
import {createVoiceExecutor} from '../packages/dsh-capabilities-plugin/voice.mjs';

function capabilityService(t,{root,voices,models,...options}){
  const executor=createVoiceExecutor({root,models,...options});
  const service=createAudioCapabilities({root,voices,modelExists:id=>!!models.get(id),execution:(operation,payload,context)=>executor[operation==='voice.check'?'check':'generate'](payload,context)});
  t.after(()=>{service.close();executor.close();});return service;
}

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'shared-voice-'));
  const models=createRvcModels({root,inspectAsset:async()=>({dimension:768,version:'v2',sha256:'fixture'})});
  const voices=createVoiceProfiles({root,models,prepareReference:async(input,output)=>{fs.copyFileSync(input,output);return {seconds:5};}});
  t.after(()=>{voices.close();models.close();fs.rmSync(root,{recursive:true,force:true});});
  const upload=()=>voices.upload(Readable.from([Buffer.from('reference')]),{name:'reference.wav'});
  const model=()=>models.upload(Readable.from([Buffer.from('model')]),{name:'voice.pth',kind:'pth'});
  return {root,models,voices,upload,model};
}
test('one voice profile holds a direct TTS reference and its singing model without exposing paths or transcript',async t=>{
  const {root,voices,upload,model}=fixture(t);
  const ref=await upload(),pth=await model();
  const added=voices.add({name:'我的音色',referenceUploadId:ref.uploadId,referenceText:'这是参考录音。',modelUploadId:pth.uploadId});
  assert.equal(added.rvcModelId,added.id);assert.equal(voices.get(added.id).ttsReady,true);
  assert(!JSON.stringify(voices.publicList()).includes(root));assert(!JSON.stringify(voices.publicList()).includes('这是参考录音'));
  assert.throws(()=>voices.add({name:'duplicate',referenceUploadId:ref.uploadId,referenceText:'unused'}));
});
test('a speech-only voice can gain a paired RVC model while retaining its reference and identity',async t=>{
  const {voices,upload,model}=fixture(t),ref=await upload();
  const added=voices.add({name:'先说话',referenceUploadId:ref.uploadId,referenceText:'你好呀。'});
  assert.equal(added.rvcModelId,'');
  const pth=await model(),updated=voices.add({existingVoiceId:added.id,name:'说话与唱歌',modelUploadId:pth.uploadId});
  assert.equal(updated.id,added.id);assert(updated.rvcModelId);assert.equal(updated.referenceSha256,added.referenceSha256);
});
test('RVC-only voices synthesize first then convert with the same model used for singing',async t=>{
  const {root,models,voices,model}=fixture(t),pth=await model(),legacy=models.add({name:'旧音色',modelUploadId:pth.uploadId});
  assert.equal(voices.get(legacy.id).ttsReady,false);
  const calls=[],tts=[],wav=Buffer.alloc(48);wav.write('RIFF');wav.write('WAVE',8);let conversionError;
  const service=capabilityService(t,{root,voices,models,speechRvc:{available:()=>true,convert:async value=>{calls.push(value);if(conversionError)throw conversionError;return {audio:wav.toString('base64'),mime:'audio/wav',runtimeRvc:true};}},fetchImpl:async(url,options)=>{
    if(url.endsWith('/health'))return Response.json({status:'ok',version:'fixture'});
    if(url.endsWith('/v1/capabilities'))return Response.json({tts:[{voice:'feiyu',available:true,styles:['cute']}]});
    if(url.endsWith('/v1/speech')){tts.push(JSON.parse(options.body));return Response.json({id:'tts-fixture'});}
    return url.endsWith('/audio')?new Response(wav):Response.json({status:'success'});
  }});
  const config={wechat:{whitelist:{private:[],groups:[]}}};
  const save=(kind,value)=>service.save(kind,{revision:service.snapshot().revision,settings:{...audioDefaults()[kind],...value}},config);
  save('voice',{voiceId:legacy.id,endpoint:'http://127.0.0.1:9882',apiKey:'fixture-credential'});
  assert.equal(service.snapshot().settings.singing.modelId,legacy.id);
  save('singing',{enabled:true});
  assert.equal((await service.checkVoice({revision:service.snapshot().revision})).code,'TTS_CONFIGURED');
  const result=await service.preview({revision:service.snapshot().revision,text:'先合成再换声。',emotion:'happy'});
  assert.equal(calls[0].modelId,legacy.id);assert.deepEqual(calls[0].audio,wav);
  assert.equal(tts[0].text,'先合成再换声。');assert.equal(tts[0].emotion,'happy');assert.equal(result.runtimeRvc,true);assert.equal(result.audio,wav.toString('base64'));
  conversionError=Object.assign(Error('换声失败'),{status:502});
  await assert.rejects(service.preview({revision:service.snapshot().revision,text:'不应退回基础音色'}),/换声失败/);
  assert.equal(service.isBusy(),false);
  assert.throws(()=>save('voice',{voiceId:'missing-voice'}),/不存在/);
});
test('RVC-only migration preserves the chosen voice and fails clearly when conversion is unavailable',async t=>{
  const {root,models,voices,model}=fixture(t),pth=await model(),legacy=models.add({name:'旧音色',modelUploadId:pth.uploadId});
  const voice={...audioDefaults().voice,endpoint:'http://127.0.0.1:9882',apiKey:'fixture-credential'};delete voice.voiceId;
  fs.mkdirSync(path.join(root,'state/voice-output'),{recursive:true});fs.writeFileSync(path.join(root,'state/voice-output/capabilities.json'),JSON.stringify({voice,singing:{...audioDefaults().singing,modelId:legacy.id}}));
  const service=capabilityService(t,{root,voices,models,fetchImpl:async()=>assert.fail('Missing RVC runtime must not start TTS')});
  assert.equal(service.snapshot().settings.voice.voiceId,legacy.id);
  await assert.rejects(service.preview({revision:service.snapshot().revision,text:'你好'}),/RVC 换声环境/);
  assert.equal((await service.checkVoice({revision:service.snapshot().revision})).code,'RVC_NOT_CONFIGURED');
});

test('voice upload accepts and updates an RVC-only model without reference recordings',async t=>{
  const {voices,model}=fixture(t),pth=await model();
  const voice=voices.add({name:'只上传模型',modelUploadId:pth.uploadId});
  assert.equal(voice.ttsReady,false);assert.equal(voice.rvcModelId,voice.id);
  assert.equal(voices.get(voice.id).name,'只上传模型');
  const updated=voices.add({name:'更新名称',existingVoiceId:voice.id});
  assert.equal(updated.id,voice.id);assert.equal(updated.rvcModelId,voice.rvcModelId);
  assert.throws(()=>voices.add({name:'没有模型'}),/RVC/);
});
