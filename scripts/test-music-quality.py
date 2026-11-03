"""Signal-level checks for the attenuation applied after RVC conversion."""
import importlib.util
from pathlib import Path
import unittest
import numpy as np

spec = importlib.util.spec_from_file_location("music_quality", Path(__file__).with_name("music-quality.py"))
quality = importlib.util.module_from_spec(spec)
spec.loader.exec_module(quality)


class VocalConditioningTests(unittest.TestCase):
    def test_quiet_source_suppresses_generated_noise_without_cutting_singing(self):
        rate = 40000
        time = np.arange(rate * 3) / rate
        reference = np.where((time >= 1) & (time < 2), 0.2 * np.sin(2 * np.pi * 220 * time), 0)
        generated = reference * 0.6 + 0.003 * np.sin(2 * np.pi * 3700 * time)
        result, report = quality.finish_vocals(generated, rate, reference, rate)
        quiet = (time < 0.8) | (time > 2.2)
        singing = (time > 1.2) & (time < 1.8)
        self.assertLess(np.sqrt(np.mean(result[quiet] ** 2)), 1e-6)
        self.assertGreater(np.sqrt(np.mean(result[singing] ** 2)), 0.07)
        self.assertLess(np.max(np.abs(np.diff(result))), 0.01)
        self.assertFalse(report['original_vocal_blended'])
        self.assertLess(report['quiet_rms_after'], report['quiet_rms_before'])

    def test_conditioning_removes_bass_bleed_and_handles_stereo_resampling(self):
        rate = 44100
        time = np.arange(rate) / rate
        bass = 0.3 * np.sin(2 * np.pi * 20 * time)
        voice = 0.1 * np.sin(2 * np.pi * 440 * time)
        prepared = quality.prepare_vocals(np.column_stack([bass + voice, bass + voice]), rate)
        self.assertLess(np.sqrt(np.mean((prepared[2000:-2000] - voice[2000:-2000]) ** 2)), 0.01)
        result, report = quality.finish_vocals(np.zeros(40000), 40000, prepared, rate)
        self.assertEqual(len(result), 40000)
        self.assertTrue(np.isfinite(result).all())
        self.assertEqual(report['after']['clipped_samples'], 0)

    def test_invalid_audio_cannot_be_mastered(self):
        for data in [[], [float('nan')], [float('inf')]]:
            with self.assertRaises(ValueError):
                quality.audio_stats(data)


if __name__ == '__main__':
    unittest.main()
