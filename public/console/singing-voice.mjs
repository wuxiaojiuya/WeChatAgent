// A TTS speaker identifies the character; a singing model still needs an explicit match.
export function resolveSingingVoice(voice, singing) {
  if (singing.voiceSource === 'custom') return {source: 'custom', status: singing.modelId ? 'matched' : 'needs-model',
    modelId: singing.modelId, message: singing.modelId ? '使用单独指定的唱歌音色。' : '请配置唱歌音色模型。'};
  const speaker = voice.speaker, resourceId = voice.resourceId;
  const matched = !!speaker && !!singing.modelId && singing.linkedSpeaker === speaker && singing.linkedResourceId === resourceId;
  return {source: 'voice-reply', speaker, resourceId, modelId: matched ? singing.modelId : '',
    status: !speaker ? 'needs-voice' : matched ? 'matched' : 'needs-model',
    message: !speaker ? '先在“语音回复”中保存角色音色，唱歌会跟随该音色。'
      : matched ? '已关联当前角色的翻唱模型；生成效果仍需实际试听确认。'
      : '将沿用语音回复的角色音色，但还需关联对应的翻唱模型。说话音色 ID 不能直接代替翻唱模型。'};
}
