import test from 'node:test';
import assert from 'node:assert/strict';
import {createAudioCapabilityUI} from '../public/console/audio-capabilities.js';

test('default voice setup hides manual credentials and saves the managed service without a user key',async t=>{
  const previous=globalThis.document;t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
  const fields=new Map(),events=new Map(),requests=[];
  const element=id=>{
    if(!fields.has(id))fields.set(id,{value:'',checked:false,disabled:false,hidden:false,addEventListener(name,handler){events.set(id+':'+name,handler);}});
    return fields.get(id);
  };
  const form={querySelector:selector=>element(selector.slice(1)),querySelectorAll:()=>[],addEventListener(name,handler){events.set('form:'+name,handler);}};
  globalThis.document={querySelector:()=>form};let markup='';
  const settings={enabled:false,chats:[],provider:'feiyu',credentialMode:'managed',hasApiKey:true,endpoint:'http://127.0.0.1:9880',style:'cute',mode:'ai-choice',emotionMode:'auto',emotionStrength:'natural'};
  const ui=createAudioCapabilityUI({api:async(route,body)=>{
    if(body){requests.push({route,body});return {revision:'saved',settings:{voice:settings}};}
    return {revision:'fixture',settings:{voice:settings}};
  },modal(_title,html){
    markup=html;
    for(const [id,value] of Object.entries({'audio-connection':'managed','audio-endpoint':'https://other.example','audio-api-key':'unsubmitted-custom-secret','audio-style':'cute','audio-mode':'ai-choice','audio-emotion-mode':'auto','audio-emotion-strength':'natural'}))element(id).value=value;
  },closeModal(){},escapeHtml:String,state:{config:{wechat:{whitelist:{private:[],groups:[]}}},names:new Map()},renderPage:async()=>{},toast(){}});
  await ui.dialog({name:'语音回复',audioKind:'voice'});
  assert.match(markup,/本机肥鱼服务（自动连接）/);assert(!markup.includes('肥鱼服务 API Key'));
  assert.equal(element('audio-custom-service').hidden,true);assert.equal(element('audio-api-key').disabled,true);
  await events.get('form:submit')({preventDefault(){}});
  assert.equal(requests[0].body.settings.endpoint,'http://127.0.0.1:9880');assert.equal(requests[0].body.settings.apiKey,'');assert.equal(requests[0].body.clearApiKey,true);
  assert(!JSON.stringify(requests).includes('unsubmitted-custom-secret'));
  element('audio-connection').value='custom';events.get('audio-connection:change')();
  assert.equal(element('audio-custom-service').hidden,false);assert.equal(element('audio-api-key').disabled,false);
});
