// Exercise the same first-run environment check as the installed UI, offline.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import deployment from '../apps/console-desktop/deployment.cjs';

const root=path.resolve(import.meta.dirname,'..');
const resources=path.resolve(process.argv[2]??path.join(root,'release/installer/win-unpacked/resources'));
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'WeChatAgent installation '));
try {
  const manifest=JSON.parse(fs.readFileSync(path.join(resources,'project/deployment.json')));
  assert.equal(manifest.hookBackend,'supplier-http');
  const installed=await deployment.bootstrapDeployment(resources,temporary);
  const configFile=path.join(installed.root,'config/wechatagent.json');
  const config=JSON.parse(fs.readFileSync(configFile));
  assert.deepEqual(config.wechat.whitelist,{private:[],groups:[]});
  assert.equal(config.hook.backend,'supplier-http');
  // No system Node/Python on PATH: verify the exact setup-page action with the
  // deployed config and copied embedded runtime, not developer dependencies.
  const powershell=path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const checked=spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(installed.root,'scripts/check-runtime.ps1')],
    {windowsHide:true,encoding:'utf8',timeout:60000,env:{...process.env,PATH:''}});
  assert.equal(checked.status,0,checked.stdout+'\n'+checked.stderr);
  assert.match(checked.stdout,/Hook components and image worker verified/);
  assert(!fs.existsSync(path.join(installed.root,'components/weflow-cli/resources/key/win32/x64/wx_key.dll')));
  const page=fs.readFileSync(path.join(installed.root,'public/console/console.js'),'utf8');
  const setup=page.slice(page.indexOf('function setupPage()'),page.indexOf('async function logsPage()'));
  assert(setup.includes("field('微信程序位置', 'hook.wechatExecutable'"));
  assert(setup.includes('data-layout-control="save-button"'));
  config.wechat.whitelist.private=['123'];fs.writeFileSync(configFile,JSON.stringify(config));
  const fixtures=[['roles/验证保留.md','custom persona fixture'],['state/custom-models/validation.pth','custom model fixture'],['state/voice-output/validation-key.txt','private-key-fixture-only'],
    ['state/voice-output/capabilities.json',JSON.stringify({singing:{provider:'feiyu-rvc',musicSource:'netease',neteaseCookie:'MUSIC_U=private-upgrade-fixture'}})]];
  for(const [relative,text]of fixtures){const file=path.join(installed.root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}
  const distributionFile=path.join(installed.root,'config/distribution.json');
  const previous=JSON.parse(fs.readFileSync(distributionFile));
  fs.writeFileSync(distributionFile,JSON.stringify({...previous,version:'0.2.0',buildId:'previous-build-fixture'}));
  await deployment.bootstrapDeployment(resources,temporary);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile)).wechat.whitelist.private,['123']);
  for(const [relative,text]of fixtures)assert.equal(fs.readFileSync(path.join(installed.root,relative),'utf8'),text);
  const {createAudioCapabilities}=await import(pathToFileURL(path.join(installed.root,'scripts/audio-capabilities.mjs')).href);
  const audio=createAudioCapabilities({root:installed.root});
  try{const saved=audio.snapshot();assert.equal(saved.settings.singing.musicSource,'netease');assert.equal(saved.settings.singing.hasNeteaseCookie,true);assert.equal(saved.settings.singing.neteaseCookie,'');assert(!JSON.stringify(saved).includes('private-upgrade-fixture'));}finally{audio.close();}
  assert(fs.readFileSync(path.join(installed.root,'public/console/music-source.js'),'utf8').includes('music-netease-login'));
  console.log(JSON.stringify({ok:true,version:manifest.version,cleanInstalledRuntimeCheck:true,systemNodeOrPythonRequired:false,
    setupWechatLocation:true,upgradePreservesChatSettings:true,upgradePreservesPersona:true,upgradePreservesPrivateKey:true,
    upgradePreservesCustomModel:true,upgradePreservesMusicCredential:true,neteaseLoginPage:true,servicesStarted:false}));
} finally {
  const resolved=path.resolve(temporary),parent=path.resolve(os.tmpdir());
  if(path.dirname(resolved)!==parent||!path.basename(resolved).startsWith('WeChatAgent installation '))throw Error('Invalid verification cleanup path');
  fs.rmSync(resolved,{recursive:true,force:true});
}
