import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {validateConfig,configureBundledHook,BUNDLED_SUPPLIER_HOOK} from './project-config.mjs';
import {validateConsoleConfig,createConsole} from './console-server.mjs';
import os from 'node:os';
import {hookComponentProblem} from './hook-component-check.mjs';

test('supplier profile rejects mixed versions and non-loopback or overlapping upstream addresses',()=>{
  const c=JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json',import.meta.url),'utf8'));
  Object.assign(c.hook,{backend:'supplier-http',expectedVersion:'4.1.8.27',...BUNDLED_SUPPLIER_HOOK});
  assert.doesNotThrow(()=>validateConfig(c));
  for(const mutate of [x=>x.hook.expectedVersion='4.1.10.27',x=>x.hook.upstreamUrl='http://example.com:19088',x=>x.hook.upstreamUrl=x.hook.baseUrl,x=>x.hook.voiceBaseUrl='http://127.0.0.1:30002',x=>x.hook.upstreamUrl='http://127.0.0.1:'+x.ports.receiver,x=>x.hook.sourceDirectory='D:/external-hook',x=>x.hook.baseUrl='http://127.0.0.1:31001']){
    const bad=structuredClone(c);mutate(bad);assert.throws(()=>validateConfig(bad));
  }
});
test('supplier single-account health checks the component without comparing login accounts',()=>{
  const health={integration:'WeChatAgent-supplier-v1',backend:'wechat-hook',provider:'supplier-http',version:'4.1.8.27',startupState:'ready',databaseAccounts:['wxid_self']};
  assert.equal(hookComponentProblem(health,'4.1.8.27'),'');
  assert.equal(hookComponentProblem({...health,integration:'WeChatAgent-1'},'4.1.8.27'),'REVIEWED_HOOK_BUILD_REQUIRED');
  assert.equal(hookComponentProblem(health,'4.1.8.27'),'');
  assert.equal(hookComponentProblem({...health,databaseAccounts:undefined},'4.1.8.27'),'');
  assert.equal(hookComponentProblem({...health,databaseAccounts:['old','other']},'4.1.8.27'),'');
  assert.equal(hookComponentProblem({...health,startupState:'waiting'},'4.1.8.27'),'HOOK_INITIALIZATION_PENDING');
  assert.equal(hookComponentProblem({...health,version:'4.1.10.27'},'4.1.8.27'),'HOOK_VERSION_MISMATCH');
});
test('connection page opens bundled Hook and routes logged-in users to overview without a manual bind step',()=>{
  const source=fs.readFileSync(new URL('../public/console/console.js',import.meta.url),'utf8');
  const extract=(name,next)=>source.slice(source.indexOf('function '+name+'('),source.indexOf('\nfunction '+next+'(',source.indexOf('function '+name+'(')));
  const state={config:{hook:{backend:'supplier-http',expectedVersion:'4.1.8.27'}},connection:{prepared:false,myWxid:'',backend:'supplier-http'}};
  const context={state,escapeHtml:String,icon:()=>'',header:(title,description,right='')=>'<h2>'+title+'</h2><p>'+description+'</p>'+right,field:(label,key)=>'<label data-key="'+key+'">'+label+'</label>',pluginPathField:()=>''};
  for(const prepared of [false,true]){
    Object.assign(state.connection,{prepared,ownWxid:'wxid_should_not_be_shown_as_a_binding'});
    const html=vm.runInNewContext(extract('hookConnectionCard','paintConnectionSetup')+'\n'+extract('connectionsPage','toolsPage')+'\nconnectionsPage()',context);
    assert.match(html,/4\.1\.8\.27/);assert.match(html,/组件已内置/);assert.match(html,/自动加载/);
    assert.doesNotMatch(html,/data-key="hook\.(sourceDirectory|upstreamUrl|baseUrl|voiceBaseUrl)"/);
    assert.doesNotMatch(html,/id="reader-db-path"|id="reader-key"|id="detect-reader"|id="scan-reader"/);
    assert.doesNotMatch(html,/data-action="reader-connect"|数据库|已绑定|当前绑定|wxid_should_not_be_shown_as_a_binding/);
    assert.match(html,/data-action="wechat-open"/);assert.match(html,/href="#overview">前往概览启动助手/);
  }
});

test('supplier progress describes loading and automatic connection without legacy database status',()=>{
  const source=fs.readFileSync(new URL('../public/console/console.js',import.meta.url),'utf8');
  const start=source.indexOf('function paintConnectionSetup('),end=source.indexOf('\nfunction pluginPathField(',start);
  const progress={},error={},state={config:{hook:{backend:'supplier-http'}},connection:{prepared:true},};
  const context={state,document:{querySelectorAll:()=>[]},$:(selector)=>selector==='#hook-connection-progress'?progress:error};
  for(const job of [null,{action:'wechat-open',state:'running'},{action:'start',state:'running'}]){
    state.job=job;vm.runInNewContext(source.slice(start,end)+'\npaintConnectionSetup()',context);
    assert.doesNotMatch(progress.textContent,/数据库|绑定|选择账号/);
    assert.match(progress.textContent,job?.action==='wechat-open'?/加载内置 Hook/:job?.action==='start'?/自动准备微信连接/:/概览启动助手/);
  }

});

