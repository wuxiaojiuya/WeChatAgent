import test from 'node:test';
import assert from 'node:assert/strict';
import {synthesizeSpeech} from '../packages/voice-output/volcengine.mjs';
import {prepareVoiceClip} from '../packages/voice-output/prepare.mjs';
import {decodeVoice} from './decode-wechat-voice.mjs';

const options = {text: '你好，语音测试。', apiKey: 'test-credential', speaker: 'test_speaker'};
const chunk = data => JSON.stringify({code: 0, message: '成功', data: data.toString('base64')});
function streamed(text, fragmentSize = 73) {
  const bytes = Buffer.from(text);
  return new Response(new ReadableStream({start(controller) {
    for (let offset = 0; offset < bytes.length; offset += fragmentSize) controller.enqueue(bytes.subarray(offset, offset + fragmentSize));
    controller.close();
  }}));
}

test('Volcengine request uses current API Key authentication and reconstructs fragmented PCM', async () => {
  const pcm = Buffer.alloc(48000, 3); let calls = 0;
  const result = await synthesizeSpeech({...options, fetchImpl: async (url, request) => {
    calls++;
    assert.equal(url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers['X-Api-Key'], options.apiKey);
    assert.equal(request.headers['X-Api-Resource-Id'], 'seed-tts-2.0');
    assert.ok(request.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(request.body), {req_params: {text: options.text, speaker: options.speaker,
      audio_params: {format: 'pcm', sample_rate: 24000}}});
    assert.ok(!request.body.includes(options.apiKey));
    return streamed(chunk(pcm.subarray(0, 171)) + '\r\n' + chunk(pcm.subarray(171)) + '\n', 7);
  }});
  assert.equal(calls, 1); assert.deepEqual(result.pcm, pcm);
  assert.equal(result.sampleRate, 24000); assert.equal(result.durationSeconds, 1);
});

test('cloned speech resource and historical end markers are accepted', async () => {
  const result = await synthesizeSpeech({...options, resourceId: 'seed-icl-2.0', fetchImpl: async (_url, request) => {
    assert.equal(request.headers['X-Api-Resource-Id'], 'seed-icl-2.0');
    return streamed(chunk(Buffer.alloc(960)) + '\n' + JSON.stringify({code: 20000000}));
  }});
  assert.equal(result.durationSeconds, 0.02);
});

test('emotional instructions use serialized additions without changing spoken text or speaker', async () => {
  for (const emotion of ['auto', 'happy', 'sad', 'angry', 'comforting', 'worried']) {
    const result = await synthesizeSpeech({...options, speaker: 'zh_female_vv_uranus_bigtts', emotion, emotionStrength: 'strong',
      fetchImpl: async (_url, request) => {
        const {req_params: params} = JSON.parse(request.body);
        assert.equal(params.text, options.text); assert.equal(params.speaker, 'zh_female_vv_uranus_bigtts');
        assert.equal(params.context_texts, undefined);
        assert.equal(typeof params.additions, 'string');
        const additions = JSON.parse(params.additions);
        assert.equal(additions.context_texts.length, 1);
        assert.match(additions.context_texts[0], /情绪明显/);
        if (emotion === 'auto') assert.match(additions.context_texts[0], /根据待朗读文字/);
        return streamed(chunk(Buffer.alloc(960)));
      }});
    assert.equal(result.emotion.instructionSent, true); assert.equal(result.emotion.support, 'verified');
  }
});

test('unverified fairy voice reports an attempt, while neutral and cloned service omit instructions', async () => {
  for (const change of [
    {emotion: 'happy', speaker: 'ICL_uranus_zh_female_jinglingxiangdao_tob'},
    {emotion: 'neutral', speaker: 'zh_female_vv_uranus_bigtts'},
    {emotion: 'happy', resourceId: 'seed-icl-2.0'},
  ]) {
    const attempted = change.speaker?.startsWith('ICL_');
    const result = await synthesizeSpeech({...options, ...change, fetchImpl: async (_url, request) => {
      assert.equal(Object.hasOwn(JSON.parse(request.body).req_params, 'additions'), !!attempted);
      return streamed(chunk(Buffer.alloc(960)));
    }});
    assert.equal(result.emotion.instructionSent, !!attempted);
    if (attempted) assert.equal(result.emotion.support, 'unverified');
    if (change.resourceId) assert.equal(result.emotion.support, 'unavailable');
  }
});

