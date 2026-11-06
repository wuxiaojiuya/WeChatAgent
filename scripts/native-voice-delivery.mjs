import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {prepareVoiceClip} from '../packages/voice-output/prepare.mjs';
import {allowedConversation} from '../packages/dsh-social-bridge-plugin/conversation-policy.mjs';
import {conversationId} from './hook-onebot.mjs';
import {hookAccountProblem} from './wechat-account-check.mjs';
import {mediaFfmpeg} from './media-tools.mjs';

const idPattern=/^[a-f0-9]{64}$/;
const serverId=value=>typeof value==='string'&&/^[1-9]\d{0,19}$/.test(value);
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
// Old ambiguous submissions are never retried. Only the interval in which
// their late receipt could overlap a NEW operation needs to hold the lane.
const AMBIGUOUS_VOICE_WINDOW_MS=90000;
const fail=code=>{throw Error(code);};
export function voiceHookOrigin(value){
  let url;try{url=new URL(value);}catch{fail('VOICE_HOOK_ENDPOINT_INVALID');}
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/')fail('VOICE_HOOK_ENDPOINT_INVALID');
  return url.origin;
}
export async function audioFileToSilk(file,{signal,root}={}){
  const stat=fs.statSync(file);if(!stat.isFile()||!stat.size||stat.size>64*1024*1024)fail('VOICE_CONVERSION_FAILED');
  const ffmpeg=mediaFfmpeg(root);
  const pcm=await new Promise((resolve,reject)=>{
    const child=spawn(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-protocol_whitelist','file,pipe','-i',file,'-t','60.02','-vn','-ac','1','-ar','24000','-f','s16le','pipe:1'],{windowsHide:true,shell:false,stdio:['ignore','pipe','ignore']});
    const chunks=[];let size=0,error;
    const cancel=()=>{error=Error('VOICE_CONVERSION_FAILED');child.kill();};
    const timer=setTimeout(cancel,30000);signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>24000*2*60){error=Error('VOICE_OUTPUT_DURATION_LIMIT');child.kill();}else chunks.push(chunk);});
    child.once('error',()=>{error=Error('VOICE_CONVERSION_FAILED');});
    child.once('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(error||code!==0)reject(error??Error('VOICE_CONVERSION_FAILED'));else resolve(Buffer.concat(chunks));});
  });
  return prepareVoiceClip({pcm,sampleRate:24000});
}

