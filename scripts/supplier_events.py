"""Normalize supplier callbacks and keep a bounded, durable project message cache.

This module never reads a WeChat database. Server IDs, local message IDs and
client submission IDs stay distinct; observing an outgoing callback is not a
server delivery receipt. Authorization of the conversation belongs to callers.
"""
import copy
import hashlib
import json
import os
import pathlib
import re
import tempfile
import threading
import time
import xml.etree.ElementTree as ET


MAX_CONTENT_BYTES = 2 * 1024 * 1024
MAX_STORE_BYTES = 16 * 1024 * 1024
IDENTIFIER = re.compile(r'^[A-Za-z0-9_-]{1,128}(?:@chatroom)?$')
RAW_ID = re.compile(r'^[a-f0-9]{64}$')
XML_TYPES = {3, 34, 43, 47, 49}
APP_TYPES = {6, 8, 19, 57, 62}


def _string(value, maximum=MAX_CONTENT_BYTES):
    if isinstance(value, dict):
        value = value.get('String', '')
    if not isinstance(value, str) or len(value.encode('utf-8')) > maximum or '\0' in value:
        raise ValueError('HOOK_CALLBACK_FIELD_INVALID')
    return value


def _number(value, default=None, maximum=18446744073709551615):
    if value is None or value == '':
        return default
    if type(value) is int:
        number = value
    elif isinstance(value, str) and re.fullmatch(r'[0-9]{1,20}', value):
        number = int(value)
    else:
        raise ValueError('HOOK_CALLBACK_NUMBER_INVALID')
    if not 0 <= number <= maximum:
        raise ValueError('HOOK_CALLBACK_NUMBER_INVALID')
    return number


def _identifier(value, *, optional=False):
    result = _string(value, 180)
    if optional and not result:
        return ''
    if not IDENTIFIER.fullmatch(result):
        raise ValueError('HOOK_CALLBACK_SENDER_INVALID')
    return result


def _xml(value):
    if re.search(r'<!\s*(?:DOCTYPE|ENTITY)\b', value, re.I):
        raise ValueError('HOOK_CALLBACK_XML_UNSAFE')
    try:
        return ET.fromstring(value)
    except ET.ParseError:
        # The own-app callback documents an appmsg followed by fromusername.
        if value.lstrip().startswith('<appmsg'):
            try:
                return ET.fromstring('<msg>' + value + '</msg>')
            except ET.ParseError:
                pass
        raise ValueError('HOOK_CALLBACK_XML_INVALID') from None


def _mentions(source):
    if not source:
        return []
    root = _xml(source)
    result = []
    for node in root.iter('atuserlist'):
        for value in (node.text or '').split(','):
            value = value.strip()
            if value and IDENTIFIER.fullmatch(value) and value not in result:
                result.append(value)
                if len(result) == 256:
                    return result
    return result


def _kind_xml(kind, text):
    root = None
    if (kind & 0xffffffff) in XML_TYPES:
        root = _xml(text)
    if kind == 49 and root is not None:
        app = root if root.tag == 'appmsg' else root.find('appmsg')
        subtype = _number(app.findtext('type'), default=0, maximum=65535) if app is not None else 0
        if subtype in APP_TYPES:
            kind = (subtype << 32) | 49
    return kind, root


def _raw_id(talker, row):
    if row.get('clientId') and row['serverId'] == '0':
        values = ['supplier-client', talker, row['clientId'], row['localType']]
    else:
        # Match the shared reader payload identity, without numeric coercion.
        values = [talker, row['serverId'], row['localId'], row['createTime']]
    return hashlib.sha256(json.dumps(values, separators=(',', ':')).encode()).hexdigest()


def _finish(talker, row, root=None):
    row['content'] = row['fullText']
    row['parsedContent'] = row['fullText']
    row['rawid'] = _raw_id(talker, row)
    row['mentions'] = _mentions(row['msgSource'])
    row['atUserList'] = list(row['mentions'])
    callback = {'msgId': row['localId'], 'from': talker, 'to': row.get('recipient', ''),
                'type': row['localType'] & 0xffffffff}
    if root is not None:
        image = root if root.tag == 'img' else root.find('img')
        if image is not None and re.fullmatch(r'[A-Fa-f0-9]{32}', image.get('md5', '')):
            row['imageMd5'] = image.get('md5').lower()
        voice = root if root.tag == 'voicemsg' else root.find('voicemsg')
        if voice is not None:
            length = voice.get('length') or voice.get('buflen')
            if length is not None:
                callback['length'] = str(_number(length, maximum=2 * 1024 * 1024))
        emoji = root if root.tag == 'emoji' else root.find('emoji')
        if emoji is not None and re.fullmatch(r'[A-Fa-f0-9]{32}', emoji.get('md5', '')):
            row['stickerMd5'] = emoji.get('md5').lower()
            row['stickerKind'] = 'emoji-47'
        app = root if root.tag == 'appmsg' else root.find('appmsg')
        if app is not None and app.findtext('type') == '6':
            row.update(fileKind='appmsg-6', fileName=app.findtext('title') or '',
                       fileSize=_number(app.findtext('appattach/totallen'), default=0),
                       fileMd5=(app.findtext('appattach/md5') or app.findtext('md5') or '').lower())
    row['callback'] = callback
    return talker, row


