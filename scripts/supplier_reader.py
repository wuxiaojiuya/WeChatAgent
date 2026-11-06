"""Supplier-backed message reader, media resolver and authenticated gateway."""
import base64
import hashlib
import hmac
import json
import pathlib
import re
import os
import tempfile
import threading
import time
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from supplier_api import SupplierApi, RemoteConnection, BACKEND, VERSION, read_json, origin, runtime_directory
from wechat_files import FileCatalog, file_policy, media_file_policy, hashes, MAX_FILE_BYTES, safe_file_name
from wechat_voice_input import MAX_SILK_BYTES
from wechat_image_normalize import normalize_image
from wechat_sticker import resolve_sticker
from wechat_video import MAX_VIDEO_BYTES
from supplier_images import download_image


def xml_root(text):
    if not isinstance(text, str) or len(text) > 2 * 1024 * 1024 or re.search(r'<!DOCTYPE|<!ENTITY', text, re.I):
        raise ValueError('HOOK_MEDIA_XML_INVALID')
    return ET.fromstring(text)


def source_file(file, maximum):
    file = pathlib.Path(file)
    if not file.is_absolute() or file.is_symlink() or not file.is_file() or not 0 < file.stat().st_size <= maximum or getattr(file.lstat(), 'st_file_attributes', 0) & 0x400:
        raise ValueError('HOOK_MEDIA_FILE_INVALID')
    return file


class SupplierFiles(FileCatalog):
    def __init__(self, reader, **options):
        self.reader = reader
        super().__init__(reader.root, reader.account, reader.sticker_account_active, **options)

    def resolve(self, file_id, key, sender):
        reader = self.reader
        record = dict(self.records.get(file_id, {}))
        if not re.fullmatch(r'[a-f0-9]{64}', file_id or '') or not self.active() or record.get('account') != str(self.account) or record.get('conversationKey') != key or record.get('senderWxid') != sender or not self.policy(read_json(reader.root/'config/wechatagent.json'), key, sender):
            raise PermissionError('FILE_REFERENCE_NOT_ALLOWED')
        talker = record.get('talker')
        row = reader.exact_message(talker, record)
        app = xml_root(row['fullText']).find('appmsg')
        if app is None or app.findtext('type') != '6' or app.findtext('title') != record['name'] or not safe_file_name(record['name']):
            raise RuntimeError('FILE_MESSAGE_IDENTITY_NOT_FOUND')
        attach = app.findtext('appattach/attachid', '')
        if not attach or not 0 < record['size'] <= MAX_FILE_BYTES:
            raise RuntimeError('FILE_DOWNLOAD_METADATA_MISSING')
        folder = reader.account/'msg/file'/file_id
        folder.mkdir(parents=True, exist_ok=True)
        file = folder/record['name']
        if not file.exists():
            reader.api.post('/api/download_file', {'from_user': talker, 'total_len': str(record['size']), 'MsgId': int(record['serverId']), 'path': str(file), 'attachid': attach, 'type': '6'})
        # A 200 response is not proof the async download has completed.
        if not file.is_file() or file.stat().st_size != record['size']:
            return {'status': 'not_downloaded', 'id': file_id, 'message': 'Hook 正在下载文件，完成后可重试读取。'}
        source_file(file, MAX_FILE_BYTES)
        md5, sha = hashes(file)
        if record.get('md5') and md5 != record['md5']:
            raise RuntimeError('FILE_INTEGRITY_FAILED')
        if not self.active() or not self.policy(read_json(reader.root/'config/wechatagent.json'), key, sender):
            raise PermissionError('FILE_REFERENCE_NOT_ALLOWED')
        return {'status': 'ready', 'id': file_id, 'conversationKey': key, 'senderWxid': sender, 'name': record['name'], 'size': record['size'], 'path': str(file), 'accountRoot': str(self.account), 'md5': md5, 'sha256': sha}


