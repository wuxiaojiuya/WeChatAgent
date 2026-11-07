import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';
import {activeReaderAccount} from './reader-account-state.mjs';
import {allowedConversation} from '../packages/dsh-social-bridge-plugin/conversation-policy.mjs';
import {conversationId} from './hook-onebot.mjs';
import {hookAccountProblem} from './wechat-account-check.mjs';

const identifier=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const serverId=value=>typeof value==='string'&&/^[1-9]\d{0,19}$/.test(value);
const digest=(value,algorithm='sha256')=>crypto.createHash(algorithm).update(value).digest('hex');
const fail=code=>{throw Error(code);};
const safeError=error=>/^IMAGE_[A-Z0-9_]{1,70}$/.test(error?.message??'')?error.message:'IMAGE_DELIVERY_FAILED';
const maxBytes=16*1024*1024;
const crcTable=Uint32Array.from({length:256},(_,index)=>{for(let n=0;n<8;n++)index=index&1?0xedb88320^(index>>>1):index>>>1;return index>>>0;});
const crc32=bytes=>{let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;};

export function imageMetadata(bytes){
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>maxBytes)fail('IMAGE_BYTES_INVALID');
  let width,height,format;
  if(bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))){
    let offset=8,header=false,ended=false,seenIdat=false,afterIdat=false,depth,type,interlace;
    const chunks=[];
    while(offset<bytes.length){
      if(offset+12>bytes.length)fail('IMAGE_FORMAT_INVALID');
      const size=bytes.readUInt32BE(offset),end=offset+12+size,name=bytes.toString('ascii',offset+4,offset+8);
      if(end>bytes.length||!size&&name!=='IEND'||!/^[A-Za-z]{4}$/.test(name)||crc32(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4))fail('IMAGE_FORMAT_INVALID');
      if(!header&&name!=='IHDR'||name==='IHDR'&&header||name==='acTL')fail('IMAGE_FORMAT_INVALID');
      if(name==='IHDR'){
        if(size!==13)fail('IMAGE_FORMAT_INVALID');
        width=bytes.readUInt32BE(offset+8);height=bytes.readUInt32BE(offset+12);depth=bytes[offset+16];type=bytes[offset+17];interlace=bytes[offset+20];header=true;
        const depths={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
        if(!depths[type]?.includes(depth)||bytes[offset+18]!==0||bytes[offset+19]!==0||interlace>1)fail('IMAGE_FORMAT_INVALID');
      }else if(name==='IDAT'){if(afterIdat)fail('IMAGE_FORMAT_INVALID');seenIdat=true;chunks.push(bytes.subarray(offset+8,end-4));}
      else{if(seenIdat)afterIdat=true;if(name==='IEND'){if(size!==0||end!==bytes.length||!seenIdat)fail('IMAGE_FORMAT_INVALID');ended=true;}}
      offset=end;
    }
    if(!ended||!width||!height||width>8192||height>8192||width*height>40000000)fail('IMAGE_DIMENSIONS_INVALID');
    const channels={0:1,2:3,3:1,4:2,6:4}[type],passes=interlace?[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]]:[[0,0,1,1]];
    const scans=passes.map(([x,y,dx,dy])=>{const w=Math.max(0,Math.ceil((width-x)/dx)),h=Math.max(0,Math.ceil((height-y)/dy));return {rows:w?h:0,stride:1+Math.ceil(w*channels*depth/8)};});
    const expected=scans.reduce((total,scan)=>total+scan.rows*scan.stride,0);
    if(expected>128*1024*1024)fail('IMAGE_DIMENSIONS_INVALID');
    let pixels;try{pixels=inflateSync(Buffer.concat(chunks),{maxOutputLength:expected});}catch{fail('IMAGE_FORMAT_INVALID');}
    if(pixels.length!==expected)fail('IMAGE_FORMAT_INVALID');
    let cursor=0;for(const scan of scans)for(let row=0;row<scan.rows;row++){if(pixels[cursor]>4)fail('IMAGE_FORMAT_INVALID');cursor+=scan.stride;}
    format='png';
  }else if(bytes[0]===255&&bytes[1]===216&&bytes.at(-2)===255&&bytes.at(-1)===217){
    let offset=2,scan=false;
    while(offset<bytes.length-2){
      if(bytes[offset++]!==255)fail('IMAGE_FORMAT_INVALID');while(bytes[offset]===255)offset++;
      const marker=bytes[offset++];if(marker===0xda){scan=true;break;}
      if(marker===0xd8||marker===0xd9||marker===0||marker>=0xd0&&marker<=0xd7)fail('IMAGE_FORMAT_INVALID');
      if(offset+2>bytes.length)fail('IMAGE_FORMAT_INVALID');const size=bytes.readUInt16BE(offset);
      if(size<2||offset+size>bytes.length)fail('IMAGE_FORMAT_INVALID');
      if([0xc0,0xc1,0xc2].includes(marker)){if(size<8)fail('IMAGE_FORMAT_INVALID');height=bytes.readUInt16BE(offset+3);width=bytes.readUInt16BE(offset+5);}
      offset+=size;
    }
    if(!scan||!width||!height||width>8192||height>8192||width*height>40000000)fail('IMAGE_FORMAT_INVALID');format='jpeg';
  }else fail('IMAGE_FORMAT_INVALID');
  return {format,mime:'image/'+format,extension:format==='png'?'.png':'.jpg',width,height,size:bytes.length,md5:digest(bytes,'md5'),sha256:digest(bytes)};
}

