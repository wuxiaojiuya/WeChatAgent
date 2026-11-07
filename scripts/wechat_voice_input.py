"""Exact-message, account-scoped voice references. Never downloads audio."""
import base64
import hashlib
import json
import pathlib
import re
import threading
import xml.etree.ElementTree as ET

ID = re.compile(r'^[a-f0-9]{64}$')
MAX_SILK_BYTES = 2 * 1024 * 1024


def voice_info(text):
    if not isinstance(text, str) or len(text) > 100000 or re.search(r'<!DOCTYPE|<!ENTITY', text, re.I):
        return None
    try:
        root = ET.fromstring(text)
        node = root.find('voicemsg') if root.tag == 'msg' else root if root.tag == 'voicemsg' else None
        duration = int(node.get('voicelength', '0')) if node is not None else 0
        if not 1 <= duration <= 60000:
            return None
        return {'durationSeconds': duration / 1000}
    except (ET.ParseError, ValueError, TypeError):
        return None


def audio_policy(root, key, plugin_id='speech-recognition'):
    if not re.fullmatch(r'wechat:(private|group):[1-9]\d*', key or '') or not re.fullmatch(r'[a-z][a-z0-9-]{0,39}', plugin_id or ''):
        return False
    try:
        project = json.loads((pathlib.Path(root)/'config/wechatagent.json').read_text(encoding='utf-8-sig'))
        kind, target = key.split(':')[1:]
        if target not in map(str, project.get('wechat', {}).get('whitelist', {}).get('groups' if kind == 'group' else 'private', [])):
            return False
        config = json.loads((pathlib.Path(root)/'config/plugins.json').read_text(encoding='utf-8-sig'))
        saved = config.get('plugins', {}).get(plugin_id, {})
        return saved.get('enabled') is True and 'audio_read' in saved.get('permissions', []) and (saved.get('chats') is None or key in saved.get('chats', []))
    except (OSError, ValueError, TypeError, AttributeError):
        return False


class VoiceCatalog:
    def __init__(self, root, account, active):
        self.root, self.account, self.active = pathlib.Path(root), str(pathlib.Path(account).resolve()), active
        self.file = self.root/'state/voices/index.json'
        self.lock = threading.RLock()
        self.records = {}
        if self.file.exists():
            if self.file.is_symlink() or self.file.stat().st_size > 2*1024*1024:
                raise RuntimeError('VOICE_INDEX_INVALID')
            value = json.loads(self.file.read_text(encoding='utf-8-sig'))
            if value.get('version') != 1 or not isinstance(value.get('entries'), dict):
                raise RuntimeError('VOICE_INDEX_INVALID')
            self.records = value['entries']

    def remember(self, talker, payload, key):
        info = payload.get('voice', {})
        if not self.active() or not audio_policy(self.root, key) or not ID.fullmatch(payload.get('rawid', '')):
            return None
        if not isinstance(info.get('localId'), int) or info['localId'] <= 0 or not isinstance(info.get('createTime'), int) or info['createTime'] <= 0 or not re.fullmatch(r'\d{1,20}', str(info.get('serverId', ''))):
            return None
        voice_id = hashlib.sha256((self.account+'\0'+talker+'\0'+payload['rawid']).encode()).hexdigest()
        record = {**info, 'talker': talker, 'sender': payload['talkerId'], 'account': self.account, 'conversationKey': key}
        with self.lock:
            self.records[voice_id] = record
            while len(self.records) > 1000:
                self.records.pop(next(iter(self.records)))
            self.file.parent.mkdir(parents=True, exist_ok=True)
            temp = self.file.with_suffix('.tmp')
            temp.write_text(json.dumps({'version': 1, 'entries': self.records}), encoding='utf-8')
            temp.replace(self.file)
        return {'id': voice_id, 'durationSeconds': info['durationSeconds']}

    def record(self, voice_id, key, plugin_id):
        if not ID.fullmatch(voice_id or '') or not self.active() or not audio_policy(self.root, key, plugin_id):
            raise PermissionError('VOICE_REFERENCE_NOT_ALLOWED')
        with self.lock:
            item = dict(self.records.get(voice_id, {}))
        if item.get('account') != self.account or item.get('conversationKey') != key:
            raise PermissionError('VOICE_REFERENCE_NOT_ALLOWED')
        return item





def audio_result(voice_id, key, data, format, duration, sample_rate=0):
    return {'id': voice_id, 'conversationKey': key, 'b64': base64.b64encode(data).decode('ascii'),
            'sha256': hashlib.sha256(data).hexdigest(), 'mime': 'audio/wav' if format == 'wav' else 'audio/silk',
            'filename': 'voice.'+format, 'sampleRate': sample_rate, 'durationSeconds': duration}
