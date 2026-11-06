import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {speechEmotion,EMOTION_STRENGTHS} from './voice-emotion.mjs';
import {feiyuCredential,managedFeiyuEndpoint} from './feiyu-credentials.mjs';
import {DEFAULT_VOICE,GENTLE_VOICE} from './voice-profiles.mjs';

const fault = (message, status = 400) => Object.assign(new Error(message), {status});
export const AUDIO_FEATURES = Object.freeze([
  {id:'native-voice-output', audioKind:'voice', name:'语音回复', description:'先合成带情绪的语音，再用所选 RVC 音色换声。语音与翻唱共用音色，由 AI 自然选择回复方式。'},
  {id:'native-singing', audioKind:'singing', name:'唱歌', description:'支持 QQ 音乐、网易云、酷狗点歌、微信视频及抖音片段。SoulX 演唱干声，再用语音回复中选择的 .pth 音色换声，混入原曲伴奏。'},
]);
export const audioDefaults = () => ({
  voice:{enabled:false, provider:'feiyu', endpoint:'http://127.0.0.1:9880', style:'cute', voiceId:DEFAULT_VOICE, mode:'ai-choice', emotionMode:'auto', emotionStrength:'natural', chats:[], apiKey:''},
  singing:{enabled:false, provider:'feiyu-rvc', modelId:'FeiyuVoice-RVC-v1', pitch:0, accompaniment:true, clipSeconds:30, musicSource:'kugou', chats:[],douyinCookie:''},
});
export const audioChatKeys = config => ['private','groups'].flatMap(kind => (config.wechat?.whitelist?.[kind] ?? [])
  .map(id => 'wechat:' + (kind === 'groups' ? 'group' : 'private') + ':' + id));
function endpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) throw fault('语音服务地址无效。');
  let url; try {url = new URL(value);} catch {throw fault('请填写完整的肥鱼语音服务地址。');}
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw fault('服务地址请使用 HTTPS 或本机 HTTP 地址，不要包含路径、密钥或查询参数。');
  return url.origin;
}
export function createAudioCapabilities({root, fetchImpl = fetch, modelExists = () => true,nativeStatus=()=>({ready:false}),voices,speechRvc} = {}) {
  const file = path.join(root,'state','voice-output','capabilities.json'), controllers = new Set(); let closed = false,inferenceRevision='';
  function read() {
    const raw = fs.existsSync(file) ? fs.readFileSync(file,'utf8') : '', saved = raw ? JSON.parse(raw) : {}, defaults = audioDefaults();
    // Never send the old cloud credential to the new local voice service.
    const voice = saved.voice?.provider === 'feiyu' ? {...defaults.voice,...saved.voice} :
      {...defaults.voice, mode:saved.voice?.mode ?? defaults.voice.mode, chats:saved.voice?.chats ?? []};
    if(managedFeiyuEndpoint(voice.endpoint))voice.apiKey='';
    const singing = saved.singing?.provider === 'feiyu-rvc' ? {...defaults.singing,...saved.singing} :
      {...defaults.singing, chats:saved.singing?.chats ?? []};
    if(voices){
      if(!saved.voice?.voiceId)voice.voiceId=saved.singing?.provider==='feiyu-rvc'&&singing.modelId!==DEFAULT_VOICE?singing.modelId:voice.style==='gentle'?GENTLE_VOICE:DEFAULT_VOICE;
      if(voices.get(voice.voiceId)?.builtin)voice.style=voices.get(voice.voiceId).style;
      singing.modelId=voices.get(voice.voiceId)?.rvcModelId??'';
    }
    return {settings:{voice,singing},revision:crypto.createHash('sha256').update(raw).digest('hex')};
  }
  function snapshot() {
    const saved=read(),credential=feiyuCredential(root,saved.settings.voice); return {revision:saved.revision,nativeTransport:nativeStatus(),settings:{
      voice:{...saved.settings.voice,apiKey:'',hasApiKey:!!credential.key,credentialMode:credential.mode}, singing:{...saved.settings.singing,douyinCookie:'',hasDouyinCookie:!!saved.settings.singing.douyinCookie}}};
  }
  function save(kind,body,config) {
    const saved=read(), defaults=audioDefaults()[kind];
    if (!body || !defaults || body.revision !== saved.revision) throw fault('音频设置已变化，请重新打开配置。',409);
    const value=body.settings;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key=>!Object.hasOwn(defaults,key)) ||
        Object.keys(body).some(key=>!['revision','settings','clearApiKey','clearDouyinCookie'].includes(key)) ||
        body.clearApiKey !== undefined && typeof body.clearApiKey !== 'boolean'||body.clearDouyinCookie!==undefined&&typeof body.clearDouyinCookie!=='boolean') throw fault('音频能力设置格式无效。');
    const next={...defaults,...value}, allowed=audioChatKeys(config);
    if(typeof next.enabled!=='boolean'||!Array.isArray(next.chats)||next.chats.length>1000||next.chats.some(key=>!allowed.includes(key)))throw fault('聊天范围已变化，请重新打开配置。');
    next.chats=[...new Set(next.chats)];
    if(kind==='voice') {
      if(!['auto','neutral'].includes(next.emotionMode)||!EMOTION_STRENGTHS.includes(next.emotionStrength))throw fault('请选择有效的情绪表达方式和强度。');
      if(next.provider!=='feiyu'||!['cute','gentle'].includes(next.style)||!['ai-choice','on-request','prefer-voice'].includes(next.mode))throw fault('请选择有效的肥鱼声线和回复方式。');
      if(typeof next.voiceId!=='string'||voices&&!voices.get(next.voiceId))throw fault('所选音色不存在，请重新选择音色。');
      if(voices?.get(next.voiceId)?.builtin)next.style=voices.get(next.voiceId).style;
      next.endpoint=endpoint(next.endpoint);
      if(typeof next.apiKey!=='string'||next.apiKey.length>4096||/[\r\n\0]/.test(next.apiKey))throw fault('API Key 格式无效。');
      next.apiKey=next.apiKey.trim()||(!body.clearApiKey&&next.endpoint===saved.settings.voice.endpoint?saved.settings.voice.apiKey:'');
      if(body.clearApiKey)next.apiKey='';
      if(managedFeiyuEndpoint(next.endpoint))next.apiKey='';
    } else {
      if(voices)next.modelId=voices.get(saved.settings.voice.voiceId)?.rvcModelId??'';
      if(voices&&!next.modelId&&next.enabled)throw fault('所选音色还没有配套翻唱模型，请在“语音回复”中补充，无需另选音色。');
      if(typeof next.douyinCookie!=='string'||next.douyinCookie.length>32768||/[\r\n\0]/.test(next.douyinCookie))throw fault('抖音 Cookie 请填写单行内容，或留空保留。');
      next.douyinCookie=next.douyinCookie.trim()||(!body.clearDouyinCookie?saved.settings.singing.douyinCookie:'');
      if(body.clearDouyinCookie)next.douyinCookie='';
      if(next.provider!=='feiyu-rvc'||typeof next.modelId!=='string'||(next.modelId?!modelExists(next.modelId):!voices||next.enabled)||
        !['kugou','qq','netease','local'].includes(next.musicSource)||!Number.isInteger(next.pitch)||next.pitch < -12||next.pitch > 12||
        typeof next.accompaniment!=='boolean'||!Number.isInteger(next.clipSeconds)||next.clipSeconds<10||next.clipSeconds>30)throw fault('请选择已安装的 RVC 模型、歌曲来源和 10～30 秒的试听时长，变调范围为 -12～12。');
    }
    saved.settings[kind]=next;if(voices&&kind==='voice')saved.settings.singing.modelId=voices.get(next.voiceId)?.rvcModelId??'';fs.mkdirSync(path.dirname(file),{recursive:true});
    const temporary=file+'.'+crypto.randomUUID()+'.tmp';
    try{fs.writeFileSync(temporary,JSON.stringify(saved.settings,null,2)+'\n',{flag:'wx',mode:0o600});fs.renameSync(temporary,file);}
    finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
    return snapshot();
  }
  function catalog(config) {
    const saved=snapshot(),keys=audioChatKeys(config);
    return AUDIO_FEATURES.map(feature=>{
      const value=saved.settings[feature.audioKind],count=value.chats.filter(key=>keys.includes(key)).length;
      const selected=voices?.get(saved.settings.voice.voiceId);
      const configured=feature.audioKind==='voice'?!!value.hasApiKey&&(!voices||!!selected?.rvcModelId&&modelExists(selected.rvcModelId)&&speechRvc?.available()):!!value.modelId&&modelExists(value.modelId);
      const transportReady=nativeStatus().ready===true,ttsVerified=feature.audioKind!=='voice'||inferenceRevision===inferenceKey(read());
      const ready=configured&&transportReady&&ttsVerified;
      return {...feature,management:'audio',builtin:true,host:'console',category:'语音与音乐',enabled:value.enabled,ready,
        statusLabel:!configured?'待配置':ready?'原生语音通道已连接':transportReady?'语音服务待试听验证':'原生语音已接入 · 待连接微信',statusTone:ready?'success':'warning',
        effectiveChats:ready&&value.enabled?value.chats.filter(key=>keys.includes(key)):[],scopeCount:count,selectedCount:count,configured,featureState:{globalEnabled:value.enabled,effectiveCount:ready&&value.enabled?count:0,totalCount:keys.length}};
    });
  }
  function inferenceKey(saved){
    return crypto.createHash('sha256').update(saved.revision+'\0'+feiyuCredential(root,saved.settings.voice).key+'\0'+JSON.stringify(voices?.get(saved.settings.voice.voiceId)??null)).digest('hex');
  }
  async function checkVoice(body,{signal}={}) {
    if(closed)throw fault('语音服务检测已关闭。',503);
    const saved=read();
    if(body?.revision!==saved.revision)throw fault('音频设置已变化，请重新打开配置。',409);
    const value=saved.settings.voice,credential=feiyuCredential(root,value),controller=new AbortController();controllers.add(controller);
    const requestSignal=AbortSignal.any([controller.signal,AbortSignal.timeout(8000),...(signal?[signal]:[])]);
    const result={serviceReachable:false,authenticated:false,ttsConfigured:false,styleConfigured:false,
      keyConfigured:!!credential.key,credentialMode:credential.mode,nativeVoiceSend:nativeStatus().ready===true,nativeReason:nativeStatus().ready?'CONNECTED':'WECHAT_VOICE_NOT_READY',sent:false};
    const finish=(code,message)=>({...result,code,message});
    if(voices){
      const model=voices.get(value.voiceId)?.rvcModelId;
      if(!model||!modelExists(model)||!speechRvc?.available()){
        controllers.delete(controller);controller.abort();
        return !model||!modelExists(model)?finish('RVC_MODEL_REQUIRED','设置已保存，请在“上传音色”中补充 RVC 模型，语音与翻唱共用此模型。'):finish('RVC_NOT_CONFIGURED','请先在设置中安装或修复 RVC 换声环境。');
      }
    }
    async function json(response){
      let size=0;const chunks=[];
      for await(const chunk of response.body){size+=chunk.length;if(size>65536)throw Error('INVALID_RESPONSE');chunks.push(chunk);}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    try{
      const base=endpoint(value.endpoint);
      const health=await fetchImpl(base+'/health',{signal:requestSignal,redirect:'error'});
      if(!health.ok)return finish('SERVICE_UNAVAILABLE','肥鱼语音服务未就绪，请启动服务后重试。');
      const identity=await json(health);
      if(identity?.status!=='ok'||typeof identity.version!=='string')return finish('INVALID_SERVICE','该地址未返回肥鱼服务的预期健康状态，请核对地址。');
      result.serviceReachable=true;
      if(!credential.key)return finish(credential.mode==='managed'?'LOCAL_KEY_UNAVAILABLE':'KEY_REQUIRED',credential.mode==='managed'?'服务已连接，但未找到本项目的服务凭据。请确认本机肥鱼环境已安装，并通过项目启动服务；无需手动填写密钥。':'服务已连接，请在自定义服务设置中填写该服务的 API Key。');
      const response=await fetchImpl(base+'/v1/capabilities',{headers:{Authorization:'Bearer '+credential.key},signal:requestSignal,redirect:'error'});
      if([401,403].includes(response.status))return finish('AUTH_FAILED',credential.mode==='managed'?'本机服务凭据不匹配，请确认 9880 端口运行的是本项目启动的肥鱼服务，再重启该服务。':'自定义服务 API Key 验证失败，请核对该服务的访问凭据。');
      if(!response.ok)return finish('CAPABILITIES_UNAVAILABLE','服务已连接，但无法读取 TTS 配置。');
      const capabilities=await json(response);
      if(!Array.isArray(capabilities?.tts))return finish('INVALID_SERVICE','服务返回的能力格式无效，请核对服务版本。');
      result.authenticated=true;
      const tts=capabilities.tts.find(entry=>entry.voice==='feiyu');
      result.ttsConfigured=tts?.available===true;
      result.styleConfigured=result.ttsConfigured&&Array.isArray(tts.styles)&&tts.styles.includes(value.style);
      if(!result.ttsConfigured)return finish('TTS_NOT_CONFIGURED','密钥有效，但肥鱼 TTS 模型或运行环境未配置完成。');
      if(!result.styleConfigured)return finish('STYLE_NOT_CONFIGURED','TTS 已配置，但当前声线不可用，请核对模型包。');
      return finish('TTS_CONFIGURED',(voices?'TTS 服务与所选 RVC 音色检查通过。试听会先合成语音，再换成此音色。':'TTS 配置检查通过。')+'请生成试听验证推理；'+(result.nativeVoiceSend?'微信原生语音通道已连接。':'微信原生语音通道尚未就绪，请登录匹配微信。'));
    }catch{
      return finish(requestSignal.aborted?'CHECK_TIMEOUT':'SERVICE_UNAVAILABLE',requestSignal.aborted?'服务检测已取消或超时。':'无法连接肥鱼语音服务，或服务返回格式无效。请先启动服务并核对地址。');
    }finally{controller.abort();controllers.delete(controller);}
  }
  async function preview(body,{signal}={}) {
    if(closed)throw fault('试听服务已关闭。',503);
    if(controllers.size)throw fault('已有试听正在生成，请稍后再试。',429);
    const saved=read();
    if(body?.revision!==saved.revision)throw fault('音频设置已变化，请重新打开配置。',409);
    if(typeof body.text!=='string'||!body.text.trim()||body.text.length>500)throw fault('试听文字需要 1～500 个字符。');
    const value=saved.settings.voice,credential=feiyuCredential(root,value),verifiedKey=inferenceKey(saved);
    const rvcModelId=voices?.get(value.voiceId)?.rvcModelId;
    if(voices){
      if(!rvcModelId||!modelExists(rvcModelId))throw fault('所选音色缺少 RVC 模型，请在语音回复中上传模型。');
      if(!speechRvc?.available())throw fault('本机 RVC 换声环境不可用，请在设置中安装或修复。',503);
    }
    if(!credential.key)throw fault(credential.mode==='managed'?'本机肥鱼服务尚未生成访问凭据，请完成环境安装并启动服务，无需填写 API Key。':'请先保存自定义语音服务的 API Key。');
    const controller=new AbortController();controllers.add(controller);
    const requestSignal=AbortSignal.any([controller.signal,AbortSignal.timeout(voices?285000:95000),...(signal?[signal]:[])]);
    async function request(route, body) {
      const response=await fetchImpl(endpoint(value.endpoint)+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+credential.key,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:requestSignal,redirect:'error'});
      if(!response.ok)throw fault([401,403].includes(response.status)?credential.mode==='managed'?'本机肥鱼服务鉴权失败，请通过项目重启肥鱼服务。':'自定义语音服务鉴权失败，请核对 API Key。':'肥鱼语音服务无法完成试听，请检查 TTS 是否已配置。',502);
      return response;
    }
    try {
      const expression=speechEmotion(value,body.emotion??'neutral');
      const submitted=await (await request('/v1/speech',{voice:'feiyu',style:value.style,text:body.text.trim(),...(expression.emotion!=='neutral'?expression:{})})).json();
      const id=submitted.id??submitted.job_id;if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(id))throw fault('肥鱼服务返回了无效任务编号。',502);
      for (;;) {
        requestSignal.throwIfAborted();
        const job=await(await request('/v1/jobs/'+id)).json();
        if(job.status==='success')break;
        if(['failed','interrupted','cancelled'].includes(job.status))throw fault('肥鱼语音生成失败，请检查本地 TTS 模型与服务日志。',502);
        await new Promise((resolve,reject)=>{const cancel=()=>{clearTimeout(timer);reject(requestSignal.reason);};const timer=setTimeout(()=>{requestSignal.removeEventListener('abort',cancel);resolve();},600);requestSignal.addEventListener('abort',cancel,{once:true});});
      }
      const response=await request('/v1/jobs/'+id+'/audio'),chunks=[];let size=0;
      for await(const chunk of response.body){size+=chunk.length;if(size>16*1024*1024)throw fault('试听文件过大，请缩短文字。',502);chunks.push(chunk);}
      const audio=Buffer.concat(chunks);if(audio.toString('ascii',0,4)!=='RIFF')throw fault('肥鱼服务未返回可播放的 WAV。',502);
      const converted=voices?await speechRvc.convert({audio,modelId:rvcModelId,signal:requestSignal}):{audio:audio.toString('base64'),mime:'audio/wav'};
      if(inferenceKey(read())!==verifiedKey)throw fault('音色设置已变化，请重新生成试听。',409);
      inferenceRevision=verifiedKey;
      return {...converted,voiceId:value.voiceId,emotion:expression.emotion,sent:false};
    } catch(error) {if(error.status)throw error;throw fault(requestSignal.aborted?'语音试听已取消或超时。':'无法连接肥鱼本地语音服务，请先启动服务。',502);}
    finally{controller.abort();controllers.delete(controller);}
  }
  return {snapshot,save,catalog,checkVoice,preview,isBusy:()=>controllers.size>0,close(){closed=true;for(const controller of controllers)controller.abort();}};
}
