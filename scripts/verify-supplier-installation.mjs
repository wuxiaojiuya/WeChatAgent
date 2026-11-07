// Exercise the same first-run environment check as the installed UI, offline.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import deployment from '../apps/console-desktop/deployment.cjs';
import hookPolicy from '../apps/console-desktop/hook-only-policy.cjs';
import {CAPABILITY_PLUGIN_FILES,CAPABILITY_EXECUTION_VERSION} from '../packages/dsh-capabilities-plugin/contract.mjs';

const root=path.resolve(import.meta.dirname,'..');
const resources=path.resolve(process.argv[2]??path.join(root,'release/installer/win-unpacked/resources'));
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'WeChatAgent installation '));
const capabilityFiles=['scripts/dsh-capability-client.mjs',...CAPABILITY_PLUGIN_FILES.map(file=>'packages/dsh-capabilities-plugin/'+file)];
const deliveryFiles=['components/qq-bridge/src/core/social-engine.js','scripts/supplier_reader.py',
  'scripts/hook-receiver.py','scripts/hook_receiver_core.py','scripts/hook-connection-state.mjs','scripts/supplier-probe.py','scripts/supplier-connect.mjs','scripts/console-process.mjs','scripts/console-server.mjs',
  'packages/dsh-social-bridge-plugin/prompt-context.mjs','packages/dsh-social-bridge-plugin/history-runtime.mjs',
  'packages/dsh-social-bridge-plugin/native-context.mjs','packages/dsh-social-bridge-plugin/persona-generation.mjs',
  'packages/dsh-social-bridge-plugin/persona-evolution.mjs','packages/dsh-social-bridge-plugin/persona-proposal-tools.mjs'];
