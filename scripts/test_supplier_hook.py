"""Offline contract tests. All upstream calls use an in-memory fake Hook."""
import hashlib
import io
import importlib.util
import json
import pathlib
import socket
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import supplier_reader
from supplier_api import SupplierApi, RemoteConnection, bind_sql, process_identity, runtime_directory, listener_address_allowed, SUPPLIER_WILDCARD_SHA256
from supplier_reader import map_send, normalize_send_response, stage_media

SCRIPT_ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('reader_contract_test', SCRIPT_ROOT/'reader-api.py')
reader_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader_module)


class FakeHook:
    def __init__(self):
        self.wxid = 'wxid_self'
        self.calls = []
        self.databases = {name: sqlite3.connect(':memory:', check_same_thread=False) for name in ('contact.db', 'message_0.db', 'media_0.db')}
        db = self.databases['contact.db']
        db.execute('CREATE TABLE contact(username TEXT,remark TEXT,nick_name TEXT,alias TEXT)')
        db.execute("INSERT INTO contact VALUES('wxid_friend','','Friend','')")
        db.execute("INSERT INTO contact VALUES('wxid_self','','Self','')")
        db = self.databases['message_0.db']
        self.table = 'Msg_' + hashlib.md5(b'wxid_friend').hexdigest()
        db.execute('CREATE TABLE Name2Id(user_name TEXT)')
        db.executemany('INSERT INTO Name2Id VALUES(?)', [('wxid_friend',), ('wxid_self',)])
        db.execute(f'CREATE TABLE "{self.table}"(local_id INTEGER,server_id INTEGER,local_type INTEGER,real_sender_id INTEGER,create_time INTEGER,message_content BLOB)')
        self.full_text = '你好，测试完整文本。' + '内容' * 220
        db.execute(f'INSERT INTO "{self.table}" VALUES(1,8047442179716189588,1,1,1700000000,?)', (self.full_text.encode(),))
        db.execute(f'INSERT INTO "{self.table}" VALUES(2,8047442179716189589,34,2,1700000001,?)', (b'<msg><voicemsg voicelength="1000"/></msg>',))
        db = self.databases['media_0.db']
        db.execute('CREATE TABLE Name2Id(user_name TEXT)')
        db.execute("INSERT INTO Name2Id VALUES('wxid_friend')")
        db.execute('CREATE TABLE VoiceInfo(chat_name_id INTEGER,local_id INTEGER,voice_data BLOB)')
        db.execute('INSERT INTO VoiceInfo VALUES(1,2,?)', (b'\x02#!SILK_V3fixture',))

    def post(self, route, body):
        self.calls.append((route, body))
        if route == '/api/get_profile_new':
            return {'baseResponse': {'ret': 0}, 'userInfo': {'userName': {'String': self.wxid}}}
        if route == '/api/get_db_handle':
            return {'data': [{'name': name, 'handle': i} for i, name in enumerate(self.databases)]}
        if route == '/api/sqlite3_exec':
            cursor = self.databases[body['db_name']].execute(body['sql_fmt'])
            # Match upstream: sorted keys, numbers as text, omitted raw BLOBs.
            return [dict(sorted((col[0], str(v) if isinstance(v, int) else v) for col, v in zip(cursor.description, row) if not isinstance(v, bytes))) for row in cursor]
        if route == '/api/download_img':
            pathlib.Path(body['path']).write_bytes(self.image_bytes)
            return {'status': 'success', 'path': body['path'], 'downloaded_bytes': len(self.image_bytes)}
        if route == '/api/cdn_download':
            pathlib.Path(body['out']).write_bytes(self.image_bytes)
            return {'code': 1}
        if route == '/api/download_file':
            pathlib.Path(body['path']).write_bytes(b'file-data')
            return {'status': 'success'}
        return {'code': 1, 'data': None, 'msg': 'success'}


