import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import storage from '../apps/console-desktop/storage-location.cjs';
import deployment from '../apps/console-desktop/deployment.cjs';
const {resolveStorageLocation,migrationPlan,retainDsh,deploymentStorageOptions,prepareDataHome,rebindExternalDsh}=storage;
function fixture(t){const base=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-data-layout-')),appDir=path.join(base,'selected/app'),home=path.join(base,'selected/data'),old=path.join(base,'old AppData'),dsh=path.join(base,'old .dsh');const write=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof data==='string'||Buffer.isBuffer(data)?data:JSON.stringify(data));};
 const cfg={runtime:{python:path.join(old,'runtimes/old/python/python.exe'),dshDesktop:'E:/independent/DSH.exe'},persona:{default:'Owner',chats:{}},wechat:{whitelist:{private:['123'],groups:[]}}};
 write(path.join(old,'workspace/config/wechatagent.json'),cfg);write(path.join(old,'workspace/config/distribution.json'),{python:cfg.runtime.python,dsh:path.join(old,'runtimes/old/dsh/Harness.exe')});write(path.join(old,'workspace/roles/Owner.md'),'Personal role');write(path.join(old,'workspace/state/weflow/WeFlow-config.json'),{dbPath:'E:/original-wechat-db',decryptKey:'userdpapi:protected'});write(path.join(old,'workspace/state/social-messages.json'),{chats:{},pendingReplies:{test:{text:'already decided'}},note:path.join(old,'workspace/this is literal chat text')});write(path.join(old,'workspace/state/stickers/collected/test/index.json'),{path:path.join(old,'workspace/state/stickers/collected/test/image.gif')});write(path.join(old,'workspace/state/stickers/collected/test/image.gif'),Buffer.from('GIF89a'));write(path.join(old,'workspace/state/runtime.json'),{pid:99999});write(path.join(old,'workspace/state/hook/wechat-4.1.10.27/Weixin.exe'),'old-client');write(path.join(old,'runtimes/old/node.exe'),'old-runtime');
 fs.mkdirSync(appDir,{recursive:true});t.after(()=>{assert(base.startsWith(os.tmpdir()+path.sep));fs.rmSync(base,{recursive:true,force:true,maxRetries:5,retryDelay:50});});return{base,appDir,home,old,dsh,cfg,write,location:{appDir,dataHome:home,migrationSource:old},sourceRoot:path.join(old,'workspace')};}
