"""Offline regressions for exact-variant video downloads; no real Hook calls."""
import hashlib
import pathlib
import tempfile
import threading
import unittest
import xml.etree.ElementTree as ET
from types import SimpleNamespace
from unittest.mock import patch

from supplier_videos import download_video


class SupplierVideo(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.data = b'\x00\x00\x00\x20ftyp' + b'exact-message-video'*10
        self.item = {'talker':'wxid_friend', 'serverId':'8047442179716189588',
            'size':len(self.data), 'md5':hashlib.md5(self.data).hexdigest()}
        self.id = 'a'*64
        self.node = ET.fromstring('<videomsg cdnvideourl="bound-cdn-file" aeskey="'+'b'*32+'"/>')
        self.calls = []
        self.allowed = True
        self.reader = SimpleNamespace(root=self.root, callback_messages={}, callback_lock=threading.Lock(),
            own_wxid='wxid_self', active_identity=lambda:None, image_talker_allowed=lambda _:self.allowed,
            api=SimpleNamespace(post=self.upstream))
        patcher = patch('supplier_videos.runtime_directory', return_value=self.root/'runtime')
        patcher.start()
        self.addCleanup(patcher.stop)

    def upstream(self, route, body, **options):
        self.calls.append((route, body))
        pathlib.Path(body.get('out') or body['path']).write_bytes(self.data)
        return {'errCode':0}

    def callback(self, **changes):
        self.reader.callback_messages[self.item['serverId']] = {
            'msgId':42, 'from':'wxid_friend', 'to':'wxid_self', 'type':43, **changes}

    def test_cdn_exact_variant_replaces_stale_partial_and_needs_no_callback(self):
        cached = self.root/'runtime/incoming-video'/(self.id+'.mp4')
        cached.parent.mkdir(parents=True)
        cached.write_bytes(b'different-truncated-variant')
        result = download_video(self.reader, self.id, self.item, self.node)
        self.assertEqual(result.read_bytes(), self.data)
        self.assertEqual([route for route,_ in self.calls], ['/api/cdn_download'])
        self.assertEqual(self.calls[0][1]['imgType'],4)
        self.reader.callback_messages.clear()
        self.assertEqual(download_video(self.reader,self.id,self.item,self.node),result)
        self.assertEqual(len(self.calls),1)

    def test_rejected_cdn_variant_falls_back_to_exact_callback_ids(self):
        self.callback(msgId='42')
        def upstream(route, body, **options):
            if route == '/api/cdn_download':
                self.calls.append((route,body))
                pathlib.Path(body['out']).write_bytes(b'x'*self.item['size'])
                return {'errCode':0}
            return self.upstream(route,body,**options)
        self.reader.api.post = upstream
        result = download_video(self.reader,self.id,self.item,self.node)
        self.assertEqual(result.read_bytes(),self.data)
        self.assertEqual(self.calls[-1][1]['NewMsgId'],8047442179716189588)
        self.assertEqual(self.calls[-1][1]['MsgId'],42)

    def test_integrity_failure_is_never_cached(self):
        def upstream(route, body, **options):
            pathlib.Path(body['out']).write_bytes(b'x'*self.item['size'])
        self.reader.api.post=upstream
        with self.assertRaisesRegex(RuntimeError,'VIDEO_INTEGRITY_FAILED'):
            download_video(self.reader,self.id,self.item,self.node)
        self.assertFalse((self.root/'runtime/incoming-video'/(self.id+'.mp4')).exists())

    def test_file_proves_download_after_http_timeout_and_revocation_prevents_use(self):
        def upstream(route, body, **options):
            self.upstream(route,body,**options)
            raise RuntimeError('HOOK_UPSTREAM_UNAVAILABLE')
        self.reader.api.post=upstream
        result=download_video(self.reader,self.id,self.item,self.node)
        self.assertEqual(result.read_bytes(),self.data)
        self.allowed=False
        with self.assertRaises(PermissionError):download_video(self.reader,self.id,self.item,self.node)

    def test_cross_chat_or_boolean_callback_ids_cannot_download_without_cdn(self):
        for changes in ({'from':'wxid_other'}, {'to':'wxid_other'}, {'type':3}, {'msgId':True}):
            self.callback(**changes)
            with self.assertRaisesRegex(RuntimeError,'VIDEO_CALLBACK_METADATA_REQUIRED'):
                download_video(self.reader,self.id,self.item,ET.fromstring('<videomsg/>'))
        self.assertEqual(self.calls,[])


if __name__ == '__main__':
    unittest.main()
