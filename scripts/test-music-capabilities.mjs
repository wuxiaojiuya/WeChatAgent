import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {Readable} from 'node:stream';
import {searchMusic,resolveMusic,musicMediaUrl,fetchMusicAudio} from '../packages/music-source/providers.mjs';
import {createMusicCapabilities} from './music-capabilities.mjs';
import {createRvcModels} from './rvc-models.mjs';
import {songRequest,rankSongCandidates} from '../packages/music-source/song-request.mjs';
import {createSingingExecutor} from '../packages/dsh-capabilities-plugin/singing.mjs';
const kgHash='A'.repeat(32);
const kgResult={status:1,data:{lists:[{FileHash:kgHash,AlbumID:'123',SongName:'同名歌（DJ版）',SingerName:'歌手甲',Duration:120,PayType:3}]}};
const plan={version:'source-vocal-arrangement-v1',pitchShift:0,accompanimentGainDb:0,emotion:'warm',intention:'前段轻唱，后段逐渐加强。',phrases:[{start:0,end:30,gainDb:.6,contour:'build'}]};
const referenceFixture=async({input,output,seconds})=>fs.writeFileSync(path.join(output,'reference.json'),JSON.stringify({schema:'singing-reference-v1',source_sha256:crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex'),seconds,analysis:{phrases:[{start:0,end:seconds}],lyrics:[{start:0,end:seconds,text:'测试歌词'}]}}));
function fixture(t,options={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'music-source-'));let clock=Date.now();
  const service=createMusicCapabilities({root,probeAudio:async()=>120,now:()=>clock,runReference:referenceFixture,planPerformance:async()=>plan,execution:createSingingExecutor({root,fetchImpl:options.fetchImpl??fetch}),...options});
  t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true});});return {root,service,advance:days=>clock+=days*86400000};
}

function recoveryFixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'music-recovery-')),services=[];
  const open=()=>{const service=createMusicCapabilities({root,runCover:async()=>assert.fail('recovered jobs must not run inference'),runReference:async()=>assert.fail('recovered jobs must not analyze audio')});services.push(service);return service;};
  const save=(changes={},preview)=>{
    const id=changes.id??crypto.randomUUID(),directory=path.join(root,'state/music-jobs',id);
    fs.mkdirSync(directory,{recursive:true});
    const job={version:1,id,state:'success',stage:'试听已生成',startedAt:'2026-11-06T09:52:00.000Z',sourceKind:'video',conversationKey:'wechat:private:123',seconds:30,completedAt:'2026-11-06T10:01:44.000Z',...changes};
    fs.writeFileSync(path.join(directory,'job.json'),JSON.stringify(job));
    if(preview!==undefined)fs.writeFileSync(path.join(directory,'preview.mp3'),preview);
    return job;
  };
  t.after(()=>{for(const service of services)service.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,open,save};
}

test('completed singing metadata and audio remain queryable after service restarts without inference or delivery',async t=>{
  const f=recoveryFixture(t),bytes=Buffer.from('ID3fixture-existing-preview');
  const job=f.save({title:'视频参考演唱',modelId:'uploaded-model',performance:plan},bytes);
  for(let attempt=0;attempt<2;attempt++){
    const service=f.open(),restored=await service.settled(job.id);
    assert.equal(restored.state,'success');assert.equal(restored.conversationKey,job.conversationKey);assert.deepEqual(restored.performance,plan);
    assert.equal(Object.hasOwn(restored,'version'),false);assert.equal(Object.hasOwn(restored,'sent'),false);
    const audio=service.preview({jobId:job.id});assert.deepEqual(Buffer.from(audio.audio,'base64'),bytes);assert.equal(audio.seconds,30);
    assert.equal(service.status().latestJob.id,job.id);assert.equal(service.isBusy(),false);service.close();
  }
});