def _incoming(body, own_wxid):
    sender_field = _identifier(body.get('fromUserName', ''))
    recipient = _identifier(body.get('toUserName', ''), optional=True)
    kind = _number(body.get('msgType'), maximum=18446744073709551615)
    if kind is None:
        return []
    timestamp = _number(body.get('createTime'), maximum=4102444800)
    local_id = _number(body.get('msgId'), default=0)
    server_id = str(_number(body.get('newMsgId'), default=0))
    if not timestamp or not local_id and server_id == '0':
        raise ValueError('HOOK_CALLBACK_MESSAGE_ID_REQUIRED')
    content = _string(body.get('content', ''))
    sender = sender_field
    sender_name = _string(body.get('sender_nick', ''), 1000)
    group = sender_field.endswith('@chatroom')
    if group:
        prefix = re.match(r'^([A-Za-z0-9_-]{1,128}):(?:\r?\n)?', content)
        member = body.get('member_info')
        member = member if isinstance(member, dict) else {}
        member_sender = _identifier(member.get('userName', ''), optional=True)
        if member_sender and prefix and member_sender != prefix[1]:
            raise ValueError('HOOK_CALLBACK_GROUP_SENDER_CONFLICT')
        sender = member_sender or (prefix[1] if prefix else '')
        if not sender:
            raise ValueError('HOOK_CALLBACK_GROUP_SENDER_REQUIRED')
        if not sender_name:
            sender_name = _string(member.get('nickName', ''), 1000)
        actual = body.get('real_content')
        content = _string(actual) if actual is not None else content[prefix.end():] if prefix else content
    elif not sender_name:
        profile = body.get('sender_profile')
        if isinstance(profile, dict):
            sender_name = _string(profile.get('nickName', ''), 1000)
    outgoing = sender == own_wxid
    talker = recipient if outgoing and not group else sender_field
    if not talker:
        raise ValueError('HOOK_CALLBACK_SENDER_INVALID')
    kind, root = _kind_xml(kind, content)
    row = {'localId': local_id, 'serverId': server_id, 'localType': kind,
           'createTime': timestamp, 'fullText': content, 'senderUsername': sender,
           'senderName': sender_name, 'isSend': int(outgoing),
           'recipient': recipient, 'msgSource': _string(body.get('msgSource', ''), 131072),
           'msgSeq': str(_number(body.get('msgSeq'), default=0)), 'source': 'supplier-push'}
    return [_finish(talker, row, root)]


def _own_message(item, own_wxid, *, kind=None, now=None):
    if not isinstance(item, dict):
        raise ValueError('HOOK_CALLBACK_INVALID')
    target = _identifier(item.get('toUserName', ''))
    kind = kind if kind is not None else _number(item.get('type'), maximum=18446744073709551615)
    if kind is None:
        return None
    content = _string(item.get('content', ''))
    kind, root = _kind_xml(kind, content)
    client_value = item.get('clientMsgId', item.get('clientImgId', ''))
    client_id = str(_number(client_value)) if type(client_value) is int else _string(client_value, 512)
    native_timestamp = _number(item.get('createTime'), maximum=4102444800)
    timestamp = native_timestamp or int(time.time() if now is None else now)
    local_id = _number(item.get('msgId'), default=0)
    server_id = str(_number(item.get('newMsgId'), default=0))
    if not client_id and not local_id and server_id == '0':
        raise ValueError('HOOK_CALLBACK_MESSAGE_ID_REQUIRED')
    row = {'localId': local_id, 'serverId': server_id, 'clientId': client_id,
           'localType': kind, 'createTime': timestamp, 'fullText': content,
           'senderUsername': own_wxid, 'senderName': '', 'isSend': 1,
           'recipient': target, 'msgSource': _string(item.get('msgSource', ''), 131072),
           'source': 'supplier-own-callback', 'observedOnly': server_id == '0',
           'timestampSource': 'callback' if native_timestamp else 'received'}
    return _finish(target, row, root)


