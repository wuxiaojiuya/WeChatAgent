import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createAudioCapabilities} from './audio-capabilities.mjs';
import {createDshCapabilityClient} from './dsh-capability-client.mjs';
import {createRvcModels} from './rvc-models.mjs';
import {createVoiceProfiles} from './voice-profiles.mjs';

const publicCode=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/.test(value)?value:'VOICE_VERIFICATION_FAILED';

// Explicit local diagnostics use exactly the saved voice and DSH execution path.
// No provider credentials, provider response bodies or audio bytes are logged.
export async function verifyLocalFeiyu({root=process.cwd(),execution,log=value=>console.log(JSON.stringify(value))}={}){
  const config=()=>JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8'));
  const models=createRvcModels({root}),voices=createVoiceProfiles({root,models});
  const api=createAudioCapabilities({root,voices,modelExists:id=>!!models.get(id),execution:execution??createDshCapabilityClient({root,config}).execute});
  try{
    const revision=api.snapshot().revision,checked=await api.checkVoice({revision});
    log({phase:'check',code:publicCode(checked.code),serviceReachable:checked.serviceReachable===true,authenticated:checked.authenticated===true,ttsConfigured:checked.ttsConfigured===true,rvcAvailable:checked.rvcAvailable===true,sent:false});
    if(checked.code!=='TTS_CONFIGURED')return {ok:false,code:publicCode(checked.code),sent:false};
    const generated=await api.preview({revision,text:'连接测试成功，你好呀。',emotion:'neutral'});
    const file=path.join(root,'state/maintenance/filehelper-feiyu-speech.wav');fs.mkdirSync(path.dirname(file),{recursive:true});
    const audio=Buffer.from(generated.audio,'base64');fs.writeFileSync(file,audio,{mode:0o600});
    const result={ok:true,code:'VOICE_VERIFIED',file,bytes:audio.length,sent:false};
    log({phase:'complete',...result});return result;
  }catch(error){
    const result={ok:false,code:publicCode(error.code),sent:false};log({phase:'failed',...result});return result;
  }finally{api.close();}
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const result=await verifyLocalFeiyu();if(!result.ok)process.exitCode=1;
}
