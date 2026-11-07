import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {validateMusicQuery} from '../packages/music-source/kugou.mjs';
import {songRequest,rankSongCandidates} from '../packages/music-source/song-request.mjs';
import {activeConnection} from './hook-connection-state.mjs';
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
export function createMusicCapabilities({root, fetchImpl = fetch, settings = () => ({musicSource: 'kugou'}), execution, probeAudio, runCover, runReference, planPerformance, models, now = Date.now} = {}) {
  const directory = path.join(root, 'state', 'music-library');
  const runtime = path.join(root, 'state', 'maintenance', 'audio-capabilities', 'feiyu-cover');
  const python = path.join(runtime, 'venv', 'Scripts', 'python.exe');
  const jobDirectory = path.join(root, 'state', 'music-jobs');
  const tickets = new Map(), jobs = new Map(), controllers = new Set();
  const references=new Map(),referenceDirectory=path.join(root,'state/music-references');
  const readerScope=()=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'state/wechat-io-config.json'))).digest('hex');
  let active = false, closed = false, preparing = false;
  const executeCapability=(operation,payload,options)=>{
    if(typeof execution!=='function')throw fault('DSH 唱歌能力插件尚未连接，请打开 DSH 并启用当前项目插件。',503);
    return execution(operation,payload,options);
  };
  const jobText=(value,max=400)=>typeof value==='string'&&value.length<=max&&!/[\r\n\0]|https?:\/\/|[A-Z]:[\\/]|^[\\/]|[A-Za-z0-9_-]{48,}/i.test(value);
  const jobTime=value=>typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value));
  function savedJob(job){
    const value={version:1,id:job.id,state:job.state,stage:job.stage,startedAt:job.startedAt,sourceKind:job.sourceKind};
    for(const key of ['conversationKey','accountScope','source','modelId','title','artist','seconds','previewOnly','sourceStartSeconds','completedAt','error','performance'])if(job[key]!==undefined)value[key]=job[key];
    // Only public task metadata belongs here; process objects, settings and
    // credentials must never become part of a recovery record.
    for(const key of ['title','artist','error'])if(value[key]!==undefined&&!jobText(value[key],key==='error'?400:240))delete value[key];
    if(value.source!==undefined&&!/^(?:local:[a-f0-9-]{36}|video:[a-f0-9]{64}|kugou:[A-Fa-f0-9]{32}:\d+|qq:[A-Za-z0-9]+|netease:\d+)$/.test(value.source))delete value.source;
    if(value.modelId!==undefined&&!/^[A-Za-z0-9_-]{1,100}$/.test(value.modelId))delete value.modelId;
    if(value.accountScope!==undefined&&(typeof value.accountScope!=='string'||!/^[a-f0-9]{64}$/.test(value.accountScope)))delete value.accountScope;
    if(value.performance&&!jobText(value.performance.intention,240))delete value.performance;
    return value;
  }
  function persistJob(job){
    const output=path.join(jobDirectory,job.id);fs.mkdirSync(output,{recursive:true});atomic(path.join(output,'job.json'),savedJob(job));
  }
  function updateJob(job,patch){Object.assign(job,patch);persistJob(job);}
  const stageJob=(job,stage)=>{if(job.stage!==stage)updateJob(job,{stage});};
  function regularJobFile(id,name){
    const output=path.join(jobDirectory,id),file=path.join(output,name);
    try{
      if(!uuid(id)||!fs.lstatSync(output).isDirectory()||fs.lstatSync(output).isSymbolicLink())return;
      const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())return;
      if(path.dirname(fs.realpathSync(file))!==fs.realpathSync(output))return;
      return stat;
    }catch{return;}
  }
  function recoverJobs(){
    if(!fs.existsSync(jobDirectory))return;
    const entries=fs.readdirSync(jobDirectory).filter(uuid).flatMap(id=>{const stat=regularJobFile(id,'job.json');return stat&&stat.size>0&&stat.size<=32768?[{id,modified:stat.mtimeMs}]:[];}).sort((a,b)=>b.modified-a.modified);
    const recovered=[];
    for(const entry of entries){
      try{
        const record=JSON.parse(fs.readFileSync(path.join(jobDirectory,entry.id,'job.json'),'utf8'));
        if(!record||record.version!==1||record.id!==entry.id||!['running','success','failed'].includes(record.state)||!jobText(record.stage)||!record.stage||!jobTime(record.startedAt)||!['song','video'].includes(record.sourceKind))continue;
        if(Object.keys(record).some(key=>!['version','id','state','stage','startedAt','sourceKind','conversationKey','accountScope','source','modelId','title','artist','seconds','previewOnly','sourceStartSeconds','completedAt','error','performance'].includes(key)))continue;
        if(record.accountScope!==undefined&&(typeof record.accountScope!=='string'||!/^[a-f0-9]{64}$/.test(record.accountScope)))continue;
        if(record.conversationKey!==undefined&&!/^wechat:(private|group):[1-9]\d*$/.test(record.conversationKey)||record.seconds!==undefined&&(!Number.isFinite(record.seconds)||record.seconds<=0||record.seconds>30)||record.previewOnly!==undefined&&typeof record.previewOnly!=='boolean'||record.sourceStartSeconds!==undefined&&(!Number.isFinite(record.sourceStartSeconds)||record.sourceStartSeconds<0||record.sourceStartSeconds>14400)||record.completedAt!==undefined&&!jobTime(record.completedAt))continue;
        const safe=savedJob(record);if(JSON.stringify(safe)!==JSON.stringify(record)){
          // Compare fields, not property ordering: hand-migrated snapshots can
          // use a different order but may not contain paths or extra values.
          if(Object.keys(record).some(key=>JSON.stringify(record[key])!==JSON.stringify(safe[key])))continue;
        }
        if(record.performance)validatePerformance(record.performance,record.seconds??30,{allowLegacy:true});
        if(record.state==='success'){
          const preview=regularJobFile(entry.id,'preview.mp3');
          if(!Number.isFinite(record.seconds)||!jobTime(record.completedAt)||!preview||preview.size<=0||preview.size>4*1024*1024)continue;
        }
        const {version,...job}=record;
        recovered.push(job);
        recovered.sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt));if(recovered.length>30)recovered.pop();
      }catch{/* Damaged or foreign records are not evidence of an audio job. */}
    }
    for(const job of recovered.reverse()){
      if(job.state==='running')updateJob(job,{state:'failed',stage:'上次演唱因服务重启而中断',error:'演唱服务已重启，上次任务被中断，未自动重新生成或发送。',completedAt:new Date(now()).toISOString()});
      jobs.set(job.id,job);
    }
  }
  const probe = probeAudio ?? (async file => {
    const value=await executeCapability('audio.probe',{file},{timeoutMs:30000});
    return Number(value.durationSeconds);
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
    const current=settings();
    if (current.musicSource === 'local') return {songs:local, remoteError:null};
    try {
      const {songs} = await executeCapability('music.search',{source:current.musicSource,query,...(current.musicSource==='netease'?{neteaseCookie:current.neteaseCookie}:{})},{signal,timeoutMs:20000});
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
    const current=settings();
    if(current.musicSource==='local')throw fault('当前只使用本地曲库，请先选择在线音乐来源。');
    const song = ticket.song, resolved = await executeCapability('music.resolve',{song,...(current.musicSource==='netease'&&song.source==='netease'?{neteaseCookie:current.neteaseCookie}:{})},{signal,timeoutMs:20000});
    fs.mkdirSync(directory, {recursive:true});
    const key = crypto.randomUUID(), temporary = path.join(directory, key + '.tmp');
    try {
      const result=await executeCapability('music.download',{source:song.source,url:resolved.url,output:temporary},{signal,timeoutMs:55000});
      signal?.throwIfAborted();const stat=fs.lstatSync(temporary);
      if(!stat.isFile()||stat.isSymbolicLink()||!Number.isSafeInteger(result.bytes)||result.bytes<=0||result.bytes>LIMIT||stat.size!==result.bytes)throw fault('歌曲下载完整性校验失败。',502);
      return await commit(temporary, key, {title:song.title, artist:song.artist, album:song.album, providerId:song.id, previewOnly:resolved.previewOnly});
    } finally {if (fs.existsSync(temporary)) fs.unlinkSync(temporary);}
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
  const runtimeAvailable = () => fs.existsSync(python) && fs.existsSync(path.join(runtime, 'runtime.cpu.json')) && fs.existsSync(path.join(runtime, 'cover_demo.py'));
  async function fetchVideoAudio(body,{signal,isAllowed=()=>true}={}){
    const {videoId,conversationKey,startSeconds=0,seconds=settings().clipSeconds??30,localOnly=false}=body??{};
    if(Object.keys(body??{}).some(key=>!['videoId','conversationKey','startSeconds','seconds','localOnly'].includes(key))||typeof localOnly!=='boolean'||!/^[a-f0-9]{64}$/.test(videoId??'')||!/^wechat:(private|group):[1-9]\d*$/.test(conversationKey??'')||!Number.isFinite(startSeconds)||startSeconds<0||startSeconds>14400||!Number.isInteger(seconds)||seconds<10||seconds>30)throw fault('请选择当前聊天中已收到的视频，片段长度为 10～30 秒。');
    if(!isAllowed())throw fault('当前聊天的唱歌能力未开启。',403);
    signal?.throwIfAborted();
    const io=JSON.parse(fs.readFileSync(path.join(root,'state/wechat-io-config.json'),'utf8').replace(/^\uFEFF/,'')),base=new URL(io.receiver_base_url);
    if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||base.pathname!=='/'||base.username||base.password||base.search||base.hash||typeof io.receiver_token!=='string'||!io.receiver_token)throw fault('微信视频读取服务未就绪。',503);
    const result=await fetchImpl(base.origin+'/api/v1/videos/'+videoId+'/singing-audio?'+new URLSearchParams({conversationKey,startSeconds:String(startSeconds),seconds:String(seconds),localOnly:String(localOnly)}),{headers:{Authorization:'Bearer '+io.receiver_token},redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(85000),...(signal?[signal]:[])])});
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
      else await executeCapability('singing.reference',{input,output:dir,seconds:audio.seconds},{signal:combined,timeoutMs:180000});
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
    if (!runCover && !runtimeAvailable()) throw fault('RVC 翻唱环境尚未准备，请在设置中安装或修复翻唱环境；仍可搜歌和缓存音频。', 503);
    if (!source && !findCached(body.songId) && !tickets.has(body.songId)) throw fault('请重新搜索并选择歌曲。', 409);
    while (jobs.size >= 30) {
      const oldest=jobs.keys().next().value;jobs.delete(oldest);
      if(regularJobFile(oldest,'job.json'))fs.unlinkSync(path.join(jobDirectory,oldest,'job.json'));
    }
    const config=structuredClone(settings()),model=models?.get(config.modelId);
    if(models&&!model)throw fault('当前音色没有可用的翻唱模型，请在“语音回复”中补充配套 RVC 模型。',409);
    const accountScope=()=>fs.existsSync(path.join(root,'state/wechat-io-config.json'))?readerScope():null,scope=accountScope(),accountId=activeConnection(root).id;
    const id = crypto.randomUUID(), output = path.join(jobDirectory, id);
    const job = {id, state:'running', stage:'正在获取歌曲音频', startedAt:new Date().toISOString(), source:body.songId,modelId:config.modelId,sourceKind:source?'video':'song',conversationKey:source?.conversationKey??body.conversationKey,...(accountId?{accountScope:accountId}:{}),...(source?{sourceStartSeconds:source.sourceStartSeconds,performance:body.performance}:{})};
    persistJob(job);jobs.set(id, job); active = true;
    const controller = new AbortController(); controllers.add(controller);
    let reference=source?.reference,performance=body.performance;
    const check=()=>{controller.signal.throwIfAborted();if(!isAllowed()||source&&!source.isAllowed())throw fault('当前聊天的唱歌能力已关闭。',403);if(scope!==accountScope())throw fault('微信账号已变化，本次演唱已取消。',409);};
    job.finished = (async () => {
      try {
        const song = source?await source.input(output):await cacheSong(body.songId, controller.signal);
        const available = Math.floor((song.durationSeconds - startSeconds) * 1000) / 1000;
        if (available < 1) throw fault('开始时间超出了音频长度，请调整开始时间。');
        const duration = Math.min(seconds, available);
        updateJob(job, {title:song.title, artist:song.artist, seconds:duration, previewOnly:song.previewOnly,stage:'正在分离人声和伴奏'});
        check();
        const inputFile=source?song.file:audioPath(song.key);
        if(!reference){
          cleanupReferences();
          const referenceId=crypto.randomUUID(),dir=path.join(referenceDirectory,referenceId);fs.mkdirSync(dir,{recursive:false});
          reference={id:referenceId,dir,inUse:true};references.set(referenceId,reference);
          stageJob(job,'正在分析原曲人声、节奏与分句');
          if(runReference)await runReference({input:inputFile,output:dir,seconds:duration,startSeconds,signal:controller.signal});
          else await executeCapability('singing.reference',{input:inputFile,output:dir,startSeconds,seconds:duration},{signal:controller.signal,timeoutMs:180000});
          check();
          const record=JSON.parse(fs.readFileSync(path.join(dir,'reference.json'),'utf8'));
          if(record.schema!=='singing-reference-v1'||record.source_sha256!==crypto.createHash('sha256').update(fs.readFileSync(inputFile)).digest('hex')||Math.abs(record.seconds-duration)>.05||!record.analysis?.phrases?.length)throw fault('歌曲参考分析未完成，未生成演唱。',502);
          stageJob(job,'AI 正在结合音轨与人格编排换声');
          performance=validatePerformance(await planPerformance({analysis:record.analysis,seconds:duration,song:{title:song.title,artist:song.artist,requestedTitle:body.requestedTitle??song.title,version:body.requestedVersion??''},direction:body.direction??'',conversationKey:body.conversationKey,signal:controller.signal}),duration);
          check();updateJob(job,{performance});
        }
        let performanceFile;
        fs.mkdirSync(output,{recursive:true});performanceFile=path.join(output,'performance.json');atomic(performanceFile,performance);
        if (runCover) await runCover({input:inputFile, output, seconds:duration, startSeconds:0, model,pitch:config.pitch,accompaniment:config.accompaniment,signal:controller.signal,performance,reference:reference.dir});
        else await executeCapability('singing.render',{input:inputFile,output,seconds:duration,modelId:config.modelId??'FeiyuVoice-RVC-v1',pitch:config.pitch??0,accompaniment:config.accompaniment!==false,performance,reference:reference.dir},{signal:controller.signal,timeoutMs:46*60*1000,onProgress:stage=>stageJob(job,stage)});
        const receipt = JSON.parse(fs.readFileSync(path.join(output, 'result.json'), 'utf8'));
        if (receipt.status !== 'success' || Math.abs(receipt.seconds - duration) > 0.05) throw fault('翻唱结果校验失败。', 502);
        if(!runCover&&(receipt.route!=='source vocal -> AI arrangement -> selected RVC -> accompaniment remix'||receipt.source_vocals_used!==true||receipt.original_vocals_mixed!==false))throw fault('翻唱链路校验失败，未返回原曲人声编排换声结果。',502);
        check();
        if(!runCover&&(receipt.performance_sha256!==crypto.createHash('sha256').update(fs.readFileSync(performanceFile)).digest('hex')||receipt.performance?.control!=='source-vocal'||receipt.performance?.source_f0_used!==true||receipt.performance?.dynamics?.applied!==true||receipt.performance?.pitch_shift!==(config.pitch??0)+performance.pitchShift||receipt.accompaniment_pitch_shift!==receipt.performance.pitch_shift||receipt.accompaniment_gain_db!==performance.accompanimentGainDb))throw fault('演唱编排未实际执行，未返回音频。',502);
        stageJob(job,'正在准备试听文件');
        await executeCapability('singing.preview',{output,seconds:duration},{signal:controller.signal,timeoutMs:150000});
        check();
        updateJob(job, {state:'success', stage:'试听已生成', seconds:receipt.seconds, completedAt:new Date().toISOString()});
      } catch (error) {
        updateJob(job, {state:'failed', stage:'未生成试听', error:error.status ? error.message : '歌曲处理失败，请检查音源与本地翻唱环境。',completedAt:new Date().toISOString()});}
      finally {if(reference){fs.rmSync(reference.dir,{recursive:true,force:true});references.delete(reference.id);}active = false; controllers.delete(controller);}
    })();
    return publicJob(job);
  }
  function publicJob(job) {const {finished, ...value} = job; return value;}
  function getJob(id) {if (!uuid(id) || !jobs.has(id)) throw fault('找不到这个试听任务。', 404); return publicJob(jobs.get(id));}
  function latestForConversation(key,accountScope){
    if(typeof key!=='string'||!/^wechat:(private|group):[1-9]\d*$/.test(key)||typeof accountScope!=='string'||!/^[a-f0-9]{64}$/.test(accountScope))return null;
    const job=[...jobs.values()].reverse().filter(job=>job.conversationKey===key&&job.accountScope===accountScope).sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt))[0];
    return job?publicJob(job):null;
  }
  function preview(body) {
    const job = getJob(body?.jobId); if (job.state !== 'success') throw fault('试听音频尚未生成。', 409);
    const file = path.join(root, 'state', 'music-jobs', job.id, 'preview.mp3');
    if (!fs.existsSync(file) || fs.statSync(file).size > 4 * 1024 * 1024) throw fault('试听文件不可用。', 404);
    return {audio:fs.readFileSync(file).toString('base64'), mime:'audio/mpeg', seconds:job.seconds, title:job.title};
  }
  recoverJobs();
  const cleanupTimer=setInterval(()=>{try{cleanup();}catch{}},3600000);cleanupTimer.unref();cleanup();
  async function checkNetease({signal}={}) {
    if(closed)throw fault('音乐服务已关闭。',503);
    const current=settings();if(current.musicSource!=='netease')throw fault('请先选择网易云音乐并保存。');
    return executeCapability('music.login-check',{neteaseCookie:current.neteaseCookie},{signal,timeoutMs:20000});
  }
  return {search, cache, importFile, status, start, getJob,latestForConversation, preview,cleanup,requestSong,requestVideo,prepareVideoReference,checkNetease,isBusy:()=>!!active||preparing,
    async settled(id) {await jobs.get(id)?.finished; return getJob(id);},
    close() {closed = true;clearInterval(cleanupTimer); for (const controller of controllers) controller.abort();}};
}