class SupplierContract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.env_patch = patch.dict('os.environ', {'LOCALAPPDATA': str(self.root/'localappdata')})
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)
        self.fake = FakeHook()
        self.addCleanup(lambda: [db.close() for db in self.fake.databases.values()])
        config = json.loads((SCRIPT_ROOT.parent/'config/wechatagent.example.json').read_text(encoding='utf-8-sig'))
        config['hook'].update(backend='supplier-http', expectedVersion='4.1.8.27', upstreamUrl='http://127.0.0.1:19088', wechatExecutable='Weixin.exe')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            config['hook']['baseUrl'] = 'http://127.0.0.1:'+str(sock.getsockname()[1])
        config['wechat']['whitelist'] = {'private': [reader_module.onebot_id('wxid_friend')], 'groups': []}
        self.write('config/wechatagent.json', config)
        self.write('state/weflow/WeFlow-config.json', {'backend': 'supplier-http', 'myWxid': self.fake.wxid, 'dbPath': str(self.root/'state/hook/accounts')})
        self.write('state/wechat-io-config.json', {'self_wxid': self.fake.wxid})
        stage = self.root/'state/hook/supplier-4.1.8.27'
        stage.mkdir(parents=True)
        (stage/'libGLESv1.dll').write_bytes(b'fixture-dll')
        runtime = runtime_directory(self.root)
        runtime.mkdir(parents=True)
        (runtime/'libGLESv1.dll').write_bytes(b'fixture-dll')
        self.write('state/hook/supplier-4.1.8.27/manifest.json', {'version': '4.1.8.27', 'runtimeDirectory': str(runtime), 'dllSha256': hashlib.sha256(b'fixture-dll').hexdigest()})
        (self.root/'state/hook/native-token.txt').write_text('a'*64)
        self.api = SupplierApi(self.root, transport=self.fake.post, inspect_process=lambda *_: 42)

    def write(self, path, value):
        file = self.root/path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps(value), encoding='utf-8')

    def reader(self):
        with patch.object(supplier_reader, 'SupplierApi', return_value=self.api):
            reader = supplier_reader.create_reader(reader_module.Reader)(self.root)
        for pool in ('image_executor', 'sticker_executor', 'sticker_review_executor'):
            self.addCleanup(getattr(reader, pool).shutdown, wait=False, cancel_futures=True)
        return reader

    def test_sql_column_order_blobs_and_64_bit_ids(self):
        conn = RemoteConnection(self.api, 'message_0.db')
        row = conn.execute(f'SELECT message_content,server_id,local_id FROM "{self.fake.table}" WHERE local_id=?', (1,)).fetchone()
        self.assertEqual(row, (self.fake.full_text.encode(), 8047442179716189588, 1))
        self.assertEqual(conn.execute(f'PRAGMA table_info("{self.fake.table}")').fetchone()[1], 'local_id')

    def test_runtime_path_and_copy_integrity_before_network(self):
        calls = []
        self.api.inspect_process = lambda port, exe, dll: calls.append(dll) or 42
        self.api.identity()
        self.assertEqual(calls, [runtime_directory(self.root)/'libGLESv1.dll'])
        (runtime_directory(self.root)/'libGLESv1.dll').write_bytes(b'tampered')
        with self.assertRaisesRegex(RuntimeError, '^HOOK_SUPPLIED_DLL_HASH_MISMATCH$'):
            self.api.identity()
        self.assertEqual(len(calls), 1)
        manifest = self.root/'state/hook/supplier-4.1.8.27/manifest.json'
        value = json.loads(manifest.read_text())
        value['runtimeDirectory'] = str(self.root/'arbitrary')
        manifest.write_text(json.dumps(value))
        with self.assertRaisesRegex(RuntimeError, '^HOOK_RUNTIME_PATH_MISMATCH$'):
            self.api.identity()

    def test_only_exact_supplied_binary_can_use_fixed_wildcard_listener(self):
        self.assertTrue(listener_address_allowed('127.0.0.1', 'any-build'))
        self.assertTrue(listener_address_allowed('0.0.0.0', SUPPLIER_WILDCARD_SHA256))
        self.assertFalse(listener_address_allowed('0.0.0.0', 'unreviewed-build'))
        self.assertFalse(listener_address_allowed('192.168.1.2', SUPPLIER_WILDCARD_SHA256))

    def test_unbound_reader_reports_binding_required_before_contacting_hook(self):
        (self.root/'state/weflow/WeFlow-config.json').unlink()
        with patch.object(supplier_reader, 'SupplierApi') as api_constructor:
            with self.assertRaisesRegex(RuntimeError, '^HOOK_ACCOUNT_BIND_REQUIRED$'):
                supplier_reader.create_reader(reader_module.Reader)(self.root)
            api_constructor.assert_not_called()

    def test_sql_read_only_and_parameter_escaping(self):
        for sql in ('DELETE FROM contact', "SELECT 1 FROM contact; DELETE FROM contact", 'PRAGMA writable_schema=ON', "SELECT load_extension('x') FROM contact"):
            with self.assertRaises(ValueError):
                self.api.query('contact.db', sql)
        self.assertEqual(bind_sql("SELECT '?' FROM contact WHERE username=?", ("x'; DROP TABLE contact; --",)), "SELECT '?' FROM contact WHERE username='x''; DROP TABLE contact; --'")
        rows = self.api.query('contact.db', bind_sql('SELECT username FROM contact WHERE username=?', ("x'; DROP TABLE contact; --",)))
        self.assertEqual(rows, [])

    def test_sql_delivered_build_envelope_and_error_rejection(self):
        original = self.api.transport
        self.api.transport = lambda route, body: {'code': 1, 'data': original(route, body), 'total': 1}
        self.assertEqual(RemoteConnection(self.api, 'contact.db').execute('SELECT COUNT(*) FROM contact').fetchone(), (2,))
        self.api.transport = lambda *_: {'code': 0, 'msg': 'no data', 'total': 0}
        self.assertEqual(self.api.query('contact.db', 'SELECT username FROM contact WHERE 0'), [])
        self.api.transport = lambda *_: {'code': 0, 'data': [], 'msg': 'failed'}
        with self.assertRaisesRegex(RuntimeError, '^HOOK_SQL_RESPONSE_INVALID$'):
            self.api.query('contact.db', 'SELECT 1')

    def test_message_table_existence_avoids_supplier_name_only_miscount(self):
        original = self.api.transport
        def delivered(route, body):
            sql = body.get('sql_fmt', '')
            if 'FROM sqlite_master WHERE name=' in sql:
                return [{'__c0': '0'}]
            return original(route, body)
        self.api.transport = delivered
        row = RemoteConnection(self.api, 'message_0.db').execute('SELECT COUNT(*) FROM sqlite_master WHERE name=?', (self.fake.table,)).fetchone()
        self.assertEqual(row, (1,))

    def test_reader_uses_remote_history_contacts_and_voice_blobs_without_key(self):
        reader = self.reader()
        self.assertFalse(hasattr(reader, 'message_db'))
        self.assertEqual(reader.backend, 'supplier-http')
        self.assertEqual(reader.contacts()[0]['displayName'], 'Friend')
        rows = reader.messages('wxid_friend')
        self.assertEqual(rows[-1]['fullText'], self.fake.full_text)
        self.assertEqual(rows[-1]['serverId'], '8047442179716189588')
        self.assertEqual(rows[0]['isSend'], 1)
        self.assertEqual(reader.voice_blob({'talker': 'wxid_friend', 'localId': 2}), b'\x02#!SILK_V3fixture')
        with self.assertRaises(PermissionError):
            reader.messages('unselected')
        self.fake.wxid = 'another_account'
        with self.assertRaisesRegex(RuntimeError, 'HOOK_ACCOUNT_MISMATCH'):
            reader.messages('wxid_friend')

    def test_gateway_auth_account_scope_and_no_old_upstream_routes(self):
        reader = self.reader()
        reader.start_native_gateway()
        self.addCleanup(reader.gateway.server_close)
        self.addCleanup(reader.gateway.shutdown)
        base = self.api.hook['baseUrl']
        def call(route, body=None, token='a'*64, account='wxid_self', method=None):
            headers = {'Authorization': 'Bearer '+token, 'X-WeChatAgent-Account': account, 'Content-Type': 'application/json'}
            req = urllib.request.Request(base+route, json.dumps(body).encode() if body else None, headers, method=method)
            return json.load(urllib.request.urlopen(req, timeout=5))
        health = call('/WeChatAgent/health')
        self.assertEqual(health['provider'], 'supplier-http')
        with self.assertRaises(urllib.error.HTTPError) as denied:
            call('/SendTextMsg', {'wxidorgid': 'wxid_friend', 'msg': 'hello'}, token='wrong')
        self.assertEqual(denied.exception.code, 401)
        with self.assertRaises(urllib.error.HTTPError) as mismatch:
            call('/SendTextMsg', {'wxidorgid': 'wxid_friend', 'msg': 'hello'}, account='other')
        self.assertEqual(mismatch.exception.code, 409)
        result = call('/SendTextMsg', {'wxidorgid': 'wxid_friend', 'msg': 'hello'})
        self.assertEqual(result, {'ret': 0, 'submitted': True, 'confirmed': False})
        sends = [(route, body) for route, body in self.fake.calls if route.startswith('/api/send')]
        self.assertEqual(sends, [('/api/send_text_msg', {'wxid': 'wxid_friend', 'msg': 'hello'})])
        self.assertTrue(all(route.startswith('/api/') for route, _ in self.fake.calls))
        callback={'msgType': 3, 'fromUserName': {'String': 'wxid_friend'}, 'toUserName': {'String': 'wxid_self'}, 'newMsgId': '8047442179716189590', 'msgId': 1234}
        call('/api/recvMsg/'+'a'*64, callback, method='PUT')
        self.assertEqual(reader.callback_messages['8047442179716189590']['msgId'], 1234)
        self.assertFalse(reader.seen)  # Callback bodies never become AI input.
        callback['newMsgId']='8047442179716189591';callback['toUserName']['String']='other_account'
        call('/api/recvMsg/'+'a'*64, callback)
        self.assertNotIn('8047442179716189591', reader.callback_messages)

    def test_voice_intermediate_and_unknown_responses_never_confirm_delivery(self):
        result = normalize_send_response('/SendVoiceMsg', {'baseResponse': {'ret': -2}, 'endFlag': 1, 'msgId': 0, 'newMsgId': '8047442179716189588'})
        self.assertFalse(result['confirmed'])
        self.assertTrue(result['submitted'])
        final = normalize_send_response('/SendVoiceMsg', {'baseResponse': {'ret': 0}, 'endFlag': 2, 'newMsgId': '8047442179716189588'})
        self.assertFalse(final['confirmed'])  # Database remains the authority.
        with self.assertRaisesRegex(RuntimeError, 'HOOK_SEND_RESPONSE_UNKNOWN'):
            normalize_send_response('/SendTextMsg', {'status': 'maybe'})

    def test_final_upload_voice_ack_requires_matching_account_target_duration_and_complete_bytes(self):
        ack = {'baseResponse': {'ret': 0}, 'endFlag': 2, 'cancelFlag': 0, 'fromUserName': 'self', 'toUserName': 'friend', 'voiceLength': 5000, 'offset': 0, 'length': 9933, 'newMsgId': '5254719564166250390'}
        result = normalize_send_response('/SendVoiceMsg', ack, 'self', 'friend', 5000, 9933)
        self.assertTrue(result['confirmed'])
        self.assertEqual(result['receipt'], 'wechat-uploadvoice-response')
        music = normalize_send_response('/SendVoiceMsg', {**ack, 'length': 114675, 'voiceLength': 62000}, 'self', 'friend', 30000, 114675)
        self.assertTrue(music['confirmed'])
        self.assertEqual((music['durationMs'], music['reportedDurationMs']), (30000, 62000))
        for field, wrong in [('fromUserName','other'), ('toUserName','other'), ('voiceLength',1000), ('length',500), ('newMsgId','0'), ('endFlag',1), ('cancelFlag',1)]:
            self.assertFalse(normalize_send_response('/SendVoiceMsg', {**ack, field: wrong}, 'self', 'friend', 5000, 9933)['confirmed'], field)

    def test_file_and_silk_send_contracts(self):
        file = self.root/'test.txt'
        file.write_bytes(b'hello')
        route, body = map_send('/SendFileMsg', {'wxidorgid': 'friend', 'path': str(file), 'md5': hashlib.md5(b'hello').hexdigest(), 'size': 5})
        self.assertEqual((route, body), ('/api/send_file_msg', {'wxid': 'friend', 'filepath': str(file)}))
        file = self.root/'voice.silk'
        file.write_bytes(b'\x02#!SILK_V3fixture')
        route, body = map_send('/SendVoiceMsg', {'wxidorgid': 'friend', 'path': str(file), 'duration': 1000})
        self.assertEqual((route, body), ('/api/send_voice', {'wxid': 'friend', 'toWxid': 'friend', 'silkPath': str(file)}))
        with self.assertRaises(ValueError):
            map_send('/SendVoiceMsg', {'wxidorgid': 'friend', 'path': str(file), 'duration': 61000})

    def test_native_media_copy_is_ascii_and_detects_changed_cached_bytes(self):
        source = self.root/'unicode-\u6d4b\u8bd5.silk'
        source.write_bytes(b'\x02#!SILK_V3fixture')
        cached = stage_media(self.root, source)
        self.assertTrue(str(cached).isascii())
        self.assertEqual(cached.read_bytes(), source.read_bytes())
        self.assertEqual(stage_media(self.root, source), cached)
        cached.write_bytes(b'tampered')
        with self.assertRaisesRegex(RuntimeError, '^HOOK_MEDIA_COPY_MISMATCH$'):
            stage_media(self.root, source)

    def test_image_requires_bound_callback_metadata_and_downloads_through_new_hook(self):
        from PIL import Image
        stream = io.BytesIO()
        Image.new('RGB', (4, 4), 'red').save(stream, 'PNG')
        self.fake.image_bytes = stream.getvalue()
        xml = f'<msg><img cdnmidimgurl_size="{len(self.fake.image_bytes)}"/></msg>'
        self.fake.databases['message_0.db'].execute(f'INSERT INTO "{self.fake.table}" VALUES(3,8047442179716189590,3,1,1700000002,?)', (xml.encode(),))
        reader = self.reader()
        message = reader.messages('wxid_friend')[0]
        payload = reader.make_payload('wxid_friend', message)
        image_id = reader.register_image('wxid_friend', payload)
        with self.assertRaisesRegex(RuntimeError, 'IMAGE_CALLBACK_METADATA_REQUIRED'):
            reader.resolve_image(image_id)
        reader.callback_messages['8047442179716189590'] = {'msgId': 1234, 'from': 'wxid_friend', 'to': 'wxid_self'}
        preview = reader.resolve_image(image_id)
        self.assertEqual(preview['imageId'], image_id)
        self.assertTrue(preview['b64'])
        calls = [body for route, body in self.fake.calls if route == '/api/download_img']
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]['MsgId'], 1234)  # Never truncate the 64-bit newMsgId.
        self.assertEqual(calls[0]['from_user'], 'wxid_friend')

    def image_fixture(self, attrs, *, callback=True):
        from PIL import Image
        stream = io.BytesIO()
        Image.new('RGB', (32, 24), 'blue').save(stream, 'PNG')
        self.fake.image_bytes = stream.getvalue()
        xml = '<msg><img '+attrs.format(size=len(self.fake.image_bytes))+'/></msg>'
        self.fake.databases['message_0.db'].execute(f'INSERT INTO "{self.fake.table}" VALUES(3,8047442179716189590,3,1,1700000002,?)', (xml.encode(),))
        reader = self.reader()
        message = reader.messages('wxid_friend')[0]
        image_id = reader.register_image('wxid_friend',reader.make_payload('wxid_friend',message))
        if callback:
            reader.callback_messages['8047442179716189590'] = {'msgId':'1234','from':'wxid_friend','to':'wxid_self','type':3}
        return reader,image_id

    def test_real_image_length_field_and_string_callback_id(self):
        reader,image_id = self.image_fixture('length="{size}" hdlength="123456"')
        result = reader.resolve_image(image_id)
        self.assertTrue(result['b64'])
        body = next(body for route,body in self.fake.calls if route=='/api/download_img')
        self.assertEqual(body['total_len'],len(self.fake.image_bytes))
        self.assertEqual(body['MsgId'],1234)
        self.assertTrue(body['path'].isascii())
        self.assertTrue(body['path'].endswith('.jpg.part'))

    def test_cdn_image_does_not_require_short_callback_id_or_length(self):
        reader,image_id = self.image_fixture('cdnmidimgurl="message-bound-file" aeskey="'+'ab'*16+'"',callback=False)
        result = reader.resolve_image(image_id)
        self.assertEqual(result['imageId'],image_id)
        calls = [(route,body) for route,body in self.fake.calls if route in ('/api/cdn_download','/api/download_img')]
        self.assertEqual(len(calls),1)
        self.assertEqual(calls[0][0],'/api/cdn_download')
        self.assertEqual(calls[0][1]['asekey'],'ab'*16)
        self.assertEqual(calls[0][1]['imgType'],2)
        self.fake.calls.clear()
        self.assertEqual(reader.resolve_image(image_id)['sha256'],result['sha256'])
        self.assertFalse(any(route=='/api/cdn_download' for route,_ in self.fake.calls))

    def test_cdn_image_type_fallback_rejects_non_image_success_response(self):
        reader,image_id = self.image_fixture('length="{size}" fileid="message-bound-file" asekey="'+'ab'*16+'"',callback=False)
        transport = self.api.transport
        def download(route,body):
            if route=='/api/cdn_download' and body['imgType']==2:
                self.fake.calls.append((route,body))
                pathlib.Path(body['out']).write_bytes(b'not an image')
                return {'code':1}
            return transport(route,body)
        self.api.transport=download
        self.assertTrue(reader.resolve_image(image_id)['b64'])
        self.assertEqual([body['imgType'] for route,body in self.fake.calls if route=='/api/cdn_download'],[2,3])

    def test_chunk_download_waits_for_complete_image_before_atomic_cache(self):
        reader,image_id = self.image_fixture('LENGTH="{size}"')
        transport = self.api.transport
        threads=[]
        def download(route,body):
            if route=='/api/download_img':
                self.fake.calls.append((route,body))
                def write():
                    target=pathlib.Path(body['path'])
                    target.write_bytes(self.fake.image_bytes[:24])
                    time.sleep(.35)
                    target.write_bytes(self.fake.image_bytes)
                thread=threading.Thread(target=write)
                threads.append(thread);thread.start()
                return {'code':1}
            return transport(route,body)
        self.api.transport=download
        self.assertTrue(reader.resolve_image(image_id)['b64'])
        for thread in threads:thread.join()
        directory=runtime_directory(self.root)/'incoming-images'
        self.assertEqual((directory/(image_id+'.image')).read_bytes(),self.fake.image_bytes)
        self.assertFalse(list(directory.glob('*.part')))

    def test_downloaded_image_is_not_published_after_account_switch(self):
        reader,image_id = self.image_fixture('cdnmidimgurl="message-bound-file" aeskey="'+'ab'*16+'"',callback=False)
        transport=self.api.transport
        def download(route,body):
            response=transport(route,body)
            if route=='/api/cdn_download':self.fake.wxid='other_account'
            return response
        self.api.transport=download
        with self.assertRaisesRegex(RuntimeError,'HOOK_ACCOUNT_MISMATCH'):
            reader.resolve_image(image_id)
        self.assertFalse((runtime_directory(self.root)/'incoming-images'/(image_id+'.image')).exists())

    def test_file_download_is_scoped_to_exact_message_and_verified_by_hash(self):
        config = json.loads((self.root/'config/wechatagent.json').read_text())
        key = 'wechat:private:'+reader_module.onebot_id('wxid_friend')
        config['wechat']['workModes'] = {key: 'assistant'}
        config['wechat']['assistant'] = {'fileTransferChats': {key: True}, 'administrators': ['wxid_friend']}
        self.write('config/wechatagent.json', config)
        md5 = hashlib.md5(b'file-data').hexdigest()
        xml = '<msg><appmsg><type>6</type><title>fixture.txt</title><appattach><totallen>9</totallen><attachid>fixture-cdn</attachid><md5>'+md5+'</md5></appattach></appmsg></msg>'
        self.fake.databases['message_0.db'].execute(f'INSERT INTO "{self.fake.table}" VALUES(3,8047442179716189590,25769803825,1,1700000002,?)', (xml.encode(),))
        reader = self.reader()
        message = reader.messages('wxid_friend')[0]
        payload = reader.make_payload('wxid_friend', message)
        ref = reader.files.remember(payload, key)
        result = reader.files.resolve(ref['id'], key, 'wxid_friend')
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['md5'], md5)
        calls = [body for route, body in self.fake.calls if route == '/api/download_file']
        self.assertEqual(calls[0]['MsgId'], 8047442179716189590)
        with self.assertRaises(PermissionError):
            reader.files.resolve(ref['id'], key, 'other_sender')

    def test_manifest_and_account_mismatch_fail_closed(self):
        self.assertEqual(self.api.identity('wxid_self')['pid'], 42)
        with self.assertRaisesRegex(RuntimeError, 'HOOK_ACCOUNT_MISMATCH'):
            self.api.identity('wxid_other')
        (self.root/'state/hook/supplier-4.1.8.27/libGLESv1.dll').write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError, 'HOOK_SUPPLIED_DLL_HASH_MISMATCH'):
            self.api.identity()

    @unittest.skipUnless(sys.platform == 'win32', 'Windows process inspection')
    def test_native_process_gate_checks_the_actual_listener_and_loaded_module(self):
        with socket.socket() as server:
            server.bind(('127.0.0.1', 0))
            server.listen()
            # A venv launcher may delegate to the base Python executable.
            for executable in dict.fromkeys([sys.executable, getattr(sys, '_base_executable', sys.executable)]):
                try:
                    process_identity(server.getsockname()[1], pathlib.Path(executable), self.root/'not-loaded.dll')
                except RuntimeError as error:
                    if str(error) == 'HOOK_PROCESS_PATH_MISMATCH':
                        continue
                    self.assertEqual(str(error), 'HOOK_SUPPLIED_DLL_NOT_LOADED')
                    break
                self.fail('A missing native module was accepted')
            else:
                self.fail('The real Python listener could not be inspected')


if __name__ == '__main__':
    unittest.main()
