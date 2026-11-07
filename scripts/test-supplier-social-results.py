"""Offline public-result contracts based on documented Moments callbacks."""
import base64
import copy
import json
import unittest

from supplier_social_results import (MAX_MOMENT_PREVIEW_BYTES, MAX_MOMENTS_PAGE_BYTES,
                                     normalize_moments_response, normalize_social_mutation)


def moment(identity='18446744073709551615', author='wxid_friend', text='今天很好', comments=0):
    xml = '<TimelineObject><id>' + identity + '</id><username>' + author + '</username><createTime>1756827024</createTime><contentDesc>' + text + '</contentDesc><ContentObject><mediaList><media><url token="PRIVATE_TOKEN" key="PRIVATE_KEY">https://example.invalid/private-cdn</url></media></mediaList></ContentObject></TimelineObject>'
    raw = xml.encode('utf-8')
    return {'id': identity, 'username': author, 'nickname': '好友', 'createTime': 1756827024,
            'commentCount': comments, 'objectDesc': {'buffer': base64.b64encode(raw).decode('ascii'), 'iLen': len(raw)},
            'objectOperations': {'buffer': 'PRIVATE_OPERATIONS'}, 'account_token': 'PRIVATE_ACCOUNT_TOKEN'}


class SupplierSocialResults(unittest.TestCase):
    def test_documented_base64_timeline_object_is_public_and_preserves_full_ids(self):
        result = normalize_moments_response('/GetMoments', {'code': 1, 'data': [moment()]})
        self.assertEqual(result, {'moments': [{'id': '18446744073709551615', 'author': 'wxid_friend', 'nickname': '好友', 'text': '今天很好',
                                             'createTime': 1756827024, 'mediaCount': 1, 'comments': [], 'commentCount': 0, 'commentsAvailable': True}]})
        public = json.dumps(result)
        for sensitive in ('PRIVATE_', 'private-cdn', 'objectDesc', 'objectOperations', 'token', 'buffer'):
            self.assertNotIn(sensitive, public)
        detail = normalize_moments_response('/GetMomentDetail', moment(), expected_id='18446744073709551615')
        self.assertEqual(detail['moment'], result['moments'][0])
        with self.assertRaisesRegex(RuntimeError, '^HOOK_MOMENT_IDENTITY_MISMATCH$'):
            normalize_moments_response('/GetMomentDetail', moment(), expected_id='1')

    def test_comments_without_a_documented_schema_are_explicitly_unavailable(self):
        value = moment(comments=2)
        value['commentUserList'] = [{'commentId': 123, 'username': 'wxid_forged', 'content': 'DO_NOT_EXPORT'}]
        result = normalize_moments_response('/GetMomentDetail', {'data': value})['moment']
        self.assertEqual(result['comments'], [])
        self.assertFalse(result['commentsAvailable'])
        self.assertEqual(result['commentCount'], 2)
        self.assertEqual(result['commentsUnavailableReason'], 'HOOK_MOMENT_COMMENTS_SCHEMA_UNDOCUMENTED')
        self.assertNotIn('DO_NOT_EXPORT', json.dumps(result))

    def test_list_previews_bound_multibyte_text_without_changing_details_or_sources(self):
        text = '\u60c5\u7eea\U0001f3b6' * 1500
        value = moment(text=text, comments=2)
        result = normalize_moments_response('/GetMoments', [value])
        self.assertTrue(result['truncated'])
        preview = result['moments'][0]
        self.assertTrue(preview['textTruncated'])
        self.assertGreater(len(preview['text']), 200)
        self.assertLessEqual(len(preview['text'].encode('utf-8')), MAX_MOMENT_PREVIEW_BYTES)
        self.assertTrue(text.startswith(preview['text']))
        self.assertNotIn('\ufffd', preview['text'])
        detail = normalize_moments_response('/GetMomentDetail', value)['moment']
        self.assertEqual(detail['text'], text)
        self.assertNotIn('textTruncated', detail)
        for name in ('id', 'author', 'nickname', 'createTime', 'mediaCount',
                     'commentCount', 'commentsAvailable', 'commentsUnavailableReason'):
            self.assertEqual(preview[name], detail[name])

    def test_list_total_budget_counts_escaped_utf8_json_and_marks_omitted_entries(self):
        values = []
        for index in range(100):
            value = moment(str(18446744073709551615-index), text='"\\\n\t' * 2500)
            value['nickname'] = '\u540d' * 1300
            values.append(value)
        result = normalize_moments_response('/GetMoments', {'code': 1, 'data': values})
        encoded = json.dumps(result, ensure_ascii=False).encode('utf-8')
        self.assertLessEqual(len(encoded), MAX_MOMENTS_PAGE_BYTES)
        self.assertTrue(result['truncated'])
        self.assertGreater(len(result['moments']), 1)
        self.assertLess(len(result['moments']), len(values))
        for original, preview in zip(values, result['moments']):
            self.assertEqual(preview['id'], original['id'])
            self.assertEqual(preview['author'], original['username'])
            self.assertEqual(preview['nickname'], original['nickname'])
            self.assertEqual(preview['createTime'], original['createTime'])
            self.assertTrue(preview['textTruncated'])
        public = encoded.decode('utf-8')
        self.assertNotIn('PRIVATE_', public)
        self.assertNotIn('private-cdn', public)

    def test_list_count_limit_is_explicit_even_when_short_entries_fit_byte_budget(self):
        values = [moment(str(index+1)) for index in range(101)]
        result = normalize_moments_response('/GetMoments', values)
        self.assertEqual(len(result['moments']), 100)
        self.assertTrue(result['truncated'])
        self.assertTrue(all('textTruncated' not in item for item in result['moments']))
        self.assertLessEqual(len(json.dumps(result, ensure_ascii=False).encode('utf-8')),
                             MAX_MOMENTS_PAGE_BYTES)

    def test_unknown_endpoint_envelopes_never_fabricate_an_empty_page_or_usable_ids(self):
        for value in ({}, {'code': 1}, {'data': None}, {'objectList': [moment()]}, {'moments': [{'id': '1'}]}, {'code': True, 'data': []}, {'ret': '0', 'data': []}, {'data': [{'id': '1', 'content': 'invented'}]}):
            with self.subTest(value=str(value)[:50]), self.assertRaisesRegex(RuntimeError, '^HOOK_MOMENTS_RESPONSE_UNKNOWN$'):
                normalize_moments_response('/GetMoments', value)
        self.assertEqual(normalize_moments_response('/GetMoments', []), {'moments': []})
        for value in ([], [moment(), moment('2')]):
            with self.subTest(detail_count=len(value)), self.assertRaises(RuntimeError):
                normalize_moments_response('/GetMomentDetail', value)
        with self.assertRaisesRegex(RuntimeError, '^HOOK_MOMENTS_REQUEST_REJECTED$'):
            normalize_moments_response('/GetMoments', {'code': 0, 'data': []})

    def test_bad_base64_xml_mismatched_identity_and_unsafe_ids_are_rejected(self):
        modifications = [
            {'id': '0'}, {'id': '01'}, {'id': '18446744073709551616'}, {'id': 1.5}, {'id': True},
            {'username': 'wxid_other'}, {'createTime': 1756827025}, {'commentCount': True},
            {'objectDesc': {'iLen': 10, 'buffer': 'invalid'}},
        ]
        for modification in modifications:
            with self.subTest(modification=modification), self.assertRaises(RuntimeError):
                normalize_moments_response('/GetMomentDetail', {**moment(), **modification})
        for xml in ('<!DOCTYPE TimelineObject [<!ENTITY x "unsafe">]><TimelineObject/>', '<broken', '<TimelineObject><id>1</id></TimelineObject>'):
            value = moment(); raw = xml.encode(); value['objectDesc'] = {'buffer': base64.b64encode(raw).decode(), 'iLen': len(raw)}
            with self.subTest(xml=xml[:20]), self.assertRaises(RuntimeError):
                normalize_moments_response('/GetMomentDetail', value)
        value = moment(); value['objectDesc']['iLen'] += 1
        with self.assertRaises(RuntimeError):
            normalize_moments_response('/GetMomentDetail', value)
        with self.assertRaises(RuntimeError):
            normalize_moments_response('/GetMoments', [moment(), moment()])

    def test_known_mutation_api_receipts_never_claim_final_state(self):
        accepted = {'ret': 0, 'submitted': True, 'apiAcknowledged': True, 'confirmed': False}
        for route in ('/PostMoment', '/PostImageMoment', '/ReplyMoment', '/SetSelfNickname', '/SetSelfAvatar', '/SetSelfSignature', '/SetGroupName'):
            for response in ({'code': 1, 'data': None}, {'errCode': 1, 'data': {'baseResponse': {'ret': 0}}}, {'baseResponse': {'ret': 0}}, {'ret': 0, 'oplogRet': {'count': 1, 'ret': [0], 'errMsg': [{}]}}):
                with self.subTest(route=route, response=response):
                    self.assertEqual(normalize_social_mutation(route, response), accepted)
        self.assertEqual(normalize_social_mutation('/SetSelfNickname', {'newName': '小鱼'}, expected={'newName': '小鱼'}), accepted)
        for expected in (None, {'newName': 'other'}, {'nickname': '小鱼'}):
            with self.subTest(expected=expected), self.assertRaisesRegex(RuntimeError, '^HOOK_SOCIAL_RESPONSE_UNKNOWN$'):
                normalize_social_mutation('/SetSelfNickname', {'newName': '小鱼'}, expected=expected)

    def test_native_rejection_and_ambiguous_mutation_responses_remain_distinct(self):
        rejected = {'ret': -1, 'submitted': False, 'apiAcknowledged': False, 'confirmed': False}
        for value in ({'code': 0}, {'code': 1, 'data': {'baseResponse': {'ret': -2}}}, {'ret': 0, 'oplogRet': {'count': 1, 'ret': [-1]}}):
            with self.subTest(value=value):
                self.assertEqual(normalize_social_mutation('/ReplyMoment', value), rejected)
        for value in ({}, [], None, {'status': 'success'}, {'code': True}, {'ret': '0'}, {'code': 1, 'data': []}, {'ret': 0, 'oplogRet': {'count': 0, 'ret': []}}, {'ret': 0, 'oplogRet': {'count': 2, 'ret': [0]}}):
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, '^HOOK_SOCIAL_RESPONSE_UNKNOWN$'):
                normalize_social_mutation('/ReplyMoment', value)
        with self.assertRaisesRegex(ValueError, '^HOOK_ROUTE_UNSUPPORTED$'):
            normalize_social_mutation('/api/sqlite3_exec', {'code': 1})


if __name__ == '__main__':
    unittest.main()
