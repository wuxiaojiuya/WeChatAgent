import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
const fault=message=>Object.assign(Error(message),{status:502});
export function createDirectTts({root}){
  const runtime=path.join(root,'state/maintenance/audio-capabilities/feiyu-tts'),python=path.join(runtime,'venv/Scripts/python.exe');
  return {available:()=>fs.existsSync(python)&&fs.existsSync(path.join(runtime,'runtime.cpu.json')),
    async generate({text,voiceId,referenceSha256,emotion,emotionStrength,signal}){
      signal?.throwIfAborted();
      const directory=path.join(root,'state/voice-output/direct',crypto.randomUUID());fs.mkdirSync(directory,{recursive:true});
      const request=path.join(directory,'request.json'),output=path.join(directory,'output');
      fs.writeFileSync(request,JSON.stringify({text,voiceId,referenceSha256,emotion,emotionStrength,output_dir:output}),{flag:'wx',mode:0o600});
      const normalizer=JSON.parse(fs.readFileSync(path.join(runtime,'normalizer.json'),'utf8')).directory;
      await new Promise((resolve,reject)=>{
        const child=spawn(python,[path.join(root,'scripts/direct-tts-worker.py'),'--root',root,'--request',request],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONPATH:path.join(root,'scripts/feiyu-site'),WECHATAGENT_FEIYU_WETEXT:normalizer}});
        let log='',stopped=false;
        const stop=()=>{stopped=true;if(process.platform==='win32'&&child.pid){const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>child.kill());}else child.kill();};
        const timer=setTimeout(stop,180000);signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
        for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{log=(log+chunk.toString('utf8')).slice(-64000);});
        const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);fs.writeFileSync(path.join(directory,'inference.log'),log,{mode:0o600});};
        child.once('error',()=>{finish();reject(fault('本机 TTS 环境尚未准备，请在设置中安装或修复。'));});
        child.once('close',code=>{finish();if(stopped||code!==0)reject(fault(stopped?'语音合成已取消或超时。':'所选音色直接合成失败，请检查参考录音和本机 TTS 环境。'));else resolve();});
      });
      signal?.throwIfAborted();
      const receipt=JSON.parse(fs.readFileSync(path.join(output,'result.json'),'utf8')),audio=fs.readFileSync(path.join(output,'speech.wav'));
      if(receipt.status!=='success'||receipt.runtime_rvc!==false||receipt.voice_id!==voiceId||receipt.reference_sha256!==referenceSha256||audio.length>16*1024*1024||audio.toString('ascii',0,4)!=='RIFF'||crypto.createHash('sha256').update(audio).digest('hex')!==receipt.playback_sha256)throw fault('语音合成结果校验失败。');
      return {audio:audio.toString('base64'),mime:'audio/wav',sent:false,voiceId,directSynthesis:true,runtimeRvc:false,seconds:receipt.seconds};
    }};
}
