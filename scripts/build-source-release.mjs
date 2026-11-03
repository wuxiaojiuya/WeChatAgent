import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {packZip} from '../packages/plugin-api/zip.mjs';
import {BUNDLED_PLUGINS} from '../packages/plugin-api/bundled.mjs';
import {assertPluginHost} from './plugin-host-check.mjs';
import {assertSourceHostCoverage} from './source-release-policy.mjs';
import {releaseIdentity} from './release-version.mjs';

const root=path.resolve(import.meta.dirname,'..');
const checked=await assertPluginHost(root);
const audit=spawnSync(process.execPath,[path.join(root,'scripts/public-source-check.mjs'),'--files'],{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024,windowsHide:true});
if(audit.status!==0)throw Error('SOURCE_RELEASE_CHECK_FAILED: '+(audit.stdout||audit.stderr));
const source=JSON.parse(audit.stdout);if(source.findings.length)throw Error('SOURCE_RELEASE_PRIVATE_FILES_REJECTED');
assertSourceHostCoverage(root,source.files);
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const {version,packageVersion,tag}=releaseIdentity(JSON.parse(fs.readFileSync(path.join(root,'package.json'))));
const output=path.join(root,'release/installer/WeChatAgent-'+version+'-source.zip');
const stageManifest=path.join(root,'state/installer-stage/project/deployment.json');
const deployment=fs.existsSync(stageManifest)?JSON.parse(fs.readFileSync(stageManifest)):{};
const profileFile=path.join(root,'release-profile.json');
if(fs.existsSync(profileFile)){
  const profile=JSON.parse(fs.readFileSync(profileFile,'utf8'));
  Object.assign(profile,{version,packageVersion,suggestedTag:tag});
  profile.sourceFileHashes=Object.fromEntries(source.files.filter(file=>!(profile.hashesExclude??['release-profile.json']).includes(file)).map(file=>[file,hash(fs.readFileSync(path.join(root,file)))]));
  profile.sourcePluginPackages=BUNDLED_PLUGINS.filter(item=>item.zip).map(item=>item.zip);
  profile.pluginHostContract=checked.contract;
  if(deployment.buildId){profile.buildId=deployment.buildId;profile.runtimeRevision=deployment.runtimeRevision;}
  fs.writeFileSync(profileFile,JSON.stringify(profile,null,2)+'\n');
}
const entries=source.files.map(name=>({name,data:fs.readFileSync(path.join(root,name))}));
// The standard ZIP serializer is reusable; plugin import limits remain unchanged.
const archive=packZip(entries);fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,archive);
const digest=hash(archive);fs.writeFileSync(output+'.sha256',digest+'  '+path.basename(output)+'\n');
const report={version,packageVersion,ok:true,sourceOnly:true,pluginHost:checked.contract,files:entries.length,sourceFiles:Object.fromEntries(entries.map(file=>[file.name,hash(file.data)])),asset:{path:path.relative(root,output).replaceAll(path.sep,'/'),bytes:archive.length,sha256:digest}};
fs.mkdirSync(path.join(root,'state'),{recursive:true});fs.writeFileSync(path.join(root,'state/source-release-'+version+'.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({ok:true,files:entries.length,bytes:archive.length,sha256:digest,output}));
