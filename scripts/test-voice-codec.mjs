import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {encode} from '../packages/voice-codec/silk-wasm/lib/index.mjs';
import {decodeVoice,probeDecoder,validateSilk} from './decode-wechat-voice.mjs';

test('the pinned codec payload retains its license and provenance hashes',()=>{
  const base=new URL('../packages/voice-codec/silk-wasm/',import.meta.url),metadata=JSON.parse(fs.readFileSync(new URL('PROVENANCE.json',base)));
  assert.equal(metadata.version,'3.7.1');assert.equal(metadata.license,'MIT');
  for(const [file,hash]of Object.entries(metadata.files))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(new URL(file,base))).digest('hex'),hash);
});

test('bundled codec decodes a synthetic WeChat SILK clip into a bounded mono 16 kHz WAV',async()=>{
  const pcm=Buffer.alloc(32000);for(let offset=0;offset<pcm.length;offset+=2)pcm.writeInt16LE(Math.round(1000*Math.sin(offset/2*2*Math.PI*440/16000)),offset);
  const silk=await encode(pcm,16000),result=await decodeVoice(Buffer.from(silk.data)),wav=Buffer.from(result.b64,'base64');
  assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.readUInt16LE(22),1);assert.equal(wav.readUInt32LE(24),16000);assert.equal(wav.readUInt16LE(34),16);
  assert.equal(result.durationSeconds,1);assert.equal(wav.length,32044);assert.equal((await probeDecoder()).decoder,true);
});

test('format, packet framing, byte and duration limits are checked before decoding',async()=>{
  const header=Buffer.from('\x02#!SILK_V3');
  for(const bytes of [Buffer.from('not silk'),Buffer.concat([header,Buffer.from([5])]),Buffer.concat([header,Buffer.from([5,0,1])]),Buffer.concat([header,Buffer.from([0,0])])])assert.throws(()=>validateSilk(bytes),/VOICE_FORMAT_UNSUPPORTED/);
  assert.throws(()=>validateSilk(Buffer.alloc(2*1024*1024+1)),/VOICE_DECODE_LIMIT/);
  assert.throws(()=>validateSilk(Buffer.concat([header,...Array.from({length:3026},()=>Buffer.from([1,0,0]))])),/VOICE_DECODE_LIMIT/);
  const valid=await encode(Buffer.alloc(1280),16000);const standard=Buffer.concat([Buffer.from(valid.data).subarray(1),Buffer.from([255,255])]);
  assert.equal((await decodeVoice(standard)).sampleRate,16000);
});

test('the installed Python 3.13 bridge can use the bundled Node codec without pip or pilk',async()=>{
  const python=process.env.VOICE_TEST_PYTHON??'python';
  const silk=await encode(Buffer.alloc(1280),16000),script=new URL('./decode-wechat-voice.py',import.meta.url);
  const result=spawnSync(python,['-B',fileURLToPath(script)],{encoding:'utf8',input:JSON.stringify({b64:Buffer.from(silk.data).toString('base64')}),windowsHide:true,timeout:6000});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).sampleRate,16000);
  const probe=spawnSync(python,['-B',fileURLToPath(script),'--probe'],{encoding:'utf8',windowsHide:true,timeout:6000});
  assert.equal(probe.status,0,probe.stderr);assert.equal(JSON.parse(probe.stdout).backend,'silk-wasm');
});