def create_reader(Base):
    class SupplierReader(Base):
        backend = BACKEND

        def initialize_source(self, settings):
            if settings.get('backend') != BACKEND:
                raise RuntimeError('HOOK_ACCOUNT_BIND_REQUIRED')
            self.api = SupplierApi(self.root)
            self.own_wxid = settings['myWxid']
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', self.own_wxid):
                raise RuntimeError('HOOK_ACCOUNT_METADATA_INVALID')
            self.account = (self.root/'state/hook/accounts'/self.own_wxid).resolve()
            if pathlib.Path(settings['dbPath']).resolve() != self.account.parent:
                raise RuntimeError('HOOK_ACCOUNT_METADATA_INVALID')
            self.account.mkdir(parents=True, exist_ok=True)
            self.passphrase = ''  # No captured database credentials in this backend.
            self.api.identity(self.own_wxid)
            callback_file = self.account/'callbacks.json'
            self.callback_messages = read_json(callback_file) if callback_file.is_file() and callback_file.stat().st_size < 1024*1024 else {}
            self.callback_lock = threading.Lock()
            self.api_names, self.api_names_time = [], 0

        def __init__(self, root):
            super().__init__(root)
            self.files = SupplierFiles(self)
            self.quoted_files = SupplierFiles(self, policy=media_file_policy, index_name='quoted.json')

        def start_native_gateway(self):
            self.gateway = start_gateway(self)

        def active_identity(self):
            current = read_json(self.settings_file)
            if current.get('backend') != BACKEND or current.get('myWxid') != self.own_wxid:
                raise RuntimeError('HOOK_ACCOUNT_MISMATCH')
            hook = read_json(self.root/'config/wechatagent.json')['hook']
            if any(hook.get(key) != self.api.hook.get(key) for key in ('backend', 'baseUrl', 'upstreamUrl', 'expectedVersion', 'wechatExecutable', 'sourceDirectory')):
                raise RuntimeError('HOOK_SETTINGS_CHANGED')
            return self.api.identity(self.own_wxid)

        def sticker_account_active(self):
            try:
                self.active_identity()
                return True
            except (RuntimeError, OSError, ValueError, KeyError):
                return False

        def database_names(self):
            if time.monotonic() - self.api_names_time > 5:
                self.api_names = self.api.databases()
                self.api_names_time = time.monotonic()
            return self.api_names

        def refresh_names(self, max_age=0):
            with self.names_lock:
                if max_age and time.monotonic() - self.names_refreshed_at < max_age:
                    return
                self.active_identity()
                connection = RemoteConnection(self.api, 'contact.db')
                rows = connection.execute("SELECT username, COALESCE(NULLIF(remark,''), NULLIF(nick_name,''), NULLIF(alias,''), username) FROM contact").fetchall()
                names = {u: n for u, n in rows if isinstance(u, str) and isinstance(n, str)}
                if not names:
                    raise RuntimeError('HOOK_CONTACTS_UNAVAILABLE')
                session_names = self.group_session_names()
                names = {**session_names, **names}
                for u, n in session_names.items():
                    if names[u] == u:
                        names[u] = n
                self.group_bindings.reconcile(names, read_json(self.root/'config/wechatagent.json')['wechat']['whitelist']['groups'], self.legacy_group_hints([]), {u: [n] for u, n in session_names.items() if n != u})
                self.names, self.names_refreshed_at = names, time.monotonic()

        def group_session_names(self):
            result = {}
            if 'session.db' not in self.database_names():
                return result
            conn = RemoteConnection(self.api, 'session.db')
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if 'SessionTable' in tables:
                result.update({u: u for (u,) in conn.execute("SELECT username FROM SessionTable WHERE username LIKE '%@chatroom' LIMIT 10000")})
            if 'SessionNoContactInfoTable' in tables:
                result.update({u: n for u, n in conn.execute("SELECT username,session_title FROM SessionNoContactInfoTable WHERE username LIKE '%@chatroom' LIMIT 10000") if isinstance(n, str) and n})
            return result

        def open_messages(self):
            self.active_identity()
            names = sorted(n for n in self.database_names() if re.fullmatch(r'message_\d+\.db', n))
            if not names or len(names) > 64:
                raise RuntimeError('HOOK_MESSAGE_DATABASES_UNAVAILABLE')
            return [RemoteConnection(self.api, n) for n in names]

        def exact_message(self, talker, identity):
            if not talker or not self.image_talker_allowed(talker):
                raise PermissionError('CONVERSATION_NOT_ALLOWED')
            # Reuse scoped history parsing and exact row identity; no fuzzy media lookup.
            matches = [row for row in self.messages(talker, limit=0, from_time=int(identity['createTime'])) if str(row['localId']) == str(identity['localId']) and str(row['serverId']) == str(identity['serverId']) and row['createTime'] == identity['createTime']]
            if len(matches) != 1:
                raise RuntimeError('HOOK_MESSAGE_IDENTITY_NOT_FOUND')
            return matches[0]

        def make_payload(self, talker, message):
            payload = super().make_payload(talker, message)
            if payload and payload.get('file'):
                payload['file'].update(talker=talker, localId=message['localId'], serverId=message['serverId'], createTime=message['createTime'])
            return payload

        def voice_blob(self, record):
            self.active_identity()
            # Remote SQL is also the supplied Hook API. Hex preserves the SILK BLOB.
            blobs = {}
            for name in self.database_names():
                if not re.fullmatch(r'media_\d+\.db', name):
                    continue
                rows = RemoteConnection(self.api, name).execute('SELECT v.voice_data FROM VoiceInfo v JOIN Name2Id n ON n.rowid=v.chat_name_id WHERE n.user_name=? AND v.local_id=? AND length(v.voice_data) BETWEEN 1 AND ? LIMIT 2', (record['talker'], record['localId'], MAX_SILK_BYTES))
                for (blob,) in rows:
                    if not blob.startswith((b'#!SILK_V3', b'\x02#!SILK_V3')):
                        raise RuntimeError('VOICE_FORMAT_UNSUPPORTED')
                    blobs[hashlib.sha256(blob).hexdigest()] = blob
            if len(blobs) != 1:
                raise RuntimeError('VOICE_AUDIO_NOT_AVAILABLE' if not blobs else 'VOICE_AUDIO_AMBIGUOUS')
            return next(iter(blobs.values()))

        def resolve_image(self, image_id):
            descriptor = self.image_index.get(image_id)
            if descriptor and descriptor.get('videoId'):
                return self.resolve_video_frame(image_id, descriptor)
            # Imported/collected sticker previews use the shared verified image pool.
            if not descriptor:
                for store in (getattr(self, 'meme_send_resources', None), getattr(self, 'sticker_collection', None)):
                    if store:
                        preview = store.preview(image_id)
                        if preview:
                            return preview
                raise PermissionError('IMAGE_REFERENCE_NOT_ALLOWED')
            self.active_identity()
            if descriptor.get('account') != self.account.name or not self.image_talker_allowed(descriptor['talker']):
                raise PermissionError('IMAGE_REFERENCE_NOT_ALLOWED')
            row = self.image_row(descriptor['talker'], descriptor)
            media = read_json(self.root/'config/wechatagent.json').get('wechat', {}).get('media', {})
            if row['localType'] == 47:
                result = resolve_sticker(self.account, row['imageXml'], normalize_image, allow_cdn=media.get('allowStickerCdn') is True, allow_cdn_alias=media.get('allowStickerCdnAlias') is True)
            else:
                node = xml_root(row['imageXml']).find('img')
                result = download_image(self, image_id, descriptor, node)
            self.active_identity()
            if not self.image_talker_allowed(descriptor['talker']):
                raise PermissionError('IMAGE_REFERENCE_NOT_ALLOWED')
            return {**result, 'imageId': image_id, 'conversationKey': 'wechat:'+('group:' if '@chatroom' in descriptor['talker'] else 'private:')+self.conversation_id(descriptor['talker'])}

        def video_source(self, video_id, item, row):
            self.active_identity()
            folder = runtime_directory(self.root)/'incoming-video'
            folder.mkdir(parents=True, exist_ok=True)
            file = folder/(video_id+'.mp4')
            if not file.exists():
                with self.callback_lock:
                    callback = self.callback_messages.get(item['serverId'], {})
                msg_id = callback.get('msgId')
                if callback.get('type') != 43 or callback.get('from') != item['talker'] or callback.get('to') != self.own_wxid or not isinstance(msg_id,int) or not 0 < msg_id <= 0xffffffff:
                    raise RuntimeError('VIDEO_CALLBACK_METADATA_REQUIRED')
                self.api.post('/api/download_video', {'total_len':item['size'], 'NewMsgId':int(item['serverId']), 'MsgId':msg_id, 'path':str(file)})
            deadline = time.monotonic()+8
            while not file.is_file() or file.stat().st_size != item['size']:
                if time.monotonic() >= deadline:
                    raise RuntimeError('VIDEO_DOWNLOAD_PENDING')
                time.sleep(.2)
            source_file(file, MAX_VIDEO_BYTES)
            if item['md5'] and hashes(file)[0] != item['md5']:
                raise RuntimeError('VIDEO_INTEGRITY_FAILED')
            self.active_identity()
            return file

        def pump_sticker_collection(self):
            # Shared pool still learns message-bound stickers through register_image.
            # No legacy local database scanner runs for this provider.
            pass

    return SupplierReader


