import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {prepareAudioBootstrap,assertAudioProcessesStopped} from './audio-bootstrap.mjs';

const fault=(message,status=400)=>Object.assign(Error(message),{status});
const kinds={tts:'feiyu-tts',rvc:'feiyu-cover'};
const messages={AUDIO_DISK_SPACE_LOW:'可用磁盘空间不足，请至少保留 20 GB 后重试。',AUDIO_DOWNLOAD_HASH_MISMATCH:'下载文件校验失败，请重试。',AUDIO_REPAIR_REQUIRED:'现有环境未通过检查，请点击一键修复。',AUDIO_SERVICES_RUNNING:'请先停止助手及本地音频服务，再安装或修复。',AUDIO_SUBPROCESS_FAILED:'官方源码、模型下载或推理验证失败，请查看本机安装日志。',AUDIO_MODEL_HASH_MISMATCH:'模型未通过官方摘要校验，请重试修复。'};
const listening=port=>new Promise(resolve=>{const s=net.connect({host:'127.0.0.1',port});const finish=value=>{s.destroy();resolve(value);};s.once('connect',()=>finish(true));s.once('error',()=>finish(false));s.setTimeout(500,()=>finish(false));});

export function createAudioRuntimeInstaller({root,launch=spawn,platform=process.platform,arch=process.arch,portProbe=listening,bootstrap=prepareAudioBootstrap,processCheck=assertAudioProcessesStopped}={}){
  const folder=path.join(root,'state/audio-install'),lock=path.join(folder,'operation.lock'),stateFile=path.join(folder,'last-job.json');
  let job=null,child=null,busy=false,closed=false;
  try{job=JSON.parse(fs.readFileSync(stateFile,'utf8'));if(job.state==='running')job={...job,state:'interrupted',message:'上次操作中断。重新安装或修复可继续下载，并恢复未完成的启用操作。'};}catch{}
  const save=()=>{fs.mkdirSync(folder,{recursive:true});const tmp=stateFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify(job),{mode:0o600});fs.renameSync(tmp,stateFile);};
  function status(){
    const environments=Object.entries(kinds).map(([kind,name])=>{
      const target=path.join(root,'state/maintenance/audio-capabilities',name);let installed=null;
      try{installed=JSON.parse(fs.readFileSync(path.join(target,'installed.json'),'utf8'));}catch{}
      const present=fs.existsSync(path.join(target,'venv/Scripts/python.exe'))&&fs.existsSync(path.join(target,'runtime.cpu.json'));
      return {kind,name:kind==='tts'?'TTS 语音回复':'RVC 歌曲翻唱',present,verifiedAt:present?installed?.verifiedAt??null:null,version:installed?.version??null,label:present?installed?'已安装 · 可检查':'已有环境 · 待检查':'尚未安装'};
    });
    return {supported:platform==='win32'&&arch==='x64',busy,job,environments,modelsFromOfficial:true};
  }
  function notify(e){
    if(!busy||typeof e.phase!=='string'||typeof e.message!=='string')return;
    job.phase=e.phase;job.message=e.message.slice(0,300);
    if(/^AUDIO_[A-Z_]+$/.test(e.code??''))job.code=e.code;
    if(Number.isSafeInteger(e.downloaded)&&Number.isSafeInteger(e.total)){job.downloaded=e.downloaded;job.total=e.total;}else{delete job.downloaded;delete job.total;}
    if(e.preview&&typeof e.preview==='string'&&path.resolve(e.preview).startsWith(path.join(root,'state/audio-install/previews')+path.sep))job.preview=e.preview;
    if(e.phase!=='download'&&e.phase!=='bootstrap'||job.events.at(-1)?.phase!==e.phase)job.events=[...job.events,{phase:job.phase,message:job.message,at:Date.now()}].slice(-15);
    save();
  }
  function finish(code,error){
    if(!busy)return;child=null;busy=false;
    if(/^AUDIO_[A-Z_]+$/.test(error?.message??''))job.code=error.message;
    job.state=code===0?'success':'failed';job.finishedAt=Date.now();
    job.message=code===0?(job.action==='check'?'环境检查通过。':'音频环境及本地音频验证完成。'):messages[job.code]??'操作未完成，请查看 state/audio-install 中的本机日志后重试。';
    save();try{fs.unlinkSync(lock);}catch{}
  }
  async function work(body){
    try{
      if(body.action!=='check'){
        if(await portProbe(9880)||await portProbe(9881))throw Error('AUDIO_SERVICES_RUNNING');
        await processCheck(root);
      }
      const python=await bootstrap(root,notify);if(closed)throw Error('AUDIO_INSTALL_INTERRUPTED');
      let buffer='';
      child=launch(python,['-B',path.join(root,'scripts/install-audio-runtime.py'),'--root',root,'--kind',body.kind,'--action',body.action],{cwd:root,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',PYTHONUNBUFFERED:'1',WECHATAGENT_INSTALL_NODE:process.execPath}});
      if(Number.isSafeInteger(child.pid))fs.writeFileSync(lock,JSON.stringify({pid:process.pid,workerPid:child.pid,root}),{mode:0o600});
      child.stdout.setEncoding('utf8');child.stdout.on('data',data=>{
        buffer=(buffer+data).slice(-65536);let end;
        while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{notify(JSON.parse(line));}catch{}}
      });
      child.stderr.on('data',()=>{});child.once('error',error=>finish(1,error));child.once('close',code=>finish(code));
    }catch(error){finish(1,error);}
  }
  async function start(body){
    if(closed)throw fault('音频安装服务已关闭。',503);
    if(!body||Object.keys(body).some(k=>!['kind','action'].includes(k))||!['all','tts','rvc'].includes(body.kind)||!['install','repair','check'].includes(body.action))throw fault('请选择有效的音频环境和操作。');
    if(platform!=='win32'||arch!=='x64')throw fault('一键安装目前支持 Windows x64 CPU。');
    if(busy)throw fault('已有音频环境操作正在执行，请等待完成。',409);
    fs.mkdirSync(folder,{recursive:true});
    try{
      if(fs.existsSync(lock)){
        const prior=JSON.parse(fs.readFileSync(lock,'utf8'));let alive=false;
        if(!Number.isSafeInteger(prior.pid)||prior.pid<=0)throw fault('安装锁无效，请检查本机日志。',409);
        for(const pid of [prior.pid,prior.workerPid].filter(pid=>Number.isSafeInteger(pid)&&pid>0)){
          try{process.kill(pid,0);alive=true;}catch(error){if(error.code!=='ESRCH')alive=true;}
        }
        if(alive)throw fault('另一控制台正在操作音频环境，请等待完成。',409);
        fs.unlinkSync(lock);
      }
      fs.writeFileSync(lock,JSON.stringify({pid:process.pid,root}),{flag:'wx',mode:0o600});
    }catch(error){if(error.status)throw error;throw fault('无法取得安装锁，请检查数据目录权限。',409);}
    busy=true;job={id:crypto.randomUUID(),kind:body.kind,action:body.action,state:'running',phase:'starting',message:'正在准备音频环境操作',startedAt:Date.now(),events:[]};save();
    void work(body);return status();
  }
  return {status,start,isBusy:()=>busy,close(){closed=true;if(child)child.kill();}};
}