test('installer location supports Unicode INI, explicit fresh installs, and separate app/data directories',t=>{const f=fixture(t);f.write(path.join(f.appDir,'storage.ini'),Buffer.from('\uFEFF[Storage]\r\ndataHome='+f.home+'\r\nmigrationSource=\r\n','utf16le'));const result=resolveStorageLocation({appDir:f.appDir,legacyHome:f.old});assert.equal(result.dataHome,f.home);assert.equal(result.migrationSource,'');assert.throws(()=>storage.validateLocation(f.appDir,path.join(f.appDir,'data')),/分开/);assert.throws(()=>storage.validateLocation(f.appDir,path.dirname(f.appDir)),/分开/);});
test('relative database paths remain anchored to the original database and test overrides never import real data',async t=>{const f=fixture(t);f.write(path.join(f.sourceRoot,'state/weflow/WeFlow-config.json'),{dbPath:'my-wechat-db',decryptKey:'userdpapi:protected'});assert.equal(resolveStorageLocation({appDir:f.appDir,legacyHome:f.old,override:f.home}).migrationSource,'');await prepareDataHome(migrationPlan(f.location,{legacyDshHome:f.dsh}),{checkIdle:async()=>{}});assert.equal(JSON.parse(fs.readFileSync(path.join(f.home,'workspace/state/weflow/WeFlow-config.json'))).dbPath,path.join(f.sourceRoot,'my-wechat-db'));});
test('migration preserves data and delivery receipts, rebases owned media paths and keeps the source unchanged',async t=>{const f=fixture(t),sourceBefore=fs.readFileSync(path.join(f.sourceRoot,'state/social-messages.json'));const plan=migrationPlan(f.location,{legacyDshHome:f.dsh});let checks=0;const result=await prepareDataHome(plan,{checkIdle:async()=>checks++});assert(result.migrated);assert.equal(checks,2);assert.deepEqual(fs.readFileSync(path.join(f.sourceRoot,'state/social-messages.json')),sourceBefore);const root=path.join(f.home,'workspace');const msg=JSON.parse(fs.readFileSync(path.join(root,'state/social-messages.json')));assert.equal(msg.pendingReplies.test.text,'already decided');assert.equal(msg.note,path.join(f.sourceRoot,'this is literal chat text'));assert.equal(JSON.parse(fs.readFileSync(path.join(root,'state/weflow/WeFlow-config.json'))).dbPath,'E:/original-wechat-db');assert.equal(JSON.parse(fs.readFileSync(path.join(root,'state/stickers/collected/test/index.json'))).path,path.join(root,'state/stickers/collected/test/image.gif'));assert(!fs.existsSync(path.join(root,'state/runtime.json')));assert(!fs.existsSync(path.join(root,'state/hook/wechat-4.1.10.27/Weixin.exe')));assert(!fs.existsSync(path.join(f.home,'runtimes')));assert.equal(migrationPlan(f.location).needed,false);assert(fs.existsSync(path.join(f.old,'runtimes/old/node.exe')));});
test('busy source, changed files, verification failure and occupied targets do not switch or overwrite data',async t=>{for(const mode of ['busy','changed','verify','occupied']){const f=fixture(t);if(mode==='occupied'){f.write(path.join(f.home,'workspace/config/wechatagent.json'),'existing');assert.throws(()=>migrationPlan(f.location),/不能合并/);continue;}const plan=migrationPlan(f.location,{legacyDshHome:f.dsh});let checks=0;await assert.rejects(prepareDataHome(plan,{checkIdle:async()=>{checks++;if(mode==='busy')throw Error('busy');if(mode==='changed'&&checks===2)f.write(path.join(f.sourceRoot,'roles/Owner.md'),'Changed');},verify:async()=>{if(mode==='verify')throw Error('verification refused');}}));assert(!fs.existsSync(path.join(f.home,'.wechatagent-data.json')));assert(!fs.existsSync(path.join(f.home,'workspace')));assert(fs.existsSync(path.join(f.sourceRoot,'config/wechatagent.json')));}});
test('managed DSH copies opaque history and attachments while independent DSH only rebinds project paths with a backup',async t=>{for(const managed of [true,false]){const f=fixture(t);if(managed){f.cfg.runtime.dshDesktop=path.join(f.old,'runtimes/old/dsh/Harness.exe');f.write(path.join(f.sourceRoot,'config/wechatagent.json'),f.cfg);}const journal=Buffer.from([0x28,0xb5,0x2f,0xfd,0,1,2,3]);f.write(path.join(f.dsh,'sessions/old-project/social-test/session.v4.jsonl.zstd'),journal);f.write(path.join(f.dsh,'attachments/file.png'),'image');f.write(path.join(f.dsh,'profiles/desktop/cordis.patch.yml'),'name: '+path.join(f.sourceRoot,'packages/dsh-social-bridge-plugin/cordis.patch.yml'));const plan=migrationPlan(f.location,{legacyDshHome:f.dsh});const result=await prepareDataHome(plan,{checkIdle:async()=>{}});assert.equal(result.report.dshCopied,managed);if(managed){assert.deepEqual(fs.readFileSync(path.join(f.home,'dsh/sessions/old-project/social-test/session.v4.jsonl.zstd')),journal);assert(fs.existsSync(path.join(f.home,'dsh/attachments/file.png')));}else{await rebindExternalDsh(result.report,path.join(f.home,'workspace'),f.home);assert(fs.readFileSync(path.join(f.dsh,'profiles/desktop/cordis.patch.yml'),'utf8').includes(path.join(f.home,'workspace')));assert(fs.existsSync(path.join(f.home,'backups/external-dsh/desktop/cordis.patch.yml')));assert(!fs.existsSync(path.join(f.home,'dsh')));}}});

