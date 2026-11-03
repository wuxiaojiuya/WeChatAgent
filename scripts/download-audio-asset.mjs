import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createReadStream} from 'node:fs';
import {pathToFileURL} from 'node:url';

export async function downloadAudioAsset(url,target,sha,expected,{fetchImpl=fetch,notify=()=>{}}={}){
  fs.mkdirSync(path.dirname(target),{recursive:true});const partial=target+'.partial';
  let offset=fs.existsSync(partial)?fs.statSync(partial).size:0;
  if(expected&&offset>=expected){fs.rmSync(partial);offset=0;}
  const response=await fetchImpl(url,{headers:offset?{Range:`bytes=${offset}-`}:{},signal:AbortSignal.timeout(3600000)});
  if(!response.ok)throw Object.assign(Error(response.status===403||response.status===429?'AUDIO_DOWNLOAD_ACCESS_DENIED':'AUDIO_DOWNLOAD_FAILED'),{status:response.status});
  if(offset&&(response.status!==206||!response.headers.get('content-range')?.startsWith(`bytes ${offset}-`)))offset=0;
  const total=expected||Number(response.headers.get('content-length'))+offset;
  let received=offset,last=0;const fd=fs.openSync(partial,offset?'a':'w');
  try{for await(const chunk of response.body){received+=chunk.length;if(received>(expected||2*1024**3))throw Error('AUDIO_DOWNLOAD_TOO_LARGE');fs.writeSync(fd,chunk);if(Date.now()-last>1000){notify({phase:'download',message:'正在下载并校验安装资源',downloaded:received,total});last=Date.now();}}}finally{fs.closeSync(fd);}
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
