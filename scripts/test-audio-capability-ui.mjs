import test from 'node:test';
import assert from 'node:assert/strict';
import {createAudioCapabilityUI} from '../public/console/audio-capabilities.js';
import {musicMarkup} from '../public/console/music-source.js';
import {audioDefaults} from './audio-capabilities.mjs';

test('voice setup exposes one shared voice selection and upload without service or advanced fields',async t=>{
  const previous=globalThis.document;t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
  const fields=new Map(),events=new Map(),requests=[];
  const element=id=>{
    if(!fields.has(id))fields.set(id,{value:'',checked:false,disabled:false,hidden:false,pause(){},append(){},addEventListener(name,handler){events.set(id+':'+name,handler);}});
    return fields.get(id);
  };
  const form={querySelector:selector=>element(selector.slice(1)),querySelectorAll:()=>[],addEventListener(name,handler){events.set('form:'+name,handler);}};
  globalThis.document={querySelector:()=>form,createElement:()=>({addEventListener(){}})};let markup='';
  const settings={enabled:false,chats:[],provider:'feiyu',credentialMode:'custom',hasApiKey:true,endpoint:'https://old.example',style:'gentle',voiceId:'selected-voice',mode:'ai-choice',emotionMode:'auto',emotionStrength:'natural'};
  const ui=createAudioCapabilityUI({api:async(route,body)=>{
    if(route.endsWith('/voice/models'))return {voices:[{id:'selected-voice',name:'我的音色',rvcModelId:'model',ttsReady:false}]};
    if(body){requests.push({route,body});return {revision:'saved',settings:{voice:settings}};}
    return {revision:'fixture',settings:{voice:settings}};
  },modal(_title,html){markup=html;for(const [id,value]of Object.entries({'audio-voice':'selected-voice','audio-mode':'ai-choice','audio-emotion-mode':'auto','audio-emotion-strength':'natural'}))element(id).value=value;
  },closeModal(){},escapeHtml:String,state:{config:{wechat:{whitelist:{private:[],groups:[]}}},names:new Map()},renderPage:async()=>{},toast(){}});
  await ui.dialog({name:'语音回复',audioKind:'voice'});
  assert.match(markup,/上传音色/);assert.match(markup,/我的音色/);assert(!/自定义服务|高级|audio-endpoint|audio-api-key|audio-connection|audio-style/.test(markup));
  assert(!/id="voice-reference|id="voice-reference-text/.test(markup));assert.match(markup,/先合成语音，再换成所选音色/);
  await events.get('form:submit')({preventDefault(){}});
  assert.equal(requests[0].body.settings.voiceId,'selected-voice');assert.equal(requests[0].body.settings.style,'gentle');
  assert.equal(requests[0].body.settings.endpoint,'http://127.0.0.1:9880');assert.equal(requests[0].body.settings.apiKey,'');assert.equal(requests[0].body.clearApiKey,true);
  assert(!/music-model-upload|music-model-file/.test(musicMarkup({settings:{musicSource:'kugou'}})));
});

test('check and preview show actionable failures next to their buttons for a missing RVC model',async t=>{
  const previous=globalThis.document;t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
  const fields=new Map(),events=new Map(),requests=[];
  const element=id=>{
    if(!fields.has(id))fields.set(id,{value:'',checked:false,disabled:false,hidden:false,pause(){},append(){},addEventListener(name,handler){events.set(id+':'+name,handler);}});
    return fields.get(id);
  };
  const form={querySelector:selector=>element(selector.slice(1)),querySelectorAll:()=>[],reportValidity:()=>true,addEventListener(){}};
  globalThis.document={querySelector:()=>form,createElement:()=>({addEventListener(){}})};
  let mode='legacy',modelId='';
  const settings=audioDefaults();settings.voice.voiceId='rvc-only';
  const ui=createAudioCapabilityUI({api:async(route,body)=>{
    if(route.endsWith('/voice/models'))return {voices:[{id:'rvc-only',name:'鹿柚',ttsReady:false,get rvcModelId(){return modelId;}}]};
    if(body){requests.push(route);if(mode==='failure')throw Error('本机 TTS 环境不可用，请修复。');if(route.endsWith('/check'))return {code:'RVC_MODEL_REQUIRED',message:'请补充 RVC 模型。'};}
    if(route.endsWith('/preview'))return {audio:Buffer.from('RIFFfixture').toString('base64'),mime:'audio/wav',runtimeRvc:true};
    return {revision:'fixture',settings};
  },modal(){for(const [id,value]of Object.entries({'audio-voice':'rvc-only','audio-mode':'ai-choice','audio-emotion-mode':'auto','audio-emotion-strength':'natural'}))element(id).value=value;},closeModal(){},escapeHtml:String,state:{config:{wechat:{whitelist:{private:[],groups:[]}}},names:new Map()},renderPage:async()=>{},toast(){}});
  await ui.dialog({name:'语音回复',audioKind:'voice'});
  assert.match(element('audio-voice-readiness').textContent,/RVC 模型/);
  assert.equal(element('audio-complete-voice').hidden,false);
  await events.get('audio-check-button:click')();
  assert.match(element('audio-check-status').textContent,/RVC 模型/);
  await events.get('audio-preview-button:click')();
  assert.match(element('audio-preview-status').textContent,/设置已保存.*RVC 模型/);
  assert(!requests.some(route=>route.endsWith('/preview')));
  mode='failure';
  await events.get('audio-check-button:click')();assert.match(element('audio-check-status').textContent,/本机 TTS 环境不可用/);
  await events.get('audio-preview-button:click')();assert.match(element('audio-preview-status').textContent,/本机 TTS 环境不可用/);
  assert.equal(element('audio-check-button').disabled,false);assert.equal(element('audio-preview-button').disabled,false);
  mode='success';modelId='rvc-only';await events.get('audio-voice:change')();
  assert.equal(element('audio-complete-voice').hidden,true);
  await events.get('audio-preview-button:click')();
  assert.match(element('audio-preview-status').textContent,/试听已生成/);assert.equal(element('audio-preview-player').hidden,false);
  URL.revokeObjectURL(element('audio-preview-player').src);
});
