// Build from audited source, not a copy of the live workspace.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {buildIcons,embedExecutableIcon} from './build-icons.mjs';
import {singleDirectoryTemplate} from './installer-directory-page.mjs';
import {assertPluginHost} from './plugin-host-check.mjs';
const root=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url);
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'))),version=pkg.releaseVersion??pkg.version;
const stage=path.join(root,'state/installer-stage'),project=path.join(stage,'project'),app=path.join(stage,'app');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const audit=spawnSync(process.execPath,['scripts/public-source-check.mjs','--files'],{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});
if(audit.status!==0)throw Error(audit.stdout||audit.stderr);
const source=JSON.parse(audit.stdout);
for(const dir of [project,app]){if(!dir.startsWith(stage+path.sep))throw Error('INVALID_STAGE');fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});}
const copy=(from,to)=>{fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);};
const files=source.files;
for(const file of files)copy(path.join(root,file),path.join(project,file));
const supplier='components/supplier-hook/4.1.8.27';
const manifest=JSON.parse(fs.readFileSync(path.join(root,supplier,'files.sha256.json')));
for(const entry of manifest){
  if(!['libGLESv1.dll','x64 inject.exe'].includes(entry.file))throw Error('UNEXPECTED_HOOK_FILE');
  const relative=supplier+'/'+entry.file,bytes=fs.readFileSync(path.join(root,relative));
  if(bytes.length!==entry.bytes||sha(bytes)!==entry.sha256)throw Error('HOOK_INTEGRITY_FAILED');
  copy(path.join(root,relative),path.join(project,relative));files.push(relative);
}
const dependencies=path.join(root,'packages/dsh-social-bridge-plugin/node_modules');
if(!fs.existsSync(dependencies))throw Error('Install bridge dependencies first.');
fs.cpSync(dependencies,path.join(project,'packages/dsh-social-bridge-plugin/node_modules'),{recursive:true,filter:file=>!file.split(path.sep).some(name=>['.cache','.bin'].includes(name))});
const bundledDependencies=path.join(project,'packages/dsh-social-bridge-plugin/node_modules');
for(const entry of fs.readdirSync(bundledDependencies,{recursive:true}))if(fs.statSync(path.join(bundledDependencies,entry)).isFile())files.push('packages/dsh-social-bridge-plugin/node_modules/'+entry.replaceAll('\\','/'));
const template=path.join(project,'packages/dsh-social-bridge-plugin/cordis.patch.yml');
fs.writeFileSync(template,fs.readFileSync(template,'utf8').replace(/file:\/\/\/[^"'\r\n]*\/dsh-social-bridge-plugin\/([A-Za-z0-9_-]+\.mjs)(?:\?[^"'\r\n]*)?/g,'dsh-social-bridge-plugin/$1'));
await assertPluginHost(project,{compareRoot:root});
const runtime=path.join(stage,'runtime');fs.mkdirSync(runtime,{recursive:true});copy(process.execPath,path.join(runtime,'node.exe'));
if(!fs.existsSync(path.join(runtime,'python/python.exe')))throw Error('Run npm run installer:runtime first.');
if(!fs.existsSync(path.join(runtime,'NODE-LICENSE.txt')))throw Error('Node.js redistribution license missing; run installer:runtime.');
for(const name of ['package.json','main.cjs','preload.cjs','shutdown.cjs','storage-location.cjs','desktop-policy.cjs','deployment.cjs','appearance.cjs','loading-preload.cjs','loading.html','loading.css','loading.js'])copy(path.join(root,'apps/console-desktop',name),path.join(app,name));
fs.writeFileSync(path.join(app,'package.json'),JSON.stringify({name:'wechatagent',version,main:'main.cjs',author:'wuxiaojiuya',description:pkg.description,license:'SEE LICENSE.txt'}));
await buildIcons(root,app,require('sharp'));
copy(path.join(root,'LICENSE'),path.join(app,'LICENSE.txt'));copy(path.join(root,'LICENSES.md'),path.join(app,'THIRD-PARTY-NOTICES.txt'));
const sourceHashes=Object.fromEntries([...new Set(files)].sort().map(file=>[file,sha(fs.readFileSync(path.join(project,file)))]));
const desktopHashes=Object.fromEntries(fs.readdirSync(app).sort().map(file=>[file,sha(fs.readFileSync(path.join(app,file)))]));
const runtimeRevision=sha(Buffer.concat([fs.readFileSync(path.join(runtime,'node.exe')),fs.readFileSync(path.join(runtime,'python/DEPENDENCIES.json'))])).slice(0,12);
const buildId=sha(Buffer.from(JSON.stringify({sourceHashes,desktopHashes,runtimeRevision}))).slice(0,16),builtAt=new Date().toISOString();
const deployment={version,buildId,builtAt,runtimeRevision,wechatVersion:'4.1.8.27',hookBackend:'supplier-http',dshBundled:false,files:Object.keys(sourceHashes),sourceHashes,node:process.version,privateAccountDataBundled:false};
fs.writeFileSync(path.join(project,'deployment.json'),JSON.stringify(deployment,null,2));
const output=path.join(root,'release/installer');fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'VERIFICATION.json'),JSON.stringify({version,buildId,builtAt,wechatVersion:'4.1.8.27',privateAccountDataBundled:false},null,2));
const {build,Platform,Arch}=require('electron-builder');
const customNsis=path.join(stage,'nsis-template');fs.mkdirSync(customNsis,{recursive:true});
fs.cpSync(path.dirname(require.resolve('app-builder-lib/templates/nsis/installer.nsi')),customNsis,{recursive:true});
fs.writeFileSync(path.join(customNsis,'assistedInstaller.nsh'),singleDirectoryTemplate(fs.readFileSync(path.join(customNsis,'assistedInstaller.nsh'),'utf8')));
const multiUser=path.join(customNsis,'multiUser.nsh');
const lookup=/      System::Store S[\s\S]*?      System::Store L\r?\n/;
const multiUserSource=fs.readFileSync(multiUser,'utf8');if(!lookup.test(multiUserSource))throw Error('NSIS_PATH_TEMPLATE_CHANGED');
fs.writeFileSync(multiUser,multiUserSource.replace(lookup,'      # Keep current-user LocalAppData; avoid legacy System::Store.\n'));
const installUtil=path.join(customNsis,'include/installUtil.nsh');
fs.writeFileSync(installUtil,fs.readFileSync(installUtil,'utf8').replace('    StrCpy $0 "$0 --updated"','    # Preserve external application data during ordinary upgrades.'));
require('app-builder-lib/out/targets/nsis/nsisUtil').nsisTemplatesDir=customNsis;
process.env.ELECTRON_BUILDER_CACHE=path.join(root,'state/installer-cache/electron-builder');process.env.CSC_IDENTITY_AUTO_DISCOVERY='false';
await build({targets:Platform.WINDOWS.createTarget('nsis',Arch.x64),config:{
  appId:'io.github.wuxiaojiuya.wechatagent',productName:'WeChatAgent',artifactName:'WeChatAgent-Setup-'+version+'-${arch}.${ext}',
  directories:{app,output,buildResources:app},electronDist:path.join(root,'node_modules/electron/dist'),electronVersion:'41.1.1',
  asar:false,npmRebuild:false,files:['**/*'],extraResources:[{from:project,to:'project'},{from:runtime,to:'runtime',filter:['**/*','!**/__pycache__/**','!**/*.pyc']}],
  afterPack:async context=>embedExecutableIcon(path.join(context.appOutDir,'WeChatAgent.exe'),path.join(app,'icon.ico'),require('resedit')),
  win:{icon:path.join(app,'icon.ico'),signAndEditExecutable:false,requestedExecutionLevel:'asInvoker'},
  nsis:{include:path.join(root,'apps/console-desktop/installer-storage.nsh'),oneClick:false,perMachine:false,allowElevation:false,allowToChangeInstallationDirectory:true,createDesktopShortcut:true,createStartMenuShortcut:true,deleteAppDataOnUninstall:false,differentialPackage:false,runAfterFinish:false,installerLanguages:['zh_CN','en_US'],language:'2052',license:path.join(app,'LICENSE.txt')},compression:'normal',publish:null
}});
console.log('Supplier installer built: '+version);
