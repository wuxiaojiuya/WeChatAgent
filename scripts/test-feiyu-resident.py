"""Synthetic subprocess tests; no model downloads, real speech or WeChat sends."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

from feiyu_tts_cache import cached_voice, clear, cpu_threads
from feiyu_speech_pool import SpeechPool, supported


class CacheTests(unittest.TestCase):
    def tearDown(self):
        clear()

    def test_reuses_only_identical_checkpoint_and_profile(self):
        calls = []
        def build():
            voice = object()
            calls.append(voice)
            return voice, [{'providers': ['CPUExecutionProvider']}]
        first, hit, sessions = cached_voice({'checkpoint': 'a', 'profile': 'v1'}, build)
        self.assertFalse(hit)
        second, hit, actual_sessions = cached_voice({'profile': 'v1', 'checkpoint': 'a'}, build)
        self.assertTrue(hit)
        self.assertIs(first, second)
        self.assertEqual(actual_sessions, sessions)
        third, hit, _ = cached_voice({'checkpoint': 'b', 'profile': 'v1'}, build)
        self.assertFalse(hit)
        self.assertIsNot(third, first)
        cached_voice({'checkpoint': 'b', 'profile': 'v2'}, build)
        self.assertEqual(len(calls), 3)

    def test_failed_load_cannot_return_a_previous_checkpoint(self):
        cached_voice('old', lambda: (object(), []))
        def broken():
            raise ValueError('broken checkpoint')
        with self.assertRaises(ValueError):
            cached_voice('new', broken)
        _, reused, _ = cached_voice('old', lambda: (object(), []))
        self.assertFalse(reused)

    def test_thread_count_is_bounded_and_not_taken_from_unvalidated_text(self):
        with patch.dict(os.environ, WECHATAGENT_TTS_CPU_THREADS='8'), patch('os.cpu_count', return_value=2):
            self.assertEqual(cpu_threads(), 2)
        for value in ('0', '100', 'four', '-1'):
            with patch.dict(os.environ, WECHATAGENT_TTS_CPU_THREADS=value):
                with self.assertRaises(ValueError):
                    cpu_threads()

    def test_measured_local_settings_do_not_change_other_installations_or_ignore_env_override(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ):
            os.environ.pop('WECHATAGENT_TTS_CPU_THREADS', None)
            file = Path(temp) / 'tts-performance.json'
            with patch('os.cpu_count', return_value=16):
                self.assertEqual(cpu_threads(file), 4)
                file.write_text(json.dumps(dict(schema='wechatagent-tts-performance-v1', cpuThreads=8)))
                self.assertEqual(cpu_threads(file), 8)
                with patch.dict(os.environ, WECHATAGENT_TTS_CPU_THREADS='2'):
                    self.assertEqual(cpu_threads(file), 2)
                file.write_text(json.dumps(dict(schema='wechatagent-tts-performance-v1', cpuThreads=100)))
                with self.assertRaises(ValueError):
                    cpu_threads(file)


FAKE_ADAPTER = '''
import hashlib,json,os,time
from pathlib import Path
from feiyu_tts_cache import cached_voice
def execute(job):
    folder=Path(job['job_directory'])
    text=job['request']['text']
    if text=='wait':time.sleep(3)
    if text=='fail':raise ValueError('synthetic inference failure')
    _,hit,_=cached_voice(job['backend'],lambda:(object(),[]))
    audio=json.dumps(dict(text=text,pid=os.getpid(),hit=hit)).encode()
    (folder/'audio.wav').write_bytes(audio)
    (folder/'worker_result.json').write_text(json.dumps(dict(status='success',sha256='bad' if text=='corrupt' else hashlib.sha256(audio).hexdigest(),audio={'fixture':True})))
'''


class PoolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.overlay = self.root / 'overlay'
        self.overlay.mkdir()
        for name in ('feiyu_speech_pool.py', 'feiyu_tts_cache.py'):
            shutil.copyfile(Path(__file__).with_name(name), self.overlay / name)
        for name in ('feiyu_voice_service', 'feiyu_singing'):
            (self.overlay / name).mkdir()
            (self.overlay / name / '__init__.py').write_text('')
        (self.overlay / 'feiyu_voice_service/worker.py').write_text(FAKE_ADAPTER)
        (self.overlay / 'feiyu_singing/pipeline.py').write_text(
            'import hashlib,json\nfrom pathlib import Path\ndef load(p):return json.loads(Path(p).read_text())\ndef sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()\n')
        spec = importlib.util.spec_from_file_location('fixture_pool', self.overlay / 'feiyu_speech_pool.py')
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        pipeline = types.ModuleType('feiyu_singing.pipeline')
        pipeline.load = lambda p: json.loads(Path(p).read_text())
        pipeline.sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
        self.patch = patch.dict(sys.modules, {'feiyu_singing': types.ModuleType('feiyu_singing'), 'feiyu_singing.pipeline': pipeline})
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.pool = self.module.SpeechPool(self.root, idle_seconds=60)
        self.addCleanup(self.pool.close)
        self.stopping = threading.Event()

    def job(self, text='one', backend_version=1):
        folder = self.root / 'jobs' / str(time.time_ns())
        folder.mkdir(parents=True)
        payload = dict(kind='speech', backend=dict(adapter='managed', revision=backend_version,
                       runtime=dict(host='windows', backend='cpu', python=sys.executable)),
                       request=dict(text=text), job_directory=str(folder))
        (folder / 'request.json').write_text(json.dumps(payload))
        return folder

    def run_job(self, folder):
        self.pool.run(folder, self.stopping)
        return json.loads((folder / 'audio.wav').read_text())

    def test_two_requests_share_process_and_model_but_keep_distinct_audio(self):
        first = self.run_job(self.job('one'))
        second = self.run_job(self.job('two'))
        self.assertEqual(first['pid'], second['pid'])
        self.assertFalse(first['hit'])
        self.assertTrue(second['hit'])
        self.assertEqual(second['text'], 'two')
        third = self.run_job(self.job('three', backend_version=2))
        self.assertNotEqual(second['pid'], third['pid'])
        self.assertFalse(third['hit'])

    def test_failure_discards_worker_and_never_replays_failed_job(self):
        first = self.run_job(self.job())
        broken = self.job('fail')
        with self.assertRaisesRegex(RuntimeError, 'Inference failed'):
            self.run_job(broken)
        self.assertFalse((broken / 'audio.wav').exists())
        self.assertIsNone(self.pool.process)
        recovered = self.run_job(self.job('recovered'))
        self.assertNotEqual(first['pid'], recovered['pid'])
        self.assertFalse(recovered['hit'])

    def test_corrupt_receipt_is_rejected_even_when_worker_says_success(self):
        with self.assertRaisesRegex(RuntimeError, 'integrity'):
            self.run_job(self.job('corrupt'))
        self.assertIsNone(self.pool.process)

    def test_timeout_cancels_process_without_inference_retry(self):
        self.pool.timeout = .1
        with self.assertRaisesRegex(RuntimeError, 'timed out'):
            self.run_job(self.job('wait'))
        self.assertIsNone(self.pool.process)

    def test_service_stop_interrupts_active_work_and_releases_worker(self):
        timer = threading.Timer(.08, self.stopping.set)
        timer.start()
        self.addCleanup(timer.cancel)
        started = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, 'cancelled'):
            self.run_job(self.job('wait'))
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertIsNone(self.pool.process)

    def test_idle_expiry_and_stop_release_process(self):
        self.pool.idle_seconds = .05
        self.run_job(self.job())
        deadline = time.monotonic() + 2
        while self.pool.process is not None and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertIsNone(self.pool.process)
        self.stopping.set()
        with self.assertRaisesRegex(RuntimeError, 'stopping'):
            self.run_job(self.job())

    def test_wrong_runtime_and_outside_job_directory_are_rejected(self):
        job = json.loads((self.job() / 'request.json').read_text())
        self.assertTrue(supported(job))
        for field, value in [('host', 'wsl'), ('backend', 'cuda'), ('python', 'another-python')]:
            changed = json.loads(json.dumps(job))
            changed['backend']['runtime'][field] = value
            self.assertFalse(supported(changed))
        job['kind'] = 'conversion'
        self.assertFalse(supported(job))
        with self.assertRaisesRegex(ValueError, 'active service'):
            self.pool.run(self.root, self.stopping)


if __name__ == '__main__':
    unittest.main()
