"""Hook-only entrypoint regressions, using isolated configuration and imports."""
import ast
import json
import pathlib
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
