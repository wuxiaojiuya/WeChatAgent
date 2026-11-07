"""Offline request-contract tests for dedicated supplier message actions."""
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from supplier_actions import map_supplier_action


class SupplierActions(unittest.TestCase):
    def test_at_uses_documented_fields_and_trusted_members(self):
        route, body = map_supplier_action('/SendAtText', {'wxidorgid': '123@chatroom', 'msg': '@测试 你好', 'wxids': ['wxid_a', 'wxid_b', 'wxid_a']}, members={'wxid_a', 'wxid_b'})
        self.assertEqual(route, '/api/send_at_text')
        self.assertEqual(body, {'roomId': '123@chatroom', 'msg': '@测试 你好', 'wxids': 'wxid_a,wxid_b'})
        self.assertEqual(map_supplier_action('/SendAtText', {'wxidorgid': '123@chatroom', 'msg': '大家好', 'wxids': 'notify@all'})[1]['wxids'], 'notify@all')
        for values in ('', 'wxid_a,123@chatroom', ['wxid_a', 'notify@all'], ['a,b'], True):
            with self.subTest(values=values), self.assertRaises(ValueError):
                map_supplier_action('/SendAtText', {'wxidorgid': '123@chatroom', 'msg': 'hello', 'wxids': values})
        with self.assertRaises(PermissionError):
            map_supplier_action('/SendAtText', {'wxidorgid': '123@chatroom', 'msg': 'hello', 'wxids': ['wxid_c']}, members={'wxid_a'})
        with self.assertRaises(ValueError):
            map_supplier_action('/SendAtText', {'wxidorgid': 'wxid_a', 'msg': 'hello', 'wxids': ['wxid_a']})

    def test_pat_binds_member_to_private_or_group_conversation(self):
        self.assertEqual(map_supplier_action('/SendPatMsg', {'wxidorgid': 'wxid_a', 'memberWxid': 'wxid_a'}), ('/api/send_pat', {'roomId': 'wxid_a', 'wxid': 'wxid_a'}))
        self.assertEqual(map_supplier_action('/SendPatMsg', {'wxidorgid': '123@chatroom', 'wxid': 'wxid_a'}, members={'wxid_a'})[1], {'roomId': '123@chatroom', 'wxid': 'wxid_a'})
        with self.assertRaises(PermissionError):
            map_supplier_action('/SendPatMsg', {'wxidorgid': 'wxid_a', 'wxid': 'wxid_other'})
        with self.assertRaises(PermissionError):
            map_supplier_action('/SendPatMsg', {'wxidorgid': '123@chatroom', 'wxid': 'wxid_other'}, members={'wxid_a'})

    def test_quote_uses_cached_metadata_not_untrusted_request(self):
        trusted = {'conversationWxid': '123@chatroom', 'referContent': '<msg>原始内容</msg>', 'fromUsr': 'wxid_a', 'newmsgid': '843118478561634774', 'createTime': 1761396536, 'msgSource': ''}
        supplied = {'wxidorgid': '123@chatroom', 'msg': '这是回复', 'referContent': '伪造', 'fromUsr': 'wxid_forged', 'newmsgid': '1', 'createTime': 0, 'msgSource': '伪造'}
        route, body = map_supplier_action('/SendQuoteMsg', supplied, quote=trusted)
        self.assertEqual(route, '/api/send_quote')
        self.assertEqual(body, {'reply': '这是回复', 'referContent': '<msg>原始内容</msg>', 'fromUsr': 'wxid_a', 'newmsgid': '843118478561634774', 'createTime': 1761396536, 'sendto': '123@chatroom', 'msgSource': ''})
        with self.assertRaisesRegex(ValueError, 'HOOK_QUOTE_SOURCE_REQUIRED'):
            map_supplier_action('/SendQuoteMsg', supplied)
        with self.assertRaises(PermissionError):
            map_supplier_action('/SendQuoteMsg', {**supplied, 'wxidorgid': '456@chatroom'}, quote=trusted)
        for mutation in ({'newmsgid': '0'}, {'newmsgid': 123}, {'createTime': True}, {'createTime': -1}, {'fromUsr': '123@chatroom'}, {'referContent': ''}):
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                map_supplier_action('/SendQuoteMsg', supplied, quote={**trusted, **mutation})

    def test_mp3_file_type_size_and_duration_are_validated(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / '测试.mp3'
            # MPEG-1 Layer III, 128 kbit/s, 44.1 kHz: one complete 417-byte frame.
            frame = b'\xff\xfb\x90\x00' + bytes(413)
            file.write_bytes(frame)
            self.assertEqual(map_supplier_action('/SendMp3VoiceMsg', {'wxidorgid': 'filehelper', 'path': str(file), 'duration': 30_000}), ('/api/send_mp3_voice', {'wxid': 'filehelper', 'mp3Path': str(file.resolve())}))
            file.write_bytes(b'ID3\x04\0\0\0\0\0\0' + frame)
            self.assertEqual(map_supplier_action('/SendMp3VoiceMsg', {'wxidorgid': 'wxid_a', 'path': str(file)})[1]['mp3Path'], str(file.resolve()))
            for contents in (b'not-mp3', b'ID3\x04\0\0\0\0\0\0', b'\xff\xfb\x90\0', b'\xff\xfb\xf0\0' + bytes(500), b'ID3\x04\0\0\x80\0\0\0' + frame):
                file.write_bytes(contents)
                with self.subTest(contents=contents[:10]), self.assertRaises(ValueError):
                    map_supplier_action('/SendMp3VoiceMsg', {'wxidorgid': 'wxid_a', 'path': str(file)})
            file.write_bytes(frame)
            for duration in (0, 60001, True, '5000'):
                with self.subTest(duration=duration), self.assertRaises(ValueError):
                    map_supplier_action('/SendMp3VoiceMsg', {'wxidorgid': 'wxid_a', 'path': str(file), 'duration': duration})
            for path in ('relative.mp3', str(file.with_suffix('.wav')), str(file.parent / 'missing.mp3')):
                with self.subTest(path=path), self.assertRaises(ValueError):
                    map_supplier_action('/SendMp3VoiceMsg', {'wxidorgid': 'wxid_a', 'path': path})
            file.write_bytes(frame + bytes(16 * 1024 * 1024))
            with self.assertRaises(ValueError):
                map_supplier_action('/SendMp3VoiceMsg', {'wxidorgid': 'wxid_a', 'path': str(file)})

    def test_targets_text_and_route_reject_invalid_values(self):
        for target in ('', 'a/b', 'wxid_a\0', '1@chatroom/../../', 123):
            with self.subTest(target=target), self.assertRaises(ValueError):
                map_supplier_action('/SendPatMsg', {'wxidorgid': target, 'wxid': 'wxid_a'})
        for value in (' ', 'a\0b', '你' * 5334, None):
            with self.subTest(value=str(value)[:10]), self.assertRaises(ValueError):
                map_supplier_action('/SendAtText', {'wxidorgid': '123@chatroom', 'msg': value, 'wxids': ['wxid_a']})
        with self.assertRaisesRegex(ValueError, 'HOOK_ROUTE_UNSUPPORTED'):
            map_supplier_action('/Unknown', {'wxidorgid': 'wxid_a'})


if __name__ == '__main__':
    unittest.main()
