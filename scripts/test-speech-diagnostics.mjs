import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {discoverModels,normalizeModels,modelsCandidates,inspectConfiguration,probeTranscription,sampleAudio,EXPECTED_SAMPLE} from '../optional-extensions/speech-recognition/lib/diagnostics.mjs';
import {createSpeechPluginConsole} from './speech-plugin-console.mjs';
import {configuration,updatePlugin,atomicJson,packageFiles} from '../packages/plugin-api/catalog.mjs';
import {PluginInstaller} from '../packages/plugin-api/installer.mjs';
import {packZip} from '../packages/plugin-api/zip.mjs';
import {createConsole} from './console-server.mjs';
import {speechDiagnosticsMarkup,speechModelField} from '../public/console/speech-settings.mjs';
import {writeVoiceAttempt} from '../packages/plugin-api/voice-status.mjs';

const source=path.resolve('optional-extensions/speech-recognition'),defaults=JSON.parse(fs.readFileSync(path.join(source,'plugin.json'))).settings;
const config=extra=>({...defaults,endpoint:'https://asr.example.test/v1/audio/transcriptions',model:'fixture-asr',apiKey:'fixture-secret-key',...extra});
const capability=async()=>({checked:true,decoder:true});
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'speech-diagnostics-'));t.after(()=>{assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
  atomicJson(path.join(root,'config/wechatagent.json'),{runtime:{python:'fixture-python'},wechat:{whitelist:{private:['123'],groups:[]}}});
  const installer=new PluginInstaller(root),preview=installer.inspect({name:'speech.zip',zip:packZip(packageFiles(source)).toString('base64')});installer.install(preview);installer.dispose();
  const save=settings=>updatePlugin(root,'speech-recognition',{revision:configuration(root).revision,enabled:false,permissions:[],chats:[],settings});save(config());
  return {root,save,body:(extra={})=>({revision:configuration(root).revision,settings:{...config(),...extra}})};
}

test('model discovery derives standard same-service paths and respects a fully custom list endpoint',()=>{
  assert.equal(modelsCandidates(config())[0].href,'https://asr.example.test/v1/models');
  assert.equal(modelsCandidates(config({endpoint:'https://gateway.example.test/prefix/chat/completions'}))[0].pathname,'/prefix/models');
  assert.equal(modelsCandidates(config({endpoint:'https://gateway.example.test/apps/proxy'}))[0].pathname,'/apps/proxy/models');
  assert.deepEqual(modelsCandidates(config({modelsEndpoint:'https://catalog.example.test/custom/list'})).map(url=>url.href),['https://catalog.example.test/custom/list']);
});

test('model lists handle custom JSON paths, deduplicate IDs, mark audio candidates and reject unsafe IDs',()=>{
  const models=normalizeModels({result:{items:[{id:'fixture-chat',input_modalities:['text']},{id:'custom-audio',input_modalities:['audio']},{id:'whisper-fixture'},{id:'custom-audio'},'manual-model',{id:'bad"id'},{id:'https://not-a-model.example'}]}},'result.items');
  assert.equal(models.length,4);assert.equal(models.find(item=>item.id==='custom-audio').audioDeclared,true);assert.equal(models.find(item=>item.id==='fixture-chat').audioDeclared,false);assert.equal(models.find(item=>item.id==='whisper-fixture').audioCandidate,true);
  assert.throws(()=>normalizeModels({models:'not an array or model map'}),/VOICE_MODELS_RESPONSE_INVALID/);
});

test('discovery carries configured auth, never follows redirects and treats missing model APIs as optional',async()=>{
  let calls=0;const result=await discoverModels(config({authHeader:'X-API-Key',authPrefix:''}),{fetchImpl:async(_url,options)=>{calls++;assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.headers.get('X-API-Key'),'fixture-secret-key');return Response.json({data:[{id:'fixture-asr'}]});}});
  assert.equal(result.ok,true);assert.equal(calls,1);
  const missing=await discoverModels(config(),{fetchImpl:async()=>new Response('',{status:404})});assert.equal(missing.code,'VOICE_MODELS_UNSUPPORTED');
  const denied=await discoverModels(config(),{fetchImpl:async()=>new Response('fixture-secret-key must never echo',{status:401})});assert.equal(denied.code,'VOICE_API_HTTP_401');assert(!JSON.stringify(denied).includes('fixture-secret-key'));
});

