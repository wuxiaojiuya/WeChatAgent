import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('voice_reference',Path(__file__).with_name('feiyu_voice_reference.py'))
reference_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(reference_module)
select_voice=reference_module.select_voice


class References(unittest.TestCase):
    def test_reference_and_submission_hash_are_required_and_base_checkpoint_is_used(self):
        with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ,WECHATAGENT_VOICE_PROFILES=temp):
            key='12345678-1234-1234-1234-123456789012'
            folder=Path(temp)/key;folder.mkdir()
            audio=folder/'reference.wav';audio.write_bytes(b'local reference')
            digest=hashlib.sha256(audio.read_bytes()).hexdigest()
            record=dict(id=key,referenceSha256=digest,referenceText='参考文字。')
            (folder/'voice.json').write_text(json.dumps(record),encoding='utf-8')
            manifest=dict(base_model_dir='base',default_style='cute',styles=dict(gentle=dict(llm_checkpoint='base/llm.pt'),cute=dict(llm_checkpoint='fine-tuned.pt')))
            selected,reference=select_voice(manifest,dict(voiceId=key,referenceSha256=digest))
            self.assertEqual(selected['llm_checkpoint'],'base/llm.pt')
            self.assertEqual(selected['reference_text'],'参考文字。')
            self.assertEqual(reference,audio)
            for request in [dict(voiceId='../../elsewhere'),dict(voiceId=key),dict(voiceId=key,referenceSha256='bad')]:
                with self.assertRaises(ValueError):select_voice(manifest,request)
            audio.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'REFERENCE_CHANGED'):select_voice(manifest,dict(voiceId=key,referenceSha256=digest))

    def test_builtin_route_keeps_its_weight_and_reference(self):
        manifest=dict(default_style='cute',styles=dict(cute={'original':True}))
        self.assertEqual(select_voice(manifest,{}),({'original':True},None))


if __name__=='__main__':unittest.main()