def normalize_callbacks(body, own_wxid, *, now=None):
    """Return normalized (conversation, row) pairs, never perform authorization.

    Unknown non-message callbacks return an empty list. Malformed message
    callbacks raise ValueError so a caller cannot acknowledge a discarded event.
    The login metadata only determines message direction; it is not compared
    with any supplier account field.
    """
    if not isinstance(body, dict) or not isinstance(own_wxid, str) or not IDENTIFIER.fullmatch(own_wxid):
        raise ValueError('HOOK_CALLBACK_INVALID')
    if isinstance(body.get('list'), list):
        if len(body['list']) > 100:
            raise ValueError('HOOK_CALLBACK_BATCH_TOO_LARGE')
        return [result for item in body['list']
                if (result := _own_message(item, own_wxid, now=now)) is not None]
    if isinstance(body.get('msg'), dict):
        result = _own_message(body['msg'], own_wxid, kind=49, now=now)
        return [result] if result is not None else []
    if 'clientImgId' in body and 'toUserName' in body:
        image = ET.Element('img')
        for key in ('md5', 'aeskey', 'cdnmidImgUrl', 'cdnbigImgUrl', 'cdnmidImgSize', 'cdnbigImgSize'):
            if key in body:
                value = body[key]
                if not isinstance(value, (str, int)) or isinstance(value, bool):
                    raise ValueError('HOOK_CALLBACK_FIELD_INVALID')
                image.set(key.lower(), str(value))
        item = {**body, 'content': '<msg>' + ET.tostring(image, encoding='unicode') + '</msg>'}
        result = _own_message(item, own_wxid, kind=3, now=now)
        return [result] if result is not None else []
    if 'msgType' in body and 'fromUserName' in body:
        return _incoming(body, own_wxid)
    return []


def _ordinary(file):
    return not file.is_symlink() and not (getattr(file.lstat(), 'st_file_attributes', 0) & 0x400)


def _ordinary_parents(file):
    for parent in [file.parent, *file.parent.parents]:
        if parent.exists() and (not _ordinary(parent) or not parent.is_dir()):
            raise RuntimeError('HOOK_EVENT_STORE_INVALID')


