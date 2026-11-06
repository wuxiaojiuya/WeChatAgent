const MAX_IMAGE=16*1024*1024;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fault=(code,status=502)=>Object.assign(new Error(code),{code,status});
const safeCodes=new Set(['DRAWING_CONFIG_INVALID','DRAWING_RESPONSE_INVALID','DRAWING_RESPONSE_TOO_LARGE','DRAWING_KEY_INVALID','DRAWING_FORBIDDEN','DRAWING_RATE_LIMIT','DRAWING_REQUEST_REJECTED','DRAWING_NOT_FOUND','DRAWING_PROVIDER_UNAVAILABLE','DRAWING_MODEL_UNCONFIRMED','DRAWING_IMAGE_INVALID']);

function endpoint(value){
  let url;try{url=new URL(value);}catch{throw fault('DRAWING_CONFIG_INVALID',400);}
  if(typeof value!=='string'||value.length>2048||url.username||url.password||url.search||url.hash||!/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/.test(url.pathname)||
    !(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))||url.pathname.endsWith('/images/generations'))throw fault('DRAWING_CONFIG_INVALID',400);
  return url.origin+url.pathname.replace(/\/+$/,'');
}
function settings(value){
  if(!record(value)||Object.keys(value).some(key=>!['endpoint','apiKey','model','size','quality'].includes(key))||typeof value.apiKey!=='string'||!value.apiKey.trim()||value.apiKey.length>4096||/[\r\n\0]/.test(value.apiKey)||
    typeof value.model!=='string'||!/^gpt-image-[A-Za-z0-9._-]{1,100}$/.test(value.model)&&value.model!=='chatgpt-image-latest'||!['1024x1024','1536x1024','1024x1536','auto'].includes(value.size)||!['auto','low','medium','high'].includes(value.quality))throw fault('DRAWING_CONFIG_INVALID',400);
  return {...value,endpoint:endpoint(value.endpoint)};
}
function abortable(promise,signal){
  if(!signal)return Promise.resolve(promise);
  return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason??fault('DRAWING_ABORTED'));if(signal.aborted){Promise.resolve(promise).catch(()=>{});abort();return;}
    signal.addEventListener('abort',abort,{once:true});Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
async function responseJson(response,limit,signal){
  if(!response?.body)throw fault('DRAWING_RESPONSE_INVALID');
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){signal?.throwIfAborted();bytes+=chunk.length;if(bytes>limit)throw fault('DRAWING_RESPONSE_TOO_LARGE');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fault('DRAWING_RESPONSE_INVALID');}
}
function responseError(status){
  return fault({401:'DRAWING_KEY_INVALID',403:'DRAWING_FORBIDDEN',429:'DRAWING_RATE_LIMIT',400:'DRAWING_REQUEST_REJECTED',404:'DRAWING_NOT_FOUND'}[status]??'DRAWING_PROVIDER_UNAVAILABLE');
}
function pngDimensions(image){
  if(typeof image!=='string'||!image.length||image.length>Math.ceil(MAX_IMAGE/3)*4||image.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(image))throw fault('DRAWING_IMAGE_INVALID');
  const bytes=Buffer.from(image,'base64');
  if(bytes.length>MAX_IMAGE||bytes.toString('base64')!==image||bytes.length<33||!bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))||bytes.readUInt32BE(8)!==13||bytes.toString('ascii',12,16)!=='IHDR')throw fault('DRAWING_IMAGE_INVALID');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  if(!width||!height||width>8192||height>8192||width*height>40000000)throw fault('DRAWING_IMAGE_INVALID');
  // The console validates the complete PNG (CRC, chunks and decompressed pixels)
  // before it saves or delivers the returned bytes. No remote image URL is used.
  return {image,width,height};
}

// Called by authenticated local DSH RPC, never exposed as a model tool. Secrets
// are request-only values; the executor does not save settings or log responses.
export function createDrawingExecution({fetchImpl=fetch}={}){
  return async function execution(operation,payload,{signal}={}){
    if(!['drawing.check','drawing.generate'].includes(operation))throw fault('DRAWING_OPERATION_INVALID',404);
    const keys=operation==='drawing.check'?['settings']:['settings','prompt'];
    if(!record(payload)||Object.keys(payload).some(key=>!keys.includes(key)))throw fault('DRAWING_CONFIG_INVALID',400);
    const value=settings(payload.settings);
    if(operation==='drawing.generate'&&(typeof payload.prompt!=='string'||!payload.prompt.trim()||payload.prompt.length>4000||/\0/.test(payload.prompt)))throw fault('DRAWING_CONFIG_INVALID',400);
    if(signal?.aborted)throw fault('DRAWING_ABORTED');
    try{
      const response=await abortable(fetchImpl(value.endpoint+(operation==='drawing.check'?'/models/'+encodeURIComponent(value.model):'/images/generations'),{
        ...(operation==='drawing.generate'?{method:'POST',body:JSON.stringify({model:value.model,prompt:payload.prompt.trim(),n:1,size:value.size,quality:value.quality,output_format:'png'})}:{}),
        headers:{Authorization:'Bearer '+value.apiKey,...(operation==='drawing.generate'?{'Content-Type':'application/json'}:{})},redirect:'error',signal
      }),signal);
      signal?.throwIfAborted();if(!response.ok)throw responseError(response.status);
      const result=await abortable(responseJson(response,operation==='drawing.check'?1024*1024:23*1024*1024,signal),signal);signal?.throwIfAborted();
      if(operation==='drawing.check'){if(result?.id!==value.model)throw fault('DRAWING_MODEL_UNCONFIRMED');return {model:value.model};}
      return pngDimensions(result?.data?.length===1?result.data[0]?.b64_json:undefined);
    }catch(error){
      if(signal?.aborted)throw fault('DRAWING_ABORTED');
      if(safeCodes.has(error?.code))throw fault(error.code,error.code==='DRAWING_CONFIG_INVALID'?400:502);
      throw fault('DRAWING_PROVIDER_UNAVAILABLE');
    }
  };
}
