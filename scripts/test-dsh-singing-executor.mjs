import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createSingingExecutor} from '../packages/dsh-capabilities-plugin/singing.mjs';
import {createMusicCapabilities} from './music-capabilities.mjs';

const plan={version:'score-performance-v1',emotion:'warm',intention:'先轻后强地演唱。',phrases:[{start:0,end:30,articulation:'flowing',timingMs:12,tail:'hold',gainDb:.6,contour:'build'}]};
function fixture(t,options={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-singing-executor-')),id=crypto.randomUUID(),calls=[];
  const input=path.join(root,'state/music-library',id+'.audio'),reference=path.join(root,'state/music-references',id),output=path.join(root,'state/music-jobs',id),model=path.join(root,'state/rvc-models',id);
  for(const directory of [path.dirname(input),reference,output,model])fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(input,'audio');fs.writeFileSync(path.join(output,'performance.json'),JSON.stringify(plan));fs.writeFileSync(path.join(output,'feiyu-cover-30s.wav'),'RIFFfixture');
  const execute=createSingingExecutor({root,models:{get:key=>key==='test-model'?{directory:model}:undefined},probeAudio:async()=>({streams:[{codec_type:'audio'}],format:{duration:120}}),runProcess:async(executable,args,options)=>{calls.push({executable,args,options});options.onData?.('soulx_loading\nsoulx_singing\n"mixing"');},...options});
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,input,reference,output,model,calls,execute};
}

test('DSH singing executor owns probing, reference analysis, score-driven generation and preview conversion',async t=>{
  const f=fixture(t),stages=[];
  assert.deepEqual(await f.execute('audio.probe',{file:f.input}),{durationSeconds:120});
  assert.deepEqual(await f.execute('singing.reference',{input:f.input,output:f.reference,seconds:30,startSeconds:5,withScore:true}),{reference:true});
  assert.deepEqual(await f.execute('singing.render',{input:f.input,output:f.output,reference:f.reference,seconds:30,modelId:'test-model',pitch:2,accompaniment:true,performance:plan},{onProgress:stage=>stages.push(stage)}),{rendered:true});
  assert.deepEqual(await f.execute('singing.preview',{output:f.output,seconds:30}),{preview:true});
  assert.equal(f.calls.length,3);assert.equal(path.basename(f.calls[0].args[0]),'music-reference.py');assert(f.calls[0].args.includes('--soulx-runtime'));
  assert.equal(path.basename(f.calls[1].args[0]),'music-cover.py');assert.equal(f.calls[1].args[f.calls[1].args.indexOf('--model')+1],f.model);assert(f.calls[1].args.includes('--performance'));assert(f.calls[1].args.includes('--reference'));
  assert(f.calls[2].args.includes('libmp3lame'));assert(stages.some(stage=>stage.includes('SoulX 正在重新演唱')));
});

test('DSH singing executor refuses command overrides, external paths, invalid score and foreign models before processing',async t=>{
  const f=fixture(t),base={input:f.input,output:f.output,reference:f.reference,seconds:30,modelId:'test-model',performance:plan};
  for(const [operation,payload]of [['singing.render',{...base,command:'arbitrary'}],['singing.render',{...base,modelId:'../private'}],['singing.render',{...base,input:path.join(f.root,'private.mp3')}],['singing.render',{...base,performance:{...plan,phrases:[{...plan.phrases[0],end:31}]}}],['singing.reference',{input:f.input,output:f.output,seconds:30}],['audio.probe',{file:path.join(os.tmpdir(),'outside.mp3')}],['unknown',{}]])await assert.rejects(f.execute(operation,payload));
  assert.equal(f.calls.length,0);
  const foreign=fixture(t,{models:{get:()=>({directory:path.join(os.tmpdir(),'outside-model')})}});await assert.rejects(foreign.execute('singing.render',{...base,input:foreign.input,output:foreign.output,reference:foreign.reference}));assert.equal(foreign.calls.length,0);
  const controller=new AbortController();controller.abort();await assert.rejects(f.execute('singing.preview',{output:f.output,seconds:30},{signal:controller.signal}));assert.equal(f.calls.length,0);
});

test('DSH singing executor rejects linked inputs and task directories',async t=>{
  const f=fixture(t),outside=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-singing-outside-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  fs.writeFileSync(path.join(outside,'audio'),'audio');const linked=path.join(f.root,'state/music-library',crypto.randomUUID()+'.audio');
  try{fs.symlinkSync(path.join(outside,'audio'),linked,'file');}catch(error){if(['EPERM','EACCES'].includes(error.code))return t.skip('symlinks unavailable');throw error;}
  await assert.rejects(f.execute('audio.probe',{file:linked}),/链接/);assert.equal(f.calls.length,0);
});

test('WeChatAgent cannot probe or start an implicit local generation fallback when DSH execution is missing',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-singing-required-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const service=createMusicCapabilities({root});t.after(()=>service.close());
  const input=path.join(root,'song.mp3');fs.writeFileSync(input,'audio');await assert.rejects(service.importFile({path:input}),/DSH 唱歌能力插件尚未连接/);
  assert.match((await service.search({query:'歌曲'})).remoteError,/DSH 唱歌能力插件尚未连接/);
  const netease=createMusicCapabilities({root,settings:()=>({musicSource:'netease',neteaseCookie:'MUSIC_U=test'})});t.after(()=>netease.close());
  await assert.rejects(netease.checkNetease(),/DSH 唱歌能力插件尚未连接/);
  assert.equal(service.status().cachedSongs,0);assert.equal(service.status().latestJob,null);
});

