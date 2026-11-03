import path from 'node:path';

// Only the local console for this checkout is a valid destination.
export function consoleClient(root,{fetchImpl=fetch,port=Number(process.env.WECHATAGENT_CONSOLE_PORT??3210)}={}) {
  return async (route,body,{signal}={})=>{
    if(!Number.isInteger(port)||port<1024||port>65535)throw Error('控制台端口无效。');
    signal=AbortSignal.any([AbortSignal.timeout(12000),...(signal?[signal]:[])]);
    const origin='http://127.0.0.1:'+port;
    const infoResponse=await fetchImpl(origin+'/api/info',{redirect:'error',signal});
    const info=await infoResponse.json();
    if(!infoResponse.ok||info.project!=='WeChatAgent Console'||typeof info.root!=='string'||path.resolve(info.root)!==path.resolve(root)||typeof info.token!=='string')throw Error('项目控制台未就绪。');
    const response=await fetchImpl(origin+route,{method:body===undefined?'GET':'POST',redirect:'error',signal,headers:{'X-Console-Token':info.token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const value=await response.json();
    if(!response.ok)throw Object.assign(Error(value.error??'操作未完成。'),{status:response.status});
    return value;
  };
}
