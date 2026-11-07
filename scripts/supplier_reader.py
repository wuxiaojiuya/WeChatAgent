"""Supplier-backed message reader, media resolver and authenticated gateway."""
import base64
import hashlib
import hmac
import io
import json
import pathlib
import re
import os
import tempfile
import threading
import time
import queue
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from supplier_api import SupplierApi, BACKEND, VERSION, VOICE_UPLOAD_TIMEOUT_SECONDS, IMAGE_UPLOAD_TIMEOUT_SECONDS, read_json, origin, runtime_directory
from supplier_contacts import load_contacts, load_groups, load_members
from supplier_events import SupplierEventStore, normalize_callbacks
from supplier_actions import map_supplier_action
from supplier_social_gateway import SupplierSocialGateway, SOCIAL_ROUTES
from wechat_files import FileCatalog, file_policy, media_file_policy, hashes, MAX_FILE_BYTES, safe_file_name
from wechat_voice_input import MAX_SILK_BYTES
from wechat_image_normalize import normalize_image
from wechat_sticker import resolve_sticker
from supplier_images import download_image
from supplier_videos import download_video
from wechat_sticker import sticker_image_xml


_voice_diagnostic_lock = threading.Lock()


def record_voice_submission(root, *, at, elapsed_ms, result, outcome, error=None):
    """Keep bounded stage evidence, never raw responses or message identities."""
    response = {'hasServerId': False}
    if isinstance(result, dict):
        base = result.get('baseResponse')
        if isinstance(base, dict) and type(base.get('ret')) is int:
            response['ret'] = base['ret']
        for key in ('code', 'errCode', 'endFlag', 'cancelFlag', 'offset', 'length', 'voiceLength'):
            if type(result.get(key)) is int:
                response[key] = result[key]
        response['hasServerId'] = isinstance(result.get('newMsgId'), str) and bool(re.fullmatch(r'[1-9]\d{0,19}', result['newMsgId']))
    record = {'at': at, 'elapsedMs': elapsed_ms, 'route': '/api/send_voice', 'outcome': outcome, 'response': response}
    if error is not None:
        code = str(error)
        record['error'] = code if re.fullmatch(r'[A-Z][A-Z0-9_]{2,79}', code) else 'HOOK_GATEWAY_UNAVAILABLE'
    # Failure to write diagnostics must not change or repeat the send operation.
    try:
        with _voice_diagnostic_lock:
            directory = pathlib.Path(root)/'state/hook/voice-submissions'
            directory.mkdir(parents=True, exist_ok=True)
            files = sorted((file for file in directory.glob('*.json') if re.fullmatch(r'\d{13,}-[a-z0-9_]+\.json', file.name)),
                           key=lambda file: int(file.name.split('-')[0]))
            # Windows clocks can repeat a tick; random suffixes must not decide
            # which recent submission is discarded, even after a clock rollback.
            sequence = max(time.time_ns(), int(files[-1].name.split('-')[0])+1 if files else 0)
            descriptor, temporary = tempfile.mkstemp(dir=directory, prefix=str(sequence)+'-', suffix='.tmp')
            try:
                with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
                    json.dump(record, stream)
                os.replace(temporary, pathlib.Path(temporary).with_suffix('.json'))
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
            for file in files[:-29]:
                file.unlink()
    except (OSError, ValueError, TypeError):
        pass


