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
    media_routes = ('/SendImageMsg', '/SendFileMsg', '/SendStickerMsg')
    receipt_routes = action_routes + media_routes
    codes = [result[key] for key in ('code', 'errCode') if key in result]
    if codes:
        if any(type(code) is not int for code in codes):
            raise RuntimeError('HOOK_SEND_RESPONSE_UNKNOWN')
        accepted = all(code == 1 for code in codes)
        if route == '/SendTextMsg' or route in receipt_routes:
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
        if accepted and route in receipt_routes:
            native = result.get('data') if isinstance(result.get('data'), dict) else result
            if (isinstance(target, str) and target and native.get('baseResponse', {}).get('ret') == 0 and native.get('toUserName') == target
                    and isinstance(native.get('newMsgId'), str) and re.fullmatch(r'[1-9]\d{0,19}', native['newMsgId'])):
                normalized.update(confirmed=True, serverId=native['newMsgId'], target=target, receipt='wechat-message-response')
        return normalized
    if route in receipt_routes and isinstance(result.get('baseResponse'), dict):
        ret = result['baseResponse'].get('ret')
        if type(ret) is not int:
            raise RuntimeError('HOOK_SEND_RESPONSE_UNKNOWN')
        normalized = {'ret': 0 if ret == 0 else -1, 'submitted': ret == 0, 'confirmed': False}
        if ret == 0 and route in action_routes:
            normalized['apiAcknowledged'] = True
        if (ret == 0 and isinstance(target, str) and target and result.get('toUserName') == target and isinstance(result.get('newMsgId'), str)
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
