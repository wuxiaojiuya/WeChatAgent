import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {PluginInstaller} from '../packages/plugin-api/installer.mjs';
import {PluginRuntime,bindAgentTools} from '../packages/plugin-api/index.mjs';
import {configuration,updatePlugin,archivePlugin,pluginCatalog,inspectPackage,packageFiles,atomicJson} from '../packages/plugin-api/catalog.mjs';
import {packZip,unpackZip} from '../packages/plugin-api/zip.mjs';
import {createConsole} from './console-server.mjs';
import {createExtensionUI} from '../public/console/extensions.js';

const project=path.resolve(import.meta.dirname,'..'),chat='wechat:private:123',other='wechat:group:456';
const round=(key=chat,actorId='wxid_fixture')=>({conversationKey:key,conversationName:'Fixture',actorId,sessionId:'fixture',toolCalls:0,replies:[]});
const schema={type:'object',properties:{},additionalProperties:false};
const runtimes=new Map();
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-plugin-v2-'));
  atomicJson(path.join(root,'config/wechatagent.json'),{wechat:{whitelist:{private:['123'],groups:['456']}}});
  const installer=new PluginInstaller(root);
  t.after(async()=>{for(const r of runtimes.get(root)??[])await r.dispose();runtimes.delete(root);installer.dispose();assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
  return {root,installer};
}
function bundle(id='fixture',code='export function setup(api){api.registerTool({id:"run",description:"fixture",parameters:{type:"object",properties:{}},execute:()=>({content:"ok"})});}',extra={}){
  return packZip([{name:'plugin.json',data:JSON.stringify({id,name:id,description:'Fixture plugin',version:'1.0.0',apiVersion:2,host:'wechatagent',...extra})},{name:'index.mjs',data:code}]);
}
function install(f,zip){const preview=f.installer.inspect({name:'fixture.zip',zip:zip.toString('base64')});f.installer.install({ticket:preview.ticket,revision:preview.revision});return preview;}
function enable(root,id,permissions=[],chats=[chat],settings={}){return updatePlugin(root,id,{revision:configuration(root).revision,enabled:true,permissions,chats,settings});}
async function runtime(t,root,options={}){const r=new PluginRuntime({root,accountScope:'fixture-account',...options});runtimes.set(root,[...(runtimes.get(root)??[]),r]);t.after(()=>r.dispose());await r.sync();return r;}

test('standard ZIP and one enclosing folder install without executing code; enable is explicit',async t=>{
  const f=fixture(t),marker=path.join(f.root,'executed.txt');
  const zip=bundle('fixture',`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'executed');export function setup(api){api.registerTool({id:'run',description:'fixture',parameters:${JSON.stringify(schema)},execute:()=>({content:'ok'})});}`);
  const files=unpackZip(zip);assert.equal(files.length,2);
  const wrapped=packZip(files.map(item=>({...item,name:'fixture-v1/'+item.name})));install(f,wrapped);
  assert.equal(fs.existsSync(marker),false);assert.equal(configuration(f.root).config.plugins.fixture.enabled,false);
  const r=await runtime(t,f.root);assert.equal(r.toolDefinitions(chat).length,0);assert.equal(fs.existsSync(marker),false);
  enable(f.root,'fixture');await r.sync();assert.equal(fs.readFileSync(marker,'utf8'),'executed');
  assert.equal((await r.execute('fixture__run',{},round())).content,'ok');
});

test('ZIP rejects traversal, ADS, reserved paths, duplicate names, symlinks, malformed data and compression bombs',()=>{
  for(const name of ['../escape.txt','/absolute','C:/file','\\\\host\\file','ok/../../file','con.txt','a:b','a./file','node_modules/a.js'])assert.throws(()=>unpackZip(packZip([{name,data:'x'}])));
  assert.throws(()=>unpackZip(packZip([{name:'plugin.json',data:'a'},{name:'PLUGIN.JSON',data:'b'}])),/重名/);
  assert.throws(()=>unpackZip(packZip([{name:'plugin.json',data:'{}'},{name:'a',data:'x'},{name:'a/b',data:'x'}])),/目录同名/);
  const symlink=bundle(),end=symlink.length-22,central=symlink.readUInt32LE(end+16);symlink.writeUInt32LE((0xa1ff<<16)>>>0,central+38);assert.throws(()=>unpackZip(symlink),/链接/);
  const broken=bundle();broken[32]^=0xff;assert.throws(()=>unpackZip(broken));
  assert.throws(()=>unpackZip(packZip([{name:'bomb',data:Buffer.alloc(1024*1024)}])),/过大|压缩/);
  assert.throws(()=>unpackZip(Buffer.from('not a zip')));
});

test('package manifests reject DSH/v1 packages, unknown fields, missing entry and unsupported permissions',t=>{
  const f=fixture(t);
  for(const extra of [{apiVersion:1},{host:'dsh'},{permissions:['shell']},{entry:'../outside.js'}])assert.throws(()=>f.installer.inspect({name:'bad.zip',zip:bundle('bad',undefined,extra).toString('base64')}));
  assert.throws(()=>f.installer.inspect({name:'bad.zip',zip:packZip([{name:'plugin.json',data:'{}'}]).toString('base64')}));
  assert.deepEqual(fs.readdirSync(path.join(f.root,'state/plugin-install-staging')),[]);
});

test('updates require confirmation and keep settings/data; uninstall archives code and stale revisions are rejected',async t=>{
  const f=fixture(t),extra={permissions:['storage'],settings:{limit:2},configSchema:{limit:{type:'integer',minimum:1,maximum:5}}};
  install(f,bundle('fixture',undefined,extra));enable(f.root,'fixture',['storage'],[chat],{limit:4});const r=await runtime(t,f.root);
  const data=path.join(f.root,'state/plugins/fixture/data.json');atomicJson(data,{note:'keep'});
  const preview=f.installer.inspect({name:'update.zip',zip:bundle('fixture',undefined,{...extra,version:'1.1.0'}).toString('base64')});
  assert.equal(preview.installedVersion,'1.0.0');assert.throws(()=>f.installer.install({ticket:preview.ticket,revision:preview.revision}),/确认更新/);
  f.installer.install({ticket:preview.ticket,revision:preview.revision,replace:true});
  const saved=configuration(f.root);assert.equal(saved.config.plugins.fixture.enabled,false);assert.equal(saved.config.plugins.fixture.settings.limit,4);assert.deepEqual(saved.config.plugins.fixture.permissions,[]);assert.equal(JSON.parse(fs.readFileSync(data)).note,'keep');
  await assert.rejects(r.execute('fixture__run',{},round()),/UNAVAILABLE/);await r.sync();enable(f.root,'fixture',['storage'],[chat],{limit:4});await r.sync();
  assert.throws(()=>archivePlugin(f.root,'fixture','outdated'),error=>error.status===409);
  archivePlugin(f.root,'fixture',configuration(f.root).revision);assert.equal(fs.existsSync(path.join(f.root,'plugins/fixture')),false);assert.equal(fs.readdirSync(path.join(f.root,'state/plugin-archives')).length,2);assert(fs.existsSync(data));
});

test('model tools are namespaced and current chat/account/actor storage remains isolated',async t=>{
  const f=fixture(t),code=`export function setup(api){api.registerTool({id:'run',description:'storage',parameters:{type:'object',properties:{value:{type:'string'}},additionalProperties:false},async execute(ctx,args){if(args.value){await ctx.storage.set('note',args.value);await ctx.actorStorage.set('note',args.value);}return {content:JSON.stringify({chat:await ctx.storage.get('note'),actor:await ctx.actorStorage.get('note')})};}});}`;
  install(f,bundle('fixture',code,{permissions:['storage']}));enable(f.root,'fixture',['storage'],null);
  const r=await runtime(t,f.root);assert.equal(r.toolDefinitions(chat)[0].name,'fixture__run');
  assert.match((await r.execute('fixture__run',{value:'only-this-chat'},round())).content,/only-this-chat/);
  assert.deepEqual(JSON.parse((await r.execute('fixture__run',{},round(other))).content),{chat:null,actor:null});
  const otherActor=JSON.parse((await r.execute('fixture__run',{},round(chat,'wxid_other'))).content);assert.equal(otherActor.actor,null);assert.equal(otherActor.chat,'only-this-chat');
  const second=await runtime(t,f.root,{accountScope:'second-account'});assert.deepEqual(JSON.parse((await second.execute('fixture__run',{},round())).content),{chat:null,actor:null});
  const registered=new Map(),agent={tools:{register(def){registered.set(def.name,def);return()=>registered.delete(def.name);}}};const dispose=bindAgentTools(agent,r,chat,()=>round());assert(registered.has('fixture__run'));dispose();assert.equal(registered.size,0);
  assert.throws(()=>enable(f.root,'fixture',[],[chat]),/能力/);
  updatePlugin(f.root,'fixture',{revision:configuration(f.root).revision,enabled:false,permissions:[],chats:[],settings:{}});
  await assert.rejects(r.execute('fixture__run',{},round()),/UNAVAILABLE/);
});

test('host history cannot choose another chat and readonly hooks cannot write or send',async t=>{
  const f=fixture(t),code=`export function setup(api){api.registerTool({id:'run',description:'history',parameters:{type:'object',properties:{},additionalProperties:false},async execute(ctx){return {content:JSON.stringify(await ctx.history.recent({limit:2}))};}});}export const hooks={'before-context':async ctx=>{try{await ctx.storage.set('bad','bad');}catch(error){return {context:error.message};}},'after-response':async()=>({text:'RESPOND: changed'})};`;
  install(f,bundle('fixture',code,{permissions:['history_read','storage']}));enable(f.root,'fixture',['history_read','storage']);
  const r=await runtime(t,f.root,{historyFor:(key,limit)=>{assert.equal(key,chat);assert.equal(limit,2);return [{text:'allowed',sender_wxid:'wxid_fixture'}];}});
  assert.match((await r.execute('fixture__run',{},round())).content,/allowed/);
  assert.equal((await r.hooks('before-context',{message:'hello'},round()))[0].context,'PLUGIN_HOOK_READ_ONLY');
  assert.equal((await r.hooks('after-response',{text:'SILENT'},round()))[0].text,undefined);
});

test('tool infinite loops and startup loops are terminated while healthy plugin and later text paths remain usable',async t=>{
  const f=fixture(t);
  install(f,bundle('bad',`export function setup(api){api.registerTool({id:'run',description:'bad',parameters:${JSON.stringify(schema)},execute(){while(true){}}});}`));
  install(f,bundle('good'));enable(f.root,'bad');enable(f.root,'good');const r=await runtime(t,f.root,{toolTimeoutMs:80});
  const started=Date.now();await assert.rejects(r.execute('bad__run',{},round()),/TIMEOUT/);assert(Date.now()-started<1500);
  assert.equal((await r.execute('good__run',{},round())).content,'ok');assert.equal(r.list().find(item=>item.id==='bad').active,false);
  install(f,bundle('startup','while(true){}'));enable(f.root,'startup');await r.sync();assert.equal(r.list().find(item=>item.id==='startup').reason,'PLUGIN_LOAD_TIMEOUT');
  assert.equal((await r.execute('good__run',{},round())).content,'ok');
});

test('cancelled tools cannot deliver queued replies or continue host writes and parent credentials are not inherited',async t=>{
  const f=fixture(t);process.env.WECHAT_PLUGIN_TEST_SECRET='must-not-be-inherited';t.after(()=>delete process.env.WECHAT_PLUGIN_TEST_SECRET);
  const code=`export function setup(api){api.registerTool({id:'run',description:'fixture',parameters:${JSON.stringify(schema)},async execute(ctx){if(process.env.WECHAT_PLUGIN_TEST_SECRET)throw Error('SECRET_LEAK');await ctx.reply('pending');await new Promise(()=>{});}});}`;
  install(f,bundle('fixture',code,{permissions:['reply']}));enable(f.root,'fixture',['reply']);const r=await runtime(t,f.root,{toolTimeoutMs:60}),turn=round();
  await assert.rejects(r.execute('fixture__run',{},turn),/TIMEOUT/);assert.deepEqual(turn.replies,[]);
});

test('fetch is bounded, honors network opt-out, and rejects local network destinations',async t=>{
  const f=fixture(t),code=`export function setup(api){api.registerTool({id:'run',description:'fetch',parameters:{type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false},async execute(ctx,args){const response=await ctx.fetch(args.url);return {content:await response.text()};}});}`;
  install(f,bundle('fixture',code,{permissions:['web_fetch']}));enable(f.root,'fixture',['web_fetch']);const r=await runtime(t,f.root);
  await assert.rejects(r.execute('fixture__run',{url:'http://127.0.0.1/private'},round()),/内网|本机/);
  await assert.rejects(r.execute('fixture__run',{url:'https://example.com'}, {...round(),networkOptOut:true}),/NETWORK_DISABLED/);
});

test('a blocked hook is terminated, missing chat scopes never expose tools and saved secrets remain masked',async t=>{
  const f=fixture(t),code=`export function setup(api){api.registerTool({id:'run',description:'ok',parameters:${JSON.stringify(schema)},execute:()=>({content:'ok'})});}export const hooks={'before-context':()=>{while(true){}}};`;
  install(f,bundle('fixture',code,{settings:{key:'fixture-secret'},configSchema:{key:{type:'string',secret:true}}}));enable(f.root,'fixture',[],[chat],{key:'fixture-secret'});
  const r=await runtime(t,f.root);assert.deepEqual(r.toolDefinitions(undefined),[]);assert.deepEqual(r.toolDefinitions('wechat:private:999'),[]);
  const started=Date.now();assert.deepEqual(await r.hooks('before-context',{message:'hello'},round()),[]);assert(Date.now()-started<1800);assert.equal(r.list()[0].active,false);
  const catalog=pluginCatalog(f.root,r.list());assert.equal(catalog.plugins[0].settings.key,'');assert(!JSON.stringify(catalog).includes('fixture-secret'));
  enable(f.root,'fixture',[],[chat],{key:''});assert.equal(configuration(f.root).config.plugins.fixture.settings.key,'fixture-secret');
});

test('cancelled previews expire without installing and the manifest cannot change after inspection',t=>{
  const f=fixture(t);const first=f.installer.inspect({name:'fixture.zip',zip:bundle().toString('base64')});f.installer.cancel(first.ticket);
  assert.throws(()=>f.installer.install({ticket:first.ticket,revision:first.revision}),/过期/);
  const second=f.installer.inspect({name:'fixture.zip',zip:bundle().toString('base64')});fs.appendFileSync(path.join(f.installer.tickets.get(second.ticket).folder,'index.mjs'),'\n// changed after preview');
  assert.throws(()=>f.installer.install({ticket:second.ticket,revision:second.revision}),/发生变化/);
  assert(!fs.existsSync(path.join(f.root,'plugins/fixture')));
});

test('a DSH registration collision rolls back only that plugin and leaves other plugin tools usable',async t=>{
  const f=fixture(t),code=`export function setup(api){for(const id of ['first','second'])api.registerTool({id,description:'fixture',parameters:${JSON.stringify(schema)},execute:()=>({content:'ok'})});}`;
  install(f,bundle('conflict',code));install(f,bundle('healthy'));enable(f.root,'conflict');enable(f.root,'healthy');
  const r=await runtime(t,f.root),registered=new Map();
  const agent={tools:{register(def){if(def.name==='conflict__second')throw Error('already registered');registered.set(def.name,def);return()=>registered.delete(def.name);}}};
  const dispose=bindAgentTools(agent,r,chat,()=>round());
  assert.deepEqual([...registered.keys()],['healthy__run']);assert.equal(r.list().find(item=>item.id==='conflict').reason,'PLUGIN_TOOL_REGISTRATION_CONFLICT');
  assert.equal((await registered.get('healthy__run').execute({})).content,'ok');dispose();assert.equal(registered.size,0);
});

test('console ZIP installation protects authentication, keeps built-ins, serves docs/example and never auto-enables',async t=>{
  const f=fixture(t),app=createConsole({root:f.root,port:0,fetchImpl:async()=>{throw Error('offline');}});const address=await app.start();t.after(()=>app.close());
  const base='http://127.0.0.1:'+address.port,info=await fetch(base+'/api/info').then(r=>r.json());
  const rpc=(route,body,token=info.token)=>fetch(base+route,{method:body?'POST':'GET',headers:{'X-Console-Token':token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await rpc('/api/plugins',undefined,'bad')).status,401);
  const preview=await rpc('/api/plugins/inspect',{name:'fixture.zip',zip:bundle().toString('base64')}).then(r=>r.json());
  assert(preview.ticket);assert.equal((await rpc('/api/plugins/install',{ticket:preview.ticket,revision:preview.revision})).status,200);
  const catalog=await rpc('/api/extensions').then(r=>r.json());assert.equal(catalog.canImport,false);assert.equal(catalog.canInstallZip,true);assert(catalog.extensions.every(item=>item.management==='project'));assert.equal(catalog.plugins[0].enabled,false);
  for(const asset of ['/plugins.js','/plugins.css','/plugin-api.md','/plugin-example.zip'])assert.equal((await fetch(base+asset)).status,200,asset);
  const sample=Buffer.from(await fetch(base+'/plugin-example.zip').then(r=>r.arrayBuffer()));assert(unpackZip(sample).some(file=>file.name==='index.mjs'));
  fs.writeFileSync(path.join(f.root,'config/plugins.json'),'{"version":1,"plugins":{"broken":"fixture-secret');
  const broken=await rpc('/api/extensions').then(r=>r.json());assert(broken.extensions.length>0);assert.deepEqual(broken.plugins,[]);assert.match(broken.pluginError,/原文件已保留/);assert(!JSON.stringify(broken).includes('fixture-secret'));
});

test('capability page shows ZIP installation, developer documentation and escaped plugin cards without changing settings',async t=>{
  const previous=globalThis.document;globalThis.document={addEventListener(){}};t.after(()=>{globalThis.document=previous;});
  const config={wechat:{whitelist:{private:['123'],groups:[]}}},before=JSON.stringify(config);
  const item={id:'fixture',name:'<plugin>',description:'<unsafe>',author:'Fixture',version:'1.0.0',management:'wechatagent',enabled:false,chats:[],statusLabel:'已关闭',statusTone:'muted',reason:'尚未启用'};
  const ui=createExtensionUI({api:async route=>route==='/api/extensions'?{extensions:[],plugins:[item],canInstallZip:true}:route==='/api/meme-library-status'?{}:{skills:[],tools:[]},modal(){},closeModal(){},confirmAction(){},state:{config,names:new Map()},renderPage(){},toast(){},icon:()=>'',escapeHtml:value=>String(value??'').replaceAll('<','&lt;').replaceAll('>','&gt;')});
  const html=await ui.page();assert.match(html,/data-plugin-install/);assert.match(html,/plugin-api.md/);assert.match(html,/plugin-example.zip/);assert.match(html,/data-plugin-card="fixture"/);assert(html.includes('&lt;plugin&gt;'));assert.equal(JSON.stringify(config),before);
});
