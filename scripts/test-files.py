import hashlib
import json
import os
import pathlib
import tempfile
import time
import unittest
from wechat_files import FILE_TYPE, file_policy, parse_file_message
from supplier_reader import SupplierFiles
from types import SimpleNamespace
from unittest.mock import patch

KEY, SENDER = 'wechat:group:123', 'wxid_fixture'

class Files(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.account = self.root / 'account'
        self.account.mkdir(parents=True)
        (self.root / 'config').mkdir()
        self.config = {'wechat': {'whitelist': {'groups': ['123'], 'private': []}, 'workModes': {KEY: 'assistant'}, 'assistant': {'administrators': [SENDER], 'fileTransferChats': {KEY: True}}}}
        self.save()
        self.active, self.download = True, b'file proof'
        def exact(talker, record):
            self.assertEqual(talker, 'fixture@chatroom')
            return {'fullText': '<msg><appmsg><type>6</type><title>报告.txt</title><appattach><attachid>fixture-only</attachid></appattach></appmsg></msg>'}
        def post(route, body):
            self.assertEqual(route, '/api/download_file')
            if self.download is not None:
                pathlib.Path(body['path']).write_bytes(self.download)
            return {'code': 1}
        self.reader = SimpleNamespace(root=self.root, account=self.account,
            sticker_account_active=lambda: self.active, exact_message=exact, api=SimpleNamespace(post=post))
        patcher = patch('supplier_reader.runtime_directory', return_value=self.root/'runtime')
        patcher.start();self.addCleanup(patcher.stop)
        self.catalog = SupplierFiles(self.reader)

    def save(self):
        (self.root / 'config/wechatagent.json').write_text(json.dumps(self.config), encoding='utf-8')

    def info(self, data=b'file proof'):
        return {'name': '报告.txt', 'size': len(data), 'md5': hashlib.md5(data).hexdigest(),
                'talker': 'fixture@chatroom', 'serverId': '1234567890123456789'}

    def remember(self, info=None):
        return self.catalog.remember({'rawid': 'a' * 64, 'talkerId': SENDER, 'timestamp': int(time.time()), 'file': info or self.info()}, KEY)

    def test_file_xml_types_are_verified_and_nested_cards_are_not_current_files(self):
        xml = '<msg><appmsg><title>报告.txt</title><type>6</type><appattach><totallen>10</totallen><md5>' + 'b' * 32 + '</md5></appattach></appmsg></msg>'
        for kind in (49, FILE_TYPE):
            self.assertEqual(parse_file_message(kind, xml)['name'], '报告.txt')
        self.assertIsNone(parse_file_message(49, '<msg><appmsg><type>19</type><recorditem>' + xml + '</recorditem></appmsg></msg>'))
        self.assertIsNone(parse_file_message(47, xml))
        for name in ('../x', 'a:b.txt', 'CON.txt', 'x.', 'x\u202eexe'):
            self.assertIsNone(parse_file_message(FILE_TYPE, xml.replace('报告.txt', name)))
        self.assertIsNone(parse_file_message(FILE_TYPE, '<!DOCTYPE msg>' + xml))

    def test_real_file_is_verified_and_catalog_survives_restart(self):
        data = b'file proof'
        self.remember()
        restarted = SupplierFiles(self.reader)
        result = restarted.resolve('a' * 64, KEY, SENDER)
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['sha256'], hashlib.sha256(data).hexdigest())
        self.assertEqual(pathlib.Path(result['path']), self.root/'runtime/incoming-files'/('a'*64+'.txt'))

    def test_not_downloaded_returns_immediately_and_unauthorized_refs_are_rejected(self):
        self.download = None
        self.remember()
        started = time.monotonic()
        self.assertEqual(self.catalog.resolve('a' * 64, KEY, SENDER)['status'], 'not_downloaded')
        self.assertLess(time.monotonic() - started, 1)
        for key, sender in [(KEY, 'wxid_other'), ('wechat:group:124', SENDER)]:
            with self.assertRaises(PermissionError):
                self.catalog.resolve('a' * 64, key, sender)
        self.config['wechat']['assistant']['fileTransferChats'][KEY] = False
        self.save()
        with self.assertRaises(PermissionError):
            self.catalog.resolve('a' * 64, KEY, SENDER)

    def test_wrong_download_digest_cannot_be_replaced_by_old_client_files(self):
        legacy = self.account/'msg/file'
        legacy.mkdir(parents=True)
        (legacy/'报告.txt').write_bytes(b'file proof')
        self.download = b'wrong data'
        self.remember()
        with self.assertRaisesRegex(RuntimeError, 'FILE_INTEGRITY_FAILED'):
            self.catalog.resolve('a'*64, KEY, SENDER)

    def test_group_open_mode_does_not_open_private_or_unselected_chats(self):
        w = self.config['wechat'];w['assistant']['adminOnlyGroups'] = {KEY: False}
        self.assertTrue(file_policy(self.config, KEY, 'wxid_other'))
        self.assertFalse(file_policy(self.config, 'wechat:private:123', 'wxid_other'))
        self.assertFalse(file_policy(self.config, 'wechat:group:999', SENDER))

    def test_account_change_and_cache_junctions_fail_closed(self):
        self.remember();self.active = False
        with self.assertRaises(PermissionError):
            self.catalog.resolve('a' * 64, KEY, SENDER)

if __name__ == '__main__':
    unittest.main()
