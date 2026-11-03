const fault=message=>Object.assign(new Error(message),{status:400});
const normalize=text=>String(text??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const clean=(value,max)=>{
  if(typeof value!=='string'||value.length>max||/[\x00-\x1f<>]|https?:\/\//i.test(value))throw fault('请只提供歌名和想听的版本。');
  return value.trim();
};

// The chat model supplies structured song metadata. The local preview also
// accepts a short utterance, without requiring an LLM account to test playback.
export function songRequest(body){
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['message','title','version','artist','localOnly'].includes(key))||
    body.localOnly!==undefined&&typeof body.localOnly!=='boolean')throw fault('点歌请求格式无效。');
  let title,version=clean(body.version??'',40),artist=clean(body.artist??'',80);
  if(body.message!==undefined){
    if(body.title!==undefined||body.version!==undefined||body.artist!==undefined)throw fault('请使用一句话点歌，或提供歌名信息。');
    let text=clean(body.message,180).replace(/[。！!？?～~]+$/u,'').trim();
    if(/^(?:你)?(?:会|能|可以|能不能|会不会)?(?:唱歌|唱首歌|唱一首歌|唱一段歌)(?:给我听)?(?:吗|么|嘛)?$/u.test(text))return {intent:'ability'};
    const quoted=/《([^》]+)》/.exec(text);
    text=quoted?quoted[1]+text.slice(quoted.index+quoted[0].length).replace(/(?:给我听|吗|么|嘛|可以吗|能吗)$/u,''):
      text.replace(/^(?:请问|请|麻烦)?\s*(?:你(?:会不会|能不能|可不可以|会|能|可以)?\s*)?(?:给我|帮我|为我)?\s*(?:唱|来)(?:一首|一段|首|段)?\s*/u,'')
        .replace(/(?:给我听(?:听)?|我听听|可以吗|行吗|好吗|吗|么|嘛)$/u,'');
    const match=/(DJ\s*(?:版|版本)?|现场版|Live版|伴奏版|原版|原唱版)/iu.exec(text);
    if(match){version=/^dj/i.test(match[0])?'DJ版':match[0];text=text.replace(match[0],'');}
    title=text.replace(/[（(]\s*[）)]/gu,'').replace(/^[《「“"\s]+|[》」”"\s]+$/gu,'').trim();
  }else title=clean(body.title??'',100);
  if(!title||/^(?:歌|一首歌|一段|随便|随便一首|随便唱|什么|什么歌)$/u.test(title))return {intent:'needs_title'};
  return {intent:'sing',title:clean(title,100),version,artist,localOnly:body.localOnly===true};
}

export function rankSongCandidates(songs,request){
  const title=normalize(request.title),version=normalize(request.version),artist=normalize(request.artist);
  const dj=version.includes('dj'),ordinary=!version;
  return songs.map((song,index)=>{
    const name=normalize(song.title),singer=normalize(song.artist);
    const metadata=normalize(song.title+' '+(song.album??''));
    if(!name.includes(title)||artist&&!singer.includes(artist))return null;
    // A requested remix must never silently become the ordinary recording.
    if(dj&&!metadata.includes('dj'))return null;
    if(['原版','原唱版'].includes(version)){
      if(/dj|remix|现场|live|伴奏|翻唱/.test(metadata))return null;
    }else if(['现场版','live版'].includes(version)){
      if(!/现场|live/.test(metadata))return null;
    }else if(version&&!dj&&!metadata.includes(version.replace(/版本?$/u,'')))return null;
    let score=name===title?100:75;
    if(song.source==='cache'||song.cachedId)score+=18;
    if(ordinary&&/dj|remix|现场|live|伴奏|翻唱/.test(metadata))score-=45;
    if(version)score+=30;
    return {song,score,index};
  }).filter(Boolean).sort((a,b)=>b.score-a.score||a.index-b.index).map(item=>item.song);
}
