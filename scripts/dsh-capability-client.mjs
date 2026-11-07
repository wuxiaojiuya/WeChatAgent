import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {activeConnection} from './hook-connection-state.mjs';
import {CAPABILITY_EXECUTION_VERSION,CAPABILITY_OPERATIONS,capabilityFault} from '../packages/dsh-capabilities-plugin/contract.mjs';

export function createDshCapabilityClient({root,config,fetchImpl=fetch,accountScope=()=>activeConnection(root).id}={}){
  const execute=async(operation,payload,{signal,onProgress,timeoutMs}={})=>{
    if(!Object.hasOwn(CAPABILITY_OPERATIONS,operation))throw capabilityFault('CAPABILITY_OPERATION_INVALID','未知的生成能力。',400);
    const tokenFile=path.join(root,'state/social-dsh-token.txt');
    if(!fs.existsSync(tokenFile))throw capabilityFault('DSH_CAPABILITY_UNAVAILABLE','请先打开 DSH 并启用本项目的能力插件，再生成图片、语音或演唱。');
    const token=fs.readFileSync(tokenFile,'utf8').trim(),port=config().ports?.dshPlugin;
    if(!token||!Number.isInteger(port)||port<1024||port>65535)throw capabilityFault('DSH_CAPABILITY_UNAVAILABLE','DSH 能力插件连接尚未配置完成。');
    const origin='http://127.0.0.1:'+port,scope=accountScope();
    let health;
    try{const response=await fetchImpl(origin+'/health',{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(4000),...(signal?[signal]:[])])});health=await response.json();
      if(!response.ok||health.ok!==true||health.project!=='WeChatAgent'||typeof health.projectRoot!=='string'||path.resolve(health.projectRoot).toLowerCase()!==path.resolve(root).toLowerCase()||health.capabilityExecution!==CAPABILITY_EXECUTION_VERSION||health.accountScope!==scope||typeof health.instanceId!=='string')throw Error('WRONG_PLUGIN');}
    catch{signal?.throwIfAborted();throw capabilityFault('DSH_CAPABILITY_UNAVAILABLE','DSH 能力插件未就绪，请打开 DSH 并加载当前项目的新版插件。');}
    const controller=new AbortController(),combined=AbortSignal.any([controller.signal,AbortSignal.timeout(Math.min(CAPABILITY_OPERATIONS[operation]+10000,timeoutMs??CAPABILITY_OPERATIONS[operation]+10000)),...(signal?[signal]:[])]);
    let response,reader,settled=false;
    try{
      response=await fetchImpl(origin+'/capability-execution',{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({operation,payload,requestId:crypto.randomUUID(),issuedAt:Date.now(),accountScope:scope,dshInstanceId:health.instanceId}),signal:combined});
      if(!response.ok){let value;try{value=await response.json();}catch{}throw capabilityFault('DSH_CAPABILITY_REJECTED',value?.error==='DSH_CONNECTION_CHANGED'?'DSH 已重新加载，本次任务没有重新提交，请再试一次。':'DSH 能力插件拒绝本次执行，请检查当前连接和任务状态。',503);}
      if(!response.headers.get('content-type')?.includes('application/x-ndjson'))throw capabilityFault('CAPABILITY_PROTOCOL_INVALID','DSH 能力插件返回格式不匹配，请更新项目插件。',502);
      reader=response.body.getReader();const decoder=new TextDecoder();let pending='',total=0;
      for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>48*1024*1024)throw capabilityFault('CAPABILITY_RESULT_TOO_LARGE','生成结果超过传输上限。',502);pending+=decoder.decode(value,{stream:true});
        let index;while((index=pending.indexOf('\n'))>=0){const line=pending.slice(0,index);pending=pending.slice(index+1);if(!line)continue;const event=JSON.parse(line);
          if(event.event==='progress'){if(typeof event.stage==='string')onProgress?.(event.stage);}
          else if(event.event==='error'){settled=true;throw capabilityFault(/^[A-Z][A-Z0-9_]{2,80}$/.test(event.code??'')?event.code:'CAPABILITY_EXECUTION_FAILED',typeof event.message==='string'&&event.message.length<=500?event.message:'能力生成未完成。',Number.isInteger(event.status)?event.status:503);}
          else if(event.event==='result'){combined.throwIfAborted();if(scope!==accountScope())throw capabilityFault('CAPABILITY_ACCOUNT_CHANGED','微信账号已变化，生成结果未交付。',409);settled=true;return event.value;}
        }
      }
      throw capabilityFault('CAPABILITY_RESULT_UNCONFIRMED','DSH 生成结果尚未确认，未自动重新生成；请查看任务记录。',502);
    }catch(error){if(error.code&&error.status)throw error;throw capabilityFault('CAPABILITY_RESULT_UNCONFIRMED',combined.aborted?'DSH 生成已取消或超时，未自动重试。':'DSH 生成连接中断，结果尚未确认，未自动重试。',502);}
    finally{controller.abort();if(reader&&!settled)await reader.cancel().catch(()=>{});}
  };
  return {execute};
}
