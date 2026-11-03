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
  if(implementation)fs.writeFileSync(path.join(root,'scripts/supplier_api.py'),implementation);
  return file;
}

test('embedded Python launches the real supplier probe offline without inherited script paths',()=>{
  const result=run(probe,['--check-runtime']);
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{ok:true,probeReady:true});
});

test('offline probe loads the adjacent module without inspecting or contacting any WeChat process',t=>{
  const file=fixture(t,'class SupplierApi:\n def __init__(self,*args): raise AssertionError("must not instantiate")\nclass RemoteConnection: pass\n');
  const result=run(file,['--check-runtime']);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).probeReady,true);
});

test('standalone probe preserves actual connection errors and reports missing imports as JSON',t=>{
  const unavailable=fixture(t,'class SupplierApi:\n def __init__(self,*args): raise RuntimeError("HOOK_NOT_LISTENING")\nclass RemoteConnection: pass\n');
  const result=run(unavailable);assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).code,'HOOK_NOT_LISTENING');
  const missing=run(fixture(t),['--check-runtime']);assert.equal(missing.status,1);assert.equal(JSON.parse(missing.stdout).code,'HOOK_PROBE_DEPENDENCY_MISSING');assert.equal(JSON.parse(missing.stdout).module,'supplier_api');assert.equal(missing.stderr,'');
});

test('unexpected failures expose a safe type instead of private exception text',t=>{
  const file=fixture(t,'class SupplierApi:\n def __init__(self,*args): raise ValueError("private-test-credential")\nclass RemoteConnection: pass\n');
  const result=run(file);assert.equal(result.status,1);const data=JSON.parse(result.stdout);
  assert.equal(data.code,'HOOK_PROBE_FAILED');assert.equal(data.exceptionType,'ValueError');assert(!result.stdout.includes('private-test-credential'));assert.equal(result.stderr,'');
});
