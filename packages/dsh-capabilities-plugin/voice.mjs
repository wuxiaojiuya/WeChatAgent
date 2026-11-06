import {speechEmotion,EMOTION_STRENGTHS} from '../../scripts/voice-emotion.mjs';
import {createRvcModels} from '../../scripts/rvc-models.mjs';
const {createSpeechRvc}=await import(new URL('./speech-rvc.mjs'+new URL(import.meta.url).search,import.meta.url));

const fault=(message,status=400)=>Object.assign(Error(message),{status});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function endpoint(value){
  let url;try{url=new URL(value);}catch{throw fault('请填写完整的肥鱼语音服务地址。');}
  if(typeof value!=='string'||value.length>2048||url.username||url.password||url.search||url.hash||url.pathname!=='/'||
    !(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw fault('语音服务地址无效。');
  return url.origin;
}
function validate(payload,generating){
  const names=['settings','credential','useRvc','rvcModelId',...(generating?['text','emotion']:[])];
  if(!record(payload)||Object.keys(payload).some(key=>!names.includes(key))||!record(payload.settings)||!record(payload.credential)||typeof payload.useRvc!=='boolean')throw fault('语音执行参数无效。');
  const value=payload.settings,credential=payload.credential;
  if(Object.keys(value).some(key=>!['endpoint','style','voiceId','emotionMode','emotionStrength'].includes(key))||!['cute','gentle'].includes(value.style)||typeof value.voiceId!=='string'||value.voiceId.length>100||/[\r\n\0]/.test(value.voiceId)||!['auto','neutral'].includes(value.emotionMode)||!EMOTION_STRENGTHS.includes(value.emotionStrength))throw fault('语音设置无效。');
  if(Object.keys(credential).some(key=>!['key','mode'].includes(key))||!['managed','custom'].includes(credential.mode)||typeof credential.key!=='string'||credential.key.length>4096||/[\r\n\0]/.test(credential.key))throw fault('语音服务凭据无效。');
  if(payload.rvcModelId!==undefined&&(typeof payload.rvcModelId!=='string'||payload.rvcModelId.length>100||/[\r\n\0]/.test(payload.rvcModelId)))throw fault('所选 RVC 音色无效。');
  if(generating&&(typeof payload.text!=='string'||!payload.text.trim()||payload.text.length>500||payload.text.includes('\0')))throw fault('试听文字需要 1～500 个字符。');
  return {base:endpoint(value.endpoint),value,credential};
}
async function json(response,limit=65536){
  let size=0;const chunks=[];
  for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw Error('INVALID_RESPONSE');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function delay(milliseconds,signal){
  return new Promise((resolve,reject)=>{const cancel=()=>{clearTimeout(timer);reject(signal.reason);};const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},milliseconds);signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();});
}

// This executor is owned by the DSH capability plugin. WeChatAgent supplies
// only the current saved settings and credential over its authenticated RPC;
// no provider request, TTS polling or RVC subprocess runs in the console.
export function createVoiceExecutor({root,fetchImpl=fetch,models,speechRvc}={}){
  const ownedModels=models?null:createRvcModels({root}),registry=models??ownedModels,rvc=speechRvc??createSpeechRvc({root,models:registry});
  const controllers=new Set();let closed=false,generating=false;
  function guard(signal){if(closed)throw fault('DSH 语音能力插件已关闭。',503);signal?.throwIfAborted();}
  function rvcProblem(payload){
    if(!payload.useRvc)return null;
    if(!payload.rvcModelId||!registry.get(payload.rvcModelId))return {code:'RVC_MODEL_REQUIRED',message:'设置已保存，请在“上传音色”中补充 RVC 模型，语音与翻唱共用此模型。'};
    if(!rvc.available())return {code:'RVC_NOT_CONFIGURED',message:'请先在设置中安装或修复 RVC 换声环境。'};
    return null;
  }
  async function check(payload,{signal}={}){
    guard(signal);const {base,value,credential}=validate(payload,false),controller=new AbortController();controllers.add(controller);
    const combined=AbortSignal.any([controller.signal,AbortSignal.timeout(8000),...(signal?[signal]:[])]);
    const result={serviceReachable:false,authenticated:false,ttsConfigured:false,styleConfigured:false,rvcAvailable:!payload.useRvc,sent:false};
    const finish=(code,message)=>({...result,code,message});
    try{
      const problem=rvcProblem(payload);if(problem)return finish(problem.code,problem.message);result.rvcAvailable=true;
      const health=await fetchImpl(base+'/health',{signal:combined,redirect:'error'});guard(combined);
      if(!health.ok)return finish('SERVICE_UNAVAILABLE','肥鱼语音服务未就绪，请启动服务后重试。');
      const identity=await json(health);guard(combined);
      if(identity?.status!=='ok'||typeof identity.version!=='string')return finish('INVALID_SERVICE','该地址未返回肥鱼服务的预期健康状态，请核对地址。');
      result.serviceReachable=true;
      if(!credential.key)return finish(credential.mode==='managed'?'LOCAL_KEY_UNAVAILABLE':'KEY_REQUIRED',credential.mode==='managed'?'服务已连接，但未找到本项目的服务凭据。请确认本机肥鱼环境已安装，并通过项目启动服务；无需手动填写密钥。':'服务已连接，请在自定义服务设置中填写该服务的 API Key。');
      const response=await fetchImpl(base+'/v1/capabilities',{headers:{Authorization:'Bearer '+credential.key},signal:combined,redirect:'error'});guard(combined);
      if([401,403].includes(response.status))return finish('AUTH_FAILED',credential.mode==='managed'?'本机服务凭据不匹配，请确认 9880 端口运行的是本项目启动的肥鱼服务，再重启该服务。':'自定义服务 API Key 验证失败，请核对该服务的访问凭据。');
      if(!response.ok)return finish('CAPABILITIES_UNAVAILABLE','服务已连接，但无法读取 TTS 配置。');
      const capabilities=await json(response);guard(combined);
      if(!Array.isArray(capabilities?.tts))return finish('INVALID_SERVICE','服务返回的能力格式无效，请核对服务版本。');
      result.authenticated=true;const tts=capabilities.tts.find(entry=>entry.voice==='feiyu');result.ttsConfigured=tts?.available===true;
      result.styleConfigured=result.ttsConfigured&&Array.isArray(tts.styles)&&tts.styles.includes(value.style);
      if(!result.ttsConfigured)return finish('TTS_NOT_CONFIGURED','密钥有效，但肥鱼 TTS 模型或运行环境未配置完成。');
      if(!result.styleConfigured)return finish('STYLE_NOT_CONFIGURED','TTS 已配置，但当前声线不可用，请核对模型包。');
      return finish('TTS_CONFIGURED',payload.useRvc?'TTS 服务与所选 RVC 音色检查通过。试听会先合成语音，再换成此音色。':'TTS 配置检查通过。');
    }catch{return finish(combined.aborted?'CHECK_TIMEOUT':'SERVICE_UNAVAILABLE',combined.aborted?'服务检测已取消或超时。':'无法连接肥鱼语音服务，或服务返回格式无效。请先启动服务并核对地址。');}
    finally{controller.abort();controllers.delete(controller);}
  }
  async function generate(payload,{signal}={}){
    guard(signal);if(generating)throw fault('已有语音正在生成，请稍后再试。',429);
    const {base,value,credential}=validate(payload,true),expression=speechEmotion(value,payload.emotion??'neutral'),problem=rvcProblem(payload);
    if(problem)throw fault(problem.code==='RVC_NOT_CONFIGURED'?'本机 RVC 换声环境不可用，请在设置中安装或修复。':problem.message,503);
    if(!credential.key)throw fault(credential.mode==='managed'?'本机肥鱼服务尚未生成访问凭据，请完成环境安装并启动服务，无需填写 API Key。':'请先保存自定义语音服务的 API Key。');
    const controller=new AbortController();controllers.add(controller);generating=true;
    const combined=AbortSignal.any([controller.signal,AbortSignal.timeout(payload.useRvc?285000:95000),...(signal?[signal]:[])]);
    async function request(route,body){
      const response=await fetchImpl(base+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+credential.key,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:combined,redirect:'error'});guard(combined);
      if(!response.ok)throw fault([401,403].includes(response.status)?credential.mode==='managed'?'本机肥鱼服务鉴权失败，请通过项目重启肥鱼服务。':'自定义语音服务鉴权失败，请核对 API Key。':'肥鱼语音服务无法完成试听，请检查 TTS 是否已配置。',502);
      return response;
    }
    try{
      const submitted=await json(await request('/v1/speech',{voice:'feiyu',style:value.style,text:payload.text.trim(),...(expression.emotion!=='neutral'?expression:{})}));guard(combined);
      const id=submitted.id??submitted.job_id;if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(id))throw fault('肥鱼服务返回了无效任务编号。',502);
      for(;;){
        guard(combined);const job=await json(await request('/v1/jobs/'+id));guard(combined);
        if(job.status==='success')break;
        if(['failed','interrupted','cancelled'].includes(job.status))throw fault('肥鱼语音生成失败，请检查本地 TTS 模型与服务日志。',502);
        await delay(600,combined);
      }
      const response=await request('/v1/jobs/'+id+'/audio'),chunks=[];let size=0;
      for await(const chunk of response.body){guard(combined);size+=chunk.length;if(size>16*1024*1024)throw fault('试听文件过大，请缩短文字。',502);chunks.push(chunk);}
      guard(combined);const audio=Buffer.concat(chunks);if(audio.toString('ascii',0,4)!=='RIFF'||audio.toString('ascii',8,12)!=='WAVE')throw fault('肥鱼服务未返回可播放的 WAV。',502);
      const converted=payload.useRvc?await rvc.convert({audio,modelId:payload.rvcModelId,signal:combined}):{audio:audio.toString('base64'),mime:'audio/wav'};
      guard(combined);return {...converted,voiceId:value.voiceId,emotion:expression.emotion,sent:false};
    }catch(error){if(error.status)throw error;throw fault(combined.aborted?'语音试听已取消或超时。':'无法连接肥鱼本地语音服务，请先启动服务。',502);}
    finally{controller.abort();controllers.delete(controller);generating=false;}
  }
  return {check,generate,close(){closed=true;for(const controller of controllers)controller.abort();ownedModels?.close();}};
}
