import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {validateMusicQuery} from '../packages/music-source/kugou.mjs';
import {searchMusic,resolveMusic,fetchMusicAudio} from '../packages/music-source/providers.mjs';
import {songRequest,rankSongCandidates} from '../packages/music-source/song-request.mjs';
import {mediaFfmpeg,probeMedia} from './media-tools.mjs';
import {validatePerformance} from '../packages/dsh-social-bridge-plugin/singing-performance.mjs';

const fault = (message, status = 400) => Object.assign(new Error(message), {status});
const LIMIT = 64 * 1024 * 1024;
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const label = value => typeof value === 'string' && value.trim().length <= 240 && !/[\r\n\0]/.test(value);
const atomic = (file, data) => {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {fs.writeFileSync(temporary, JSON.stringify(data, null, 2), {flag: 'wx', mode: 0o600}); fs.renameSync(temporary, file);}
  finally {if (fs.existsSync(temporary)) fs.unlinkSync(temporary);}
};
function execute(executable, args, {signal, cwd, timeoutMs = 120000, onData = () => {}} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {cwd, windowsHide: true, shell: false,
      env: {...process.env, PYTHONIOENCODING: 'utf-8'}, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '', failed = false;
    const stop = () => {failed = true;
      if(process.platform==='win32'&&child.pid){const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>child.kill());}
      else child.kill();};
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', stop, {once: true}); if (signal?.aborted) stop();
    child.stdout.on('data', data => {output = (output + data.toString('utf8')).slice(-1048576); onData(data.toString('utf8'));});
    child.stderr.on('data', data => onData(data.toString('utf8')));
    child.once('error', error => {clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(error);});
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      if (failed || code !== 0) reject(fault('本地音频处理失败或超时，请检查音频及翻唱环境。', 502));
      else resolve(output);
    });
  });
}

