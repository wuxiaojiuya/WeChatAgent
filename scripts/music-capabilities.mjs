import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {validateMusicQuery} from '../packages/music-source/kugou.mjs';
import {searchMusic,resolveMusic,fetchMusicAudio} from '../packages/music-source/providers.mjs';
import {songRequest,rankSongCandidates} from '../packages/music-source/song-request.mjs';

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

export function createMusicCapabilities({root, fetchImpl = fetch, settings = () => ({musicSource: 'kugou'}), probeAudio, runCover, models, now = Date.now} = {}) {
  const directory = path.join(root, 'state', 'music-library');
  const runtime = path.join(root, 'state', 'maintenance', 'audio-capabilities', 'feiyu-cover');
  const ffmpeg = fs.existsSync('C:/ffmpeg-tools/bin/ffmpeg.exe') ? 'C:/ffmpeg-tools/bin/ffmpeg.exe' : 'ffmpeg';
  const ffprobe = fs.existsSync('C:/ffmpeg-tools/bin/ffprobe.exe') ? 'C:/ffmpeg-tools/bin/ffprobe.exe' : 'ffprobe';
  const python = path.join(runtime, 'venv', 'Scripts', 'python.exe');
  const tickets = new Map(), jobs = new Map(), controllers = new Set();
  let active = false, closed = false, preparing = false;
  const probe = probeAudio ?? (async file => {
    const value = JSON.parse(await execute(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], {timeoutMs:15000}));
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
    const wanted=songRequest(body);
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
      const job=start({songId:'local:'+selected.key,seconds:settings().clipSeconds??30});
      return {...job,selectionAutomatic:true,requestedTitle:wanted.title,requestedVersion:wanted.version,sent:false};
    }finally{preparing=false;}
  }
  const runtimeAvailable = () => fs.existsSync(python) && fs.existsSync(path.join(runtime, 'runtime.cpu.json')) && fs.existsSync(path.join(runtime, 'cover_demo.py'));
  async function requestVideo(body,{signal,isAllowed=()=>true}={}){
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
    const input=async output=>{
      if(!isAllowed())throw fault('当前聊天的唱歌能力已关闭。',403);
      fs.mkdirSync(output,{recursive:true});const file=path.join(output,'video-source.wav');fs.writeFileSync(file,bytes,{flag:'wx',mode:0o600});
      return {file,title:'视频片段翻唱',artist:'视频音轨',durationSeconds:audio.seconds,previewOnly:false};
    };
    return {...start({songId:'video:'+videoId,seconds,startSeconds:0},{input,conversationKey,videoId,sourceStartSeconds:startSeconds,isAllowed}),sourceKind:'video',sent:false};
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
  function start(body,source) {
    cleanup();
    if (closed) throw fault('音乐服务已关闭。', 503);
    if (active) throw fault('已有歌曲正在处理，请稍后再试。', 429);
    const startSeconds = body?.startSeconds ?? 0, seconds = body?.seconds ?? 30;
    if (!body || typeof body.songId !== 'string' || !Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 14400 ||
        !Number.isInteger(seconds) || seconds < 10 || seconds > 30) throw fault('请选择歌曲，试听长度为 10～30 秒，开始时间不能为负数。');
    if (!runCover && !runtimeAvailable()) throw fault('本地肥鱼翻唱环境尚未准备，仍可搜歌和缓存音频。', 503);
    if (!source && !findCached(body.songId) && !tickets.has(body.songId)) throw fault('请重新搜索并选择歌曲。', 409);
    while (jobs.size >= 30) jobs.delete(jobs.keys().next().value);
    const config=structuredClone(settings()),model=models?.get(config.modelId);
    if(models&&!model)throw fault('所选 RVC 模型已变化，请重新选择。',409);
    const id = crypto.randomUUID(), output = path.join(root, 'state', 'music-jobs', id);
    const job = {id, state:'running', stage:'正在获取歌曲音频', startedAt:new Date().toISOString(), source:body.songId,modelId:config.modelId,...(source?{sourceKind:'video',conversationKey:source.conversationKey,sourceStartSeconds:source.sourceStartSeconds}:{})};
    jobs.set(id, job); active = true;
    const controller = new AbortController(); controllers.add(controller);
    let processLog='';
    job.finished = (async () => {
      try {
        const song = source?await source.input(output):await cacheSong(body.songId, controller.signal);
        const available = Math.floor((song.durationSeconds - startSeconds) * 1000) / 1000;
        if (available < 1) throw fault('开始时间超出了音频长度，请调整开始时间。');
        const duration = Math.min(seconds, available);
        Object.assign(job, {title:song.title, artist:song.artist, seconds:duration, previewOnly:song.previewOnly});
        job.stage = '正在分离人声和伴奏';
        if(source&&!source.isAllowed())throw fault('当前聊天的唱歌能力已关闭。',403);
        const inputFile=source?song.file:audioPath(song.key);
        if (runCover) await runCover({input:inputFile, output, seconds:duration, startSeconds, model,pitch:config.pitch,accompaniment:config.accompaniment,signal:controller.signal});
        else await execute(python, [path.join(root,'scripts','music-cover.py'), '--input', inputFile, '--start', String(startSeconds),
          '--seconds', String(duration), '--output', output,'--model',model?.directory??path.join(runtime,'models','FeiyuVoice-RVC'),
          '--pitch',String(config.pitch??0),...(config.accompaniment===false?['--vocals-only']:[])], {cwd:runtime, signal:controller.signal, timeoutMs:10 * 60 * 1000,
          onData(chunk) {processLog=(processLog+chunk).slice(-64000);if (chunk.includes('Converting with')) job.stage = '正在优化换声音质并混音';}});
        const receipt = JSON.parse(fs.readFileSync(path.join(output, 'result.json'), 'utf8'));
        if (receipt.status !== 'success' || Math.abs(receipt.seconds - duration) > 0.05) throw fault('翻唱结果校验失败。', 502);
        const wav = path.join(output, 'feiyu-cover-' + Number(duration).toString() + 's.wav');
        job.stage = '正在准备试听文件';
        await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '256k', path.join(output, 'preview.mp3')], {signal:controller.signal});
        Object.assign(job, {state:'success', stage:'试听已生成', seconds:receipt.seconds, completedAt:new Date().toISOString()});
      } catch (error) {
        if(processLog){fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output+'.log',processLog,{mode:0o600});}
        Object.assign(job, {state:'failed', stage:'未生成试听', error:error.status ? error.message : '歌曲处理失败，请检查音源与本地翻唱环境。'});}
      finally {if(source){const temporary=path.join(output,'video-source.wav');if(fs.existsSync(temporary))fs.unlinkSync(temporary);}active = false; controllers.delete(controller);}
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
  return {search, cache, importFile, status, start, getJob, preview,cleanup,requestSong,requestVideo,
    async settled(id) {await jobs.get(id)?.finished; return getJob(id);},
    close() {closed = true;clearInterval(cleanupTimer); for (const controller of controllers) controller.abort();}};
}
