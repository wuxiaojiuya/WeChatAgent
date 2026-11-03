import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createAudioCapabilities,audioDefaults} from './audio-capabilities.mjs';
import {createConsole} from './console-server.mjs';
import {feiyuCredential} from './feiyu-credentials.mjs';
const secret='fixture-feiyu-credential';
const config={wechat:{whitelist:{private:['123'],groups:['456']}}};
function fixture(t,fetchImpl,options={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'feiyu-audio-'));
  const service=createAudioCapabilities({root,fetchImpl,...options});t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true});});
  const save=(kind,value,extra={})=>service.save(kind,{revision:service.snapshot().revision,settings:{...audioDefaults()[kind],...(kind==='voice'?{endpoint:'http://127.0.0.1:9882'}:{}),...value},...extra},config);
  return {root,service,save};
}

function localCredential(root,key,{relative=false}={}){
  const folder=path.join(root,'state/maintenance/audio-capabilities/feiyu-tts');fs.mkdirSync(folder,{recursive:true});
  const server=path.join(root,'state/maintenance/audio-capabilities/feiyu-cover/source/astrbot_plugin_feiyu_voice-76774b499f7d306454562d56348dd63399b6d7e8/server');
  const data=relative?'custom-service-data':path.join(folder,'service-data');
  fs.writeFileSync(path.join(folder,'voice-service.json'),JSON.stringify({schema:'feiyu-voice-service-v1',data_dir:data}));
  const keyFile=path.resolve(server,data,'api_key.txt');fs.mkdirSync(path.dirname(keyFile),{recursive:true});fs.writeFileSync(keyFile,key);return keyFile;
}

test('managed speech reads the actual service key, overrides stale manual keys and invalidates readiness after rotation',async t=>{
  let current='managed-local-credential-one';const wav=Buffer.alloc(48);wav.write('RIFF');wav.write('WAVE',8);
  const {root,service,save}=fixture(t,async(url,options)=>{
    if(url.endsWith('/health'))return Response.json({status:'ok',version:'fixture'});
    assert.equal(options.headers.Authorization,'Bearer '+current);
    if(url.endsWith('/v1/capabilities'))return Response.json({tts:[{voice:'feiyu',available:true,styles:['cute']}]});
    if(url.endsWith('/v1/speech'))return Response.json({id:'managed-job'});
    return url.endsWith('/audio')?new Response(wav):Response.json({status:'success'});
  },{nativeStatus:()=>({ready:true})});
  const keyFile=localCredential(root,current,{relative:true});
  save('voice',{endpoint:'http://127.0.0.1:9880',apiKey:'stale-manual-credential'});
  const saved=service.snapshot();assert.equal(saved.settings.voice.credentialMode,'managed');assert.equal(saved.settings.voice.hasApiKey,true);assert.equal(saved.settings.voice.apiKey,'');
  assert(!JSON.stringify(saved).includes(current));assert(!fs.readFileSync(path.join(root,'state/voice-output/capabilities.json'),'utf8').includes('stale-manual-credential'));
  assert.equal((await service.checkVoice({revision:saved.revision})).code,'TTS_CONFIGURED');
  await service.preview({revision:saved.revision,text:'你好'});assert.equal(service.catalog(config)[0].ready,true);
  current='managed-local-credential-two';fs.writeFileSync(keyFile,current);
  assert.equal(service.catalog(config)[0].ready,false);assert.equal(service.snapshot().revision,saved.revision);
  assert.equal((await service.checkVoice({revision:saved.revision})).authenticated,true);
  await service.preview({revision:saved.revision,text:'你好'});assert.equal(service.catalog(config)[0].ready,true);
});

test('managed credentials never leave for custom addresses or silently carry over when switching services',async t=>{
  const {root,service,save}=fixture(t,async()=>assert.fail('Missing credential must not start inference'));
  const key=localCredential(root,'private-managed-service-key');
  const file=path.join(root,'state/voice-output/capabilities.json');fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({voice:{...audioDefaults().voice,apiKey:'legacy-manual-local-key'}}));
  for(const endpoint of ['https://remote.example','https://127.0.0.1:9880','http://127.0.0.1:9882']){
    assert.deepEqual(feiyuCredential(root,{endpoint,apiKey:''}),{mode:'custom',key:''});
  }
  save('voice',{endpoint:'https://remote.example'});assert.equal(service.snapshot().settings.voice.hasApiKey,false);
  await assert.rejects(service.preview({revision:service.snapshot().revision,text:'你好'}),/自定义.*API Key/);
  save('voice',{endpoint:'https://remote.example',apiKey:secret});
  assert.equal(service.snapshot().settings.voice.hasApiKey,true);
  save('voice',{endpoint:'https://another.example'});assert.equal(service.snapshot().settings.voice.hasApiKey,false);
  assert.equal(fs.readFileSync(key,'utf8'),'private-managed-service-key');
});

