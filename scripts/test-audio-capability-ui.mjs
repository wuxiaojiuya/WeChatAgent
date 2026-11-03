import test from 'node:test';
import assert from 'node:assert/strict';
import {createAudioCapabilityUI} from '../public/console/audio-capabilities.js';
import {musicMarkup} from '../public/console/music-source.js';

test('voice setup exposes one shared voice selection and upload without service or advanced fields',async t=>{
  const previous=globalThis.document;t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
  const fields=new Map(),events=new Map(),requests=[];
  const element=id=>{
    if(!fields.has(id))fields.set(id,{value:'',checked:false,disabled:false,hidden:false,append(){},addEventListener(name,handler){events.set(id+':'+name,handler);}});
    return fields.get(id);
  };
  const form={querySelector:selector=>element(selector.slice(1)),querySelectorAll:()=>[],addEventListener(name,handler){events.set('form:'+name,handler);}};
  globalThis.document={querySelector:()=>form,createElement:()=>({addEventListener(){}})};let markup='';
  const settings={enabled:false,chats:[],provider:'feiyu',credentialMode:'custom',hasApiKey:true,endpoint:'https://old.example',style:'gentle',voiceId:'selected-voice',mode:'ai-choice',emotionMode:'auto',emotionStrength:'natural'};
  const ui=createAudioCapabilityUI({api:async(route,body)=>{
    if(route.endsWith('/voice/models'))return {voices:[{id:'selected-voice',name:'我的音色',ttsReady:true}]};
    if(body){requests.push({route,body});return {revision:'saved',settings:{voice:settings}};}
    return {revision:'fixture',settings:{voice:settings}};
  },modal(_title,html){markup=html;for(const [id,value]of Object.entries({'audio-voice':'selected-voice','audio-mode':'ai-choice','audio-emotion-mode':'auto','audio-emotion-strength':'natural'}))element(id).value=value;
  },closeModal(){},escapeHtml:String,state:{config:{wechat:{whitelist:{private:[],groups:[]}}},names:new Map()},renderPage:async()=>{},toast(){}});
  await ui.dialog({name:'语音回复',audioKind:'voice'});
  assert.match(markup,/上传音色/);assert.match(markup,/我的音色/);assert(!/自定义服务|高级|audio-endpoint|audio-api-key|audio-connection|audio-style/.test(markup));
  await events.get('form:submit')({preventDefault(){}});
  assert.equal(requests[0].body.settings.voiceId,'selected-voice');assert.equal(requests[0].body.settings.style,'gentle');
  assert.equal(requests[0].body.settings.endpoint,'http://127.0.0.1:9880');assert.equal(requests[0].body.settings.apiKey,'');assert.equal(requests[0].body.clearApiKey,true);
  assert(!/music-model-upload|music-model-file/.test(musicMarkup({settings:{musicSource:'kugou'}})));
});