test('DSH owns music search, authenticated resolution, bounded cache download and public login verification',async t=>{
  const cookie='MUSIC_U=private-test-secret',requests=[],audio=Buffer.from('ID3fixture');
  const f=fixture(t,{fetchImpl:async(url,options)=>{
    const address=new URL(url);requests.push({address,options});
    if(address.hostname==='music.163.com'){
      assert.equal(options.headers.Cookie,cookie);
      if(address.pathname.includes('search'))return Response.json({code:200,result:{songs:[{id:123,name:'测试歌',artists:[{name:'歌手'}],album:{name:'专辑'},duration:120000}]}});
      if(address.pathname.includes('account'))return Response.json({code:200,account:{id:123},profile:{nickname:'must remain private'}});
      return Response.json({code:200,data:[{url:'https://m10.music.126.net/fixture.mp3',freeTrialInfo:{start:0,end:30}}]});
    }
    assert.equal(address.hostname,'m10.music.126.net');assert.equal(options.headers.Cookie,undefined);return new Response(audio);
  }});
  const {songs}=await f.execute('music.search',{source:'netease',query:'测试歌',neteaseCookie:cookie});assert.equal(songs.length,1);
  const resolved=await f.execute('music.resolve',{song:songs[0],neteaseCookie:cookie});assert.equal(resolved.previewOnly,true);assert.equal(typeof resolved.url,'string');
  const output=path.join(f.root,'state/music-library',crypto.randomUUID()+'.tmp');
  assert.deepEqual(await f.execute('music.download',{source:'netease',url:resolved.url,output}),{bytes:audio.length});assert.deepEqual(fs.readFileSync(output),audio);
  const login=await f.execute('music.login-check',{neteaseCookie:cookie});assert.equal(login.authenticated,true);assert(!JSON.stringify(login).includes('must remain private'));assert(!JSON.stringify(login).includes(cookie));
  assert.equal(requests.length,4);assert.equal(f.calls.length,0);
});

test('DSH music source operations refuse foreign output, foreign URLs, unexpected keys and forged provider identities',async t=>{
  let requests=0;const f=fixture(t,{fetchImpl:async()=>{requests++;return new Response('audio');}}),output=path.join(f.root,'state/music-library',crypto.randomUUID()+'.tmp');
  const song={id:'qq:validMid',source:'qq',mid:'validMid',title:'测试歌',artist:'歌手',album:'专辑',durationSeconds:120,access:'unknown'};
  for(const [operation,payload]of [
    ['music.search',{source:'local',query:'测试歌'}],['music.search',{source:'qq',query:'测试歌',neteaseCookie:'MUSIC_U=secret'}],
    ['music.resolve',{song:{...song,id:'netease:123'}}],['music.resolve',{song:{...song,url:'http://localhost/'}}],
    ['music.download',{source:'qq',url:'https://localhost/file.mp3',output}],
    ['music.download',{source:'qq',url:'https://isure.stream.qqmusic.qq.com/file.mp3',output:path.join(f.root,'private.tmp')}],
    ['music.download',{source:'qq',url:'https://isure.stream.qqmusic.qq.com/file.mp3',output,command:'arbitrary'}],
    ['music.login-check',{neteaseCookie:'MUSIC_U=secret\nInjected: yes'}],
  ])await assert.rejects(f.execute(operation,payload));
  assert.equal(requests,0);assert.equal(fs.existsSync(output),false);
  fs.writeFileSync(output,'existing');await assert.rejects(f.execute('music.download',{source:'qq',url:'https://isure.stream.qqmusic.qq.com/file.mp3',output}));assert.equal(fs.readFileSync(output,'utf8'),'existing');assert.equal(requests,0);
});

test('DSH music download removes aborted, empty, oversized and redirected partial files',async t=>{
  for(const mode of ['aborted','empty','oversized','redirect']){
    const controller=new AbortController();let requests=0,cancelled=0;
    const f=fixture(t,{fetchImpl:async()=>{
      requests++;
      if(mode==='oversized')return {ok:true,status:200,headers:new Headers({'content-length':String(64*1024*1024+1)}),body:{async cancel(){cancelled++;}}};
      if(mode==='redirect')return new Response(null,{status:302,headers:{location:'https://foreign.example/private.mp3'}});
      if(mode==='empty')return new Response('');
      return {ok:true,status:200,headers:new Headers(),body:{async * [Symbol.asyncIterator](){yield Buffer.from('partial');controller.abort();yield Buffer.from('remaining');}}};
    }}),output=path.join(f.root,'state/music-library',crypto.randomUUID()+'.tmp');
    await assert.rejects(f.execute('music.download',{source:'kugou',url:'https://fs.kugou.com/audio.mp3',output},{signal:controller.signal}));
    assert.equal(fs.existsSync(output),false,mode);assert.equal(requests,1);if(mode==='oversized')assert.equal(cancelled,1);
  }
});