test('invalid settings fail before a billable network request', async () => {
  let called = false;
  for (const change of [{text: ''}, {text: 'a'.repeat(501)}, {apiKey: ''}, {apiKey: 'x\ny'}, {speaker: ''},
    {speaker: '../file'}, {resourceId: 'unknown'}, {timeoutMs: 0}, {emotion: 'invalid'}, {emotionStrength: 5}]) {
    await assert.rejects(synthesizeSpeech({...options, ...change, fetchImpl: async () => {called = true;}}), /^Error: VOICE_TTS_/);
  }
  assert.equal(called, false);
});

test('HTTP, transport and API errors never disclose credentials or provider content', async () => {
  for (const fetchImpl of [async () => new Response(options.apiKey, {status: 403}),
    async () => {throw new Error('request included ' + options.apiKey);},
    async () => streamed(chunk(Buffer.alloc(960)) + '\n' + JSON.stringify({code: 1234, message: options.apiKey}))]) {
    await assert.rejects(synthesizeSpeech({...options, fetchImpl}), error => /^VOICE_TTS_[A-Z_]+$/.test(error.message) && !error.message.includes(options.apiKey));
  }
});

test('malformed, empty, odd-length, unfinished and oversized audio cannot become a clip', async () => {
  for (const value of ['{', '{}', '{"code":0}', '{"code":0,"data":"invalid*"}', chunk(Buffer.alloc(1)),
    chunk(Buffer.alloc(960)) + '\n{"code":', chunk(Buffer.alloc(24000 * 2 * 60 + 2))]) {
    await assert.rejects(synthesizeSpeech({...options, fetchImpl: async () => streamed(value, 64000)}), /^Error: VOICE_TTS_/);
  }
  // A broken stream must discard all previously generated audio.
  await assert.rejects(synthesizeSpeech({...options, fetchImpl: async () => new Response(new ReadableStream({start(controller) {
    controller.enqueue(Buffer.from(chunk(Buffer.alloc(960)) + '\n')); controller.error(new Error('lost connection'));
  }}))}), /VOICE_TTS_REQUEST_FAILED/);
});

test('cancelled and timed-out requests return bounded errors and cancel the body', async () => {
  const controller = new AbortController(); controller.abort(); let called = false;
  await assert.rejects(synthesizeSpeech({...options, signal: controller.signal, fetchImpl: async () => {called = true;}}), /VOICE_TTS_CANCELLED/);
  assert.equal(called, false);
  await assert.rejects(synthesizeSpeech({...options, timeoutMs: 1000, fetchImpl: async (_url, request) => {
    return new Promise((_resolve, reject) => {
      // Keep the mocked request alive just as a network socket would.
      const timer = setTimeout(() => reject(new Error('unexpected')), 1500);
      request.signal.addEventListener('abort', () => {clearTimeout(timer); reject(request.signal.reason);}, {once: true});
    });
  }}), /VOICE_TTS_TIMEOUT/);
});

test('real bundled SILK codec preserves the final PCM frame and round-trips audio', async () => {
  const pcm = Buffer.alloc(48002);
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(Math.round(1000 * Math.sin(offset / 2 * 2 * Math.PI * 440 / 24000)), offset);
  const clip = await prepareVoiceClip({pcm, sampleRate: 24000});
  assert.equal(clip.silk[0], 2); assert.equal(clip.silk.toString('ascii', 1, 10), '#!SILK_V3');
  assert.equal(clip.durationMs, 1020);
  const decoded = await decodeVoice(clip.silk);
  assert.equal(decoded.durationSeconds, 1.02);
  const wav = Buffer.from(decoded.b64, 'base64');
  assert.ok(wav.subarray(44).some(byte => byte !== 0));
});

test('voice encoding rejects invalid and over-60-second PCM before processing', async () => {
  for (const value of [{pcm: Buffer.alloc(0), sampleRate: 24000}, {pcm: Buffer.alloc(3), sampleRate: 24000},
    {pcm: Buffer.alloc(960), sampleRate: 44100}, {pcm: Buffer.alloc(24000 * 2 * 60 + 2), sampleRate: 24000}]) {
    await assert.rejects(prepareVoiceClip(value), /^Error: VOICE_OUTPUT_/);
  }
});
