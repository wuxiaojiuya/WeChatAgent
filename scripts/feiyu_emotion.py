"""Instruction-based CosyVoice3 expression; no text rewriting or pitch shifting."""
EMOTIONS = ('neutral', 'happy', 'sad', 'angry', 'comforting', 'worried', 'surprised')
STRENGTHS = ('gentle', 'natural', 'strong')
STYLES = {'happy': '开心、喜悦', 'sad': '难过、低落', 'angry': '生气、不满但不吼叫',
          'comforting': '温柔、安慰、体贴', 'worried': '担忧、关切', 'surprised': '惊讶、意外'}


def emotion_instruction(request):
    emotion, strength = request.get('emotion', 'neutral'), request.get('emotionStrength', 'natural')
    if emotion not in EMOTIONS or strength not in STRENGTHS:
        raise ValueError('VOICE_EMOTION_INVALID')
    if emotion == 'neutral':
        return None
    level = {'gentle': '情绪含蓄轻微', 'natural': '情绪自然适度', 'strong': '情绪清楚但不夸张'}[strength]
    return 'You are a helpful assistant. 请用' + STYLES[emotion] + '的语气说话，' + level + '，保持音色，只朗读正文。<|endofprompt|>'


def synthesize(voice, request, reference, params, reference_text):
    instruction = emotion_instruction(request)
    if instruction:
        return voice.inference_instruct2(request['text'], instruction, str(reference),
                                        stream=False, speed=params['speed'], text_frontend=True)
    return voice.inference_zero_shot(request['text'], params['prompt_prefix'] + reference_text,
                                    str(reference), stream=False, speed=params['speed'], text_frontend=True)
