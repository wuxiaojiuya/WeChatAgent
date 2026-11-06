import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {neteaseCookie,neteaseRequest,checkNeteaseLogin} from '../packages/music-source/netease.mjs';
import {searchMusic,resolveMusic} from '../packages/music-source/providers.mjs';
import {createMusicCapabilities} from './music-capabilities.mjs';
import {createSingingExecutor} from '../packages/dsh-capabilities-plugin/singing.mjs';

const cookie='MUSIC_U=fixture-login-secret; __csrf=fixture-csrf';
const song={id:123,name:'测试歌曲',artists:[{name:'测试歌手'}],duration:120000};

test('NetEase verifies account identity without returning profile data or accepting anonymous success',async()=>{
  assert.equal((await checkNeteaseLogin()).code,'NETEASE_COOKIE_REQUIRED');
  for(const [body,authenticated]of [[{code:200,account:{id:123},profile:{nickname:'private profile'}},true],[{code:200,account:null,profile:null},false],[{code:301,msg:cookie},false]]){
    const result=await checkNeteaseLogin({neteaseCookie:cookie,fetchImpl:async(url,options)=>{
      assert.equal(String(url),'https://music.163.com/weapi/w/nuser/account/get');assert.equal(options.headers.Cookie,cookie);assert.equal(options.redirect,'error');assert.equal(options.method,'POST');
      const data=new URLSearchParams(options.body);assert(data.has('params'));assert.match(data.get('encSecKey'),/^[a-f0-9]{256}$/);assert(!options.body.includes('fixture-csrf'));
      return Response.json(body);
    }});
    assert.equal(result.authenticated,authenticated);assert(!JSON.stringify(result).includes('private profile'));assert(!JSON.stringify(result).includes(cookie));
  }
});

test('NetEase errors and invalid credentials never expose the request or response credential',async()=>{
  for(const fetchImpl of [async()=>{throw Error(cookie);},async()=>new Response(cookie,{status:403}),async()=>new Response(cookie),async()=>Response.json({code:200,note:cookie})]){
    const result=await checkNeteaseLogin({neteaseCookie:cookie,fetchImpl});assert.equal(result.authenticated,false);assert(!JSON.stringify(result).includes(cookie));
  }
  for(const value of ['Cookie: MUSIC_U=x','MUSIC_U=x\nOther: y','a=\u007f','a=值',null])assert.throws(()=>neteaseCookie(value),error=>error.status===400);
  await assert.rejects(neteaseRequest('https://foreign.example',{neteaseCookie:cookie}),error=>error.status===400);
  let calls=0;await assert.rejects(neteaseRequest('/api/search/get/web',{neteaseCookie:cookie,fetchImpl:async(_url,options)=>{calls++;assert.equal(options.redirect,'error');throw Error('redirect refused '+cookie);}}),error=>!error.message.includes(cookie));assert.equal(calls,1);
  const controller=new AbortController();controller.abort();await assert.rejects(checkNeteaseLogin({neteaseCookie:cookie,signal:controller.signal,fetchImpl:async(_url,options)=>{options.signal.throwIfAborted();}}),error=>error.name==='AbortError');
});

test('NetEase resolves authenticated audio with a web request and preserves platform trial restrictions',async()=>{
  const tracks=await searchMusic('netease','测试歌曲',{neteaseCookie:cookie,fetchImpl:async(url,options)=>{assert.equal(options.headers.Cookie,cookie);assert.equal(new URL(url).hostname,'music.163.com');return Response.json({code:200,result:{songs:[song]}});}});
  const result=await resolveMusic(tracks[0],{neteaseCookie:cookie,fetchImpl:async(url,options)=>{assert.equal(new URL(url).pathname,'/weapi/song/enhance/player/url');assert.equal(options.method,'POST');assert.equal(options.headers.Cookie,cookie);return Response.json({code:200,data:[{url:'https://m10.music.126.net/song.mp3',freeTrialInfo:{start:0,end:30}}]});}});
  assert.equal(result.previewOnly,true);
  await assert.rejects(resolveMusic(tracks[0],{neteaseCookie:cookie,fetchImpl:async()=>Response.json({code:200,data:[{url:null}]})}),error=>error.status===422);
});

test('saved credentials apply dynamically to NetEase metadata, never to other providers, downloads or cache records',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'netease-source-'));let current={musicSource:'netease',neteaseCookie:cookie},requests=[];
  const fetchImpl=async(url,options)=>{
    const address=new URL(url);requests.push({host:address.hostname,cookie:options.headers.Cookie});
    if(address.hostname==='music.163.com'){
      assert.equal(options.headers.Cookie,current.neteaseCookie||undefined);
      return address.pathname.includes('search')?Response.json({code:200,result:{songs:[song]}}):Response.json({code:200,data:[{url:'https://m10.music.126.net/song.mp3'}]});
    }
    assert.equal(options.headers.Cookie,undefined);
    return address.hostname==='c.y.qq.com'?Response.json({code:0,data:{song:{list:[]}}}):new Response('ID3fixture');
  };
  const service=createMusicCapabilities({root,settings:()=>current,probeAudio:async()=>120,fetchImpl,execution:createSingingExecutor({root,fetchImpl})});t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true});});
  const result=await service.search({query:'测试歌曲'});current={...current,neteaseCookie:'MUSIC_U=rotated-fixture'};
  await service.cache({songId:result.songs[0].id});assert.equal(requests[1].cookie,current.neteaseCookie);assert.equal(requests[2].cookie,undefined);
  for(const name of fs.readdirSync(path.join(root,'state/music-library')))assert(!fs.readFileSync(path.join(root,'state/music-library',name),'utf8').includes('fixture-login-secret'));
  current={...current,musicSource:'qq'};await service.search({query:'其他歌曲'});assert.equal(requests.at(-1).cookie,undefined);
  current={musicSource:'netease',neteaseCookie:''};await service.search({query:'新歌曲'});assert.equal(requests.at(-1).cookie,undefined);
});
