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
import {hookAccountProblem} from './wechat-account-check.mjs';

test('supplier profile rejects mixed versions and non-loopback or overlapping upstream addresses',()=>{
  const c=JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json',import.meta.url),'utf8'));
  Object.assign(c.hook,{backend:'supplier-http',expectedVersion:'4.1.8.27',...BUNDLED_SUPPLIER_HOOK});
  assert.doesNotThrow(()=>validateConfig(c));
  for(const mutate of [x=>x.hook.expectedVersion='4.1.10.27',x=>x.hook.upstreamUrl='http://example.com:19088',x=>x.hook.upstreamUrl=x.hook.baseUrl,x=>x.hook.voiceBaseUrl='http://127.0.0.1:30002',x=>x.hook.upstreamUrl='http://127.0.0.1:'+x.ports.weflow,x=>x.hook.sourceDirectory='D:/external-hook',x=>x.hook.baseUrl='http://127.0.0.1:31001']){
    const bad=structuredClone(c);mutate(bad);assert.throws(()=>validateConfig(bad));
  }
});
test('supplier account health cannot be satisfied by the previous project DLL',()=>{
  const health={integration:'WeChatAgent-supplier-v1',backend:'wechat-hook',provider:'supplier-http',version:'4.1.8.27',startupState:'ready',databaseAccounts:['wxid_self']};
  assert.equal(hookAccountProblem(health,'wxid_self','4.1.8.27'),'');
  assert.equal(hookAccountProblem({...health,integration:'WeChatAgent-1'},'wxid_self','4.1.8.27'),'REVIEWED_HOOK_BUILD_REQUIRED');
  assert.equal(hookAccountProblem(health,'other','4.1.8.27'),'HOOK_ACCOUNT_MISMATCH');
});
test('connection page uses bundled Hook without editable component or HTTP address fields',()=>{
  const source=fs.readFileSync(new URL('../public/console/console.js',import.meta.url),'utf8');
  const extract=(name,next)=>source.slice(source.indexOf('function '+name+'('),source.indexOf('\nfunction '+next+'(',source.indexOf('function '+name+'(')));
  const state={config:{hook:{backend:'supplier-http',expectedVersion:'4.1.8.27'}},reader:{verified:false,myWxid:'',backend:'supplier-http'}};
  const context={state,escapeHtml:String,icon:()=>'',header:(title,description)=>'<h2>'+title+'</h2><p>'+description+'</p>',field:(label,key)=>'<label data-key="'+key+'">'+label+'</label>',pluginPathField:()=>''};
  const html=vm.runInNewContext(extract('readerConfigurationCard','paintReaderSetup')+'\n'+extract('connectionsPage','toolsPage')+'\nconnectionsPage()',context);
  assert.match(html,/4\.1\.8\.27/);assert.match(html,/组件已内置/);
  assert.doesNotMatch(html,/data-key="hook\.(sourceDirectory|upstreamUrl|baseUrl|voiceBaseUrl)"/);
  assert.doesNotMatch(html,/id="reader-db-path"|id="reader-key"|id="detect-reader"|id="scan-reader"/);
  assert.match(html,/data-action="reader-connect"/);
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
test('Python supplier contracts cover SQL, full history, media, authentication and send mapping',async()=>{
  const root=fileURLToPath(new URL('..',import.meta.url));
  const file=new URL('../config/wechatagent.json',import.meta.url);
  const config=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')):{};
  const python=process.env.WECHATAGENT_TEST_PYTHON??config.runtime?.python??'python';
  const {stdout,stderr}=await promisify(execFile)(python,['-B',path.join(root,'scripts/test_supplier_hook.py')],{windowsHide:true,timeout:30000,encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'}});
  assert.match(stdout+stderr,/OK/);
});
