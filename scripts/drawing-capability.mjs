import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {imageMetadata} from './native-image-delivery.mjs';
import {allowedConversation} from '../packages/dsh-social-bridge-plugin/conversation-policy.mjs';
import {audioChatKeys} from './audio-capabilities.mjs';
import {activeConnection} from './hook-connection-state.mjs';

const publicFault=Symbol('drawing public error');
const fault=(message,status=400)=>Object.assign(new Error(message),{status,[publicFault]:true});
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const conversation=value=>typeof value==='string'&&/^wechat:(private|group):[1-9]\d*$/.test(value);
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const MAX_IMAGE=16*1024*1024;
// Images are bounded independently of the small, longer-lived request ledger.
// The ledger prevents a retained request ID from being billed again after cleanup.
export const drawingRetention=Object.freeze({maxJobs:30,maxBytes:256*1024*1024,maxAgeMs:30*86400000,maxRequests:2048,requestMaxAgeMs:90*86400000});
export const drawingDefaults=()=>({enabled:false,endpoint:'https://api.openai.com/v1',apiKey:'',model:'gpt-image-2',size:'1024x1024',quality:'auto',chats:[]});
function abortable(promise,signal){
  return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason??new Error('ABORTED'));if(signal.aborted){Promise.resolve(promise).catch(()=>{});abort();return;}signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
