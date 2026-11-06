import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {mediaFfmpeg,probeMedia} from '../../scripts/media-tools.mjs';
import {createRvcModels} from '../../scripts/rvc-models.mjs';
import {validatePerformance} from '../dsh-social-bridge-plugin/singing-performance.mjs';
import {searchMusic,resolveMusic,fetchMusicAudio,musicMediaUrl} from '../music-source/providers.mjs';
import {checkNeteaseLogin,neteaseCookie} from '../music-source/netease.mjs';

const fault=(message,status=400)=>Object.assign(new Error(message),{status});
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const stages=[['soulx_preprocess','正在提取歌词、旋律与节奏'],['soulx_loading','正在加载 SoulX 演唱模型'],['performance_arranged','AI 编排已应用，正在按谱重新演唱'],['soulx_singing','SoulX 正在重新演唱（CPU 处理需要数分钟）'],['Converting with','正在用所选 .pth 音色换声'],['"mixing"','正在混入原歌曲伴奏并优化音量']];

// This process runner belongs to the DSH capability executor. The console only
// requests named operations; neither a chat tool nor RPC can supply a command.
function execute(executable,args,{signal,cwd,timeoutMs=120000,onData=()=>{}}={}){
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd,windowsHide:true,shell:false,env:{...process.env,PYTHONIOENCODING:'utf-8'},stdio:['ignore','pipe','pipe']});
    let output='',failed=false;
    const stop=()=>{failed=true;if(process.platform==='win32'&&child.pid){const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>child.kill());}else child.kill();};
    const timer=setTimeout(stop,timeoutMs);signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
    child.stdout.on('data',data=>{output=(output+data.toString('utf8')).slice(-1048576);onData(data.toString('utf8'));});child.stderr.on('data',data=>onData(data.toString('utf8')));
    child.once('error',()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);reject(fault('DSH 唱歌插件无法启动本地音频环境。',503));});
    child.once('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);if(failed||code!==0)reject(fault('DSH 唱歌插件处理失败或超时，请检查音频与翻唱环境。',502));else resolve(output);});
  });
}