export function createNativeImageDelivery({root,config,enabledFor,reader,fetchImpl=fetch,now=Date.now,receiptTimeoutMs=18000,pollMs=400}={}){
  root=path.resolve(root);const directory=path.join(root,'state/image-output/deliveries'),records=new Map(),tasks=new Map(),controllers=new Set();
  let closed=false,lane=Promise.resolve(),corrupt=false;
  const scope=()=>{const value=activeReaderAccount(root).id;if(!identifier(value))fail('IMAGE_ACCOUNT_UNAVAILABLE');return value;};
  const token=()=>{const value=fs.readFileSync(path.join(root,'state/hook/native-token.txt'),'utf8').trim();if(!identifier(value))fail('IMAGE_HOOK_UNAVAILABLE');return value;};
  const origin=()=>{const h=config().hook;let url;try{url=new URL(h.baseUrl);}catch{fail('IMAGE_HOOK_UNAVAILABLE');}
    if(h.backend!=='supplier-http'||h.expectedVersion!=='4.1.8.27'||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)fail('IMAGE_HOOK_UNAVAILABLE');return url.origin;};
  const binding=()=>digest(JSON.stringify([config().hook,token()]));
  const assertScope=key=>{if(closed||!/^wechat:(private|group):[1-9]\d*$/.test(key)||!allowedConversation(config().wechat,key)||enabledFor(key)!==true)fail('IMAGE_SCOPE_DENIED');origin();return scope();};
  function local(file,base=path.join(root,'state')){
    const target=path.resolve(file),relative=path.relative(base,target);if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))fail('IMAGE_FILE_OUTSIDE_STATE');
    for(let current=target;;current=path.dirname(current)){if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())fail('IMAGE_FILE_LINK_DENIED');if(current===base)break;}
    return target;
  }
  const view=r=>({id:r.id,conversationKey:r.key,state:r.state,sent:r.state==='confirmed',confirmed:r.state==='confirmed',...(r.error?{code:safeError({message:r.error})}:{}),...(r.state==='confirmed'?{serverId:r.serverId,receipt:'wechat-image-server-id'}:{}),
    message:r.state==='confirmed'?'图片已取得微信服务器回执。':r.state==='unconfirmed'?'图片发送结果未确认，不会自动重发。':r.state==='failed'?'图片没有发送成功。':'图片已生成，正在准备发送或核对微信回执。'});
  function persist(r){local(path.join(directory,r.id+'.json'));fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,r.id+'.json'),temporary=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temporary,JSON.stringify(r),{flag:'wx',mode:0o600});fs.renameSync(temporary,file);records.set(r.id,r);}
  function getRecord(id,key){assertScope(key);const r=records.get(id);if(!identifier(id)||!r||r.key!==key||r.accountScope!==scope())fail('IMAGE_DELIVERY_NOT_FOUND');return r;}
  const get=(id,key)=>view(getRecord(id,key));
  async function api(route,body,signal){
    const response=await fetchImpl(origin()+route,{method:body?'POST':'GET',redirect:'error',headers:{Authorization:'Bearer '+token(),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.any([signal,AbortSignal.timeout(body?35000:4000)])});
    if(!response.ok)fail('IMAGE_HTTP_'+response.status);let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>128*1024)fail('IMAGE_HOOK_RESPONSE_INVALID');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async function capture(key,{signal=new AbortController().signal}={}){
    const accountScope=assertScope(key),own=await reader('/api/v1/reader/status');
    if(own?.backend!=='supplier-http'||typeof own.ownWxid!=='string'||!own.ownWxid||typeof own.accountDirectory!=='string'||!own.accountDirectory)fail('IMAGE_READER_UNAVAILABLE');
    const health=await api('/WeChatAgent/health',undefined,signal),problem=hookAccountProblem(health,own.accountDirectory,'4.1.8.27');
    if(problem||health.nativeImageSend!==true||health.ready!==true||!Number.isInteger(health.pid)||health.pid<=0)fail('IMAGE_HOOK_IDENTITY_INVALID');
    const [,kind,id]=key.split(':'),sessions=await reader('/api/v1/sessions?limit=500');
    const matches=(sessions.sessions??[]).filter(item=>typeof item.username==='string'&&(item.username.includes('@chatroom')?'group':'private')===kind&&String(conversationId(item.username,item.displayName,item.conversationId))===id);
    if(matches.length!==1||matches[0].username===own.ownWxid)fail('IMAGE_TARGET_UNRESOLVED');
    signal.throwIfAborted();if(assertScope(key)!==accountScope)fail('IMAGE_ACCOUNT_CHANGED');
    return {accountScope,accountWxid:own.ownWxid,accountDirectory:own.accountDirectory.toLowerCase(),target:matches[0].username,binding:binding()};
  }
  const same=(r,ticket)=>['accountScope','accountWxid','accountDirectory','target','binding'].every(field=>r[field]===ticket?.[field]);
  async function rowsFor(r){const result=await reader('/api/v1/messages?talker='+encodeURIComponent(r.target)+'&limit=100');if(!Array.isArray(result.messages))fail('IMAGE_READER_UNAVAILABLE');return result.messages;}
  async function reconcile(r,signal){
    const deadline=Date.now()+receiptTimeoutMs;
    do{
      signal.throwIfAborted();if(!same(r,await capture(r.key,{signal})))fail('IMAGE_ACCOUNT_CHANGED');
      const candidates=(await rowsFor(r)).filter(row=>(row.isSend===true||row.isSend===1)&&row.localType===3&&String(row.imageMd5??'').toLowerCase()===r.md5&&!r.baseline.includes(String(row.localId))&&Number.isSafeInteger(Number(row.localId))&&Number(row.localId)>0&&Number(row.createTime)>=Math.floor(r.startedAt/1000)-30&&Number(row.createTime)<=Math.floor(r.startedAt/1000)+120);
      if(candidates.length>1)fail('IMAGE_RECEIPT_AMBIGUOUS');
      const row=candidates[0];if(row&&(!r.candidateId||r.candidateId===String(row.localId))){r.candidateId=String(row.localId);persist(r);if(serverId(row.serverId)){r.serverId=row.serverId;r.state='confirmed';r.confirmedAt=now();delete r.error;persist(r);return;}}
      if(Date.now()>=deadline)break;await delay(pollMs,undefined,{signal});
    }while(!closed);
    r.state='unconfirmed';r.error='IMAGE_DELIVERY_UNCONFIRMED';persist(r);
  }
  function run(r){
    if(tasks.has(r.id))return tasks.get(r.id);const controller=new AbortController(),signal=controller.signal;controllers.add(controller);
    const task=lane.catch(()=>{}).then(async()=>{
      try{
        signal.throwIfAborted();if(!same(r,await capture(r.key,{signal})))fail('IMAGE_ACCOUNT_CHANGED');
        if(r.state==='queued'){
          const file=local(path.join(directory,r.id+r.extension)),bytes=fs.readFileSync(file);if(imageMetadata(bytes).sha256!==r.sha256)fail('IMAGE_FILE_CHANGED');
          r.baseline=(await rowsFor(r)).map(row=>String(row.localId));signal.throwIfAborted();if(assertScope(r.key)!==r.accountScope||r.binding!==binding())fail('IMAGE_ACCOUNT_CHANGED');
          r.state='dispatching';r.startedAt=now();persist(r);
          try{const result=await api('/SendImageMsg',{wxidorgid:r.target,path:file,md5:r.md5,size:r.size},signal);
            if(result?.ret!==0){r.state='failed';r.error='IMAGE_NATIVE_REJECTED';persist(r);return;}r.state='submitted';persist(r);
          }catch(error){r.submissionCode=safeError(error);persist(r);}
        }
        await reconcile(r,signal);
      }catch(error){r.state=r.startedAt?'unconfirmed':'failed';r.error=safeError(error);try{persist(r);}catch{}}
      finally{controllers.delete(controller);}
    });tasks.set(r.id,task);lane=task;void task.finally(()=>tasks.delete(r.id));return task;
  }
  async function send({id,conversationKey:key,file,accountScope,ticket}){
    assertScope(key);if(!identifier(id)||accountScope!==scope())fail('IMAGE_ACCOUNT_CHANGED');
    if(records.has(id)){const prior=getRecord(id,key);if(!same(prior,ticket))fail('IMAGE_DELIVERY_ID_CONFLICT');return view(prior);}
    if(corrupt)fail('IMAGE_DELIVERY_STATE_INVALID');
    if(records.size>=128||[...records.values()].reduce((sum,r)=>sum+r.size,0)>=512*1024*1024)fail('IMAGE_STORAGE_LIMIT');
    const current=await capture(key);if(!same(current,ticket)||current.accountScope!==accountScope)fail('IMAGE_ACCOUNT_CHANGED');
    // Recheck after asynchronous identity work: concurrent same-ID requests reuse
    // the first durable operation rather than racing a second native submission.
    if(records.has(id))return get(id,key);
    if([...records.values()].filter(r=>['queued','dispatching','submitted'].includes(r.state)).length>=4)fail('IMAGE_QUEUE_FULL');
    const source=local(file),stat=fs.statSync(source);if(!stat.isFile()||stat.size>maxBytes)fail('IMAGE_BYTES_INVALID');const bytes=fs.readFileSync(source),metadata=imageMetadata(bytes);
    const r={version:1,id,key,...current,...metadata,state:'queued',createdAt:now()};
    const target=local(path.join(directory,id+metadata.extension));fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});persist(r);run(r);return view(r);
  }
  if(fs.existsSync(directory)){
    local(path.join(directory,'state-check'));for(const name of fs.readdirSync(directory).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).slice(0,129)){
      try{if(records.size>=128)fail('IMAGE_STORAGE_LIMIT');const file=local(path.join(directory,name));if(fs.statSync(file).size>32768)fail('IMAGE_DELIVERY_STATE_INVALID');const r=JSON.parse(fs.readFileSync(file,'utf8'));
        if(r.version!==1||name!==r.id+'.json'||!identifier(r.id)||!identifier(r.accountScope)||!identifier(r.binding)||!identifier(r.sha256)||!/^[a-f0-9]{32}$/.test(r.md5??'')||!/^wechat:(private|group):[1-9]\d*$/.test(r.key)||!['.png','.jpg'].includes(r.extension)||!Number.isSafeInteger(r.size)||r.size<1||r.size>maxBytes||!['queued','dispatching','submitted','confirmed','failed','unconfirmed'].includes(r.state)||!Number.isFinite(r.createdAt)||!['accountWxid','accountDirectory','target'].every(field=>typeof r[field]==='string'&&/^[A-Za-z0-9_@.-]{1,180}$/.test(r[field])))fail('IMAGE_DELIVERY_STATE_INVALID');
        if(r.state==='confirmed'&&!serverId(r.serverId))fail('IMAGE_DELIVERY_STATE_INVALID');
        if(!['confirmed','failed','unconfirmed'].includes(r.state)){r.state=r.startedAt?'unconfirmed':'failed';r.error=r.startedAt?'IMAGE_DELIVERY_UNCONFIRMED':'IMAGE_INTERRUPTED_BEFORE_SUBMISSION';}
        records.set(r.id,r);
      }catch{corrupt=true;}
    }
  }
  return {capture,send,get,lookup(id,key){if(!records.has(id)){assertScope(key);return null;}return get(id,key);},refresh(id,key,{wait=false}={}){const r=getRecord(id,key);if(r.state==='unconfirmed'&&r.startedAt){const task=run(r);if(wait)return task.then(()=>get(id,key));}return get(id,key);},async settled(id,key){getRecord(id,key);await tasks.get(id);return get(id,key);},close(){closed=true;for(const controller of controllers)controller.abort();}};
}
