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


class StickerDiagnostics(unittest.TestCase):
    def test_disabled_download_explains_the_setting_and_preserves_the_original_error_code(self):
        raw = b'fixture-sticker-bytes'
        digest = hashlib.md5(raw).hexdigest()
        xml = f'<msg><emoji md5="{digest}" cdnurl="https://wxapp.tc.qq.com/image?private-token=fixture" /></msg>'
        with tempfile.TemporaryDirectory() as directory, patch.object(sticker, 'download_sticker', return_value=raw) as download:
            with self.assertRaisesRegex(RuntimeError, '^IMAGE_STICKER_LOCAL_COPY_UNAVAILABLE$') as raised:
                sticker.resolve_sticker_bytes(directory, xml, allow_cdn=False)
            download.assert_not_called()
            payload = sticker.sticker_failure_payload(raised.exception)
            code, details = payload['error'], json.dumps(payload)
            self.assertEqual(code, 'IMAGE_STICKER_LOCAL_COPY_UNAVAILABLE')
            self.assertEqual(payload['reason'], 'STICKER_CDN_DISABLED')
            self.assertEqual(payload['setting'], 'wechat.media.allowStickerCdn')
            self.assertNotIn('private-token', json.dumps(payload) + details)
            self.assertEqual(sticker.resolve_sticker_bytes(directory, xml, allow_cdn=True), raw)
            self.assertEqual(download.call_count, 1)

    def test_arbitrary_diagnostic_fields_cannot_leak_urls_keys_or_other_errors(self):
        error = RuntimeError('IMAGE_STICKER_LOCAL_COPY_UNAVAILABLE')
        error.reason = 'https://example.invalid/?private-token=fixture'
        self.assertNotIn('reason', sticker.sticker_failure_payload(error))
        payload = sticker.sticker_failure_payload(error)
        code, details = payload['error'], json.dumps(payload)
        self.assertEqual(code, str(error))
        self.assertNotIn('private-token', details)
        error = RuntimeError('IMAGE_FORMAT_UNSUPPORTED')
        error.reason = 'STICKER_CDN_DISABLED'
        self.assertNotIn('reason', sticker.sticker_failure_payload(error))


if __name__ == '__main__':
    unittest.main()
