import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createConsole} from './console-server.mjs';import {projectRoot} from './project-config.mjs';
import {createPersonaCategoryUI} from '../public/console/persona-categories.js';

async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wca-persona-categories-'));
  for(const dir of ['config','roles','state'])fs.mkdirSync(path.join(root,dir));
  const config=JSON.parse(fs.readFileSync(path.join(projectRoot,'config/wechatagent.example.json'),'utf8'));
  fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify(config));
  fs.writeFileSync(path.join(root,'roles',config.persona.default+'.md'),'# Default fixture');fs.writeFileSync(path.join(root,'roles/Other.md'),'# Other fixture');
  const servers=[];
  t.after(async()=>{for(const app of servers){app.server.closeAllConnections();if(app.server.listening)await new Promise(resolve=>app.server.close(resolve));}assert(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  async function start(){const app=createConsole({root,port:0,runner:async()=>0});servers.push(app);const address=await app.start(),base='http://127.0.0.1:'+address.port,info=await fetch(base+'/api/info').then(response=>response.json());
    const request=async(route,body,token=info.token)=>{const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'X-Console-Token':token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};};return{app,base,request};}
  const first=await start();return{root,config,start,...first};
}
const changed=(f,body,revision)=>f.request('/api/persona-categories',{...body,revision});

test('persona classification keeps the complete console module graph reachable',async t=>{
  const f=await fixture(t),pending=['/'],seen=new Set();
  while(pending.length){
    const route=pending.shift();if(seen.has(route))continue;seen.add(route);
    const response=await fetch(f.base+route);assert.equal(response.status,200,'Missing dependency: '+route);
    const source=await response.text();
    if(/\.(?:m?js)$/.test(route))assert.match(response.headers.get('content-type'),/javascript/);
    const refs=route==='/'?[...source.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(item=>item[1]):/\.(?:m?js)$/.test(route)?[...source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"](\.[^'"]+)['"]/g)].map(item=>item[1]):[];
    for(const ref of refs){if(ref.startsWith('#'))continue;const url=new URL(ref,f.base+route);if(url.origin===f.base)pending.push(url.pathname);}
  }
  assert(seen.has('/persona-categories.js'));assert(seen.has('/persona-categories.css'));
  assert.equal((await fetch(f.base+'/unregistered-private-file.js')).status,404);
});

test('classifying existing and bound personas persists independently without editing content, bindings or restart flags',async t=>{
  const f=await fixture(t),configFile=path.join(f.root,'config/wechatagent.json'),before=fs.readFileSync(configFile),rolesBefore=(await f.request('/api/roles')).body;
  const empty=(await f.request('/api/persona-categories')).body;assert.deepEqual(empty.assignments,{});assert.deepEqual(rolesBefore.categories,empty);assert(!fs.existsSync(path.join(f.root,'state/persona-categories.json')));
  assert.equal((await changed(f,{action:'create',title:'日常'},empty.revision)).status,200);
  const data=(await f.request('/api/persona-categories')).body,id=data.categories[0].id;
  const assigned=await changed(f,{action:'assign',name:f.config.persona.default,categoryId:id},data.revision);assert.equal(assigned.status,200);assert.equal(assigned.body.assignments[f.config.persona.default],id);
  const renamed=await changed(f,{action:'rename',categoryId:id,title:'日常聊天'},assigned.body.revision);assert.equal(renamed.status,200);assert.equal(renamed.body.categories[0].title,'日常聊天');
  const restarted=await f.start();assert.deepEqual((await restarted.request('/api/persona-categories')).body,renamed.body);
  assert.deepEqual(fs.readFileSync(configFile),before);assert.deepEqual((await f.request('/api/roles')).body.roles,rolesBefore.roles);assert(!fs.existsSync(path.join(f.root,'state/console-state.json')));
  for(const asset of ['/persona-categories.js','/persona-categories.css']){const response=await fetch(f.base+asset);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),asset.endsWith('.js')?/javascript/:/css/);}
});