test('managed setup reports missing, malformed and rejected credentials without requesting manual input or exposing secrets',async t=>{
  let status=200,healthFails=false;
  const {root,service,save}=fixture(t,async url=>{
    if(healthFails)throw Error('sensitive network diagnostic');
    return url.endsWith('/health')?Response.json({status:'ok',version:'fixture'}):new Response('private-managed-service-key',{status});
  });
  save('voice',{endpoint:'http://localhost:9880'});
  const check=()=>service.checkVoice({revision:service.snapshot().revision});
  assert.equal((await check()).code,'LOCAL_KEY_UNAVAILABLE');
  const keyFile=localCredential(root,'bad\ncredential');assert.equal(service.snapshot().settings.voice.hasApiKey,false);
  await assert.rejects(service.preview({revision:service.snapshot().revision,text:'你好'}),/无需填写/);
  fs.writeFileSync(keyFile,'private-managed-service-key');status=401;
  const rejected=await check();assert.equal(rejected.code,'AUTH_FAILED');assert.match(rejected.message,/重启/);assert(!JSON.stringify(rejected).includes('private-managed-service-key'));
  healthFails=true;assert.equal((await check()).code,'SERVICE_UNAVAILABLE');
  fs.rmSync(keyFile);assert.equal(service.snapshot().settings.voice.hasApiKey,false);
});
test('new local service never reuses old cloud credentials or speaker associations',t=>{
  const {root,service,save}=fixture(t);const file=path.join(root,'state/voice-output/capabilities.json');fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({voice:{provider:'volcengine',apiKey:secret,speaker:'old-speaker',mode:'on-request'},singing:{provider:'rvc',voiceSource:'voice-reply',modelId:'old-model'}}));
  const data=service.snapshot();assert.equal(data.settings.voice.provider,'feiyu');assert.equal(data.settings.voice.hasApiKey,false);
  assert.equal(data.settings.voice.mode,'on-request');assert.equal(data.settings.singing.provider,'feiyu-rvc');assert.equal(data.settings.singing.modelId,'FeiyuVoice-RVC-v1');
  assert.ok(!JSON.stringify(data).includes(secret));save('singing',{musicSource:'netease'});assert.ok(!fs.readFileSync(file,'utf8').includes(secret));
});
test('local settings persist separately, mask the private API key and reject stale revisions',t=>{
  const {root,service,save}=fixture(t),initial=service.snapshot();
  save('voice',{apiKey:secret,style:'gentle',chats:['wechat:private:123']});save('singing',{musicSource:'qq',pitch:2,accompaniment:false});save('voice',{style:'gentle'});
  const reread=createAudioCapabilities({root});t.after(()=>reread.close());const value=reread.snapshot();
  assert.equal(value.settings.voice.hasApiKey,true);assert.equal(value.settings.voice.apiKey,'');assert.equal(value.settings.singing.musicSource,'qq');assert.equal(value.settings.singing.pitch,2);
  assert.ok(!JSON.stringify(service.catalog(config)).includes(secret));
  assert.throws(()=>service.save('voice',{revision:initial.revision,settings:audioDefaults().voice},config),error=>error.status===409);
  save('voice',{}, {clearApiKey:true});assert.equal(service.snapshot().settings.voice.hasApiKey,false);
});
test('configuration validates local endpoints, source choices, scopes and model settings',t=>{
  const {save}=fixture(t);
  for(const value of [{provider:'volcengine'},{style:'happy'},{chats:['wechat:private:999']},{apiKey:'x\ny'},
    {endpoint:'https:'+'/'+ '/'+['u:password','example.com'].join('@')},{endpoint:'http://remote.example.com'},{endpoint:'https://example.com?key=secret'},{endpoint:'https://example.com/path'}])assert.throws(()=>save('voice',value),error=>error.status===400);
  for(const value of [{musicSource:'invalid'},{pitch:13},{clipSeconds:31},{accompaniment:'yes'},{provider:'rvc'}])assert.throws(()=>save('singing',value),error=>error.status===400);
});