test('retaining DSH leaves its history, external links, config and executable binding in place across migration and restart',async t=>{
 for(const mode of ['managed','independent','nested-home','backup-home']){
  const f=fixture(t),dsh=mode==='nested-home'?path.join(f.sourceRoot,'state/old-dsh'):mode==='backup-home'?path.join(f.old,'backups/dsh-home'):f.dsh;
  const exe=mode==='independent'?path.join(f.base,'independent/Harness.exe'):path.join(f.old,'runtimes/old/dsh/Harness.exe');
  f.cfg.runtime.dshDesktop=exe;f.write(path.join(f.sourceRoot,'config/wechatagent.json'),f.cfg);f.write(exe,'old DSH program');
  f.write(path.join(f.sourceRoot,'config/distribution.json'),{python:f.cfg.runtime.python,dsh:path.join(f.old,'runtimes/old/dsh/Harness.exe'),dshHome:dsh,externalDshHome:dsh});
  const history=path.join(dsh,'sessions/old-project/social-test/session.v4.jsonl.zstd'),profile=path.join(dsh,'profiles/desktop/cordis.patch.yml');
  const journal=Buffer.from([0x28,0xb5,0x2f,0xfd,0,1,2,3]);f.write(history,journal);f.write(profile,'plugin: '+path.join(f.sourceRoot,'packages/dsh-social-bridge-plugin'));f.write(path.join(dsh,'attachments/image.png'),'image');
  const outside=path.join(f.base,'external plugin');f.write(path.join(outside,'keep.txt'),'external data');const link=path.join(dsh,'external-plugin');fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');
  f.write(path.join(f.sourceRoot,'state/dsh-reference.json'),{path:path.join(dsh,'attachments/image.png')});
  f.write(path.join(f.sourceRoot,'state/weflow/WeFlow-config.json'),{dbPath:'my-wechat-db',decryptKey:'userdpapi:protected'});
  const originalConfig=fs.readFileSync(path.join(f.sourceRoot,'config/wechatagent.json')),originalProfile=fs.readFileSync(profile),originalLink=fs.readlinkSync(link);
  const plan=retainDsh(migrationPlan(f.location,{legacyDshHome:dsh})),result=await prepareDataHome(plan,{checkIdle:async()=>{}});
  assert(result.migrated);assert.equal(result.report.dshRetained,true);assert.equal(result.report.dshCopied,false);assert.equal(result.report.oldDshHome,dsh);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home,'workspace/config/wechatagent.json'))).runtime.dshDesktop,exe);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home,'workspace/state/dsh-reference.json'))).path,path.join(dsh,'attachments/image.png'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home,'workspace/state/weflow/WeFlow-config.json'))).dbPath,path.join(f.sourceRoot,'my-wechat-db'));
  assert(!fs.existsSync(path.join(f.home,'dsh')));assert(!fs.existsSync(path.join(f.home,'workspace/state/old-dsh')));
  assert(!fs.existsSync(path.join(f.home,'backups/dsh-home')));
  const resources=path.join(f.base,'new app/resources');for(const [relative,value]of Object.entries({'project/deployment.json':{version:'new',dshBundled:false,files:[]},'runtime/python/python.exe':'python','runtime/node.exe':'node','vendor/wechat/Weixin.exe':'wechat','vendor/hook/version.dll':'hook','vendor/hook/build.json':{}}))f.write(path.join(resources,relative),value);
  for(let launch=0;launch<2;launch++){
   const nextPlan=migrationPlan(f.location);assert.equal(nextPlan.needed,false);assert.equal(nextPlan.report.dshRetained,true);
   await deployment.bootstrapDeployment(resources,f.home,()=>{},deploymentStorageOptions(nextPlan.report,f.home));
   await rebindExternalDsh(nextPlan.report,path.join(f.home,'workspace'),f.home);
   const cfg=JSON.parse(fs.readFileSync(path.join(f.home,'workspace/config/wechatagent.json'))),dist=JSON.parse(fs.readFileSync(path.join(f.home,'workspace/config/distribution.json')));
   assert.equal(cfg.runtime.dshDesktop,exe);assert.equal(dist.dshHome,dsh);assert.equal(dist.externalDshHome,dsh);assert(fs.existsSync(exe));assert(cfg.runtime.python.startsWith(path.join(f.home,'runtimes')));
   assert.deepEqual(fs.readFileSync(history),journal);assert.deepEqual(fs.readFileSync(profile),originalProfile);assert.equal(fs.readlinkSync(link),originalLink);assert.equal(fs.readFileSync(path.join(outside,'keep.txt'),'utf8'),'external data');
   assert(!fs.existsSync(path.join(f.home,'backups/external-dsh')));assert(!fs.existsSync(path.join(f.home,'dsh')));
  }
  assert.deepEqual(fs.readFileSync(path.join(f.sourceRoot,'config/wechatagent.json')),originalConfig);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home,'workspace/state/social-messages.json'))).pendingReplies.test.text,'already decided');
 }
});

