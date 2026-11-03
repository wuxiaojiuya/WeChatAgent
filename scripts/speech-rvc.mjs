import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
const fault=message=>Object.assign(Error(message),{status:502});
const sha=audio=>crypto.createHash('sha256').update(audio).digest('hex');

export function createSpeechRvc({root,models}){
  const runtime=path.join(root,'state/maintenance/audio-capabilities/feiyu-cover'),python=path.join(runtime,'venv/Scripts/python.exe');
  return {
    available:()=>fs.existsSync(python)&&fs.existsSync(path.join(runtime,'runtime.cpu.json')),
    async convert({audio,modelId,signal}){
      signal?.throwIfAborted();
      const model=models.get(modelId);
      if(!model)throw fault('所选音色的 RVC 模型不存在，请重新上传或选择音色。');
      if(!Buffer.isBuffer(audio)||audio.length>16*1024*1024||audio.toString('ascii',0,4)!=='RIFF')throw fault('基础语音格式无效，未执行换声。');
      const modelHash=model.builtin?JSON.parse(fs.readFileSync(path.join(model.directory,'manifest.json'),'utf8')).model.pth_sha256:model.modelSha256;
      const directory=path.join(root,'state/voice-output/converted',crypto.randomUUID());fs.mkdirSync(directory,{recursive:true});
      const input=path.join(directory,'source.wav'),output=path.join(directory,'output');
      fs.writeFileSync(input,audio,{flag:'wx',mode:0o600});
      await new Promise((resolve,reject)=>{
        const child=spawn(python,[path.join(root,'scripts/speech-rvc-worker.py'),'--model',model.directory,'--profile',path.join(runtime,'runtime.cpu.json'),'--input',input,'--output-dir',output],
          {windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8',PATH:[path.join(runtime,'git/cmd'),path.join(runtime,'tools/mingit/cmd'),process.env.PATH??''].join(path.delimiter)}});
        let log='',stopped=false;
        const stop=()=>{stopped=true;if(process.platform==='win32'&&child.pid){const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>child.kill());}else child.kill();};
        const timer=setTimeout(stop,180000);signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
        for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{log=(log+chunk.toString('utf8')).slice(-64000);});
        const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);fs.writeFileSync(path.join(directory,'inference.log'),log,{mode:0o600});};
        child.once('error',()=>{finish();reject(fault('RVC 换声环境不可用，请在设置中安装或修复。'));});
        child.once('close',code=>{finish();if(stopped||code!==0)reject(fault(stopped?'语音换声已取消或超时。':'语音换声失败，请检查所选 RVC 模型与本机环境。'));else resolve();});
      });
      signal?.throwIfAborted();
      const receipt=JSON.parse(fs.readFileSync(path.join(output,'result.json'),'utf8')),converted=fs.readFileSync(path.join(output,'speech.wav'));
      if(receipt.status!=='success'||receipt.runtime_rvc!==true||receipt.model_sha256!==modelHash||receipt.source_sha256!==sha(audio)||receipt.output_sha256!==sha(converted)||converted.length>16*1024*1024||converted.toString('ascii',0,4)!=='RIFF')throw fault('换声音频校验失败，未返回基础音色。');
      return {audio:converted.toString('base64'),mime:'audio/wav',runtimeRvc:true,directSynthesis:false,modelId,seconds:receipt.seconds,sent:false};
    },
  };
}
