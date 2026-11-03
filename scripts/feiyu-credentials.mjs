import fs from 'node:fs';
import path from 'node:path';

export function managedFeiyuEndpoint(value){
  try{
    const url=new URL(value);
    return url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)&&url.port==='9880'&&url.pathname==='/'&&!url.username&&!url.password&&!url.search&&!url.hash;
  }catch{return false;}
}

// Match the managed service's data_dir resolution; never send this credential
// to custom hosts or ports, and reread it for each operation after key rotation.
export function feiyuCredential(root,voice){
  if(!managedFeiyuEndpoint(voice.endpoint))return {mode:'custom',key:voice.apiKey??''};
  try{
    const configFile=path.join(root,'state/maintenance/audio-capabilities/feiyu-tts/voice-service.json');
    if(fs.statSync(configFile).size>65536)return {mode:'managed',key:''};
    const config=JSON.parse(fs.readFileSync(configFile,'utf8').replace(/^\uFEFF/,''));
    if(config.schema!=='feiyu-voice-service-v1'||typeof config.data_dir!=='string'||!config.data_dir)return {mode:'managed',key:''};
    const server=path.join(root,'state/maintenance/audio-capabilities/feiyu-cover/source/astrbot_plugin_feiyu_voice-76774b499f7d306454562d56348dd63399b6d7e8/server');
    const file=path.resolve(server,config.data_dir,'api_key.txt'),stat=fs.statSync(file);
    if(!stat.isFile()||stat.size>4096)return {mode:'managed',key:''};
    const key=fs.readFileSync(file,'utf8').trim();
    return {mode:'managed',key:key.length>=16&&!/[\r\n\0]/.test(key)?key:''};
  }catch{return {mode:'managed',key:''};}
}
