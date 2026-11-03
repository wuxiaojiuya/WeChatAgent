import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
const fault=(message,status=400)=>Object.assign(new Error(message),{status});
const id=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
export function createRvcModels({root,inspectAsset}={}) {
  const directory=path.join(root,'state','rvc-models'),uploads=path.join(directory,'uploads');
  const runtime=path.join(root,'state','maintenance','audio-capabilities','feiyu-cover');
  const tickets=new Map();
  const inspect=inspectAsset??((kind,file)=>new Promise((resolve,reject)=>{
    const child=spawn(path.join(runtime,'venv','Scripts','python.exe'),[path.join(root,'scripts','rvc-inspect.py'),'--kind',kind,'--input',file],
      {windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});
    let output='';const timer=setTimeout(()=>child.kill(),30000);
    child.stdout.on('data',data=>{output=(output+data.toString()).slice(-10000);});child.stderr.on('data',()=>{});
    child.once('error',()=>{clearTimeout(timer);reject(fault('模型检查环境尚未准备。',503));});
    child.once('close',code=>{clearTimeout(timer);if(code!==0)return reject(fault(kind==='pth'?'无法识别这个 RVC 推理模型，请上传导出的 .pth 权重。':'无法识别这个 RVC 索引文件。'));try{resolve(JSON.parse(output));}catch{reject(fault('模型检查结果无效。'));}});
  }));
  function list() {
    const builtin={id:'FeiyuVoice-RVC-v1',name:'肥鱼 · 默认音色',builtin:true,version:'v2',sampleRate:40000,
      hasIndex:true,directory:path.join(runtime,'models','FeiyuVoice-RVC')};
    const custom=fs.existsSync(directory)?fs.readdirSync(directory).filter(id).flatMap(key=>{
      try{const value=JSON.parse(fs.readFileSync(path.join(directory,key,'model.json'),'utf8'));
        return value.id===key&&fs.existsSync(path.join(directory,key,'model.pth'))?[{...value,directory:path.join(directory,key)}]:[];
      }catch{return [];}
    }):[];
    return [builtin,...custom];
  }
  async function upload(stream,{kind,name}={}) {
    if(!['pth','index'].includes(kind)||typeof name!=='string'||!name.toLowerCase().endsWith('.'+kind))throw fault('请选择 .pth 模型文件或 .index 索引文件。');
    fs.mkdirSync(uploads,{recursive:true});
    for(const [key,ticket]of tickets)if(Date.now()-ticket.time>3600000){fs.rmSync(ticket.file,{force:true});tickets.delete(key);}
    const key=crypto.randomUUID(),file=path.join(uploads,key+'.'+kind),max=(kind==='pth'?512:256)*1024*1024;
    const fd=fs.openSync(file,'wx',0o600);let size=0;
    try{
      for await(const chunk of stream){size+=chunk.length;if(size>max)throw fault('模型文件超过大小限制。',413);fs.writeSync(fd,chunk);}
    }catch(error){fs.closeSync(fd);fs.rmSync(file,{force:true});throw error;}
    fs.closeSync(fd);
    try{if(!size)throw fault('上传文件为空。');const info=await inspect(kind,file);tickets.set(key,{kind,file,info,time:Date.now()});return {uploadId:key,kind,size,info};}
    catch(error){fs.rmSync(file,{force:true});throw error;}
  }
  function add(body) {
    const model=tickets.get(body?.modelUploadId),index=body?.indexUploadId?tickets.get(body.indexUploadId):null;
    if(!model||model.kind!=='pth'||body.indexUploadId&&(!index||index.kind!=='index')||typeof body.name!=='string'||!body.name.trim()||body.name.length>80||/[\r\n\0]/.test(body.name))throw fault('请上传模型并填写音色名称。');
    if(index&&index.info.dimension!==model.info.dimension)throw fault('索引维度与模型版本不匹配，请上传同一个音色的索引。');
    const key=crypto.randomUUID(),target=path.join(directory,key);fs.mkdirSync(target);
    try{
      fs.copyFileSync(model.file,path.join(target,'model.pth'));if(index)fs.copyFileSync(index.file,path.join(target,'model.index'));
      const value={id:key,name:body.name.trim(),builtin:false,...model.info,modelSha256:model.info.sha256,
        hasIndex:!!index,indexSha256:index?.info.sha256??null,addedAt:new Date().toISOString()};
      fs.writeFileSync(path.join(target,'model.json'),JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
      fs.unlinkSync(model.file);tickets.delete(body.modelUploadId);if(index){fs.unlinkSync(index.file);tickets.delete(body.indexUploadId);}
      return value;
    }catch(error){fs.rmSync(target,{recursive:true,force:true});throw error;}
  }
  return {list,get:key=>list().find(model=>model.id===key),upload,add,
    publicList:()=>list().map(({directory,...value})=>value),
    close(){for(const ticket of tickets.values())fs.rmSync(ticket.file,{force:true});tickets.clear();}};
}
