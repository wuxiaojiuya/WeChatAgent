import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {windowsPowerShellExecutable} from './console-process.mjs';

export const subprocess=(exe,args,options={})=>new Promise((resolve,reject)=>{
  const child=spawn(exe,args,{windowsHide:true,shell:false,stdio:'ignore',...options});
  child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('AUDIO_SUBPROCESS_FAILED')));
});
export async function prepareAudioBootstrap(root,notify,{fetchImpl=fetch,execute=subprocess}={}){
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'scripts/audio-runtime-manifest.json'),'utf8'));
  const spec=manifest.bootstrap,folder=path.join(root,'state/audio-install'),archive=path.join(folder,spec.file);
  fs.mkdirSync(folder,{recursive:true});
  const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  // Reverify the archive and recreate this small independent interpreter on every
  // operation. Repair never runs inside the environment it is replacing.
  if(!fs.existsSync(archive)||fs.statSync(archive).size!==spec.bytes||hash(archive)!==spec.sha256){
    notify({phase:'bootstrap',message:'正在准备独立安装工具'});
    const cached=path.join(root,'state/installer-cache',spec.file);
    if(fs.existsSync(cached)&&fs.statSync(cached).size===spec.bytes&&hash(cached)===spec.sha256)fs.copyFileSync(cached,archive);
    else{
      const response=await fetchImpl(manifest.baseUrl+spec.file,{signal:AbortSignal.timeout(180000)});
      if(!response.ok)throw Error('AUDIO_BOOTSTRAP_DOWNLOAD_FAILED');
      const temporary=archive+'.partial',fd=fs.openSync(temporary,'w');let total=0;
      try{for await(const chunk of response.body){total+=chunk.length;if(total>spec.bytes)throw Error('AUDIO_DOWNLOAD_TOO_LARGE');fs.writeSync(fd,chunk);notify({phase:'bootstrap',message:'正在下载独立安装工具',downloaded:total,total:spec.bytes});}}finally{fs.closeSync(fd);}
      if(total!==spec.bytes||hash(temporary)!==spec.sha256){fs.rmSync(temporary,{force:true});throw Error('AUDIO_DOWNLOAD_HASH_MISMATCH');}
      fs.renameSync(temporary,archive);
    }
  }
  const destination=path.join(folder,'bootstrap');
  if(fs.existsSync(destination)){if(fs.lstatSync(destination).isSymbolicLink())throw Error('AUDIO_TARGET_INVALID');fs.rmSync(destination,{recursive:true});}
  await execute(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/extract-audio-bootstrap.ps1'),'-Archive',archive,'-Destination',destination]);
  const python=path.join(destination,'python.exe');if(!fs.existsSync(python))throw Error('AUDIO_BOOTSTRAP_MISSING');return python;
}

export async function assertAudioProcessesStopped(root){
  await subprocess(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/audio-runtime-processes.ps1'),'-Runtime',path.join(root,'state/maintenance/audio-capabilities')]).catch(()=>{throw Error('AUDIO_SERVICES_RUNNING');});
}
