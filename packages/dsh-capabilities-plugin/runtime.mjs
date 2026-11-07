import crypto from 'node:crypto';
import {activeConnection} from '../../scripts/hook-connection-state.mjs';
const query=new URL(import.meta.url).search;
const {CAPABILITY_EXECUTION_VERSION,CAPABILITY_OPERATIONS,capabilityFault}=await import(new URL('./contract.mjs'+query,import.meta.url));
const {createDrawingExecution}=await import(new URL('./drawing.mjs'+query,import.meta.url));
const {createVoiceExecutor}=await import(new URL('./voice.mjs'+query,import.meta.url));
const {createSingingExecutor}=await import(new URL('./singing.mjs'+query,import.meta.url));

// This service is mounted in DSH. WeChatAgent supplies private execution inputs
// over its authenticated local channel; none become model tools or chat text.
function abortable(promise,signal){
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason??Error('CAPABILITY_ABORTED'));
    if(signal.aborted){Promise.resolve(promise).catch(()=>{});abort();return;}
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
export function createCapabilityRuntime({root,fetchImpl=fetch,executors,accountScope=()=>activeConnection(root).id,now=Date.now}={}){
  const drawing=executors?.drawing??createDrawingExecution({fetchImpl});
  const voice=executors?.voice??createVoiceExecutor({root,fetchImpl});
  const singing=executors?.singing??createSingingExecutor({root,fetchImpl});
  const records=new Map(),controllers=new Set();let closed=false;
  const status=()=>({version:CAPABILITY_EXECUTION_VERSION,host:'dsh',operations:Object.keys(CAPABILITY_OPERATIONS),running:controllers.size});
  async function execute(request,{signal,onProgress=()=>{}}={}){
    if(closed)throw capabilityFault('CAPABILITY_PLUGIN_CLOSED','DSH 能力插件已关闭。');
    const {operation,payload,requestId,issuedAt,accountScope:scope}=request??{};
    if(!request||Object.keys(request).some(key=>!['operation','payload','requestId','issuedAt','accountScope'].includes(key))||!Object.hasOwn(CAPABILITY_OPERATIONS,operation)||!payload||typeof payload!=='object'||Array.isArray(payload)||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(requestId??'')||!Number.isSafeInteger(issuedAt)||typeof scope!=='string'||scope!==accountScope())throw capabilityFault('CAPABILITY_REQUEST_INVALID','能力执行请求或当前账号无效。',400);
    signal?.throwIfAborted();
    for(const [id,row]of records)if(row.completedAt!==null&&now()-row.completedAt>120000&&now()-row.issuedAt>120000)records.delete(id);
    const fingerprint=crypto.createHash('sha256').update(JSON.stringify([operation,payload,scope,issuedAt])).digest('hex');
    const previous=records.get(requestId);
    if(previous){
      if(previous.fingerprint!==fingerprint)throw capabilityFault('CAPABILITY_REQUEST_CONFLICT','此能力任务编号已用于其他请求。',409);
      if(previous.expired)throw capabilityFault('CAPABILITY_RESULT_EXPIRED','此任务已经执行，返回结果已过期；没有重新生成。',409);
      return previous.promise;
    }
    if(Math.abs(now()-issuedAt)>120000)throw capabilityFault('CAPABILITY_REQUEST_EXPIRED','此执行请求已过期，没有重新生成。',409);
    if(records.size>=512)throw capabilityFault('CAPABILITY_EXECUTION_LIMIT','能力执行请求过于频繁，请稍后再试。',429);
    const controller=new AbortController(),combined=AbortSignal.any([controller.signal,AbortSignal.timeout(CAPABILITY_OPERATIONS[operation]),...(signal?[signal]:[])]);
    controllers.add(controller);
    const row={fingerprint,issuedAt,startedAt:now(),completedAt:null};records.set(requestId,row);
    const progress=stage=>{combined.throwIfAborted();if(typeof stage==='string'&&stage.length<=200&&!/[\r\n\0]|https?:\/\/|[A-Z]:[\\/]/i.test(stage))onProgress(stage);};
    row.promise=abortable((async()=>{
      combined.throwIfAborted();if(scope!==accountScope())throw capabilityFault('CAPABILITY_ACCOUNT_CHANGED','微信账号已变化，本次生成已取消。',409);
      const options={signal:combined,onProgress:progress};
      const result=operation.startsWith('drawing.')?await drawing(operation,payload,options):operation.startsWith('voice.')?await voice[operation.slice(6)](payload,options):await singing(operation,payload,options);
      combined.throwIfAborted();if(scope!==accountScope())throw capabilityFault('CAPABILITY_ACCOUNT_CHANGED','微信账号已变化，生成结果没有交付。',409);
      return result;
    })(),combined);
    try{return await row.promise;}
    finally{
      row.completedAt=now();controllers.delete(controller);
      // Keep duplicate-request fingerprints while releasing large media results.
      // An expired execution is never silently submitted to a paid service again.
      const completed=[...records.values()].filter(value=>value.completedAt&&!value.expired);
      for(const old of completed.slice(0,-3)){old.expired=true;old.promise=null;}
    }
  }
  return {status,execute,isBusy:()=>controllers.size>0,close(){closed=true;for(const controller of controllers)controller.abort();voice.close?.();}};
}