def submit_voice(reader, mapped, account, target, duration):
    at, started = time.time(), time.monotonic()
    result, outcome, error = None, 'error', None
    try:
        size = pathlib.Path(mapped['silkPath']).stat().st_size
        # This is a single upload request, with a separate budget from reads.
        result = reader.api.post('/api/send_voice', mapped, timeout=VOICE_UPLOAD_TIMEOUT_SECONDS)
        response = normalize_send_response('/SendVoiceMsg', result, account, target, duration, size)
        outcome = 'confirmed' if response.get('confirmed') else 'submitted' if response.get('submitted') else 'rejected'
        return response
    except Exception as caught:
        error = caught
        raise
    finally:
        record_voice_submission(reader.root, at=at, elapsed_ms=max(0, round((time.monotonic()-started)*1000)), result=result, outcome=outcome, error=error)


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
        folder = runtime_directory(reader.root)/'incoming-files'
        folder.mkdir(parents=True, exist_ok=True)
        suffix = pathlib.Path(record['name']).suffix.lower()
        file = folder/(file_id+(suffix if re.fullmatch(r'\.[a-z0-9]{1,10}', suffix) else '.bin'))
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
            # Connection setup already captured metadata for every downstream
            # cache. Do not silently switch only the reader's namespace here.
            self.startup_identity = {'wxid': self.own_wxid, **self.api.component_identity()}
            callback_file = self.account/'callbacks.json'
            self.callback_messages = read_json(callback_file) if callback_file.is_file() and callback_file.stat().st_size < 1024*1024 else {}
            self.callback_lock = threading.Lock()
            self.events = SupplierEventStore(self.account/'events.json')
            with self.events.lock:
                for entry in self.events.entries.values():
                    row = entry['row']
                    if row['serverId'] != '0' and isinstance(row.get('callback'), dict):
                        self.callback_messages[row['serverId']] = row['callback']
            self.callback_wake = threading.Event()
            self.member_cache, self.member_lock = {}, threading.Lock()

        def __init__(self, root):
            super().__init__(root)
            self.files = SupplierFiles(self)
            self.quoted_files = SupplierFiles(self, policy=media_file_policy, index_name='quoted.json')

        def start_native_gateway(self):
            self.gateway = start_gateway(self)

        def active_identity(self):
            # The supplier Hook has one login. Its connection metadata is used for
            # message direction/cache keys, not a repeated login-account gate.
            hook = read_json(self.root/'config/wechatagent.json')['hook']
            if any(hook.get(key) != self.api.hook.get(key) for key in ('backend', 'baseUrl', 'upstreamUrl', 'expectedVersion', 'wechatExecutable', 'sourceDirectory')):
                raise RuntimeError('HOOK_SETTINGS_CHANGED')
            return dict(self.startup_identity)

        def sticker_account_active(self):
            try:
                self.active_identity()
                return True
            except (RuntimeError, OSError, ValueError, KeyError):
                return False

        def refresh_names(self, max_age=0):
            with self.names_lock:
                if max_age and time.monotonic() - self.names_refreshed_at < max_age:
                    return
                self.active_identity()
                names, friends, catalog_error = load_contacts(self.api, self.own_wxid)
                session_names = self.group_session_names()
                names = {**session_names, **names}
                for u, n in session_names.items():
                    if names[u] == u:
                        names[u] = n
                self.group_bindings.reconcile(names, read_json(self.root/'config/wechatagent.json')['wechat']['whitelist']['groups'], self.legacy_group_hints([]), {u: [n] for u, n in session_names.items() if n != u})
                self.names, self.names_refreshed_at = names, time.monotonic()
                self.friend_contacts, self.contact_catalog_error = friends, catalog_error

        def group_session_names(self):
            return load_groups(self.api)

        def group_members(self, talker):
            if not talker.endswith('@chatroom') or not self.image_talker_allowed(talker):
                raise PermissionError('CONVERSATION_NOT_ALLOWED')
            with self.member_lock:
                cached = self.member_cache.get(talker)
                if cached and time.monotonic()-cached[0] < 30:
                    return [dict(item) for item in cached[1]]
                members = load_members(self.api, talker)
                self.member_cache[talker] = (time.monotonic(), members)
                return [dict(item) for item in members]

        def open_messages(self):
            # Compatibility with the shared HTTP server. Supplier reception is
            # callback-only and never opens a WeChat database or asks for handles.
            return []

        def messages(self, talker, limit=100, from_time=None):
            if talker not in self.selected_talkers():
                raise PermissionError('CONVERSATION_NOT_ALLOWED')
            return self.events.messages(talker, limit=limit, from_time=from_time)

        def exact_message(self, talker, identity):
            if not talker or not self.image_talker_allowed(talker):
                raise PermissionError('CONVERSATION_NOT_ALLOWED')
            row = self.events.exact(talker, identity)
            if not row:
                raise RuntimeError('HOOK_MESSAGE_IDENTITY_NOT_FOUND')
            return row

        def bound_message(self, talker, server_id):
            if not self.image_talker_allowed(talker):
                return None
            return self.events.bound(talker, server_id)

        def quote_reference(self, talker, reply_id):
            if not isinstance(reply_id, str) or not self.image_talker_allowed(talker):
                raise PermissionError('HOOK_QUOTE_REFERENCE_NOT_ALLOWED')
            rows = self.events.messages(talker, limit=0)
            matches = [row for row in rows if (row['rawid'] == reply_id or row['serverId'] == reply_id) and row['serverId'] != '0']
            if len(matches) != 1:
                raise RuntimeError('HOOK_QUOTE_ORIGINAL_NOT_CACHED')
            row = matches[0]
            return {'conversationWxid': talker, 'referContent': row['fullText'],
                    'fromUsr': row['senderUsername'], 'newmsgid': row['serverId'],
                    'createTime': row['createTime'], 'msgSource': row.get('msgSource', '')}

        def image_row(self, talker, descriptor):
            row = self.exact_message(talker, descriptor)
            kind = row['localType']
            if kind == 3:
                text = row['fullText']
            else:
                text = sticker_image_xml(kind, row['fullText'])
            if not text or row['senderUsername'] != descriptor.get('sender'):
                raise RuntimeError('IMAGE_MESSAGE_IDENTITY_NOT_FOUND')
            return {**row, 'localType': 47 if kind != 3 else 3, 'imageXml': text}

        def make_payload(self, talker, message):
            payload = super().make_payload(talker, message)
            if payload:
                payload['rawid'] = message['rawid']
                payload['mentions'] = message.get('mentions', [])
                payload['atUserList'] = message.get('mentions', [])
                payload['mentionedSelf'] = self.own_wxid in message.get('mentions', [])
                if message.get('senderName'):
                    payload['senderName'] = message['senderName']
            if payload and payload.get('file'):
                payload['file'].update(talker=talker, localId=message['localId'], serverId=message['serverId'], createTime=message['createTime'])
            return payload

        def voice_blob(self, record):
            row = self.exact_message(record['talker'], record)
            callback = row.get('callback', {})
            length = callback.get('length')
            if (row['localType'] != 34 or row['senderUsername'] != record['sender']
                    or row['localId'] <= 0 or row['serverId'] == '0'
                    or not isinstance(length, str) or not re.fullmatch(r'[1-9]\d{0,7}', length)
                    or int(length) > MAX_SILK_BYTES):
                raise RuntimeError('VOICE_CALLBACK_METADATA_REQUIRED')
            directory = runtime_directory(self.root)/'incoming-voice'
            directory.mkdir(parents=True, exist_ok=True)
            file = directory/(row['rawid']+'.silk')
            def verified():
                source_file(file, MAX_SILK_BYTES)
                raw = file.read_bytes()
                if len(raw) != int(length):
                    raise OSError('Voice is still downloading')
                if not raw.startswith((b'#!SILK_V3', b'\x02#!SILK_V3')):
                    raise RuntimeError('VOICE_FORMAT_UNSUPPORTED')
                return raw
            if file.exists():
                try:
                    return verified()
                except OSError:
                    pass
            handle, temporary = tempfile.mkstemp(dir=directory, suffix='.silk.part')
            os.close(handle)
            temporary = pathlib.Path(temporary)
            try:
                deadline = time.monotonic()+10
                # Async native download: a transport timeout does not mean it
                # failed, so wait for this one file rather than submit it twice.
                try:
                    self.api.post('/api/download_voice', {'newMsgId': row['serverId'], 'length': length,
                        'MsgId': str(row['localId']), 'path': str(temporary)}, timeout=3)
                except RuntimeError:
                    pass
                while time.monotonic() < deadline:
                    try:
                        source_file(temporary, MAX_SILK_BYTES)
                        raw = temporary.read_bytes()
                        if len(raw) == int(length) and raw.startswith((b'#!SILK_V3', b'\x02#!SILK_V3')):
                            self.verify_voice_message(record)
                            os.replace(temporary, file)
                            return raw
                    except (OSError, ValueError):
                        pass
                    time.sleep(.1)
                raise RuntimeError('VOICE_DOWNLOAD_PENDING')
            finally:
                temporary.unlink(missing_ok=True)

        def verify_voice_message(self, record):
            row = self.exact_message(record['talker'], record)
            if row['localType'] != 34 or row['senderUsername'] != record['sender']:
                raise RuntimeError('VOICE_MESSAGE_IDENTITY_NOT_FOUND')

        def accept_callback(self, body):
            allowed = set(self.selected_talkers())
            count = 0
            for talker, row in normalize_callbacks(body, self.own_wxid):
                if talker not in allowed:
                    continue
                if self.events.add(talker, row):
                    count += 1
                if row['serverId'] != '0':
                    original = self.events.bound(talker, row['serverId'])
                    with self.callback_lock:
                        self.callback_messages[row['serverId']] = original['callback']
                        while len(self.callback_messages) > 5000:
                            self.callback_messages.pop(next(iter(self.callback_messages)))
            if count:
                self.callback_wake.set()
            return count

        def dispatch_pending(self):
            for talker, row in self.events.pending():
                if talker not in self.selected_talkers():
                    self.events.mark_dispatched(row['rawid'])
                    continue
                with self.lock:
                    if not self.clients or any(client.full() for client in self.clients):
                        return
                payload = self.make_payload(talker, row)
                if not payload:
                    self.events.mark_dispatched(row['rawid'])
                    continue
                key = 'wechat:'+('group:' if '@chatroom' in talker else 'private:')+self.conversation_id(talker)
                if payload.get('file'):
                    reference = self.files.remember(payload, key)
                    if not reference:
                        self.events.mark_dispatched(row['rawid'])
                        continue
                    payload['file'] = reference
                if payload['type'] == 34:
                    reference = self.voices.remember(talker, payload, key)
                    if not reference:
                        self.events.mark_dispatched(row['rawid'])
                        continue
                    payload['voice'] = reference
                if payload['type'] in (3, 47):
                    image_id = self.register_image(talker, payload)
                    if not image_id:
                        self.events.mark_dispatched(row['rawid'])
                        continue
                    payload['image'] = {'id': image_id}
                if payload['type'] == 43:
                    video = self.videos.remember(talker, row)
                    if video:
                        payload['video'] = video
                try:
                    self.quote_media(talker, payload)
                except (RuntimeError, ValueError, OSError, PermissionError):
                    pass
                with self.lock:
                    if not self.clients or any(client.full() for client in self.clients):
                        return
                    for client in self.clients:
                        client.put_nowait(payload)
                self.events.mark_dispatched(row['rawid'])
                self.pushed += 1

        def poll(self):
            # Local durable inbox dispatcher. No upstream history/profile/SQL
            # requests run on this idle loop.
            while not self.stop.is_set():
                self.callback_wake.clear()
                try:
                    self.dispatch_pending()
                    self.pump_sticker_collection()
                    self.pump_sticker_pool_review()
                    self.last_poll, self.last_error = time.time(), ''
                except Exception as error:
                    code = str(error)
                    self.last_error = code if re.fullmatch(r'[A-Z][A-Z0-9_]{2,79}', code) else type(error).__name__
                self.callback_wake.wait(.5)

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
            return download_video(self, video_id, item, xml_root(row['fullText']).find('videomsg'))

        def pump_sticker_collection(self):
            # Shared collector resolves registered descriptors via overridden
            # cache-backed image_row; it has no database scanner.
            return super().pump_sticker_collection()

    return SupplierReader


