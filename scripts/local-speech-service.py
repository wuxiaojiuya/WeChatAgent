"""Loopback-only Whisper ASR. Models are installed explicitly, never during a chat."""
import base64
import hashlib
import hmac
import io
import json
import pathlib
import secrets
import threading
import wave
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parent.parent
MODEL = ROOT/'state/media-runtime/models/whisper-small'
TOKEN_FILE = ROOT/'state/media-runtime/asr-token.txt'


def valid_wav(data):
    if not 44 <= len(data) <= 2*1024*1024:
        raise ValueError('VOICE_AUDIO_SIZE_LIMIT')
    with wave.open(io.BytesIO(data)) as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != 16000 or not 0 < wav.getnframes() <= 16000*60:
            raise ValueError('VOICE_AUDIO_FORMAT_INVALID')


def run():
    from faster_whisper import WhisperModel
    model = WhisperModel(str(MODEL), device='cpu', compute_type='int8', cpu_threads=4,
                         local_files_only=True, num_workers=2)
    if not TOKEN_FILE.exists():
        TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        TOKEN_FILE.write_text(secrets.token_hex(32), encoding='ascii')
    token = TOKEN_FILE.read_text(encoding='ascii').strip()
    slots = threading.BoundedSemaphore(2)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, status, value):
            data = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def authorized(self):
            return hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer '+token)

        def do_GET(self):
            if self.path == '/health':
                return self.reply(200, {'status': 'ok', 'project': 'WeChatAgent local ASR', 'model': 'whisper-small', 'local': True})
            if not self.authorized():
                return self.reply(401, {'error': 'Unauthorized'})
            if self.path == '/v1/models':
                return self.reply(200, {'data': [{'id': 'whisper-small', 'object': 'model'}]})
            return self.reply(404, {'error': 'Not found'})

        def do_POST(self):
            if not self.authorized():
                return self.reply(401, {'error': 'Unauthorized'})
            if self.path != '/v1/audio/transcriptions':
                return self.reply(404, {'error': 'Not found'})
            if not slots.acquire(blocking=False):
                return self.reply(429, {'error': 'VOICE_ASR_BUSY'})
            try:
                self.connection.settimeout(5)
                length = int(self.headers.get('Content-Length', '-1'))
                if not 0 < length <= 3*1024*1024:
                    raise ValueError('VOICE_AUDIO_SIZE_LIMIT')
                content_type = self.headers.get('Content-Type', '')
                if not content_type.startswith('multipart/form-data;'):
                    raise ValueError('VOICE_REQUEST_INVALID')
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError('VOICE_REQUEST_INVALID')
                message = BytesParser(policy=default).parsebytes(('Content-Type: '+content_type+'\r\nMIME-Version: 1.0\r\n\r\n').encode()+raw)
                files = [part.get_payload(decode=True) for part in message.iter_parts() if part.get_param('name', header='content-disposition') == 'file']
                if len(files) != 1:
                    raise ValueError('VOICE_REQUEST_INVALID')
                valid_wav(files[0])
                segments, info = model.transcribe(io.BytesIO(files[0]), beam_size=3, vad_filter=True,
                    condition_on_previous_text=False, temperature=0, language=None)
                text = ''.join(segment.text for segment in segments if segment.no_speech_prob < .8).strip()[:4000]
                if not text:
                    return self.reply(422, {'error': 'VOICE_NO_SPEECH'})
                return self.reply(200, {'text': text, 'language': info.language, 'local': True})
            except Exception as error:
                code = str(error) if isinstance(error, ValueError) and str(error).startswith('VOICE_') else 'VOICE_ASR_FAILED'
                return self.reply(400, {'error': code})
            finally:
                slots.release()

    print('Local speech recognition ready; audio stays on this computer.', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 9881), Handler).serve_forever()


if __name__ == '__main__':
    run()