export function drawingEndpoint(value){
  let url;try{url=new URL(value);}catch{throw fault('请填写完整的绘画 API 基础地址。');}
  if(typeof value!=='string'||value.length>2048||url.username||url.password||url.search||url.hash||!/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/.test(url.pathname)||
    !(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw fault('绘画地址请使用 HTTPS 或本机 HTTP 基础地址，不要包含密钥或查询参数。');
  if(url.pathname.endsWith('/images/generations'))throw fault('请填写 API 基础地址，例如 https://api.openai.com/v1，不要包含 /images/generations。');
  return url.origin+url.pathname.replace(/\/+$/,'');
}
// Provider URLs are never fetched. Validate the actual decoded PNG bytes
// with the same parser used by the native image transport.
export function validateDrawingPng(bytes){
  try{const value=imageMetadata(bytes);if(value.format!=='png')throw Error('PNG_REQUIRED');return {width:value.width,height:value.height};}
  catch{throw fault('绘画接口未返回有效的 PNG 图片。',502);}
}
const executionMessages=Object.freeze({DRAWING_KEY_INVALID:'绘画 API Key 无效，请核对凭据。',DRAWING_FORBIDDEN:'当前账号没有该绘画模型的访问权限，请核对模型授权。',DRAWING_RATE_LIMIT:'绘画服务额度不足或请求过于频繁，请在服务商后台检查。',DRAWING_REQUEST_REJECTED:'绘画请求被服务商拒绝，请检查模型、尺寸、画质或调整画面描述。',DRAWING_NOT_FOUND:'绘画接口或模型不存在，请检查基础地址和模型名称。',DRAWING_PROVIDER_UNAVAILABLE:'DSH 绘画插件无法连接绘画服务，本次没有自动重试。',DRAWING_RESPONSE_TOO_LARGE:'绘画接口响应过大。',DRAWING_RESPONSE_INVALID:'绘画接口返回格式无效。',DRAWING_MODEL_UNCONFIRMED:'服务未确认所选模型，请核对模型名称，或直接生成试画验证。',DRAWING_IMAGE_INVALID:'绘画接口未返回有效的 PNG 图片。',DRAWING_CONFIG_INVALID:'DSH 绘画插件配置无效，请重新保存绘画设置。'});

export function createDrawingCapability({root,config,delivery,execution,accountScope=()=>activeConnection(root).id,now=Date.now,timeoutMs=240000,retention={}}={}){
  root=path.resolve(root);
  const settingsFile=path.join(root,'state/drawing/capability.json'),directory=path.join(root,'state/drawing/jobs'),ledgerFile=path.join(root,'state/drawing/retired.json');
  const limits={...drawingRetention,...retention};for(const key of Object.keys(limits))if(!Object.hasOwn(drawingRetention,key)||!Number.isSafeInteger(limits[key])||limits[key]<1||limits[key]>drawingRetention[key])throw new TypeError('Invalid drawing retention');
  const jobs=new Map(),tasks=new Map(),controllers=new Set(),retired=new Map();let closed=false,busy=false,verifiedRevision='',storageProblem=false;
  function safe(file,{mkdir=false}={}){const relative=path.relative(root,file);if(!relative||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw fault('绘画文件位置无效。',503);
    const segments=relative.split(path.sep);let current=root;for(let index=0;index<segments.length;index++){current=path.join(current,segments[index]);let stat;try{stat=fs.lstatSync(current);}catch(error){if(error.code!=='ENOENT')throw error;if(mkdir&&index<segments.length-1){fs.mkdirSync(current);stat=fs.lstatSync(current);}else continue;}
      if(stat.isSymbolicLink()||index<segments.length-1&&!stat.isDirectory())throw fault('绘画文件目录不可用，请检查本地存储。',503);}
    return file;
  }
  function atomic(file,value){safe(file,{mkdir:true});const temporary=file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});safe(file);fs.renameSync(temporary,file);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}}
  function read(){let raw='';try{safe(settingsFile);if(fs.existsSync(settingsFile)){const stat=fs.lstatSync(settingsFile);if(!stat.isFile()||stat.size>65536)throw Error('SETTINGS_SIZE');raw=fs.readFileSync(settingsFile,'utf8');}
      const parsed=raw?JSON.parse(raw):{},settings={...drawingDefaults(),...parsed};
      if(!record(parsed)||Object.keys(parsed).some(key=>!Object.hasOwn(drawingDefaults(),key))||typeof settings.enabled!=='boolean'||!Array.isArray(settings.chats)||settings.chats.length>1000||settings.chats.some(key=>!conversation(key))||typeof settings.apiKey!=='string'||settings.apiKey.length>4096||/[\r\n\0]/.test(settings.apiKey)||typeof settings.model!=='string'||!/^gpt-image-[A-Za-z0-9._-]{1,100}$/.test(settings.model)&&settings.model!=='chatgpt-image-latest'||!['1024x1024','1536x1024','1024x1536','auto'].includes(settings.size)||!['auto','low','medium','high'].includes(settings.quality))throw Error('SETTINGS_SCHEMA');
      settings.endpoint=drawingEndpoint(settings.endpoint);return {settings,revision:hash(raw)};
    }catch{throw fault('绘画配置文件不可用，请检查文件和目录后重试。',503);}}
  function snapshot(){const saved=read();return {revision:saved.revision,settings:{...saved.settings,apiKey:'',apiKeyConfigured:!!saved.settings.apiKey},verified:saved.revision===verifiedRevision};}
  const allowed=key=>{const value=read().settings;return value.enabled&&value.chats.includes(key)&&allowedConversation(config().wechat,key);};
  function save(body){const previous=read(),value=body?.settings;
    if(body?.revision!==previous.revision)throw fault('绘画设置已变化，请重新打开配置。',409);
    if(!record(body)||!record(value)||Object.keys(body).some(key=>!['revision','settings','clearApiKey'].includes(key))||Object.keys(value).some(key=>!Object.hasOwn(drawingDefaults(),key))||body.clearApiKey!==undefined&&typeof body.clearApiKey!=='boolean')throw fault('绘画设置格式无效。');
    const next={...drawingDefaults(),...value},keys=audioChatKeys(config());
    if(typeof next.enabled!=='boolean'||!Array.isArray(next.chats)||next.chats.length>1000||next.chats.some(key=>!keys.includes(key)))throw fault('请重新选择允许绘画的聊天。');
    next.chats=[...new Set(next.chats)];next.endpoint=drawingEndpoint(next.endpoint);
    if(typeof next.model!=='string'||!/^gpt-image-[A-Za-z0-9._-]{1,100}$/.test(next.model)&&next.model!=='chatgpt-image-latest')throw fault('请输入 GPT Image 模型名称，例如 gpt-image-2。');
    if(!['1024x1024','1536x1024','1024x1536','auto'].includes(next.size)||!['auto','low','medium','high'].includes(next.quality))throw fault('请选择有效的图片尺寸和画质。');
    if(typeof next.apiKey!=='string'||next.apiKey.length>4096||/[\r\n\0]/.test(next.apiKey))throw fault('绘画 API Key 格式无效。');
    next.apiKey=body.clearApiKey?'':next.apiKey.trim()||(next.endpoint===previous.settings.endpoint?previous.settings.apiKey:'');
    if(next.endpoint!==previous.settings.endpoint&&!next.apiKey&&previous.settings.apiKey&&!body.clearApiKey)throw fault('接口地址已改变，请为新地址重新填写 API Key，或明确勾选清除密钥。');
    atomic(settingsFile,next);return snapshot();
  }
  function catalog(){const saved=snapshot(),value=saved.settings,count=value.chats.filter(key=>audioChatKeys(config()).includes(key)).length,ready=saved.verified;
    return [{id:'native-gpt-drawing',name:'GPT 绘画',description:'在聊天中描述想画的内容，由 GPT Image 生成图片并发送。支持独立接口、画质、尺寸与聊天范围配置。',management:'drawing',managementHost:'wechatagent',builtin:true,host:'dsh',category:'绘画与素材',enabled:value.enabled,ready,configured:value.apiKeyConfigured,selectedCount:count,statusLabel:!value.apiKeyConfigured?'待配置 API Key':ready?'绘画接口已验证':'已配置 · 待检测或试画',statusTone:ready?'success':'warning',featureState:{globalEnabled:value.enabled,effectiveCount:value.enabled&&value.apiKeyConfigured?count:0,totalCount:audioChatKeys(config()).length}}];
  }
  function guard(signal){if(closed)throw fault('绘画服务已关闭。',503);signal?.throwIfAborted();}
  async function execute(operation,settings,prompt,signal){
    if(typeof execution!=='function')throw fault('DSH 绘画插件尚未就绪，请启动 DSH 并启用能力插件。',503);
    const {endpoint,apiKey,model,size,quality}=settings;
    try{return await abortable(execution(operation,{settings:{endpoint,apiKey,model,size,quality},...(prompt===undefined?{}:{prompt})},{signal}),signal);}
    catch(error){if(Object.hasOwn(executionMessages,error?.code))throw fault(executionMessages[error.code],502);throw error;}
  }
  async function check(body){guard();const saved=read();if(body?.revision!==saved.revision)throw fault('绘画设置已变化，请重新打开配置。',409);if(!saved.settings.apiKey)throw fault('请先保存绘画服务的 API Key。');
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(12000)]);controllers.add(controller);
    try{const result=await execute('drawing.check',saved.settings,undefined,signal);guard(signal);if(result?.model!==saved.settings.model)throw fault('服务未确认所选模型，请核对模型名称，或直接生成试画验证。',502);if(read().revision!==saved.revision)throw fault('绘画设置已变化，请重新检测。',409);verifiedRevision=saved.revision;
      return {ok:true,message:'API 凭据和模型访问检查通过。请生成一张试画，验证实际绘图权限；本地试画不会发送微信。'};
    }catch(error){if(error?.[publicFault])throw error;throw fault('无法连接绘画服务，或检测超时。请检查 API 基础地址和网络。',502);}finally{controllers.delete(controller);}
  }
  function persist(job){atomic(path.join(directory,job.id,'job.json'),job);}
  function update(job,patch){const value={...job,...patch};persist(value);Object.assign(job,value);}
  function authorize(job,key){if(job.previewOnly){if(key)throw fault('此试画不属于微信会话。',403);return;}
    if(key!==job.conversationKey||job.accountScope!==accountScope()||!allowed(key))throw fault('此绘画任务不属于当前账号或聊天，或聊天授权已关闭。',403);}
  function publicJob(job){const d=job.delivery,sent=d?.state==='confirmed'||d?.state==='api-acknowledged'&&d.sent===true&&d.confirmed===false&&d.apiAcknowledged===true&&d.receipt==='supplier-api'&&d.delivered==='api-acknowledged';return {id:job.id,state:job.state,stage:job.stage,startedAt:job.startedAt,completedAt:job.completedAt,previewOnly:job.previewOnly,sent,...(job.error?{error:job.error}:{}),...(d?{delivery:d}:{}),...(job.state==='success'?{previewUrl:'/api/drawing-capability/jobs/'+job.id+'/image',width:job.width,height:job.height}:{} )};}
  const requestIdentity=job=>JSON.stringify([job.requestId,job.previewOnly,job.conversationKey??'',job.accountScope??'']);
  function validCore(job){return record(job)&&uuid(job.id)&&uuid(job.requestId)&&digest(job.promptHash)&&typeof job.previewOnly==='boolean'&&iso(job.startedAt)&&
    (job.previewOnly?!Object.hasOwn(job,'conversationKey')&&!Object.hasOwn(job,'accountScope'):conversation(job.conversationKey)&&digest(job.accountScope));}
  function validJob(job,id){if(!validCore(job)||job.id!==id||job.version!==1||Object.keys(job).some(key=>!['version','id','requestId','promptHash','state','stage','startedAt','completedAt','previewOnly','conversationKey','accountScope','error','width','height','delivery'].includes(key)))return false;
    if(job.state==='running')return job.stage==='GPT 正在绘画'&&!['completedAt','error','width','height','delivery'].some(key=>Object.hasOwn(job,key));
    if(!iso(job.completedAt)||Date.parse(job.completedAt)<Date.parse(job.startedAt))return false;
    if(job.state==='failed')return ['生成已中断','绘画未完成'].includes(job.stage)&&typeof job.error==='string'&&job.error.length>0&&job.error.length<=500&&!['width','height','delivery'].some(key=>Object.hasOwn(job,key));
    return job.state==='success'&&job.stage==='图片已生成'&&!Object.hasOwn(job,'error')&&Number.isSafeInteger(job.width)&&Number.isSafeInteger(job.height)&&job.width>0&&job.height>0&&job.width<=8192&&job.height<=8192&&job.width*job.height<=40000000&&(!Object.hasOwn(job,'delivery')||record(job.delivery));
  }
  function jsonFile(file,limit){safe(file);const stat=fs.lstatSync(file);if(!stat.isFile()||stat.size>limit)throw Error('INVALID_DRAWING_RECORD');return JSON.parse(fs.readFileSync(file,'utf8'));}
  function ledgerEntries(values){return [...values].filter(value=>now()-Date.parse(value.retiredAt)<=limits.requestMaxAgeMs).sort((a,b)=>Date.parse(b.retiredAt)-Date.parse(a.retiredAt)).slice(0,limits.maxRequests);}
  function writeLedger(values){const entries=ledgerEntries(values);atomic(ledgerFile,{version:1,entries});retired.clear();for(const value of entries)retired.set(value.id,value);}
  function removeJob(id){const dir=safe(path.join(directory,id));if(!fs.existsSync(dir))return;if(!fs.lstatSync(dir).isDirectory())throw Error('INVALID_DRAWING_DIRECTORY');const names=fs.readdirSync(dir);
    for(const name of names){if(name!=='job.json'&&name!=='image.png'&&!/^job\.json\.[a-f0-9-]{36}\.tmp$/.test(name))throw Error('UNKNOWN_DRAWING_FILE');const file=safe(path.join(dir,name));if(!fs.lstatSync(file).isFile())throw Error('INVALID_DRAWING_FILE');}
    for(const name of names)fs.unlinkSync(safe(path.join(dir,name)));fs.rmdirSync(dir);
  }
  function jobBytes(job){let total=0;for(const name of ['job.json','image.png']){const file=safe(path.join(directory,job.id,name));if(!fs.existsSync(file))continue;const stat=fs.lstatSync(file);if(!stat.isFile())throw Error('INVALID_DRAWING_FILE');total+=stat.size;}return total;}
  function retire(job){const last=Math.max(0,...[...retired.values()].map(value=>Date.parse(value.retiredAt)));const entry={id:job.id,requestId:job.requestId,promptHash:job.promptHash,startedAt:job.startedAt,retiredAt:new Date(Math.max(now(),Date.parse(job.startedAt),last+1)).toISOString(),previewOnly:job.previewOnly,...(!job.previewOnly?{conversationKey:job.conversationKey,accountScope:job.accountScope}:{})};
    // Persist the idempotency fingerprint before removing the result. A crash
    // between these writes must never make an old request look new.
    writeLedger([...retired.values(),entry]);jobs.delete(job.id);removeJob(job.id);
  }
  function prune(){let count=0,bytes=0;for(const job of jobs.values())if(job.state==='running'){count++;bytes+=jobBytes(job);}
    const terminal=[...jobs.values()].reverse().filter(job=>job.state!=='running').sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt));
    for(const job of terminal){const size=jobBytes(job);if(now()-Date.parse(job.startedAt)>limits.maxAgeMs||count>=limits.maxJobs||bytes+size>limits.maxBytes)retire(job);else{count++;bytes+=size;}}
    if(ledgerEntries(retired.values()).length!==retired.size)writeLedger(retired.values());
  }
  function recover(){try{
      safe(ledgerFile);if(fs.existsSync(ledgerFile)){const ledger=jsonFile(ledgerFile,2*1024*1024);if(!record(ledger)||ledger.version!==1||Object.keys(ledger).some(key=>!['version','entries'].includes(key))||!Array.isArray(ledger.entries)||ledger.entries.length>drawingRetention.maxRequests)throw Error('INVALID_DRAWING_LEDGER');
        const identities=new Set();for(const entry of ledger.entries){if(!validCore(entry)||!iso(entry.retiredAt)||Date.parse(entry.retiredAt)<Date.parse(entry.startedAt)||Object.keys(entry).some(key=>!['id','requestId','promptHash','startedAt','retiredAt','previewOnly','conversationKey','accountScope'].includes(key))||retired.has(entry.id)||identities.has(requestIdentity(entry)))throw Error('INVALID_DRAWING_LEDGER');retired.set(entry.id,entry);identities.add(requestIdentity(entry));}}
      safe(directory);if(!fs.existsSync(directory))return;if(!fs.lstatSync(directory).isDirectory())throw Error('INVALID_DRAWING_DIRECTORY');const identities=new Set([...retired.values()].map(requestIdentity));
      for(const id of fs.readdirSync(directory).filter(uuid))try{if(retired.has(id)){removeJob(id);continue;}const job=jsonFile(path.join(directory,id,'job.json'),24000);if(!validJob(job,id)||identities.has(requestIdentity(job)))throw Error('INVALID_DRAWING_JOB');identities.add(requestIdentity(job));
          // Delivery metadata is recovered from the dedicated delivery store.
          delete job.delivery;if(job.state==='running')update(job,{state:'failed',stage:'生成已中断',error:'项目已重启，上次绘画结果未知；没有自动重试生成或微信发送。',completedAt:new Date(Math.max(now(),Date.parse(job.startedAt))).toISOString()});jobs.set(id,job);
        }catch{storageProblem=true;}
      prune();for(const [id,job]of jobs)if(job.state==='success')try{const size=validateDrawingPng(readImage(id));if(size.width!==job.width||size.height!==job.height)throw Error('DIMENSION_MISMATCH');}catch{storageProblem=true;jobs.delete(id);}
    }catch{storageProblem=true;}
  }
  function readImage(id){if(!uuid(id))throw fault('生成图片不可用。',404);const file=safe(path.join(directory,id,'image.png')),stat=fs.lstatSync(file);if(!stat.isFile()||!stat.size||stat.size>MAX_IMAGE)throw fault('生成图片不可用。',404);return fs.readFileSync(file);}
  async function generate(body){
    guard();
    if(!record(body)||Object.keys(body).some(key=>!['prompt','conversationKey','requestId','previewOnly','revision'].includes(key))||typeof body.prompt!=='string'||!body.prompt.trim()||body.prompt.length>4000||/[\0]/.test(body.prompt)||!uuid(body.requestId)||typeof body.previewOnly!=='boolean'||body.previewOnly&&body.conversationKey!==undefined)throw fault('请填写 1～4000 字的画面描述，并使用有效的绘画请求。');
    const previewOnly=body.previewOnly,key=body.conversationKey,saved=read();
    if(!previewOnly&&!allowed(key))throw fault('当前聊天未开启 GPT 绘画。',403);
    if(previewOnly&&body.revision!==saved.revision)throw fault('绘画设置已变化，请重新打开配置。',409);
    const scope=previewOnly?undefined:accountScope(),promptHash=hash(body.prompt.trim());
    if(!previewOnly&&!digest(scope))throw fault('当前微信账号尚未就绪，请先连接并验证微信。',409);
    try{prune();}catch{storageProblem=true;}
    const previous=[...jobs.values()].find(job=>job.requestId===body.requestId&&job.previewOnly===previewOnly&&job.conversationKey===key&&job.accountScope===scope);
    if(previous){if(previous.promptHash!==promptHash)throw fault('该请求编号已经用于其他画面，未重复生成。',409);return {job:await get(previous.id,key)};}
    const expired=[...retired.values()].find(job=>job.requestId===body.requestId&&job.previewOnly===previewOnly&&job.conversationKey===key&&job.accountScope===scope);
    if(expired)throw fault(expired.promptHash===promptHash?'这次绘画已超过本地保存期限，未重复生成；请使用新的请求重新绘画。':'该请求编号已经用于其他画面，未重复生成。',expired.promptHash===promptHash?410:409);
    if(storageProblem)throw fault('绘画任务记录无法安全保存或恢复，请检查本地磁盘和任务目录；本次未提交生成。',503);
    if(busy)throw fault('已有一张图片正在生成，请等待完成后再画。',429);
    if(!saved.settings.apiKey)throw fault('请先在能力菜单的 GPT 绘画中配置 API Key。');
    busy=true;let ticket;const controller=new AbortController();controllers.add(controller);
    try{if(!previewOnly){const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]);ticket=await abortable(delivery.capture(key,{signal}),signal);guard(signal);if(ticket.accountScope!==scope||scope!==accountScope())throw fault('微信账号已变化，请重新请求绘画。',409);}
      guard(controller.signal);if(read().revision!==saved.revision||!previewOnly&&!allowed(key))throw fault('绘画设置或聊天授权已变化，本次尚未提交生成。',409);
    }catch(error){busy=false;controllers.delete(controller);if(closed)throw fault('绘画服务已关闭，本次尚未提交生成。',503);if(error?.[publicFault])throw error;throw fault('微信图片通道尚未就绪，请检查微信连接和聊天授权。',502);}
    const id=crypto.randomUUID(),job={version:1,id,requestId:body.requestId,promptHash,state:'running',stage:'GPT 正在绘画',startedAt:new Date(now()).toISOString(),previewOnly,...(!previewOnly?{conversationKey:key,accountScope:scope}:{})};
    try{persist(job);}catch{busy=false;controllers.delete(controller);storageProblem=true;throw fault('无法保存绘画任务，请检查本地磁盘；本次未提交生成。',503);}jobs.set(id,job);
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutMs)]);
    const task=(async()=>{
      try{guard(signal);const result=await execute('drawing.generate',saved.settings,body.prompt.trim(),signal);guard(signal);const base64=result?.image;
        if(typeof base64!=='string'||base64.length>Math.ceil(MAX_IMAGE/3)*4||base64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(base64))throw fault('绘画服务没有返回 PNG 图片数据，请使用支持 GPT Image 的接口。',502);
        const bytes=Buffer.from(base64,'base64');if(bytes.toString('base64')!==base64)throw fault('绘画接口返回的图片编码无效。',502);const dimensions=validateDrawingPng(bytes);if(result.width!==dimensions.width||result.height!==dimensions.height)throw fault('DSH 绘画插件返回的图片尺寸无效。',502);const file=safe(path.join(directory,id,'image.png'));fs.writeFileSync(file,bytes,{flag:'wx',mode:0o600});
        const unchanged=read().revision===saved.revision;if(unchanged)verifiedRevision=saved.revision;
        update(job,{state:'success',stage:'图片已生成',...dimensions,completedAt:new Date(Math.max(now(),Date.parse(job.startedAt))).toISOString()});
        if(!previewOnly){
          guard(signal);if(!unchanged||!allowed(key)||scope!==accountScope()){job.delivery={state:'not-sent',sent:false,message:'图片已生成，但设置、账号或聊天授权已变化，未发送微信。'};}
          else{job.delivery=await delivery.send({id:hash('drawing:'+id),conversationKey:key,file,accountScope:scope,ticket});}
          persist(job);
        }
      }catch(error){if(job.state==='success'){job.delivery={state:'failed',sent:false,message:'图片已生成，但未完成微信图片发送，请检查连接。'};}
        else Object.assign(job,{state:'failed',stage:'绘画未完成',error:error?.[publicFault]?error.message:controller.signal.aborted?'绘画因项目关闭而中断；结果未知，没有自动重试。':'绘画请求失败或超时；结果未知，没有自动重试。',completedAt:new Date(Math.max(now(),Date.parse(job.startedAt))).toISOString()});
        try{persist(job);}catch{storageProblem=true;if(job.state!=='success')job.error='无法保存绘画任务状态，请检查本地磁盘；没有自动重试。';}
      }finally{busy=false;controllers.delete(controller);try{prune();}catch{storageProblem=true;}}
    })();tasks.set(id,task);void task.then(()=>tasks.delete(id),()=>tasks.delete(id));return {job:publicJob(job)};
  }
  async function get(id,key){const job=jobs.get(id);if(!job){const previous=retired.get(id);if(previous){authorize(previous,key);throw fault('这次绘画已超过本地保存期限，未重复生成。',410);}throw fault('绘画任务不存在。',404);}authorize(job,key);
    if(!job.previewOnly&&job.state==='success'){const value=delivery.lookup(hash('drawing:'+id),key);if(value)job.delivery=await delivery.refresh(value.id,key);else job.delivery??={state:'not-sent',sent:false,message:'图片已生成，但没有微信投递记录，未自动重发。'};}
    return publicJob(job);
  }
  async function latest(key){if(!allowed(key))throw fault('当前聊天未开启 GPT 绘画。',403);const job=[...jobs.values()].filter(value=>!value.previewOnly&&value.conversationKey===key&&value.accountScope===accountScope()).sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt))[0];return {job:job?await get(job.id,key):null};}
  function image(id,key){const job=jobs.get(id);if(!job||job.state!=='success')throw fault('生成图片尚不可用。',404);authorize(job,key);return readImage(id);}
  recover();
  return {snapshot,save,catalog,allowed,check,generate,get,latest,image,isBusy:()=>busy,async settled(id){await tasks.get(id);return jobs.get(id);},close(){closed=true;for(const controller of controllers)controller.abort();}};
}
