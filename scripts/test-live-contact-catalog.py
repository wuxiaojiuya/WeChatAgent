"""Add-chat catalogs are fetched directly from Hook on every request."""
import concurrent.futures
import json
import pathlib
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import hook_receiver_core as receiver


def contact(username, name='', **fields):
    return {'username': username, 'ret': 0, 'contact': {
        'userName': {'String': username}, 'nickName': {'String': name},
        'bitVal': 3, 'verifyFlag': 0, **fields}}


class LiveApi:
    def __init__(self):
        self.friends = [contact('wxid_latest', 'Latest friend')]
        self.groups = [contact('latest@chatroom', 'Latest group')]
        self.calls, self.error = [], ''
        self.gate = None
        self.two_requests = threading.Event()
        self.lock = threading.Lock()

    def post(self, route, body=None, *, timeout=None):
        with self.lock:
            self.calls.append((route, body, timeout))
            if len(self.calls) >= 2:
                self.two_requests.set()
        if self.gate:
            if not self.gate.wait(5):
                raise AssertionError('Concurrent catalog request did not finish')
        if self.error:
            raise RuntimeError(self.error)
        if route == '/api/update_all_friend':
            return {'contact_list': self.friends, 'friend_count': len(self.friends)}
        if route == '/api/get_chatroom_list':
            return {'data': self.groups}
        raise AssertionError('Picker must use dedicated live APIs, never cached or database APIs')


class LiveContactCatalog(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        (self.root/'config').mkdir()
        self.project = {'wechat': {'whitelist': {
            'private': [receiver.onebot_id('wxid_cached')], 'groups': []}}}
        self.file = self.root/'config/wechatagent.json'
        self.file.write_text(json.dumps(self.project), encoding='utf-8')
        self.api = LiveApi()
        self.reader = reader = receiver.HookReceiver.__new__(receiver.HookReceiver)
        reader.root, reader.account = self.root, self.root/'account'
        reader.account.mkdir()
        reader.own_wxid, reader.api = 'wxid_owner', self.api
        reader.names = {'wxid_cached': 'Old friend', 'cached@chatroom': 'Old group'}
        reader.friend_contacts = {'wxid_cached': {'displayName': 'Old friend', 'searchTerms': []}}
        reader.contact_catalog_error = ''
        reader.names_lock, reader.names_refreshed_at = threading.Lock(), 10**12
        reader.group_bindings = receiver.GroupBindings(self.root, reader.account, readonly=False)
        reader.group_bindings.reconcile(reader.names)
        reader.legacy_group_hints = lambda allowed: {}
        reader.active_identity = lambda: {'wxid': 'wxid_owner'}

    def test_each_private_request_uses_full_api_and_only_that_response(self):
        self.assertEqual([c['displayName'] for c in self.reader.contacts(kind='private')], ['Latest friend'])
        self.api.friends = [contact('wxid_new', 'Newly added friend')]
        self.assertEqual([c['displayName'] for c in self.reader.contacts(kind='private')], ['Newly added friend'])
        self.assertEqual(self.api.calls, [('/api/update_all_friend', {}, 120)]*2)
        self.assertEqual(json.loads(self.file.read_text(encoding='utf-8')), self.project)

    def test_deleted_nonfriends_system_and_own_account_never_become_picker_friends(self):
        self.api.friends.extend([contact('wxid_owner', 'Self'), contact('filehelper', 'System'),
            contact('weixin', 'WeChat team'), contact('gh_official', 'Official', verifyFlag=24),
            contact('wxid_deleted', 'Deleted', delete_flag=1),
            contact('wxid_stranger', 'Stranger', bitVal=2), contact('member@chatroom', 'Group')])
        self.assertEqual([c['username'] for c in self.reader.contacts(kind='private')], ['wxid_latest'])
        self.api.friends = []
        self.assertEqual(self.reader.contacts(kind='private'), [])
        self.assertEqual(len(self.api.calls), 2)

    def test_api_failure_is_an_error_without_cached_list_fallback(self):
        self.api.error = 'HOOK_UPSTREAM_TIMEOUT'
        with self.assertRaisesRegex(RuntimeError, '^HOOK_UPSTREAM_TIMEOUT$'):
            self.reader.contacts(kind='private')
        self.api.error = ''
        self.assertEqual([c['username'] for c in self.reader.contacts(kind='private')], ['wxid_latest'])
        self.assertEqual(len(self.api.calls), 2)

    def test_invalid_relationships_do_not_return_previous_friend_proof(self):
        self.api.friends = [contact('wxid_unproven', 'Unproven', bitVal=None)]
        with self.assertRaisesRegex(RuntimeError, '^CONTACT_FRIENDSHIP_METADATA_UNAVAILABLE$'):
            self.reader.contacts(kind='private')
        self.assertEqual(self.api.calls, [('/api/update_all_friend', {}, 120)])

    def test_groups_query_only_current_group_api_each_time(self):
        first = self.reader.contacts(kind='groups')
        self.assertEqual([c['displayName'] for c in first], ['Latest group'])
        self.api.groups = [contact('other@chatroom', 'Newly joined group')]
        second = self.reader.contacts(kind='groups')
        self.assertEqual([c['displayName'] for c in second], ['Newly joined group'])
        self.assertTrue(all(c['username'] != 'cached@chatroom' for c in second))
        self.assertEqual(self.api.calls, [('/api/get_chatroom_list', None, None)]*2)

    def test_group_failure_does_not_return_old_groups(self):
        self.api.error = 'HOOK_UPSTREAM_TIMEOUT'
        with self.assertRaisesRegex(RuntimeError, '^HOOK_UPSTREAM_TIMEOUT$'):
            self.reader.contacts(kind='groups')
        self.assertEqual(self.api.calls, [('/api/get_chatroom_list', None, None)])

    def test_search_runs_fresh_query_before_filtering_new_names(self):
        self.assertEqual(self.reader.contacts('Renamed', 'private'), [])
        self.api.friends[0]['contact']['nickName']['String'] = 'Renamed friend'
        self.assertEqual([c['displayName'] for c in self.reader.contacts('Renamed', 'private')], ['Renamed friend'])
        self.assertEqual(len(self.api.calls), 2)

    def test_parallel_requests_do_not_reuse_an_earlier_query_or_block_callback_lock(self):
        self.api.gate = threading.Event()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            requests = [pool.submit(self.reader.contacts, kind='private') for _ in range(2)]
            try:
                self.assertTrue(self.api.two_requests.wait(3), 'Each request must reach Hook independently')
                self.assertTrue(self.reader.names_lock.acquire(blocking=False), 'Network calls must not hold metadata lock')
                self.reader.names_lock.release()
            finally:
                self.api.gate.set()
            for request in requests:
                self.assertEqual(request.result(timeout=5)[0]['username'], 'wxid_latest')
        self.assertEqual(self.api.calls, [('/api/update_all_friend', {}, 120)]*2)


if __name__ == '__main__':
    unittest.main()
