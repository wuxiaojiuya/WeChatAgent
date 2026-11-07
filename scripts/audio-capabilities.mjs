import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {EMOTION_STRENGTHS} from './voice-emotion.mjs';
import {feiyuCredential,managedFeiyuEndpoint} from './feiyu-credentials.mjs';
import {DEFAULT_VOICE,GENTLE_VOICE} from './voice-profiles.mjs';
import {neteaseCookie} from '../packages/music-source/netease.mjs';

const fault = (message, status = 400) => Object.assign(new Error(message), {status});
export const AUDIO_FEATURES = Object.freeze([
  {id:'native-voice-output', audioKind:'voice', name:'语音回复', description:'先合成带情绪的语音，再用所选 RVC 音色换声。语音与翻唱共用音色，由 AI 自然选择回复方式。'},
  {id:'native-singing', audioKind:'singing', name:'唱歌', description:'支持 QQ 音乐、网易云、酷狗点歌、微信视频及抖音片段。原曲人声经 AI 分析编排，使用语音回复所选 .pth 音色换声后混入伴奏。'},
]);
export const audioDefaults = () => ({
  voice:{enabled:false, provider:'feiyu', endpoint:'http://127.0.0.1:9880', style:'cute', voiceId:DEFAULT_VOICE, mode:'ai-choice', emotionMode:'auto', emotionStrength:'natural', chats:[], apiKey:''},
  singing:{enabled:false, provider:'feiyu-rvc', modelId:'FeiyuVoice-RVC-v1', pitch:0, accompaniment:true, clipSeconds:30, musicSource:'kugou', chats:[],douyinCookie:'',neteaseCookie:''},
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
export function createAudioCapabilities({root, execution, modelExists = () => true,nativeStatus=()=>({ready:false}),voices} = {}) {
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
      voice:{...saved.settings.voice,apiKey:'',hasApiKey:!!credential.key,credentialMode:credential.mode}, singing:{...saved.settings.singing,douyinCookie:'',hasDouyinCookie:!!saved.settings.singing.douyinCookie,neteaseCookie:'',hasNeteaseCookie:!!saved.settings.singing.neteaseCookie}}};
  }
  function save(kind,body,config) {
    const saved=read(), defaults=audioDefaults()[kind];
    if (!body || !defaults || body.revision !== saved.revision) throw fault('音频设置已变化，请重新打开配置。',409);
    const value=body.settings;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key=>!Object.hasOwn(defaults,key)) ||
        Object.keys(body).some(key=>!['revision','settings','clearApiKey','clearDouyinCookie','clearNeteaseCookie'].includes(key)) ||
        ['clearApiKey','clearDouyinCookie','clearNeteaseCookie'].some(key=>body[key]!==undefined&&typeof body[key]!=='boolean')) throw fault('音频能力设置格式无效。');
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
      next.neteaseCookie=neteaseCookie(next.neteaseCookie)||(!body.clearNeteaseCookie?saved.settings.singing.neteaseCookie:'');
      if(body.clearNeteaseCookie)next.neteaseCookie='';
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
      const configured=feature.audioKind==='voice'?!!value.hasApiKey&&(!voices||!!selected?.rvcModelId&&modelExists(selected.rvcModelId)):!!value.modelId&&modelExists(value.modelId);
      const transportReady=nativeStatus().ready===true,ttsVerified=feature.audioKind!=='voice'||inferenceRevision===inferenceKey(read());
      const ready=configured&&transportReady&&ttsVerified;
      return {...feature,management:'audio',managementHost:'wechatagent',builtin:true,host:'dsh',category:'语音与音乐',enabled:value.enabled,ready,
        statusLabel:!configured?'待配置':ready?'原生语音通道已连接':transportReady?'语音服务待试听验证':'原生语音已接入 · 待连接微信',statusTone:ready?'success':'warning',
        effectiveChats:ready&&value.enabled?value.chats.filter(key=>keys.includes(key)):[],scopeCount:count,selectedCount:count,configured,featureState:{globalEnabled:value.enabled,effectiveCount:ready&&value.enabled?count:0,totalCount:keys.length}};
    });
  }
  function inferenceKey(saved){
    return crypto.createHash('sha256').update(saved.revision+'\0'+feiyuCredential(root,saved.settings.voice).key+'\0'+JSON.stringify(voices?.get(saved.settings.voice.voiceId)??null)).digest('hex');
  }
  function executionPayload(saved){
    const value=saved.settings.voice;
    return {settings:Object.fromEntries(['endpoint','style','voiceId','emotionMode','emotionStrength'].map(name=>[name,value[name]])),credential:feiyuCredential(root,value),useRvc:!!voices,...(voices?{rvcModelId:voices.get(value.voiceId)?.rvcModelId??''}:{})};
  }
  async function execute(operation,payload,signal){
    if(typeof execution!=='function')throw Object.assign(fault('DSH 语音能力插件尚未就绪，请启动 DSH 并启用项目能力插件。',503),{code:'DSH_CAPABILITY_NOT_READY'});
    return execution(operation,payload,{signal});
  }
  async function checkVoice(body,{signal}={}) {
    if(closed)throw fault('语音服务检测已关闭。',503);
    const saved=read();if(body?.revision!==saved.revision)throw fault('音频设置已变化，请重新打开配置。',409);
    const payload=executionPayload(saved),verifiedKey=inferenceKey(saved),controller=new AbortController();controllers.add(controller);
    const combined=AbortSignal.any([controller.signal,AbortSignal.timeout(12000),...(signal?[signal]:[])]);
    const native=nativeStatus(),base={serviceReachable:false,authenticated:false,ttsConfigured:false,styleConfigured:false,keyConfigured:!!payload.credential.key,credentialMode:payload.credential.mode,nativeVoiceSend:native.ready===true,nativeReason:native.ready?'CONNECTED':'WECHAT_VOICE_NOT_READY',sent:false};
    try{
      if(voices&&(!payload.rvcModelId||!modelExists(payload.rvcModelId)))return {...base,code:'RVC_MODEL_REQUIRED',message:'设置已保存，请在“上传音色”中补充 RVC 模型，语音与翻唱共用此模型。'};
      const result=await execute('voice.check',payload,combined);combined.throwIfAborted();
      if(inferenceKey(read())!==verifiedKey)throw fault('音色设置已变化，请重新检测。',409);
      if(!result||typeof result.code!=='string'||!/^[A-Z][A-Z0-9_]{1,63}$/.test(result.code)||typeof result.message!=='string'||result.message.length>600)throw Error('INVALID_VOICE_CHECK');
      return {...base,...Object.fromEntries(['serviceReachable','authenticated','ttsConfigured','styleConfigured','rvcAvailable'].map(name=>[name,result[name]===true])),code:result.code,message:result.message+(result.code==='TTS_CONFIGURED'?'请生成试听验证推理；'+(base.nativeVoiceSend?'微信原生语音通道已连接。':'微信原生语音通道尚未就绪，请登录匹配微信。'):''),sent:false};
    }catch(error){
      if(error.status===409)throw error;
      const unavailable=/^(?:DSH_|CAPABILITY_)/.test(error.code??'');
      return {...base,code:unavailable?'DSH_CAPABILITY_NOT_READY':combined.aborted?'CHECK_TIMEOUT':'SERVICE_UNAVAILABLE',message:unavailable?'DSH 语音能力插件尚未就绪，请启动 DSH 并启用项目能力插件。':combined.aborted?'服务检测已取消或超时。':'DSH 语音能力检查未完成，请确认插件和语音服务正在运行。'};
    }finally{controller.abort();controllers.delete(controller);}
  }
  async function preview(body,{signal}={}) {
    if(closed)throw fault('试听服务已关闭。',503);
    if(controllers.size)throw fault('已有试听正在生成，请稍后再试。',429);
    const saved=read();
    if(body?.revision!==saved.revision)throw fault('音频设置已变化，请重新打开配置。',409);
    if(typeof body.text!=='string'||!body.text.trim()||body.text.length>500)throw fault('试听文字需要 1～500 个字符。');
    const payload=executionPayload(saved),verifiedKey=inferenceKey(saved);
    if(voices&&(!payload.rvcModelId||!modelExists(payload.rvcModelId)))throw fault('所选音色缺少 RVC 模型，请在语音回复中上传模型。');
    if(!payload.credential.key)throw fault(payload.credential.mode==='managed'?'本机肥鱼服务尚未生成访问凭据，请完成环境安装并启动服务，无需填写 API Key。':'请先保存自定义语音服务的 API Key。');
    const controller=new AbortController();controllers.add(controller);
    const combined=AbortSignal.any([controller.signal,AbortSignal.timeout(voices?295000:105000),...(signal?[signal]:[])]);
    try{
      const result=await execute('voice.generate',{...payload,text:body.text.trim(),emotion:body.emotion??'neutral'},combined);combined.throwIfAborted();
      if(inferenceKey(read())!==verifiedKey)throw fault('音色设置已变化，请重新生成试听。',409);
      if(!result||typeof result.audio!=='string'||result.audio.length>24*1024*1024||result.mime!=='audio/wav'||result.voiceId!==payload.settings.voiceId||typeof result.emotion!=='string'||payload.useRvc&&result.runtimeRvc!==true)throw fault('DSH 语音能力返回结果无效，未使用基础音色回退。',502);
      const bytes=Buffer.from(result.audio,'base64');if(bytes.length<12||bytes.toString('base64')!==result.audio||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw fault('DSH 语音能力未返回可播放的 WAV。',502);
      inferenceRevision=verifiedKey;
      return {...result,sent:false};
    }catch(error){if(error.status)throw error;throw fault(combined.aborted?'语音试听已取消或超时。':'DSH 语音能力未完成，请确认 DSH 与语音服务正在运行。',502);}
    finally{controller.abort();controllers.delete(controller);}
  }
  return {snapshot,save,catalog,checkVoice,preview,singingSettings:()=>read().settings.singing,isBusy:()=>controllers.size>0,close(){closed=true;for(const controller of controllers)controller.abort();}};
}
