import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import deployment from '../apps/console-desktop/deployment.cjs';
import {validateConfig} from './project-config.mjs';

test('supplier installation starts with clean config and deploys packaged components without old native vendor files',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'supplier-deploy-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const resources=path.join(base,'resources'),home=path.join(base,'data');
  const write=(relative,value)=>{const target=path.join(resources,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,typeof value==='object'?JSON.stringify(value):value);};
  const config=JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json',import.meta.url)));
  validateConfig(config);
  const files=['config/wechatagent.example.json','roles/示例助手.md','components/supplier-hook/4.1.8.27/libGLESv1.dll'];
  write('project/deployment.json',{version:'0.1.0',wechatVersion:'4.1.8.27',hookBackend:'supplier-http',dshBundled:false,files});
  write('project/'+files[0],config);write('project/'+files[1],'Example role');write('project/'+files[2],'fixture-only');
  write('runtime/python/python.exe','fixture-python');write('runtime/node.exe','fixture-node');
  await deployment.bootstrapDeployment(resources,home);
  const cfg=JSON.parse(fs.readFileSync(path.join(home,'workspace/config/wechatagent.json')));
  assert.equal(cfg.hook.backend,'supplier-http');assert.equal(cfg.hook.expectedVersion,'4.1.8.27');
  assert.equal(cfg.hook.wechatExecutable,'');
  assert.deepEqual(cfg.wechat.whitelist,{groups:[],private:[]});assert.equal(cfg.persona.default,'示例助手');
  assert(fs.existsSync(path.join(home,'workspace',files[2])));
  assert(!fs.existsSync(path.join(home,'workspace/state/hook/native')));
  assert(!fs.existsSync(path.join(home,'workspace/state/hook/wechat-4.1.8.27')));
  cfg.wechat.whitelist.private=['123'];fs.writeFileSync(path.join(home,'workspace/config/wechatagent.json'),JSON.stringify(cfg));
  await deployment.bootstrapDeployment(resources,home);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home,'workspace/config/wechatagent.json'))).wechat.whitelist.private,['123']);
});

test('deployment refuses old backends and database programs before creating a workspace',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'supplier-only-deploy-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const resources=path.join(base,'resources'),home=path.join(base,'data');
  fs.mkdirSync(path.join(resources,'project'),{recursive:true});
  const manifest={version:'test',wechatVersion:'4.1.8.27',hookBackend:'supplier-http',files:[]};
  for(const change of [{wechatVersion:'4.1.15.13'},{hookBackend:'project-native'},{files:['scripts/reader-api.py']},{files:['components/weflow-cli/scripts/nt_decrypt.py']}]){
    fs.writeFileSync(path.join(resources,'project/deployment.json'),JSON.stringify({...manifest,...change}));
    await assert.rejects(()=>deployment.bootstrapDeployment(resources,home),/4\.1\.8\.27|Retired WeChat/);
    assert(!fs.existsSync(path.join(home,'workspace')));
  }
});

test('upgrading synchronizes workspace and displayed release metadata even when manifest is not listed as a source file',async t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'supplier-version-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const resources=path.join(base,'resources'),home=path.join(base,'data'),template=path.join(resources,'project');
 for(const dir of [template,path.join(resources,'runtime/python'),path.join(template,'config')])fs.mkdirSync(dir,{recursive:true});
 const config=JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json',import.meta.url)));
 fs.writeFileSync(path.join(template,'config/wechatagent.example.json'),JSON.stringify(config));
 fs.writeFileSync(path.join(resources,'runtime/python/python.exe'),'fixture');fs.writeFileSync(path.join(resources,'runtime/node.exe'),'fixture');
 const manifest={version:'0.2.17',packageVersion:'0.2.17',buildId:'2222222222222222',builtAt:'2026-11-07T10:00:00Z',wechatVersion:'4.1.8.27',hookBackend:'supplier-http',dshBundled:false,files:['config/wechatagent.example.json']};
 fs.writeFileSync(path.join(template,'deployment.json'),JSON.stringify(manifest));
 const workspace=path.join(home,'workspace');fs.mkdirSync(workspace,{recursive:true});fs.writeFileSync(path.join(workspace,'deployment.json'),JSON.stringify({...manifest,version:'0.2.15'}));
 await deployment.bootstrapDeployment(resources,home);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace,'deployment.json'))),manifest);
 const installed=JSON.parse(fs.readFileSync(path.join(workspace,'config/distribution.json')));
 for(const field of ['version','packageVersion','buildId','builtAt'])assert.equal(installed[field],manifest[field]);
});
