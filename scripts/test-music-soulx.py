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


worker=load('music-soulx-worker')
cover=load('music-cover')


class SoulXSingingTests(unittest.TestCase):
    def test_prepared_reference_is_verified_and_main_carries_plan_through_singer_rvc_and_mix(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp);ref=base/'reference';ref.mkdir();out=base/'job'
            seconds=3;rate=24000;signal=.1*np.sin(2*np.pi*220*np.arange(rate*seconds)/rate)
            source=ref/'video-source.wav';sf.write(source,np.column_stack([signal,signal]),rate,subtype='FLOAT')
            for name in ['source-clip.wav','original-vocals.wav','accompaniment.wav']:
                sf.write(ref/name,np.column_stack([signal,signal]),rate,subtype='FLOAT')
            metadata=ref/'soulx/preprocess/metadata.json';metadata.parent.mkdir(parents=True);metadata.write_text('[]')
            (ref/'reference.json').write_text(json.dumps({'schema':'singing-reference-v1','source_sha256':cover.sha(source),'seconds':seconds,
                'score':{'metadata_sha256':cover.sha(metadata),'vocal_sha256':cover.sha(ref/'original-vocals.wav')},
                'separation':{'vocal_rms':.1},'files':{name:cover.sha(ref/name) for name in ['source-clip.wav','original-vocals.wav','accompaniment.wav']}}))
            model=base/'model';model.mkdir();(model/'model.pth').write_bytes(b'fixture model');model_hash=cover.sha(model/'model.pth')
            (model/'model.json').write_text(json.dumps({'modelSha256':model_hash}))
            singer_runtime=base/'singer';singer_runtime.mkdir()
            plan_file=base/'performance.json';plan_file.write_text(json.dumps({'version':'score-performance-v1','emotion':'warm','intention':'轻唱起句，逐渐加强。','phrases':[
                {'start':0,'end':3,'articulation':'flowing','timingMs':10,'tail':'hold','gainDb':1,'contour':'build'}]}))
            original_run=cover.run;seen=[]
            def run(arguments):
                args=[str(x) for x in arguments]
                if any(x.endswith('music-soulx-worker.py') for x in args):
                    seen.append('singer');self.assertIn('--performance',args);self.assertEqual(args[args.index('--performance')+1],str(plan_file))
                    self.assertEqual(args[args.index('--phase')+1],'sing');self.assertEqual((out/'soulx/preprocess/metadata.json').read_text(),'[]')
                    folder=out/'soulx';folder.mkdir(exist_ok=True);sf.write(folder/'soulx-vocals.wav',signal,rate,subtype='FLOAT')
                    (folder/'result.json').write_text(json.dumps({'status':'success','seconds':seconds,'actual_inference':True,
                        'input_sha256':cover.sha(out/'original-vocals.wav'),'output_sha256':cover.sha(folder/'soulx-vocals.wav'),
                        'performance_sha256':cover.sha(plan_file),'performance':{'control':'score','source_f0_used':False}}))
                elif any(x.endswith('music-rvc-worker.py') for x in args):
                    seen.append('rvc');folder=out/'rvc';folder.mkdir();sf.write(folder/'rvc_native.wav',signal[:-240],rate,subtype='FLOAT')
                    (folder/'cover_result.json').write_text(json.dumps({'status':'success','model_sha256':model_hash,'actual_synth_calls':[{'device':'fixture'}]}))
                else:original_run(arguments)
            arguments=['music-cover.py','--input',str(source),'--output',str(out),'--model',str(model),'--seconds','3','--reference',str(ref),'--performance',str(plan_file),'--soulx-runtime',str(singer_runtime)]
            with patch('sys.argv',arguments),patch.object(cover,'separate',side_effect=AssertionError('Reference must not be separated twice')),patch.object(cover,'run',side_effect=run):
                cover.main()
            self.assertEqual(seen,['singer','rvc'])
            result=json.loads((out/'result.json').read_text('utf-8'))
            self.assertEqual(result['performance_sha256'],cover.sha(plan_file));self.assertTrue(result['performance']['dynamics']['applied'])
            self.assertAlmostEqual(result['seconds'],seconds,places=3)

    def test_verified_singing_with_rvc_frame_rounding_finishes_real_mix_and_preserves_full_duration(self):
        with tempfile.TemporaryDirectory() as temp:
            out=Path(temp);(out/'soulx').mkdir();(out/'rvc').mkdir()
            rate=40000;seconds=3
            signal=.1*np.sin(2*np.pi*220*np.arange(rate*seconds)/rate)
            reference=out/'soulx/soulx-vocals.wav';sf.write(reference,signal,rate,subtype='FLOAT')
            source=out/'original-vocals.wav';sf.write(source,signal,rate,subtype='FLOAT')
            sf.write(out/'accompaniment.wav',np.column_stack([signal*.2,signal*.2]),rate,subtype='FLOAT')
            sf.write(out/'rvc/rvc_native.wav',signal[:-800],rate,subtype='FLOAT')
            model_hash='a'*64
            (out/'rvc/cover_result.json').write_text(json.dumps({'status':'success','model_sha256':model_hash,'actual_synth_calls':[{'device':'fixture'}]}))
            plan={'version':'score-performance-v1','emotion':'warm','intention':'温暖连贯地唱。','phrases':[{'start':0,'end':3,'articulation':'flowing','timingMs':0,'tail':'natural','gainDb':1,'contour':'build'}]}
            plan_file=out/'performance.json';plan_file.write_text(json.dumps(plan),encoding='utf-8')
            singer={'actual_inference':True,'input_sha256':cover.sha(source),'output_sha256':cover.sha(reference),
                    'performance_sha256':cover.sha(plan_file),'performance':{'control':'score','source_f0_used':False}}
            a=SimpleNamespace(seconds=seconds,start=0,quality='enhanced',vocals_only=False,performance=plan_file)
            cover.finish_cover(a,out,source,model_hash,{'vocal_rms':.1},singer,time.monotonic())
            result=json.loads((out/'result.json').read_text('utf-8'))
            self.assertAlmostEqual(result['seconds'],3,places=3)
            self.assertEqual(result['performance']['dynamics']['tail_padding_samples'],800)
            self.assertFalse(result['original_vocals_mixed']);self.assertTrue(result['performance']['dynamics']['applied'])
            with self.assertRaisesRegex(ValueError,'previous audio job'):
                cover.finish_cover(a,out,source,model_hash,{'vocal_rms':.1},singer,time.monotonic())

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

    def test_generated_phrases_keep_source_timing_and_full_clip_silence(self):
        metadata=[{'time':[500,1500]},{'time':[2000,2500]}]
        calls=[]
        def infer(index,meta):
            calls.append(index)
            return np.full(round((meta['time'][1]-meta['time'][0])*24),.2*(index+1),dtype=np.float32)
        result=worker.render_segments(metadata,infer,3,np)
        self.assertEqual(calls,[0,1]);self.assertEqual(len(result),72000)
        self.assertTrue(np.all(result[:12000]==0));self.assertTrue(np.all(result[36000:48000]==0));self.assertTrue(np.all(result[60000:]==0))
        self.assertAlmostEqual(result[20000],.2,places=6);self.assertAlmostEqual(result[50000],.4,places=6)

    def test_no_silent_partial_or_invalid_phrase_can_be_reported_as_success(self):
        for meta,audio in [({'time':[-1,1000]},np.ones(24000)),({'time':[0,4000]},np.ones(96000)),
                           ({'time':[0,1000]},np.zeros(24000)),({'time':[0,1000]},np.ones(12000)),
                           ({'time':[0,1000]},np.full(24000,np.nan))]:
            with self.subTest(meta=meta),self.assertRaises(ValueError):
                worker.render_segments([meta],lambda *_:audio,3,np)
        with self.assertRaises(ValueError):worker.render_segments([],lambda *_:None,3,np)

    def test_selected_uploaded_model_is_verified_before_expensive_synthesis(self):
        with tempfile.TemporaryDirectory() as temp:
            model=Path(temp);weight=model/'model.pth';weight.write_bytes(b'uploaded model fixture')
            expected=hashlib.sha256(weight.read_bytes()).hexdigest()
            (model/'model.json').write_text(json.dumps({'modelSha256':expected}))
            self.assertEqual(cover.selected_model_hash(model),expected)
            weight.write_bytes(b'damaged')
            with self.assertRaisesRegex(ValueError,'checksum'):cover.selected_model_hash(model)

    def test_runtime_rejects_corruption_of_source_models_and_extracted_resources(self):
        tools=worker.runtime_tools
        with tempfile.TemporaryDirectory() as temp:
            runtime=Path(temp)
            files={'source/cli/inference.py':b'official source','source/pretrained_models/singer/model.pt':b'official model',
                   'nltk_data/corpora/data.zip':b'official resource','nltk_data/corpora/data/text':b'extracted resource'}
            for name,data in files.items():
                file=runtime/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes(data)
            sha=lambda name:hashlib.sha256(files[name]).hexdigest()
            spec={'sourceFiles':{'cli/inference.py':sha('source/cli/inference.py')},
                  'assets':[{'destination':'singer/model.pt','bytes':len(files['source/pretrained_models/singer/model.pt']),'sha256':sha('source/pretrained_models/singer/model.pt')}],
                  'nltk':[{'destination':'corpora/data.zip','sha256':sha('nltk_data/corpora/data.zip')}],
                  'nltkFiles':{'corpora/data/text':sha('nltk_data/corpora/data/text')}}
            with patch.object(tools,'specification',return_value=spec):
                tools.verify_runtime(runtime)
                for name,data in files.items():
                    (runtime/name).write_bytes(b'corrupted')
                    with self.subTest(file=name),self.assertRaisesRegex(RuntimeError,'AUDIO_SOULX_'):
                        tools.verify_runtime(runtime)
                    (runtime/name).write_bytes(data)


if __name__=='__main__':unittest.main()
