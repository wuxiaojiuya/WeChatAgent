"""Synthetic Hook voice callbacks only; no client database or network."""
import base64
import hashlib
import importlib.util
import json
import pathlib
import sys
import tempfile
import threading
import types
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from wechat_voice_input import VoiceCatalog, voice_info, audio_policy

spec = importlib.util.spec_from_file_location('voice_reader_test', pathlib.Path(__file__).with_name('hook_receiver_core.py'))
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

KEY = 'wechat:private:123'
SILK = b'\x02#!SILK_V3\nsynthetic'


class VoiceBoundaries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.account = self.root/'account'
        self.account.mkdir(parents=True)
        (self.root/'config').mkdir()
        (self.root/'config/wechatagent.json').write_text(json.dumps({'wechat': {'whitelist': {'private': ['123'], 'groups': []}}}))
        self.policy = {'version': 1, 'plugins': {'speech-recognition': {'enabled': True, 'permissions': ['audio_read'], 'chats': [KEY]}}}
        self.save_policy()
        self.active = True
        self.catalog = VoiceCatalog(self.root, self.account, lambda: self.active)
        self.message = {'localType': 34, 'senderUsername': 'contact-alpha', 'localId': 7, 'serverId': '123456789012345678', 'createTime': 100, 'fullText': '<msg><voicemsg voicelength="2500"/></msg>'}
        self.payload = api.push_payload('contact-alpha', self.message, {}, 'owner-account')
        self.ref = self.catalog.remember('contact-alpha', self.payload, KEY)

    def save_policy(self):
        (self.root/'config/plugins.json').write_text(json.dumps(self.policy))

    def test_voice_payload_is_bounded_metadata_and_excludes_xml_and_self_messages(self):
        self.assertEqual(self.payload['content'], '[语音，尚未转写]')
        self.assertEqual(self.payload['voice']['durationSeconds'], 2.5)
        self.assertNotIn('voicemsg', json.dumps(self.payload))
        self.assertIsNone(api.push_payload('contact-alpha', {**self.message, 'isSend': True}, {}, 'owner-account'))
        self.assertIsNone(voice_info('<!DOCTYPE msg><msg><voicemsg voicelength="1"/></msg>'))
        self.assertIsNone(voice_info('<msg><voicemsg voicelength="60001"/></msg>'))

    def test_disabled_plugin_wrong_chat_account_or_missing_grant_never_returns_audio(self):
        self.assertTrue(audio_policy(self.root, KEY))
        with self.assertRaises(PermissionError): self.catalog.record(self.ref['id'], 'wechat:private:456', 'speech-recognition')
        self.policy['plugins']['speech-recognition']['permissions'] = []
        self.save_policy()
        with self.assertRaises(PermissionError): self.catalog.record(self.ref['id'], KEY, 'speech-recognition')
        self.assertIsNone(self.catalog.remember('contact-alpha', self.payload, KEY))
        self.active = False
        with self.assertRaises(PermissionError): self.catalog.record(self.ref['id'], KEY, 'speech-recognition')

    def reader(self, sender='contact-alpha', server_id='123456789012345678'):
        from unittest.mock import patch
        from types import SimpleNamespace
        reader = api.HookReceiver.__new__(api.HookReceiver)
        reader.root, reader.account, reader.voices = self.root, self.account, self.catalog
        reader.voice_slots = threading.BoundedSemaphore(2)
        row = {**self.message, 'senderUsername': sender, 'serverId': str(server_id),
               'rawid': self.payload['rawid'], 'callback': {'length': str(len(SILK))}}
        def exact(talker, identity):
            if talker != 'contact-alpha' or any(str(row[name]) != str(identity[name]) for name in ('localId','serverId','createTime')):
                return None
            return row
        reader.events = SimpleNamespace(exact=exact)
        reader.image_talker_allowed = lambda talker: talker == 'contact-alpha' and self.active
        def post(route, body, **kwargs):
            if route != '/api/download_voice':
                raise AssertionError('Only the dedicated voice download is allowed')
            self.assertEqual(body['newMsgId'], self.message['serverId'])
            pathlib.Path(body['path']).write_bytes(SILK)
            return {'code': 1}
        reader.api = SimpleNamespace(post=post)
        env_patch = patch.dict('os.environ', {'LOCALAPPDATA': str(self.root/'localappdata')})
        env_patch.start();self.addCleanup(env_patch.stop)
        return reader

    def test_complete_message_identity_and_real_sender_are_verified_before_media_read(self):
        for reader in (self.reader(sender='wxid_other'), self.reader(server_id=999)):
            with self.assertRaisesRegex(RuntimeError, '(VOICE|HOOK)_MESSAGE_IDENTITY_NOT_FOUND'):
                reader.resolve_voice(self.ref['id'], KEY, 'speech-recognition', 'silk')

    def test_silk_response_has_only_bound_audio_and_digest_and_rechecks_revocation(self):
        from unittest.mock import patch
        reader = self.reader()
        result = reader.resolve_voice(self.ref['id'], KEY, 'speech-recognition', 'silk')
        self.assertEqual(base64.b64decode(result['b64']), SILK)
        self.assertEqual(result['conversationKey'], KEY)
        self.assertEqual(result['sha256'], hashlib.sha256(SILK).hexdigest())
        self.assertNotIn('account', result)
        def revoke(*_):
            self.active = False
            return SILK
        with patch.object(reader, 'voice_blob', revoke):
            with self.assertRaises(PermissionError): reader.resolve_voice(self.ref['id'], KEY, 'speech-recognition', 'silk')

    def test_decoder_is_optional_and_requires_no_model(self):
        decoder_spec = importlib.util.spec_from_file_location('voice_decoder_test', pathlib.Path(__file__).with_name('decode-wechat-voice.py'))
        decoder = importlib.util.module_from_spec(decoder_spec)
        decoder_spec.loader.exec_module(decoder)
        from unittest.mock import patch
        with patch.dict(sys.modules, {'pilk': None}), patch.object(decoder, 'wasm_command', return_value=None):
            with self.assertRaisesRegex(RuntimeError, 'VOICE_DECODER_MISSING'): decoder.decode(SILK)


if __name__ == '__main__':
    unittest.main()