export function createMusicCapabilities({root, fetchImpl = fetch, settings = () => ({musicSource: 'kugou'}), probeAudio, runCover, runReference, planPerformance, models, now = Date.now} = {}) {
  const directory = path.join(root, 'state', 'music-library');
  const runtime = path.join(root, 'state', 'maintenance', 'audio-capabilities', 'feiyu-cover');
  const python = path.join(runtime, 'venv', 'Scripts', 'python.exe');
  const singer = path.join(root, 'state/maintenance/audio-capabilities/soulx-singer');
  const tickets = new Map(), jobs = new Map(), controllers = new Set();
  const references=new Map(),referenceDirectory=path.join(root,'state/music-references');
  const readerScope=()=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'state/wechat-io-config.json'))).digest('hex');
  let active = false, closed = false, preparing = false;
  const probe = probeAudio ?? (async file => {
    const value = await probeMedia(file, {root});
    if (!value.streams?.some(stream => stream.codec_type === 'audio')) throw fault('文件中没有可解码的音频。');
    return Number(value.format?.duration);
  });
  const audioPath = id => path.join(directory, id + '.audio');
  const readEntries = () => {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).slice(-1000).flatMap(name => {
      try {const entry = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
        return uuid(entry.key) && name === entry.key + '.json' && fs.existsSync(audioPath(entry.key)) ? [entry] : [];
      } catch {return [];}
    });
  };
  const publicEntry = entry => ({id:'local:' + entry.key, source:'cache', title:entry.title, artist:entry.artist, album:entry.album ?? '',
    durationSeconds:entry.durationSeconds, previewOnly:entry.previewOnly === true, access:'cached'});
  const findCached = id => readEntries().find(entry => 'local:' + entry.key === id || entry.providerId === id);
  function remember(song) {
    const now = Date.now(); for (const [id, value] of tickets) if (now - value.time > 15 * 60 * 1000) tickets.delete(id);
    if (tickets.size > 1000) tickets.delete(tickets.keys().next().value);
    tickets.set(song.id, {song, time:now});
    return {...song, hash:undefined, albumId:undefined};
  }
  async function search(body, {signal} = {}) {
    cleanup();const query = validateMusicQuery(body?.query);
    const terms = query.normalize('NFKC').toLowerCase().split(/\s+/);
    const local = readEntries().filter(entry => terms.every(term => (entry.title + ' ' + entry.artist).normalize('NFKC').toLowerCase().includes(term))).map(publicEntry);
    if (settings().musicSource === 'local') return {songs:local, remoteError:null};
    try {
      const songs = await searchMusic(settings().musicSource,query, {fetchImpl, signal});
      return {songs:[...local, ...songs.map(song => ({...remember(song), mid:undefined,songId:undefined,cachedId:findCached(song.id) ? 'local:' + findCached(song.id).key : null}))], remoteError:null};
    } catch (error) {
      if (signal?.aborted) throw error;
      return {songs:local, remoteError:error.status ? error.message : '音乐平台连接失败，本地曲库仍可使用。'};
    }
  }
  async function commit(file, key, metadata) {
    const durationSeconds = await probe(file);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 4 * 3600) throw fault('音频时长无效，请提供普通歌曲文件。');
    const entry = {...metadata, key, durationSeconds, addedAt:new Date(now()).toISOString(),
      ...(metadata.providerId?{expiresAt:new Date(now()+7*86400000).toISOString()}:{})};
    fs.renameSync(file, audioPath(key));
    try {atomic(path.join(directory, key + '.json'), entry);} catch (error) {fs.unlinkSync(audioPath(key)); throw error;}
    return entry;
  }
  async function importFile(body) {
    if (!body || typeof body.path !== 'string' || !path.isAbsolute(body.path) || /[\0\r\n]/.test(body.path) ||
        !/\.(mp3|flac|wav|m4a)$/i.test(body.path) || !label(body.title ?? '') || !label(body.artist ?? '')) throw fault('请填写普通音频文件的完整路径，以及有效的歌名和歌手。');
    let stat; try {stat = fs.statSync(body.path);} catch {throw fault('找不到这个音频文件，请检查完整路径。');}
    if (!stat.isFile() || stat.size > LIMIT || !stat.size) throw fault('歌曲文件必须是 64 MB 以内的普通音频。');
    fs.mkdirSync(directory, {recursive:true});
    const key = crypto.randomUUID(), temporary = path.join(directory, key + '.tmp');
    try {
      fs.copyFileSync(body.path, temporary, fs.constants.COPYFILE_EXCL);
      return publicEntry(await commit(temporary, key, {title:body.title?.trim() || path.basename(body.path, path.extname(body.path)),
        artist:body.artist?.trim() ?? '', providerId:null, previewOnly:false}));
    } finally {if (fs.existsSync(temporary)) fs.unlinkSync(temporary);}
  }
  async function cacheSong(id, signal) {
    if(closed)throw fault('音乐服务已关闭。',503);
    const existing = findCached(id); if (existing) return existing;
    const ticket = tickets.get(id);
    if (!ticket || Date.now() - ticket.time > 15 * 60 * 1000) throw fault('搜索结果已过期，请重新搜索后选择歌曲。', 409);
    if(settings().musicSource==='local')throw fault('当前只使用本地曲库，请先选择在线音乐来源。');
    const song = ticket.song, resolved = await resolveMusic(song, {fetchImpl, signal});
    fs.mkdirSync(directory, {recursive:true});
    const key = crypto.randomUUID(), temporary = path.join(directory, key + '.tmp');
    let handle;
    try {
      const downloadSignal = AbortSignal.any([AbortSignal.timeout(45000), ...(signal ? [signal] : [])]);
      const response = await fetchMusicAudio(resolved.url,song.source, {fetchImpl, signal:downloadSignal});
      if (Number(response.headers.get('content-length')) > LIMIT) {await response.body?.cancel(); throw fault('歌曲文件超过 64 MB，请先下载较小的版本。');}
      if (!response.body) throw fault('音源返回了空文件。', 502);
      handle = fs.openSync(temporary, 'wx', 0o600); let size = 0;
      for await (const chunk of response.body) {
        if (downloadSignal.aborted || (size += chunk.length) > LIMIT) throw fault('音频下载超时或超过 64 MB。', 502);
        fs.writeSync(handle, chunk);
      }
      fs.closeSync(handle); handle = undefined;
      if (!size) throw fault('音源返回了空文件。', 502);
      return await commit(temporary, key, {title:song.title, artist:song.artist, album:song.album, providerId:song.id, previewOnly:resolved.previewOnly});
    } finally {if (handle !== undefined) fs.closeSync(handle); if (fs.existsSync(temporary)) fs.unlinkSync(temporary);}
  }
  async function cache(body, {signal} = {}) {return publicEntry(await cacheSong(body?.songId, signal));}
  async function requestSong(body,{signal,isAllowed=()=>true}={}) {
    const check=()=>{signal?.throwIfAborted();if(!isAllowed())throw fault('当前聊天的唱歌能力已关闭。',403);};
    check();
    const {conversationKey,direction='',...query}=body??{};
    if(conversationKey!==undefined&&!/^wechat:(private|group):[1-9]\d*$/.test(conversationKey)||typeof direction!=='string'||direction.length>240||/[\0\r\n]/.test(direction))throw fault('点歌演绎要求无效。');
    const wanted=songRequest(query);
    if(wanted.intent!=='sing')return {state:wanted.intent,message:wanted.intent==='ability'?'会呀，想听哪首歌？':'想听哪首歌？告诉我歌名就好。',sent:false};
    if(closed)throw fault('音乐服务已关闭。',503);
    if(active||preparing)throw fault('已有歌曲正在处理，请稍后再试。',429);
    if(!runCover&&!runtimeAvailable())throw fault('本地翻唱环境尚未准备。',503);
    preparing=true;
    try {
      cleanup();check();
      let candidates=rankSongCandidates(readEntries().map(publicEntry),wanted),remoteError;
      if(!candidates.length&&settings().musicSource!=='local'&&!wanted.localOnly){
        const queries=[`${wanted.title} ${wanted.version} ${wanted.artist}`.trim(),wanted.title];
        const found=new Map();
        for(const query of new Set(queries)){
          const result=await search({query},{signal});check();remoteError=result.remoteError;
          for(const song of result.songs)found.set(song.id,song);
          candidates=rankSongCandidates([...found.values()],wanted);
          if(candidates.length)break;
        }
      }
      if(!candidates.length)throw fault(remoteError??`暂时没有找到可用的《${wanted.title}》${wanted.version}音源，我不会用其他版本替代。`,422);
      let selected,lastError;
      for(const candidate of candidates.slice(0,3)){
        check();
        try{selected=await cacheSong(candidate.cachedId??candidate.id,signal);break;}
        catch(error){if(signal?.aborted)throw error;if(![409,422,502].includes(error.status))throw error;lastError=error;}
      }
      check();
      if(!selected)throw fault(lastError?.message??'没有取得可以使用的音频，暂时唱不了这首歌。',422);
      preparing=false;
      const job=start({songId:'local:'+selected.key,seconds:settings().clipSeconds??30,conversationKey,direction,requestedTitle:wanted.title,requestedVersion:wanted.version},undefined,{isAllowed});
      return {...job,selectionAutomatic:true,requestedTitle:wanted.title,requestedVersion:wanted.version,sent:false};
    }finally{preparing=false;}
  }
  const runtimeAvailable = () => fs.existsSync(python) && fs.existsSync(path.join(runtime, 'runtime.cpu.json')) && fs.existsSync(path.join(runtime, 'cover_demo.py')) &&
    fs.existsSync(path.join(singer,'venv/Scripts/python.exe')) && fs.existsSync(path.join(singer,'runtime.cpu.json')) &&
    fs.existsSync(path.join(singer,'source/pretrained_models/SoulX-Singer/model.pt'));
  async function fetchVideoAudio(body,{signal,isAllowed=()=>true}={}){
    const {videoId,conversationKey,startSeconds=0,seconds=settings().clipSeconds??30,localOnly=false}=body??{};
    if(Object.keys(body??{}).some(key=>!['videoId','conversationKey','startSeconds','seconds','localOnly'].includes(key))||typeof localOnly!=='boolean'||!/^[a-f0-9]{64}$/.test(videoId??'')||!/^wechat:(private|group):[1-9]\d*$/.test(conversationKey??'')||!Number.isFinite(startSeconds)||startSeconds<0||startSeconds>14400||!Number.isInteger(seconds)||seconds<10||seconds>30)throw fault('请选择当前聊天中已收到的视频，片段长度为 10～30 秒。');
    if(!isAllowed())throw fault('当前聊天的唱歌能力未开启。',403);
    signal?.throwIfAborted();
    const io=JSON.parse(fs.readFileSync(path.join(root,'state/wechat-io-config.json'),'utf8').replace(/^\uFEFF/,'')),base=new URL(io.reader_base_url);
    if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||base.pathname!=='/'||base.username||base.password||base.search||base.hash||typeof io.reader_token!=='string'||!io.reader_token)throw fault('微信视频读取服务未就绪。',503);
    const result=await fetchImpl(base.origin+'/api/v1/videos/'+videoId+'/singing-audio?'+new URLSearchParams({conversationKey,startSeconds:String(startSeconds),seconds:String(seconds),localOnly:String(localOnly)}),{headers:{Authorization:'Bearer '+io.reader_token},redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(85000),...(signal?[signal]:[])])});
    if(!result.ok)throw fault('没有取得视频音轨，请确认视频可访问、有声音且当前聊天已启用唱歌。',422);
    const chunks=[];let size=0;
    for await(const chunk of result.body){size+=chunk.length;if(size>9*1024*1024)throw fault('视频音轨超过处理上限。',413);chunks.push(chunk);}
    const audio=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(audio.videoId!==videoId||audio.conversationKey!==conversationKey||audio.mime!=='audio/wav'||typeof audio.b64!=='string'||audio.b64.length>8*1024*1024||!Number.isFinite(audio.seconds)||audio.seconds<=0||audio.seconds>seconds+.05||audio.startSeconds!==startSeconds)throw fault('视频音轨身份或片段不匹配。',422);
    const bytes=Buffer.from(audio.b64,'base64');
    if(bytes.length<44||bytes.toString('base64')!==audio.b64||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE'||crypto.createHash('sha256').update(bytes).digest('hex')!==audio.sha256)throw fault('视频音轨完整性校验失败。',422);
    signal?.throwIfAborted();if(!isAllowed())throw fault('当前聊天的唱歌能力已关闭。',403);
    return {audio,bytes};
  }
  function cleanupReferences(){
    fs.mkdirSync(referenceDirectory,{recursive:true});
    for(const name of fs.readdirSync(referenceDirectory)){
      if(!uuid(name))continue;
      const dir=path.join(referenceDirectory,name),entry=references.get(name);
      if(entry?.inUse)continue;
      if(now()-fs.statSync(dir).mtimeMs>30*60*1000){fs.rmSync(dir,{recursive:true,force:true});references.delete(name);}
    }
  }
  async function prepareVideoReference(body,{signal,isAllowed=()=>true}={}){
    if(closed)throw fault('音乐服务已关闭。',503);
    if(active||preparing)throw fault('已有音频正在处理，请稍后再试。',429);
    if(!runReference&&!runtimeAvailable())throw fault('本地翻唱环境尚未准备。',503);
    preparing=true;const controller=new AbortController();controllers.add(controller);
    const combined=AbortSignal.any([controller.signal,...(signal?[signal]:[])]);
    let dir;
    try{
      cleanupReferences();
      const scope=readerScope();
      const {audio,bytes}=await fetchVideoAudio(body,{signal:combined,isAllowed});
      if(references.size>=10)throw fault('参考音轨过多，请稍后再试。',429);
      const id=crypto.randomUUID();dir=path.join(referenceDirectory,id);fs.mkdirSync(dir,{recursive:false});
      const input=path.join(dir,'video-source.wav');fs.writeFileSync(input,bytes,{flag:'wx',mode:0o600});
      if(runReference)await runReference({input,output:dir,seconds:audio.seconds,signal:combined});
      else await execute(python,[path.join(root,'scripts/music-reference.py'),'--input',input,'--output',dir,'--seconds',String(audio.seconds)],{cwd:runtime,signal:combined,timeoutMs:150000});
      combined.throwIfAborted();if(!isAllowed())throw fault('当前聊天的唱歌能力已关闭。',403);
      if(scope!==readerScope())throw fault('微信读取账号已变化，请重新分析视频。',409);
      const record=JSON.parse(fs.readFileSync(path.join(dir,'reference.json'),'utf8'));
      if(record.schema!=='singing-reference-v1'||record.source_sha256!==audio.sha256||Math.abs(record.seconds-audio.seconds)>.05||!record.analysis?.phrases?.length)throw fault('参考音轨分析校验失败。',502);
      const entry={id,dir,videoId:body.videoId,conversationKey:body.conversationKey,startSeconds:body.startSeconds??0,seconds:record.seconds,createdAt:now(),analysis:record.analysis,readerScope:scope};
      references.set(id,entry);
      return {referenceId:id,videoId:entry.videoId,startSeconds:entry.startSeconds,seconds:entry.seconds,analysis:record.analysis,expiresInSeconds:1800,sent:false};
    }catch(error){if(dir)fs.rmSync(dir,{recursive:true,force:true});throw error;}
    finally{preparing=false;controllers.delete(controller);}
  }
  async function requestVideo(body,{signal,isAllowed=()=>true}={}){
    if(!body||Object.keys(body).some(k=>!['videoId','conversationKey','startSeconds','seconds','localOnly','referenceId','performance'].includes(k)))throw fault('视频演唱请求无效。');
    signal?.throwIfAborted();if(!isAllowed())throw fault('当前聊天的唱歌能力已关闭。',403);
    const entry=references.get(body.referenceId);
    if(!entry||entry.inUse||now()-entry.createdAt>30*60*1000||entry.readerScope!==readerScope()||entry.videoId!==body.videoId||entry.conversationKey!==body.conversationKey||entry.startSeconds!==(body.startSeconds??0)||body.seconds!==undefined&&Math.abs(Math.min(body.seconds,entry.seconds)-entry.seconds)>.05)throw fault('请先分析当前视频音轨，再提交对应的演唱编排。',409);
    const performance=validatePerformance(body.performance,entry.seconds);
    const input=async output=>{
      if(!isAllowed())throw fault('当前聊天的唱歌能力已关闭。',403);
      const file=path.join(entry.dir,'video-source.wav');
      return {file,title:'视频参考演唱',artist:'AI 自主编排',durationSeconds:entry.seconds,previewOnly:false};
    };
    const job=start({songId:'video:'+entry.videoId,seconds:Math.max(10,Math.ceil(entry.seconds)),startSeconds:0,performance},{input,conversationKey:entry.conversationKey,videoId:entry.videoId,sourceStartSeconds:entry.startSeconds,isAllowed,reference:entry});
    entry.inUse=true;
    return {...job,sourceKind:'video',sent:false};
  }
  function cleanup() {
    if(active)return {deleted:0};let deleted=0;
    for(const entry of readEntries()){
      const expires=Date.parse(entry.expiresAt??'');
      const added=Date.parse(entry.addedAt??'');
      if(entry.providerId && (Number.isFinite(expires)?expires<=now():Number.isFinite(added)&&added+7*86400000<=now())){
        fs.unlinkSync(audioPath(entry.key));fs.unlinkSync(path.join(directory,entry.key+'.json'));deleted++;
      }
    }
    return {deleted};
  }
  function status() {cleanup();const entries=readEntries();return {source:settings().musicSource ?? 'kugou', cachedSongs:entries.length,
    cacheBytes:entries.reduce((sum,e)=>sum+fs.statSync(audioPath(e.key)).size,0),retentionDays:7,localCoverAvailable:runtimeAvailable(),
    latestJob:jobs.size?publicJob([...jobs.values()].at(-1)):null};}
  function start(body,source,{isAllowed=()=>true}={}) {
    cleanup();
    if (closed) throw fault('音乐服务已关闭。', 503);
    if (active||preparing) throw fault('已有歌曲正在处理，请稍后再试。', 429);
    const startSeconds = body?.startSeconds ?? 0, seconds = body?.seconds ?? 30;
    if (!body || typeof body.songId !== 'string' || !Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 14400 ||
        !Number.isInteger(seconds) || seconds < 10 || seconds > 30) throw fault('请选择歌曲，试听长度为 10～30 秒，开始时间不能为负数。');
    if(body.performance&&!source?.reference)throw fault('演唱编排必须绑定已分析的参考。',409);
    if(!source?.reference&&typeof planPerformance!=='function')throw fault('AI 演唱编排服务尚未就绪，请启动 DSH 并启用项目插件。',503);
    if (!runCover && !runtimeAvailable()) throw fault('SoulX 翻唱环境尚未准备，请在设置中安装或修复翻唱环境；仍可搜歌和缓存音频。', 503);
    if (!source && !findCached(body.songId) && !tickets.has(body.songId)) throw fault('请重新搜索并选择歌曲。', 409);
    while (jobs.size >= 30) jobs.delete(jobs.keys().next().value);
    const config=structuredClone(settings()),model=models?.get(config.modelId);
    if(models&&!model)throw fault('当前音色没有可用的翻唱模型，请在“语音回复”中补充配套 RVC 模型。',409);
    const accountScope=()=>fs.existsSync(path.join(root,'state/wechat-io-config.json'))?readerScope():null,scope=accountScope();
    const id = crypto.randomUUID(), output = path.join(root, 'state', 'music-jobs', id);
    const job = {id, state:'running', stage:'正在获取歌曲音频', startedAt:new Date().toISOString(), source:body.songId,modelId:config.modelId,sourceKind:source?'video':'song',conversationKey:source?.conversationKey??body.conversationKey,...(source?{sourceStartSeconds:source.sourceStartSeconds,performance:body.performance}:{})};
    jobs.set(id, job); active = true;
    const controller = new AbortController(); controllers.add(controller);
    let processLog='',reference=source?.reference,performance=body.performance;
    const check=()=>{controller.signal.throwIfAborted();if(!isAllowed()||source&&!source.isAllowed())throw fault('当前聊天的唱歌能力已关闭。',403);if(scope!==accountScope())throw fault('微信账号已变化，本次演唱已取消。',409);};
    job.finished = (async () => {
      try {
        const song = source?await source.input(output):await cacheSong(body.songId, controller.signal);
        const available = Math.floor((song.durationSeconds - startSeconds) * 1000) / 1000;
        if (available < 1) throw fault('开始时间超出了音频长度，请调整开始时间。');
        const duration = Math.min(seconds, available);
        Object.assign(job, {title:song.title, artist:song.artist, seconds:duration, previewOnly:song.previewOnly});
        job.stage = '正在分离人声和伴奏';
        check();
        const inputFile=source?song.file:audioPath(song.key);
        if(!reference){
          cleanupReferences();
          const referenceId=crypto.randomUUID(),dir=path.join(referenceDirectory,referenceId);fs.mkdirSync(dir,{recursive:false});
          reference={id:referenceId,dir,inUse:true};references.set(referenceId,reference);
          job.stage='正在分析歌词、旋律、节奏与分句';
          if(runReference)await runReference({input:inputFile,output:dir,seconds:duration,startSeconds,withScore:true,signal:controller.signal});
          else await execute(python,[path.join(root,'scripts/music-reference.py'),'--input',inputFile,'--output',dir,'--start',String(startSeconds),'--seconds',String(duration),'--soulx-runtime',singer],{cwd:runtime,signal:controller.signal,timeoutMs:10*60*1000,onData:chunk=>{processLog=(processLog+chunk).slice(-64000);}});
          check();
          const record=JSON.parse(fs.readFileSync(path.join(dir,'reference.json'),'utf8'));
          if(record.schema!=='singing-reference-v1'||record.source_sha256!==crypto.createHash('sha256').update(fs.readFileSync(inputFile)).digest('hex')||Math.abs(record.seconds-duration)>.05||!record.analysis?.phrases?.length||!record.analysis?.lyrics?.length)throw fault('歌曲参考分析未完成，未生成演唱。',502);
          job.stage='AI 正在结合歌词与人格编排演唱';
          performance=validatePerformance(await planPerformance({analysis:record.analysis,seconds:duration,song:{title:song.title,artist:song.artist,requestedTitle:body.requestedTitle??song.title,version:body.requestedVersion??''},direction:body.direction??'',conversationKey:body.conversationKey,signal:controller.signal}),duration);
          check();job.performance=performance;
        }
        let performanceFile;
        fs.mkdirSync(output,{recursive:true});performanceFile=path.join(output,'performance.json');atomic(performanceFile,performance);
        if (runCover) await runCover({input:inputFile, output, seconds:duration, startSeconds:0, model,pitch:config.pitch,accompaniment:config.accompaniment,signal:controller.signal,performance,reference:reference.dir});
        else await execute(python, [path.join(root,'scripts','music-cover.py'), '--input', inputFile, '--start', '0',
          '--seconds', String(duration), '--output', output,'--model',model?.directory??path.join(runtime,'models','FeiyuVoice-RVC'),
          '--pitch',String(config.pitch??0),'--performance',performanceFile,'--reference',reference.dir,...(config.accompaniment===false?['--vocals-only']:[])], {cwd:runtime, signal:controller.signal, timeoutMs:45 * 60 * 1000,
          onData(chunk) {processLog=(processLog+chunk).slice(-64000);
            if(chunk.includes('soulx_preprocess'))job.stage='正在提取歌词、旋律与节奏';
            if(chunk.includes('soulx_loading'))job.stage='正在加载 SoulX 演唱模型';
            if(chunk.includes('performance_arranged'))job.stage='AI 编排已应用，正在按谱重新演唱';
            if(chunk.includes('soulx_singing'))job.stage='SoulX 正在重新演唱（CPU 处理需要数分钟）';
            if(chunk.includes('Converting with'))job.stage='正在用所选 .pth 音色换声';
            if(chunk.includes('"mixing"'))job.stage='正在混入原歌曲伴奏并优化音量';}});
        const receipt = JSON.parse(fs.readFileSync(path.join(output, 'result.json'), 'utf8'));
        if (receipt.status !== 'success' || Math.abs(receipt.seconds - duration) > 0.05) throw fault('翻唱结果校验失败。', 502);
        if(!runCover&&(receipt.route!=='SoulX -> selected RVC -> accompaniment remix'||receipt.original_vocals_mixed!==false))throw fault('翻唱链路校验失败，未返回 SoulX 演唱结果。',502);
        check();
        if(!runCover&&(receipt.performance_sha256!==crypto.createHash('sha256').update(fs.readFileSync(performanceFile)).digest('hex')||receipt.performance?.control!=='score'||receipt.performance?.source_f0_used!==false||receipt.performance?.dynamics?.applied!==true))throw fault('演唱编排未实际执行，未返回音频。',502);
        const wav = path.join(output, 'feiyu-cover-' + Number(duration).toString() + 's.wav');
        job.stage = '正在准备试听文件';
        await execute(mediaFfmpeg(root), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '256k', path.join(output, 'preview.mp3')], {signal:controller.signal});
        check();
        Object.assign(job, {state:'success', stage:'试听已生成', seconds:receipt.seconds, completedAt:new Date().toISOString()});
      } catch (error) {
        if(processLog){fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output+'.log',processLog,{mode:0o600});}
        Object.assign(job, {state:'failed', stage:'未生成试听', error:error.status ? error.message : '歌曲处理失败，请检查音源与本地翻唱环境。'});}
      finally {if(reference){fs.rmSync(reference.dir,{recursive:true,force:true});references.delete(reference.id);}active = false; controllers.delete(controller);}
    })();
    return publicJob(job);
  }
  function publicJob(job) {const {finished, ...value} = job; return value;}
  function getJob(id) {if (!uuid(id) || !jobs.has(id)) throw fault('找不到这个试听任务。', 404); return publicJob(jobs.get(id));}
  function preview(body) {
    const job = getJob(body?.jobId); if (job.state !== 'success') throw fault('试听音频尚未生成。', 409);
    const file = path.join(root, 'state', 'music-jobs', job.id, 'preview.mp3');
    if (!fs.existsSync(file) || fs.statSync(file).size > 4 * 1024 * 1024) throw fault('试听文件不可用。', 404);
    return {audio:fs.readFileSync(file).toString('base64'), mime:'audio/mpeg', seconds:job.seconds, title:job.title};
  }
  const cleanupTimer=setInterval(()=>{try{cleanup();}catch{}},3600000);cleanupTimer.unref();cleanup();
  return {search, cache, importFile, status, start, getJob, preview,cleanup,requestSong,requestVideo,prepareVideoReference,isBusy:()=>!!active||preparing,
    async settled(id) {await jobs.get(id)?.finished; return getJob(id);},
    close() {closed = true;clearInterval(cleanupTimer); for (const controller of controllers) controller.abort();}};
}
