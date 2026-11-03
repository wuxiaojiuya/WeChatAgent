const fault = (message, status = 502) => Object.assign(new Error(message), {status});
const headers = {'User-Agent': 'Mozilla/5.0', Referer: 'https://www.kugou.com/'};
const text = value => String(value ?? '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').slice(0, 240);
export function validateMusicQuery(query) {
  if (typeof query !== 'string' || !query.trim() || query.length > 100 || /[\0\r\n]/.test(query)) throw fault('请输入 1～100 字的歌名或歌手。', 400);
  return query.trim();
}
export function kugouMediaUrl(value) {
  let url; try {url = new URL(value);} catch {throw fault('酷狗没有返回可用音频。');}
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
      !['kugou.com', 'kugou.net', 'kugoucdn.com'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) {
    throw fault('音频地址不属于受支持的酷狗音源。');
  }
  url.protocol = 'https:'; url.hash = '';
  return url;
}
export async function musicJson(url, fetchImpl, signal, extraHeaders = {}) {
  const response = await fetchImpl(url, {headers:{...headers,...extraHeaders}, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(12000), ...(signal ? [signal] : [])])});
  if (!response.ok) throw fault('酷狗暂时无法访问，请稍后再试。');
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>2*1024*1024)throw fault('音乐搜索结果过大。');chunks.push(chunk);}
  const value=Buffer.concat(chunks).toString('utf8');
  try {return JSON.parse(value);} catch {throw fault('酷狗接口格式已变化，请稍后再试。');}
}
export async function searchKugou(query, {fetchImpl = fetch, signal} = {}) {
  const url = new URL('https://songsearch.kugou.com/song_search_v2');
  url.search = new URLSearchParams({keyword: validateMusicQuery(query), page: '1', pagesize: '10', platform: 'WebFilter', filter: '2'});
  const data = await musicJson(url, fetchImpl, signal);
  if (data.status !== 1 || !Array.isArray(data.data?.lists)) throw fault('酷狗搜索暂不可用，请稍后重试。');
  const seen = new Set();
  return data.data.lists.flatMap(item => {
    const hash = String(item.FileHash ?? '').toUpperCase(), albumId = String(item.AlbumID ?? '0');
    if (!/^[A-F0-9]{32}$/.test(hash) || !/^\d{1,20}$/.test(albumId) || seen.has(hash)) return [];
    seen.add(hash);
    const title = text(item.SongName || item.OriSongName || item.FileName), artist = text(item.SingerName);
    if (!title) return [];
    return [{id: 'kugou:' + hash + ':' + albumId, source: 'kugou', title, artist,
      album: text(item.AlbumName), durationSeconds: Math.max(0, Number(item.Duration) || 0),
      access: Number(item.PayType) > 0 ? 'restricted' : 'unknown', hash, albumId}];
  });
}
export async function resolveKugou(song, {fetchImpl = fetch, signal} = {}) {
  if (!/^[A-F0-9]{32}$/.test(song.hash) || !/^\d{1,20}$/.test(song.albumId)) throw fault('请重新搜索并选择歌曲。', 400);
  // Public mobile playback metadata reports access restrictions explicitly.
  // Do not substitute hashes, forge paid credentials, or decrypt downloads.
  const url = new URL('https://m.kugou.com/app/i/getSongInfo.php');
  url.search = new URLSearchParams({cmd: 'playInfo', hash: song.hash, albumid: song.albumId});
  const data = await musicJson(url, fetchImpl, signal);
  if (typeof data.url !== 'string' || !data.url) throw fault('这首歌未提供可下载音频，可能需要登录、购买或受版权限制。可在酷狗正常下载后导入普通音频文件。', 422);
  const media = kugouMediaUrl(data.url);
  return {url: media, previewOnly: Number(data.pay_type) > 0 || Number(data.timeLength) + 2 < song.durationSeconds};
}
export async function fetchKugouAudio(url, {fetchImpl = fetch, signal} = {}) {
  let current = kugouMediaUrl(url);
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetchImpl(current, {headers, redirect: 'manual', signal});
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      current = kugouMediaUrl(new URL(response.headers.get('location') ?? '', current));
      continue;
    }
    if (!response.ok) throw fault('酷狗音频下载失败，请稍后重试。');
    return response;
  }
  throw fault('音频跳转次数过多，请稍后重试。');
}
