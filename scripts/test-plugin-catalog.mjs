import test from 'node:test';
import assert from 'node:assert/strict';
import {trackToolOrigins,decorateToolCatalog,localizedText,upsertToolCatalogPatch} from '../packages/dsh-social-bridge-plugin/plugin-catalog.mjs';
import {dshCatalog} from '../packages/dsh-social-bridge-plugin/dsh-access.mjs';
import {catalogGroups,renderCatalogOptions} from '../public/console/dsh-catalog.mjs';

function fixture(bundles=[]) {
  const accessors=new Map(),global=new Map(),contexts=new Map();let managerReads=0,removals=0;
  class Registry {
    constructor(){this.entries=global;}
    register(definition){const entries=this.entries;if(entries.has(definition.name))throw Error('already registered');entries.set(definition.name,definition);return ()=>{if(entries.get(definition.name)===definition){entries.delete(definition.name);removals++;}};}
    get(name,scope){return contexts.get(scope)?.get(name)??global.get(name);}
    schemas(scope){return [...new Map([...global,...contexts.get(scope)??[]]).values()].map(({name,description=''})=>({name,description}));}
  }
  const tools=new Registry(),root={};root.root=root;
  root.reflect={accessor(name,value){if(accessors.has(name))throw Error('accessor exists');accessors.set(name,value);return ()=>accessors.delete(name);}};
  root.get=name=>name==='tools'?tools:name==='pluginManager'?{listBundles(){managerReads++;return bundles;}}:undefined;
  const register=(definition,{entryId='entry-a',moduleName='plugin-a',scope}={})=>{
    const receiver=Object.create(tools);receiver.ctx={fiber:{entry:{id:entryId,options:{name:moduleName}}},root};
    if(scope){if(!contexts.has(scope))contexts.set(scope,new Map());receiver.entries=contexts.get(scope);}
    const method=accessors.get('tools.register')?.get.call(receiver.ctx,receiver)??tools.register.bind(receiver);
    return method(definition);
  };
  return {ctx:root,tools,accessors,register,get managerReads(){return managerReads;},get removals(){return removals;}};
}
const bundle=(name,id,moduleName,title=name)=>({name,installed:true,enabled:true,version:'1.2.3',meta:{title:{'zh-cn':title,en:name}},rows:[{entryId:id,moduleName}]});
const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

