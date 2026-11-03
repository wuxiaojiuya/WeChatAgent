import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {windowsPowerShellExecutable,windowsPowerShellEnvironment} from './console-process.mjs';

test('supplier launcher handles absolute and relative client paths with spaces and Unicode without executing binaries',{skip:process.platform!=='win32'},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'supplier launch 中文 '));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const folder of ['scripts','config','components/supplier-hook/4.1.8.27','state/hook','appdata','client folder'])fs.mkdirSync(path.join(root,folder),{recursive:true});
  fs.copyFileSync(new URL('./launch-supplier-hook.ps1',import.meta.url),path.join(root,'scripts/launch-supplier-hook.ps1'));
  fs.copyFileSync(new URL('./supplier-runtime-check.ps1',import.meta.url),path.join(root,'scripts/supplier-runtime-check.ps1'));
  const bundle=path.join(root,'components/supplier-hook/4.1.8.27'),bytes=Buffer.from('fixture; never execute');
  const manifest=['libGLESv1.dll','x64 inject.exe'].map(file=>{fs.writeFileSync(path.join(bundle,file),bytes);return {file,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};});
  fs.writeFileSync(path.join(bundle,'files.sha256.json'),JSON.stringify(manifest));
  fs.writeFileSync(path.join(root,'state/hook/native-token.txt'),'a'.repeat(64));
  const exe=path.join(root,'client folder/Weixin.exe');fs.writeFileSync(exe,'fixture; never execute');
  const probe=path.join(root,'probe.ps1');
  fs.copyFileSync(new URL('./test-supplier-launcher-fixture.ps1',import.meta.url),probe);
  for(const executable of [exe,'client folder/Weixin.exe']){
    fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify({hook:{backend:'supplier-http',expectedVersion:'4.1.8.27',sourceDirectory:'D:/ignored-old-directory',wechatExecutable:executable,baseUrl:'http://127.0.0.1:31001',upstreamUrl:'http://127.0.0.1:19999'}}));
    const {stdout}=await promisify(execFile)(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',probe,root],{windowsHide:true,timeout:15000,env:windowsPowerShellEnvironment()});
    assert.match(stdout,/launch-contract-ok/);
  }
  fs.writeFileSync(path.join(bundle,'libGLESv1.dll'),'changed fixture');
  await assert.rejects(promisify(execFile)(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',probe,root],{windowsHide:true,timeout:15000,env:windowsPowerShellEnvironment()}),error=>String(error.stderr).includes('HOOK_BUNDLED_COMPONENT_INTEGRITY_FAILED'));
});