const updatedFiles=[...capabilityFiles,...deliveryFiles];
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
try {
  const manifest=JSON.parse(fs.readFileSync(path.join(resources,'project/deployment.json')));
  assert.equal(manifest.hookBackend,'supplier-http');
  assert.equal(manifest.wechatVersion,'4.1.8.27');
  hookPolicy.assertHookOnlyFiles(manifest.files);
  hookPolicy.assertHookRuntime(path.join(resources,'runtime'));
  const installed=await deployment.bootstrapDeployment(resources,temporary);
  const configFile=path.join(installed.root,'config/wechatagent.json');
  const config=JSON.parse(fs.readFileSync(configFile));
  assert.deepEqual(config.wechat.whitelist,{private:[],groups:[]});
  assert.equal(config.hook.backend,'supplier-http');
  const featureFiles=['scripts/drawing-capability.mjs','scripts/native-image-delivery.mjs','packages/dsh-social-bridge-plugin/drawing-tools.mjs',
    'packages/dsh-social-bridge-plugin/persona-generation.mjs','public/console/drawing-capability.js','public/console/drawing-capability.css','docs/GPT_DRAWING.md'];
  for(const relative of featureFiles){assert(manifest.sourceHashes[relative]);assert(fs.existsSync(path.join(installed.root,relative)));}
  for(const relative of updatedFiles){
    assert(manifest.files.includes(relative),'Missing deployment file: '+relative);
    assert.equal(manifest.sourceHashes[relative],sha(path.join(root,relative)),'Packaged source is outdated: '+relative);
    assert.equal(sha(path.join(resources,'project',relative)),manifest.sourceHashes[relative],'Packaged feature hash mismatch: '+relative);
    assert.equal(sha(path.join(installed.root,relative)),manifest.sourceHashes[relative],'Deployed feature hash mismatch: '+relative);
  }
  // No system Node/Python on PATH: verify the exact setup-page action with the
  // deployed config and copied embedded runtime, not developer dependencies.
  const powershell=path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const checked=spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(installed.root,'scripts/check-runtime.ps1')],
    {windowsHide:true,encoding:'utf8',timeout:60000,env:{...process.env,PATH:''}});
  assert.equal(checked.status,0,checked.stdout+'\n'+checked.stderr);
  assert.match(checked.stdout,/Bundled Hook receiver, media codecs and WeChat 4\.1\.8\.27 components verified/);
  assert(!fs.existsSync(path.join(installed.root,'components/weflow-cli/resources/key/win32/x64/wx_key.dll')));
  const page=fs.readFileSync(path.join(installed.root,'public/console/console.js'),'utf8');
  const setup=page.slice(page.indexOf('function setupPage()'),page.indexOf('async function logsPage()'));
  assert(setup.includes("field('微信程序位置', 'hook.wechatExecutable'"));
  assert(setup.includes('data-layout-control="save-button"'));
  config.wechat.whitelist.private=['123'];fs.writeFileSync(configFile,JSON.stringify(config));
  const fixtures=[['roles/验证保留.md','custom persona fixture'],['state/custom-models/validation.pth','custom model fixture'],['state/voice-output/validation-key.txt','private-key-fixture-only'],
    ['state/voice-output/capabilities.json',JSON.stringify({singing:{provider:'feiyu-rvc',musicSource:'netease',neteaseCookie:'MUSIC_U=private-upgrade-fixture'}})],
    ['state/drawing/capability.json',JSON.stringify({enabled:false,apiKey:'private-drawing-upgrade-fixture'})],
    ['state/persona-backups/validation/original.md','original persona backup fixture']];
  for(const [relative,text]of fixtures){const file=path.join(installed.root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}
  const distributionFile=path.join(installed.root,'config/distribution.json');
  const previous=JSON.parse(fs.readFileSync(distributionFile));
  fs.writeFileSync(distributionFile,JSON.stringify({...previous,version:'0.2.0',buildId:'previous-build-fixture'}));
  // An upgrade must replace prior capability/transport code, while leaving the
  // user's settings, credentials, custom voices and personas intact.
  const retired=['scripts/music-soulx-worker.py','scripts/soulx-runtime.py','scripts/soulx-assets.json','docs/SOULX_SINGING.md',
    'state/maintenance/audio-capabilities/soulx-singer/source/pretrained_models/model.pt'];
  for(const relative of retired){const file=path.join(installed.root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'retired engine fixture');}
  const oldHook=['scripts/reader-api.py','scripts/reader_setup.py','scripts/hook-client-health.ps1','components/weflow-cli/scripts/nt_decrypt.py','scripts/native-hook/probe.cpp'];
  for(const relative of oldHook){const file=path.join(installed.root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'retired connection fixture');}
  for(const relative of updatedFiles)fs.writeFileSync(path.join(installed.root,relative),'prior-version feature fixture\n');
  await deployment.bootstrapDeployment(resources,temporary);
  for(const relative of oldHook)assert(!fs.existsSync(path.join(installed.root,relative)),'Upgrade retained obsolete connection program: '+relative);
  assert(fs.readdirSync(path.join(installed.root,'state/maintenance')).some(name=>name.startsWith('retired-hook-')),'Upgrade must archive retired programs');
  for(const relative of retired)assert(!fs.existsSync(path.join(installed.root,relative)),'Upgrade retained obsolete singing engine: '+relative);
  for(const relative of updatedFiles)assert.equal(sha(path.join(installed.root,relative)),manifest.sourceHashes[relative],'Upgrade retained stale feature code: '+relative);
  const upgradeState=JSON.parse(fs.readFileSync(path.join(installed.root,'state/console-state.json')));
  assert.equal(upgradeState.pendingApply,true);assert.equal(upgradeState.dshReloadRequired,true);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile)).wechat.whitelist.private,['123']);
  for(const [relative,text]of fixtures)assert.equal(fs.readFileSync(path.join(installed.root,relative),'utf8'),text);
  const {createAudioCapabilities}=await import(pathToFileURL(path.join(installed.root,'scripts/audio-capabilities.mjs')).href);
  const audio=createAudioCapabilities({root:installed.root});
  try{const saved=audio.snapshot();assert.equal(saved.settings.singing.musicSource,'netease');assert.equal(saved.settings.singing.hasNeteaseCookie,true);assert.equal(saved.settings.singing.neteaseCookie,'');assert(!JSON.stringify(saved).includes('private-upgrade-fixture'));}finally{audio.close();}
  assert(fs.readFileSync(path.join(installed.root,'public/console/music-source.js'),'utf8').includes('music-netease-login'));
  console.log(JSON.stringify({ok:true,version:manifest.version,cleanInstalledRuntimeCheck:true,systemNodeOrPythonRequired:false,
    capabilityHost:'dsh',capabilityExecution:CAPABILITY_EXECUTION_VERSION,capabilityPluginFilesVerified:CAPABILITY_PLUGIN_FILES.length,capabilityFilesDeployed:true,upgradeReplacesCapabilityAndDeliveryFiles:true,upgradeRequiresDshReload:true,
    setupWechatLocation:true,upgradePreservesChatSettings:true,upgradePreservesPersona:true,upgradePreservesPrivateKey:true,
    upgradePreservesCustomModel:true,upgradePreservesMusicCredential:true,upgradePreservesDrawingCredential:true,upgradePreservesPersonaBackup:true,
    drawingAndPersonaFiles:true,neteaseLoginPage:true,obsoleteSingingEnvironmentRemoved:true,legacyConnectionProgramsRemoved:true,wechatDatabaseAccess:false,servicesStarted:false}));
} finally {
  const resolved=path.resolve(temporary),parent=path.resolve(os.tmpdir());
  if(path.dirname(resolved)!==parent||!path.basename(resolved).startsWith('WeChatAgent installation '))throw Error('Invalid verification cleanup path');
  fs.rmSync(resolved,{recursive:true,force:true});
}
