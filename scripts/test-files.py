import hashlib
import json
import os
import pathlib
import tempfile
import time
import unittest
from wechat_files import FILE_TYPE, FileCatalog, file_policy, parse_file_message

KEY, SENDER = 'wechat:group:123', 'wxid_fixture'

class Files(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.account = self.root / 'account'
        (self.account / 'msg/file/2026-10').mkdir(parents=True)
        (self.root / 'config').mkdir()
        self.config = {'wechat': {'whitelist': {'groups': ['123'], 'private': []}, 'workModes': {KEY: 'assistant'}, 'assistant': {'administrators': [SENDER], 'fileTransferChats': {KEY: True}}}}
        self.save()
        self.catalog = FileCatalog(self.root, self.account)

    def save(self):
        (self.root / 'config/wechatagent.json').write_text(json.dumps(self.config), encoding='utf-8')

    def info(self, data=b'file proof'):
        return {'name': '报告.txt', 'size': len(data), 'md5': hashlib.md5(data).hexdigest()}

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
        target = self.account / 'msg/file/2026-10/报告.txt'
        target.write_bytes(data)
        self.remember()
        restarted = FileCatalog(self.root, self.account)
        result = restarted.resolve('a' * 64, KEY, SENDER)
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['sha256'], hashlib.sha256(data).hexdigest())
        self.assertEqual(pathlib.Path(result['path']), target)

    def test_not_downloaded_returns_immediately_and_unauthorized_refs_are_rejected(self):
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

    def test_wrong_digest_and_ambiguous_filenames_are_not_substituted(self):
        (self.account / 'msg/file/2026-10/报告.txt').write_bytes(b'wrong data')
        self.remember()
        self.assertEqual(self.catalog.resolve('a' * 64, KEY, SENDER)['status'], 'integrity_failed')
        info = self.info();info['md5'] = ''
        self.remember(info)
        folder = self.account / 'msg/file/other';folder.mkdir()
        (folder / '报告.txt').write_bytes(b'wrong data')
        self.assertEqual(self.catalog.resolve('a' * 64, KEY, SENDER)['status'], 'ambiguous')

    def test_group_open_mode_does_not_open_private_or_unselected_chats(self):
        w = self.config['wechat'];w['assistant']['adminOnlyGroups'] = {KEY: False}
        self.assertTrue(file_policy(self.config, KEY, 'wxid_other'))
        self.assertFalse(file_policy(self.config, 'wechat:private:123', 'wxid_other'))
        self.assertFalse(file_policy(self.config, 'wechat:group:999', SENDER))

    def test_account_change_and_cache_junctions_fail_closed(self):
        self.remember();self.catalog.active = lambda: False
        with self.assertRaises(PermissionError):
            self.catalog.resolve('a' * 64, KEY, SENDER)

if __name__ == '__main__':
    unittest.main()
