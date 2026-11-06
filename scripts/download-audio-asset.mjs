import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createReadStream} from 'node:fs';
import {pathToFileURL} from 'node:url';

export async function downloadAudioAsset(url,target,sha,expected,{fetchImpl=fetch,notify=()=>{},rangeBytes}={}){
  fs.mkdirSync(path.dirname(target),{recursive:true});const partial=target+'.partial';
  let offset=fs.existsSync(partial)?fs.statSync(partial).size:0;
  if(expected&&offset>=expected){fs.rmSync(partial);offset=0;}
  const official=new URL(url).hostname==='huggingface.co';
  rangeBytes??=official&&expected>500*1024**2?16*1024**2:0;
  let received=offset,last=0;
  do{
    const start=received,end=rangeBytes&&expected?Math.min(start+rangeBytes,expected)-1:null;
    const requestUrl=new URL(url);
    // Different ranges need different resolver cache keys for HF's signed CDN redirects.
    if(official&&end!==null)requestUrl.searchParams.set('range_start',String(start));
    const response=await fetchImpl(requestUrl.href,{headers:end!==null?{Range:`bytes=${start}-${end}`}:(start?{Range:`bytes=${start}-`}:{}),signal:AbortSignal.timeout(3600000)});
    if(!response.ok)throw Object.assign(Error(response.status===403||response.status===429?'AUDIO_DOWNLOAD_ACCESS_DENIED':'AUDIO_DOWNLOAD_FAILED'),{status:response.status});
    const selected=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')??'');
    if(response.status===206&&(!selected||Number(selected[1])!==start||expected&&Number(selected[3])!==expected)){
      await response.body?.cancel();throw Error('AUDIO_DOWNLOAD_RANGE_INVALID');
    }
    if(response.status!==206)received=0;
    const total=expected||Number(response.headers.get('content-length'))+received;
    const fd=fs.openSync(partial,received?'a':'w');let chunkBytes=0;
    try{for await(const chunk of response.body){received+=chunk.length;chunkBytes+=chunk.length;if(received>(expected||2*1024**3)||selected&&received>Number(selected[2])+1)throw Error('AUDIO_DOWNLOAD_TOO_LARGE');fs.writeSync(fd,chunk);if(Date.now()-last>1000){notify({phase:'download',message:'正在下载并校验安装资源',downloaded:received,total});last=Date.now();}}}finally{fs.closeSync(fd);}
    if(!chunkBytes||selected&&received!==Number(selected[2])+1)throw Error('AUDIO_DOWNLOAD_INCOMPLETE');
    if(response.status!==206||!expected)break;
  }while(received<expected);
  const hash=crypto.createHash('sha256');for await(const chunk of createReadStream(partial))hash.update(chunk);
  if(expected&&received!==expected)throw Error('AUDIO_DOWNLOAD_INCOMPLETE');
  if(hash.digest('hex')!==sha){fs.rmSync(partial);throw Error('AUDIO_DOWNLOAD_HASH_MISMATCH');}
  fs.renameSync(partial,target);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const [url,target,sha,size]=process.argv.slice(2);
  try{await downloadAudioAsset(url,target,sha,Number(size)||undefined,{notify:e=>console.log(JSON.stringify(e))});}
  catch(error){let host;try{host=new URL(url).hostname;}catch{}console.log(JSON.stringify({phase:'failed',message:'下载未完成',...(host?{sourceHost:host}:{}),...(Number.isSafeInteger(error.status)?{httpStatus:error.status}:{}),code:/^AUDIO_[A-Z_]+$/.test(error.message)?error.message:'AUDIO_DOWNLOAD_FAILED'}));process.exitCode=1;}
}