export function createSingingExecutor({root,models=createRvcModels({root}),runProcess=execute,probeAudio=probeMedia,fetchImpl=fetch}={}){
  root=path.resolve(root);
  const runtime=path.join(root,'state/maintenance/audio-capabilities/feiyu-cover'),python=path.join(runtime,'venv/Scripts/python.exe'),singer=path.join(root,'state/maintenance/audio-capabilities/soulx-singer');
  function safe(value,kind){
    if(typeof value!=='string'||!path.isAbsolute(value)||/[\0\r\n]/.test(value))throw fault('唱歌插件文件引用无效。');
    const resolved=path.resolve(value),relative=path.relative(root,resolved),parts=relative.split(path.sep);
    if(relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||parts[0]!=='state')throw fault('唱歌插件只能处理本项目的音频任务。',403);
    let valid=false;
    if(kind==='input')valid=parts.length===3&&parts[1]==='music-library'&&/^[a-f0-9-]{36}\.(?:audio|tmp)$/.test(parts[2])&&uuid(parts[2].slice(0,36))||parts.length===4&&parts[1]==='music-references'&&uuid(parts[2])&&parts[3]==='video-source.wav';
    if(kind==='reference')valid=parts.length===3&&parts[1]==='music-references'&&uuid(parts[2]);
    if(kind==='output')valid=parts.length===3&&parts[1]==='music-jobs'&&uuid(parts[2]);
    if(kind==='download')valid=parts.length===3&&parts[1]==='music-library'&&/^[a-f0-9-]{36}\.tmp$/.test(parts[2])&&uuid(parts[2].slice(0,36));
    if(!valid)throw fault('唱歌插件文件引用与任务类型不匹配。',403);
    let current=root;for(const part of parts){current=path.join(current,part);if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw fault('唱歌插件不处理链接目录或链接音频。',403);}
    if(kind==='download'){if(fs.existsSync(resolved)||!fs.lstatSync(path.dirname(resolved)).isDirectory())throw fault('歌曲缓存临时文件不可用。',409);}
    else if(kind==='input'){const stat=fs.lstatSync(resolved);if(!stat.isFile()||!stat.size||stat.size>64*1024*1024)throw fault('唱歌插件输入音频不可用。');}
    else if(!fs.lstatSync(resolved).isDirectory())throw fault('唱歌插件任务目录不可用。');
    return resolved;
  }
  function modelDirectory(modelId){
    if(typeof modelId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(modelId))throw fault('请选择已上传的 RVC 音色。');
    const model=models.get(modelId);if(!model)throw fault('所选 RVC 音色已不存在。',409);
    const directory=path.resolve(model.directory),relative=path.relative(root,directory);
    if(relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw fault('RVC 音色不属于当前项目。',403);
    let current=root;for(const part of relative.split(path.sep)){current=path.join(current,part);if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw fault('RVC 音色目录不可用。',403);}
    return directory;
  }
  const properties=(payload,allowed)=>{if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!allowed.includes(key)))throw fault('唱歌插件执行参数无效。');};
  const seconds=value=>{if(!Number.isFinite(value)||value<=0||value>30)throw fault('唱歌插件仅支持 30 秒以内的演唱片段。');return value;};
  const source=value=>{if(!['kugou','qq','netease'].includes(value))throw fault('请选择有效的歌曲来源。');return value;};
  const credential=(payload,provider)=>{if(provider!=='netease'&&payload.neteaseCookie!==undefined)throw fault('当前音乐来源不接受网易云登录凭证。');return provider==='netease'?neteaseCookie(payload.neteaseCookie):'';};
  function songInput(song){
    properties(song,['id','source','title','artist','album','durationSeconds','access','hash','albumId','mid','songId']);source(song.source);
    if(['title','artist','album'].some(key=>typeof song[key]!=='string'||song[key].length>240||/[\0\r\n]/.test(song[key]))||!Number.isFinite(song.durationSeconds)||song.durationSeconds<0||!['restricted','unknown'].includes(song.access))throw fault('歌曲搜索结果无效，请重新搜索。');
    const valid=song.source==='kugou'?/^[A-F0-9]{32}$/.test(song.hash??'')&&/^\d{1,20}$/.test(song.albumId??'')&&song.id==='kugou:'+song.hash+':'+song.albumId:song.source==='qq'?/^[A-Za-z0-9]{1,40}$/.test(song.mid??'')&&song.id==='qq:'+song.mid:Number.isSafeInteger(song.songId)&&song.songId>0&&song.id==='netease:'+song.songId;
    if(!valid)throw fault('歌曲来源与搜索结果不匹配，请重新搜索。');return song;
  }
  return async function executeOperation(operation,payload,{signal,onProgress=()=>{}}={}){
    signal?.throwIfAborted();
    if(operation==='music.search'){
      properties(payload,['source','query','neteaseCookie']);const provider=source(payload.source),cookie=credential(payload,provider);
      const songs=await searchMusic(provider,payload.query,{fetchImpl,signal,neteaseCookie:cookie});signal?.throwIfAborted();return {songs};
    }
    if(operation==='music.resolve'){
      properties(payload,['song','neteaseCookie']);const song=songInput(payload.song),cookie=credential(payload,song.source);
      const resolved=await resolveMusic(song,{fetchImpl,signal,neteaseCookie:cookie});signal?.throwIfAborted();return {url:String(resolved.url),previewOnly:resolved.previewOnly===true};
    }
    if(operation==='music.download'){
      properties(payload,['source','url','output']);const provider=source(payload.source),url=musicMediaUrl(payload.url,provider),output=safe(payload.output,'download');
      const downloadSignal=AbortSignal.any([AbortSignal.timeout(45000),...(signal?[signal]:[])]),limit=64*1024*1024;
      let handle,created=false,complete=false;
      try{
        const response=await fetchMusicAudio(url,provider,{fetchImpl,signal:downloadSignal});downloadSignal.throwIfAborted();
        if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw fault('歌曲文件超过 64 MB，请先下载较小的版本。');}
        if(!response.body)throw fault('音源返回了空文件。',502);
        handle=fs.openSync(output,'wx',0o600);created=true;let bytes=0;
        for await(const chunk of response.body){downloadSignal.throwIfAborted();bytes+=chunk.length;if(bytes>limit)throw fault('音频下载超过 64 MB。',502);fs.writeSync(handle,chunk);}
        downloadSignal.throwIfAborted();if(!bytes)throw fault('音源返回了空文件。',502);
        fs.closeSync(handle);handle=undefined;complete=true;return {bytes};
      }finally{if(handle!==undefined)fs.closeSync(handle);if(created&&!complete&&fs.existsSync(output))fs.unlinkSync(output);}
    }
    if(operation==='music.login-check'){
      properties(payload,['neteaseCookie']);return checkNeteaseLogin({neteaseCookie:neteaseCookie(payload.neteaseCookie),fetchImpl,signal});
    }
    if(operation==='audio.probe'){
      properties(payload,['file']);const file=safe(payload.file,'input'),value=await probeAudio(file,{root,signal});signal?.throwIfAborted();
      if(!value.streams?.some(stream=>stream.codec_type==='audio'))throw fault('文件中没有可解码的音频。');
      const durationSeconds=Number(value.format?.duration);if(!Number.isFinite(durationSeconds)||durationSeconds<=0||durationSeconds>14400)throw fault('音频时长无效。');return {durationSeconds};
    }
    if(operation==='singing.reference'){
      properties(payload,['input','output','seconds','startSeconds','withScore']);const input=safe(payload.input,'input'),output=safe(payload.output,'reference'),duration=seconds(payload.seconds),start=payload.startSeconds??0;
      if(!Number.isFinite(start)||start<0||start>14400||payload.withScore!==undefined&&typeof payload.withScore!=='boolean')throw fault('参考音轨片段参数无效。');
      await runProcess(python,[path.join(root,'scripts/music-reference.py'),'--input',input,'--output',output,'--start',String(start),'--seconds',String(duration),...(payload.withScore?['--soulx-runtime',singer]:[])],{cwd:runtime,signal,timeoutMs:payload.withScore?10*60*1000:150000});
      signal?.throwIfAborted();return {reference:true};
    }
    if(operation==='singing.render'){
      properties(payload,['input','output','seconds','modelId','pitch','accompaniment','performance','reference']);
      const input=safe(payload.input,'input'),output=safe(payload.output,'output'),reference=safe(payload.reference,'reference'),duration=seconds(payload.seconds),pitch=payload.pitch??0;
      if(!Number.isInteger(pitch)||pitch< -12||pitch>12||payload.accompaniment!==undefined&&typeof payload.accompaniment!=='boolean')throw fault('演唱音色或混音参数无效。');
      const performance=validatePerformance(payload.performance,duration),performanceFile=path.join(output,'performance.json');
      if(fs.lstatSync(performanceFile).isSymbolicLink()||JSON.stringify(JSON.parse(fs.readFileSync(performanceFile,'utf8')))!==JSON.stringify(performance))throw fault('演唱编排与当前任务不一致。',409);
      await runProcess(python,[path.join(root,'scripts/music-cover.py'),'--input',input,'--start','0','--seconds',String(duration),'--output',output,'--model',modelDirectory(payload.modelId),'--pitch',String(pitch),'--performance',performanceFile,'--reference',reference,...(payload.accompaniment===false?['--vocals-only']:[])],{cwd:runtime,signal,timeoutMs:45*60*1000,onData:chunk=>{for(const [marker,stage]of stages)if(chunk.includes(marker))onProgress(stage);}});
      signal?.throwIfAborted();return {rendered:true};
    }
    if(operation==='singing.preview'){
      properties(payload,['output','seconds']);const output=safe(payload.output,'output'),duration=seconds(payload.seconds),wav=path.join(output,'feiyu-cover-'+Number(duration).toString()+'s.wav');
      if(fs.lstatSync(wav).isSymbolicLink()||!fs.lstatSync(wav).isFile())throw fault('演唱音频不可用。');
      await runProcess(mediaFfmpeg(root),['-hide_banner','-loglevel','error','-nostdin','-protocol_whitelist','file,pipe','-i',wav,'-c:a','libmp3lame','-b:a','256k',path.join(output,'preview.mp3')],{signal});signal?.throwIfAborted();return {preview:true};
    }
    throw fault('DSH 唱歌插件不支持这个执行操作。',404);
  };
}