test('successful supplier overview startup refreshes automatic connection state and clears stale failures',async()=>{
  const source=fs.readFileSync(new URL('../public/console/console.js',import.meta.url),'utf8');
  const start=source.indexOf('async function pollJob('),end=source.indexOf('\nasync function runAction(',start);
  for(const action of ['start','restart']){
    const calls=[],nodes=new Map(),state={config:{hook:{backend:'supplier-http'}},job:{action,state:'succeeded'},page:'overview',deployment:{configured:false}};
    const context={state,api:async route=>{calls.push(route);if(route==='/api/hook/connection')return{backend:'supplier-http',prepared:true};if(route==='/api/deployment')return{installed:true,configured:true};throw Error(route);},$:(selector)=>{if(!nodes.has(selector))nodes.set(selector,{});return nodes.get(selector);},paintJob(){},paintConnectionSetup(){},refreshStatus:async()=>{},renderPage:async()=>{},toast(){},showError(message){throw Error(message);}};
    await vm.runInNewContext('let jobPolling=false;\n'+source.slice(start,end)+'\npollJob()',context);
    assert.deepEqual(calls.sort(),['/api/deployment','/api/hook/connection']);
    assert.equal(state.connection.prepared,true);assert.equal(state.deployment.configured,true);
    assert.equal(nodes.get('#setup-banner').hidden,true);assert.equal(nodes.get('#setup-nav').hidden,true);
  }
});
test('supplier API, reader and connection probe contain no database-access implementation',()=>{
  for(const script of ['supplier_api.py','supplier_reader.py','supplier-probe.py']){
    const source=fs.readFileSync(new URL(script,import.meta.url),'utf8');
    assert.equal(/['"]\/api\/(?:get_db_handle|sqlite3_exec)['"]|\bRemoteConnection\b/.test(source),false,script+' must not implement WeChat database access');
  }
});

test('saved console settings restore bundled paths and endpoints even when a stale client submits custom values',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-bundled-hook-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'config'));fs.mkdirSync(path.join(root,'roles'));
  const config=JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json',import.meta.url),'utf8'));
  Object.assign(config.hook,{backend:'supplier-http',expectedVersion:'4.1.8.27',wechatExecutable:'Weixin.exe',sourceDirectory:'D:/old-installers',upstreamUrl:'http://127.0.0.1:19999'});
  fs.writeFileSync(path.join(root,'roles',config.persona.default+'.md'),'测试人格');
  fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify(config));
  const app=createConsole({root,port:0});const address=await app.start();t.after(()=>app.close());
  const origin='http://127.0.0.1:'+address.port,info=await fetch(origin+'/api/info').then(r=>r.json()),headers={'X-Console-Token':info.token,'Content-Type':'application/json'};
  const snapshot=await fetch(origin+'/api/config',{headers}).then(r=>r.json());
  for(const [key,value] of Object.entries(BUNDLED_SUPPLIER_HOOK))assert.equal(snapshot.config.hook[key],value);
  Object.assign(snapshot.config.hook,{sourceDirectory:'D:/external',upstreamUrl:'http://example.com:1234',baseUrl:'http://example.com:1235',voiceBaseUrl:'http://example.com:1236'});
  const response=await fetch(origin+'/api/config',{method:'POST',headers,body:JSON.stringify({revision:snapshot.revision,config:snapshot.config})});
  assert.equal(response.status,200,await response.text());
  const stored=JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8'));
  for(const [key,value] of Object.entries(BUNDLED_SUPPLIER_HOOK))assert.equal(stored.hook[key],value);
  assert.equal(configureBundledHook(stored),false);assert.doesNotThrow(()=>validateConsoleConfig(stored,root));
});
test('Python supplier contracts cover push reception, local cache, media, authentication and send mapping',async()=>{
  const root=fileURLToPath(new URL('..',import.meta.url));
  const file=new URL('../config/wechatagent.json',import.meta.url);
  const config=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')):{};
  const python=process.env.WECHATAGENT_TEST_PYTHON??config.runtime?.python??'python';
  const scripts=['test-supplier-api-surface.py','test-supplier-contacts.py','test-supplier-actions.py','test-supplier-events.py','test_supplier_hook.py','test-supplier-social-actions.py','test-supplier-social-results.py','test-supplier-social-gateway.py'];
  for(const script of scripts){
    const {stdout,stderr}=await promisify(execFile)(python,['-B',path.join(root,'scripts',script)],{windowsHide:true,timeout:30000,encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'}});
    assert.match(stdout+stderr,/OK/);
  }
});
