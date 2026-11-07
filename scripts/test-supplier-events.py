"""Offline callback/cache tests: no live Hook, account, database or network."""
import concurrent.futures
import copy
import hashlib
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import supplier_events as events


OWN = 'wxid_test_owner'
FRIEND = 'wxid_test_friend'
GROUP = 'test_room@chatroom'
STAMP = 1780000000


def callback(**changes):
    return {'fromUserName': {'String': FRIEND}, 'toUserName': {'String': OWN},
            'content': {'String': '一条普通消息'}, 'msgType': '1',
            'createTime': str(STAMP), 'msgId': '101',
            'newMsgId': '18446744073709550001', 'msgSource': '', **changes}


def normalized(**changes):
    return events.normalize_callbacks(callback(**changes), OWN)[0]


class NormalizeTests(unittest.TestCase):
    def test_private_preserves_unicode_and_full_uint64_server_identity(self):
        talker, row = normalized(content={'String': '你好，世界 🌻\n第二行'})
        self.assertEqual(talker, FRIEND)
        self.assertEqual(row['fullText'], '你好，世界 🌻\n第二行')
        self.assertEqual(row['serverId'], '18446744073709550001')
        self.assertEqual(row['localId'], 101)
        self.assertEqual(row['isSend'], 0)
        self.assertEqual(row['senderUsername'], FRIEND)
        expected = hashlib.sha256(json.dumps([FRIEND, row['serverId'], 101, STAMP], separators=(',', ':')).encode()).hexdigest()
        self.assertEqual(row['rawid'], expected)
        self.assertEqual(row['callback'], {'msgId': 101, 'from': FRIEND, 'to': OWN, 'type': 1})

    def test_group_member_prefix_real_content_and_mentions(self):
        talker, row = normalized(fromUserName={'String': GROUP},
                                content={'String': FRIEND + ':\n旧内容'}, real_content='@机器人 新内容',
                                member_info={'userName': FRIEND, 'nickName': '测试成员'},
                                msgSource='<msgsource><atuserlist><![CDATA[' + OWN + ',' + OWN + ',bad value]]></atuserlist></msgsource>')
        self.assertEqual(talker, GROUP)
        self.assertEqual(row['senderUsername'], FRIEND)
        self.assertEqual(row['senderName'], '测试成员')
        self.assertEqual(row['fullText'], '@机器人 新内容')
        self.assertEqual(row['mentions'], [OWN])
        self.assertEqual(row['atUserList'], [OWN])

    def test_group_without_real_content_removes_only_sender_prefix(self):
        _, row = normalized(fromUserName=GROUP, content=FRIEND + ':\n文本:保留\n内容')
        self.assertEqual(row['fullText'], '文本:保留\n内容')

    def test_private_profile_nickname_fallback(self):
        _, row = normalized(sender_profile={'nickName': {'String': '好友昵称'}})
        self.assertEqual(row['senderName'], '好友昵称')

    def test_group_conflicting_or_absent_sender_is_not_acknowledgeable(self):
        for changes in ({'content': FRIEND + ':\n内容', 'member_info': {'userName': 'wxid_other'}}, {'content': '无发送者'}):
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, 'GROUP_SENDER'):
                normalized(fromUserName=GROUP, **changes)

    def test_no_saved_account_validation_and_outgoing_direction(self):
        talker, row = normalized(fromUserName=OWN, toUserName=FRIEND,
                                account_wxid='wxid_unrelated_supplier_metadata')
        self.assertEqual(talker, FRIEND)
        self.assertEqual(row['isSend'], 1)

    def test_app_types_have_native_kind_and_file_metadata(self):
        for subtype in (6, 8, 19, 57, 62):
            with self.subTest(subtype=subtype):
                _, row = normalized(msgType=49, content='<msg><appmsg><type>' + str(subtype) + '</type><title>附件.txt</title><appattach><totallen>512</totallen><md5>' + 'A' * 32 + '</md5></appattach></appmsg></msg>')
                self.assertEqual(row['localType'], (subtype << 32) | 49)
                self.assertEqual(row['callback']['type'], 49)
                if subtype == 6:
                    self.assertEqual(row['fileName'], '附件.txt')
                    self.assertEqual(row['fileSize'], 512)
                    self.assertEqual(row['fileMd5'], 'a' * 32)

    def test_media_callback_metadata_never_substitutes_server_id(self):
        for kind, xml in ((3, '<msg><img md5="' + 'B' * 32 + '"/></msg>'),
                          (34, '<msg><voicemsg voicelength="5000" length="8400"/></msg>'),
                          (43, '<msg><videomsg playlength="5"/></msg>'),
                          (47, '<msg><emoji md5="' + 'C' * 32 + '"/></msg>')):
            with self.subTest(kind=kind):
                _, row = normalized(msgType=kind, content=xml)
                self.assertEqual(row['callback']['msgId'], 101)
                self.assertEqual(row['callback']['type'], kind)
                if kind == 34:
                    self.assertEqual(row['callback']['length'], '8400')
                if kind == 3:
                    self.assertEqual(row['imageMd5'], 'b' * 32)
                if kind == 47:
                    self.assertEqual(row['stickerMd5'], 'c' * 32)

    def test_own_text_batch_is_observation_without_fake_server_receipt(self):
        rows = events.normalize_callbacks({'account_wxid': 'ignored', 'list': [
            {'clientMsgId': 12030, 'content': '自己的消息', 'createTime': STAMP,
             'type': 1, 'toUserName': {'String': FRIEND}, 'msgSource': ''}]}, OWN)
        talker, row = rows[0]
        self.assertEqual(talker, FRIEND)
        self.assertEqual(row['clientId'], '12030')
        self.assertEqual(row['localId'], 0)
        self.assertEqual(row['serverId'], '0')
        self.assertEqual(row['observedOnly'], True)
        self.assertEqual(row['isSend'], 1)

    def test_own_app_documented_multiple_roots(self):
        rows = events.normalize_callbacks({'msg': {'clientMsgId': 'submitted-1',
            'type': 6, 'content': '<appmsg><type>6</type><title>file.pdf</title></appmsg><fromusername>' + OWN + '</fromusername>',
            'toUserName': FRIEND, 'fromUserName': OWN, 'createTime': STAMP}}, OWN)
        self.assertEqual(rows[0][1]['localType'], (6 << 32) | 49)
        self.assertEqual(rows[0][1]['fileName'], 'file.pdf')

    def test_own_image_missing_timestamp_has_stable_client_identity(self):
        body = {'clientImgId': {'String': 'image-client-1'}, 'toUserName': {'String': FRIEND},
                'fromUserName': OWN, 'md5': 'D' * 32, 'cdnmidImgUrl': 'cdn-token'}
        _, first = events.normalize_callbacks(body, OWN, now=STAMP)[0]
        _, second = events.normalize_callbacks(body, OWN, now=STAMP + 3)[0]
        self.assertEqual(first['rawid'], second['rawid'])
        self.assertEqual(first['imageMd5'], 'd' * 32)
        self.assertEqual(first['timestampSource'], 'received')
        self.assertEqual(first['serverId'], '0')
        self.assertIn('cdnmidimgurl="cdn-token"', first['fullText'])

    def test_malformed_numeric_fields_and_client_ids_rejected(self):
        for field in ('msgId', 'newMsgId', 'msgType', 'createTime'):
            for value in (True, 3.5, -1, '1e6', 18446744073709551616):
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    normalized(**{field: value})
        for value in (True, -3, 1.5, 18446744073709551616):
            with self.subTest(client=value), self.assertRaises(ValueError):
                events.normalize_callbacks({'list': [{'clientMsgId': value, 'content': 'x', 'type': 1, 'toUserName': FRIEND}]}, OWN)

    def test_unsafe_or_malformed_xml_rejected(self):
        for value in ('<!DOCTYPE msg [<!ENTITY x "x">]><msg>&x;</msg>', '<msg><img></msg>'):
            with self.subTest(xml=value), self.assertRaisesRegex(ValueError, 'XML_'):
                normalized(msgType=3, content=value)
        with self.assertRaisesRegex(ValueError, 'XML_UNSAFE'):
            normalized(msgSource='<!DOCTYPE msgsource><msgsource/>')

    def test_unknown_callback_ignored_and_invalid_batches_rejected(self):
        self.assertEqual(events.normalize_callbacks({'messageType': 99, 'status': 'heartbeat'}, OWN), [])
        with self.assertRaisesRegex(ValueError, 'BATCH_TOO_LARGE'):
            events.normalize_callbacks({'list': [{}] * 101}, OWN)
        for own in (None, 123, 'bad account'):
            with self.subTest(own=own), self.assertRaises(ValueError):
                events.normalize_callbacks({}, own)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = pathlib.Path(self.temporary.name) / 'cache' / 'events.json'

    def store(self, **kwargs):
        return events.SupplierEventStore(self.path, **kwargs)

    def test_pending_persisted_before_ack_and_no_restart_replay_after_mark(self):
        talker, row = normalized()
        store = self.store()
        self.assertTrue(store.add(talker, row))
        store.close()
        reopened = self.store()
        self.assertEqual(reopened.pending(), [(talker, row)])
        self.assertFalse(reopened.add(talker, row))
        self.assertTrue(reopened.mark_dispatched(row['rawid']))
        self.assertFalse(reopened.mark_dispatched(row['rawid']))
        self.assertEqual(self.store().pending(), [])
        self.assertEqual(self.store().messages(talker), [row])

    def test_outgoing_observed_callback_never_becomes_pending(self):
        talker, row = events.normalize_callbacks({'list': [{'type': 1, 'clientMsgId': 99,
            'createTime': STAMP, 'toUserName': FRIEND, 'content': 'own'}]}, OWN)[0]
        store = self.store()
        store.add(talker, row)
        self.assertEqual(store.pending(), [])
        self.assertEqual(self.store().messages(talker)[0]['serverId'], '0')

    def test_dedupe_uses_server_identity_and_chat_scope(self):
        talker, first = normalized()
        _, alternate = normalized(msgId=999, createTime=STAMP + 1)
        other_talker, other = normalized(fromUserName='wxid_test_other')
        store = self.store()
        self.assertTrue(store.add(talker, first))
        self.assertFalse(store.add(talker, alternate))
        self.assertTrue(store.add(other_talker, other))
        self.assertEqual(len(store.pending()), 2)
        self.assertEqual(store.bound(talker, first['serverId']), first)
        self.assertEqual(store.bound('wxid_unknown', first['serverId']), None)

    def test_message_queries_exact_scope_order_and_copy_isolation(self):
        store = self.store()
        rows = []
        for index in range(3):
            talker, row = normalized(msgId=index + 1, newMsgId=str(index + 100), createTime=STAMP + index)
            store.add(talker, row)
            rows.append(row)
        self.assertEqual(store.messages(talker, limit=2), rows[1:][::-1])
        self.assertEqual(store.messages(talker, from_time=STAMP + 1, limit=0), rows[1:][::-1])
        self.assertEqual(store.exact(talker, rows[0]), rows[0])
        self.assertIsNone(store.exact('wxid_other', rows[0]))
        returned = store.messages(talker)
        returned[0]['fullText'] = 'mutated'
        self.assertEqual(store.messages(talker)[0]['fullText'], rows[-1]['fullText'])

    def test_capacity_prunes_dispatched_and_never_unprocessed_events(self):
        store = self.store(max_messages=2)
        for index in range(2):
            talker, row = normalized(newMsgId=str(index + 1))
            store.add(talker, row)
        before = self.path.read_bytes()
        talker, newest = normalized(newMsgId='3')
        with self.assertRaisesRegex(RuntimeError, 'BACKPRESSURE'):
            store.add(talker, newest)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(len(store.pending()), 2)
        oldest = store.messages(talker, limit=0)[-1]
        store.mark_dispatched(oldest['rawid'])
        self.assertTrue(store.add(talker, newest))
        self.assertIsNone(store.bound(talker, oldest['serverId']))
        self.assertEqual(len(store.pending()), 2)

    def test_new_outgoing_observation_cannot_silently_evict_itself(self):
        store = self.store(max_messages=1)
        talker, row = normalized()
        store.add(talker, row)
        target, outgoing = normalized(fromUserName=OWN, toUserName=FRIEND, newMsgId='2')
        with self.assertRaisesRegex(RuntimeError, 'BACKPRESSURE'):
            store.add(target, outgoing)
        self.assertEqual(store.messages(talker), [row])

    def test_byte_capacity_backpressure_preserves_file_and_memory(self):
        store = self.store(max_bytes=2048)
        talker, row = normalized()
        store.add(talker, row)
        before = self.path.read_bytes()
        talker, huge = normalized(newMsgId='2', content='x' * 3000)
        with self.assertRaisesRegex(RuntimeError, 'BACKPRESSURE'):
            store.add(talker, huge)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(store.messages(talker), [row])

    def test_failed_atomic_replace_keeps_last_good_state(self):
        store = self.store()
        talker, first = normalized()
        store.add(talker, first)
        before = self.path.read_bytes()
        _, second = normalized(newMsgId='2')
        with patch.object(events.os, 'replace', side_effect=OSError('simulated write error')):
            with self.assertRaises(OSError):
                store.add(talker, second)
        self.assertEqual(store.messages(talker), [first])
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(list(self.path.parent.glob('*.tmp')), [])

    def test_corrupt_or_wrongly_typed_persisted_state_is_rejected(self):
        talker, row = normalized()
        store = self.store()
        store.add(talker, row)
        valid = json.loads(self.path.read_text(encoding='utf-8'))
        invalid = ['not-json', {'version': 2, 'entries': []}, {'version': 1, 'entries': ['wrong']}]
        for field, value in (('talker', []), ('row', [])):
            state = copy.deepcopy(valid)
            state['entries'][0][field] = value
            invalid.append(state)
        for field, value in (('rawid', 4), ('serverId', '18446744073709551616'),
                             ('localId', True), ('senderUsername', []), ('clientId', 2),
                             ('rawid', 'a' * 64)):
            state = copy.deepcopy(valid)
            state['entries'][0]['row'][field] = value
            invalid.append(state)
        invalid.append({**valid, 'entries': valid['entries'] * 2})
        for state in invalid:
            with self.subTest(state=type(state).__name__):
                self.path.write_text(state if isinstance(state, str) else json.dumps(state), encoding='utf-8')
                with self.assertRaisesRegex(RuntimeError, 'STORE_INVALID'):
                    self.store()

    def test_symlink_file_and_parent_rejected(self):
        destination = pathlib.Path(self.temporary.name) / 'actual'
        destination.mkdir()
        self.path.parent.mkdir()
        actual = destination / 'events.json'
        actual.write_text('{"version":1,"entries":[]}', encoding='utf-8')
        try:
            self.path.symlink_to(actual)
        except OSError:
            self.skipTest('Host disallows unprivileged symlink creation')
        with self.assertRaisesRegex(RuntimeError, 'STORE_INVALID'):
            self.store()
        self.path.unlink()
        self.path.parent.rmdir()
        self.path.parent.symlink_to(destination, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'STORE_INVALID'):
            self.store()

    def test_concurrent_duplicate_events_stored_once(self):
        store = self.store()
        talker, row = normalized()
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            results = list(executor.map(lambda _: store.add(talker, row), range(24)))
        self.assertEqual(results.count(True), 1)
        self.assertEqual(len(store.pending()), 1)
        self.assertEqual(self.store().pending(), [(talker, row)])

    def test_closed_store_rejects_mutations_even_duplicate(self):
        store = self.store()
        talker, row = normalized()
        store.add(talker, row)
        store.close()
        with self.assertRaisesRegex(RuntimeError, 'STORE_CLOSED'):
            store.add(talker, row)
        with self.assertRaisesRegex(RuntimeError, 'STORE_CLOSED'):
            store.mark_dispatched(row['rawid'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
