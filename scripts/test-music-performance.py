"""Reference measurements and executed musical edits, without large models."""
import copy
import importlib.util
from pathlib import Path
import unittest
import numpy as np

spec=importlib.util.spec_from_file_location('performance',Path(__file__).with_name('music-performance.py'))
performance=importlib.util.module_from_spec(spec);spec.loader.exec_module(performance)


def plan():
    return {'version':performance.VERSION,'emotion':'warm','intention':'前句连贯，尾字延长，轻轻渐强。','phrases':[
        {'start':0,'end':3,'articulation':'flowing','timingMs':20,'tail':'hold','gainDb':1,'contour':'build'}]}


class PerformanceTests(unittest.TestCase):
    def test_source_vocal_plan_applies_dynamics_without_score_or_timing_edits(self):
        arrangement={'version':performance.ARRANGEMENT_VERSION,'emotion':'tender','intention':'前轻后强，伴奏稍轻。',
                     'pitchShift':2,'accompanimentGainDb':-2,'phrases':[{'start':0,'end':3,'gainDb':1,'contour':'build'}]}
        self.assertEqual(performance.validate_arrangement(arrangement,3),arrangement)
        signal=np.full((24000*3,2),.1,dtype=np.float32)
        output,receipt=performance.apply_dynamics(signal,24000,arrangement,3)
        self.assertEqual(output.shape,signal.shape)
        self.assertGreater(output[-1000,0],output[1000,0]);self.assertTrue(receipt['applied'])
        for field,value in [('pitchShift',4),('pitchShift',True),('accompanimentGainDb',-7),('accompanimentGainDb',float('nan'))]:
            with self.subTest(field=field,value=value),self.assertRaises(ValueError):
                performance.validate_arrangement({**arrangement,field:value},3)
        with self.assertRaises(ValueError):
            performance.validate_arrangement({**arrangement,'phrases':[{**arrangement['phrases'][0],'articulation':'clear'}]},3)

    def test_reference_measures_pitch_and_phrase_positions_without_inventing_emotion(self):
        rate=8000;t=np.arange(rate*4)/rate
        envelope=((t>.4)&(t<1.6))|((t>2)&(t<3.4))
        vocal=.2*np.sin(2*np.pi*220*t)*envelope
        accompaniment=.1*np.sin(2*np.pi*90*t)*((t%.5)<.1)
        result=performance.analyze_stems(vocal,accompaniment,rate)
        self.assertEqual(result['evidence'],'measured-separated-vocal-and-accompaniment')
        self.assertAlmostEqual(result['pitch_hz_p10_p50_p90'][1],220,delta=8)
        self.assertGreaterEqual(len(result['phrases']),2)
        self.assertNotIn('emotion',result);self.assertTrue(result['limits'])

    def test_phrase_dynamics_change_waveform_and_keep_channels_and_sample_count(self):
        audio=np.full((24000*3,2),.1,dtype=np.float32)
        output,receipt=performance.apply_dynamics(audio,24000,plan())
        self.assertEqual(output.shape,audio.shape);self.assertTrue(np.isfinite(output).all())
        self.assertGreater(output[-1000,0],output[1000,0]);self.assertTrue(receipt['applied'])
        self.assertLess(np.max(np.abs(output)),.2)

    def test_invalid_plan_or_unaligned_notes_fail_instead_of_silently_ignoring_controls(self):
        for mutate in [lambda p:p['phrases'].append(dict(p['phrases'][0])),
                       lambda p:p['phrases'][0].update(gainDb=10),
                       lambda p:p['phrases'][0].update(timingMs=float('nan')),
                       lambda p:p.update(extra='ignored')]:
            p=plan();mutate(p)
            with self.assertRaises(ValueError):performance.validate_plan(p,3)

    def test_rvc_frame_rounding_pads_only_a_small_tail_before_applying_end_of_clip_plan(self):
        audio=np.full(round(24000*2.98),.1,dtype=np.float32)
        output,receipt=performance.apply_dynamics(audio,24000,plan(),3)
        self.assertEqual(len(output),72000);self.assertEqual(receipt['tail_padding_samples'],480)
        self.assertTrue(np.all(output[-480:]==0))
        with self.assertRaisesRegex(ValueError,'duration mismatch'):
            performance.apply_dynamics(audio[:24000],24000,plan(),3)


if __name__=='__main__':unittest.main()