def start_gateway(reader):
    config = read_json(reader.root/'config/wechatagent.json')
    port = urlsplit(origin(config['hook']['baseUrl'])).port
    token = (reader.root/'state/hook/native-token.txt').read_text(encoding='utf-8-sig').strip()
    if not re.fullmatch(r'[a-f0-9]{64}', token):
        raise RuntimeError('HOOK_TOKEN_MISSING')
    management = SupplierSocialGateway(reader, stage_media)

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
                    component = reader.api.component_identity()
                    health = {'integration': 'WeChatAgent-supplier-v1', 'backend': 'wechat-voice' if self.path == '/health' else 'wechat-hook', 'provider': BACKEND, 'version': VERSION, 'pid': component['pid'], 'singleAccount': True, 'accountVerification': 'not-required', 'startupState': 'ready', 'ready': True, 'nativeTextSend': True, 'nativeStickerSend': True, 'nativeFileSend': True, 'nativeVoiceSend': True, 'nativeImageSend': True,
                        'nativeMp3VoiceSend': True, 'nativeAtSend': True, 'nativeQuoteSend': True, 'nativePatSend': True,
                        'messageSource': 'supplier-callback', 'wechatDatabaseAccess': False}
                    return self.reply(health)
                if self.command != 'POST':
                    return self.reply({'error': 'HOOK_ROUTE_NOT_FOUND'}, 404)
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 128*1024:
                    raise ValueError('HOOK_REQUEST_INVALID')
                body = json.loads(self.rfile.read(length))
                if self.path in SOCIAL_ROUTES:
                    return self.reply(management.execute(self.path, body))
                target = body.get('wxidorgid')
                if not isinstance(target, str) or target == reader.own_wxid or target not in reader.selected_talkers():
                    return self.reply({'error': 'HOOK_TARGET_NOT_ALLOWED'}, 403)
                if self.path in ('/SendAtText', '/SendQuoteMsg', '/SendPatMsg', '/SendMp3VoiceMsg'):
                    members = {item['username'] for item in reader.group_members(target)} if target.endswith('@chatroom') and self.path in ('/SendAtText', '/SendPatMsg') else None
                    quote = reader.quote_reference(target, body.get('replyId')) if self.path == '/SendQuoteMsg' else None
                    route, mapped = map_supplier_action(self.path, body, quote=quote, members=members)
                else:
                    route, mapped = map_send(self.path, body)
                if self.path in ('/SendFileMsg', '/SendImageMsg', '/SendStickerMsg', '/SendVoiceMsg', '/SendMp3VoiceMsg'):
                    field = 'silkPath' if self.path == '/SendVoiceMsg' else 'mp3Path' if self.path == '/SendMp3VoiceMsg' else 'filepath'
                    mapped[field] = str(stage_media(reader.root, pathlib.Path(mapped[field])))
                # Do not retry upstream sends, even on network timeout.
                if self.path == '/SendVoiceMsg':
                    return self.reply(submit_voice(reader, mapped, identity['wxid'], target, body.get('duration')))
                if self.path == '/SendImageMsg':
                    result = reader.api.post(route, mapped, timeout=IMAGE_UPLOAD_TIMEOUT_SECONDS)
                    return self.reply(normalize_send_response(self.path, result, identity['wxid'], target))
                result = reader.api.post(route, mapped, timeout=VOICE_UPLOAD_TIMEOUT_SECONDS) if self.path == '/SendMp3VoiceMsg' else reader.api.post(route, mapped)
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
            reader.accept_callback(body)

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
    mapping = {'/SendFileMsg': ('/api/send_file_msg', 'filepath', 50*1024*1024), '/SendImageMsg': ('/api/send_image_msg', 'filepath', 16*1024*1024), '/SendStickerMsg': ('/api/send_emotion_msg', 'filepath', 8*1024*1024), '/SendVoiceMsg': ('/api/send_voice', 'silkPath', 2*1024*1024)}
    if route not in mapping:
        raise ValueError('HOOK_ROUTE_UNSUPPORTED')
    upstream, key, maximum = mapping[route]
    file = source_file(body['path'], maximum)
    if route == '/SendFileMsg' and (file.stat().st_size != body.get('size') or hashes(file)[0] != body.get('md5')):
        raise ValueError('HOOK_FILE_INTEGRITY_FAILED')
    if route == '/SendImageMsg':
        if file.stat().st_size != body.get('size') or hashes(file)[0] != body.get('md5'):
            raise ValueError('HOOK_IMAGE_INTEGRITY_FAILED')
        from PIL import Image
        try:
            raw = file.read_bytes()
            with Image.open(io.BytesIO(raw)) as image:
                if image.format not in ('PNG', 'JPEG') or not 0 < image.width <= 8192 or not 0 < image.height <= 8192 or image.width*image.height > 40_000_000:
                    raise ValueError('HOOK_IMAGE_FORMAT_INVALID')
                image.verify()
            with Image.open(io.BytesIO(raw)) as image:
                image.load()
        except (OSError, SyntaxError, Image.DecompressionBombError):
            raise ValueError('HOOK_IMAGE_FORMAT_INVALID') from None
    if route == '/SendVoiceMsg':
        if not 1 <= body.get('duration', 0) <= 60000 or not file.read_bytes().startswith((b'#!SILK_V3', b'\x02#!SILK_V3')):
            raise ValueError('HOOK_VOICE_INVALID')
    if route == '/SendStickerMsg' and not file.read_bytes().startswith((b'GIF87a', b'GIF89a')):
        raise ValueError('HOOK_STICKER_INVALID')
    return upstream, {**({'wxid': target, 'toWxid': target} if route == '/SendVoiceMsg' else {'wxid': target}), key: str(file)}


