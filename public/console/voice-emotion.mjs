export const EMOTION_CHOICES = [
  ['auto', '自动表达（随文字内容变化）'], ['neutral', '平静自然'],
  ['happy', '开心 / 喜悦'], ['sad', '难过 / 悲伤'], ['angry', '生气 / 不满'],
  ['comforting', '温柔 / 安慰'], ['worried', '担忧 / 关切'],
];
export const EMOTION_STRENGTHS = [['gentle', '轻微'], ['natural', '自然（推荐）'], ['strong', '明显']];
// These voices are explicitly marked as instruction-following in the official tone list.
const verifiedSpeakers = new Set(['zh_female_vv_uranus_bigtts', 'zh_female_xiaohe_uranus_bigtts',
  'zh_male_m191_uranus_bigtts', 'zh_male_taocheng_uranus_bigtts']);
const styles = {happy: '开心、喜悦', sad: '难过、悲伤', angry: '生气、不满，但不要吼叫',
  comforting: '温柔、安慰、体贴', worried: '担忧、关切'};
const strengths = {gentle: '情绪轻微、含蓄。', natural: '情绪自然适度，像日常聊天。', strong: '情绪明显，但避免夸张表演。'};

export function emotionPlan({emotion = 'neutral', emotionStrength = 'natural', resourceId = 'seed-tts-2.0', speaker = ''} = {}) {
  if (!EMOTION_CHOICES.some(([key]) => key === emotion) || !EMOTION_STRENGTHS.some(([key]) => key === emotionStrength)) {
    throw new Error('VOICE_TTS_EMOTION_INVALID');
  }
  const support = resourceId === 'seed-tts-2.0' ? verifiedSpeakers.has(speaker) ? 'verified' : 'unverified' : 'unavailable';
  const instructionSent = emotion !== 'neutral' && support !== 'unavailable' && !!speaker;
  const instruction = instructionSent ? (emotion === 'auto'
    ? '请根据待朗读文字的含义，自然选择并随内容调整语气：开心时喜悦，难过时低落，安慰时温柔，担忧时关切；普通内容保持平静。'
    : `请用${styles[emotion]}的语气说话。`) + strengths[emotionStrength] + '保持当前音色，只朗读原文，不添加台词。' : undefined;
  const message = emotion === 'neutral' ? '使用音色默认的自然语气。'
    : support === 'unavailable' ? '当前声音复刻服务暂不发送情绪指令，试听使用原音色语气。'
    : !speaker ? '填写音色 ID 后可试听情绪。建议先试 Vivi 2.0 或小何 2.0。'
    : support === 'verified' ? '该音色官方标注支持指令遵循；情绪效果以试听为准。'
    : '将尝试发送情绪指令。该音色的情绪效果待验证；若变化不明显，可试 Vivi 2.0 或小何 2.0。';
  return {mode: emotion, strength: emotionStrength, support, instructionSent, instruction, message};
}