test('classification mutations require token and current revision, validate names and targets, and do not overwrite newer state',async t=>{
  const f=await fixture(t),initial=(await f.request('/api/persona-categories')).body;
  assert.equal((await f.request('/api/persona-categories',{action:'create',title:'Unauthorized',revision:initial.revision},'wrong')).status,401);
  for(const title of ['', '全部','未分类','x'.repeat(61),'bad\nname'])assert.equal((await changed(f,{action:'create',title},initial.revision)).status,400);
  const first=(await changed(f,{action:'create',title:'Daily'},initial.revision)).body,id=first.categories[0].id;
  assert.equal((await changed(f,{action:'create',title:'stale'},initial.revision)).status,409);
  for(const title of ['daily',' Ｄａｉｌｙ '])assert.equal((await changed(f,{action:'create',categoryId:id,title},first.revision)).status,409);
  assert.equal((await changed(f,{action:'assign',name:'../Other',categoryId:id},first.revision)).status,400);
  assert.equal((await changed(f,{action:'assign',name:'Missing',categoryId:id},first.revision)).status,404);
  assert.equal((await changed(f,{action:'assign',name:'Other',categoryId:'missing'},first.revision)).status,409);
  assert.equal((await changed(f,{action:'unsupported'},first.revision)).status,400);
  assert.deepEqual((await f.request('/api/persona-categories')).body,first);
  const assigned=(await changed(f,{action:'assign',name:'OTHER',categoryId:id},first.revision)).body;assert.equal(assigned.assignments.Other,id);assert.equal(assigned.assignments.OTHER,undefined);
  const cleared=(await changed(f,{action:'assign',name:'Other',categoryId:''},assigned.revision)).body;assert.deepEqual(cleared.assignments,{});
});

test('deleting a populated category requires confirmation and preserves all persona files and configuration',async t=>{
  const f=await fixture(t),before=(await f.request('/api/roles')).body.roles;
  let data=(await f.request('/api/persona-categories')).body;data=(await changed(f,{action:'create',title:'角色'},data.revision)).body;const id=data.categories[0].id;
  data=(await changed(f,{action:'assign',name:'Other',categoryId:id},data.revision)).body;
  assert.equal((await changed(f,{action:'delete',categoryId:id},data.revision)).status,409);
  const result=await changed(f,{action:'delete',categoryId:id,confirmed:true},data.revision);assert.equal(result.status,200);assert.deepEqual(result.body.categories,[]);assert.deepEqual(result.body.assignments,{});assert.deepEqual((await f.request('/api/roles')).body.roles,before);
});

test('deleting and recreating a persona clears its old category without changing other assignments',async t=>{
  const f=await fixture(t);let data=(await f.request('/api/persona-categories')).body;data=(await changed(f,{action:'create',title:'角色'},data.revision)).body;const id=data.categories[0].id;
  for(const name of ['Other',f.config.persona.default])data=(await changed(f,{action:'assign',name,categoryId:id},data.revision)).body;
  const role=(await f.request('/api/roles')).body.roles.find(item=>item.name==='Other');assert.equal((await f.request('/api/roles/delete',{name:'Other',revision:role.revision,confirmed:true})).status,200);
  const recreated=await f.request('/api/roles',{name:'Other',content:'# Recreated'});assert.equal(recreated.status,200);assert.deepEqual(recreated.body.categories.assignments,{[f.config.persona.default]:id});
});

test('damaged category metadata is preserved and does not block loading or editing persona cards',async t=>{
  const f=await fixture(t),file=path.join(f.root,'state/persona-categories.json'),raw='{invalid metadata';fs.writeFileSync(file,raw);
  assert.equal((await f.request('/api/persona-categories')).status,409);
  const roles=await f.request('/api/roles');assert.equal(roles.status,200);assert.equal(roles.body.roles.length,2);assert.match(roles.body.categories.error,/格式有误/);
  const role=roles.body.roles.find(item=>item.name==='Other');assert.equal((await f.request('/api/roles',{name:role.name,revision:role.revision,content:'# Still editable'})).status,200);
  assert.equal((await changed(f,{action:'create',title:'Do not overwrite'},'bad')).status,409);assert.equal(fs.readFileSync(file,'utf8'),raw);
});

