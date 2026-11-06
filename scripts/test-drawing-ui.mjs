import test from 'node:test';
import assert from 'node:assert/strict';
import {createDrawingCapabilityUI} from '../public/console/drawing-capability.js';

const id='11111111-1111-4111-8111-111111111111';
function fixture(t,{generate,query,fetchImage}={}){
  const previous={document:globalThis.document,fetch:globalThis.fetch,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout},fields=new Map(),events=new Map(),timers=new Map(),calls=[],imageCalls=[];let lifecycle,markup='',counter=0;
  t.after(()=>{lifecycle?.onClose();Object.assign(globalThis,previous);});
  const element=id=>{if(!fields.has(id))fields.set(id,{value:'',checked:false,hidden:false,disabled:false,readOnly:false,textContent:'',addEventListener(name,handler){events.set(id+':'+name,handler);}});return fields.get(id);};
  const form={querySelector:selector=>element(selector.slice(1)),querySelectorAll:selector=>selector.includes('drawing-chat')?[]:[...fields.values()],reportValidity:()=>true,addEventListener(name,handler){events.set('form:'+name,handler);}};
  globalThis.document={querySelector:()=>form};globalThis.setTimeout=(fn,ms)=>{const key=++counter;timers.set(key,{fn,ms});return key;};globalThis.clearTimeout=key=>timers.delete(key);
  const settings={enabled:true,endpoint:'https://api.example.com/v1',apiKeyConfigured:true,model:'gpt-image-2',size:'1024x1024',quality:'auto',chats:[]},state={root:'fixture-project',token:'fixture-token',config:{wechat:{whitelist:{private:[],groups:[]}}},names:new Map()};
  const running=()=>({id,state:'running',stage:'正在生成图片',previewOnly:true}),ui=createDrawingCapabilityUI({state,api:async(route,body,retry,options)=>{
    calls.push({route,body,retry,options});if(route.endsWith('/save'))return {revision:'saved',settings};if(route.endsWith('/generate'))return generate?generate({route,body,calls}):{job:running()};if(route.includes('/jobs/'))return query?query({route,body,calls}):{job:running()};return {revision:'saved',settings};
  },modal(_title,html,options){markup=html;lifecycle=options;fields.clear();events.clear();for(const name of ['drawing-enabled','drawing-endpoint','drawing-key','drawing-model','drawing-size','drawing-quality','drawing-clear-key','drawing-prompt','drawing-check','drawing-preview','drawing-resume','drawing-error','drawing-progress','drawing-image','drawing-download','drawing-check-status'])element(name);
    for(const [name,value]of Object.entries({'drawing-endpoint':settings.endpoint,'drawing-model':settings.model,'drawing-size':settings.size,'drawing-quality':settings.quality,'drawing-prompt':'画一只橘猫。'}))element(name).value=value;
  },closeModal:()=>lifecycle.onClose(),escapeHtml:String,renderPage:async()=>{},toast(){}});
  globalThis.fetch=async(url,options)=>{imageCalls.push({url,options});return fetchImage?fetchImage(url,options,state):new Response(Buffer.from('PNGfixture'),{headers:{'content-type':'image/png'}});};
  return {ui,fields,events,timers,calls,imageCalls,state,running,get markup(){return markup;},close:()=>lifecycle.onClose(),click:id=>events.get(id+':click')(),async flush(){for(let n=0;n<10;n++)await new Promise(resolve=>setImmediate(resolve));}};
}

test('a failed progress read keeps generation locked, permits a query retry and survives closing the dialog',async t=>{
  const f=fixture(t,{query:()=>{throw Error('temporary query failure');}});await f.ui.dialog();await f.click('drawing-preview');
  assert.equal(f.calls.filter(row=>row.route.endsWith('/generate')).length,1);assert.equal(f.fields.get('drawing-preview').disabled,true);assert.equal(f.fields.get('drawing-prompt').readOnly,true);
  const timer=[...f.timers.values()][0];await timer.fn();assert.match(f.fields.get('drawing-progress').textContent,/继续查询/);assert.equal(f.fields.get('drawing-preview').disabled,true);assert.equal(f.fields.get('drawing-resume').disabled,false);
  f.fields.get('drawing-prompt').value='changed prompt';await f.click('drawing-preview');assert.equal(f.calls.filter(row=>row.route.endsWith('/generate')).length,1);
  f.close();await f.ui.dialog();await f.flush();assert.equal(f.calls.filter(row=>row.route.endsWith('/generate')).length,1);assert(f.calls.at(-1).route.endsWith('/jobs/'+id));assert.match(f.markup,/关闭此窗口不会取消后台生成/);
});

test('a lost submission response reuses its operation id after reopening without saving settings or changing the prompt',async t=>{
  let attempts=0;const f=fixture(t,{generate:()=>{if(++attempts===1)throw Error('response lost');return {job:{id,state:'running',stage:'正在生成图片',previewOnly:true}};}});
  await f.ui.dialog();await f.click('drawing-preview');assert.equal(f.fields.get('drawing-preview').disabled,true);assert.equal(f.fields.get('drawing-resume').hidden,false);
  const first=f.calls.find(row=>row.route.endsWith('/generate')).body;f.close();await f.ui.dialog();await f.flush();
  const posts=f.calls.filter(row=>row.route.endsWith('/generate'));assert.equal(posts.length,2);assert.equal(posts[1].body.requestId,first.requestId);assert.equal(posts[1].body.prompt,first.prompt);assert.equal(posts[1].retry,false);assert.equal(f.calls.filter(row=>row.route.endsWith('/save')).length,1);
});

test('preview retrieval rejects foreign URLs without sending the console token and retains retry controls',async t=>{
  const f=fixture(t,{generate:()=>({job:{id,state:'success',stage:'已生成',previewOnly:true,previewUrl:'https://foreign.invalid/image.png'}})});await f.ui.dialog();await f.click('drawing-preview');
  assert.equal(f.imageCalls.length,0);assert.match(f.fields.get('drawing-error').textContent,/预览地址无效/);assert.equal(f.fields.get('drawing-resume').hidden,false);assert.equal(f.fields.get('drawing-preview').disabled,true);
});

test('a generated preview refreshes console authentication and retries the exact local image without generating again',async t=>{
  const f=fixture(t,{generate:()=>({job:{id,state:'success',stage:'已生成',previewOnly:true,previewUrl:'/api/drawing-capability/jobs/'+id+'/image'}}),fetchImage:(_url,_options,state)=>{
    if(f.imageCalls.length===1){state.token='fresh-token';return new Response('{}',{status:401,headers:{'content-type':'application/json'}});}return new Response(Buffer.from('PNGfixture'),{headers:{'content-type':'image/png'}});
  }});await f.ui.dialog();await f.click('drawing-preview');
  assert.equal(f.imageCalls.length,2);assert.equal(f.imageCalls[0].url,'/api/drawing-capability/jobs/'+id+'/image');assert.equal(f.imageCalls[1].options.headers['X-Console-Token'],'fresh-token');assert.equal(f.imageCalls[1].options.redirect,'error');
  assert.equal(f.fields.get('drawing-image').hidden,false);assert.equal(f.fields.get('drawing-download').hidden,false);assert.match(f.fields.get('drawing-progress').textContent,/仅在本机预览/);assert.equal(f.calls.filter(row=>row.route.endsWith('/generate')).length,1);
});
