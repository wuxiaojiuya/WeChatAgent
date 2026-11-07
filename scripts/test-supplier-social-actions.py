"""Offline mappings for Moments/profile actions; no real account is changed."""
import io
import json
import pathlib
import tempfile
import unittest

from PIL import Image
from supplier_social_actions import map_social_action


class SupplierSocialActions(unittest.TestCase):
    def test_text_moment_has_exact_required_documented_fields(self):
        self.assertEqual(map_social_action('/PostMoment', {'content': '今天心情不错 🌞'}), (
            '/api/sns_post', {'content': '今天心情不错 🌞', 'blackList': '', 'withauserList': ''}))
        self.assertEqual(map_social_action('/PostMoment', {'content': 'hello', 'blackList': 'wxid_a,wxid_a', 'withauserList': 'wxid_b'})[1],
                         {'content': 'hello', 'blackList': 'wxid_a', 'withauserList': 'wxid_b'})
        for mutation in ({'content': ''}, {'content': 'a\0b'}, {'blackList': ['wxid_a']}, {'withauserList': '123@chatroom'}):
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                map_social_action('/PostMoment', {'content': 'hi', **mutation})

    def test_profile_and_group_requests_use_exact_field_names(self):
        self.assertEqual(map_social_action('/SetSelfNickname', {'newName': '鸭梨🍐大a'}), ('/api/mod_self_nick_name', {'newName': '鸭梨🍐大a'}))
        self.assertEqual(map_social_action('/SetSelfNickname', {'nickname': '小鱼'}), ('/api/mod_self_nick_name', {'newName': '小鱼'}))
        self.assertEqual(map_social_action('/SetSelfSignature', {'newSignature': '认真生活'}), ('/api/mod_self_nick_signature', {'newSignature': '认真生活'}))
        self.assertEqual(map_social_action('/SetSelfSignature', {'signature': ''}), ('/api/mod_self_nick_signature', {'newSignature': ''}))
        self.assertEqual(map_social_action('/SetGroupName', {'wxidorgid': '49767299448@chatroom', 'topic': '新群名称'}), ('/api/mod_chatroom_topic', {'wxid': '49767299448@chatroom', 'topic': '新群名称'}))
        for route, body in (('/SetSelfNickname', {'newName': ' '}), ('/SetSelfNickname', {'newName': 'a' * 513}),
                            ('/SetSelfSignature', {}), ('/SetSelfSignature', {'signature': '\0'}),
                            ('/SetGroupName', {'wxidorgid': 'wxid_friend', 'topic': 'rename'}),
                            ('/SetGroupName', {'wxidorgid': '123@chatroom', 'topic': ''})):
            with self.subTest(route=route, body=body), self.assertRaises(ValueError):
                map_social_action(route, body)

    def test_reply_preserves_full_uint64_and_requires_integer_comment_id(self):
        identity = '18446744073709551615'
        self.assertEqual(map_social_action('/ReplyMoment', {'content': '好听', 'sns_id': identity, 'comment_id': 3}),
                         ('/api/sns_comment_reply', {'content': '好听', 'sns_id': identity, 'comment_id': 3}))
        self.assertEqual(map_social_action('/ReplyMoment', {'content': '赞', 'momentId': identity, 'commentId': 0})[1]['comment_id'], 0)
        for value in ('', '0', '01', '-1', '18446744073709551616', 18446744073709551615, 1.0, True):
            with self.subTest(identity=value), self.assertRaises(ValueError):
                map_social_action('/ReplyMoment', {'content': 'reply', 'sns_id': value, 'comment_id': 1})
        for value in (-1, '3', True, 0x100000000):
            with self.subTest(comment=value), self.assertRaises(ValueError):
                map_social_action('/ReplyMoment', {'content': 'reply', 'sns_id': identity, 'comment_id': value})

    def test_moments_read_context_uses_dedicated_endpoints_without_precision_loss(self):
        self.assertEqual(map_social_action('/GetMoments', {}), ('/api/sns_get_first_page', {'firstPageMd5': '', 'maxId': ''}))
        self.assertEqual(map_social_action('/GetMoments', {'firstPageMd5': 'a' * 32, 'maxId': '18446744073709551615'})[1]['maxId'], '18446744073709551615')
        route, body = map_social_action('/GetMomentDetail', {'sns_id': '18446744073709551615'})
        self.assertEqual(route, '/api/sns_get_detail')
        self.assertEqual(json.dumps(body), '{"sns_id": 18446744073709551615}')
        for mutation in ({'firstPageMd5': 'invalid'}, {'firstPageMd5': None}, {'maxId': 123}, {'maxId': '18446744073709551616'}):
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                map_social_action('/GetMoments', mutation)

    def test_image_post_and_avatar_validate_real_local_images_without_guessing_multi_image_delimiters(self):
        with tempfile.TemporaryDirectory() as directory:
            image = pathlib.Path(directory) / '头像.png'
            Image.new('RGB', (32, 32), 'blue').save(image)
            self.assertEqual(map_social_action('/PostImageMoment', {'path': str(image), 'content': '分享一张图'}),
                             ('/api/sns_send_img', {'filelist': str(image.resolve()), 'content': '分享一张图'}))
            self.assertEqual(map_social_action('/PostImageMoment', {'paths': [str(image)]})[1], {'filelist': str(image.resolve()), 'content': ''})
            self.assertEqual(map_social_action('/PostImageMoment', {'filelist': str(image)})[1]['filelist'], str(image.resolve()))
            self.assertEqual(map_social_action('/SetSelfAvatar', {'path': str(image)}), ('/api/upload_head_img', {'filepath': str(image.resolve())}))
            self.assertEqual(map_social_action('/SetSelfAvatar', {'filepath': str(image)})[1]['filepath'], str(image.resolve()))
            for paths in ([], [str(image), str(image)], ['relative.png']):
                with self.subTest(paths=paths), self.assertRaises(ValueError):
                    map_social_action('/PostImageMoment', {'paths': paths})
            for path in ('relative.png', str(image.with_name('absent.png')), str(image.with_suffix('.txt'))):
                with self.subTest(path=path), self.assertRaises(ValueError):
                    map_social_action('/SetSelfAvatar', {'path': path})
            image.write_bytes(b'not an image')
            with self.assertRaises(ValueError):
                map_social_action('/SetSelfAvatar', {'path': str(image)})
            image.write_bytes(b'a' * (16 * 1024 * 1024 + 1))
            with self.assertRaises(ValueError):
                map_social_action('/SetSelfAvatar', {'path': str(image)})

    def test_unknown_routes_and_non_object_bodies_fail_without_side_effects(self):
        with self.assertRaisesRegex(ValueError, '^HOOK_ROUTE_UNSUPPORTED$'):
            map_social_action('/api/sqlite3_exec', {})
        for value in (None, [], 'text'):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, '^HOOK_REQUEST_INVALID$'):
                map_social_action('/PostMoment', value)


if __name__ == '__main__':
    unittest.main()