test('legacy SoulX task plans remain readable while source-vocal readiness only needs the RVC environment',t=>{
  const f=recoveryFixture(t),legacy={version:'score-performance-v1',emotion:'warm',intention:'旧任务。',phrases:[{start:0,end:30,gainDb:0,contour:'even',articulation:'flowing',timingMs:0,tail:'natural'}]};
  const job=f.save({performance:legacy},Buffer.from('ID3historical'));
  const runtime=path.join(f.root,'state/maintenance/audio-capabilities/feiyu-cover');
  fs.mkdirSync(path.join(runtime,'venv/Scripts'),{recursive:true});
  for(const file of ['venv/Scripts/python.exe','runtime.cpu.json','cover_demo.py'])fs.writeFileSync(path.join(runtime,file),'fixture');
  const service=f.open();assert.deepEqual(service.getJob(job.id).performance,legacy);
  assert.equal(service.status().localCoverAvailable,true);
  assert.equal(fs.existsSync(path.join(f.root,'state/maintenance/audio-capabilities/soulx-singer')),false);
});

test('restart closes a persisted running job as interrupted and never treats incidental audio as a completed job',async t=>{
  const f=recoveryFixture(t),job=f.save({state:'running',stage:'SoulX 正在重新演唱',completedAt:undefined},Buffer.from('ID3partial'));
  const output=path.join(f.root,'state/music-jobs',job.id);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({status:'success',seconds:30}));
  const service=f.open(),restored=await service.settled(job.id);
  assert.equal(restored.state,'failed');assert.match(restored.error,/重启.*中断/);assert.equal(service.isBusy(),false);
  assert.throws(()=>service.preview({jobId:job.id}),error=>error.status===409);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output,'job.json'),'utf8')).state,'failed');
  assert.equal(f.open().getJob(job.id).state,'failed');
  const orphan=crypto.randomUUID(),directory=path.join(f.root,'state/music-jobs',orphan);fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({status:'success',seconds:30}));fs.writeFileSync(path.join(directory,'preview.mp3'),'ID3old');
  assert.throws(()=>f.open().getJob(orphan),error=>error.status===404);
});

test('recovery ignores damaged, foreign, unsafe-path, oversized and missing-preview records',t=>{
  const f=recoveryFixture(t),valid=f.save({},Buffer.from('ID3valid')),ids=[];
  for(const changes of [{id:'a'.repeat(36),state:'queued'},{source:'C:\\private\\song.mp3'},{file:'C:\\private\\audio.mp3'},
    {conversationKey:'wechat:private:../../private'},{modelId:'../../model'},{title:'C:\\private\\secret.mp3'},
    {startedAt:'yesterday'},{seconds:31},{performance:{...plan,apiKey:'secret'}},{error:'https://example.com/private?key=secret'},
    {version:2},{sourceKind:'remote'}])ids.push(f.save(changes,Buffer.from('ID3unsafe')).id);
  const missing=f.save(),empty=f.save({},Buffer.alloc(0));ids.push(missing.id,empty.id);
  const corrupted=f.save();fs.writeFileSync(path.join(f.root,'state/music-jobs',corrupted.id,'job.json'),'{');ids.push(corrupted.id);
  const oversized=f.save();fs.writeFileSync(path.join(f.root,'state/music-jobs',oversized.id,'job.json'),' '.repeat(32769));ids.push(oversized.id);
  const mismatch=f.save();fs.writeFileSync(path.join(f.root,'state/music-jobs',mismatch.id,'job.json'),JSON.stringify({...mismatch,id:crypto.randomUUID()}));ids.push(mismatch.id);
  const service=f.open();assert.equal(service.getJob(valid.id).state,'success');
  for(const id of ids)assert.throws(()=>service.getJob(id),error=>error.status===404,id);
});

