import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {synthesizeSpeech} from '../packages/voice-output/volcengine.mjs';
import {prepareVoiceClip} from '../packages/voice-output/prepare.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const textFile = process.argv[2];
  if (!textFile || process.argv.length !== 3) throw new Error('VOICE_SMOKE_TEXT_FILE_REQUIRED');
  const text = await fs.readFile(path.resolve(textFile), 'utf8');
  const speech = await synthesizeSpeech({text: text.replace(/^\uFEFF/, ''),
    apiKey: process.env.VOLCENGINE_TTS_API_KEY, speaker: process.env.VOLCENGINE_TTS_SPEAKER,
    resourceId: process.env.VOLCENGINE_TTS_RESOURCE_ID || 'seed-tts-2.0'});
  const clip = await prepareVoiceClip(speech);
  const directory = path.join(root, 'state', 'voice-output', 'smoke');
  await fs.mkdir(directory, {recursive: true});
  const file = path.join(directory, Date.now() + '.silk');
  await fs.writeFile(file, clip.silk, {flag: 'wx'});
  process.stdout.write(JSON.stringify({generated: true, sent: false, file, durationMs: clip.durationMs}) + '\n');
} catch (error) {
  const code = /^VOICE_[A-Z_]+$/.test(error.message ?? '') ? error.message : 'VOICE_SMOKE_FAILED';
  process.stderr.write(JSON.stringify({generated: false, sent: false, code}) + '\n'); process.exitCode = 1;
}