test('discovery has a total timeout, validates model-array shape and bounds responses',async()=>{
  const timed=await discoverModels(config({timeoutMs:30}),{fetchImpl:async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});assert.equal(timed.code,'VOICE_API_TIMEOUT');
  const huge=await discoverModels(config(),{fetchImpl:async()=>new Response('x'.repeat(513*1024))});assert.equal(huge.code,'VOICE_API_RESPONSE_TOO_LARGE');
});

test('configuration checks catch a model URL, missing JSON audio mapping and missing WAV conversion before upload',()=>{
  const wrong=inspectConfiguration(config({model:'https://example.test/model'}),{checked:true,decoder:false});assert.equal(wrong.configurationValid,false);assert.equal(wrong.checks[0].code,'VOICE_MODEL_IS_URL');assert.equal(wrong.decoderReady,false);
  const badTemplate=inspectConfiguration(config({requestMode:'json',jsonTemplate:'{"model":"{{model}}"}'}),{checked:true,decoder:true});assert.equal(badTemplate.configurationValid,false);assert.equal(badTemplate.checks[0].code,'VOICE_API_TEMPLATE_AUDIO_MISSING');
  assert.equal(inspectConfiguration(config({audioFormat:'silk'}),{checked:true,decoder:false}).decoderReady,true);
  assert.equal(inspectConfiguration(config({endpoint:'bad-url'}),{checked:true,decoder:true}).configurationValid,false);
});

test('realtime models remain visible but are not automatically selected as HTTP audio candidates',()=>{
  const models=normalizeModels({data:[{id:'fixture-asr-realtime',input_modalities:['audio']},{id:'fixture-asr-flash-message'},{id:'custom-asr',transport:'websocket'},{id:'fixture-asr-http',protocol:'https'}]});
  assert.equal(models.filter(model=>model.audioCandidate).length,1);assert.equal(models[0].id,'fixture-asr-http');
  assert(models.filter(model=>model.transportHint==='websocket').every(model=>!model.audioCandidate));
  const report=inspectConfiguration(config({model:'fixture-asr-flash-message'}),{checked:true,decoder:true});
  assert.equal(report.checks.find(item=>item.id==='model-transport').state,'warning');
  assert.equal(inspectConfiguration(config({model:'custom-asr'}),{checked:true,decoder:true},models).checks.find(item=>item.id==='model-transport').state,'warning');
  assert.equal(inspectConfiguration(config({endpoint:'https://asr.example.test/v1/chat/completions'})).checks.find(item=>item.id==='request-protocol').state,'warning');
});

test('a SILK-only API rejecting the bundled WAV is reported as inconclusive rather than verified',async()=>{
  const probe=await probeTranscription(config({audioFormat:'silk'}),{fetchImpl:async()=>new Response('',{status:415})});
  assert.equal(probe.verified,false);assert.equal(probe.inconclusive,true);assert.match(probe.message,/SILK/);
});

test('API test uses the bundled synthetic WAV and only verifies a matching transcript',async()=>{
  const audio=sampleAudio();assert.equal(Buffer.from(audio.b64,'base64').toString('ascii',0,4),'RIFF');assert(audio.durationSeconds>0&&audio.durationSeconds<5);
  const good=await probeTranscription(config(),{fetchImpl:async(_url,options)=>{assert.equal(options.method,'POST');assert.equal(options.body.get('file').name,'config-test.wav');return Response.json({text:'你好，这是'+EXPECTED_SAMPLE+'。'});}});assert.equal(good.verified,true);
  const unrelated=await probeTranscription(config(),{fetchImpl:async()=>Response.json({text:'我无法处理音频，请输入文字。'})});assert.equal(unrelated.ok,true);assert.equal(unrelated.verified,false);
  const empty=await probeTranscription(config(),{fetchImpl:async()=>Response.json({text:''})});assert.equal(empty.ok,false);
});

