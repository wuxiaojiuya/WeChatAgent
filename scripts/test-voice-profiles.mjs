import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {createVoiceProfiles,DEFAULT_VOICE} from './voice-profiles.mjs';
import {createRvcModels} from './rvc-models.mjs';
import {createAudioCapabilities,audioDefaults} from './audio-capabilities.mjs';

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
test('legacy RVC voices require a reference, and one selection controls both direct speech and singing',async t=>{
  const {root,models,voices,upload,model}=fixture(t),pth=await model(),legacy=models.add({name:'旧音色',modelUploadId:pth.uploadId});
  assert.equal(voices.get(legacy.id).ttsReady,false);
  const calls=[],service=createAudioCapabilities({root,voices,modelExists:id=>!!models.get(id),directTts:{available:()=>true,generate:async value=>{calls.push(value);return {audio:'fixture',mime:'audio/wav',runtimeRvc:false};}},fetchImpl:async()=>assert.fail('Custom direct speech must not call the Feiyu/RVC service')});t.after(()=>service.close());
  const config={wechat:{whitelist:{private:[],groups:[]}}};
  const save=(kind,value)=>service.save(kind,{revision:service.snapshot().revision,settings:{...audioDefaults()[kind],...value}},config);
  assert.throws(()=>save('voice',{voiceId:legacy.id}),/参考录音/);
  const ref=await upload();voices.add({existingVoiceId:legacy.id,name:'统一音色',referenceUploadId:ref.uploadId,referenceText:'参考文字。'});
  save('voice',{voiceId:legacy.id,emotionMode:'auto'});
  assert.equal(service.snapshot().settings.singing.modelId,legacy.id);
  save('singing',{modelId:DEFAULT_VOICE,enabled:true});assert.equal(service.snapshot().settings.singing.modelId,legacy.id);
  const result=await service.preview({revision:service.snapshot().revision,text:'直接说话。',emotion:'happy'});
  assert.equal(calls[0].voiceId,legacy.id);assert.equal(calls[0].text,'直接说话。');assert.equal(calls[0].emotion,'happy');assert.equal(result.runtimeRvc,false);
  assert.equal((await service.checkVoice({revision:service.snapshot().revision})).code,'TTS_CONFIGURED');
});
test('RVC-only migration preserves the chosen voice and never silently speaks in the default voice',async t=>{
  const {root,models,voices,model}=fixture(t),pth=await model(),legacy=models.add({name:'旧音色',modelUploadId:pth.uploadId});
  const voice=audioDefaults().voice;delete voice.voiceId;
  fs.mkdirSync(path.join(root,'state/voice-output'),{recursive:true});fs.writeFileSync(path.join(root,'state/voice-output/capabilities.json'),JSON.stringify({voice,singing:{...audioDefaults().singing,modelId:legacy.id}}));
  const service=createAudioCapabilities({root,voices,modelExists:id=>!!models.get(id),fetchImpl:async()=>assert.fail('Missing reference must not infer')});t.after(()=>service.close());
  assert.equal(service.snapshot().settings.voice.voiceId,legacy.id);
  await assert.rejects(service.preview({revision:service.snapshot().revision,text:'你好'}),/参考录音/);
});
