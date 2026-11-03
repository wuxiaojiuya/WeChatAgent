import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createMusicCapabilities} from './music-capabilities.mjs';
const videoId='a'.repeat(64),conversationKey='wechat:private:123';
function wave(){
  const data=Buffer.alloc(44+44100*4);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(2,22);data.writeUInt32LE(44100,24);data.writeUInt32LE(44100*4,28);data.writeUInt16LE(4,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(data.length-44,40);return data;
}
function fixture(t,options={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'video-singing-'));
  fs.mkdirSync(path.join(root,'state'));fs.writeFileSync(path.join(root,'state/wechat-io-config.json'),JSON.stringify({reader_base_url:'http://127.0.0.1:1',reader_token:'fixture-reader-token'}));
  const bytes=wave(),packet={videoId,conversationKey,startSeconds:0,seconds:1,mime:'audio/wav',b64:bytes.toString('base64'),sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  const service=createMusicCapabilities({root,runCover:async()=>{throw Error('unexpected processing');},fetchImpl:async()=>Response.json(packet),...options});
  t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true});});return {root,service,packet,bytes};
}
test('video singing rejects forged binding, corrupt audio and invalid timing before starting any job',async t=>{
  for(const modify of [p=>p.conversationKey='wechat:private:456',p=>p.videoId='b'.repeat(64),p=>p.sha256='f'.repeat(64),p=>p.seconds=31,p=>p.startSeconds=2,p=>p.b64='not base64']){
    let packet;const f=fixture(t,{fetchImpl:async()=>Response.json(packet)});packet={...f.packet};modify(packet);
    await assert.rejects(f.service.requestVideo({videoId,conversationKey}));assert.equal(f.service.status().latestJob,null);
  }
});
test('revocation, cancellation, local-only policy and path injection cannot admit a video job',async t=>{
  let allowed=true,packet,calls=0;
  const f=fixture(t,{fetchImpl:async url=>{calls++;assert.equal(new URL(url).searchParams.get('localOnly'),'true');allowed=false;return Response.json(packet);}});packet=f.packet;
  await assert.rejects(f.service.requestVideo({videoId,conversationKey,path:'C:/private'}));assert.equal(calls,0);
  await assert.rejects(f.service.requestVideo({videoId,conversationKey,localOnly:true},{isAllowed:()=>allowed}),error=>error.status===403);
  assert.equal(f.service.status().latestJob,null);
  const controller=new AbortController();controller.abort();await assert.rejects(f.service.requestVideo({videoId,conversationKey},{signal:controller.signal}));assert.equal(calls,1);
});
test('verified video clip uses original stereo bytes, skips music search and keeps it out of shared song cache',{skip:!fs.existsSync('C:/ffmpeg-tools/bin/ffmpeg.exe')},async t=>{
  let packet,seenInput,bytes,root;
  const f=fixture(t,{settings:()=>({modelId:'configured-voice',pitch:2,accompaniment:true}),fetchImpl:async(url,options)=>{
    assert(new URL(url).pathname.endsWith('/'+videoId+'/singing-audio'));assert.equal(options.headers.Authorization,'Bearer fixture-reader-token');return Response.json(packet);
  },runCover:async options=>{
    seenInput=options.input;assert.deepEqual(fs.readFileSync(options.input),bytes);assert.equal(options.seconds,1);assert.equal(options.pitch,2);assert.equal(options.accompaniment,true);
    fs.writeFileSync(path.join(options.output,'result.json'),JSON.stringify({status:'success',seconds:1}));fs.writeFileSync(path.join(options.output,'feiyu-cover-1s.wav'),bytes);
  }});({packet,bytes,root}=f);
  const job=await f.service.requestVideo({videoId,conversationKey});
  const ready=await f.service.settled(job.id);assert.equal(ready.state,'success',ready.error);assert.equal(ready.sourceKind,'video');
  assert.equal(f.service.status().cachedSongs,0);assert.equal(fs.existsSync(seenInput),false);assert.equal(f.service.preview({jobId:job.id}).mime,'audio/mpeg');
});