test('reading models never tests audio or executes an installed entry, including disabled plugins',async t=>{
  const f=fixture(t),marker=path.join(f.root,'entry-executed');fs.appendFileSync(path.join(f.root,'plugins/speech-recognition/index.mjs'),`\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'bad');`);
  let posts=0;const helper=createSpeechPluginConsole({root:f.root,readCapabilities:capability,fetchImpl:async(_url,options)=>{if(options.method==='POST')posts++;return Response.json({data:[{id:'fixture-asr'}]});}});t.after(()=>helper.close());
  const before=fs.readFileSync(path.join(f.root,'config/plugins.json'),'utf8'),result=await helper.run('models',{...f.body(),testAudio:true});assert.equal(result.models.ok,true);assert.equal(result.summary.ready,false);assert.equal(posts,0);assert.equal(fs.existsSync(marker),false);assert.equal(fs.readFileSync(path.join(f.root,'config/plugins.json'),'utf8'),before);
});

test('checks report actual readiness, preserve a saved blank-secret input and never echo credentials',async t=>{
  const f=fixture(t);let auth;
  const helper=createSpeechPluginConsole({root:f.root,readCapabilities:capability,fetchImpl:async(_url,options)=>{auth=options.headers.get('Authorization');return Response.json(options.method==='GET'?{data:[{id:'fixture-asr'}]}:{text:'你好，这是语音识别测试。'});}});t.after(()=>helper.close());
  const result=await helper.run('check',{...f.body({apiKey:'',headersJson:''}),testAudio:true});assert.equal(auth,'Bearer fixture-secret-key');assert.equal(result.summary.ready,true);assert.equal(helper.status().ready,true);assert(!JSON.stringify(result).includes('fixture-secret-key'));
  const repeat=await helper.run('models',f.body());assert.equal(repeat.summary.ready,true,'refreshing models must preserve a valid test for the same configuration');
});

test('missing conversion stays not-ready even when the remote WAV test works; unsupported lists allow manual models',async t=>{
  const f=fixture(t);const fetchImpl=async(_url,options)=>options.method==='GET'?new Response('',{status:404}):Response.json({text:'语音识别测试'});
  const missing=createSpeechPluginConsole({root:f.root,readCapabilities:async()=>({checked:true,decoder:false}),fetchImpl});t.after(()=>missing.close());const result=await missing.run('check',{...f.body(),testAudio:true});assert.equal(result.probe.verified,true);assert.equal(result.summary.ready,false);assert.equal(result.summary.label,'转换组件未就绪');
  const manual=createSpeechPluginConsole({root:f.root,readCapabilities:capability,fetchImpl});t.after(()=>manual.close());assert.equal((await manual.run('check',{...f.body(),testAudio:true})).summary.ready,true);
});

test('wrong model settings block the test call and invalid enabled saves, without altering current settings',async t=>{
  const f=fixture(t);let posts=0;const helper=createSpeechPluginConsole({root:f.root,readCapabilities:capability,fetchImpl:async(_url,options)=>{if(options.method==='POST')posts++;return Response.json({data:[]});}});t.after(()=>helper.close());
  const body=f.body({model:'https://wrong.example/model'}),before=configuration(f.root).revision;const result=await helper.run('check',{...body,testAudio:true});assert.equal(posts,0);assert.equal(result.summary.ready,false);await assert.rejects(()=>helper.validateForSave({...body,enabled:true}),/模型名填写了网址/);assert.equal(configuration(f.root).revision,before);
});

test('draft checks do not replace saved status; key or settings changes invalidate verified configuration',async t=>{
  const f=fixture(t),helper=createSpeechPluginConsole({root:f.root,readCapabilities:capability,fetchImpl:async(_url,options)=>Response.json(options.method==='GET'?{data:[{id:'fixture-asr'}]}:{text:'语音识别测试'})});t.after(()=>helper.close());
  const draft={apiKey:'new-fixture-key'};assert.equal((await helper.run('check',{...f.body(draft),testAudio:true})).summary.ready,true);assert.equal(helper.status().ready,false);
  f.save(config(draft));helper.onSaved();assert.equal(helper.status().ready,true);
  f.save(config({apiKey:'different-fixture-key'}));assert.equal(helper.status().ready,false);
});

test('model cache is credential-specific and a concurrent configuration save prevents stale results',async t=>{
  const f=fixture(t);let calls=0,change=false;const helper=createSpeechPluginConsole({root:f.root,readCapabilities:capability,fetchImpl:async()=>{calls++;if(change)f.save(config({model:'changed-model'}));return Response.json({data:[{id:'fixture-asr'}]});}});t.after(()=>helper.close());
  await helper.run('models',f.body());await helper.run('models',f.body());assert.equal(calls,1);change=true;const stale=await helper.run('models',f.body({apiKey:'other-fixture-key'}));assert.equal(stale.stale,true);assert.equal(helper.status().ready,false);
});

