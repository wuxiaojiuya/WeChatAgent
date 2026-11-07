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
from types import SimpleNamespace
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
        db.execute('CREATE TABLE contact(username TEXT,remark TEXT,nick_name TEXT,alias TEXT,local_type INTEGER,flag INTEGER,delete_flag INTEGER,verify_flag INTEGER)')
        db.execute("INSERT INTO contact VALUES('wxid_friend','','Friend','',1,8388611,0,0)")
        db.execute("INSERT INTO contact VALUES('wxid_self','','Self','',1,3,0,0)")
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

    def test_friend_discovery_uses_relationships_not_every_known_person(self):
        db = self.fake.databases['contact.db']
        db.executemany('INSERT INTO contact VALUES(?,?,?,?,?,?,?,?)', [
            ('wxid_group_member', '', 'Known member', '', 3, 0, 0, 0),
            ('wxid_stranger', '', 'Stranger', '', 2, 2, 0, 0),
            ('wxid_deleted', '', 'Deleted', '', 1, 3, 1, 0),
            ('gh_official', '', 'Official', '', 1, 3, 0, 24),
            ('wxid_business', '', 'Verified', '', 1, 3, 0, 56),
            ('filehelper', '', 'File transfer', '', 1, 3, 0, 0),
            ('room@chatroom', '', 'Room', '', 1, 3, 0, 0),
            ('wxid_invalid', '', 'Invalid flags', '', 1, 'invalid', 0, 0),
        ])
        db.execute("UPDATE contact SET remark='备注',alias='account_alias' WHERE username='wxid_friend'")
        reader = self.reader()
        found = reader.contacts(kind='private')
        self.assertEqual([(c['username'], c['displayName'], c['isFriend']) for c in found], [('wxid_friend', '备注', True)])
        for keyword in ('备注', 'Friend', 'account_alias', 'wxid_friend'):
            self.assertEqual(len(reader.contacts(keyword, 'private')), 1)
        self.assertEqual(reader.names['wxid_group_member'], 'Known member')
        self.assertEqual(reader.contacts(kind='groups')[0]['displayName'], 'Room')
        # Already allowed display metadata remains resolvable after unfriending;
        # it must not reappear in the add-friend picker or expand permissions.
        db.execute("UPDATE contact SET delete_flag=1 WHERE username='wxid_friend'")
        self.assertEqual(reader.contacts(kind='private', refresh=True), [])
        selected = reader.contacts(selected=True)
        self.assertEqual([c['username'] for c in selected], ['wxid_friend'])
        self.assertFalse(selected[0]['isFriend'])
        self.assertEqual(reader.selected_talkers(), ['wxid_friend'])

    def test_missing_friendship_metadata_never_falls_back_to_all_contact_names(self):
        reader = self.reader()
        db = self.fake.databases['contact.db']
        db.execute('ALTER TABLE contact RENAME TO contact_full')
        db.execute('CREATE TABLE contact AS SELECT username,remark,nick_name,alias FROM contact_full')
        with self.assertRaisesRegex(RuntimeError, '^CONTACT_FRIENDSHIP_METADATA_UNAVAILABLE$'):
            reader.contacts(kind='private', refresh=True)
        self.assertEqual(reader.names['wxid_friend'], 'Friend')
        self.assertFalse(reader.contacts(selected=True)[0]['isFriend'])

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

    def test_delivered_errcode_send_envelope_only_acknowledges_submission(self):
        ack = {'account_wxid': 'wxid_self', 'data': {}, 'errCode': 1, 'errMsg': '请求处理成功'}
        for route in ('/SendTextMsg', '/SendImageMsg', '/SendFileMsg', '/SendStickerMsg', '/SendVoiceMsg'):
            with self.subTest(route=route):
                self.assertEqual(normalize_send_response(route, ack, 'wxid_self', 'wxid_friend'),
                                 {'ret': 0, 'submitted': True, 'confirmed': False})
        # Older envelopes remain valid and never become delivery receipts either.
        self.assertEqual(normalize_send_response('/SendTextMsg', {'code': 1}),
                         {'ret': 0, 'submitted': True, 'confirmed': False})
        self.assertFalse(normalize_send_response('/SendTextMsg', {'errCode': 1})['confirmed'])

    def test_send_envelope_account_must_match_the_bound_request(self):
        for account in ('wxid_other', '', None, 1, {}, ['wxid_self']):
            for code in ('code', 'errCode'):
                with self.subTest(account=account, code=code):
                    with self.assertRaisesRegex(RuntimeError, '^HOOK_ACCOUNT_MISMATCH$'):
                        normalize_send_response('/SendTextMsg', {code: 1, 'account_wxid': account}, 'wxid_self')
        with self.assertRaisesRegex(RuntimeError, '^HOOK_ACCOUNT_MISMATCH$'):
            normalize_send_response('/SendTextMsg', {'errCode': 1, 'account_wxid': 'wxid_self'})

    def test_failed_unknown_and_conflicting_send_envelopes_are_not_accepted(self):
        for result in ({'errCode': 0}, {'errCode': -1}, {'errCode': 2}, {'code': 1, 'errCode': 0}, {'code': 0, 'errCode': 1}):
            with self.subTest(result=result):
                self.assertEqual(normalize_send_response('/SendTextMsg', {**result, 'errMsg': '请求处理成功'}),
                                 {'ret': -1, 'submitted': False, 'confirmed': False})
        for result in ({'errCode': '1'}, {'errCode': True}, {'errCode': 1.0}, {'errCode': None}, {'code': True}, {'data': {}, 'errMsg': '请求处理成功'}):
            with self.subTest(result=result):
                with self.assertRaisesRegex(RuntimeError, '^HOOK_SEND_RESPONSE_UNKNOWN$'):
                    normalize_send_response('/SendTextMsg', result)

    def test_gateway_handles_actual_errcode_ack_without_delivery_confirmation_or_retry(self):
        reader = self.reader()
        reader.start_native_gateway()
        self.addCleanup(reader.gateway.server_close)
        self.addCleanup(reader.gateway.shutdown)
        original, response_account = self.api.transport, ['wxid_self']
        def delivered(route, body):
            result = original(route, body)
            return {'account_wxid': response_account[0], 'data': {}, 'errCode': 1, 'errMsg': '请求处理成功'} if route.startswith('/api/send_') else result
        self.api.transport = delivered
        headers = {'Authorization': 'Bearer '+'a'*64, 'X-WeChatAgent-Account': 'wxid_self', 'Content-Type': 'application/json'}
        def call(route, body):
            request = urllib.request.Request(self.api.hook['baseUrl']+route, json.dumps(body).encode(), headers)
            return json.load(urllib.request.urlopen(request, timeout=5))
        for text in ('第一句', '第二句'):
            self.assertEqual(call('/SendTextMsg', {'wxidorgid': 'wxid_friend', 'msg': text}),
                             {'ret': 0, 'submitted': True, 'confirmed': False})
        file = self.image_file()
        self.assertEqual(call('/SendImageMsg', {'wxidorgid': 'wxid_friend', 'path': str(file), 'size': file.stat().st_size, 'md5': hashlib.md5(file.read_bytes()).hexdigest()}),
                         {'ret': 0, 'submitted': True, 'confirmed': False})
        self.assertEqual(len([route for route, _ in self.fake.calls if route.startswith('/api/send_')]), 3)
        # The fake Hook did not add SQL rows: acknowledgements cannot invent them.
        self.assertEqual(len(reader.messages('wxid_friend')), 2)
        response_account[0] = 'wxid_other'
        with self.assertRaises(urllib.error.HTTPError) as mismatch:
            call('/SendTextMsg', {'wxidorgid': 'wxid_friend', 'msg': '第三句'})
        self.assertEqual(mismatch.exception.code, 503)
        self.assertEqual(json.load(mismatch.exception), {'error': 'HOOK_ACCOUNT_MISMATCH'})
        self.assertEqual(len([route for route, _ in self.fake.calls if route == '/api/send_text_msg']), 3)

    def test_voice_upload_has_a_separate_budget_and_other_requests_keep_five_seconds(self):
        file = self.root/'voice.silk'
        file.write_bytes(b'\x02#!SILK_V3fixture')
        self.api.transport = None
        with patch.object(self.api.opener, 'open', side_effect=lambda *args, **kwargs: io.BytesIO(b'{"code":1}')) as opened:
            self.api.post('/api/send_text_msg', {'wxid': 'friend', 'msg': 'hello'})
            result = supplier_reader.submit_voice(SimpleNamespace(root=self.root, api=self.api), {'silkPath': str(file)}, 'self', 'friend', 1000)
        self.assertFalse(result['confirmed'])
        self.assertEqual([call.kwargs['timeout'] for call in opened.call_args_list], [5, 30])

    def test_gateway_voice_diagnostics_survive_later_text_and_never_save_payloads(self):
        reader = self.reader()
        reader.start_native_gateway()
        self.addCleanup(reader.gateway.server_close)
        self.addCleanup(reader.gateway.shutdown)
        file = self.root/'private-audio-path.silk'
        file.write_bytes(b'\x02#!SILK_V3fixture')
        headers = {'Authorization': 'Bearer '+'a'*64, 'X-WeChatAgent-Account': 'wxid_self', 'Content-Type': 'application/json'}
        def call(route, body):
            request = urllib.request.Request(self.api.hook['baseUrl']+route, json.dumps(body).encode(), headers)
            return json.load(urllib.request.urlopen(request, timeout=5))
        with patch.object(self.api, 'post', wraps=self.api.post) as posted:
            voice = call('/SendVoiceMsg', {'wxidorgid': 'wxid_friend', 'path': str(file), 'duration': 1000})
            sends = [entry for entry in posted.call_args_list if entry.args[0] == '/api/send_voice']
            self.assertEqual(len(sends), 1)
            self.assertEqual(sends[0].kwargs, {'timeout': 30})
        self.assertFalse(voice['confirmed'])
        files = list((self.root/'state/hook/voice-submissions').glob('*.json'))
        self.assertEqual(len(files), 1)
        diagnostic = files[0].read_text()
        call('/SendTextMsg', {'wxidorgid': 'wxid_friend', 'msg': 'secret-text-content'})
        self.assertEqual(files[0].read_text(), diagnostic)
        self.assertEqual(json.loads((self.root/'state/hook/last-submit-response.json').read_text())['route'], '/api/send_text_msg')
        for private in ('wxid_self', 'wxid_friend', str(file), file.name, 'secret-text-content', 'a'*64, 'silkPath'):
            self.assertNotIn(private, diagnostic)
        record = json.loads(diagnostic)
        self.assertEqual(record['outcome'], 'submitted')
        self.assertEqual(record['response'], {'hasServerId': False, 'code': 1})
        self.assertGreaterEqual(record['elapsedMs'], 0)

    def test_voice_diagnostic_response_is_a_whitelist_and_keeps_only_server_id_presence(self):
        sensitive = 'private-wxid-path-secret'
        result = {'baseResponse': {'ret': -2, 'errMsg': sensitive}, 'endFlag': 1, 'cancelFlag': 0, 'offset': 100, 'length': 500,
                  'voiceLength': 30000, 'newMsgId': '8047442179716189588', 'fromUserName': sensitive, 'toUserName': sensitive,
                  'silkPath': sensitive, 'token': sensitive, 'data': sensitive, 'code': sensitive}
        supplier_reader.record_voice_submission(self.root, at=1700000000, elapsed_ms=5012, result=result, outcome='submitted')
        record = json.loads(next((self.root/'state/hook/voice-submissions').glob('*.json')).read_text())
        self.assertEqual(record['response'], {'hasServerId': True, 'ret': -2, 'endFlag': 1, 'cancelFlag': 0, 'offset': 100, 'length': 500, 'voiceLength': 30000})
        self.assertNotIn(sensitive, json.dumps(record))
        self.assertNotIn(result['newMsgId'], json.dumps(record))

    def test_voice_diagnostics_keep_failures_without_retrying_or_leaking_exception_text(self):
        file = self.root/'voice.silk'
        file.write_bytes(b'\x02#!SILK_V3fixture')
        reader = SimpleNamespace(root=self.root, api=self.api)
        for error in (RuntimeError('HOOK_UPSTREAM_TIMEOUT'), RuntimeError('private path C:\\private-audio.silk with secret-token')):
            with patch.object(self.api, 'post', side_effect=error) as posted:
                with self.assertRaises(RuntimeError):
                    supplier_reader.submit_voice(reader, {'silkPath': str(file)}, 'self', 'friend', 1000)
                posted.assert_called_once()
        records = [json.loads(file.read_text()) for file in sorted((self.root/'state/hook/voice-submissions').glob('*.json'))]
        self.assertEqual([record['error'] for record in records], ['HOOK_UPSTREAM_TIMEOUT', 'HOOK_GATEWAY_UNAVAILABLE'])
        self.assertTrue(all(record['outcome'] == 'error' and record['elapsedMs'] >= 0 for record in records))
        self.assertNotIn('private-audio', json.dumps(records))
        self.assertNotIn('secret-token', json.dumps(records))

    def test_voice_diagnostics_are_bounded_and_do_not_change_upload_results_on_disk_failure(self):
        with patch.object(supplier_reader.time, 'time_ns', return_value=1700000000000000000):
            for index in range(35):
                supplier_reader.record_voice_submission(self.root, at=index, elapsed_ms=0, result={}, outcome='submitted')
        files = sorted((self.root/'state/hook/voice-submissions').glob('*.json'))
        self.assertEqual(len(files), 30)
        self.assertEqual([json.loads(file.read_text())['at'] for file in files], list(range(5, 35)))
        file = self.root/'voice.silk'
        file.write_bytes(b'\x02#!SILK_V3fixture')
        with patch.object(supplier_reader.tempfile, 'mkstemp', side_effect=OSError('disk unavailable')):
            result = supplier_reader.submit_voice(SimpleNamespace(root=self.root, api=self.api), {'silkPath': str(file)}, 'self', 'friend', 1000)
        self.assertTrue(result['submitted'])

    def test_upstream_timeouts_have_a_safe_code_and_are_never_retried(self):
        self.api.transport = None
        for error in (TimeoutError('private endpoint'), urllib.error.URLError(TimeoutError('private endpoint'))):
            with patch.object(self.api.opener, 'open', side_effect=error) as opened:
                with self.assertRaisesRegex(RuntimeError, '^HOOK_UPSTREAM_TIMEOUT$'):
                    self.api.post('/api/send_voice', {}, timeout=30)
                opened.assert_called_once()

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

    def image_file(self, format='PNG'):
        from PIL import Image
        stream = io.BytesIO()
        Image.new('RGB', (4, 4), 'blue').save(stream, format=format)
        file = self.root/('generated.png' if format == 'PNG' else 'generated.jpg')
        file.write_bytes(stream.getvalue())
        return file

    def test_image_send_uses_the_delivered_binary_filepath_field_and_checks_actual_pixels_and_hash(self):
        for format in ('PNG', 'JPEG'):
            file = self.image_file(format)
            body = {'wxidorgid': 'friend', 'path': str(file), 'size': file.stat().st_size, 'md5': hashlib.md5(file.read_bytes()).hexdigest()}
            self.assertEqual(map_send('/SendImageMsg', body), ('/api/send_image_msg', {'wxid': 'friend', 'filepath': str(file)}))
            with self.assertRaisesRegex(ValueError, 'HOOK_IMAGE_INTEGRITY_FAILED'):
                map_send('/SendImageMsg', {**body, 'md5': 'a'*32})
        file.write_bytes(b'not an image')
        with self.assertRaisesRegex(ValueError, 'HOOK_IMAGE_FORMAT_INVALID'):
            map_send('/SendImageMsg', {**body, 'size': file.stat().st_size, 'md5': hashlib.md5(file.read_bytes()).hexdigest()})
        from PIL import Image
        Image.new('RGB', (2, 2)).save(file, format='GIF')
        with self.assertRaisesRegex(ValueError, 'HOOK_IMAGE_FORMAT_INVALID'):
            map_send('/SendImageMsg', {**body, 'size': file.stat().st_size, 'md5': hashlib.md5(file.read_bytes()).hexdigest()})

    def test_image_gateway_stages_ascii_uses_thirty_seconds_once_and_does_not_confirm_generic_ack(self):
        reader = self.reader()
        reader.start_native_gateway()
        self.addCleanup(reader.gateway.server_close)
        self.addCleanup(reader.gateway.shutdown)
        file = self.image_file()
        body = {'wxidorgid': 'wxid_friend', 'path': str(file), 'size': file.stat().st_size, 'md5': hashlib.md5(file.read_bytes()).hexdigest()}
        headers = {'Authorization': 'Bearer '+'a'*64, 'X-WeChatAgent-Account': 'wxid_self', 'Content-Type': 'application/json'}
        request = urllib.request.Request(self.api.hook['baseUrl']+'/SendImageMsg', json.dumps(body).encode(), headers)
        with patch.object(self.api, 'post', wraps=self.api.post) as posted:
            result = json.load(urllib.request.urlopen(request, timeout=5))
            sends = [call for call in posted.call_args_list if call.args[0] == '/api/send_image_msg']
        self.assertEqual(len(sends), 1)
        self.assertEqual(sends[0].kwargs, {'timeout': 30})
        self.assertEqual(sends[0].args[1]['wxid'], 'wxid_friend')
        self.assertTrue(sends[0].args[1]['filepath'].isascii())
        self.assertEqual(pathlib.Path(sends[0].args[1]['filepath']).read_bytes(), file.read_bytes())
        self.assertEqual(result, {'ret': 0, 'submitted': True, 'confirmed': False})
        health_request = urllib.request.Request(self.api.hook['baseUrl']+'/WeChatAgent/health', headers=headers)
        self.assertTrue(json.load(urllib.request.urlopen(health_request, timeout=5))['nativeImageSend'])
        body['wxidorgid'] = 'unselected_target'
        with self.assertRaises(urllib.error.HTTPError) as denied:
            urllib.request.urlopen(urllib.request.Request(self.api.hook['baseUrl']+'/SendImageMsg', json.dumps(body).encode(), headers), timeout=5)
        self.assertEqual(denied.exception.code, 403)
        self.assertEqual(len([route for route, _ in self.fake.calls if route == '/api/send_image_msg']), 1)

    def test_image_receipts_extract_only_valid_message_bound_md5_and_reject_xml_entities(self):
        md5 = 'ABCDEF0123456789ABCDEF0123456789'
        for index, xml in enumerate((f'<msg><img md5="{md5}"/></msg>', '<msg><img md5="not-a-hash"/></msg>', '<!DOCTYPE msg [<!ENTITY leak "private">]><msg><img md5="&leak;"/></msg>'), start=3):
            self.fake.databases['message_0.db'].execute(f'INSERT INTO "{self.fake.table}" VALUES(?, ?,3,2,?,?)', (index, 8047442179716189590+index, 1700000000+index, xml.encode()))
        rows = {row['localId']: row for row in self.reader().messages('wxid_friend')}
        self.assertEqual(rows[3]['imageMd5'], md5.lower())
        self.assertNotIn('imageMd5', rows[4])
        self.assertNotIn('imageMd5', rows[5])

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
