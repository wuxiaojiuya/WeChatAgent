import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../public/console/console.js',import.meta.url),'utf8');
const start=source.indexOf('function addChats('),end=source.indexOf('\nfunction reconnectGroup(',start);
assert(start>=0&&end>start);
const declaration=source.slice(start,end);
const contacts=[{id:'123',name:'最新好友',wechatId:'wxid_friend',administratorEligible:true,ambiguous:false}];
const result={contacts};
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const flush=()=>new Promise(resolve=>setImmediate(resolve));

function fixture(responses,{kind='private'}={}){
  const nodes=new Map(),calls=[],timers=new Map();let timerId=0,markup='',lifecycle={};
  const node=selector=>{if(!nodes.has(selector))nodes.set(selector,{isConnected:true,disabled:false,hidden:true,value:'',textContent:'',innerHTML:'',events:new Map(),addEventListener(event,fn){this.events.set(event,fn);}});return nodes.get(selector);};
  const state={chatKind:kind,draft:{wechat:{whitelist:{private:[],groups:[]},assistant:{administrators:[]}}},names:new Map()};
  const context={state,Map,Set,AbortController,Date,Number,String,escapeHtml,icon:()=>'',empty:(title,description)=>title+' '+description,
    $:node,
    modal(_title,html,options){markup=html;lifecycle=options;},closeModal(){lifecycle.onClose?.();for(const n of nodes.values())n.isConnected=false;},
    renderPage(){},updateDraftUI(){},toast(){},
    setTimeout(fn,delay){const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);},
    async api(route,_body,_retry,options){calls.push({url:new URL(route,'http://fixture'),...options});const response=responses.shift();if(response instanceof Error)throw response;return typeof response==='function'?response():response;},
  };
  vm.runInNewContext(declaration+'\naddChats();',context);
  const event=async(selector,type='click',extra={})=>{node(selector).events.get(type)({preventDefault(){},...extra});await flush();};
  return{nodes,node,state,calls,timers,event,close:context.closeModal,get markup(){return markup;}};
}

test('opening every friend dialog immediately queries latest Hook contacts without cache or polling',async()=>{
  for(let i=0;i<2;i++){
    const f=fixture([result]);const before=JSON.stringify(f.state.draft);
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].cache,'no-store');
    assert.equal(f.calls[0].url.searchParams.get('kind'),'private');
    assert.equal(f.calls[0].url.searchParams.get('includeIdentity'),'1');
    assert(!f.calls[0].url.searchParams.has('sync'));
    assert.equal(f.node('#contact-results').innerHTML,'');assert(f.node('#contact-sync').disabled);
    await flush();
    assert.match(f.markup,/刷新好友列表/);assert.match(f.markup,/每次打开和搜索/);
    assert.match(f.node('#contact-results').innerHTML,/最新好友/);
    assert.match(f.node('#contact-sync-status').textContent,/获取最新列表/);
    assert(!f.node('#contact-sync').disabled);assert.equal(f.timers.size,0);
    assert.equal(JSON.stringify(f.state.draft),before);
  }
});

test('search and refresh make new API requests and retain explicit picks without changing allowed chats',async()=>{
  const f=fixture([result,result,result]);await flush();const before=JSON.stringify(f.state.draft);
  const input={checked:true,value:'123',dataset:{name:'最新好友'},matches:selector=>selector==='[data-contact]',closest:()=>({querySelector:()=>null})};
  await f.event('#contact-results','change',{target:input});
  f.node('#contact-keyword').value='最新搜索';await f.event('#contact-search-form','submit');
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].url.searchParams.get('keyword'),'最新搜索');
  assert.match(f.node('#contact-results').innerHTML,/data-name="最新好友"\s+checked/);
  await f.event('#contact-sync');assert.equal(f.calls.length,3);
  assert(f.calls.every(call=>call.cache==='no-store'));assert.equal(f.timers.size,0);
  assert.equal(JSON.stringify(f.state.draft),before);
});

test('failed fresh request clears previous results rather than falling back to an old list',async()=>{
  let reject;const pending=new Promise((_resolve,fail)=>{reject=fail;});
  const f=fixture([result,()=>pending]);await flush();assert.match(f.node('#contact-results').innerHTML,/最新好友/);
  await f.event('#contact-sync');assert.equal(f.node('#contact-results').innerHTML,'');
  assert.match(f.node('#contact-sync-status').textContent,/正在通过微信 Hook/);
  reject(new Error('receiver unavailable'));await flush();
  assert.doesNotMatch(f.node('#contact-results').innerHTML,/最新好友/);
  assert.match(f.node('#contact-results').innerHTML,/最新列表查询失败/);
  assert.match(f.node('#contact-error').textContent,/receiver unavailable/);
  assert.match(f.node('#contact-sync-status').textContent,/未取得最新列表/);
  assert(!f.node('#contact-sync').disabled);assert.equal(f.timers.size,0);
});

test('closing while initial direct query is pending aborts it and cannot mutate dismissed dialog',async()=>{
  let resolve;const pending=new Promise(done=>{resolve=done;});
  const f=fixture([()=>pending]);assert.equal(f.calls.length,1);
  f.close();resolve(result);await flush();
  assert.equal(f.timers.size,0);assert.equal(f.node('#contact-results').innerHTML,'');assert(f.calls[0].signal.aborted);
  await f.event('#contact-sync');assert.equal(f.calls.length,1);
});

test('opening and refreshing group discovery also query current Hook API directly',async()=>{
  const f=fixture([result,result],{kind:'groups'});await flush();
  assert.match(f.markup,/刷新群聊列表/);assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].url.searchParams.get('kind'),'groups');
  await f.event('#contact-sync');assert.equal(f.calls.length,2);
  assert(f.calls.every(call=>call.cache==='no-store'&&!call.url.searchParams.has('sync')));
  assert.equal(f.timers.size,0);
});

test('browser contact request deadline covers the live Hook query and forwards no-store',async()=>{
  const apiStart=source.indexOf('async function api('),apiEnd=source.indexOf('\nlet modalLifecycle',apiStart);
  const calls=[],timeouts=[];
  const context={state:{token:'fixture'},AbortSignal:{timeout(ms){timeouts.push(ms);return {timeoutMs:ms};}},
    async fetch(route,options){calls.push({route,options});return {ok:true,status:200,json:async()=>result};}};
  vm.runInNewContext(source.slice(apiStart,apiEnd)+'\nglobalThis.run=api;',context);
  await context.run('/api/contacts?kind=private',undefined,true,{cache:'no-store'});
  assert.equal(timeouts[0],130000);assert.equal(calls[0].options.cache,'no-store');
});
