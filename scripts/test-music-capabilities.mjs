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
const kgHash='A'.repeat(32);
const kgResult={status:1,data:{lists:[{FileHash:kgHash,AlbumID:'123',SongName:'同名歌（DJ版）',SingerName:'歌手甲',Duration:120,PayType:3}]}};
const plan={version:'score-performance-v1',emotion:'warm',intention:'前段轻唱，后段逐渐加强。',phrases:[{start:0,end:30,articulation:'flowing',timingMs:12,tail:'hold',gainDb:.6,contour:'build'}]};
const referenceFixture=async({input,output,seconds})=>fs.writeFileSync(path.join(output,'reference.json'),JSON.stringify({schema:'singing-reference-v1',source_sha256:crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex'),seconds,analysis:{phrases:[{start:0,end:seconds}],lyrics:[{start:0,end:seconds,text:'测试歌词'}]}}));
function fixture(t,options={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'music-source-'));let clock=Date.now();
  const service=createMusicCapabilities({root,probeAudio:async()=>120,now:()=>clock,runReference:referenceFixture,planPerformance:async()=>plan,...options});
  t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true});});return {root,service,advance:days=>clock+=days*86400000};
}

test('conversational requests distinguish a capability question from a DJ song request',()=>{
  assert.equal(songRequest({message:'你会唱歌吗？'}).intent,'ability');
  assert.deepEqual(songRequest({message:'你会唱朋友的酒DJ版吗'}),{intent:'sing',title:'朋友的酒',version:'DJ版',artist:'',localOnly:false});
  assert.equal(songRequest({message:'唱一段《朋友的酒》DJ版给我听'}).version,'DJ版');
  assert.equal(songRequest({message:'随便一首'}).intent,'needs_title');
  assert.throws(()=>songRequest({title:'朋友的酒',unknown:'override'}));
});

test('direct requests and local jobs analyze once, obtain a real model plan, then synthesize from that score',async t=>{
  const calls=[];let options;
  const {root,service}=fixture(t,{settings:()=>({musicSource:'local'}),
    runReference:async value=>{calls.push('analysis');assert(value.withScore);assert.equal(value.startSeconds,5);await referenceFixture(value);},
    planPerformance:async value=>{calls.push('plan');assert.equal(value.analysis.lyrics[0].text,'测试歌词');assert.equal(value.direction,'先轻后强');assert.equal(value.conversationKey,'wechat:private:123');return plan;},
    runCover:async value=>{calls.push('sing');options=value;throw Error('fixture stops after score handoff');}});
  const file=path.join(root,'歌.mp3');fs.writeFileSync(file,'audio');const song=await service.importFile({path:file});
  const job=service.start({songId:song.id,startSeconds:5,seconds:30,direction:'先轻后强',conversationKey:'wechat:private:123'});
  await service.settled(job.id);assert.deepEqual(calls,['analysis','plan','sing']);assert.deepEqual(options.performance,plan);assert.equal(options.startSeconds,0);
  assert.equal(fs.existsSync(options.reference),false,'prepared stems are removed after completion');
  assert.deepEqual(service.getJob(job.id).performance,plan);
});

test('planning failure, invalid score, missing lyrics, account switches and scope revocation never fall back to vocal conversion',async t=>{
  for(const failure of ['model','invalid','lyrics','account','scope']){
    let allowed=true;
    const f=fixture(t,{settings:()=>({musicSource:'local'}),runCover:async()=>assert.fail('must not synthesize without verified planning'),
      runReference:async options=>{await referenceFixture(options);if(failure==='lyrics'){const file=path.join(options.output,'reference.json'),record=JSON.parse(fs.readFileSync(file));delete record.analysis.lyrics;fs.writeFileSync(file,JSON.stringify(record));}},
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