function uiFixture(handler){
  const elements=new Map(),get=selector=>{if(!elements.has(selector))elements.set(selector,{value:'',disabled:false,textContent:'',focus(){},addEventListener(name,callback){this[name]=callback;}});return elements.get(selector);};
  const id='a'.repeat(32),state={roles:[{name:'Default'},{name:'Other'}],selectedRole:'Other',draft:{persona:{default:'Default',chats:{}}},roleDrafts:new Map([['Other',{content:'unsaved'}]])};
  let dialog,closed=0,rendered=0;const requests=[],toasts=[];
  const ui=createPersonaCategoryUI({state,query:get,api:async(route,body)=>{requests.push({route,body});return handler?.(route,body);},modal:(title,html,options)=>{dialog={title,html,options};},closeModal:()=>{closed++;},renderPage:async()=>{rendered++;},toast:message=>toasts.push(message),escapeHtml:value=>String(value).replaceAll('<','&lt;').replaceAll('"','&quot;')});
  ui.setData({revision:'original',categories:[{id,title:'Daily'}],assignments:{Default:id}});
  const button=dataset=>({dataset,hasAttribute:name=>Object.hasOwn(dataset,name.replace(/^data-/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase()))});
  return{ui,id,state,get,requests,toasts,button,get dialog(){return dialog;},get closed(){return closed;},get rendered(){return rendered;}};
}

test('category filtering and moving preserve unsaved persona content and unrelated configuration',async()=>{
  let finish;const gate=new Promise(resolve=>{finish=resolve;}),f=uiFixture(()=>gate),draft=f.state.roleDrafts.get('Other'),config=JSON.stringify(f.state.draft);
  f.ui.click(f.button({personaCategoryFilter:f.id}));assert.deepEqual(f.ui.visible().map(role=>role.name),['Default']);
  f.ui.click(f.button({personaCategoryFilter:''}));assert.deepEqual(f.ui.visible().map(role=>role.name),['Other']);
  f.ui.click(f.button({personaCategoryMove:'Other'}));f.get('#persona-category-target').value=f.id;
  const submit=f.get('#persona-category-form').submit({preventDefault(){}});assert.equal(f.dialog.options.beforeClose(),false);assert.equal(f.get('#persona-category-submit').disabled,true);
  assert.equal(f.requests[0].body.revision,'original');finish({revision:'saved',categories:[{id:f.id,title:'Daily'}],assignments:{Default:f.id,Other:f.id}});await submit;
  assert.equal(f.closed,1);assert.equal(f.state.roleDrafts.get('Other'),draft);assert.equal(JSON.stringify(f.state.draft),config);assert.equal(f.ui.visible().length,2);
});

test('classification conflicts keep the form and drafts, refresh the revision, and allow a deliberate retry',async()=>{
  let calls=0;const f=uiFixture(async(_route,body)=>{calls++;if(calls===1)throw Object.assign(Error('分类已变更'),{status:409});return {revision:body?'saved':'fresh',categories:[{id:'a'.repeat(32),title:'Daily'}],assignments:{}};});
  f.ui.click(f.button({personaCategoryNew:''}));f.get('#persona-category-title').value='New';await f.get('#persona-category-form').submit({preventDefault(){}});
  assert.equal(f.closed,0);assert.equal(f.get('#persona-category-error').textContent,'分类已变更');assert(f.state.roleDrafts.has('Other'));assert.equal(f.get('#persona-category-submit').disabled,false);
  await f.get('#persona-category-form').submit({preventDefault(){}});assert.equal(f.requests.at(-1).body.revision,'fresh');assert.equal(f.closed,1);
});
