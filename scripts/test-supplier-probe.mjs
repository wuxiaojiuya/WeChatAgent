import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const python=process.env.WECHATAGENT_TEST_PYTHON??path.resolve(import.meta.dirname,'../state/installer-stage/runtime/python/python.exe');
const probe=path.join(import.meta.dirname,'supplier-probe.py');
function run(file,args=[]){return spawnSync(python,['-B',file,...args],{windowsHide:true,encoding:'utf8',timeout:10000,env:{...process.env,PATH:'',PYTHONPATH:''}});}
function fixture(t,implementation){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'supplier probe '));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'scripts'));const file=path.join(root,'scripts/supplier-probe.py');fs.copyFileSync(probe,file);
  for(const dependency of ['supplier_contacts.py','wechat_contacts.py'])fs.copyFileSync(path.join(import.meta.dirname,dependency),path.join(root,'scripts',dependency));
  if(implementation)fs.writeFileSync(path.join(root,'scripts/supplier_api.py'),implementation);
  return file;
}

test('embedded Python launches the real supplier probe offline without inherited script paths',()=>{
  const result=run(probe,['--check-runtime']);
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{ok:true,probeReady:true});
});

test('offline probe loads the adjacent module without inspecting or contacting any WeChat process',t=>{
  const file=fixture(t,'class SupplierApi:\n def __init__(self,*args): raise AssertionError("must not instantiate")\n');
  const result=run(file,['--check-runtime']);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).probeReady,true);
});

test('standalone probe preserves actual connection errors and reports missing imports as JSON',t=>{
  const unavailable=fixture(t,'class SupplierApi:\n def __init__(self,*args): raise RuntimeError("HOOK_NOT_LISTENING")\n');
  const result=run(unavailable);assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).code,'HOOK_NOT_LISTENING');
  const missing=run(fixture(t),['--check-runtime']);assert.equal(missing.status,1);assert.equal(JSON.parse(missing.stdout).code,'HOOK_PROBE_DEPENDENCY_MISSING');assert.equal(JSON.parse(missing.stdout).module,'supplier_api');assert.equal(missing.stderr,'');
});

test('unexpected failures expose a safe type instead of private exception text',t=>{
  const file=fixture(t,'class SupplierApi:\n def __init__(self,*args): raise ValueError("private-test-credential")\n');
  const result=run(file);assert.equal(result.status,1);const data=JSON.parse(result.stdout);
  assert.equal(data.code,'HOOK_PROBE_FAILED');assert.equal(data.exceptionType,'ValueError');assert(!result.stdout.includes('private-test-credential'));assert.equal(result.stderr,'');
});

test('unknown dedicated catalog responses fail explicitly without database fallback',t=>{
 for(const [route,code] of [['/api/get_frien_lists','HOOK_CONTACTS_RESPONSE_INVALID'],['/api/get_chatroom_list','HOOK_GROUPS_RESPONSE_INVALID']]){
  const file=fixture(t,`class SupplierApi:
 def __init__(self,*args): pass
 def identity(self): return {'wxid':'wxid_fixture','version':'4.1.8.27'}
 def post(self,route):
  if route not in ('/api/get_frien_lists','/api/get_chatroom_list'): raise AssertionError('database fallback forbidden')
  return {'code':1} if route=='${route}' else {'data':[]}
`);
  const result=run(file);assert.equal(result.status,1,result.stderr);assert.equal(JSON.parse(result.stdout).code,code);
 }
});

test('unproven friend relationship flags cannot pass contact picker verification',t=>{
 const file=fixture(t,`class SupplierApi:
 def __init__(self,*args): pass
 def identity(self): return {'wxid':'wxid_fixture','version':'4.1.8.27'}
 def post(self,route):
  if route!='/api/get_frien_lists': raise AssertionError('unexpected request')
  return {'data':[{'userName':'wxid_friend','nickName':'Friend'}]}
`);
 const result=run(file);assert.equal(result.status,1,result.stderr);assert.equal(JSON.parse(result.stdout).code,'HOOK_CONTACTS_RELATIONSHIP_UNAVAILABLE');
});

test('single-account connection reads its metadata once without an expected-account comparison',t=>{
 const file=fixture(t,`class SupplierApi:
 def __init__(self,*args): self.calls=0
 def identity(self):
  self.calls+=1
  if self.calls!=1: raise AssertionError('duplicate login query')
  return {'wxid':'wxid_fixture','pid':42,'version':'4.1.8.27'}
 def post(self,route):
  if route=='/api/get_frien_lists': return {'data':[{'userName':'wxid_friend','nickName':'Friend','bitVal':1,'verifyFlag':0}]}
  if route=='/api/get_chatroom_list': return {'data':[{'userName':'123@chatroom','nickName':'Room'}]}
  raise AssertionError('database fallback forbidden')
`);
 const result=run(file);assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{ok:true,wxid:'wxid_fixture',pid:42,version:'4.1.8.27',messageSource:'supplier-callback',contactCount:1,groupCount:1});
});