test('manual model refresh bypasses cache and a new authorization failure removes old green readiness',async t=>{
  const f=fixture(t);let denied=false,calls=0;const helper=createSpeechPluginConsole({root:f.root,readCapabilities:capability,fetchImpl:async(_url,options)=>{calls++;return denied?new Response('',{status:401}):Response.json(options.method==='GET'?{data:[{id:'fixture-asr'}]}:{text:'语音识别测试'});}});t.after(()=>helper.close());
  const first=await helper.run('check',{...f.body(),testAudio:true});assert.equal(first.summary.ready,true);assert(first.probe.testedAt>0);
  denied=true;const count=calls,refreshed=await helper.run('models',{...f.body(),refreshModels:true});assert(calls>count);assert.equal(refreshed.models.code,'VOICE_API_HTTP_401');assert.equal(refreshed.summary.ready,false);assert.equal(helper.status().ready,false);
});

test('a later real voice failure overrides an older synthetic check, while changing settings retires the old failure',async t=>{
  const f=fixture(t),helper=createSpeechPluginConsole({root:f.root,now:()=>1000,readCapabilities:capability,fetchImpl:async(_url,options)=>Response.json(options.method==='GET'?{data:[{id:'fixture-asr'}]}:{text:'语音识别测试'})});t.after(()=>helper.close());
  assert.equal((await helper.run('check',{...f.body(),testAudio:true})).summary.ready,true);
  const generation=configuration(f.root).config.plugins['speech-recognition'].generation;
  writeVoiceAttempt(f.root,{ok:false,code:'VOICE_API_HTTP_403',stage:'api'},generation);
  assert.equal(helper.status().ready,false);assert.equal(helper.status().label,'语音已收到，转写失败');
  const report=await helper.run('models',f.body());assert.equal(report.lastAttempt.code,'VOICE_API_HTTP_403');assert.equal(report.summary.ready,false);
  f.save(config({model:'new-fixture-model'}));assert.equal(helper.status().label,'配置待检测');
});

test('the UI distinguishes model discovery, verification and the test-audio action with escaped output',()=>{
  const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const markup=speechDiagnosticsMarkup({label:'<unsafe>',message:'test'},esc);assert(!markup.includes('<unsafe>'));assert(markup.includes('aria-live="polite"'));assert(markup.includes('不使用聊天语音'));assert(markup.includes('type="button"'));
  const model=speechModelField({attr:'id="model-input" data-plugin-setting="model"',field:'model-input',label:'模型',value:'',esc});assert(model.includes('API 返回的模型'));assert(model.includes('for="model-input"'));assert(model.includes('id="model-input"'));
});

test('console diagnostics require its token, operate on unsaved values without enabling and expose a status badge',async t=>{
  const f=fixture(t),full=JSON.parse(fs.readFileSync('config/wechatagent.example.json'));full.wechat.whitelist={private:['123'],groups:[]};atomicJson(path.join(f.root,'config/wechatagent.json'),full);fs.mkdirSync(path.join(f.root,'roles'));fs.writeFileSync(path.join(f.root,'roles',full.persona.default+'.md'),'Fixture persona');let calls=0;
  const app=createConsole({root:f.root,port:0,speechCapabilities:capability,fetchImpl:async(_url,options)=>{calls++;return Response.json(options.method==='POST'?{text:'语音识别测试'}:{data:[{id:'fixture-asr'}]});}});t.after(()=>app.close());const addr=await app.start(),base='http://127.0.0.1:'+addr.port,{token}=await fetch(base+'/api/info').then(r=>r.json());
  const url=base+'/api/plugins/speech-recognition/models',body=f.body();assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).status,401);assert.equal(calls,0);
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','X-Console-Token':token},body:JSON.stringify(body)});assert.equal(response.status,200);assert.equal((await response.json()).models.models[0].id,'fixture-asr');assert.equal(configuration(f.root).config.plugins['speech-recognition'].enabled,false);
  assert.equal((await fetch(base+'/speech-settings.mjs')).status,200);
});