// The reviewed WeChatVoice.dll listens on 30002, independently of StartPort.
export function createNativeVoiceDelivery({root,settings,config,reader,fetchImpl=fetch,convert=audioFileToSilk,receiptTimeoutMs=18000,pollMs=400}={}){
  const directory=path.join(root,'state/voice-output/deliveries'),records=new Map(),tasks=new Map(),controllers=new Set();
  let closed=false,lane=Promise.resolve();
  const token=()=>{const value=fs.readFileSync(path.join(root,'state/hook/native-token.txt'),'utf8').trim();if(!/^[a-f0-9]{64}$/.test(value))fail('HOOK_TOKEN_MISSING');return value;};
  const origin=()=>{const h=config().hook;if(h?.backend==='supplier-http'&&h.expectedVersion==='4.1.8.27')return voiceHookOrigin(h.baseUrl);if(h?.expectedVersion!=='4.1.10.27'||!h.voiceBaseUrl)fail('VOICE_HOOK_DISABLED');return voiceHookOrigin(h.voiceBaseUrl);};
  const binding=()=>hash(JSON.stringify([config().hook,token()]));
  const policy=kind=>hash(JSON.stringify([config().wechat,settings()[kind]]));
  function assertNoRecentAmbiguous(key,account,exceptId){
    const now=Date.now();
    if([...records.values()].some(prior=>prior.id!==exceptId&&prior.key===key&&prior.account===account&&prior.state==='unconfirmed'&&prior.startedAt&&!prior.candidateId&&now-prior.startedAt<AMBIGUOUS_VOICE_WINDOW_MS))fail('VOICE_PREVIOUS_DELIVERY_UNCONFIRMED');
  }
  function assertScope(key,kind){
    if(closed)fail('VOICE_SERVICE_CLOSED');
    if(!/^wechat:(private|group):[1-9]\d*$/.test(key)||!['voice','singing'].includes(kind)||!allowedConversation(config().wechat,key)||settings()[kind]?.enabled!==true||!settings()[kind]?.chats?.includes(key))fail('VOICE_SCOPE_DENIED');
    origin();
  }
  const notice=record=>record.state==='confirmed'?'微信原生语音已取得服务器消息回执。':record.state==='closed-unconfirmed'?'此前发送结果未确认，已由用户结束核对；该条不会重发。':record.state==='unconfirmed'?'语音提交结果未确认，不会自动重发。':record.state==='failed'?'语音未发送，请检查微信连接与音频服务。':'音频正在准备或等待微信回执。';
  const publicRecord=r=>({id:r.id,state:r.state,kind:r.kind,conversationKey:r.key,sent:r.state==='confirmed',confirmed:r.state==='confirmed',durationMs:r.durationMs,
    ...(r.error?{code:/^[A-Z][A-Z0-9_]{0,79}$/.test(r.error)?r.error:'VOICE_DELIVERY_FAILED'}:{}),...(r.state==='confirmed'?{serverId:r.serverId,receipt:r.receipt??'wechat-server-id'}:{}),message:notice(r)});
  function persist(r){fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,r.id+'.json');fs.writeFileSync(file+'.tmp',JSON.stringify(r),{mode:0o600});fs.renameSync(file+'.tmp',file);records.set(r.id,r);}
  async function api(base,route,body,signal,account){
    const response=await fetchImpl(base+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token(),...(body===undefined?{}:{'Content-Type':'application/json'}),...(account?{'X-WeChatAgent-Account':account}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(body===undefined?4000:8000)])});
    if(!response.ok)throw Error('VOICE_HTTP_'+response.status);
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>128*1024)fail('VOICE_HOOK_UNAVAILABLE');chunks.push(chunk);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async function identity(signal){
    const own=await reader('/api/v1/reader/status');
    if(own?.backend!==(config().hook.backend==='supplier-http'?'supplier-http':'weflow-cli-nt')||!own.ownWxid||!own.accountDirectory)fail('VOICE_READER_UNAVAILABLE');
    const main=await api(voiceHookOrigin(config().hook.baseUrl),'/WeChatAgent/health',undefined,signal);
    const problem=hookAccountProblem(main,own.accountDirectory,config().hook.expectedVersion);if(problem)fail(problem);
    const health=await api(origin(),'/health',undefined,signal);
    if(health?.backend!=='wechat-voice'||health.ready!==true||health.version!==config().hook.expectedVersion||!Number.isInteger(main.pid)||main.pid<=0||health.pid!==main.pid)fail('VOICE_HOOK_IDENTITY_INVALID');
    if(!Array.isArray(health.databaseAccounts)||health.databaseAccounts.length!==1||String(health.databaseAccounts[0]).toLowerCase()!==String(own.accountDirectory).toLowerCase())fail('VOICE_HOOK_ACCOUNT_MISMATCH');
    return {account:String(own.accountDirectory).toLowerCase(),wxid:own.ownWxid,pid:health.pid};
  }
  async function check({signal}={}){
    const c=new AbortController();controllers.add(c);
    try{origin();await identity(AbortSignal.any([c.signal,...(signal?[signal]:[])]));return {ready:true,accountVerified:true,version:config().hook.expectedVersion,sent:false,message:'原生语音接口已连接，账号与微信进程一致；实际发送以消息回执确认。'};}
    catch(e){return {ready:false,accountVerified:false,sent:false,code:e.message,message:'原生语音尚未就绪，请启动并登录匹配的微信 '+config().hook.expectedVersion+'。'};}
    finally{controllers.delete(c);}
  }
  async function targetFor(key){
    const [,kind,target]=key.split(':'),result=await reader('/api/v1/sessions?limit=500');
    const matches=(result.sessions??[]).filter(s=>typeof s.username==='string'&&(s.username.includes('@chatroom')?'group':'private')===kind&&String(conversationId(s.username,s.displayName,s.conversationId))===target);
    if(matches.length!==1)fail('VOICE_TARGET_UNRESOLVED');return matches[0].username;
  }
  async function rowsFor(r){const result=await reader('/api/v1/messages?talker='+encodeURIComponent(r.wxid)+'&limit=100');if(!Array.isArray(result.messages))fail('VOICE_READER_UNAVAILABLE');return result.messages;}
  async function reconcile(r,signal){
    const deadline=Date.now()+receiptTimeoutMs;
    do{
      assertScope(r.key,r.kind);signal.throwIfAborted();
      const own=await reader('/api/v1/reader/status');
      if(own.ownWxid!==r.accountWxid||String(own.accountDirectory).toLowerCase()!==r.account)fail('VOICE_HOOK_ACCOUNT_MISMATCH');
      const rows=await rowsFor(r),candidates=rows.filter(row=>{
        const duration=Number(/<voicemsg\b[^>]*\bvoicelength\s*=\s*["'](\d{1,6})["']/i.exec(String(row.fullText??row.content??''))?.[1]);
        return (row.isSend===true||row.isSend===1)&&row.localType===34&&!r.baseline.includes(String(row.localId))&&Number.isSafeInteger(Number(row.localId))&&Number(row.localId)>0&&Number(row.createTime)>=Math.floor(r.startedAt/1000)-2&&Number(row.createTime)<=Math.floor(r.startedAt/1000)+60&&Math.abs(duration-r.durationMs)<=20;
      });
      // Multiple new voice messages cannot be unambiguously associated with this operation.
      if(candidates.length>1)fail('VOICE_RECEIPT_AMBIGUOUS');
      const row=candidates[0];
      if(row&&(!r.candidateId||r.candidateId===String(row.localId))){
        r.candidateId=String(row.localId);persist(r);
        if(serverId(row.serverId)){r.serverId=row.serverId;r.state='confirmed';r.confirmedAt=Date.now();delete r.error;persist(r);return true;}
      }
      if(Date.now()>=deadline)break;await delay(pollMs,undefined,{signal});
    }while(!closed);
    return false;
  }
  function run(r,callerSignal){
    if(tasks.has(r.id))return tasks.get(r.id);
    const c=new AbortController();controllers.add(c);const signal=AbortSignal.any([c.signal,...(callerSignal?[callerSignal]:[])]);
    const task=lane.catch(()=>{}).then(async()=>{
      try{
        signal.throwIfAborted();assertScope(r.key,r.kind);
        if(r.binding!==binding()||r.origin!==origin()||r.policy!==policy(r.kind))fail('VOICE_SETTINGS_CHANGED');
        const own=await identity(signal);
        if(own.account!==r.account||own.wxid!==r.accountWxid||await targetFor(r.key)!==r.wxid||r.wxid===own.wxid)fail('VOICE_HOOK_ACCOUNT_MISMATCH');
        if(r.state==='queued'){
          const file=path.join(directory,r.id+'.silk');if(hash(fs.readFileSync(file))!==r.silkHash)fail('VOICE_SETTINGS_CHANGED');
          r.baseline=(await rowsFor(r)).map(row=>String(row.localId));
          signal.throwIfAborted();assertScope(r.key,r.kind);if(r.binding!==binding()||r.origin!==origin()||r.policy!==policy(r.kind))fail('VOICE_SETTINGS_CHANGED');
          assertNoRecentAmbiguous(r.key,r.account,r.id);
          r.state='dispatching';r.startedAt=Date.now();persist(r); // Must precede the native call; never resubmit after a crash/timeout.
          try{
            const result=await api(r.origin,'/SendVoiceMsg',{wxidorgid:r.wxid,path:file,duration:r.durationMs},signal,r.account);
            if(result?.ret!==0){r.state='failed';r.error='NATIVE_VOICE_REJECTED';persist(r);return;}
            if(config().hook.backend==='supplier-http'&&result.confirmed===true&&result.receipt==='wechat-uploadvoice-response'&&serverId(result.serverId)&&result.account===own.wxid&&result.target===r.wxid&&result.durationMs===r.durationMs){
              r.state='confirmed';r.serverId=result.serverId;r.receipt=result.receipt;r.reportedDurationMs=result.reportedDurationMs;r.confirmedAt=Date.now();delete r.error;persist(r);return;
            }
            r.state='submitted';persist(r);
          }catch(e){r.error=e.message;/* A lost HTTP reply may still mean submitted. Reconcile only. */}
        }
        if(!await reconcile(r,signal)){r.state='unconfirmed';r.error='VOICE_DELIVERY_UNCONFIRMED';persist(r);}
      }catch(e){r.error=e.message;r.state=r.startedAt?'unconfirmed':'failed';persist(r);}
      finally{controllers.delete(c);}
    });
    tasks.set(r.id,task);lane=task;void task.finally(()=>tasks.delete(r.id));return task;
  }
  async function capture(key,kind,signal=new AbortController().signal){assertScope(key,kind);const own=await identity(signal),wxid=await targetFor(key);if(wxid===own.wxid)fail('VOICE_TARGET_UNRESOLVED');assertNoRecentAmbiguous(key,own.account);return {...own,target:wxid,binding:binding(),policy:policy(kind)};}
  async function enqueue({key,kind,sourceId,file,signal,context}){
    assertScope(key,kind);if(typeof sourceId!=='string'||!sourceId||sourceId.length>200)fail('VOICE_SETTINGS_CHANGED');
    const id=hash(JSON.stringify([key,kind,sourceId]));if(records.has(id))return publicRecord(records.get(id));
    if([...records.values()].filter(r=>['preparing','queued','submitted','dispatching'].includes(r.state)).length>=16)fail('VOICE_QUEUE_FULL');
    const r={id,key,kind,state:'preparing',createdAt:Date.now(),origin:origin(),binding:binding(),policy:policy(kind)};persist(r);
    const c=new AbortController();controllers.add(c);const current=AbortSignal.any([c.signal,...(signal?[signal]:[])]);
    try{
      const own=await identity(current),wxid=await targetFor(key);if(wxid===own.wxid)fail('VOICE_TARGET_UNRESOLVED');
      if(context&&(context.account!==own.account||context.wxid!==own.wxid||context.target!==wxid||context.binding!==binding()||context.policy!==policy(kind)))fail('VOICE_HOOK_ACCOUNT_MISMATCH');
      const clip=await convert(file,{signal:current,root});current.throwIfAborted();assertScope(key,kind);
      if(r.binding!==binding()||r.origin!==origin()||r.policy!==policy(kind))fail('VOICE_SETTINGS_CHANGED');
      Object.assign(r,{state:'queued',account:own.account,accountWxid:own.wxid,wxid,durationMs:clip.durationMs,silkHash:hash(clip.silk)});
      fs.writeFileSync(path.join(directory,id+'.silk'),clip.silk,{flag:'wx',mode:0o600});persist(r);run(r,signal);
    }catch(e){r.state='failed';r.error=e.message;persist(r);}
    finally{controllers.delete(c);}
    return publicRecord(r);
  }
  function get(id,key){const r=records.get(id);if(!r||r.key!==key)fail('VOICE_DELIVERY_NOT_FOUND');return publicRecord(r);}
  async function refresh(id,key){get(id,key);const r=records.get(id);if(r.state==='unconfirmed'&&r.startedAt)await run(r);return get(id,key);}
  if(fs.existsSync(directory))for(const name of fs.readdirSync(directory).filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){
    try{const r=JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));if(!idPattern.test(r.id)||name!==r.id+'.json'||!/^wechat:(private|group):[1-9]\d*$/.test(r.key))continue;
      if(!['confirmed','failed','closed-unconfirmed'].includes(r.state)){r.state='unconfirmed';r.error='VOICE_DELIVERY_UNCONFIRMED';}records.set(r.id,r);
    }catch{}
  }
  return {check,capture,enqueue,get,refresh,lookup(key,kind,sourceId){const r=records.get(hash(JSON.stringify([key,kind,sourceId])));return r?publicRecord(r):null;},async settled(id,key){await tasks.get(id);return get(id,key);},close(){closed=true;for(const c of controllers)c.abort();}};
}

