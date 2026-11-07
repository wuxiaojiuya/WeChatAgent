"""Phrase alignment and strict model provenance without running large inference."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np
import soundfile as sf


def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


cover=load('music-cover')


class SingingPipelineTests(unittest.TestCase):
    def test_prepared_reference_uses_source_vocals_without_soulx_and_carries_plan_through_rvc_mix(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp);ref=base/'reference';ref.mkdir();out=base/'job'
            seconds=3;rate=24000;signal=.1*np.sin(2*np.pi*220*np.arange(rate*seconds)/rate)
            source=ref/'video-source.wav';sf.write(source,np.column_stack([signal,signal]),rate,subtype='FLOAT')
            for name in ['source-clip.wav','original-vocals.wav','accompaniment.wav']:
                sf.write(ref/name,np.column_stack([signal,signal]),rate,subtype='FLOAT')
            (ref/'reference.json').write_text(json.dumps({'schema':'singing-reference-v1','source_sha256':cover.sha(source),'seconds':seconds,
                'separation':{'vocal_rms':.1},'files':{name:cover.sha(ref/name) for name in ['source-clip.wav','original-vocals.wav','accompaniment.wav']}}))
            model=base/'model';model.mkdir();(model/'model.pth').write_bytes(b'fixture model');model_hash=cover.sha(model/'model.pth')
            (model/'model.json').write_text(json.dumps({'modelSha256':model_hash}))
            plan_file=base/'performance.json';plan_file.write_text(json.dumps({'version':'source-vocal-arrangement-v1','pitchShift':2,'accompanimentGainDb':-2,'emotion':'warm','intention':'轻唱起句，逐渐加强。','phrases':[
                {'start':0,'end':3,'gainDb':1,'contour':'build'}]}))
            original_run=cover.run;seen=[]
            def run(arguments):
                args=[str(x) for x in arguments]
                if any(x.endswith('music-soulx-worker.py') for x in args):
                    self.fail('SoulX must never run for a source-vocal cover')
                elif any(x.endswith('music-rvc-worker.py') for x in args):
                    seen.append('rvc');self.assertEqual(args[args.index('--input')+1],str(out/'conditioned-vocals.wav'));self.assertEqual(args[args.index('--pitch')+1],'2')
                    folder=out/'rvc';folder.mkdir();sf.write(folder/'rvc_native.wav',signal[:-240],rate,subtype='FLOAT')
                    (folder/'cover_result.json').write_text(json.dumps({'status':'success','model_sha256':model_hash,'actual_synth_calls':[{'device':'fixture'}],'input_sha256':cover.sha(out/'conditioned-vocals.wav'),'inference':{'pitch_shift':2}}))
                else:original_run(arguments)
            arguments=['music-cover.py','--input',str(source),'--output',str(out),'--model',str(model),'--seconds','3','--reference',str(ref),'--performance',str(plan_file)]
            with patch('sys.argv',arguments),patch.object(cover,'separate',side_effect=AssertionError('Reference must not be separated twice')),patch.object(cover,'run',side_effect=run):
                cover.main()
            self.assertEqual(seen,['rvc']);self.assertFalse((out/'soulx').exists())
            result=json.loads((out/'result.json').read_text('utf-8'))
            self.assertEqual(result['performance_sha256'],cover.sha(plan_file));self.assertTrue(result['performance']['dynamics']['applied'])
            self.assertAlmostEqual(result['seconds'],seconds,places=3)
            self.assertEqual(result['route'],'source vocal -> AI arrangement -> selected RVC -> accompaniment remix')
            self.assertTrue(result['source_vocals_used']);self.assertTrue(result['performance']['source_f0_used'])
            self.assertEqual(result['accompaniment_gain_db'],-2)
            self.assertEqual(result['accompaniment_pitch_shift'],2)
            cleaned,_=sf.read(out/'cleaned-vocals.wav')
            self.assertAlmostEqual(result['vocal_gain'],float(np.clip(.1/np.sqrt(np.mean(cleaned**2)),.25,2)),places=5)
            backing,sr=sf.read(out/'transposed-accompaniment.wav',always_2d=True)
            frequency=np.argmax(np.abs(np.fft.rfft(backing[:,0])))*sr/len(backing)
            self.assertAlmostEqual(frequency,220*2**(2/12),delta=1)

    def test_verified_singing_with_rvc_frame_rounding_finishes_real_mix_and_preserves_full_duration(self):
        with tempfile.TemporaryDirectory() as temp:
            out=Path(temp);(out/'rvc').mkdir()
            rate=40000;seconds=3
            signal=.1*np.sin(2*np.pi*220*np.arange(rate*seconds)/rate)
            source=out/'original-vocals.wav';sf.write(source,signal,rate,subtype='FLOAT');sf.write(out/'conditioned-vocals.wav',signal,rate,subtype='FLOAT')
            sf.write(out/'accompaniment.wav',np.column_stack([signal*.2,signal*.2]),rate,subtype='FLOAT')
            sf.write(out/'rvc/rvc_native.wav',signal[:-800],rate,subtype='FLOAT')
            model_hash='a'*64
            (out/'rvc/cover_result.json').write_text(json.dumps({'status':'success','model_sha256':model_hash,'actual_synth_calls':[{'device':'fixture'}],'input_sha256':cover.sha(out/'conditioned-vocals.wav'),'inference':{'pitch_shift':0}}))
            plan={'version':'source-vocal-arrangement-v1','pitchShift':0,'accompanimentGainDb':-2,'emotion':'warm','intention':'温暖连贯地唱。','phrases':[{'start':0,'end':3,'gainDb':1,'contour':'build'}]}
            plan_file=out/'performance.json';plan_file.write_text(json.dumps(plan),encoding='utf-8')
            a=SimpleNamespace(seconds=seconds,start=0,quality='enhanced',vocals_only=False,performance=plan_file,pitch=0)
            cover.finish_cover(a,out,source,model_hash,{'vocal_rms':.1},time.monotonic())
            result=json.loads((out/'result.json').read_text('utf-8'))
            self.assertAlmostEqual(result['seconds'],3,places=3)
            self.assertEqual(result['performance']['dynamics']['tail_padding_samples'],800)
            self.assertFalse(result['original_vocals_mixed']);self.assertTrue(result['performance']['dynamics']['applied'])
            with self.assertRaisesRegex(ValueError,'previous audio job'):
                cover.finish_cover(a,out,source,model_hash,{'vocal_rms':.1},time.monotonic())

    def test_video_job_with_staged_source_reaches_separation_and_rejects_existing_results(self):
        with tempfile.TemporaryDirectory() as temp:
            out=Path(temp)/'job';out.mkdir()
            source=out/'video-source.wav';sf.write(source,np.full((4410,2),.1,dtype=np.float32),44100)
            model=Path(temp)/'model';model.mkdir();weights=model/'model.pth';weights.write_bytes(b'model fixture')
            (model/'model.json').write_text(json.dumps({'modelSha256':hashlib.sha256(weights.read_bytes()).hexdigest()}))
            arguments=['music-cover.py','--input',str(source),'--output',str(out),'--model',str(model),'--seconds','.1','--separate-only']
            with patch('sys.argv',arguments),patch.object(cover,'separate',return_value={'engine':'fixture'}) as separate:
                cover.main()
                separate.assert_called_once()
            self.assertTrue(source.is_file());self.assertTrue((out/'separation.json').is_file())
            with patch('sys.argv',arguments),self.assertRaisesRegex(ValueError,'previous audio job'):
                cover.main()

    def test_selected_uploaded_model_is_verified_before_expensive_synthesis(self):
        with tempfile.TemporaryDirectory() as temp:
            model=Path(temp);weight=model/'model.pth';weight.write_bytes(b'uploaded model fixture')
            expected=hashlib.sha256(weight.read_bytes()).hexdigest()
            (model/'model.json').write_text(json.dumps({'modelSha256':expected}))
            self.assertEqual(cover.selected_model_hash(model),expected)
            weight.write_bytes(b'damaged')
            with self.assertRaisesRegex(ValueError,'checksum'):cover.selected_model_hash(model)



if __name__=='__main__':unittest.main()
