"""Offline integration of social gateway, mappings, public results and journal."""
import base64
import hashlib
import io
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
from supplier_reader import stage_media
from supplier_social_gateway import SupplierSocialGateway


PRIVATE = 'wxid_social_friend'
GROUP = 'social_room@chatroom'
PRIVATE_KEY = 'wechat:private:101'
GROUP_KEY = 'wechat:group:202'
IMAGE_ID = 'a' * 64
JOB_ID = '12345678-1234-1234-1234-123456789abc'
MOMENT_ID = '18446744073709551615'
ALLOWED_APIS = {'/api/sns_post', '/api/sns_send_img', '/api/sns_comment_reply',
                '/api/mod_self_nick_name', '/api/upload_head_img',
                '/api/mod_self_nick_signature', '/api/mod_chatroom_topic',
                '/api/sns_get_first_page', '/api/sns_get_detail'}


def operation(name):
    return hashlib.sha256(name.encode()).hexdigest()


def write_json(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(value), encoding='utf-8')


def timeline(identity=MOMENT_ID):
    raw = ('<TimelineObject><id>' + identity + '</id><username>' + PRIVATE + '</username><createTime>1756827024</createTime><contentDesc>文档中的朋友圈格式</contentDesc></TimelineObject>').encode()
    return {'id': identity, 'username': PRIVATE, 'nickname': '好友',
            'createTime': 1756827024, 'commentCount': 0,
            'objectDesc': {'buffer': base64.b64encode(raw).decode(), 'iLen': len(raw)}}


class FakeApi:
    def __init__(self):
        self.calls = []
        self.responses = {}

    def post(self, route, body=None, **options):
        if route not in ALLOWED_APIS:
            raise AssertionError('Unexpected API; database access is forbidden: ' + route)
        self.calls.append((route, body, options))
        result = self.responses.get(route, {'code': 1, 'data': None})
        if isinstance(result, Exception):
            raise result
        return result(route, body) if callable(result) else result


class FakeReader:
    def __init__(self, root):
        self.root = root
        self.account = root/'state/hook/accounts/wxid_social_self'
        self.account.mkdir(parents=True)
        self.api = FakeApi()
        self.image_index = {IMAGE_ID: {'talker': PRIVATE}}
        self.resolved = []
        self.selected = [PRIVATE, GROUP]
        image = io.BytesIO()
        Image.new('RGB', (32, 32), 'red').save(image, format='PNG')
        self.image_bytes = image.getvalue()

    def selected_talkers(self):
        return self.selected

    def conversation_id(self, talker):
        return {PRIVATE: '101', GROUP: '202'}.get(talker)

    def resolve_image(self, image_id):
        self.resolved.append(image_id)
        if image_id not in self.image_index:
            raise PermissionError('IMAGE_REFERENCE_NOT_ALLOWED')
        return {'b64': base64.b64encode(self.image_bytes).decode(),
                'sha256': hashlib.sha256(self.image_bytes).hexdigest()}


class SupplierSocialGatewayTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='social-gateway-')
        self.addCleanup(temporary.cleanup)
        self.base = pathlib.Path(temporary.name)
        self.root = self.base/'工作区'
        self.root.mkdir()
        patcher = patch.dict('os.environ', {'LOCALAPPDATA': str(self.base/'ascii-localappdata')})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.reader = FakeReader(self.root)
        self.gateway = SupplierSocialGateway(self.reader, stage_media)

    def mutate(self, route, name, **body):
        return self.gateway.execute(route, {'conversationKey': PRIVATE_KEY,
                                            'operationId': operation(name), **body})

    def test_all_seven_routes_use_real_mappings_and_only_api_acknowledgements(self):
        cases = [
            ('/PostMoment', {'text': '今天很好'}, '/api/sns_post', {'content': '今天很好', 'blackList': '', 'withauserList': ''}),
            ('/PostImageMoment', {'text': '一张图片', 'imageId': IMAGE_ID}, '/api/sns_send_img', None),
            ('/ReplyMoment', {'content': '谢谢分享', 'sns_id': MOMENT_ID, 'comment_id': 3}, '/api/sns_comment_reply', {'content': '谢谢分享', 'sns_id': MOMENT_ID, 'comment_id': 3}),
            ('/SetSelfNickname', {'newName': '小鱼'}, '/api/mod_self_nick_name', {'newName': '小鱼'}),
            ('/SetSelfAvatar', {'imageId': IMAGE_ID}, '/api/upload_head_img', None),
            ('/SetSelfSignature', {'newSignature': '今天也要开心'}, '/api/mod_self_nick_signature', {'newSignature': '今天也要开心'}),
            ('/SetGroupName', {'conversationKey': GROUP_KEY, 'topic': '新群名', 'wxidorgid': 'forged_room@chatroom'}, '/api/mod_chatroom_topic', {'wxid': GROUP, 'topic': '新群名'}),
        ]
        for route, body, api, expected in cases:
            with self.subTest(route=route):
                result = self.mutate(route, route, **body)
                self.assertEqual(result['state'], 'api-acknowledged')
                self.assertTrue(result['apiAcknowledged'])
                self.assertFalse(result['confirmed'])
                self.assertNotIn('serverId', result)
                actual_api, payload, options = self.reader.api.calls[-1]
                self.assertEqual(actual_api, api)
                self.assertEqual(options['timeout'], 30)
                if expected is not None:
                    self.assertEqual(payload, expected)
                else:
                    field = 'filelist' if route == '/PostImageMoment' else 'filepath'
                    self.assertTrue(payload[field].isascii())
                    self.assertTrue(pathlib.Path(payload[field]).is_file())
                    self.assertEqual(pathlib.Path(payload[field]).read_bytes(), self.reader.image_bytes)
        self.assertEqual(len(self.reader.api.calls), 7)

    def test_operation_journal_deduplicates_restarts_and_detects_conflicts(self):
        first = self.mutate('/PostMoment', 'durable-text', text='只发一次')
        self.gateway = SupplierSocialGateway(self.reader, stage_media)
        reused = self.mutate('/PostMoment', 'durable-text', text='只发一次')
        self.assertTrue(reused['reused'])
        self.assertEqual({k: v for k, v in reused.items() if k != 'reused'}, first)
        self.assertEqual(len(self.reader.api.calls), 1)
        with self.assertRaisesRegex(ValueError, '^HOOK_OPERATION_CONFLICT$'):
            self.mutate('/PostMoment', 'durable-text', text='变更了内容')
        status = self.gateway.execute('/ManagementOperationStatus', {'conversationKey': PRIVATE_KEY, 'operationId': operation('durable-text')})
        self.assertEqual(status, first)
        journal = json.loads(self.gateway.file.read_text())
        self.assertEqual(journal['operations'][operation('durable-text')]['route'], '/PostMoment')
        self.assertEqual(len(self.reader.api.calls), 1)

    def test_timeouts_and_unknown_raw_results_never_trigger_a_second_submission(self):
        for response in (RuntimeError('HOOK_UPSTREAM_TIMEOUT'), {}, {'status': 'success', 'token': 'do-not-export'}):
            with self.subTest(response=response):
                name = repr(response)
                self.reader.api.responses['/api/sns_post'] = response
                before = len(self.reader.api.calls)
                first = self.mutate('/PostMoment', name, text='不可重试')
                self.assertEqual(first['state'], 'unconfirmed')
                self.assertFalse(first['apiAcknowledged'])
                self.assertFalse(first['confirmed'])
                self.assertIn('code', first)
                self.assertNotIn('do-not-export', json.dumps(first))
                self.gateway = SupplierSocialGateway(self.reader, stage_media)
                reused = self.mutate('/PostMoment', name, text='不可重试')
                self.assertTrue(reused['reused'])
                self.assertEqual(reused['state'], 'unconfirmed')
                self.assertEqual(len(self.reader.api.calls), before + 1)

    def test_explicit_rejection_is_distinct_and_is_not_retried(self):
        self.reader.api.responses['/api/mod_self_nick_signature'] = {'ret': -1}
        first = self.mutate('/SetSelfSignature', 'rejected', signature='签名')
        self.assertEqual(first['state'], 'rejected')
        self.assertFalse(first['apiAcknowledged'])
        self.assertFalse(first['confirmed'])
        self.gateway = SupplierSocialGateway(self.reader, stage_media)
        self.assertTrue(self.mutate('/SetSelfSignature', 'rejected', signature='签名')['reused'])
        self.assertEqual(len(self.reader.api.calls), 1)

    def test_unknown_intent_is_durable_before_the_upstream_mutation_begins(self):
        identity = operation('pre-submit-journal')
        def inspect_journal(route, payload):
            saved = json.loads(self.gateway.file.read_text())['operations'][identity]
            self.assertEqual(saved['result']['state'], 'unconfirmed')
            self.assertFalse(saved['result']['apiAcknowledged'])
            self.assertFalse(saved['result']['confirmed'])
            return {'code': 1, 'data': None}
        self.reader.api.responses['/api/sns_post'] = inspect_journal
        result = self.mutate('/PostMoment', 'pre-submit-journal', text='先记意图再提交')
        self.assertEqual(result['state'], 'api-acknowledged')
        self.assertEqual(len(self.reader.api.calls), 1)

    def test_scope_and_status_cannot_cross_conversations(self):
        self.mutate('/PostMoment', 'bound-scope', text='有范围的操作')
        for key in ('', 'wechat:private:999', 'wechat:group:101', 'wechat:private:101/../../'):
            with self.subTest(key=key), self.assertRaises(PermissionError):
                self.gateway.execute('/PostMoment', {'conversationKey': key, 'operationId': operation('denied-' + key), 'text': '不应发送'})
        with self.assertRaises(PermissionError):
            self.gateway.execute('/ManagementOperationStatus', {'conversationKey': GROUP_KEY, 'operationId': operation('bound-scope')})
        with self.assertRaises(PermissionError):
            self.mutate('/SetGroupName', 'private-group-rename', topic='不应修改')
        self.reader.selected.remove(PRIVATE)
        with self.assertRaises(PermissionError):
            self.gateway.execute('/ManagementOperationStatus', {'conversationKey': PRIVATE_KEY, 'operationId': operation('bound-scope')})
        self.assertEqual(len(self.reader.api.calls), 1)

    def test_received_image_must_belong_to_current_conversation_and_is_staged_ascii(self):
        with self.assertRaises(PermissionError):
            self.mutate('/PostImageMoment', 'wrong-chat-image', conversationKey=GROUP_KEY, imageId=IMAGE_ID)
        self.assertEqual(self.reader.resolved, [])
        with self.assertRaises(PermissionError):
            self.mutate('/SetSelfAvatar', 'wrong-image-id', imageId='f' * 64)
        with self.assertRaises(ValueError):
            self.mutate('/PostImageMoment', 'raw-image-path', path=str(self.root/'不可信路径.png'))
        with self.assertRaises(ValueError):
            self.mutate('/PostImageMoment', 'two-images', imageIds=[IMAGE_ID, IMAGE_ID])
        self.mutate('/SetSelfAvatar', 'allowed-avatar', imageId=IMAGE_ID)
        wire_file = self.reader.api.calls[0][1]['filepath']
        self.assertTrue(wire_file.isascii())
        self.assertFalse(str(self.root).isascii())
        self.assertEqual(pathlib.Path(wire_file).read_bytes(), self.reader.image_bytes)
        # A completed operation remains inspectable even if its original
        # message attachment has expired from the bounded media catalog.
        self.reader.image_index.clear()
        self.gateway = SupplierSocialGateway(self.reader, stage_media)
        self.assertTrue(self.mutate('/SetSelfAvatar', 'allowed-avatar', imageId=IMAGE_ID)['reused'])
        self.assertEqual(len(self.reader.api.calls), 1)

    def create_drawing(self, **changes):
        folder = self.root/'state/drawing/jobs'/JOB_ID
        folder.mkdir(parents=True, exist_ok=True)
        (folder/'image.png').write_bytes(self.reader.image_bytes)
        write_json(self.root/'state/hook/active-connection.json', {'id': 'cached-scope'})
        write_json(folder/'job.json', {'id': JOB_ID, 'state': 'success', 'conversationKey': PRIVATE_KEY,
                                     'accountScope': 'cached-scope', **changes})

    def test_drawing_job_is_bound_to_conversation_and_saved_resource_scope(self):
        self.create_drawing()
        self.mutate('/PostImageMoment', 'drawing-post', drawingJobId=JOB_ID, text='自己的画')
        path = self.reader.api.calls[0][1]['filelist']
        self.assertTrue(path.isascii())
        self.assertEqual(pathlib.Path(path).read_bytes(), self.reader.image_bytes)
        for change in ({'conversationKey': GROUP_KEY}, {'accountScope': 'other-scope'}, {'state': 'running'}):
            self.create_drawing(**change)
            with self.subTest(change=change), self.assertRaises(PermissionError):
                self.mutate('/SetSelfAvatar', repr(change), drawingJobId=JOB_ID)
        self.assertEqual(len(self.reader.api.calls), 1)

    def test_moments_reads_return_only_recognized_public_objects_without_mutation_journal(self):
        self.reader.api.responses['/api/sns_get_first_page'] = {'code': 1, 'data': [timeline()]}
        page = self.gateway.execute('/GetMoments', {'conversationKey': PRIVATE_KEY})
        self.assertEqual(page['moments'][0]['id'], MOMENT_ID)
        self.assertFalse(self.gateway.file.exists())
        self.reader.api.responses['/api/sns_get_detail'] = timeline()
        detail = self.gateway.execute('/GetMomentDetail', {'conversationKey': PRIVATE_KEY, 'sns_id': MOMENT_ID})
        self.assertEqual(detail['moment'], page['moments'][0])
        self.assertEqual(self.reader.api.calls[-1][1], {'sns_id': int(MOMENT_ID)})
        self.reader.api.responses['/api/sns_get_detail'] = timeline('2')
        with self.assertRaisesRegex(RuntimeError, '^HOOK_MOMENT_IDENTITY_MISMATCH$'):
            self.gateway.execute('/GetMomentDetail', {'conversationKey': PRIVATE_KEY, 'sns_id': MOMENT_ID})
        self.reader.api.responses['/api/sns_get_first_page'] = {'code': 1, 'data': {'unknown': 'PRIVATE_TOKEN'}}
        with self.assertRaisesRegex(RuntimeError, '^HOOK_MOMENTS_RESPONSE_UNKNOWN$'):
            self.gateway.execute('/GetMoments', {'conversationKey': PRIVATE_KEY})
        self.assertFalse(self.gateway.file.exists())


if __name__ == '__main__':
    unittest.main()