test('Douyin cookie stays local and masked, preserves blank edits and supports explicit clearing',t=>{
  const {service,save}=fixture(t),cookie='fixture_cookie=local-test-value';
  save('singing',{douyinCookie:cookie});
  assert.equal(service.snapshot().settings.singing.hasDouyinCookie,true);assert.equal(service.snapshot().settings.singing.douyinCookie,'');
  assert(!JSON.stringify(service.snapshot()).includes(cookie));assert(!JSON.stringify(service.catalog(config)).includes(cookie));
  save('singing',{});assert.equal(service.snapshot().settings.singing.hasDouyinCookie,true);
  assert.throws(()=>save('singing',{douyinCookie:'invalid\r\nheader'}));
  save('singing',{}, {clearDouyinCookie:true});assert.equal(service.snapshot().settings.singing.hasDouyinCookie,false);
});
test('Feiyu preview submits a real service job, polls completion, then fetches WAV',async t=>{
  const calls=[];let pending=0;const wav=Buffer.alloc(48);wav.write('RIFF');wav.write('WAVE',8);
  const {service,save}=fixture(t,async(url,options)=>{
    calls.push(url);assert.equal(options.headers.Authorization,'Bearer '+secret);
    if(url.endsWith('/v1/speech')){assert.deepEqual(JSON.parse(options.body),{voice:'feiyu',style:'gentle',text:'你好'});return Response.json({id:'job-123'});}
    if(url.endsWith('/audio'))return new Response(wav,{headers:{'Content-Type':'audio/wav'}});
    return Response.json({status:pending++?'success':'running'});
  });
  save('voice',{apiKey:secret,style:'gentle'});
  const result=await service.preview({revision:service.snapshot().revision,text:'你好'});
  assert.equal(result.sent,false);assert.deepEqual(Buffer.from(result.audio,'base64'),wav);assert.equal(calls.length,4);assert.ok(calls.every(url=>url.startsWith('http://127.0.0.1:9882/')));
});
test('voice preview enforces a saved credential, serializes work and supports cancellation',async t=>{
  let entered;const ready=new Promise(resolve=>entered=resolve);
  const {service,save}=fixture(t,async(_url,options)=>{entered();return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));});
  await assert.rejects(service.preview({revision:service.snapshot().revision,text:'你好'}),/API Key/);
  save('voice',{apiKey:secret});const body={revision:service.snapshot().revision,text:'你好'},controller=new AbortController();
  const pending=service.preview(body,{signal:controller.signal});await ready;
  await assert.rejects(service.preview(body),error=>error.status===429);controller.abort();await assert.rejects(pending,/取消/);
});

