import {searchKugou,resolveKugou,musicJson,validateMusicQuery} from './kugou.mjs';
const fault=(message,status=502)=>Object.assign(new Error(message),{status});
export const MUSIC_SOURCES={kugou:'酷狗音乐',qq:'QQ 音乐',netease:'网易云音乐',local:'本地曲库'};
const clean=value=>String(value??'').replace(/<[^>]*>/g,'').slice(0,240);
export async function searchMusic(source,query,{fetchImpl=fetch,signal}={}) {
  validateMusicQuery(query);
  if(source==='kugou')return searchKugou(query,{fetchImpl,signal});
  if(source==='qq'){
    const url=new URL('https://c.y.qq.com/soso/fcgi-bin/client_search_cp');url.search=new URLSearchParams({format:'json',w:query,n:'10',p:'1'});
    const data=await musicJson(url,fetchImpl,signal,{Referer:'https://y.qq.com/'});
    if(data.code!==0||!Array.isArray(data.data?.song?.list))throw fault('QQ 音乐搜索暂不可用。');
    return data.data.song.list.filter(song=>/^[A-Za-z0-9]{1,40}$/.test(song.songmid)).map(song=>({
      id:'qq:'+song.songmid,source:'qq',title:clean(song.songname),artist:(song.singer??[]).map(s=>clean(s.name)).join(' / '),
      album:clean(song.albumname),durationSeconds:Number(song.interval)||0,mid:song.songmid,
      access:song.pay?.payplay||song.pay?.paydownload?'restricted':'unknown',
    }));
  }
  if(source==='netease'){
    const url=new URL('https://music.163.com/api/search/get/web');url.search=new URLSearchParams({s:query,type:'1',limit:'10',offset:'0'});
    const data=await musicJson(url,fetchImpl,signal,{Referer:'https://music.163.com/'});
    if(data.code!==200)throw fault('网易云音乐搜索暂不可用。');
    return (data.result?.songs??[]).filter(song=>Number.isSafeInteger(song.id)).map(song=>({
      id:'netease:'+song.id,source:'netease',songId:song.id,title:clean(song.name),
      artist:(song.artists??[]).map(s=>clean(s.name)).join(' / '),album:clean(song.album?.name),
      durationSeconds:(Number(song.duration)||0)/1000,access:Number(song.fee)>0?'restricted':'unknown',
    }));
  }
  throw fault('请选择有效的歌曲来源。',400);
}
export function musicMediaUrl(value,source) {
  let url;try{url=new URL(value);}catch{throw fault('音乐平台没有返回可用音频。');}
  const domains={kugou:['kugou.com','kugou.net','kugoucdn.com'],qq:['qqmusic.qq.com','qqmusic.tc.qq.com'],netease:['music.126.net','music.163.com']}[source];
  if(!domains||!['https:','http:'].includes(url.protocol)||url.username||url.password||url.port||
    !domains.some(domain=>url.hostname===domain||url.hostname.endsWith('.'+domain)))throw fault('音频地址不属于所选音乐平台。');
  url.protocol='https:';url.hash='';return url;
}
export async function resolveMusic(song,{fetchImpl=fetch,signal}={}) {
  if(song.source==='kugou')return resolveKugou(song,{fetchImpl,signal});
  if(song.source==='netease'){
    const url=new URL('https://music.163.com/api/song/enhance/player/url');
    url.search=new URLSearchParams({ids:JSON.stringify([song.songId]),br:'128000'});
    const data=await musicJson(url,fetchImpl,signal,{Referer:'https://music.163.com/'}),track=data.data?.[0];
    if(!track?.url)throw fault('网易云未提供可用音频，歌曲可能需要登录、购买或受版权限制。',422);
    return {url:musicMediaUrl(track.url,'netease'),previewOnly:!!track.freeTrialInfo};
  }
  if(song.source==='qq'){
    const request={comm:{ct:24,cv:0},req_0:{module:'vkey.GetVkeyServer',method:'CgiGetVkey',
      param:{guid:crypto.randomUUID().replace(/\D/g,'').slice(0,10)||'1234567890',songmid:[song.mid],songtype:[0],uin:'0',loginflag:0,platform:'20'}}};
    const url=new URL('https://u.y.qq.com/cgi-bin/musicu.fcg');url.searchParams.set('data',JSON.stringify(request));
    const data=await musicJson(url,fetchImpl,signal,{Referer:'https://y.qq.com/'}),value=data.req_0?.data;
    const purl=value?.midurlinfo?.[0]?.purl,host=value?.sip?.find(s=>s.startsWith('https:'))??value?.sip?.[0];
    if(!purl||!host)throw fault('QQ 音乐未提供可用音频，歌曲可能需要登录、购买或受版权限制。',422);
    return {url:musicMediaUrl(new URL(purl,host),'qq'),previewOnly:false};
  }
  throw fault('歌曲来源无效。',400);
}
export async function fetchMusicAudio(url,source,{fetchImpl=fetch,signal}={}) {
  let current=musicMediaUrl(url,source);
  for(let hop=0;hop<4;hop++){
    const response=await fetchImpl(current,{redirect:'manual',signal,headers:{'User-Agent':'Mozilla/5.0'}});
    if([301,302,303,307,308].includes(response.status)){
      await response.body?.cancel();const location=response.headers.get('location');if(!location)throw fault('音频地址跳转无效。');
      current=musicMediaUrl(new URL(location,current),source);continue;
    }
    if(!response.ok)throw fault('音乐平台音频下载失败，请稍后重试。');return response;
  }
  throw fault('音频跳转次数过多。');
}
