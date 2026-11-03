import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {mediaFfmpeg} from './media-tools.mjs';
const fault=(message,status=400)=>Object.assign(new Error(message),{status});
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
export const DEFAULT_VOICE='FeiyuVoice-RVC-v1';
export const GENTLE_VOICE='FeiyuVoice-gentle';

export function createVoiceProfiles({root,models,prepareReference}={}) {
  const directory=path.join(root,'state/voice-profiles'),tickets=new Map();
  const prepare=prepareReference??((input,output)=>new Promise((resolve,reject)=>{
    const runtime=path.join(root,'state/maintenance/audio-capabilities/feiyu-tts');
    const child=spawn(path.join(runtime,'venv/Scripts/python.exe'),[path.join(root,'scripts/voice-reference.py'),'--input',input,'--output',output,'--ffmpeg',mediaFfmpeg(root)],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});
    let data='';const timer=setTimeout(()=>child.kill(),30000);
    child.stdout.on('data',chunk=>{data=(data+chunk).slice(-10000);});child.stderr.on('data',()=>{});
    child.once('error',()=>{clearTimeout(timer);reject(fault('请先安装 TTS 环境，再上传参考录音。',503));});
    child.once('close',code=>{clearTimeout(timer);if(code!==0)return reject(fault('参考录音需为 3～30 秒、清晰无伴奏的正常人声。'));try{resolve(JSON.parse(data));}catch{reject(fault('参考录音检查失败。'));}});
  }));
  function list(){
    const profiles=fs.existsSync(directory)?fs.readdirSync(directory).filter(uuid).flatMap(key=>{
      try{const value=JSON.parse(fs.readFileSync(path.join(directory,key,'voice.json'),'utf8'));
        return value.id===key&&fs.existsSync(path.join(directory,key,'reference.wav'))?[{...value,directory:path.join(directory,key),ttsReady:true}]:[];
      }catch{return [];}
    }):[];
    return [{id:DEFAULT_VOICE,name:'肥鱼 · 可爱',builtin:true,style:'cute',ttsReady:true,rvcModelId:DEFAULT_VOICE},
      {id:GENTLE_VOICE,name:'肥鱼 · 温柔',builtin:true,style:'gentle',ttsReady:true,rvcModelId:DEFAULT_VOICE},...profiles,
      ...models.list().filter(model=>!model.builtin&&!profiles.some(profile=>profile.id===model.id||profile.rvcModelId===model.id)).map(model=>({id:model.id,name:model.name,builtin:false,ttsReady:false,rvcModelId:model.id}))];
  }
  const get=key=>list().find(profile=>profile.id===key);
  async function upload(stream,{name}={}){
    if(typeof name!=='string'||!/^.+\.(wav|mp3|flac|m4a|ogg)$/i.test(name))throw fault('请选择 WAV、MP3、FLAC、M4A 或 OGG 参考录音。');
    const uploads=path.join(directory,'uploads');fs.mkdirSync(uploads,{recursive:true});
    for(const [key,value]of tickets)if(Date.now()-value.time>3600000){fs.rmSync(value.file,{force:true});tickets.delete(key);}
    const key=crypto.randomUUID(),input=path.join(uploads,key+path.extname(name).toLowerCase()),file=path.join(uploads,key+'.normalized.wav');
    const fd=fs.openSync(input,'wx',0o600);let size=0;
    try{for await(const chunk of stream){size+=chunk.length;if(size>20*1024*1024)throw fault('参考录音最大 20 MB。',413);fs.writeSync(fd,chunk);}}
    catch(error){fs.closeSync(fd);fs.rmSync(input,{force:true});throw error;}fs.closeSync(fd);
    try{if(!size)throw fault('参考录音为空。');const info=await prepare(input,file);tickets.set(key,{file,info,time:Date.now()});return {uploadId:key,seconds:info.seconds};}
    catch(error){fs.rmSync(file,{force:true});throw error;}finally{fs.rmSync(input,{force:true});}
  }
  function add(body){
    const existing=body?.existingVoiceId?get(body.existingVoiceId):null;
    if(body?.existingVoiceId&&(!existing||existing.builtin))throw fault('请选择已有的自定义音色。');
    const ticket=tickets.get(body?.referenceUploadId),text=body?.referenceText?.trim()||(ticket?'':existing?.referenceText),name=body?.name?.trim();
    if((!ticket&&!existing?.ttsReady)||body?.referenceUploadId&&!ticket||typeof text!=='string'||!text||text.length>500||/[\0<>]/.test(text)||typeof name!=='string'||!name||name.length>80||/[\r\n\0]/.test(name))throw fault('请上传参考录音，填写音色名称及录音中准确的文字。');
    if(body.indexUploadId&&!body.modelUploadId)throw fault('索引需要配套的 RVC 模型。');
    let model=existing?.rvcModelId?models.get(existing.rvcModelId):null;
    if(body.modelUploadId)model=models.add(body);
    const key=existing?.id??model?.id??crypto.randomUUID(),target=path.join(directory,key);
    fs.mkdirSync(target,{recursive:true});
    const value={id:key,name,builtin:false,rvcModelId:model?.id??'',referenceText:text,referenceSha256:ticket?crypto.createHash('sha256').update(fs.readFileSync(ticket.file)).digest('hex'):existing.referenceSha256,seconds:ticket?.info.seconds??existing.seconds};
    // The metadata is the commit point; an interrupted update fails its hash check.
    if(ticket)fs.copyFileSync(ticket.file,path.join(target,'reference.wav'));
    const temporary=path.join(target,crypto.randomUUID()+'.tmp');fs.writeFileSync(temporary,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});fs.renameSync(temporary,path.join(target,'voice.json'));
    if(ticket){fs.unlinkSync(ticket.file);tickets.delete(body.referenceUploadId);}return {...value,ttsReady:true};
  }
  return {list,get,upload,add,publicList:()=>list().map(({directory,referenceText,referenceSha256,...value})=>value),close(){for(const ticket of tickets.values())fs.rmSync(ticket.file,{force:true});tickets.clear();}};
}