test('emotional preview passes only validated expression and forced neutral suppresses it',async t=>{
  const submitted=[],wav=Buffer.alloc(48);wav.write('RIFF');wav.write('WAVE',8);
  const {service,save}=fixture(t,async(url,options)=>{
    if(url.endsWith('/v1/speech')){submitted.push(JSON.parse(options.body));return Response.json({id:'fixture'});}
    return url.endsWith('/audio')?new Response(wav):Response.json({status:'success'});
  });
  save('voice',{apiKey:secret,emotionStrength:'gentle'});
  assert.equal((await service.preview({revision:service.snapshot().revision,text:'你好',emotion:'happy'})).emotion,'happy');
  assert.equal(submitted[0].emotion,'happy');assert.equal(submitted[0].emotionStrength,'gentle');
  await assert.rejects(service.preview({revision:service.snapshot().revision,text:'你好',emotion:'untrusted'}));assert.equal(submitted.length,1);
  save('voice',{emotionMode:'neutral'});await service.preview({revision:service.snapshot().revision,text:'你好',emotion:'angry'});
  assert.equal(submitted[1].emotion,undefined);
});
test('catalog describes Feiyu and local RVC without claiming WeChat delivery',t=>{
  const {service}=fixture(t),cards=service.catalog(config);assert.equal(cards.length,2);assert.ok(cards.every(card=>!card.ready));
  assert.ok(!JSON.stringify(cards).includes('火山'));assert.match(cards[1].description,/QQ 音乐/);assert.match(cards[1].description,/上传/);
});
test('voice check distinguishes service, credential and TTS readiness without generating or sending audio',async t=>{
  let status=200,capabilities={tts:[{voice:'feiyu',available:false}]};const calls=[];
  const {service,save}=fixture(t,async(url,options)=>{
    calls.push(url);assert.equal(options.redirect,'error');
    if(url.endsWith('/health')){assert.equal(options.headers,undefined);return Response.json({status:'ok',version:'0.2.0'});}
    assert.equal(options.headers.Authorization,'Bearer '+secret);
    return status===200?Response.json(capabilities):new Response(secret,{status});
  });
  const check=()=>service.checkVoice({revision:service.snapshot().revision});
  let result=await check();assert.equal(result.code,'LOCAL_KEY_UNAVAILABLE');assert.equal(calls.length,1);
  save('voice',{apiKey:secret});status=401;result=await check();assert.equal(result.code,'AUTH_FAILED');assert.ok(!JSON.stringify(result).includes(secret));
  status=200;result=await check();assert.equal(result.code,'TTS_NOT_CONFIGURED');
  capabilities={tts:[{voice:'feiyu',available:true,styles:['gentle']}]};assert.equal((await check()).code,'STYLE_NOT_CONFIGURED');
  save('voice',{style:'gentle'});result=await check();assert.equal(result.code,'TTS_CONFIGURED');
  assert.equal(result.nativeVoiceSend,false);assert.equal(result.sent,false);assert.equal(result.authenticated,true);
  assert.ok(calls.every(url=>url.endsWith('/health')||url.endsWith('/v1/capabilities')));
});
test('voice check does not trust malformed health, expose server errors, or accept stale settings',async t=>{
  let response=()=>new Response(secret,{status:503});
  const {service,save}=fixture(t,async()=>response());save('voice',{apiKey:secret});
  const body={revision:service.snapshot().revision};
  assert.equal((await service.checkVoice(body)).code,'SERVICE_UNAVAILABLE');
  response=()=>Response.json({status:'ok'});assert.equal((await service.checkVoice(body)).code,'INVALID_SERVICE');
  response=()=>new Response('a'.repeat(65537));const result=await service.checkVoice(body);assert.equal(result.code,'SERVICE_UNAVAILABLE');assert.ok(!JSON.stringify(result).includes(secret));
  save('voice',{style:'gentle'});await assert.rejects(service.checkVoice(body),error=>error.status===409);
});
test('console authenticates music search, uploads, cache access and local model settings',async t=>{
  const {root}=fixture(t);fs.mkdirSync(path.join(root,'config'));fs.copyFileSync(new URL('../config/wechatagent.example.json',import.meta.url),path.join(root,'config/wechatagent.example.json'));
  const app=createConsole({root,port:0,fetchImpl:async()=>Response.json({status:1,data:{lists:[]}})});const address=await app.start();t.after(()=>app.close());
  const base='http://127.0.0.1:'+address.port,{token}=await fetch(base+'/api/info').then(r=>r.json());
  for(const route of ['/status','/models'])assert.equal((await fetch(base+'/api/audio-capabilities/music'+route)).status,401);
  assert.equal((await fetch(base+'/api/audio-capabilities/voice/check',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  const request=(route,body)=>fetch(base+route,{method:body?'POST':'GET',headers:{'X-Console-Token':token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const status=await request('/api/audio-capabilities/music/status').then(r=>r.json());assert.equal(status.retentionDays,7);assert.equal(status.localCoverAvailable,false);
  const songs=await request('/api/audio-capabilities/music/search',{query:'测试'}).then(r=>r.json());assert.deepEqual(songs.songs,[]);
  assert.equal((await fetch(base+'/api/audio-capabilities/music/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'你会唱歌吗'})})).status,401);
  const ability=await request('/api/audio-capabilities/music/request',{message:'你会唱歌吗'}).then(r=>r.json());assert.equal(ability.state,'ability');
  assert.equal((await request('/api/audio-capabilities/music/request',{conversationKey:'wechat:private:123',title:'朋友的酒'})).status,403);
  const models=await request('/api/audio-capabilities/music/models').then(r=>r.json());assert.equal(models.models[0].id,'FeiyuVoice-RVC-v1');
  assert.equal((await request('/api/audio-capabilities/music/jobs',{songId:'local:../../outside',seconds:30})).status,503);
  const asset=await fetch(base+'/music-source.js');assert.equal(asset.status,200);assert.match(asset.headers.get('content-security-policy'),/media-src 'self' blob:/);
});
