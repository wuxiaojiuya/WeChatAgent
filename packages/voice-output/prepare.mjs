import {encode, getDuration} from '../voice-codec/silk-wasm/lib/index.mjs';
import {validateSilk} from '../../scripts/decode-wechat-voice.mjs';

// SILK framing is necessary for a voice message, but is not a native send API.
export async function prepareVoiceClip({pcm, sampleRate} = {}) {
  if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || ![8000, 12000, 16000, 24000].includes(sampleRate)) {
    throw new Error('VOICE_OUTPUT_PCM_INVALID');
  }
  if (pcm.length > sampleRate * 2 * 60) throw new Error('VOICE_OUTPUT_DURATION_LIMIT');
  // SILK uses 20 ms frames. Pad the last frame rather than losing the end.
  const frameBytes = sampleRate * 2 / 50;
  const padded = Buffer.alloc(Math.ceil(pcm.length / frameBytes) * frameBytes);
  pcm.copy(padded);
  const encoded = await encode(padded, sampleRate), silk = Buffer.from(encoded.data);
  validateSilk(silk);
  const durationMs = getDuration(silk);
  if (durationMs <= 0 || durationMs > 60000) throw new Error('VOICE_OUTPUT_DURATION_LIMIT');
  return {silk, sampleRate, durationMs, format: 'silk'};
}
