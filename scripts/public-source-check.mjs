import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {SOURCE_PLUGIN_ZIPS,verifySourcePluginZip,assertSourceHostCoverage} from './source-release-policy.mjs';
import {assertPluginHost} from './plugin-host-check.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
await assertPluginHost(root);
const git=spawnSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8'});
if(git.status!==0)throw new Error('Cannot enumerate source candidates; run this check in the Git checkout');
const files=[...new Set(git.stdout.split('\0').filter(Boolean))];
assertSourceHostCoverage(root,files);
const findings=[];let bytes=0;
const banned=/(^|\/)(state|release|node_modules|\.local-state|\.git|\.venv|venv)\/|(^|\/)wechatagent\.json$|wechatagent\.pre-|(^|\/)\.env(?:\.[^/]+)?$|\.(?:exe|dll|node|pdb|obj|lib|so|dylib|db|sqlite3?|pfx|pem|key|log|bak|pyc|zip|7z|rar)$/i;
const example=/\.env\.(?:example|sample|template)$/;
const privatePlugins=/^(?:plugins\/|config\/(?:plugins|extensions)\.json$|config\/extensions\.pre-)/i;
const checks=[
 ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
 ['credential-url',/https?:\/\/[^\s/@:]+:[^\s/@]+@/],
 ['api-key',/\bsk-(?!example|placeholder|test)[A-Za-z0-9_-]{20,}\b/],
 ['developer-home',/[A-Z]:[\\/]Users[\\/](?!Public[\\/]|<|YOUR_)[^\s<>"']+[\\/]/i],
 ['developer-checkout',/[A-Z]:[\\/]Transfer[\\/]DeepSeek[\\/]/i]
];
function scanText(relative,text){for(const [kind,regex]of checks)if(regex.test(text))findings.push({file:relative,kind});}
for(const relative of files){
 const file=path.join(root,relative),stat=fs.lstatSync(file,{throwIfNoEntry:false});if(!stat)continue;
 if(!stat.isFile()||stat.isSymbolicLink()){findings.push({file:relative,kind:'source-link-or-special-file'});continue;}
 bytes+=stat.size;
 if(SOURCE_PLUGIN_ZIPS.includes(relative)){
  try{const checked=verifySourcePluginZip(root,fs.readFileSync(file),relative);for(const entry of checked.entries)scanText(relative+'!/'+entry.name,entry.data.toString('utf8'));}
  catch{findings.push({file:relative,kind:'first-party-plugin-zip-invalid-or-stale'});}
  continue;
 }
 if((banned.test(relative)||privatePlugins.test(relative))&&!example.test(relative)){findings.push({file:relative,kind:'excluded-file'});continue;}
 if(stat.size>100*1024*1024){findings.push({file:relative,kind:'github-file-limit'});continue;}
 scanText(relative,fs.readFileSync(file,'utf8'));
}
console.log(JSON.stringify({candidateFiles:files.length,sourceBytes:bytes,findings,...(process.argv.includes('--files')?{files:files.filter(name=>fs.existsSync(path.join(root,name))&&fs.lstatSync(path.join(root,name)).isFile()).sort()}:{})},null,2));
if(findings.length)process.exitCode=1;
