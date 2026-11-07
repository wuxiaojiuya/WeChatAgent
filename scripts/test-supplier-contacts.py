"""Offline supplier contact/group contracts; no WeChat or SQL is contacted."""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from supplier_contacts import load_contacts, load_groups, load_members
from wechat_contacts import RELATIONSHIP_ERROR


def contact(username, nickname='', **fields):
    value = {'userName': {'String': username}, 'nickName': {'String': nickname},
             'remark': {'String': ''}, 'alias': '', 'bitVal': 1, 'verifyFlag': 0}
    value.update(fields)
    return {'username': username, 'ret': 0, 'contact': value}


class FakeApi:
    def __init__(self, contacts=None, groups=None, members=None):
        self.contacts = {'data': []} if contacts is None else contacts
        self.groups = {'data': []} if groups is None else groups
        self.members = {'data': []} if members is None else members
        self.calls = []

    def post(self, route, body=None):
        self.calls.append((route, body) if body is not None else route)
        if route == '/api/get_frien_lists':
            return self.contacts
        if route == '/api/get_chatroom_list':
            return self.groups
        if route == '/api/get_room_members':
            return self.members
        raise AssertionError('Only dedicated contact APIs are allowed')


class ContactContracts(unittest.TestCase):
    def test_documented_friend_response_preserves_remark_and_search_metadata(self):
        api = FakeApi({'data': [contact('wxid_friend', 'Nickname', remark={'String': 'My friend'},
                                       alias='friend_alias', quanPin={'String': 'pengyou'})], 'friend_count': 1})
        names, friends, error = load_contacts(api, 'wxid_self')
        self.assertEqual(names, {'wxid_friend': 'My friend'})
        self.assertEqual(friends['wxid_friend']['displayName'], 'My friend')
        self.assertEqual(friends['wxid_friend']['searchTerms'], ['My friend', 'Nickname', 'friend_alias', 'pengyou'])
        self.assertEqual(error, '')
        self.assertEqual(api.calls, ['/api/get_frien_lists'])

    def test_supplier_contact_list_envelope_uses_relationships_not_friend_count(self):
        # Anonymized shape returned by the supplied 4.1.8.27 Hook. The count
        # describes its catalog, not proof that every entry is a private friend.
        response = {'contact_list': [
            contact('wxid_friend', 'Nickname', remark={'String': 'My friend'}),
            contact('wxid_other_friend', 'Another friend', bitVal=3),
            contact('wxid_self', 'Self'), contact('filehelper', 'File helper'),
            contact('wxid_stranger', 'Stranger', bitVal=2),
            contact('wxid_deleted', 'Deleted', delete_flag=1),
            contact('gh_official', 'Official', verifyFlag=24),
        ], 'friend_count': 7}
        for envelope in (response, {'code': 1, 'data': response}):
            with self.subTest(nested='data' in envelope):
                api = FakeApi(envelope)
                names, friends, error = load_contacts(api, 'wxid_self')
                self.assertEqual(names['wxid_friend'], 'My friend')
                self.assertEqual(len(names), 7)
                self.assertEqual(set(friends), {'wxid_friend', 'wxid_other_friend'})
                self.assertEqual(error, '')
                self.assertEqual(api.calls, ['/api/get_frien_lists'])

    def test_contact_list_envelope_preserves_validation_and_rejects_ambiguous_results(self):
        self.assertEqual(load_contacts(FakeApi({'contact_list': [], 'friend_count': 0}), 'wxid_self'), ({}, {}, ''))
        conflicting = contact('wxid_friend')
        conflicting['username'] = 'wxid_someone_else'
        for response in ({'friend_count': 7}, {'contact_list': {}, 'friend_count': 0},
                         {'code': 0, 'contact_list': []},
                         {'baseResponse': {'ret': -1}, 'contact_list': []},
                         {'data': [], 'contact_list': []}, {'contact_list': [conflicting]}):
            with self.subTest(response=response), self.assertRaisesRegex(RuntimeError, '^HOOK_CONTACTS_RESPONSE_INVALID$'):
                load_contacts(FakeApi(response), 'wxid_self')
        unproven = contact('wxid_unproven', 'Known person')
        del unproven['contact']['bitVal']
        names, friends, error = load_contacts(FakeApi({'contact_list': [unproven], 'friend_count': 1}), 'wxid_self')
        self.assertEqual(names, {'wxid_unproven': 'Known person'})
        self.assertEqual(friends, {})
        self.assertEqual(error, RELATIONSHIP_ERROR)
        failed = contact('wxid_unavailable')
        failed['ret'] = -1
        self.assertEqual(load_contacts(FakeApi({'contact_list': [failed], 'friend_count': 1}), 'wxid_self'), ({}, {}, ''))

    def test_picker_excludes_strangers_deleted_system_verified_group_and_self(self):
        rows = [contact('wxid_friend', 'Friend'), contact('wxid_self'), contact('filehelper'),
                contact('weixin'), contact('gh_official'), contact('room@chatroom'),
                contact('wxid_stranger', bitVal=2), contact('wxid_deleted', delete_flag=1),
                contact('wxid_member', local_type=3), contact('wxid_verified', verifyFlag=24),
                contact('wxid_invalid', bitVal=True), contact('wxid_string', bitVal='3', verifyFlag='0')]
        names, friends, error = load_contacts(FakeApi({'data': rows}), 'wxid_self')
        self.assertEqual(set(friends), {'wxid_friend', 'wxid_string'})
        self.assertEqual(len(names), len(rows))
        self.assertEqual(error, RELATIONSHIP_ERROR)

    def test_missing_relationship_metadata_keeps_name_but_never_invents_friendship(self):
        row = contact('wxid_unproven', 'Known person')
        del row['contact']['bitVal']
        names, friends, error = load_contacts(FakeApi({'data': [row]}), 'wxid_self')
        self.assertEqual(names['wxid_unproven'], 'Known person')
        self.assertFalse(friends)
        self.assertEqual(error, RELATIONSHIP_ERROR)

    def test_numeric_strings_and_nested_or_direct_list_envelopes_are_supported(self):
        row = contact('wxid_friend', 'Friend', bitVal='1', verifyFlag='0')
        row['ret'] = '0'
        for response in ([row], {'code': 1, 'data': [row]}, {'errCode': '1', 'data': {'list': [row]}}):
            with self.subTest(response=response):
                self.assertEqual(set(load_contacts(FakeApi(response), 'wxid_self')[1]), {'wxid_friend'})

    def test_empty_catalog_is_valid_but_unknown_or_failed_success_shapes_are_not(self):
        self.assertEqual(load_contacts(FakeApi({'data': []}), 'wxid_self'), ({}, {}, ''))
        for response in ({}, {'code': 1}, {'code': 1, 'data': None}, {'code': 0, 'data': []},
                         {'errCode': True, 'data': []}, {'code': 1, 'errCode': 0, 'data': []},
                         {'baseResponse': {'ret': -1}, 'data': []}, {'data': {}, 'list': []}):
            with self.subTest(response=response), self.assertRaisesRegex(RuntimeError, '^HOOK_CONTACTS_RESPONSE_INVALID$'):
                load_contacts(FakeApi(response), 'wxid_self')

    def test_failed_entries_are_skipped_but_conflicting_contact_identity_is_rejected(self):
        row = contact('wxid_unavailable')
        row['ret'] = -1
        self.assertEqual(load_contacts(FakeApi({'data': [row]}), 'wxid_self'), ({}, {}, ''))
        row = contact('wxid_other')
        row['username'] = 'wxid_mismatch'
        with self.assertRaisesRegex(RuntimeError, '^HOOK_CONTACTS_RESPONSE_INVALID$'):
            load_contacts(FakeApi({'data': [row]}), 'wxid_self')

    def test_flat_contacts_use_their_explicit_relationship_flags(self):
        api = FakeApi({'data': [{'username': 'old_account_name', 'nick_name': 'Friend',
                                 'remark': 'Remark', 'flag': 3, 'verify_flag': 0,
                                 'local_type': 1, 'delete_flag': 0}]})
        names, friends, error = load_contacts(api, 'self')
        self.assertEqual(names, {'old_account_name': 'Remark'})
        self.assertEqual(set(friends), {'old_account_name'})
        self.assertFalse(error)

    def test_group_list_accepts_ids_contacts_and_keyed_caches_without_querying_sql(self):
        for response in (['123@chatroom'], {'data': [contact('123@chatroom', 'Room')]},
                         {'data': {'123@chatroom': 'Room'}},
                         {'code': 1, 'data': {'roomList': [{'userName': '123@chatroom', 'nickName': 'Room'}]}}):
            with self.subTest(response=response):
                api = FakeApi(groups=response)
                names = load_groups(api)
                self.assertIn('123@chatroom', names)
                self.assertEqual(api.calls, ['/api/get_chatroom_list'])

    def test_empty_groups_are_valid_while_unknown_group_schemas_are_explicit(self):
        self.assertEqual(load_groups(FakeApi(groups={'data': []})), {})
        for response in ({}, {'code': 1}, {'data': None}, {'data': ['wxid_friend']},
                         {'data': [contact('wxid_friend')]}, {'data': {'arbitrary': 'Room'}},
                         {'data': {'123@chatroom': {'userName': '456@chatroom'}}}):
            with self.subTest(response=response), self.assertRaisesRegex(RuntimeError, '^HOOK_GROUPS_RESPONSE_INVALID$'):
                load_groups(FakeApi(groups=response))

    def test_documented_members_use_room_id_and_new_chatroom_data(self):
        api = FakeApi(members={'baseResponse': {'ret': 0, 'errMsg': {}},
                               'chatroomUserName': '123@chatroom',
                               'newChatroomData': {'memberCount': 2, 'chatRoomMember': [
                                   {'userName': 'wxid_one', 'nickName': 'Member One', 'status': 0},
                                   {'userName': 'wxid_two', 'nickName': 'Member Two', 'status': 0}]}})
        self.assertEqual(load_members(api, '123@chatroom'), [
            {'username': 'wxid_one', 'displayName': 'Member One', 'nickname': 'Member One', 'card': ''},
            {'username': 'wxid_two', 'displayName': 'Member Two', 'nickname': 'Member Two', 'card': ''}])
        self.assertEqual(api.calls, [('/api/get_room_members', {'room_id': '123@chatroom'})])

    def test_compatible_member_envelopes_names_and_duplicates(self):
        member = {'userName': {'String': 'wxid_one'}, 'nickName': {'String': 'Nickname'}, 'card': 'Group card'}
        for response in ([member], {'data': {'memberList': [member, member]}}, {'code': 1, 'members': [member]}):
            with self.subTest(response=response):
                self.assertEqual(load_members(FakeApi(members=response), '123@chatroom'), [
                    {'username': 'wxid_one', 'displayName': 'Group card', 'nickname': 'Nickname', 'card': 'Group card'}])

    def test_members_reject_unknown_failed_or_wrong_room_responses(self):
        for response in ({}, {'code': 1}, {'data': None}, {'baseResponse': {'ret': -1}, 'data': []},
                         {'chatroomUserName': '456@chatroom', 'newChatroomData': {'chatRoomMember': []}},
                         {'data': {'room_id': '456@chatroom', 'memberList': []}},
                         {'data': [{'userName': '123@chatroom'}]}, {'data': ['wxid_one']}):
            with self.subTest(response=response), self.assertRaisesRegex(RuntimeError, '^HOOK_GROUP_MEMBERS_RESPONSE_INVALID$'):
                load_members(FakeApi(members=response), '123@chatroom')
        self.assertEqual(load_members(FakeApi(members={'data': []}), '123@chatroom'), [])
        api = FakeApi()
        with self.assertRaisesRegex(RuntimeError, '^HOOK_ROOM_ID_INVALID$'):
            load_members(api, 'wxid_friend')
        self.assertEqual(api.calls, [])


if __name__ == '__main__':
    unittest.main()