def normalize_send_response(route, result, account=None, target=None, duration=None, size=None):
    if not isinstance(result, dict):
        raise RuntimeError('HOOK_SEND_RESPONSE_UNKNOWN')
    # A supplier account field is informational, not another login gate.
    # Supplied builds use either code or errCode. A text API acknowledgement
    # is distinct from a delivery receipt; other media still require their receipt.
    action_routes = ('/SendAtText', '/SendQuoteMsg', '/SendPatMsg', '/SendMp3VoiceMsg')
    codes = [result[key] for key in ('code', 'errCode') if key in result]
    if codes:
        if any(type(code) is not int for code in codes):
            raise RuntimeError('HOOK_SEND_RESPONSE_UNKNOWN')
        accepted = all(code == 1 for code in codes)
        if route == '/SendTextMsg' or route in action_routes:
            envelopes = [result]
            if 'data' in result and result['data'] is not None:
                if not isinstance(result['data'], dict):
                    raise RuntimeError('HOOK_SEND_RESPONSE_UNKNOWN')
                envelopes.append(result['data'])
            native_rets = []
            for envelope in envelopes:
                if 'baseResponse' in envelope:
                    base_response = envelope['baseResponse']
                    if not isinstance(base_response, dict) or type(base_response.get('ret')) is not int:
                        raise RuntimeError('HOOK_SEND_RESPONSE_UNKNOWN')
                    native_rets.append(base_response['ret'])
            accepted = accepted and all(ret == 0 for ret in native_rets)
        normalized = {'ret': 0 if accepted else -1, 'submitted': accepted, 'confirmed': False}
        if accepted and (route == '/SendTextMsg' or route in action_routes):
            normalized['apiAcknowledged'] = True
        if accepted and route in action_routes:
            native = result.get('data') if isinstance(result.get('data'), dict) else result
            if (native.get('baseResponse', {}).get('ret') == 0 and native.get('toUserName') == target
                    and isinstance(native.get('newMsgId'), str) and re.fullmatch(r'[1-9]\d{0,19}', native['newMsgId'])):
                normalized.update(confirmed=True, serverId=native['newMsgId'], target=target, receipt='wechat-message-response')
        return normalized
    if route in action_routes and isinstance(result.get('baseResponse'), dict):
        ret = result['baseResponse'].get('ret')
        if type(ret) is not int:
            raise RuntimeError('HOOK_SEND_RESPONSE_UNKNOWN')
        normalized = {'ret': 0 if ret == 0 else -1, 'submitted': ret == 0, 'confirmed': False}
        if ret == 0:
            normalized['apiAcknowledged'] = True
            if (result.get('toUserName') == target and isinstance(result.get('newMsgId'), str)
                    and re.fullmatch(r'[1-9]\d{0,19}', result['newMsgId'])):
                normalized.update(confirmed=True, serverId=result['newMsgId'], target=target, receipt='wechat-message-response')
        return normalized
    if (route == '/SendVoiceMsg' and account and target and result.get('baseResponse', {}).get('ret') == 0
            and result.get('endFlag') == 2 and result.get('cancelFlag') == 0
            and result.get('fromUserName') == account and result.get('toUserName') == target
            and isinstance(result.get('newMsgId'), str) and re.fullmatch(r'[1-9]\d{0,19}', result['newMsgId'])
            and isinstance(duration, int) and isinstance(size, int)
            and result.get('voiceLength') == int(size / (1.8 * 1024)) * 1000
            and isinstance(size, int) and isinstance(result.get('offset'), int) and isinstance(result.get('length'), int)
            and result['offset'] >= 0 and result['length'] > 0 and result['offset'] + result['length'] == size):
        # This build uploads successfully without a matching local UI row.
        # Only a final, account/target/duration/byte-count-bound server ACK counts.
        # Its duration is hardcoded floor(fileBytes / (1.8*1024))*1000 (RVA
        # 209461..209480), not SILK frame duration. Retain both, do not stretch
        # or damage the audio to fit this metadata estimate.
        return {'ret': 0, 'submitted': True, 'confirmed': True, 'receipt': 'wechat-uploadvoice-response',
                'serverId': result['newMsgId'], 'account': account, 'target': target, 'durationMs': duration,
                'reportedDurationMs': result['voiceLength']}
    if route == '/SendVoiceMsg' and (result.get('baseResponse', {}).get('ret') == 0 or result.get('baseResponse', {}).get('ret') == -2 and result.get('endFlag') == 1):
        # ret=-2/endFlag=1 is an intermediate packet, not final delivery proof.
        return {'ret': 0, 'submitted': True, 'confirmed': False}
    if route == '/SendVoiceMsg' and result.get('baseResponse', {}).get('ret') == -2:
        raise RuntimeError('HOOK_SEND_RESPONSE_UNKNOWN')
    if 'code' in result or isinstance(result.get('baseResponse', {}).get('ret'), int):
        return {'ret': -1, 'submitted': False, 'confirmed': False}
    raise RuntimeError('HOOK_SEND_RESPONSE_UNKNOWN')
