"""Hook-only entrypoint regressions, using isolated configuration and imports."""
import ast
import json
import pathlib
import queue
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import hook_receiver_core as receiver
import supplier_reader
from wechat_media import clean_account_wxid


class CallbackAuthorization(unittest.TestCase):
    """The contact picker is not the authorization source for incoming chats."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.project = {'hook': {'baseUrl': 'http://127.0.0.1:19001'},
                        'wechat': {'whitelist': {'private': [receiver.onebot_id('wxid_missing')], 'groups': []}}}
        (self.root/'config').mkdir()
        self.save_project()
        self.reader = reader = receiver.HookReceiver.__new__(receiver.HookReceiver)
        reader.root, reader.own_wxid = self.root, 'wxid_owner'
        reader.account = self.root/'state/hook/accounts/wxid_owner'
        reader.account.mkdir(parents=True)
        reader.names, reader.friend_contacts = {'wxid_catalog': 'Known friend'}, {}
        reader.contact_catalog_error = ''
        reader.group_bindings = receiver.GroupBindings(self.root, reader.account, readonly=False)
        reader.events = receiver.SupplierEventStore(reader.account/'events.json')
        self.addCleanup(reader.events.close)
        reader.callback_messages, reader.callback_lock = {}, threading.Lock()
        reader.callback_wake = threading.Event()
        self.client = queue.Queue(maxsize=10)
        reader.clients, reader.lock = {self.client}, threading.Lock()
        reader.pushed = 0
        reader.refresh_names = lambda **kwargs: None
        reader.live_contact_catalog = lambda kind='': ({}, {})

    def save_project(self):
        (self.root/'config/wechatagent.json').write_text(json.dumps(self.project), encoding='utf-8')

    def callback(self, sender='wxid_missing', **extra):
        return {'fromUserName': {'String': sender}, 'toUserName': {'String': 'wxid_owner'},
                'content': {'String': 'hello'}, 'msgType': '1', 'createTime': '1780000000',
                'msgId': '101', 'newMsgId': '18446744073709550001', 'msgSource': '', **extra}

    def test_authorized_private_callback_survives_missing_catalog_without_becoming_friend(self):
        reader = self.reader
        original_project = json.loads(json.dumps(self.project))
        self.assertNotIn('wxid_missing', reader.selected_talkers())
        self.assertEqual(reader.accept_callback(self.callback()), 1)
        self.assertIn('wxid_missing', reader.selected_talkers())
        self.assertNotIn('wxid_missing', reader.names)
        self.assertEqual(reader.friend_contacts, {})
        self.assertEqual(reader.contacts(kind='private'), [])
        self.assertEqual(reader.sessions()[0]['username'], 'wxid_missing')
        self.assertEqual(len(reader.messages('wxid_missing')), 1)
        reader.dispatch_pending()
        payload = self.client.get_nowait()
        self.assertEqual(payload['conversationId'], receiver.onebot_id('wxid_missing'))
        self.assertEqual(payload['content'], 'hello')
        self.assertEqual(reader.pushed, 1)
        self.assertEqual(receiver.read_json(self.root/'config/wechatagent.json'), original_project)

    def test_unknown_unauthorized_callbacks_are_neither_cached_nor_selected(self):
        self.assertEqual(self.reader.accept_callback(self.callback('wxid_stranger')), 0)
        self.assertEqual(self.reader.events.messages('wxid_stranger'), [])
        self.assertEqual(self.reader.selected_talkers(), [])
        self.assertFalse(self.reader.callback_wake.is_set())
        with self.assertRaises(PermissionError):
            self.reader.messages('wxid_stranger')
        self.reader.dispatch_pending()
        self.assertTrue(self.client.empty())

    def test_missing_catalog_callback_is_deduplicated_across_dispatch_and_restart(self):
        body = self.callback()
        self.assertEqual(self.reader.accept_callback(body), 1)
        self.assertEqual(self.reader.accept_callback(body), 0)
        self.reader.dispatch_pending()
        self.assertEqual(self.client.qsize(), 1)
        self.reader.events.close()
        self.reader.events = receiver.SupplierEventStore(self.reader.account/'events.json')
        self.addCleanup(self.reader.events.close)
        self.assertIn('wxid_missing', self.reader.selected_talkers())
        self.assertEqual(self.reader.accept_callback(body), 0)
        self.reader.dispatch_pending()
        self.assertEqual(self.client.qsize(), 1)
        self.assertEqual(self.reader.pushed, 1)

    def test_whitelist_removal_discards_pending_callbacks_and_cached_send_target(self):
        self.reader.accept_callback(self.callback())
        self.project['wechat']['whitelist']['private'] = []
        self.save_project()
        self.reader.dispatch_pending()
        self.assertTrue(self.client.empty())
        self.assertEqual(self.reader.events.pending(), [])
        self.assertEqual(self.reader.selected_talkers(), [])
        with self.assertRaises(PermissionError):
            self.reader.messages('wxid_missing')
        self.assertEqual(self.reader.accept_callback(self.callback(newMsgId='18446744073709550002')), 0)

    def test_whitelist_removal_during_media_preparation_prevents_ai_delivery(self):
        self.reader.accept_callback(self.callback())
        def revoke(*args):
            self.project['wechat']['whitelist']['private'] = []
            self.save_project()
        with patch.object(self.reader, 'quote_media', side_effect=revoke):
            self.reader.dispatch_pending()
        self.assertTrue(self.client.empty())
        self.assertEqual(self.reader.events.pending(), [])

    def test_display_name_changes_do_not_grant_a_different_wxid_permission(self):
        self.reader.accept_callback(self.callback(sender_nick='Shared name'))
        self.reader.names.update(wxid_missing='Changed name', wxid_stranger='Changed name')
        self.assertEqual(self.reader.accept_callback(self.callback('wxid_stranger', sender_nick='Changed name')), 0)
        self.assertEqual(self.reader.selected_talkers(), ['wxid_missing'])
        self.reader.dispatch_pending()
        self.assertEqual(self.client.get_nowait()['conversationId'], receiver.onebot_id('wxid_missing'))

    def test_group_member_observation_does_not_create_a_private_chat_candidate(self):
        self.reader.names['room@chatroom'] = 'Selected room'
        group_id = receiver.onebot_id('Selected room')
        self.project['wechat']['whitelist']['groups'] = [group_id]
        self.save_project()
        self.reader.group_bindings.reconcile(self.reader.names, [group_id])
        body = self.callback('room@chatroom', content={'String': 'wxid_missing:\nhello'},
                             member_info={'userName': 'wxid_missing', 'nickName': 'Member'})
        self.assertEqual(self.reader.accept_callback(body), 1)
        self.assertEqual(self.reader.selected_talkers(), ['room@chatroom'])
        self.assertEqual(self.reader.friend_contacts, {})
        self.assertEqual(self.reader.events.messages('wxid_missing'), [])
        self.reader.dispatch_pending()
        self.assertEqual(self.client.get_nowait()['talkerId'], 'wxid_missing')

    def test_send_gateway_resolves_only_currently_authorized_accepted_private_target(self):
        sent = []
        self.reader.api = SimpleNamespace(hook=self.project['hook'],
            post=lambda route, body: sent.append((route, body)) or {'code': 1})
        self.reader.startup_identity = {'wxid': self.reader.own_wxid}
        (self.root/'state/hook/native-token.txt').write_text('a'*64, encoding='utf-8')
        server_type = supplier_reader.ThreadingHTTPServer
        def ephemeral_server(address, handler):
            return server_type(('127.0.0.1', 0), handler)
        with patch.object(supplier_reader, 'ThreadingHTTPServer', side_effect=ephemeral_server):
            server = supplier_reader.start_gateway(self.reader)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        def send():
            request = urllib.request.Request('http://127.0.0.1:'+str(server.server_port)+'/SendTextMsg',
                json.dumps({'wxidorgid': 'wxid_missing', 'msg': 'reply'}).encode(),
                {'Authorization': 'Bearer '+'a'*64, 'Content-Type': 'application/json'})
            return json.load(urllib.request.urlopen(request, timeout=5))
        with self.assertRaises(urllib.error.HTTPError) as denied:
            send()
        self.assertEqual(denied.exception.code, 403)
        self.reader.accept_callback(self.callback())
        self.assertEqual(send()['ret'], 0)
        self.assertEqual(sent, [('/api/send_text_msg', {'wxid': 'wxid_missing', 'msg': 'reply'})])
        self.project['wechat']['whitelist']['private'] = []
        self.save_project()
        with self.assertRaises(urllib.error.HTTPError) as revoked:
            send()
        self.assertEqual(revoked.exception.code, 403)
        self.assertEqual(len(sent), 1)


class HookOnlyReceiver(unittest.TestCase):
    def test_receiver_has_no_database_base_class_or_legacy_entrypoints(self):
        self.assertEqual(receiver.HookReceiver.__bases__, (object,))
        for name in ('open_messages', 'load_contact_catalog'):
            self.assertFalse(hasattr(receiver.HookReceiver, name))
        self.assertFalse(hasattr(supplier_reader, 'create_reader'))
        self.assertFalse(hasattr(receiver, 'nt'))

    def test_import_and_runtime_probe_work_when_client_database_imports_are_forbidden(self):
        scripts = pathlib.Path(__file__).resolve().parent
        program = '''import builtins, runpy, sys
original = builtins.__import__
def guarded(name, *args, **kwargs):
    if name.split('.')[0] in ('nt_decrypt', 'nt_common', 'sqlcipher3', 'sqlite3'):
        raise AssertionError('Client database dependency imported: '+name)
    return original(name, *args, **kwargs)
builtins.__import__ = guarded
sys.argv = [sys.argv[1], '--check-runtime']
runpy.run_path(sys.argv[0], run_name='__main__')
'''
        result = subprocess.run([sys.executable, '-B', '-c', program, str(scripts/'hook-receiver.py')],
                                capture_output=True, text=True, encoding='utf-8', timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'ok': True, 'receiverReady': True, 'backend': 'supplier-http', 'wechatVersion': '4.1.8.27'})

    def test_only_the_new_connection_contract_is_read_before_hook_access(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(receiver, 'SupplierApi') as api:
            root = pathlib.Path(temporary)
            # A legacy configuration can exist after upgrading, but is not an input.
            legacy = root/'state/weflow/WeFlow-config.json'
            legacy.parent.mkdir(parents=True)
            legacy.write_text('{"dbPath":"must-not-be-read"}', encoding='utf-8')
            with self.assertRaisesRegex(RuntimeError, '^HOOK_CONNECTION_REQUIRED$'):
                receiver.HookReceiver(root)
            connection = root/'state/hook/connection.json'
            connection.parent.mkdir(parents=True)
            good = {'version': 1, 'backend': 'supplier-http', 'wechatVersion': '4.1.8.27', 'ownWxid': 'wxid_self'}
            for changed in ({'version': True}, {'version': 2}, {'backend': 'other'},
                            {'wechatVersion': '4.1.10.27'}, {'ownWxid': '../outside'}, {'ownWxid': None}):
                connection.write_text(json.dumps({**good, **changed}), encoding='utf-8')
                with self.subTest(changed=changed), self.assertRaisesRegex(RuntimeError, '^HOOK_CONNECTION_CONFIG_INVALID$'):
                    receiver.HookReceiver(root)
            api.assert_not_called()

    def test_hook_identity_does_not_use_legacy_account_directory_suffix_rules(self):
        self.assertEqual(clean_account_wxid('wxid_person_abcd'), 'wxid_person_abcd')
        message = {'senderUsername': 'wxid_person_abcd', 'localType': 1,
                   'fullText': 'hello', 'createTime': 1, 'serverId': '123', 'localId': 2}
        self.assertIsNotNone(receiver.push_payload('wxid_person_abcd', message, {}, 'wxid_person_efgh'))

    def test_http_sessions_status_and_media_errors_use_only_receiver_interfaces(self):
        ready, servers = threading.Event(), []
        def factory(port, handler):
            server = receiver.ThreadingHTTPServer(('127.0.0.1', 0), handler)
            servers.append(server);ready.set()
            return server
        def unavailable_voice(*args):
            raise RuntimeError('VOICE_CALLBACK_METADATA_REQUIRED')
        def unavailable_image(*args):
            error = RuntimeError('IMAGE_STICKER_LOCAL_COPY_UNAVAILABLE')
            error.reason = 'STICKER_CDN_DISABLED'
            raise error
        # There is intentionally no open_messages or other database-like interface.
        fixture = SimpleNamespace(start_native_gateway=lambda:None, poll=lambda:None,
            stop=threading.Event(), backend='supplier-http', last_poll=0, started_at=1,
            contact_catalog_error='', last_error='', clients=set(), pushed=0,
            own_wxid='wxid_self', account=pathlib.Path('project-cache'), image_index={}, image_error='',
            sessions=lambda limit:[{'username':'wxid_friend','displayName':'Friend','type':0}],
            resolve_voice=unavailable_voice, resolve_image=unavailable_image,
            sticker_executor=SimpleNamespace(shutdown=lambda **kwargs:None),
            sticker_review_executor=SimpleNamespace(shutdown=lambda **kwargs:None))
        with patch.object(receiver, 'create_reader_server', factory):
            thread = threading.Thread(target=receiver.serve, args=(fixture, 0, 'fixture-token'), daemon=True)
            thread.start();self.assertTrue(ready.wait(5))
            base = 'http://127.0.0.1:'+str(servers[0].server_port)
            def get(route):
                request = urllib.request.Request(base+route, headers={'Authorization':'Bearer fixture-token'})
                try:
                    with urllib.request.urlopen(request, timeout=5) as response:
                        return response.status, json.load(response)
                except urllib.error.HTTPError as error:
                    return error.code, json.load(error)
            try:
                status, data = get('/api/v1/sessions')
                self.assertEqual(status, 200)
                self.assertEqual(data['sessions'][0]['username'], 'wxid_friend')
                status, data = get('/api/v1/receiver/status')
                self.assertEqual(status, 200)
                self.assertFalse(data['wechatDatabaseAccess'])
                self.assertEqual(data['historySource'], 'project-cache')
                self.assertEqual(data['ownWxid'], 'wxid_self')
                self.assertNotIn('accountDirectory', data)
                self.assertEqual(get('/api/v1/voices/'+'a'*64)[1]['error'], 'VOICE_CALLBACK_METADATA_REQUIRED')
                image = get('/api/v1/images/'+'a'*64)[1]
                self.assertEqual(image['error'], 'IMAGE_STICKER_LOCAL_COPY_UNAVAILABLE')
                self.assertEqual(image['reason'], 'STICKER_CDN_DISABLED')
            finally:
                servers[0].shutdown();thread.join(5)


if __name__ == '__main__':
    unittest.main()
