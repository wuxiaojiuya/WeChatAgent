"""Bounded file-message metadata and verified, account-local file lookup."""
import hashlib
import json
import os
import pathlib
import re
import threading
import time
import xml.etree.ElementTree as ET

FILE_TYPE = (6 << 32) | 49
MAX_FILE_BYTES = 50 * 1024 * 1024
ID = re.compile(r'^[a-f0-9]{64}$')

def safe_file_name(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 180:
        return None
    if value in ('.', '..') or value[-1:] in (' ', '.') or re.search(r'[\\/:*?"<>|\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]', value):
        return None
    if re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', value, re.I):
        return None
    return value

def parse_file_message(kind, text):
    if kind not in (49, FILE_TYPE) or not isinstance(text, str) or len(text) > 131072 or re.search(r'<!DOCTYPE|<!ENTITY', text, re.I):
        return None
    try:
        root = ET.fromstring(text)
        app = root if root.tag == 'appmsg' else root.find('./appmsg') if root.tag == 'msg' else None
        if app is None or app.findtext('type') != '6':
            return None
        name = safe_file_name(app.findtext('title') or '')
        size = int(app.findtext('appattach/totallen') or '-1')
        md5 = (app.findtext('appattach/md5') or app.findtext('md5') or '').lower()
        if not name or not 0 <= size <= MAX_FILE_BYTES or md5 and not re.fullmatch(r'[a-f0-9]{32}', md5):
            return None
        return {'name': name, 'size': size, 'md5': md5}
    except (ET.ParseError, ValueError, TypeError):
        return None

def file_policy(project, key, sender):
    w = project.get('wechat', {})
    match = re.fullmatch(r'wechat:(private|group):([1-9]\d{0,15})', key or '')
    if not match or not isinstance(sender, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', sender):
        return False
    if match[2] not in map(str, w.get('whitelist', {}).get('groups' if match[1] == 'group' else 'private', [])) or w.get('workModes', {}).get(key, 'social') != 'assistant':
        return False
    policy = w.get('assistant', {})
    if policy.get('fileTransferChats', {}).get(key) is not True:
        return False
    return (match[1] == 'group' and policy.get('adminOnlyGroups', {}).get(key) is False) or sender in policy.get('administrators', [])


def media_file_policy(project, key, sender):
    """Read-only quote extraction in selected chats, independent of OS tools."""
    match = re.fullmatch(r'wechat:(private|group):([1-9]\d{0,15})', key or '')
    return bool(match and isinstance(sender,str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}',sender) and
        match[2] in map(str,project.get('wechat',{}).get('whitelist',{}).get('groups' if match[1]=='group' else 'private',[])))

def _ordinary(path):
    stat = path.lstat()
    return not path.is_symlink() and not (getattr(stat, 'st_file_attributes', 0) & 0x400)

def hashes(path):
    md5, sha = hashlib.md5(), hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            md5.update(block)
            sha.update(block)
    return md5.hexdigest(), sha.hexdigest()

class FileCatalog:
    def __init__(self, root, account, active=lambda: True, *, policy=file_policy, index_name='incoming.json'):
        self.root, self.account, self.active = pathlib.Path(root), pathlib.Path(account).resolve(), active
        self.policy = policy
        self.lock = threading.RLock()
        self.index_file = self.root / 'state/files' / index_name
        self.records = {}
        if self.index_file.is_file() and self.index_file.stat().st_size <= 2 * 1024 * 1024:
            value = json.loads(self.index_file.read_text(encoding='utf-8-sig'))
            if value.get('version') != 1 or not isinstance(value.get('entries'), dict):
                raise RuntimeError('FILE_INDEX_INVALID')
            self.records = value['entries']

    def remember(self, payload, key):
        info = payload.get('file')
        if not info or not self.active() or not ID.fullmatch(payload.get('rawid', '')):
            return None
        project = json.loads((self.root / 'config/wechatagent.json').read_text(encoding='utf-8-sig'))
        if not self.policy(project, key, payload.get('talkerId')):
            return None
        file_id = payload['rawid']
        with self.lock:
            self.records[file_id] = {**info, 'account': str(self.account), 'conversationKey': key, 'senderWxid': payload['talkerId'], 'createTime': payload.get('timestamp', 0)}
            while len(self.records) > 1000:
                self.records.pop(next(iter(self.records)))
            self.index_file.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.index_file.with_suffix('.tmp')
            temporary.write_text(json.dumps({'version': 1, 'entries': self.records}), encoding='utf-8')
            temporary.replace(self.index_file)
        return {'id': file_id, 'name': info['name'], 'size': info['size']}

    def resolve(self, file_id, key, sender):
        raise RuntimeError('HOOK_FILE_RESOLVER_REQUIRED')
