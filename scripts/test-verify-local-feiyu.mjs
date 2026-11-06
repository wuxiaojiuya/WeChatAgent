import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {verifyLocalFeiyu} from './verify-local-feiyu.mjs';
import {createAudioCapabilities,audioDefaults} from './audio-capabilities.mjs';

const secret='fixture-diagnostic-secret',wav=Buffer.alloc(48);wav.write('RIFF');wav.write('WAVE',8);
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-voice-diagnostic-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'state/voice-output/capabilities.json');fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({voice:{...audioDefaults().voice,endpoint:'http://127.0.0.1:9882',apiKey:secret}}));
  return {root,file,before:fs.readFileSync(file,'utf8')};
}

test('local speech diagnostics execute saved settings through DSH without changing settings or exposing private results',async t=>{
  const {root,file,before}=fixture(t),calls=[],logs=[];
  const result=await verifyLocalFeiyu({root,log:value=>logs.push(value),execution:async(operation,payload)=>{
    calls.push(operation);assert.equal(payload.credential.key,secret);assert.equal(payload.useRvc,true);
    if(operation==='voice.check')return {code:'TTS_CONFIGURED',message:secret,serviceReachable:true,authenticated:true,ttsConfigured:true,rvcAvailable:true};
    assert.equal(operation,'voice.generate');assert.equal(payload.settings.voiceId,audioDefaults().voice.voiceId);
    return {audio:wav.toString('base64'),mime:'audio/wav',voiceId:payload.settings.voiceId,emotion:'neutral',runtimeRvc:true,sent:false};
  }});
  assert.deepEqual(calls,['voice.check','voice.generate']);assert.equal(result.ok,true);assert.equal(result.sent,false);
  assert.deepEqual(fs.readFileSync(result.file),wav);assert.equal(fs.readFileSync(file,'utf8'),before);
  assert(!JSON.stringify(logs).includes(secret));assert(!JSON.stringify(logs).includes(wav.toString('base64')));
});

test('diagnostics stop when DSH is unavailable and never log exception details',async t=>{
  const {root}=fixture(t),calls=[],logs=[];
  const result=await verifyLocalFeiyu({root,log:value=>logs.push(value),execution:async operation=>{
    calls.push(operation);throw Object.assign(Error(secret),{code:'DSH_CAPABILITY_UNAVAILABLE',status:503});
  }});
  assert.equal(result.ok,false);assert.deepEqual(calls,['voice.check']);assert(!JSON.stringify(logs).includes(secret));
  assert.equal(fs.existsSync(path.join(root,'state/maintenance/filehelper-feiyu-speech.wav')),false);
});

test('audio catalog attributes execution to DSH and settings management to WeChatAgent',t=>{
  const {root}=fixture(t),api=createAudioCapabilities({root});t.after(()=>api.close());
  for(const card of api.catalog({wechat:{whitelist:{private:[],groups:[]}}})){
    assert.equal(card.host,'dsh');assert.equal(card.managementHost,'wechatagent');assert.equal(card.management,'audio');
  }
});
