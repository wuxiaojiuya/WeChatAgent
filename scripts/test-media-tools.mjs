import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {mediaFfmpeg,probeMedia} from './media-tools.mjs';

test('bundled FFmpeg probes and decodes audio without system ffmpeg or ffprobe', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media tools '));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const python = path.resolve(import.meta.dirname, '../state/installer-stage/runtime/python/python.exe');
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config/wechatagent.json'), JSON.stringify({runtime:{python}}));
  const ffmpeg = mediaFfmpeg(root);
  assert.ok(ffmpeg.includes('imageio_ffmpeg'), ffmpeg);
  const file = path.join(root, 'sample.wav');
  const result = spawnSync(ffmpeg, ['-nostdin','-f','lavfi','-i','sine=frequency=440:duration=1.25','-y',file],
    {windowsHide:true,env:{...process.env,PATH:''}});
  assert.equal(result.status,0,result.stderr?.toString());
  const probe = await probeMedia(file,{root});
  assert.ok(Math.abs(probe.format.duration-1.25)<.02);
  assert.ok(probe.streams.some(stream=>stream.codec_type==='audio'));
  const invalid = path.join(root, 'invalid.wav'); fs.writeFileSync(invalid,'invalid');
  await assert.rejects(probeMedia(invalid,{root}),/MEDIA_PROBE_FAILED/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(probeMedia(file,{root,signal:controller.signal}),/MEDIA_PROBE_FAILED/);
});
