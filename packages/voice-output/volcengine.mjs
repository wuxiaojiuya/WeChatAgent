import {randomUUID} from 'node:crypto';
import {emotionPlan} from '../../public/console/voice-emotion.mjs';

const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const SAMPLE_RATE = 24000;
const MAX_PCM_BYTES = SAMPLE_RATE * 2 * 60;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const fault = code => new Error(code);

// New Volcengine console API Key authentication. This generates speech only;
// the caller must separately submit it through a verified native voice sender.
export async function synthesizeSpeech({text, apiKey, speaker, resourceId = 'seed-tts-2.0', emotion = 'neutral', emotionStrength = 'natural', signal,
  timeoutMs = 60000, fetchImpl = fetch} = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > 500) throw fault('VOICE_TTS_TEXT_INVALID');
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) throw fault('VOICE_TTS_KEY_REQUIRED');
  if (typeof speaker !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(speaker)) throw fault('VOICE_TTS_SPEAKER_REQUIRED');
  if (!['seed-tts-2.0', 'seed-icl-2.0'].includes(resourceId)) throw fault('VOICE_TTS_RESOURCE_INVALID');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw fault('VOICE_TTS_TIMEOUT_INVALID');
  const {instruction, ...emotionResult} = emotionPlan({emotion, emotionStrength, resourceId, speaker});
  const requestSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  try {
    requestSignal.throwIfAborted();
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST', redirect: 'error', signal: requestSignal,
      headers: {'Content-Type': 'application/json', 'X-Api-Key': apiKey.trim(),
        'X-Api-Resource-Id': resourceId, 'X-Api-Request-Id': randomUUID()},
      body: JSON.stringify({req_params: {text: text.trim(), speaker,
        ...(instruction ? {additions: JSON.stringify({context_texts: [instruction]})} : {}),
        audio_params: {format: 'pcm', sample_rate: SAMPLE_RATE}}}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw fault(response.status === 401 || response.status === 403 ? 'VOICE_TTS_AUTH_FAILED' : 'VOICE_TTS_HTTP_FAILED');
    }
    if (!response.body) throw fault('VOICE_TTS_RESPONSE_INVALID');
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', {fatal: true});
    const audio = []; let pending = '', responseBytes = 0, audioBytes = 0, completed = false;
    const accept = line => {
      if (!line.trim()) return;
      if (completed) throw fault('VOICE_TTS_RESPONSE_INVALID');
      let item;
      try { item = JSON.parse(line); } catch { throw fault('VOICE_TTS_RESPONSE_INVALID'); }
      // 20000000 is the historical V3 end marker; the current API uses code 0.
      if (item?.code === 20000000) { completed = true; return; }
      if (item?.code !== 0) throw fault('VOICE_TTS_API_FAILED');
      if (item.data === undefined || item.data === '') return;
      if (typeof item.data !== 'string' || item.data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.data)) {
        throw fault('VOICE_TTS_RESPONSE_INVALID');
      }
      const bytes = Buffer.from(item.data, 'base64');
      if (bytes.toString('base64') !== item.data) throw fault('VOICE_TTS_RESPONSE_INVALID');
      audioBytes += bytes.length;
      if (audioBytes > MAX_PCM_BYTES) throw fault('VOICE_TTS_DURATION_LIMIT');
      audio.push(bytes);
    };
    try {
      for (;;) {
        requestSignal.throwIfAborted();
        const {done, value} = await reader.read();
        if (done) break;
        responseBytes += value.byteLength;
        if (responseBytes > MAX_RESPONSE_BYTES) throw fault('VOICE_TTS_RESPONSE_LIMIT');
        pending += decoder.decode(value, {stream: true});
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          accept(pending.slice(0, newline)); pending = pending.slice(newline + 1);
        }
      }
      pending += decoder.decode(); accept(pending);
      if (!audioBytes || audioBytes % 2) throw fault('VOICE_TTS_AUDIO_INVALID');
      requestSignal.throwIfAborted();
      return {pcm: Buffer.concat(audio), sampleRate: SAMPLE_RATE, durationSeconds: audioBytes / (SAMPLE_RATE * 2), emotion: emotionResult};
    } finally {
      await reader.cancel().catch(() => {}); reader.releaseLock();
    }
  } catch (error) {
    if (requestSignal.aborted) throw fault(signal?.aborted ? 'VOICE_TTS_CANCELLED' : 'VOICE_TTS_TIMEOUT');
    if (/^VOICE_TTS_[A-Z_]+$/.test(error.message ?? '')) throw error;
    // Never expose provider bodies or transport messages containing credentials.
    throw fault('VOICE_TTS_REQUEST_FAILED');
  }
}
