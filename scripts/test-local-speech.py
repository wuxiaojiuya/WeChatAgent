"""Music-backed speech recovery without treating silence or weak decodes as text."""
import importlib.util
import io
import pathlib
import unittest
import wave
from types import SimpleNamespace

spec=importlib.util.spec_from_file_location('local_speech',pathlib.Path(__file__).with_name('local-speech-service.py'))
service=importlib.util.module_from_spec(spec);spec.loader.exec_module(service)


class LocalSpeech(unittest.TestCase):
    def wav(self, audible=True):
        data=io.BytesIO()
        with wave.open(data,'wb') as wav:
            wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(16000)
            wav.writeframes((b'\x00\x10' if audible else b'\x00\x00')*1600)
        return data.getvalue()

    def test_singing_discarded_by_vad_is_recovered_but_normal_speech_runs_once(self):
        calls=[]
        segment=SimpleNamespace(text='识别到的内容',no_speech_prob=.62,avg_logprob=-.54,compression_ratio=1.2)
        def transcribe(file, **options):
            calls.append(options['vad_filter'])
            return iter([] if options['vad_filter'] else [segment]),SimpleNamespace(language='zh')
        model=SimpleNamespace(transcribe=transcribe)
        self.assertEqual(service.transcribe_wav(model,self.wav()),('识别到的内容','zh'))
        self.assertEqual(calls,[True,False])
        calls.clear()
        model.transcribe=lambda file,**options:(calls.append(options['vad_filter']) or iter([segment]),SimpleNamespace(language='zh'))
        self.assertEqual(service.transcribe_wav(model,self.wav())[0],'识别到的内容')
        self.assertEqual(calls,[True])

    def test_silence_is_not_retried_and_weak_or_repetitive_fallback_is_not_claimed_as_speech(self):
        calls=[]
        def transcribe(file, **options):
            calls.append(options['vad_filter'])
            return iter([]),SimpleNamespace(language='zh')
        model=SimpleNamespace(transcribe=transcribe)
        self.assertEqual(service.transcribe_wav(model,self.wav(False))[0],'')
        self.assertEqual(calls,[True])
        for fields in ({'no_speech_prob':.9},{'avg_logprob':-1.1},{'compression_ratio':3}):
            segment=SimpleNamespace(text='不可靠结果',**({'no_speech_prob':.2,'avg_logprob':-.4,'compression_ratio':1.2}|fields))
            model.transcribe=lambda file,**options:(iter([] if options['vad_filter'] else [segment]),SimpleNamespace(language='zh'))
            self.assertEqual(service.transcribe_wav(model,self.wav())[0],'')


if __name__=='__main__':
    unittest.main()
