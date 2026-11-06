import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {packZip} from '../packages/plugin-api/zip.mjs';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const root=path.resolve(import.meta.dirname,'..'),pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'))),version=pkg.releaseVersion??pkg.version;
const output=path.join(root,'release/installer'),prefix='WeChatAgent-'+version;
const files=['components/supplier-hook/4.1.8.27/files.sha256.json','components/supplier-hook/4.1.8.27/libGLESv1.dll','components/supplier-hook/4.1.8.27/x64 inject.exe','components/supplier-hook/README.md','docs/SUPPLIER_HOOK_41827.md'];
const entries=files.map(name=>({name,data:fs.readFileSync(path.join(root,name))}));
const zip=packZip(entries),hookName=prefix+'-hook-4.1.8.27.zip';
fs.writeFileSync(path.join(output,hookName),zip);
const checked=spawnSync(createRequire(import.meta.url)('7zip-bin').path7za,['t',path.join(output,hookName)],{windowsHide:true,encoding:'utf8'});
if(checked.status!==0)throw Error('HOOK_ARCHIVE_VERIFICATION_FAILED');
const assets=['WeChatAgent-Setup-'+version+'-x64.exe',prefix+'-source.zip',hookName,'VERIFICATION.json'];
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for(const name of assets)if(!fs.existsSync(path.join(output,name)))throw Error('RELEASE_ASSET_MISSING: '+name);
const manifest=JSON.parse(fs.readFileSync(path.join(output,'VERIFICATION.json')));
if(manifest.version!==version||!/^[a-f0-9]{16}$/.test(manifest.buildId)||manifest.privateAccountDataBundled!==false)throw Error('RELEASE_METADATA_INVALID');
const report=JSON.parse(fs.readFileSync(path.join(root,'state/source-release-'+version+'.json')));
if(report.version!==version)throw Error('SOURCE_VERSION_MISMATCH');
for(const [relative,expected]of Object.entries(report.sourceFiles))if(sha(path.join(root,relative))!==expected)throw Error('SOURCE_CHANGED_AFTER_PACKAGING: '+relative);
if(sha(path.join(root,report.asset.path))!==report.asset.sha256)throw Error('SOURCE_ARCHIVE_CHANGED');
let packagedFiles=0;
for(const directory of [path.join(root,'state/installer-stage/project'),path.join(output,'win-unpacked/resources/project')]){
  const deployment=JSON.parse(fs.readFileSync(path.join(directory,'deployment.json')));
  if(deployment.version!==version||deployment.buildId!==manifest.buildId||deployment.hookBackend!=='supplier-http'||deployment.wechatVersion!=='4.1.8.27'||deployment.privateAccountDataBundled!==false)throw Error('PACKAGED_DEPLOYMENT_MISMATCH');
  const packaged=JSON.parse(fs.readFileSync(path.join(directory,'package.json')));
  if(packaged.version!==version||packaged.releaseVersion!==version)throw Error('PACKAGED_VERSION_MISMATCH');
  for(const [relative,expected]of Object.entries(deployment.sourceHashes)){
    if(path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..')||/^(?:state|release)\//.test(relative)||relative==='config/wechatagent.json')throw Error('PACKAGED_PRIVATE_PATH_REJECTED');
    if(sha(path.join(directory,relative))!==expected)throw Error('PACKAGED_HASH_MISMATCH: '+relative);
    packagedFiles++;
  }
  for(const relative of ['state','config/wechatagent.json','config/plugins.json','config/extensions.json'])if(fs.existsSync(path.join(directory,relative)))throw Error('PACKAGED_PRIVATE_DATA_REJECTED');
  for(const relative of ['scripts/audio-runtime-installer.mjs','scripts/install-audio-runtime.py','scripts/audio-runtime-manifest.json','public/console/audio-runtime.js','docs/AUDIO_INSTALLER.md',
    'scripts/voice-profiles.mjs','scripts/voice-reference.py','scripts/direct-tts.mjs','scripts/direct-tts-worker.py','scripts/feiyu_voice_reference.py','public/console/voice-profiles.js',
    'scripts/speech-rvc.mjs','scripts/speech-rvc-worker.py','scripts/music-rvc-worker.py',
    'scripts/wechat_video.py','scripts/douyin_video.py','scripts/media_tools.py','scripts/media-tools.mjs','scripts/music-capabilities.mjs','docs/VIDEO_SINGING.md'])if(!deployment.sourceHashes[relative])throw Error('AUDIO_OR_VIDEO_FEATURE_NOT_PACKAGED: '+relative);
  for(const relative of ['scripts/supplier_images.py','components/qq-bridge/src/core/image-context.js','components/qq-bridge/src/core/live-settings.js',
    'scripts/dsh-refresh.mjs','packages/dsh-social-bridge-plugin/console-client.mjs','docs/IMAGE_INPUT.md','docs/LIVE_SETTINGS.md'])if(!deployment.sourceHashes[relative])throw Error('IMAGE_OR_LIVE_SETTINGS_FEATURE_NOT_PACKAGED: '+relative);
}
const desktop=JSON.parse(fs.readFileSync(path.join(output,'win-unpacked/resources/app/package.json')));
if(desktop.version!==version)throw Error('DESKTOP_VERSION_MISMATCH');
const runtimeProbe=spawnSync(path.join(output,'win-unpacked/resources/runtime/python/python.exe'),['-B','-c',
  'import yt_dlp,imageio_ffmpeg,subprocess,sqlcipher3,PIL; subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),"-version"],check=True,capture_output=True); print("PACKAGED_MEDIA_RUNTIME_OK")'],{windowsHide:true,encoding:'utf8',timeout:30000});
if(runtimeProbe.status!==0)throw Error('PACKAGED_MEDIA_RUNTIME_INVALID');
const installationProbe=spawnSync(process.execPath,[path.join(root,'scripts/verify-supplier-installation.mjs')],{cwd:root,windowsHide:true,encoding:'utf8',timeout:120000});
if(installationProbe.status!==0)throw Error('INSTALLED_FIRST_RUN_CHECK_FAILED: '+installationProbe.stdout+'\n'+installationProbe.stderr);
const installedChecks=JSON.parse(installationProbe.stdout.trim());
const binary=fs.readFileSync(path.join(output,assets[0])),pe=binary.readUInt32LE(0x3c);
if(binary.toString('ascii',0,2)!=='MZ'||binary.readUInt32LE(pe)!==0x4550)throw Error('INSTALLER_PE_INVALID');
const identity=spawnSync('git',['rev-parse','HEAD'],{cwd:root,windowsHide:true,encoding:'utf8'});
if(identity.status!==0)throw Error('SOURCE_REVISION_UNAVAILABLE');
Object.assign(manifest,{ok:true,checkedAt:new Date().toISOString(),sourceRevision:identity.stdout.trim(),sourceFilesVerified:Object.keys(report.sourceFiles).length,packagedFileCopiesVerified:packagedFiles,installedChecks,
  assets:assets.filter(name=>name!=='VERIFICATION.json').map(name=>({name,bytes:fs.statSync(path.join(output,name)).size,sha256:sha(path.join(output,name))})),
  validationLimits:['Packaged source/resource hashes and executable headers verified; the installer has not been installed on another physical computer.','Audio environment installation/repair and local TTS/RVC pipeline checks were performed separately with verified cached official models; full first-time model downloads require access to official sources.','Video singing was tested using synthetic media; the supplied live Douyin link requires fresh cookies and has not completed real download/cover validation.'],packagedMediaRuntimeVerified:true,servicesRestarted:false,realWeChatMessagesSent:false});
fs.writeFileSync(path.join(output,'VERIFICATION.json'),JSON.stringify(manifest,null,2)+'\n');
const sums=assets.map(name=>sha(path.join(output,name))+'  '+name).join('\n')+'\n';
fs.writeFileSync(path.join(output,'SHA256SUMS.txt'),sums);
console.log(JSON.stringify({version,assets:assets.map(name=>({name,bytes:fs.statSync(path.join(output,name)).size,sha256:sha(path.join(output,name))}))},null,2));