test('real plugin names come from DSH metadata rather than tool-name prefixes',async()=>{
  const f=fixture([bundle('dsh-note','entry-a','note-runtime','知识笔记'),bundle('sidebar-ui','entry-ui','sidebar-runtime','增强侧边栏')]);
  const dispose=trackToolOrigins(f.ctx),tool={name:'unrelated_lookup',description:'lookup'};const undo=f.register(tool,{moduleName:'note-runtime'});
  assert.equal(f.tools.get(tool.name),tool);const catalog=await decorateToolCatalog(f.ctx,f.tools,undefined,f.tools.schemas());
  assert.equal(catalog.metadataAvailable,true);assert.equal(catalog.tools[0].name,'unrelated_lookup');assert.equal(catalog.tools[0].sourceId,'plugin:dsh-note');
  assert.equal(catalog.plugins.find(p=>p.id==='plugin:dsh-note').name,'知识笔记');assert.deepEqual(catalog.plugins.find(p=>p.id==='plugin:sidebar-ui').toolNames,[]);
  undo();assert.equal(f.removals,1);assert.equal(f.tools.get(tool.name),undefined);dispose();assert.equal(f.accessors.size,0);
});
test('scoped shadows and failed duplicate registrations cannot steal another tool source',async()=>{
  const f=fixture([bundle('custom-read','entry-shadow','custom-provider','自己的读取插件')]),dispose=trackToolOrigins(f.ctx),scope={};
  f.register({name:'read'},{entryId:'builtin',moduleName:'@deepseek-ai/dsh-tool-fs'});
  assert.throws(()=>f.register({name:'read'},{entryId:'other',moduleName:'pretender'}),/already registered/);
  assert.equal((await decorateToolCatalog(f.ctx,f.tools,undefined,f.tools.schemas())).tools[0].sourceId,'dsh-builtin');
  const remove=f.register({name:'read'},{entryId:'entry-shadow',moduleName:'custom-provider',scope});
  assert.equal((await decorateToolCatalog(f.ctx,f.tools,scope,f.tools.schemas(scope))).tools[0].sourceId,'plugin:custom-read');
  remove();assert.equal((await decorateToolCatalog(f.ctx,f.tools,scope,f.tools.schemas(scope))).tools[0].sourceId,'dsh-builtin');dispose();
});
test('unknown or ambiguous sources remain explicit and optional plugin metadata failure preserves tools',async()=>{
  const f=fixture([bundle('one','a','shared'),bundle('two','b','shared')]);f.tools.register({name:'one__search'});const dispose=trackToolOrigins(f.ctx);f.register({name:'lookup'},{moduleName:'shared',entryId:'unknown'});
  let result=await decorateToolCatalog(f.ctx,f.tools,undefined,f.tools.schemas());assert(result.tools.every(tool=>tool.sourceId==='unverified'));
  const original=f.ctx.get;f.ctx.get=name=>name==='pluginManager'?{listBundles(){throw Error('offline');}}:original(name);
  result=await decorateToolCatalog(f.ctx,f.tools,undefined,f.tools.schemas());assert.equal(result.metadataAvailable,false);assert.equal(result.tools.length,2);assert(result.plugins.some(p=>p.name==='shared'));dispose();
});
test('source subscriptions clean up once and never replace another plugin accessor',()=>{
  const f=fixture(),a=trackToolOrigins(f.ctx),b=trackToolOrigins(f.ctx);a();a();assert.equal(f.accessors.size,1);b();b();assert.equal(f.accessors.size,0);
  const foreign={get:()=>()=>{}};f.accessors.set('tools.register',foreign);const stop=trackToolOrigins(f.ctx);assert.equal(f.accessors.get('tools.register'),foreign);stop();assert.equal(f.accessors.get('tools.register'),foreign);
});
test('model skill instruction discovery skips plugin display metadata and preserves raw tool IDs',async()=>{
  const f=fixture([bundle('unused','a','unused')]);const original=f.ctx.get;f.ctx.get=name=>name==='skills'?{list:async()=>[{name:'sample',description:'instructions'}]}:original(name);
  f.tools.register({name:'lookup'});const old=await dshCatalog(f.ctx,{includePlugins:false});assert.equal(f.managerReads,0);assert.equal(old.apiVersion,1);assert.deepEqual(old.tools,[{name:'lookup',description:''}]);
  const display=await dshCatalog(f.ctx);assert.equal(f.managerReads,1);assert.equal(display.apiVersion,2);assert.equal(display.tools[0].name,'lookup');
});
test('a slow optional metadata service is bounded by cancellation',async()=>{
  const f=fixture(),base=f.ctx.get;f.ctx.get=name=>name==='pluginManager'?{listBundles:()=>new Promise(()=>{})}:base(name);
  const controller=new AbortController(),pending=decorateToolCatalog(f.ctx,f.tools,undefined,[{name:'lookup',description:''}],{signal:controller.signal});controller.abort();
  const result=await pending;assert.equal(result.tools[0].name,'lookup');assert.equal(result.metadataAvailable,false);
});
test('groups retain exact selection IDs, distinguish equal plugin titles, and preserve unloaded assignments',()=>{
  const catalog={tools:[{name:'alpha__find',description:'find',sourceId:'plugin:a'},{name:'read',description:'read',sourceId:'dsh-builtin'},{name:'beta',sourceId:'plugin:b'}],plugins:[{id:'plugin:a',name:'同名插件',packageName:'a',kind:'plugin'},{id:'plugin:b',name:'同名插件',packageName:'b',kind:'plugin'},{id:'dsh-builtin',name:'DSH 内置能力',kind:'builtin'}]};
  const selected={skills:[],tools:['alpha__find','gone']},view=catalogGroups(catalog,selected,selected);
  assert.equal(view.groups.length,4);assert.equal(view.groups.filter(g=>g.name==='同名插件').length,2);assert.deepEqual(selected.tools,['alpha__find','gone']);
  const html=renderCatalogOptions(catalog,selected,selected,esc);assert(html.includes('value="alpha__find" checked'));assert(html.includes('value="gone" checked'));assert(!html.includes('value="同名插件"'));assert(html.includes('已分配但未加载的工具'));
});
test('unavailable and legacy catalogs stay honest and plugin metadata is escaped',()=>{
  const assigned={skills:['memo'],tools:['retained']};let html=renderCatalogOptions(null,assigned,assigned,esc);assert(html.includes('value="retained" checked'));assert(html.includes('value="memo" checked'));
  html=renderCatalogOptions({tools:[{name:'lookup'}]},assigned,assigned,esc);assert(html.includes('来源未确认的工具'));
  html=renderCatalogOptions({skills:[],tools:[{name:'lookup',sourceId:'evil'}],plugins:[{id:'evil',name:'<script>bad</script>',packageName:'bad',description:'" onclick="bad',kind:'plugin'}]},assigned,assigned,esc);
  assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));assert(html.includes('&quot; onclick=&quot;bad'));assert.equal(localizedText({'zh-cn':'中文',en:'English'}),'中文');
});
test('generated catalog startup row is idempotent and only a display service dependency is added',()=>{
  const root='E:/fixture',base='- insert:\n    - id: existing\n      name: example\n';const first=upsertToolCatalogPatch(base,root);
  assert.equal(upsertToolCatalogPatch(first,root),first);assert(first.includes('"id":"wechat-tool-catalog"'));assert(first.includes('id: existing'));
});
test('the real DSH base bundle joins native capabilities instead of appearing as a third-party plugin',()=>{
  const catalog={tools:[{name:'read',sourceId:'plugin:base'},{name:'write',sourceId:'plugin:base'},{name:'edit',sourceId:'plugin:base'},{name:'glob',sourceId:'plugin:base'},{name:'grep',sourceId:'plugin:base'},{name:'schedule_list',sourceId:'dsh-builtin'},{name:'create_skill',sourceId:'plugin:skills'}],plugins:[{id:'plugin:base',kind:'plugin',name:'@deepseek-ai/dsh-base',packageName:'@deepseek-ai/dsh-base'},{id:'dsh-builtin',kind:'builtin',name:'DSH 内置能力'},{id:'plugin:skills',kind:'plugin',name:'Skills Manager',packageName:'dsh-skills-manager'}]};
  const selected={skills:[],tools:['read']},view=catalogGroups(catalog,selected,selected);assert.equal(view.groups.length,2);assert.equal(view.groups[0].name,'Skills Manager');assert.equal(view.groups[1].tools.length,6);assert.equal(view.informational.length,0);const html=renderCatalogOptions(catalog,selected,selected,esc);assert(html.includes('data-capability-fold'));assert(!html.includes('<legend>@deepseek-ai/dsh-base'));assert(html.includes('value="read" checked'));
});