test('recovery rejects a linked job directory or preview outside the job directory',t=>{
  const f=recoveryFixture(t),outside=fs.mkdtempSync(path.join(os.tmpdir(),'music-outside-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  const original=f.save({},Buffer.from('ID3valid')),linked=crypto.randomUUID(),target=path.join(f.root,'state/music-jobs',original.id);
  try{fs.symlinkSync(target,path.join(f.root,'state/music-jobs',linked),process.platform==='win32'?'junction':'dir');}
  catch(error){if(['EPERM','EACCES'].includes(error.code))return t.skip('symlink creation is unavailable');throw error;}
  const file=path.join(outside,'preview.mp3');fs.writeFileSync(file,'ID3outside');
  const escaped=f.save();
  try{fs.symlinkSync(file,path.join(f.root,'state/music-jobs',escaped.id,'preview.mp3'),'file');}
  catch(error){if(!['EPERM','EACCES'].includes(error.code))throw error;}
  const service=f.open();assert.equal(service.getJob(original.id).state,'success');
  for(const id of [linked,escaped.id])assert.throws(()=>service.getJob(id),error=>error.status===404);
});

test('recovery keeps only the latest thirty valid jobs by start time',t=>{
  const f=recoveryFixture(t),saved=[];
  for(let index=0;index<33;index++)saved.push(f.save({state:'failed',stage:'未生成试听',startedAt:new Date(Date.UTC(2026,10,6,0,index)).toISOString()}));
  // A late filesystem edit to an old task does not make it the newest request.
  const oldest=path.join(f.root,'state/music-jobs',saved[0].id,'job.json');fs.utimesSync(oldest,new Date(),new Date());
  const service=f.open();assert.equal(service.status().latestJob.id,saved.at(-1).id);
  for(const job of saved.slice(0,3))assert.throws(()=>service.getJob(job.id),error=>error.status===404);
  for(const job of saved.slice(3))assert.equal(service.getJob(job.id).state,'failed');
});

test('latest singing recovery requires the exact account and conversation and never falls back to unscoped legacy jobs',t=>{
  const f=recoveryFixture(t),account='a'.repeat(64),other='b'.repeat(64),key='wechat:private:123';
  const older=f.save({accountScope:account,startedAt:'2026-11-06T08:00:00.000Z'},Buffer.from('ID3old'));
  const latest=f.save({accountScope:account,startedAt:'2026-11-06T09:00:00.000Z'},Buffer.from('ID3new'));
  const foreign=f.save({accountScope:other,startedAt:'2026-11-06T10:00:00.000Z'},Buffer.from('ID3foreign'));
  const otherChat=f.save({accountScope:account,conversationKey:'wechat:private:456',startedAt:'2026-11-06T11:00:00.000Z'},Buffer.from('ID3other-chat'));
  const legacy=f.save({startedAt:'2026-11-06T12:00:00.000Z'},Buffer.from('ID3legacy'));
  const invalid=f.save({accountScope:'../account'},Buffer.from('ID3invalid'));
  const service=f.open();assert.equal(service.latestForConversation(key,account).id,latest.id);assert.notEqual(latest.id,older.id);
  assert.equal(service.latestForConversation(key,other).id,foreign.id);assert.equal(service.latestForConversation('wechat:private:456',account).id,otherChat.id);
  for(const scope of ['',null,undefined,'bad','c'.repeat(63),'C'.repeat(64),'c'.repeat(64)])assert.equal(service.latestForConversation(key,scope),null);
  for(const chat of ['',null,'wechat:private:789','wechat:group:123'])assert.equal(service.latestForConversation(chat,account),null);
  assert.equal(service.getJob(legacy.id).accountScope,undefined);assert.throws(()=>service.getJob(invalid.id),error=>error.status===404);
});

test('live job stages and failures are atomically saved with only public metadata',async t=>{
  let entered,release;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const f=fixture(t,{settings:()=>({musicSource:'local',apiKey:'private-fixture-key',endpoint:'https://private.invalid'}),runCover:async()=>{entered();await gate;throw Error('private error with credentials');}});
  const file=path.join(f.root,'test.mp3');fs.writeFileSync(file,'audio');const song=await f.service.importFile({path:file,title:'测试歌曲'});
  fs.mkdirSync(path.join(f.root,'state/weflow'),{recursive:true});const account='a'.repeat(64),accountFile=path.join(f.root,'state/weflow/active-account.json');fs.writeFileSync(accountFile,JSON.stringify({id:account}));
  const job=f.service.start({songId:song.id,seconds:30,conversationKey:'wechat:private:123'}),journal=path.join(f.root,'state/music-jobs',job.id,'job.json');
  assert.equal(JSON.parse(fs.readFileSync(journal,'utf8')).stage,'正在获取歌曲音频');
  try{
    await ready;const persisted=JSON.parse(fs.readFileSync(journal,'utf8'));
    assert.equal(persisted.state,'running');assert.equal(persisted.stage,'AI 正在结合音轨与人格编排换声');assert.deepEqual(persisted.performance,plan);
    assert.equal(persisted.accountScope,account);fs.writeFileSync(accountFile,JSON.stringify({id:'b'.repeat(64)}));assert.equal(f.service.getJob(job.id).accountScope,account);
    assert.equal(persisted.conversationKey,'wechat:private:123');assert(!JSON.stringify(persisted).includes('private-fixture-key'));assert(!JSON.stringify(persisted).includes(f.root));
    assert.equal(Object.hasOwn(persisted,'finished'),false);assert.equal(fs.readdirSync(path.dirname(journal)).some(name=>name.endsWith('.tmp')),false);
  }finally{release();}
  await f.service.settled(job.id);const failed=JSON.parse(fs.readFileSync(journal,'utf8'));assert.equal(failed.state,'failed');assert(!failed.error.includes('credentials'));
  const restarted=createMusicCapabilities({root:f.root});t.after(()=>restarted.close());assert.equal(restarted.getJob(job.id).state,'failed');assert.equal(restarted.latestForConversation('wechat:private:123',account).id,job.id);assert.equal(restarted.latestForConversation('wechat:private:123','b'.repeat(64)),null);
});

test('conversational requests distinguish a capability question from a DJ song request',()=>{
  assert.equal(songRequest({message:'你会唱歌吗？'}).intent,'ability');
  assert.deepEqual(songRequest({message:'你会唱朋友的酒DJ版吗'}),{intent:'sing',title:'朋友的酒',version:'DJ版',artist:'',localOnly:false});
  assert.equal(songRequest({message:'唱一段《朋友的酒》DJ版给我听'}).version,'DJ版');
  assert.equal(songRequest({message:'随便一首'}).intent,'needs_title');
  assert.throws(()=>songRequest({title:'朋友的酒',unknown:'override'}));
});

test('direct jobs without lyrics analyze once, obtain AI arrangement, then convert the verified source vocal',async t=>{
  const calls=[];let options;
  const {root,service}=fixture(t,{settings:()=>({musicSource:'local'}),
    runReference:async value=>{calls.push('analysis');assert.equal(value.withScore,undefined);assert.equal(value.startSeconds,5);await referenceFixture(value);const f=path.join(value.output,'reference.json'),r=JSON.parse(fs.readFileSync(f));delete r.analysis.lyrics;fs.writeFileSync(f,JSON.stringify(r));},
    planPerformance:async value=>{calls.push('plan');assert.equal(value.analysis.lyrics,undefined);assert(value.analysis.phrases.length);assert.equal(value.direction,'先轻后强');assert.equal(value.conversationKey,'wechat:private:123');return plan;},
    runCover:async value=>{calls.push('sing');options=value;throw Error('fixture stops after score handoff');}});
  const file=path.join(root,'歌.mp3');fs.writeFileSync(file,'audio');const song=await service.importFile({path:file});
  const job=service.start({songId:song.id,startSeconds:5,seconds:30,direction:'先轻后强',conversationKey:'wechat:private:123'});
  await service.settled(job.id);assert.deepEqual(calls,['analysis','plan','sing']);assert.deepEqual(options.performance,plan);assert.equal(options.startSeconds,0);
  assert.equal(fs.existsSync(options.reference),false,'prepared stems are removed after completion');
  assert.deepEqual(service.getJob(job.id).performance,plan);
});

test('planning failure, invalid arrangement, missing phrases, account switches and revocation never convert unplanned vocals',async t=>{
  for(const failure of ['model','invalid','phrases','account','scope']){
    let allowed=true;
    const f=fixture(t,{settings:()=>({musicSource:'local'}),runCover:async()=>assert.fail('must not synthesize without verified planning'),
      runReference:async options=>{await referenceFixture(options);if(failure==='phrases'){const file=path.join(options.output,'reference.json'),record=JSON.parse(fs.readFileSync(file));delete record.analysis.phrases;fs.writeFileSync(file,JSON.stringify(record));}},
      planPerformance:async()=>{if(failure==='model')throw Error('secret upstream details');if(failure==='invalid')return {...plan,phrases:[{...plan.phrases[0],end:31}]};if(failure==='account')fs.writeFileSync(path.join(f.root,'state/wechat-io-config.json'),'{}');if(failure==='scope')allowed=false;return plan;}});
    const file=path.join(f.root,'测试歌曲.mp3');fs.writeFileSync(file,'audio');await f.service.importFile({path:file});
    const job=await f.service.requestSong({title:'测试歌曲'},{isAllowed:()=>allowed});const result=await f.service.settled(job.id);
    assert.equal(result.state,'failed',failure);assert(!result.error.includes('secret'));
    assert.equal(fs.readdirSync(path.join(f.root,'state/music-references')).length,0);
  }
});

test('automatic selection preserves explicit versions and rejects unrelated songs',()=>{
  const songs=[{id:'other',title:'朋友',source:'cache'},{id:'dj',title:'朋友的酒（DJ版）',source:'cache'},
    {id:'original',title:'朋友的酒',source:'kugou'},{id:'live',title:'朋友的酒（现场版）',source:'cache'}];
  assert.deepEqual(rankSongCandidates(songs,{title:'朋友的酒',version:'DJ版'}).map(s=>s.id),['dj']);
  assert.equal(rankSongCandidates(songs,{title:'朋友的酒'}).at(0).id,'original');
  assert.deepEqual(rankSongCandidates(songs,{title:'朋友的酒',version:'原版'}).map(s=>s.id),['original']);
  assert.deepEqual(rankSongCandidates(songs,{title:'朋友的酒',version:'Live版'}).map(s=>s.id),['live']);
  assert.deepEqual(rankSongCandidates(songs.filter(s=>s.id!=='dj'),{title:'朋友的酒',version:'DJ版'}),[]);
});

test('a conversational DJ request automatically reuses the matching import without networking',async t=>{
  let input;
  const {root,service}=fixture(t,{settings:()=>({musicSource:'kugou',clipSeconds:30}),fetchImpl:async()=>{throw Error('must not network');},
    runCover:async options=>{input=fs.readFileSync(options.input,'utf8');throw Error('fixture stops before inference');}});
  for(const [name,content] of [['朋友的酒','ordinary'],['朋友的酒（DJ版）','dj']]){
    const file=path.join(root,name+'.mp3');fs.writeFileSync(file,content);await service.importFile({path:file});
  }
  const ability=await service.requestSong({message:'你会唱歌吗'});assert.equal(ability.state,'ability');assert.equal(input,undefined);
  const result=await service.requestSong({message:'你会唱朋友的酒DJ版吗'});await service.settled(result.id);
  assert.equal(input,'dj');assert.equal(result.selectionAutomatic,true);assert.equal(result.sent,false);
  await assert.rejects(service.requestSong({title:'不存在的歌',localOnly:true}),error=>error.status===422);
});

test('automatic selection tries another matching source result when the first audio is restricted',async t=>{
  const {service}=fixture(t,{runCover:async()=>{throw Error('fixture stops before inference');},fetchImpl:async url=>{
    const text=String(url);
    if(text.includes('song_search'))return Response.json({status:1,data:{lists:[...kgResult.data.lists,{...kgResult.data.lists[0],FileHash:'B'.repeat(32)}]}});
    if(text.includes('getSongInfo'))return Response.json({url:text.includes('B'.repeat(32))?'https://fs.kugou.com/song.mp3':'',timeLength:120});
    return new Response('ID3fixture');
  }});
  const result=await service.requestSong({title:'同名歌',version:'DJ版'});await service.settled(result.id);
  assert.equal(result.state,'running');assert.equal(service.status().cachedSongs,1);
});

test('scope revocation while finding audio prevents starting a cover job',async t=>{
  let allowed=true;
  const {service}=fixture(t,{runCover:async()=>assert.fail('revoked request must not run'),fetchImpl:async()=>{allowed=false;return Response.json(kgResult);}});
  await assert.rejects(service.requestSong({title:'同名歌'},{isAllowed:()=>allowed}),error=>error.status===403);
  assert.equal(service.status().latestJob,null);
});
test('three sources normalize song IDs and keep artist/version distinctions',async()=>{
  const cases=[['kugou',kgResult,'kugou:'+kgHash+':123'],['qq',{code:0,data:{song:{list:[{songmid:'Song123',songname:'同名歌（DJ版）',singer:[{name:'歌手甲'}],interval:120}]}}},'qq:Song123'],
    ['netease',{code:200,result:{songs:[{id:123,name:'同名歌（DJ版）',artists:[{name:'歌手甲'}],duration:120000}]}},'netease:123']];
  for(const [source,payload,id]of cases){const songs=await searchMusic(source,'同名歌',{fetchImpl:async()=>Response.json(payload)});assert.equal(songs[0].id,id);assert.equal(songs[0].artist,'歌手甲');assert.equal(songs[0].title,'同名歌（DJ版）');assert.equal(songs[0].durationSeconds,120);}
});
test('empty playback URLs are access failures and never trigger a media download',async()=>{
  const song=(await searchMusic('kugou','同名歌',{fetchImpl:async()=>Response.json(kgResult)}))[0];
  await assert.rejects(resolveMusic(song,{fetchImpl:async()=>Response.json({error:'需要付费',url:''})}),error=>error.status===422);
});
test('media downloads reject foreign hosts, embedded credentials and cross-platform redirects',async()=>{
  for(const url of ['https://127.0.0.1/song.mp3','https://evil.com/song.mp3','https://kugou.com.evil.com/a','https:'+'/'+ '/'+['u:p','fs.kugou.com/a'].join('@')])assert.throws(()=>musicMediaUrl(url,'kugou'));
  assert.equal(musicMediaUrl('http://m10.music.126.net/a.mp3','netease').protocol,'https:');
  let calls=0;await assert.rejects(fetchMusicAudio('https://fs.kugou.com/a','kugou',{fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{Location:'http://localhost/private'}});}}));assert.equal(calls,1);
});
test('online audio is cached once, re-used and deleted after seven days; imported originals survive',async t=>{
  let downloads=0;const {root,service,advance}=fixture(t,{fetchImpl:async url=>{
    if(String(url).includes('song_search'))return Response.json(kgResult);
    if(String(url).includes('getSongInfo'))return Response.json({url:'https://fs.kugou.com/song.mp3',timeLength:120});
    downloads++;return new Response(Buffer.from('ID3fixture-audio'));
  }});
  const local=path.join(root,'local.mp3');fs.writeFileSync(local,'ID3local');const imported=await service.importFile({path:local,title:'同名歌（用户原曲）'});
  const results=await service.search({query:'同名歌'});assert.equal(results.songs.length,2);
  const remote=results.songs.find(song=>song.source==='kugou');const cached=await service.cache({songId:remote.id});
  assert.equal((await service.cache({songId:remote.id})).id,cached.id);assert.equal(downloads,1);assert.equal(service.status().retentionDays,7);
  advance(6);assert.equal(service.cleanup().deleted,0);advance(2);assert.equal(service.cleanup().deleted,1);
  assert.equal(service.status().cachedSongs,1);assert.equal((await service.cache({songId:imported.id})).id,imported.id);
  assert.equal(fs.readFileSync(local,'utf8'),'ID3local');
});
test('failed and oversized downloads cannot enter the local library',async t=>{
  const {root,service}=fixture(t,{fetchImpl:async url=>{
    if(String(url).includes('song_search'))return Response.json(kgResult);
    if(String(url).includes('getSongInfo'))return Response.json({url:'https://fs.kugou.com/a.mp3',timeLength:120});
    return new Response('invalid',{headers:{'Content-Length':String(100*1024*1024)}});
  }});
  const song=(await service.search({query:'同名歌'})).songs[0];await assert.rejects(service.cache({songId:song.id}),/64 MB/);
  assert.equal(service.status().cachedSongs,0);assert.ok(!fs.existsSync(path.join(root,'state/music-library'))||fs.readdirSync(path.join(root,'state/music-library')).length===0);
});
test('search outages preserve imported music and unknown song IDs cannot fetch arbitrary URLs',async t=>{
  const {root,service}=fixture(t,{fetchImpl:async()=>{throw Error('network failure with secret');}});
  const file=path.join(root,'track.mp3');fs.writeFileSync(file,'audio');await service.importFile({path:file,title:'测试歌'});
  const results=await service.search({query:'测试歌'});assert.equal(results.songs.length,1);assert.match(results.remoteError,/连接失败/);assert.ok(!results.remoteError.includes('secret'));
  await assert.rejects(service.cache({songId:'https://localhost/private'}),error=>error.status===409);
});
test('uploaded models require the matching RVC index dimensionality',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rvc-upload-'));const models=createRvcModels({root,inspectAsset:async(kind)=>({dimension:kind==='pth'?768:256,version:'v2',sampleRate:40000,sha256:'fixture'})});
  t.after(()=>{models.close();fs.rmSync(root,{recursive:true,force:true});});
  const pth=await models.upload(Readable.from([Buffer.from('weights')]),{kind:'pth',name:'my.pth'});
  const index=await models.upload(Readable.from([Buffer.from('index')]),{kind:'index',name:'my.index'});
  assert.throws(()=>models.add({name:'我的音色',modelUploadId:pth.uploadId,indexUploadId:index.uploadId}),/不匹配/);
  const added=models.add({name:'我的音色',modelUploadId:pth.uploadId});assert.equal(models.get(added.id).name,'我的音色');assert.equal(added.hasIndex,false);
  assert.ok(!JSON.stringify(models.publicList()).includes(root));
  await assert.rejects(models.upload(Readable.from([]),{kind:'pth',name:'empty.pth'}),/为空/);
});

