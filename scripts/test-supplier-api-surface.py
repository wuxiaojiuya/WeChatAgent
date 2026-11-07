"""Offline regression coverage for the dedicated supplier HTTP surface."""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import supplier_api


class SupplierSurface(unittest.TestCase):
    def test_removed_database_compatibility_surface_cannot_be_used(self):
        for method in ('databases', 'query'):
            self.assertFalse(hasattr(supplier_api.SupplierApi, method))
        for symbol in ('RemoteCursor', 'RemoteConnection', 'bind_sql', 'split_projection'):
            self.assertFalse(hasattr(supplier_api, symbol))
        source = pathlib.Path(supplier_api.__file__).read_text(encoding='utf-8')
        for route in ('/api/get_db_handle', '/api/sqlite3_exec'):
            self.assertNotIn(route, source)

    def test_existing_post_transport_and_media_timeout_contracts_are_preserved(self):
        api = object.__new__(supplier_api.SupplierApi)
        calls = []
        api.transport = lambda route, body: calls.append((route, body)) or {'code': 1}
        self.assertEqual(api.post('/api/get_room_members', {'room_id': '123@chatroom'}), {'code': 1})
        self.assertEqual(calls, [('/api/get_room_members', {'room_id': '123@chatroom'})])
        for route in ('/arbitrary/path', '/api/get_db_handle', '/api/sqlite3_exec', '/api/unreviewed_action'):
            with self.subTest(route=route), self.assertRaisesRegex(ValueError, '^HOOK_ROUTE_INVALID$'):
                api.post(route)
        self.assertEqual(len(calls), 1)
        self.assertEqual(supplier_api.VOICE_UPLOAD_TIMEOUT_SECONDS, 30)
        self.assertEqual(supplier_api.IMAGE_UPLOAD_TIMEOUT_SECONDS, 30)

    def test_component_inspection_stays_separate_from_single_profile_read(self):
        api = object.__new__(supplier_api.SupplierApi)
        components, routes = [], []
        api.component_identity = lambda: components.append(True) or {'pid': 42, 'version': '4.1.8.27'}
        api.post = lambda route: routes.append(route) or {'baseResponse': {'ret': 0}, 'userInfo': {'userName': {'String': 'wxid_offline'}}}
        self.assertEqual(api.identity(), {'wxid': 'wxid_offline', 'pid': 42, 'version': '4.1.8.27'})
        self.assertEqual(routes, ['/api/get_profile_new'])
        self.assertEqual(components, [True])


if __name__ == '__main__':
    unittest.main()
