export const EMOTIONS=Object.freeze(['neutral','happy','sad','angry','comforting','worried','surprised']);
export const EMOTION_STRENGTHS=Object.freeze(['gentle','natural','strong']);
export function speechEmotion(settings,requested='neutral'){
  if(!EMOTIONS.includes(requested))throw Object.assign(Error('请选择有效的语音情绪。'),{status:400});
  return {emotion:settings.emotionMode==='neutral'?'neutral':requested,emotionStrength:settings.emotionStrength??'natural'};
}