test('running jobs freeze the chosen model and defer expiry cleanup until processing finishes',async t=>{
  let entered,release,options;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  let settings={musicSource:'kugou',modelId:'original-model',pitch:2,accompaniment:false};
  const {service,advance}=fixture(t,{settings:()=>settings,models:{get:id=>({id,directory:'fixture'})},fetchImpl:async url=>{
    if(String(url).includes('song_search'))return Response.json(kgResult);
    if(String(url).includes('getSongInfo'))return Response.json({url:'https://fs.kugou.com/song.mp3',timeLength:120});
    return new Response(Buffer.from('ID3fixture'));
  },runCover:async value=>{options=value;entered();await gate;throw Error('internal error must stay private');}});
  const song=(await service.search({query:'同名歌'})).songs[0];await service.cache({songId:song.id});
  const job=service.start({songId:song.id,seconds:30});await ready;
  try{settings={...settings,modelId:'changed-model',pitch:-4};
    assert.throws(()=>service.start({songId:song.id,seconds:30}),error=>error.status===429);
    assert.equal(options.model.id,'original-model');assert.equal(options.pitch,2);assert.equal(options.accompaniment,false);
    advance(8);assert.equal(service.cleanup().deleted,0);
  }finally{release();}
  const failed=await service.settled(job.id);assert.equal(failed.state,'failed');assert.ok(!failed.error.includes('internal'));
  assert.equal(service.cleanup().deleted,1);
});