class SupplierEventStore:
    """Atomic bounded cache plus inbox; retained dispatched events never replay."""
    def __init__(self, file, max_messages=5000, max_bytes=MAX_STORE_BYTES):
        self.file = pathlib.Path(os.path.abspath(file))
        self.max_messages, self.max_bytes = max_messages, max_bytes
        self.lock = threading.RLock()
        self.entries = {}
        self.closed = False
        if type(max_messages) is not int or not 1 <= max_messages <= 10000 or type(max_bytes) is not int or not 1024 <= max_bytes <= 64 * 1024 * 1024:
            raise ValueError('HOOK_EVENT_STORE_LIMIT_INVALID')
        _ordinary_parents(self.file)
        if self.file.exists() or self.file.is_symlink():
            if not _ordinary(self.file) or not self.file.is_file() or self.file.stat().st_size > max_bytes:
                raise RuntimeError('HOOK_EVENT_STORE_INVALID')
            try:
                value = json.loads(self.file.read_text(encoding='utf-8-sig'))
            except (ValueError, OSError):
                raise RuntimeError('HOOK_EVENT_STORE_INVALID') from None
            if not isinstance(value, dict) or value.get('version') != 1 or not isinstance(value.get('entries'), list) or len(value['entries']) > max_messages:
                raise RuntimeError('HOOK_EVENT_STORE_INVALID')
            for entry in value['entries']:
                self._validate(entry)
                key = self._key(entry['talker'], entry['row'])
                if key in self.entries:
                    raise RuntimeError('HOOK_EVENT_STORE_INVALID')
                self.entries[key] = entry

    def _key(self, talker, row):
        if row['serverId'] != '0':
            return 'server:' + talker + ':' + row['serverId']
        if row.get('clientId'):
            return 'client:' + talker + ':' + row['clientId'] + ':' + str(row['localType'])
        return 'local:' + talker + ':' + str(row['localId']) + ':' + str(row['createTime'])

    def _validate(self, entry):
        row = entry.get('row') if isinstance(entry, dict) else None
        if (not isinstance(row, dict) or not isinstance(entry.get('talker'), str)
                or not IDENTIFIER.fullmatch(entry['talker'])
                or type(entry.get('dispatched')) is not bool or not isinstance(row.get('rawid'), str)
                or not RAW_ID.fullmatch(row['rawid'])
                or type(row.get('localId')) is not int or row['localId'] < 0
                or not isinstance(row.get('serverId'), str) or not re.fullmatch(r'[0-9]{1,20}', row['serverId'])
                or int(row['serverId']) > 18446744073709551615 or str(int(row['serverId'])) != row['serverId']
                or row['localId'] > 18446744073709551615
                or type(row.get('createTime')) is not int or not 0 < row['createTime'] <= 4102444800
                or type(row.get('localType')) is not int or not 0 <= row['localType'] <= 18446744073709551615
                or type(row.get('isSend')) is not int or row['isSend'] not in (0, 1)
                or not isinstance(row.get('fullText'), str) or len(row['fullText'].encode('utf-8')) > MAX_CONTENT_BYTES
                or '\0' in row['fullText'] or not isinstance(row.get('senderUsername'), str)
                or not IDENTIFIER.fullmatch(row['senderUsername'])
                or not isinstance(row.get('clientId', ''), str) or len(row.get('clientId', '').encode('utf-8')) > 512
                or '\0' in row.get('clientId', '')):
            raise RuntimeError('HOOK_EVENT_STORE_INVALID')
        if row['rawid'] != _raw_id(entry['talker'], row):
            raise RuntimeError('HOOK_EVENT_STORE_INVALID')

    def _encoded(self, entries):
        return (json.dumps({'version': 1, 'entries': list(entries.values())}, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')

    def _commit(self, entries, retain=None):
        if self.closed:
            raise RuntimeError('HOOK_EVENT_STORE_CLOSED')
        content = self._encoded(entries)
        while len(entries) > self.max_messages or len(content) > self.max_bytes:
            disposable = next((key for key, entry in entries.items() if entry['dispatched'] and key != retain), None)
            if disposable is None:
                raise RuntimeError('HOOK_CALLBACK_BACKPRESSURE')
            entries.pop(disposable)
            content = self._encoded(entries)
        _ordinary_parents(self.file)
        self.file.parent.mkdir(parents=True, exist_ok=True)
        _ordinary_parents(self.file)
        if self.file.exists() and not _ordinary(self.file):
            raise RuntimeError('HOOK_EVENT_STORE_INVALID')
        descriptor, temporary = tempfile.mkstemp(prefix=self.file.name + '.', suffix='.tmp', dir=self.file.parent)
        try:
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.file)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        self.entries = entries

    def add(self, talker, row):
        entry = {'talker': talker, 'row': copy.deepcopy(row), 'dispatched': bool(row.get('isSend'))}
        self._validate(entry)
        key = self._key(talker, row)
        with self.lock:
            if self.closed:
                raise RuntimeError('HOOK_EVENT_STORE_CLOSED')
            if key in self.entries:
                return False
            entries = dict(self.entries)
            entries[key] = entry
            self._commit(entries, retain=key)
            return True

    def messages(self, talker, limit=100, from_time=None):
        with self.lock:
            result = [copy.deepcopy(entry['row']) for entry in self.entries.values()
                      if entry['talker'] == talker and (from_time is None or entry['row']['createTime'] >= from_time)]
        result.sort(key=lambda row: (row['createTime'], row['localId'], row['serverId']), reverse=True)
        return result[:limit] if limit else result

    def exact(self, talker, identity):
        matches = [row for row in self.messages(talker, limit=0)
                   if str(row['localId']) == str(identity.get('localId'))
                   and row['serverId'] == str(identity.get('serverId'))
                   and row['createTime'] == identity.get('createTime')]
        return matches[0] if len(matches) == 1 else None

    def bound(self, talker, server_id):
        if not re.fullmatch(r'[1-9][0-9]{0,19}', str(server_id)):
            return None
        with self.lock:
            entry = self.entries.get('server:' + talker + ':' + str(server_id))
            return copy.deepcopy(entry['row']) if entry else None

    def pending(self):
        with self.lock:
            return [(entry['talker'], copy.deepcopy(entry['row'])) for entry in self.entries.values()
                    if not entry['dispatched']]

    def mark_dispatched(self, rawid):
        with self.lock:
            if self.closed:
                raise RuntimeError('HOOK_EVENT_STORE_CLOSED')
            key = next((key for key, entry in self.entries.items() if entry['row']['rawid'] == rawid), None)
            if key is None or self.entries[key]['dispatched']:
                return False
            entries = dict(self.entries)
            entries[key] = {**entries[key], 'dispatched': True}
            self._commit(entries)
            return True

    def close(self):
        with self.lock:
            self.closed = True