test('a DSH external-link failure can retry with retention without bypassing links in WeChatAgent data',async t=>{
 const f=fixture(t);f.cfg.runtime.dshDesktop=path.join(f.old,'runtimes/old/dsh/Harness.exe');f.write(path.join(f.sourceRoot,'config/wechatagent.json'),f.cfg);
 const outside=path.join(f.base,'external attachments');f.write(path.join(outside,'keep.txt'),'keep');fs.mkdirSync(f.dsh,{recursive:true});const link=path.join(f.dsh,'external');fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');
 const plan=migrationPlan(f.location,{legacyDshHome:f.dsh});await assert.rejects(prepareDataHome(plan,{checkIdle:async()=>{}}),error=>error.code==='DSH_EXTERNAL_LINK'&&error.message.includes(link)&&error.message.includes(fs.realpathSync(outside)));
 assert(!fs.existsSync(path.join(f.home,'.wechatagent-data.json')));assert(!fs.existsSync(path.join(f.home,'workspace')));
 assert((await prepareDataHome(retainDsh(plan),{checkIdle:async()=>{}})).migrated);
 const other=fixture(t),active=path.join(other.sourceRoot,'state/external');fs.symlinkSync(outside,active,process.platform==='win32'?'junction':'dir');
 await assert.rejects(prepareDataHome(retainDsh(migrationPlan(other.location,{legacyDshHome:other.dsh})),{checkIdle:async()=>{}}),error=>error.message.includes(active)&&error.code!=='DSH_EXTERNAL_LINK');
 assert(!fs.existsSync(path.join(other.home,'.wechatagent-data.json')));assert(fs.lstatSync(active).isSymbolicLink());
});

test('external-only distributions keep the actual bound DSH home without classifying it as bundled again',async t=>{
 const f=fixture(t),exe=path.join(f.old,'runtimes/old/dsh/Harness.exe');f.cfg.runtime.dshDesktop=exe;f.write(path.join(f.sourceRoot,'config/wechatagent.json'),f.cfg);f.write(path.join(f.dsh,'sessions/keep.txt'),'history');
 f.write(path.join(f.sourceRoot,'config/distribution.json'),{dshBundled:false,dsh:exe,dshHome:f.dsh,externalDshHome:path.join(f.base,'different default .dsh')});
 const plan=migrationPlan(f.location);assert.equal(plan.managedDsh,false);assert.equal(plan.migrateDsh,false);assert.equal(plan.oldDshHome,f.dsh);
 assert.deepEqual(deploymentStorageOptions(undefined,f.home),{});
 assert.equal(deploymentStorageOptions({source:f.old,dshCopied:true},f.home).dshHome,path.join(f.home,'dsh'));
 assert.equal(deploymentStorageOptions({source:f.old,managedDsh:false,dshCopied:false,oldDshHome:f.dsh},f.home).dshHome,undefined);
 const result=await prepareDataHome(plan,{checkIdle:async()=>{}});assert.equal(result.report.dshCopied,false);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.home,'workspace/config/wechatagent.json'))).runtime.dshDesktop,exe);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.home,'workspace/config/distribution.json'))).dsh,exe);
});

function backupLink(f,{missing=false,name='dsh-social-bridge-plugin.original-link',target}={}){
 const original=target||path.join(f.base,'developer checkout/packages/dsh-social-bridge-plugin');
 if(!missing)f.write(path.join(original,'must-not-be-copied.txt'),'outside the old data source');
 const file=path.join(f.old,'backups/before-0.3.6-repair-20261018/dsh',name);
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.symlinkSync(original,file,process.platform==='win32'?'junction':'dir');
 return {file,target:original,rawTarget:fs.readlinkSync(file)};
}

