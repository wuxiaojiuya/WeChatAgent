"""Bounded video sampling tied to exact account/chat/message identities."""
import base64
import hashlib
import json
import math
import os
import pathlib
import re
import shutil
import subprocess
import threading
import time
import wave
import xml.etree.ElementTree as ET

MAX_VIDEO_BYTES = 100*1024*1024


def video_info(text):
    if not isinstance(text, str) or len(text) > 100000 or re.search(r'<!DOCTYPE|<!ENTITY', text, re.I):
        return None
    try:
        root = ET.fromstring(text)
        node = root if root.tag == 'videomsg' else root.find('videomsg')
        if node is None:
            return None
        size = int(node.get('length', '0'))
        md5 = node.get('md5', '').lower()
        if not 0 < size <= MAX_VIDEO_BYTES or md5 and not re.fullmatch(r'[a-f0-9]{32}', md5):
            return None
        return {'size': size, 'md5': md5}
    except (ET.ParseError, ValueError):
        return None


def ordinary(path):
    info = pathlib.Path(path).lstat()
    return not pathlib.Path(path).is_symlink() and not getattr(info, 'st_file_attributes', 0) & 0x400


def run_tool(name, args, timeout=12):
    candidate = pathlib.Path('C:/ffmpeg-tools/bin')/(name+'.exe')
    tool = str(candidate) if candidate.is_file() else shutil.which(name)
    if not tool:
        raise RuntimeError('VIDEO_FFMPEG_MISSING')
    result = subprocess.run([tool, '-hide_banner', '-loglevel', 'error', *args],
        stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise RuntimeError('VIDEO_DECODE_FAILED')
    return result.stdout


class VideoCatalog:
    def __init__(self, reader):
        self.reader = reader
        self.folder = reader.root/'state/video-input'
        self.folder.mkdir(parents=True, exist_ok=True)
        self.index = self.folder/'index.json'
        self.records = json.loads(self.index.read_text(encoding='utf-8')) if self.index.is_file() and self.index.stat().st_size < 2*1024*1024 else {}
        self.lock = threading.RLock()
        self.slots = threading.BoundedSemaphore(1)

    def remember_link(self, url, key):
        from douyin_video import douyin_url
        url = douyin_url(url)
        talkers = [talker for talker in self.reader.selected_talkers() if key == 'wechat:'+('group:' if '@chatroom' in talker else 'private:')+self.reader.conversation_id(talker)]
        if len(talkers) != 1 or not self.reader.sticker_account_active():
            raise PermissionError('VIDEO_REFERENCE_NOT_ALLOWED')
        identity = hashlib.sha256(json.dumps([str(self.reader.account), key, url]).encode()).hexdigest()
        with self.lock:
            self.records[identity] = {'account':str(self.reader.account), 'talker':talkers[0], 'sender':'', 'sourceUrl':url,
                'localId':1, 'serverId':str(int(identity[:12],16)), 'createTime':int(time.time())}
            while len(self.records) > 500:
                self.records.pop(next(iter(self.records)))
            temporary = self.index.with_suffix('.tmp')
            temporary.write_text(json.dumps(self.records), encoding='utf-8')
            temporary.replace(self.index)
        return identity

    def source(self, video_id, item, row, local_only=False):
        if not item.get('sourceUrl'):
            return self.reader.video_source(video_id, item, row)
        from douyin_video import download_douyin
        file = self.folder/(video_id+'-source.mp4')
        for old in self.folder.glob('*-source.mp4'):
            if re.fullmatch(r'[a-f0-9]{64}-source\.mp4', old.name) and ordinary(old) and old.stat().st_mtime < time.time()-7*86400:
                old.unlink()
        if not file.is_file():
            if local_only:
                raise RuntimeError('VIDEO_NETWORK_DISABLED')
            config_file=self.reader.root/'state/voice-output/capabilities.json'
            config=json.loads(config_file.read_text(encoding='utf-8')) if config_file.is_file() else {}
            download_douyin(item['sourceUrl'], file, MAX_VIDEO_BYTES, cookie=config.get('singing',{}).get('douyinCookie',''))
        if not ordinary(file) or not 32 <= file.stat().st_size <= MAX_VIDEO_BYTES:
            raise RuntimeError('VIDEO_DOUYIN_UNAVAILABLE')
        return file

    def remember(self, talker, message):
        info = video_info(message.get('fullText', ''))
        if not info or not self.reader.image_talker_allowed(talker):
            return None
        identity = [str(self.reader.account), talker, message.get('localId'), str(message.get('serverId')), message.get('createTime')]
        video_id = hashlib.sha256(json.dumps(identity).encode()).hexdigest()
        with self.lock:
            self.records[video_id] = {**info, 'account': str(self.reader.account), 'talker': talker,
                'localId': message['localId'], 'serverId': str(message['serverId']), 'createTime': message['createTime'], 'sender': message['senderUsername']}
            while len(self.records) > 500:
                old = next(iter(self.records))
                del self.records[old]
                # Only known generated files, never recursive deletion of account data.
                for file in self.folder.glob(old+'-*'):
                    if file.is_file() and ordinary(file):
                        file.unlink()
            temporary = self.index.with_suffix('.tmp')
            temporary.write_text(json.dumps(self.records), encoding='utf-8')
            temporary.replace(self.index)
        return {'id': video_id}

    def record(self, video_id, key):
        reader = self.reader
        item = self.records.get(video_id, {})
        if not re.fullmatch(r'[a-f0-9]{64}', video_id or '') or not item or item.get('account') != str(reader.account):
            raise PermissionError('VIDEO_REFERENCE_NOT_ALLOWED')
        expected = 'wechat:'+('group:' if '@chatroom' in item.get('talker', '') else 'private:')+reader.conversation_id(item.get('talker', ''))
        if not re.fullmatch(r'[a-f0-9]{64}', video_id or '') or item.get('account') != str(reader.account) or key != expected or not reader.sticker_account_active() or not reader.image_talker_allowed(item.get('talker', '')):
            raise PermissionError('VIDEO_REFERENCE_NOT_ALLOWED')
        if item.get('sourceUrl'):
            from douyin_video import douyin_url
            if douyin_url(item['sourceUrl']) != item['sourceUrl']:
                raise RuntimeError('VIDEO_DOUYIN_URL_INVALID')
            return item, None
        row = reader.bound_message(item['talker'], item['serverId'])
        if not row or row['localType'] != 43 or any(str(row[k]) != str(item[k]) for k in ('localId','createTime')) or row['senderUsername'] != item['sender']:
            raise RuntimeError('VIDEO_MESSAGE_IDENTITY_NOT_FOUND')
        info = video_info(row['fullText'])
        if info != {k:item[k] for k in ('size','md5')}:
            raise RuntimeError('VIDEO_MESSAGE_IDENTITY_NOT_FOUND')
        return item, row

    def prepare(self, video_id, key):
        item, row = self.record(video_id, key)
        if not self.slots.acquire(blocking=False):
            raise RuntimeError('VIDEO_READER_BUSY')
        try:
            file = self.source(video_id, item, row)
            with pathlib.Path(file).open('rb') as stream:
                header = stream.read(32)
            if len(header) < 12 or header[4:8] != b'ftyp':
                raise RuntimeError('VIDEO_FORMAT_UNSUPPORTED')
            info = json.loads(run_tool('ffprobe', ['-protocol_whitelist','file,pipe','-show_entries','format=duration:stream=codec_type','-of','json',str(file)]))
            duration = float(info['format']['duration'])
            if not math.isfinite(duration) or not 0 < duration <= 14400:
                raise RuntimeError('VIDEO_DURATION_INVALID')
            sampled = min(duration, 60)
            images = []
            # Leave decoder margin at the end (duration can include audio past
            # the last video frame). Seeking beyond it returns an empty JPEG.
            times = [max(0,sampled-.5)*f for f in (0,.33,.66,1)] if sampled > 1 else [0]
            for index, at in enumerate(times):
                data = run_tool('ffmpeg', ['-nostdin','-protocol_whitelist','file,pipe','-ss',str(max(0,at)),'-i',str(file),'-frames:v','1','-vf','scale=960:960:force_original_aspect_ratio=decrease','-q:v','5','-f','image2pipe','pipe:1'])
                if not data:
                    continue
                from wechat_image_normalize import normalize_image
                normalized = normalize_image(data, max_side=960)
                frame_id = hashlib.sha256((video_id+':frame:'+str(index)).encode()).hexdigest()
                self.reader.video_frame(frame_id, video_id, item, normalized, at)
                images.append({'id':frame_id})
            if not images:
                raise RuntimeError('VIDEO_FRAMES_UNAVAILABLE')
            voice = None
            if any(stream.get('codec_type') == 'audio' for stream in info.get('streams', [])):
                audio = self.folder/(video_id+'-audio.wav')
                run_tool('ffmpeg', ['-nostdin','-protocol_whitelist','file,pipe','-i',str(file),'-t',str(sampled),'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le','-y',str(audio)])
                with wave.open(str(audio)) as wav:
                    seconds = wav.getnframes()/wav.getframerate()
                voice = self.reader.voices.remember(item['talker'], {'rawid':video_id, 'talkerId':item['sender'],
                    'voice':{**{k:item[k] for k in ('localId','serverId','createTime')},'videoId':video_id,'durationSeconds':min(60,seconds)}}, key)
            self.record(video_id, key)
            return {'id':video_id, 'conversationKey':key, 'images':images, 'voice':voice,
                'text':'[视频引用 ID：'+video_id+'。总长约 '+str(round(duration,1))+' 秒，本轮提供前 '+str(round(sampled,1))+' 秒的 '+str(len(images))+' 个采样画面；画面之间的动作和未采样部分不可推断。'+('音轨将单独转写；要求翻唱此片段时可直接使用此视频引用，无需猜歌名。' if voice else '本轮未提供音轨转写。')+']'}
        finally:
            self.slots.release()

    def singing_audio(self, video_id, key, start=0, seconds=30, local_only=False):
        item, row = self.record(video_id, key)
        settings_file = self.reader.root/'state/voice-output/capabilities.json'
        settings = json.loads(settings_file.read_text(encoding='utf-8')).get('singing', {}) if settings_file.is_file() else {}
        if settings.get('provider') != 'feiyu-rvc' or settings.get('enabled') is not True or key not in settings.get('chats', []):
            raise PermissionError('VIDEO_SINGING_NOT_ALLOWED')
        if not math.isfinite(start) or not 0 <= start <= 14400 or not isinstance(seconds, int) or not 10 <= seconds <= 30:
            raise RuntimeError('VIDEO_CLIP_INVALID')
        if not self.slots.acquire(blocking=False):
            raise RuntimeError('VIDEO_READER_BUSY')
        try:
            file = self.source(video_id, item, row, local_only)
            with pathlib.Path(file).open('rb') as stream:
                header = stream.read(12)
            if len(header) < 12 or header[4:8] != b'ftyp':
                raise RuntimeError('VIDEO_FORMAT_UNSUPPORTED')
            data = run_tool('ffmpeg', ['-nostdin','-protocol_whitelist','file,pipe','-ss',str(start),'-i',str(file),'-t',str(seconds),'-vn','-ac','2','-ar','44100','-c:a','pcm_s16le','-f','wav','pipe:1'], timeout=30)
            if not 44 < len(data) <= 6*1024*1024:
                raise RuntimeError('VIDEO_AUDIO_UNAVAILABLE')
            # ffmpeg's pipe WAV uses an unknown length; probe actual PCM bytes.
            import io
            with wave.open(io.BytesIO(data)) as wav:
                frames = wav.readframes(44100*31)
                duration = len(frames)/(wav.getframerate()*wav.getnchannels()*wav.getsampwidth())
            if not 0 < duration <= seconds+.05:
                raise RuntimeError('VIDEO_AUDIO_UNAVAILABLE')
            self.record(video_id, key)
            fresh = json.loads(settings_file.read_text(encoding='utf-8')).get('singing', {})
            if fresh.get('enabled') is not True or fresh.get('provider') != 'feiyu-rvc' or key not in fresh.get('chats', []):
                raise PermissionError('VIDEO_SINGING_NOT_ALLOWED')
            return {'videoId':video_id, 'conversationKey':key, 'mime':'audio/wav', 'b64':base64.b64encode(data).decode(), 'sha256':hashlib.sha256(data).hexdigest(), 'seconds':duration, 'startSeconds':start}
        finally:
            self.slots.release()

    def audio(self, video_id, key):
        self.record(video_id, key)
        file = self.folder/(video_id+'-audio.wav')
        if not ordinary(file) or not 44 < file.stat().st_size <= 2*1024*1024:
            raise RuntimeError('VOICE_AUDIO_NOT_AVAILABLE')
        return file.read_bytes()
