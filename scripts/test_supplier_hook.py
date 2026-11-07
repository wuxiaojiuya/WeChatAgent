"""Offline contract tests. All upstream calls use an in-memory fake Hook."""
import hashlib
import io
import importlib.util
import json
import pathlib
import queue
import socket
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
from supplier_api import SupplierApi, process_identity, runtime_directory, listener_address_allowed, SUPPLIER_WILDCARD_SHA256
from supplier_reader import map_send, normalize_send_response, stage_media

SCRIPT_ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('reader_contract_test', SCRIPT_ROOT/'hook_receiver_core.py')
reader_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader_module)


class FakeHook:
    def __init__(self):
        self.wxid = 'wxid_self'
        self.calls = []
        self.friends = [self.contact('wxid_friend', 'Friend'), self.contact('wxid_self', 'Self')]
        self.groups = []
        self.members = {}
        self.full_text = '你好，测试完整文本。' + '内容' * 220
        self.voice_bytes = b'\x02#!SILK_V3fixture'

    @staticmethod
    def contact(username, nickname, **fields):
        return {'userName': {'String': username}, 'nickName': {'String': nickname},
                'bitVal': 3, 'verifyFlag': 0, **fields}

    def post(self, route, body):
        self.calls.append((route, body))
        if route == '/api/get_profile_new':
            return {'baseResponse': {'ret': 0}, 'userInfo': {'userName': {'String': self.wxid}}}
        if route in ('/api/get_db_handle', '/api/sqlite3_exec'):
            raise AssertionError('Supplier message reception must not use database APIs')
        if route in ('/api/get_frien_lists', '/api/update_all_friend'):
            return {'code': 1, 'data': self.friends}
        if route == '/api/get_chatroom_list':
            return {'code': 1, 'data': self.groups}
        if route == '/api/get_room_members':
            return {'baseResponse': {'ret': 0}, 'chatroomUserName': {'String': body['room_id']},
                    'newChatroomData': self.members.get(body['room_id'], [])}
        if route == '/api/download_img':
            pathlib.Path(body['path']).write_bytes(self.image_bytes)
            return {'status': 'success', 'path': body['path'], 'downloaded_bytes': len(self.image_bytes)}
        if route == '/api/cdn_download':
            pathlib.Path(body['out']).write_bytes(self.image_bytes)
            return {'code': 1}
        if route == '/api/download_file':
            pathlib.Path(body['path']).write_bytes(b'file-data')
            return {'status': 'success'}
        if route == '/api/download_voice':
            pathlib.Path(body['path']).write_bytes(self.voice_bytes)
            return {'code': 1}
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
        config = json.loads((SCRIPT_ROOT.parent/'config/wechatagent.example.json').read_text(encoding='utf-8-sig'))
        config['hook'].update(backend='supplier-http', expectedVersion='4.1.8.27', upstreamUrl='http://127.0.0.1:19088', wechatExecutable='Weixin.exe')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            config['hook']['baseUrl'] = 'http://127.0.0.1:'+str(sock.getsockname()[1])
        config['wechat']['whitelist'] = {'private': [reader_module.onebot_id('wxid_friend')], 'groups': []}
        self.write('config/wechatagent.json', config)
        self.write('state/hook/connection.json', {'version': 1, 'backend': 'supplier-http', 'wechatVersion': '4.1.8.27', 'ownWxid': self.fake.wxid})
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
        with patch.object(reader_module, 'SupplierApi', return_value=self.api):
            reader = reader_module.HookReceiver(self.root)
        for pool in ('image_executor', 'sticker_executor', 'sticker_review_executor'):
            self.addCleanup(getattr(reader, pool).shutdown, wait=False, cancel_futures=True)
        self.addCleanup(reader.events.close)
        return reader

    def incoming(self, reader, *, kind=1, content=None, local_id=1, server_id='8047442179716189588',
                 timestamp=1700000000, sender='wxid_friend', recipient='wxid_self', **extra):
        body = {'fromUserName': {'String': sender}, 'toUserName': {'String': recipient},
                'msgType': str(kind), 'content': {'String': self.fake.full_text if content is None else content},
                'msgId': str(local_id), 'newMsgId': str(server_id), 'createTime': str(timestamp),
                'msgSource': '', **extra}
        reader.accept_callback(body)
        return body

    def assert_no_database_api(self):
        self.assertFalse(any(route in ('/api/get_db_handle', '/api/sqlite3_exec') for route, _ in self.fake.calls))

    def allow_group(self):
        self.fake.groups = [self.fake.contact('room@chatroom', 'Room')]
        self.fake.members['room@chatroom'] = [self.fake.contact('wxid_friend', 'Friend')]
        config = json.loads((self.root/'config/wechatagent.json').read_text())
        config['wechat']['whitelist']['groups'] = [reader_module.onebot_id('Room')]
        self.write('config/wechatagent.json', config)

    def test_push_messages_preserve_full_text_and_64_bit_ids_without_history_fetch(self):
        reader = self.reader()
        self.assertFalse(hasattr(reader, 'open_messages'))
        self.assertEqual(reader.messages('wxid_friend'), [])
        self.incoming(reader)
        row = reader.messages('wxid_friend')[0]
        self.assertEqual(row['fullText'], self.fake.full_text)
        self.assertEqual(row['serverId'], '8047442179716189588')
        self.assertEqual(row['localId'], 1)
        self.assert_no_database_api()

    def test_legacy_client_paths_are_not_opened_or_used_as_missing_media_fallback(self):
        client = self.root/'wechat-client/db_storage'
        client.mkdir(parents=True)
        (client/'message_0.db').write_bytes(b'client-database-must-not-be-opened')
        legacy = self.root/'state/weflow/WeFlow-config.json'
        self.write(str(legacy.relative_to(self.root)), {'dbPath': str(client), 'myWxid': self.fake.wxid,
                                                     'decryptKey': 'fixture-not-a-real-key'})
        ordinary_open = pathlib.Path.open
        def guarded_open(file, *args, **kwargs):
            resolved = file.absolute()
            if resolved == legacy or resolved.is_relative_to(client):
                raise AssertionError('Legacy client data must not be opened')
            return ordinary_open(file, *args, **kwargs)
        with patch.object(pathlib.Path, 'open', guarded_open):
            reader = self.reader()
            self.assertTrue(reader.account.is_relative_to(self.root/'state/hook/accounts'))
            self.assertEqual(reader.contacts()[0]['displayName'], 'Friend')
            self.incoming(reader, kind=34, content='<msg><voicemsg voicelength="1000"/></msg>')
            row = reader.messages('wxid_friend')[0]
            self.assertEqual(reader.sessions()[0]['username'], 'wxid_friend')
            with self.assertRaisesRegex(RuntimeError, '^VOICE_CALLBACK_METADATA_REQUIRED$'):
                reader.voice_blob({**row, 'talker': 'wxid_friend', 'sender': 'wxid_friend'})
        self.assert_no_database_api()
        self.assertFalse(any(route == '/api/download_voice' for route, _ in self.fake.calls))

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
        (self.root/'state/hook/connection.json').unlink()
        with patch.object(reader_module, 'SupplierApi') as api_constructor:
            with self.assertRaisesRegex(RuntimeError, '^HOOK_CONNECTION_REQUIRED$'):
                reader_module.HookReceiver(self.root)
            api_constructor.assert_not_called()

    def test_unselected_callbacks_are_not_stored_or_sent_to_ai(self):
        reader = self.reader()
        self.incoming(reader, sender='wxid_unselected')
        self.assertEqual(reader.events.pending(), [])
        self.assertEqual(reader.events.messages('wxid_unselected'), [])
        with self.assertRaises(PermissionError):
            reader.messages('wxid_unselected')
        self.assert_no_database_api()

    def test_duplicate_callbacks_are_durable_and_dispatched_once(self):
        reader = self.reader()
        client = queue.Queue(maxsize=10)
        reader.clients.add(client)
        body = self.incoming(reader)
        self.assertEqual(reader.accept_callback(body), 0)
        reader.dispatch_pending()
        payload = client.get_nowait()
        self.assertEqual(payload['content'], self.fake.full_text)
        self.assertEqual(reader.pushed, 1)
        self.assertEqual(reader.events.pending(), [])
        reader.events.close()
        restarted = self.reader()
        restarted_client = queue.Queue(maxsize=10)
        restarted.clients.add(restarted_client)
        self.assertEqual(restarted.accept_callback(body), 0)
        restarted.dispatch_pending()
        self.assertTrue(restarted_client.empty())
        self.assert_no_database_api()

    def test_pending_callback_survives_restart_without_fetching_wechat_history(self):
        reader = self.reader()
        body = self.incoming(reader)
        reader.events.close()
        restarted = self.reader()
        self.assertEqual(len(restarted.events.pending()), 1)
        client = queue.Queue(maxsize=10)
        restarted.clients.add(client)
        restarted.dispatch_pending()
        self.assertEqual(client.get_nowait()['content'], self.fake.full_text)
        self.assertEqual(restarted.events.pending(), [])
        self.assertEqual(restarted.accept_callback(body), 0)
        self.assert_no_database_api()

    def test_dispatch_waits_for_live_clients_without_losing_callbacks(self):
        reader = self.reader()
        self.incoming(reader)
        reader.dispatch_pending()
        self.assertEqual(len(reader.events.pending()), 1)
        self.assertEqual(reader.pushed, 0)
        client = queue.Queue(maxsize=1)
        reader.clients.add(client)
        client.put({'occupied': True})
        reader.dispatch_pending()
        self.assertEqual(len(reader.events.pending()), 1)
        client.get_nowait()
        reader.dispatch_pending()
        self.assertEqual(client.get_nowait()['content'], self.fake.full_text)
        self.assertEqual(reader.events.pending(), [])

    def test_own_callbacks_are_observed_but_never_replied_to(self):
        reader = self.reader()
        reader.accept_callback({'account_wxid': 'ignored-metadata', 'list': [
            {'clientMsgId': 123456, 'createTime': 1700000000, 'type': 1,
             'content': 'own text', 'toUserName': {'String': 'wxid_friend'}}]})
        self.assertEqual(reader.events.pending(), [])
        row = reader.messages('wxid_friend')[0]
        self.assertEqual(row['serverId'], '0')
        self.assertTrue(row['observedOnly'])
        self.assertEqual(row['clientId'], '123456')
        self.assertIsNone(reader.make_payload('wxid_friend', row))

    def test_idle_poll_runs_local_dispatcher_without_upstream_reads(self):
        reader = self.reader()
        calls_before = len(self.fake.calls)
        reader.last_error = 'old failure'
        with patch.object(reader.stop, 'is_set', side_effect=(False, True)), patch.object(reader.callback_wake, 'wait'):
            reader.poll()
        self.assertEqual(reader.last_error, '')
        self.assertGreater(reader.last_poll, 0)
        self.assertEqual(len(self.fake.calls), calls_before)
        self.assert_no_database_api()

    def test_malformed_callbacks_do_not_become_acknowledged_or_ai_input(self):
        reader = self.reader()
        with self.assertRaises(ValueError):
            self.incoming(reader, local_id=True)
        self.assertEqual(reader.events.pending(), [])
        self.assertEqual(reader.pushed, 0)

    def test_group_callback_mentions_sender_and_member_catalog_use_dedicated_apis(self):
        self.allow_group()
        reader = self.reader()
        self.incoming(reader, sender='room@chatroom', content='wxid_friend:\n@机器人 你好',
                      member_info={'userName': 'wxid_friend', 'nickName': '群成员'},
                      msgSource='<msgsource><atuserlist>wxid_self</atuserlist></msgsource>')
        row = reader.messages('room@chatroom')[0]
        payload = reader.make_payload('room@chatroom', row)
        self.assertEqual(payload['senderName'], '群成员')
        self.assertEqual(payload['sessionType'], 'group')
        self.assertEqual(payload['talkerId'], 'wxid_friend')
        self.assertEqual(payload['content'], '@机器人 你好')
        self.assertTrue(payload['mentionedSelf'])
        self.assertEqual(reader.group_members('room@chatroom')[0]['username'], 'wxid_friend')
        self.assertIn(('/api/get_room_members', {'room_id': 'room@chatroom'}), self.fake.calls)
        self.assert_no_database_api()

    def test_voice_download_partial_length_stays_pending_without_retry_or_final_cache(self):
        reader = self.reader()
        self.incoming(reader, kind=34, content='<msg><voicemsg voicelength="1000" length="99"/></msg>')
        row = reader.messages('wxid_friend')[0]
        record = {**row, 'talker': 'wxid_friend', 'sender': 'wxid_friend'}
        with patch.object(reader_module.time, 'monotonic', side_effect=(0, 0, 11)), patch.object(reader_module.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, '^VOICE_DOWNLOAD_PENDING$'):
                reader.voice_blob(record)
        self.assertEqual(sum(route == '/api/download_voice' for route, _ in self.fake.calls), 1)
        directory = runtime_directory(self.root)/'incoming-voice'
        self.assertFalse(list(directory.glob('*.silk')))
        self.assertFalse(list(directory.glob('*.part')))

    def test_reader_uses_dedicated_contacts_and_bound_voice_download_without_key(self):
        reader = self.reader()
        self.assertFalse(hasattr(reader, 'message_db'))
        self.assertEqual(reader.backend, 'supplier-http')
        self.assertEqual(reader.contacts()[0]['displayName'], 'Friend')
        self.incoming(reader)
        length = len(self.fake.voice_bytes)
        self.incoming(reader, kind=34, content='<msg><voicemsg voicelength="1000" length="' + str(length) + '"/></msg>',
                      local_id=2, server_id='8047442179716189589', timestamp=1700000001)
        row = reader.messages('wxid_friend')[0]
        record = {**row, 'talker': 'wxid_friend', 'sender': 'wxid_friend'}
        self.assertEqual(reader.voice_blob(record), self.fake.voice_bytes)
        call = next(body for route, body in self.fake.calls if route == '/api/download_voice')
        self.assertEqual(call['MsgId'], '2')
        self.assertEqual(call['newMsgId'], '8047442179716189589')
        self.assertEqual(call['length'], str(length))
        self.assertTrue(call['path'].isascii())
        profiles = sum(route == '/api/get_profile_new' for route, _ in self.fake.calls)
        self.fake.wxid = 'another_account'
        with patch.object(self.api, 'identity', side_effect=AssertionError('runtime must not query login accounts')):
            self.assertEqual(reader.active_identity()['wxid'], 'wxid_self')
            self.assertEqual(reader.messages('wxid_friend')[-1]['fullText'], self.fake.full_text)
            self.assertEqual(reader.voice_blob(record), self.fake.voice_bytes)
        self.assertEqual(sum(route == '/api/get_profile_new' for route, _ in self.fake.calls), profiles)
        self.assert_no_database_api()

    def test_startup_reuses_connection_metadata_without_querying_or_comparing_login_accounts(self):
        self.fake.wxid = 'other_live_metadata'
        with patch.object(self.api, 'identity', side_effect=AssertionError('startup must reuse connection metadata')):
            reader = self.reader()
        self.assertEqual(reader.own_wxid, 'wxid_self')
        self.assertEqual(reader.account.name, 'wxid_self')
        self.assertEqual(sum(route == '/api/get_profile_new' for route, _ in self.fake.calls), 0)

    def test_friend_discovery_uses_relationships_not_every_known_person(self):
        self.fake.friends.extend([
            self.fake.contact('wxid_group_member', 'Known member', local_type=3, bitVal=0),
            self.fake.contact('wxid_stranger', 'Stranger', local_type=2, bitVal=2),
            self.fake.contact('wxid_deleted', 'Deleted', delete_flag=1),
            self.fake.contact('gh_official', 'Official', verifyFlag=24),
            self.fake.contact('wxid_business', 'Verified', verifyFlag=56),
            self.fake.contact('filehelper', 'File transfer'),
            self.fake.contact('room@chatroom', 'Room'),
        ])
        self.fake.groups = [self.fake.contact('room@chatroom', 'Room')]
        self.fake.friends[0].update(remark='备注', alias='account_alias')
        reader = self.reader()
        found = reader.contacts(kind='private')
        self.assertEqual([(c['username'], c['displayName'], c['isFriend']) for c in found], [('wxid_friend', '备注', True)])
        for keyword in ('备注', 'Friend', 'account_alias', 'wxid_friend'):
            self.assertEqual(len(reader.contacts(keyword, 'private')), 1)
        self.assertEqual(reader.names['wxid_group_member'], 'Known member')
        self.assertEqual(reader.contacts(kind='groups')[0]['displayName'], 'Room')
        # Already allowed display metadata remains resolvable after unfriending;
        # it must not reappear in the add-friend picker or expand permissions.
        self.fake.friends[0]['delete_flag'] = 1
        self.assertEqual(reader.contacts(kind='private', refresh=True), [])
        selected = reader.contacts(selected=True)
        self.assertEqual([c['username'] for c in selected], ['wxid_friend'])
        self.assertFalse(selected[0]['isFriend'])
        self.assertEqual(reader.selected_talkers(), ['wxid_friend'])

    def test_missing_friendship_metadata_never_falls_back_to_all_contact_names(self):
        reader = self.reader()
        for contact in self.fake.friends:
            contact.pop('bitVal')
            contact.pop('verifyFlag')
        with self.assertRaisesRegex(RuntimeError, '^CONTACT_FRIENDSHIP_METADATA_UNAVAILABLE$'):
            reader.contacts(kind='private', refresh=True)
        self.assertEqual(reader.names['wxid_friend'], 'Friend')
        self.assertFalse(reader.contacts(selected=True)[0]['isFriend'])

    def test_gateway_auth_without_account_headers_and_no_old_upstream_routes(self):
        reader = self.reader()
        reader.start_native_gateway()
        self.addCleanup(reader.gateway.server_close)
        self.addCleanup(reader.gateway.shutdown)
        base = self.api.hook['baseUrl']
        def call(route, body=None, token='a'*64, account=None, method=None):
            headers = {'Authorization': 'Bearer '+token, 'Content-Type': 'application/json'}
            if account is not None:
                headers['X-WeChatAgent-Account'] = account
            req = urllib.request.Request(base+route, json.dumps(body).encode() if body else None, headers, method=method)
            return json.load(urllib.request.urlopen(req, timeout=5))
        health = call('/WeChatAgent/health')
        self.assertEqual(health['provider'], 'supplier-http')
        self.assertTrue(health['singleAccount'])
        self.assertEqual(health['accountVerification'], 'not-required')
        self.assertNotIn('databaseAccounts', health)
        with self.assertRaises(urllib.error.HTTPError) as denied:
            call('/SendTextMsg', {'wxidorgid': 'wxid_friend', 'msg': 'hello'}, token='wrong')
        self.assertEqual(denied.exception.code, 401)
        profiles = sum(route == '/api/get_profile_new' for route, _ in self.fake.calls)
        self.assertEqual(call('/SendTextMsg', {'wxidorgid': 'wxid_friend', 'msg': 'hello'}, account='other')['ret'], 0)
        result = call('/SendTextMsg', {'wxidorgid': 'wxid_friend', 'msg': 'hello'})
        self.assertEqual(result, {'ret': 0, 'submitted': True, 'confirmed': False, 'apiAcknowledged': True})
        sends = [(route, body) for route, body in self.fake.calls if route.startswith('/api/send')]
        self.assertEqual(sends, [('/api/send_text_msg', {'wxid': 'wxid_friend', 'msg': 'hello'})]*2)
        self.assertTrue(all(route.startswith('/api/') for route, _ in self.fake.calls))
        callback={'msgType': 1, 'fromUserName': {'String': 'wxid_friend'}, 'toUserName': {'String': 'wxid_self'},
                  'newMsgId': '8047442179716189590', 'msgId': 1234, 'createTime': 1700000002, 'content': {'String': '来自回调的消息'}}
        call('/api/recvMsg/'+'a'*64, callback, method='PUT')
        self.assertEqual(reader.callback_messages['8047442179716189590']['msgId'], 1234)
        self.assertEqual(reader.messages('wxid_friend')[0]['fullText'], '来自回调的消息')
        self.assertEqual(len(reader.events.pending()), 1)
        callback['newMsgId']='8047442179716189591';callback['toUserName']['String']='other_account'
        call('/api/recvMsg/'+'a'*64, callback)
        self.assertEqual(reader.callback_messages['8047442179716189591']['to'], 'other_account')
        self.assertEqual(len(reader.events.pending()), 2)
        self.assert_no_database_api()
        self.assertEqual(sum(route == '/api/get_profile_new' for route, _ in self.fake.calls), profiles)
        # Component liveness is still checked without fetching login profiles.
        with patch.object(self.api, 'component_identity', side_effect=RuntimeError('HOOK_NOT_LISTENING')):
            with self.assertRaises(urllib.error.HTTPError) as stopped:
                call('/WeChatAgent/health')
            self.assertEqual(stopped.exception.code, 503)
            self.assertEqual(json.load(stopped.exception), {'error': 'HOOK_NOT_LISTENING'})

    def test_voice_intermediate_and_unknown_responses_never_confirm_delivery(self):
        result = normalize_send_response('/SendVoiceMsg', {'baseResponse': {'ret': -2}, 'endFlag': 1, 'msgId': 0, 'newMsgId': '8047442179716189588'})
        self.assertFalse(result['confirmed'])
        self.assertTrue(result['submitted'])
        final = normalize_send_response('/SendVoiceMsg', {'baseResponse': {'ret': 0}, 'endFlag': 2, 'newMsgId': '8047442179716189588'})
        self.assertFalse(final['confirmed'])  # Incomplete upload metadata is not a final receipt.
        with self.assertRaisesRegex(RuntimeError, 'HOOK_SEND_RESPONSE_UNKNOWN'):
            normalize_send_response('/SendTextMsg', {'status': 'maybe'})

    def test_gateway_new_actions_use_cached_quote_members_and_single_staged_mp3_upload(self):
        self.allow_group()
        reader = self.reader()
        self.incoming(reader)
        original = reader.messages('wxid_friend')[0]
        reader.start_native_gateway()
        self.addCleanup(reader.gateway.server_close)
        self.addCleanup(reader.gateway.shutdown)
        headers = {'Authorization': 'Bearer '+'a'*64, 'Content-Type': 'application/json'}
        def call(route, body, supplied_headers=None):
            request = urllib.request.Request(self.api.hook['baseUrl']+route, json.dumps(body).encode(), supplied_headers or headers)
            return json.load(urllib.request.urlopen(request, timeout=5))
        requests = [
            ('/SendAtText', {'wxidorgid': 'room@chatroom', 'msg': '@Friend 你好', 'wxids': ['wxid_friend']}),
            ('/SendPatMsg', {'wxidorgid': 'room@chatroom', 'memberWxid': 'wxid_friend'}),
            ('/SendQuoteMsg', {'wxidorgid': 'wxid_friend', 'replyId': original['rawid'], 'msg': '引用回复',
                              'referContent': '伪造内容', 'fromUsr': 'wxid_forged', 'newmsgid': '1', 'createTime': 0}),
        ]
        mp3 = self.root/'测试语音.mp3'
        mp3.write_bytes(b'\xff\xfb\x90\x00' + bytes(413))
        requests.append(('/SendMp3VoiceMsg', {'wxidorgid': 'wxid_friend', 'path': str(mp3), 'duration': 1000}))
        with patch.object(self.api, 'post', wraps=self.api.post) as posted:
            for route, body in requests:
                self.assertEqual(call(route, body), {'ret': 0, 'submitted': True, 'confirmed': False, 'apiAcknowledged': True})
            mp3_calls = [entry for entry in posted.call_args_list if entry.args[0] == '/api/send_mp3_voice']
        self.assertEqual(len(mp3_calls), 1)
        self.assertEqual(mp3_calls[0].kwargs, {'timeout': 30})
        mapped = [(route, body) for route, body in self.fake.calls if route.startswith('/api/send_')]
        self.assertEqual([route for route, _ in mapped], ['/api/send_at_text', '/api/send_pat', '/api/send_quote', '/api/send_mp3_voice'])
        self.assertEqual(mapped[0][1], {'roomId': 'room@chatroom', 'msg': '@Friend 你好', 'wxids': 'wxid_friend'})
        self.assertEqual(mapped[1][1], {'roomId': 'room@chatroom', 'wxid': 'wxid_friend'})
        self.assertEqual(mapped[2][1]['referContent'], self.fake.full_text)
        self.assertEqual(mapped[2][1]['fromUsr'], 'wxid_friend')
        self.assertEqual(mapped[2][1]['newmsgid'], original['serverId'])
        self.assertEqual(mapped[2][1]['createTime'], original['createTime'])
        self.assertTrue(mapped[3][1]['mp3Path'].isascii())
        self.assertEqual(pathlib.Path(mapped[3][1]['mp3Path']).read_bytes(), mp3.read_bytes())
        for route, body in requests:
            with self.subTest(auth=route), self.assertRaises(urllib.error.HTTPError) as denied:
                call(route, body, {'Authorization': 'Bearer wrong', 'Content-Type': 'application/json'})
            self.assertEqual(denied.exception.code, 401)
        with self.assertRaises(urllib.error.HTTPError) as denied_member:
            call('/SendAtText', {'wxidorgid': 'room@chatroom', 'msg': 'hello', 'wxids': ['wxid_unknown']})
        self.assertEqual(denied_member.exception.code, 403)
        with self.assertRaises(urllib.error.HTTPError) as unknown_quote:
            call('/SendQuoteMsg', {'wxidorgid': 'wxid_friend', 'replyId': 'uncached-reference', 'msg': 'hello'})
        self.assertEqual(unknown_quote.exception.code, 503)
        self.assertEqual(json.load(unknown_quote.exception), {'error': 'HOOK_QUOTE_ORIGINAL_NOT_CACHED'})
        self.assertEqual(len([route for route, _ in self.fake.calls if route.startswith('/api/send_')]), 4)
        self.assert_no_database_api()

    def test_delivered_errcode_send_envelope_only_acknowledges_submission(self):
        ack = {'account_wxid': 'wxid_self', 'data': {}, 'errCode': 1, 'errMsg': '请求处理成功'}
        for route in ('/SendTextMsg', '/SendImageMsg', '/SendFileMsg', '/SendStickerMsg', '/SendVoiceMsg'):
            with self.subTest(route=route):
                expected = {'ret': 0, 'submitted': True, 'confirmed': False}
                if route == '/SendTextMsg':
                    expected['apiAcknowledged'] = True
                self.assertEqual(normalize_send_response(route, ack, 'wxid_self', 'wxid_friend'),
                                 expected)
        # Older envelopes remain valid and never become delivery receipts either.
        for ack in ({'code': 1}, {'code': 1, 'data': None}, {'code': 1, 'errCode': 1},
                    {'code': 1, 'baseResponse': {'ret': 0}, 'data': {'baseResponse': {'ret': 0}}}):
            with self.subTest(ack=ack):
                self.assertEqual(normalize_send_response('/SendTextMsg', ack),
                                 {'ret': 0, 'submitted': True, 'confirmed': False, 'apiAcknowledged': True})
        self.assertFalse(normalize_send_response('/SendTextMsg', {'errCode': 1})['confirmed'])

    def test_send_envelope_account_is_informational_in_single_account_mode(self):
        for account in ('wxid_other', '', None, 1, {}, ['wxid_self']):
            for code in ('code', 'errCode'):
                with self.subTest(account=account, code=code):
                    self.assertTrue(normalize_send_response('/SendTextMsg', {code: 1, 'account_wxid': account}, 'wxid_self')['apiAcknowledged'])
        self.assertTrue(normalize_send_response('/SendTextMsg', {'errCode': 1, 'account_wxid': 'wxid_self'})['apiAcknowledged'])

    def test_failed_unknown_and_conflicting_send_envelopes_are_not_accepted(self):
        for result in ({'errCode': 0}, {'errCode': -1}, {'errCode': 2}, {'code': 1, 'errCode': 0}, {'code': 0, 'errCode': 1}):
            with self.subTest(result=result):
                self.assertEqual(normalize_send_response('/SendTextMsg', {**result, 'errMsg': '请求处理成功'}),
                                 {'ret': -1, 'submitted': False, 'confirmed': False})
        for result in ({'errCode': '1'}, {'errCode': True}, {'errCode': 1.0}, {'errCode': None}, {'code': True}, {'data': {}, 'errMsg': '请求处理成功'}):
            with self.subTest(result=result):
                with self.assertRaisesRegex(RuntimeError, '^HOOK_SEND_RESPONSE_UNKNOWN$'):
                    normalize_send_response('/SendTextMsg', result)

    def test_outer_text_success_never_overrides_explicit_native_failure(self):
        for result in ({'code': 1, 'baseResponse': {'ret': -1}},
                       {'errCode': 1, 'data': {'baseResponse': {'ret': -2}}},
                       {'code': 1, 'errCode': 1, 'baseResponse': {'ret': 0}, 'data': {'baseResponse': {'ret': -3}}},
                       {'code': 1, 'baseResponse': {'ret': -4}, 'data': {'baseResponse': {'ret': 0}}}):
            with self.subTest(result=result):
                self.assertEqual(normalize_send_response('/SendTextMsg', result),
                                 {'ret': -1, 'submitted': False, 'confirmed': False})

    def test_nontext_generic_ack_preserves_existing_media_submission_behavior(self):
        for route in ('/SendVoiceMsg',):
            for result in ({'code': 1, 'data': []},
                           {'errCode': 1, 'baseResponse': {'ret': -2}, 'endFlag': 1},
                           {'code': 1, 'data': {'baseResponse': {'ret': -1}}}):
                with self.subTest(route=route, result=result):
                    self.assertEqual(normalize_send_response(route, result),
                                     {'ret': 0, 'submitted': True, 'confirmed': False})
            for result in ({'code': 1, 'errCode': 0}, {'errCode': True}):
                with self.subTest(route=route, result=result):
                    if type(result.get('errCode')) is not int:
                        with self.assertRaisesRegex(RuntimeError, '^HOOK_SEND_RESPONSE_UNKNOWN$'):
                            normalize_send_response(route, result)
                    else:
                        self.assertEqual(normalize_send_response(route, result),
                                         {'ret': -1, 'submitted': False, 'confirmed': False})

    def test_media_receipts_require_matching_target_and_string_server_id(self):
        native = {'baseResponse': {'ret': 0}, 'toUserName': 'wxid_friend', 'newMsgId': '8047442179716189588'}
        for route in ('/SendImageMsg', '/SendFileMsg', '/SendStickerMsg'):
            for response in (native, {'code': 1, 'data': native}, {'errCode': 1, **native}):
                with self.subTest(route=route, response=response):
                    self.assertEqual(normalize_send_response(route, response, target='wxid_friend'),
                                     {'ret': 0, 'submitted': True, 'confirmed': True,
                                      'serverId': native['newMsgId'], 'target': 'wxid_friend',
                                      'receipt': 'wechat-message-response'})
            for changes in ({'toUserName': 'other'}, {'newMsgId': 8047442179716189588},
                            {'newMsgId': '0'}, {'newMsgId': ''}, {'newMsgId': '1'*21}):
                with self.subTest(route=route, changes=changes):
                    result = normalize_send_response(route, {**native, **changes}, target='wxid_friend')
                    self.assertEqual(result, {'ret': 0, 'submitted': True, 'confirmed': False})
            for response in ({'code': 1}, {'baseResponse': {'ret': 0}}, {'errCode': 1, 'data': {}}):
                self.assertEqual(normalize_send_response(route, response, target='wxid_friend'),
                                 {'ret': 0, 'submitted': True, 'confirmed': False})
            incomplete = {'baseResponse': {'ret': 0}, 'newMsgId': native['newMsgId']}
            self.assertFalse(normalize_send_response(route, incomplete)['confirmed'])
            self.assertFalse(normalize_send_response(route, {'code': 1, 'data': incomplete})['confirmed'])
            for response in ({**native, 'baseResponse': {'ret': -1}},
                             {'code': 1, 'data': {**native, 'baseResponse': {'ret': -1}}}):
                self.assertEqual(normalize_send_response(route, response, target='wxid_friend'),
                                 {'ret': -1, 'submitted': False, 'confirmed': False})

    def test_malformed_send_envelope_types_remain_unknown(self):
        for result in ({'code': 1, 'errCode': True}, {'code': '1', 'errCode': 1},
                       {'code': 1, 'data': []}, {'errCode': 1, 'data': 'ok'},
                       {'code': 1, 'baseResponse': None}, {'code': 1, 'baseResponse': []},
                       {'code': 1, 'baseResponse': {}}, {'code': 1, 'baseResponse': {'ret': True}},
                       {'code': 1, 'baseResponse': {'ret': '0'}}, {'code': 1, 'baseResponse': {'ret': 0.0}},
                       {'errCode': 1, 'data': {'baseResponse': None}},
                       {'errCode': 1, 'data': {'baseResponse': {'ret': None}}},
                       {'errCode': 1, 'data': {'baseResponse': {'ret': False}}},
                       {'code': 0, 'data': {'baseResponse': {'ret': '0'}}}):
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
                             {'ret': 0, 'submitted': True, 'confirmed': False, 'apiAcknowledged': True})
        file = self.image_file()
        self.assertEqual(call('/SendImageMsg', {'wxidorgid': 'wxid_friend', 'path': str(file), 'size': file.stat().st_size, 'md5': hashlib.md5(file.read_bytes()).hexdigest()}),
                         {'ret': 0, 'submitted': True, 'confirmed': False})
        self.assertEqual(len([route for route, _ in self.fake.calls if route.startswith('/api/send_')]), 3)
        # An API acknowledgement cannot invent an observed outgoing callback.
        self.assertEqual(reader.messages('wxid_friend'), [])
        response_account[0] = 'wxid_other'
        self.assertTrue(call('/SendTextMsg', {'wxidorgid': 'wxid_friend', 'msg': '第三句'})['apiAcknowledged'])
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
        reader = self.reader()
        for index, xml in enumerate((f'<msg><img md5="{md5}"/></msg>', '<msg><img md5="not-a-hash"/></msg>'), start=3):
            self.incoming(reader, kind=3, content=xml, local_id=index,
                          server_id=str(8047442179716189590+index), timestamp=1700000000+index)
        with self.assertRaisesRegex(ValueError, 'XML_UNSAFE'):
            self.incoming(reader, kind=3, local_id=5, server_id='8047442179716189595',
                          content='<!DOCTYPE msg [<!ENTITY leak "private">]><msg><img md5="&leak;"/></msg>')
        rows = {row['localId']: row for row in reader.messages('wxid_friend')}
        self.assertEqual(rows[3]['imageMd5'], md5.lower())
        self.assertNotIn('imageMd5', rows[4])
        self.assertNotIn(5, rows)

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
        reader = self.reader()
        self.incoming(reader, kind=3, content=xml, local_id=1234, server_id='8047442179716189590', timestamp=1700000002)
        message = reader.messages('wxid_friend')[0]
        payload = reader.make_payload('wxid_friend', message)
        image_id = reader.register_image('wxid_friend', payload)
        bound_callback = reader.callback_messages.pop('8047442179716189590')
        with self.assertRaisesRegex(RuntimeError, 'IMAGE_CALLBACK_METADATA_REQUIRED'):
            reader.resolve_image(image_id)
        reader.callback_messages['8047442179716189590'] = bound_callback
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
        reader = self.reader()
        self.incoming(reader, kind=3, content=xml, local_id=1234 if callback else 0,
                      server_id='8047442179716189590', timestamp=1700000002)
        message = reader.messages('wxid_friend')[0]
        image_id = reader.register_image('wxid_friend',reader.make_payload('wxid_friend',message))
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

    def test_cached_image_download_restores_callback_metadata_after_reader_restart(self):
        reader, image_id = self.image_fixture('length="{size}"')
        reader.events.close()
        restarted = self.reader()
        result = restarted.resolve_image(image_id)
        self.assertEqual(result['imageId'], image_id)
        self.assertTrue(result['b64'])
        body = next(body for route, body in self.fake.calls if route == '/api/download_img')
        self.assertEqual(body['MsgId'], 1234)
        self.assert_no_database_api()

    def test_duplicate_callback_cannot_rebind_cached_image_short_id(self):
        reader, image_id = self.image_fixture('length="{size}"')
        self.incoming(reader, kind=3, local_id=9999, server_id='8047442179716189590', timestamp=1700000002,
                      content='<msg><img length="'+str(len(self.fake.image_bytes))+'"/></msg>')
        self.assertTrue(reader.resolve_image(image_id)['b64'])
        body = next(body for route, body in self.fake.calls if route == '/api/download_img')
        self.assertEqual(body['MsgId'], 1234)

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

    def test_image_download_does_not_repeat_login_account_checks(self):
        reader,image_id = self.image_fixture('cdnmidimgurl="message-bound-file" aeskey="'+'ab'*16+'"',callback=False)
        transport=self.api.transport
        def download(route,body):
            response=transport(route,body)
            if route=='/api/cdn_download':self.fake.wxid='other_account'
            return response
        self.api.transport=download
        profiles = sum(route == '/api/get_profile_new' for route, _ in self.fake.calls)
        with patch.object(self.api, 'identity', side_effect=AssertionError('media must not query login accounts')):
            self.assertTrue(reader.resolve_image(image_id)['b64'])
        self.assertEqual(sum(route == '/api/get_profile_new' for route, _ in self.fake.calls), profiles)
        self.assertTrue((runtime_directory(self.root)/'incoming-images'/(image_id+'.image')).exists())

    def test_file_download_is_scoped_to_exact_message_and_verified_by_hash(self):
        config = json.loads((self.root/'config/wechatagent.json').read_text())
        key = 'wechat:private:'+reader_module.onebot_id('wxid_friend')
        config['wechat']['workModes'] = {key: 'assistant'}
        config['wechat']['assistant'] = {'fileTransferChats': {key: True}, 'administrators': ['wxid_friend']}
        self.write('config/wechatagent.json', config)
        md5 = hashlib.md5(b'file-data').hexdigest()
        xml = '<msg><appmsg><type>6</type><title>fixture.txt</title><appattach><totallen>9</totallen><attachid>fixture-cdn</attachid><md5>'+md5+'</md5></appattach></appmsg></msg>'
        reader = self.reader()
        self.incoming(reader, kind=49, content=xml, local_id=3, server_id='8047442179716189590', timestamp=1700000002)
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

    def test_component_integrity_remains_required_without_account_comparison(self):
        self.assertEqual(self.api.identity()['pid'], 42)
        self.fake.wxid = 'wxid_other'
        self.assertEqual(self.api.identity()['wxid'], 'wxid_other')
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
