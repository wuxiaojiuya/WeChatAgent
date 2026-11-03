"""Synthetic CDN opt-in diagnostics; never connects to a real account or CDN."""
import hashlib
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
import wechat_sticker as sticker
spec = importlib.util.spec_from_file_location('diagnostic_worker', SCRIPTS / 'resolve-wechat-image.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class StickerDiagnostics(unittest.TestCase):
    def test_disabled_download_explains_the_setting_and_preserves_the_original_error_code(self):
        raw = b'fixture-sticker-bytes'
        digest = hashlib.md5(raw).hexdigest()
        xml = f'<msg><emoji md5="{digest}" cdnurl="https://wxapp.tc.qq.com/image?private-token=fixture" /></msg>'
        with tempfile.TemporaryDirectory() as directory, patch.object(sticker, 'download_sticker', return_value=raw) as download:
            with self.assertRaisesRegex(RuntimeError, '^IMAGE_STICKER_LOCAL_COPY_UNAVAILABLE$') as raised:
                sticker.resolve_sticker_bytes(directory, xml, allow_cdn=False)
            download.assert_not_called()
            payload = worker.image_failure_payload(raised.exception)
            code, details = worker.reader_api.image_worker_failure(json.dumps(payload))
            self.assertEqual(code, 'IMAGE_STICKER_LOCAL_COPY_UNAVAILABLE')
            self.assertIn('reason=STICKER_CDN_DISABLED', details)
            self.assertIn('setting=wechat.media.allowStickerCdn', details)
            self.assertNotIn('private-token', json.dumps(payload) + details)
            self.assertEqual(sticker.resolve_sticker_bytes(directory, xml, allow_cdn=True), raw)
            self.assertEqual(download.call_count, 1)

    def test_arbitrary_diagnostic_fields_cannot_leak_urls_keys_or_other_errors(self):
        error = RuntimeError('IMAGE_STICKER_LOCAL_COPY_UNAVAILABLE')
        error.reason = 'https://example.invalid/?private-token=fixture'
        self.assertNotIn('reason', worker.image_failure_payload(error))
        code, details = worker.reader_api.image_worker_failure(json.dumps({'error': str(error), 'reason': error.reason, 'setting': error.reason}))
        self.assertEqual(code, str(error))
        self.assertNotIn('private-token', details)
        error = RuntimeError('IMAGE_FORMAT_UNSUPPORTED')
        error.reason = 'STICKER_CDN_DISABLED'
        self.assertNotIn('reason', worker.image_failure_payload(error))


if __name__ == '__main__':
    unittest.main()
