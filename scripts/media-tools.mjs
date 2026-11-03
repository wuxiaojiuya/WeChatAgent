import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

const sourceRoot = path.resolve(import.meta.dirname, '..');
export function mediaFfmpeg(root = sourceRoot) {
  let configured;
  try {configured = JSON.parse(fs.readFileSync(path.join(root, 'config/wechatagent.json'), 'utf8')).runtime?.python;} catch {}
  const interpreters = [configured && path.resolve(root, configured),
    path.join(root, 'runtime/python/python.exe'),
    path.join(root, 'state/installer-stage/runtime/python/python.exe'),
    path.join(root, 'state/maintenance/audio-capabilities/feiyu-cover/venv/Scripts/python.exe'),
    path.join(sourceRoot, 'state/installer-stage/runtime/python/python.exe')].filter(Boolean);
  for (const python of interpreters) {
    for (const base of [path.dirname(python), path.dirname(path.dirname(python))]) {
      const binaries = path.join(base, 'Lib/site-packages/imageio_ffmpeg/binaries');
      if (!fs.existsSync(binaries)) continue;
      const name = fs.readdirSync(binaries).find(name => /^ffmpeg[^/\\]*\.exe$/i.test(name));
      if (name && fs.statSync(path.join(binaries, name)).isFile()) return path.join(binaries, name);
    }
  }
  return 'ffmpeg';
}

// FFmpeg ships with imageio-ffmpeg; ffprobe does not. Read headers only,
// without decoding the whole video or requiring a second system installation.
export async function probeMedia(file, {root, signal} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(mediaFfmpeg(root), ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file,pipe',
      '-probesize', '5000000', '-analyzeduration', '5000000', '-i', file],
      {windowsHide:true, shell:false, stdio:['ignore', 'ignore', 'pipe']});
    let header = '', failed = false;
    const stop = () => {failed = true; child.kill();};
    const timer = setTimeout(stop, 15000);
    signal?.addEventListener('abort', stop, {once:true}); if (signal?.aborted) stop();
    child.stderr.on('data', data => {header += data.toString('utf8'); if (header.length > 1048576) stop();});
    child.once('error', () => {failed = true;});
    child.once('close', () => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(header);
      const streams = [...header.matchAll(/Stream #[^\r\n]*?: (Audio|Video):/g)].map(item => ({codec_type:item[1].toLowerCase()}));
      if (failed || !duration || !streams.length) return reject(Error('MEDIA_PROBE_FAILED'));
      resolve({format:{duration:Number(duration[1])*3600+Number(duration[2])*60+Number(duration[3])}, streams});
    });
  });
}
