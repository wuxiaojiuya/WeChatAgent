"""Reuse one isolated CPU TTS process; retain durable queue and output checks."""
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
import uuid

PREFIX = 'WECHATAGENT_SPEECH_RESULT '
IDLE_SECONDS = 600


def supported(job):
    backend = job.get('backend', {})
    runtime = backend.get('runtime', {})
    return (job.get('kind') == 'speech' and backend.get('adapter') == 'managed'
            and runtime.get('host') == 'windows' and runtime.get('backend') == 'cpu'
            and os.path.normcase(os.path.realpath(runtime.get('python', '')))
            == os.path.normcase(os.path.realpath(sys.executable)))


class SpeechPool:
    def __init__(self, root, *, timeout=1800, idle_seconds=IDLE_SECONDS):
        self.root = Path(root).resolve()
        self.timeout = timeout
        self.idle_seconds = idle_seconds
        self.lock = threading.RLock()
        self.process = None
        self.responses = None
        self.identity = None
        self.idle_timer = None
        self.closed = False

    def _discard(self):
        if self.idle_timer:
            self.idle_timer.cancel()
            self.idle_timer = None
        process, self.process = self.process, None
        if process:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            process.stdin.close()
            process.stdout.close()

    def close(self):
        with self.lock:
            self.closed = True
            self._discard()

    def _expire(self):
        with self.lock:
            self._discard()

    def _start(self, identity):
        self._discard()
        self.identity = identity
        log_path = self.root / 'resident-speech.log'
        with log_path.open('a', encoding='utf-8') as log:
            self.process = subprocess.Popen(
                [sys.executable, '-u', '-B', str(Path(__file__).resolve()), '--worker',
                 '--jobs', str(self.root / 'jobs')],
                cwd=Path(__file__).resolve().parent, stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=log, text=True, encoding='utf-8',
                env=dict(os.environ, PYTHONIOENCODING='utf-8'),
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.responses = queue.Queue()
        process, responses = self.process, self.responses

        def read():
            try:
                for line in process.stdout:
                    if line.startswith(PREFIX) and len(line) <= 4096:
                        responses.put(json.loads(line[len(PREFIX):]))
            except (OSError, ValueError):
                pass
            finally:
                responses.put(None)
        threading.Thread(target=read, name='resident-speech-receipts', daemon=True).start()

    def run(self, folder, stopping):
        folder = Path(folder).resolve()
        if folder.parent != self.root / 'jobs':
            raise ValueError('Speech job must belong to the active service')
        job = json.loads((folder / 'request.json').read_text(encoding='utf-8'))
        if not supported(job):
            raise ValueError('Unsupported resident speech runtime')
        identity = hashlib.sha256(json.dumps(job['backend'], sort_keys=True).encode()).hexdigest()
        with self.lock:
            if self.closed or stopping.is_set():
                raise RuntimeError('Speech service stopping')
            if self.idle_timer:
                self.idle_timer.cancel()
                self.idle_timer = None
            if not self.process or self.process.poll() is not None or self.identity != identity:
                self._start(identity)
            request_id = uuid.uuid4().hex
            (folder / 'worker.log').write_text('Isolated resident CPU TTS; see resident-speech.log\n', encoding='utf-8')
            try:
                from feiyu_tts_cache import cpu_threads
                self.process.stdin.write(json.dumps(dict(id=request_id, folder=str(folder), threads=cpu_threads(self.root / 'tts-performance.json'))) + '\n')
                self.process.stdin.flush()
                deadline = time.monotonic() + self.timeout
                while True:
                    if stopping.is_set() or time.monotonic() >= deadline:
                        raise RuntimeError('Resident speech cancelled or timed out')
                    try:
                        result = self.responses.get(timeout=.2)
                    except queue.Empty:
                        continue
                    if result is None or result.get('id') != request_id:
                        raise RuntimeError('Resident speech worker disconnected')
                    if not result.get('ok'):
                        raise RuntimeError('Inference failed; inspect resident-speech.log')
                    break
                from feiyu_singing.pipeline import load, sha
                receipt = load(folder / 'worker_result.json')
                if receipt['status'] != 'success' or sha(folder / 'audio.wav') != receipt['sha256']:
                    raise RuntimeError('Inference output integrity check failed')
                return receipt
            except BaseException:
                # A failed request is never silently replayed on a fresh worker.
                self._discard()
                raise
            finally:
                if self.process:
                    self.idle_timer = threading.Timer(self.idle_seconds, self._expire)
                    self.idle_timer.daemon = True
                    self.idle_timer.start()


def run_job(manager, folder):
    if manager.speech_pool is None:
        manager.speech_pool = SpeechPool(manager.root)
    return manager.speech_pool.run(folder, manager.stopping)


def worker(jobs):
    import traceback
    jobs = Path(jobs).resolve(strict=True)
    protocol = sys.stdout
    # Imported model libraries retain this stable stream across requests.
    sys.stdout = sys.stderr
    from feiyu_voice_service import worker as adapter

    def inline_tts(command, log_path):
        expected = Path(__file__).parent / 'feiyu_runtime/worker.py'
        if (len(command) != 11 or Path(command[0]).resolve() != Path(sys.executable).resolve()
                or command[1] != '-B' or Path(command[2]).resolve() != expected.resolve()
                or command[3:5] != ['--kind', 'tts'] or command[5] != '--package'
                or command[7] != '--profile' or command[9] != '--request'):
            raise ValueError('Unexpected resident speech command')
        from feiyu_runtime.common import load
        from feiyu_runtime.tts import main
        profile = load(command[8])
        if profile.get('engine') != 'tts' or profile.get('backend') != 'cpu':
            raise ValueError('Unexpected resident speech profile')
        Path(log_path).write_text('Resident TTS: see service-data/resident-speech.log\n', encoding='utf-8')
        main(Path(command[6]).resolve(), profile, ['--request', command[10]])

    adapter.run_logged = inline_tts
    for line in sys.stdin:
        request_id = None
        try:
            if len(line) > 8192:
                raise ValueError('Oversized speech command')
            request = json.loads(line)
            request_id = request['id']
            if not isinstance(request_id, str) or len(request_id) != 32:
                raise ValueError('Invalid speech command')
            threads = request.get('threads')
            if type(threads) is not int or not 1 <= threads <= 8:
                raise ValueError('Invalid speech CPU thread count')
            os.environ['WECHATAGENT_TTS_CPU_THREADS'] = str(threads)
            folder = Path(request['folder']).resolve(strict=True)
            if folder.parent != jobs:
                raise ValueError('Unexpected speech job directory')
            job = json.loads((folder / 'request.json').read_text(encoding='utf-8'))
            if not supported(job) or Path(job['job_directory']).resolve() != folder:
                raise ValueError('Unexpected speech job')
            print('Resident speech job ' + folder.name, file=sys.stderr, flush=True)
            adapter.execute(job)
            response = dict(id=request_id, ok=True)
        except Exception:
            from feiyu_tts_cache import clear
            clear()
            traceback.print_exc(file=sys.stderr)
            response = dict(id=request_id, ok=False)
        protocol.write(PREFIX + json.dumps(response) + '\n')
        protocol.flush()


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--worker', action='store_true', required=True)
    parser.add_argument('--jobs', type=Path, required=True)
    worker(parser.parse_args().jobs)