def start_gateway(reader):
    config = read_json(reader.root/'config/wechatagent.json')
    port = urlsplit(origin(config['hook']['baseUrl'])).port
    token = (reader.root/'state/hook/native-token.txt').read_text(encoding='utf-8-sig').strip()
    if not re.fullmatch(r'[a-f0-9]{64}', token):
        raise RuntimeError('HOOK_TOKEN_MISSING')

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # Never log the secret callback path or message bodies.

        def reply(self, data, status=200):
            body = json.dumps(data, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self.handle_request()

        def do_POST(self):
            self.handle_request()

        def do_PUT(self):
            self.handle_request()

        def handle_request(self):
            try:
                if self.command in ('POST', 'PUT') and self.path == '/api/recvMsg/'+token:
                    length = int(self.headers.get('Content-Length', '0'))
                    if not 0 < length <= 2*1024*1024:
                        raise ValueError('HOOK_CALLBACK_INVALID')
                    body = json.loads(self.rfile.read(length))
                    self.accept_callback(body)
                    return self.reply({'code': 1})
                if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer '+token):
                    return self.reply({'error': 'HOOK_AUTH_FAILED'}, 401)
                identity = reader.active_identity()
                if self.command == 'GET' and self.path in ('/WeChatAgent/health', '/health'):
                    health = {'integration': 'WeChatAgent-supplier-v1', 'backend': 'wechat-voice' if self.path == '/health' else 'wechat-hook', 'provider': BACKEND, 'version': VERSION, 'pid': identity['pid'], 'databaseAccounts': [identity['wxid']], 'startupState': 'ready', 'ready': True, 'nativeTextSend': True, 'nativeStickerSend': True, 'nativeFileSend': True, 'nativeVoiceSend': True}
                    return self.reply(health)
                if self.command != 'POST':
                    return self.reply({'error': 'HOOK_ROUTE_NOT_FOUND'}, 404)
                if self.headers.get('X-WeChatAgent-Account', '').lower() != identity['wxid'].lower():
                    return self.reply({'error': 'HOOK_ACCOUNT_MISMATCH'}, 409)
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 128*1024:
                    raise ValueError('HOOK_REQUEST_INVALID')
                body = json.loads(self.rfile.read(length))
                target = body.get('wxidorgid')
                if not isinstance(target, str) or target == reader.own_wxid or target not in reader.selected_talkers():
                    return self.reply({'error': 'HOOK_TARGET_NOT_ALLOWED'}, 403)
                route, mapped = map_send(self.path, body)
                if self.path != '/SendTextMsg':
                    field = 'silkPath' if self.path == '/SendVoiceMsg' else 'filepath'
                    mapped[field] = str(stage_media(reader.root, pathlib.Path(mapped[field])))
                # Do not retry upstream sends, even on network timeout.
                result = reader.api.post(route, mapped)
                # Keep the last acknowledgement locally for diagnosis, never
                # expose it in public status or log the submitted message body.
                diagnostic = reader.root/'state/hook/last-submit-response.json'
                diagnostic.write_text(json.dumps({'route': route, 'at': time.time(), 'response': result}, ensure_ascii=False), encoding='utf-8')
                return self.reply(normalize_send_response(self.path, result, identity['wxid'], target, body.get('duration'), pathlib.Path(mapped['silkPath']).stat().st_size if self.path == '/SendVoiceMsg' else None))
            except PermissionError:
                self.reply({'error': 'HOOK_SCOPE_DENIED'}, 403)
            except (ValueError, KeyError, TypeError):
                self.reply({'error': 'HOOK_REQUEST_INVALID'}, 400)
            except Exception as error:
                code = str(error) if re.fullmatch(r'[A-Z][A-Z0-9_]{2,79}', str(error)) else 'HOOK_GATEWAY_UNAVAILABLE'
                self.reply({'error': code}, 503)

        def accept_callback(self, body):
            if not isinstance(body, dict):
                raise ValueError('HOOK_CALLBACK_INVALID')
            identity = reader.active_identity()
            own = identity['wxid']
            sender, recipient = body.get('fromUserName', {}), body.get('toUserName', {})
            sender = sender.get('String') if isinstance(sender, dict) else sender
            recipient = recipient.get('String') if isinstance(recipient, dict) else recipient
            server_id = body.get('newMsgId')
            if body.get('msgType') not in (3,43) or recipient != own or not isinstance(sender, str) or sender not in reader.selected_talkers() or not isinstance(server_id, str) or not re.fullmatch(r'[1-9]\d{0,19}', server_id):
                return
            # Only supplemental download metadata; never pushes callback contents
            # or marks outgoing messages confirmed without exact database rows.
            with reader.callback_lock:
                reader.callback_messages[server_id] = {'msgId': body.get('msgId'), 'from': sender, 'to': recipient, 'type':body.get('msgType')}
                while len(reader.callback_messages) > 5000:
                    reader.callback_messages.pop(next(iter(reader.callback_messages)))
                file = reader.account/'callbacks.json'
                temporary = file.with_suffix('.tmp')
                temporary.write_text(json.dumps(reader.callback_messages),encoding='utf-8')
                temporary.replace(file)

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def stage_media(root, source):
    """The delivered DLL opens narrow Windows paths: provide an ASCII copy."""
    data = source.read_bytes()
    directory = runtime_directory(root)/'media'
    directory.mkdir(parents=True, exist_ok=True)
    suffix = source.suffix.lower()
    if not re.fullmatch(r'\.[a-z0-9]{1,10}', suffix):
        suffix = '.bin'
    target = directory/(hashlib.sha256(data).hexdigest()+suffix)
    if target.exists():
        if target.is_symlink() or target.read_bytes() != data:
            raise RuntimeError('HOOK_MEDIA_COPY_MISMATCH')
        return target
    descriptor, temporary = tempfile.mkstemp(dir=directory, suffix='.tmp')
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return target


def map_send(route, body):
    target = body['wxidorgid']
    if route == '/SendTextMsg':
        if not isinstance(body.get('msg'), str) or not body['msg'].strip() or len(body['msg'].encode()) > 16000:
            raise ValueError('HOOK_TEXT_INVALID')
        return '/api/send_text_msg', {'wxid': target, 'msg': body['msg']}
    mapping = {'/SendFileMsg': ('/api/send_file_msg', 'filepath', 50*1024*1024), '/SendStickerMsg': ('/api/send_emotion_msg', 'filepath', 8*1024*1024), '/SendVoiceMsg': ('/api/send_voice', 'silkPath', 2*1024*1024)}
    if route not in mapping:
        raise ValueError('HOOK_ROUTE_UNSUPPORTED')
    upstream, key, maximum = mapping[route]
    file = source_file(body['path'], maximum)
    if route == '/SendFileMsg' and (file.stat().st_size != body.get('size') or hashes(file)[0] != body.get('md5')):
        raise ValueError('HOOK_FILE_INTEGRITY_FAILED')
    if route == '/SendVoiceMsg':
        if not 1 <= body.get('duration', 0) <= 60000 or not file.read_bytes().startswith((b'#!SILK_V3', b'\x02#!SILK_V3')):
            raise ValueError('HOOK_VOICE_INVALID')
    if route == '/SendStickerMsg' and not file.read_bytes().startswith((b'GIF87a', b'GIF89a')):
        raise ValueError('HOOK_STICKER_INVALID')
    return upstream, {**({'wxid': target, 'toWxid': target} if route == '/SendVoiceMsg' else {'wxid': target}), key: str(file)}


def normalize_send_response(route, result, account=None, target=None, duration=None, size=None):
    if not isinstance(result, dict):
        raise RuntimeError('HOOK_SEND_RESPONSE_UNKNOWN')
    # A generic code=1 only acknowledges submission, never delivery.
    if result.get('code') == 1:
        return {'ret': 0, 'submitted': True, 'confirmed': False}
    if (route == '/SendVoiceMsg' and account and target and result.get('baseResponse', {}).get('ret') == 0
            and result.get('endFlag') == 2 and result.get('cancelFlag') == 0
            and result.get('fromUserName') == account and result.get('toUserName') == target
            and isinstance(result.get('newMsgId'), str) and re.fullmatch(r'[1-9]\d{0,19}', result['newMsgId'])
            and isinstance(duration, int) and isinstance(size, int)
            and result.get('voiceLength') == int(size / (1.8 * 1024)) * 1000
            and isinstance(size, int) and isinstance(result.get('offset'), int) and isinstance(result.get('length'), int)
            and result['offset'] >= 0 and result['length'] > 0 and result['offset'] + result['length'] == size):
        # This build uploads successfully without inserting a local SQL/UI row.
        # Only a final, account/target/duration/byte-count-bound server ACK counts.
        # Its duration is hardcoded floor(fileBytes / (1.8*1024))*1000 (RVA
        # 209461..209480), not SILK frame duration. Retain both, do not stretch
        # or damage the audio to fit this metadata estimate.
        return {'ret': 0, 'submitted': True, 'confirmed': True, 'receipt': 'wechat-uploadvoice-response',
                'serverId': result['newMsgId'], 'account': account, 'target': target, 'durationMs': duration,
                'reportedDurationMs': result['voiceLength']}
    if route == '/SendVoiceMsg' and (result.get('baseResponse', {}).get('ret') == 0 or result.get('baseResponse', {}).get('ret') == -2 and result.get('endFlag') == 1):
        # ret=-2/endFlag=1 is an intermediate packet; wait for the SQL receipt.
        return {'ret': 0, 'submitted': True, 'confirmed': False}
    if route == '/SendVoiceMsg' and result.get('baseResponse', {}).get('ret') == -2:
        raise RuntimeError('HOOK_SEND_RESPONSE_UNKNOWN')
    if 'code' in result or isinstance(result.get('baseResponse', {}).get('ret'), int):
        return {'ret': -1, 'submitted': False, 'confirmed': False}
    raise RuntimeError('HOOK_SEND_RESPONSE_UNKNOWN')
