import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import policy from '../apps/console-desktop/hook-only-policy.cjs';

function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'hook-only-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function put(root,file,text='fixture'){const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);return target;}

test('source and installer manifests reject every retired connection implementation',()=>{
 for(const file of [...policy.retiredFiles,'components/weflow-cli/scripts/nt_decrypt.py','scripts/native-hook/wechatagent_hook.cpp'])assert.throws(()=>policy.assertHookOnlyFiles([file]),/Retired WeChat connection/);
 assert.doesNotThrow(()=>policy.assertHookOnlyFiles(['scripts/hook-receiver.py','scripts/hook_receiver_core.py','components/supplier-hook/4.1.8.27/libGLESv1.dll']));
});
test('upgrade retires only project programs and preserves settings, messages and external client data',t=>{
 const root=fixture(t),external=fixture(t);
 const client=put(external,'db_storage/message/message_0.db','untouched client fixture');
 const config=put(root,'config/wechatagent.json','retained configuration');
 const history=put(root,'state/chat-history/scope/history.sqlite','retained project history');
 put(root,'components/weflow-cli/scripts/nt_decrypt.py');put(root,'scripts/reader-api.py');put(root,'scripts/native-hook/probe.cpp');
 put(root,'scripts/hook-receiver.py');
 const result=policy.retireLegacyHook(root);
 assert.equal(result.retired.length,3);assert(fs.existsSync(path.join(result.backup,'scripts/reader-api.py')));
 assert(!fs.existsSync(path.join(root,'scripts/reader-api.py')));assert(fs.existsSync(path.join(root,'scripts/hook-receiver.py')));
 assert.equal(fs.readFileSync(config,'utf8'),'retained configuration');assert.equal(fs.readFileSync(history,'utf8'),'retained project history');assert.equal(fs.readFileSync(client,'utf8'),'untouched client fixture');
 assert.deepEqual(policy.retireLegacyHook(root).retired,[]);
});
test('upgrade cannot move program files through a junction outside the workspace',t=>{
 const root=fixture(t),external=fixture(t);put(external,'reader-api.py','external program');
 fs.symlinkSync(external,path.join(root,'scripts'),process.platform==='win32'?'junction':'dir');
 assert.throws(()=>policy.retireLegacyHook(root),/linked project program/);assert.equal(fs.readFileSync(path.join(external,'reader-api.py'),'utf8'),'external program');
});
test('runtime verification rejects both declared and leftover database-reader packages',t=>{
 const root=fixture(t);put(root,'python/DEPENDENCIES.json','[]');
 assert.doesNotThrow(()=>policy.assertHookRuntime(root));
 put(root,'python/Lib/site-packages/sqlcipher3/__init__.py');assert.throws(()=>policy.assertHookRuntime(root),/Retired database dependency/);
 fs.rmSync(path.join(root,'python/Lib/site-packages/sqlcipher3'),{recursive:true});
 put(root,'python/DEPENDENCIES.json',JSON.stringify([{name:'sqlcipher3'}]));assert.throws(()=>policy.assertHookRuntime(root),/Retired database dependency/);
});