test('legacy plugin backup junctions migrate as reference metadata without copying or recreating the external directory',async t=>{
 const f=fixture(t),link=backupLink(f);f.write(path.join(f.old,'backups/owner-backup.json'),{keep:true});
 const before=fs.readFileSync(path.join(f.sourceRoot,'config/wechatagent.json'));
 const result=await prepareDataHome(migrationPlan(f.location,{legacyDshHome:f.dsh}),{checkIdle:async()=>{}});
 assert(result.migrated);assert.equal(result.report.archivedBackupLinks,1);
 const record=JSON.parse(fs.readFileSync(path.join(f.home,result.report.backupLinkFile)));
 assert.equal(record.policy,'reference-only');assert.equal(record.links[0].source,link.file);assert.equal(record.links[0].target,link.rawTarget);assert.equal(record.links[0].copiedTarget,false);
 assert(!fs.existsSync(path.join(f.home,'backups/before-0.3.6-repair-20261018/dsh/dsh-social-bridge-plugin.original-link')));
 assert.equal(fs.readlinkSync(link.file),link.rawTarget);assert(fs.existsSync(path.join(link.target,'must-not-be-copied.txt')));
 assert.deepEqual(fs.readFileSync(path.join(f.sourceRoot,'config/wechatagent.json')),before);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.home,'backups/owner-backup.json'))).keep,true);
});

test('a dangling legacy plugin backup reference is retained without reading its missing target',async t=>{
 const f=fixture(t),link=backupLink(f,{missing:true});assert(!fs.existsSync(link.target));
 const result=await prepareDataHome(migrationPlan(f.location,{legacyDshHome:f.dsh}),{checkIdle:async()=>{}});
 assert.equal(result.report.archivedBackupLinks,1);
 const record=JSON.parse(fs.readFileSync(path.join(f.home,result.report.backupLinkFile)));
 assert.equal(record.links[0].target,link.rawTarget);assert.equal(fs.readlinkSync(link.file),link.rawTarget);
});

test('unrecognized backup junctions and links in active user data still stop with the exact path and preserve the source',async t=>{
 for(const mode of ['unknown-name','wrong-target','active-data']){
  const f=fixture(t);let file;
  if(mode==='active-data'){const target=path.join(f.base,'external owner files');f.write(path.join(target,'keep.txt'),'keep');file=path.join(f.sourceRoot,'state/linked-media');fs.symlinkSync(target,file,process.platform==='win32'?'junction':'dir');}
  else file=backupLink(f,mode==='unknown-name'?{name:'unrecognized.original-link'}:{target:path.join(f.base,'external owner files')}).file;
  await assert.rejects(prepareDataHome(migrationPlan(f.location,{legacyDshHome:f.dsh}),{checkIdle:async()=>{}}),error=>error.message.includes(file)&&error.message.includes('目录联接'));
  assert(!fs.existsSync(path.join(f.home,'workspace')));assert(!fs.existsSync(path.join(f.home,'.wechatagent-data.json')));
  assert(fs.lstatSync(file).isSymbolicLink());assert(fs.existsSync(path.join(f.sourceRoot,'config/wechatagent.json')));
 }
});

test('changing a recognized backup link during copying cancels migration without committing the new data home',async t=>{
 const f=fixture(t),link=backupLink(f),replacement=path.join(f.base,'other checkout/packages/dsh-social-bridge-plugin');f.write(path.join(replacement,'keep.txt'),'keep');let checks=0;
 await assert.rejects(prepareDataHome(migrationPlan(f.location,{legacyDshHome:f.dsh}),{checkIdle:async()=>{
  if(++checks===2){fs.unlinkSync(link.file);fs.symlinkSync(replacement,link.file,process.platform==='win32'?'junction':'dir');}
 }}),error=>error.message.includes(link.file)&&error.message.includes('发生变化'));
 assert(!fs.existsSync(path.join(f.home,'.wechatagent-data.json')));assert(!fs.existsSync(path.join(f.home,'workspace')));
 assert(fs.existsSync(path.join(f.sourceRoot,'config/wechatagent.json')));assert.equal(path.resolve(fs.readlinkSync(link.file)),path.resolve(replacement));
});
