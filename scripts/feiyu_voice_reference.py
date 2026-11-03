"""Resolve a registered reference for direct TTS, never an RVC conversion."""
import hashlib
import json
import os
from pathlib import Path
import re


def select_voice(manifest, request):
    key=request.get('voiceId')
    if not key:
        return manifest['styles'][request.get('style', manifest['default_style'])], None
    if not isinstance(key, str) or not re.fullmatch(r'[a-f0-9-]{36}', key):
        raise ValueError('VOICE_PROFILE_INVALID')
    root=Path(os.environ['WECHATAGENT_VOICE_PROFILES']).resolve(strict=True)
    directory=(root/key).resolve(strict=True)
    if directory.parent != root:
        raise ValueError('VOICE_PROFILE_INVALID')
    record=json.loads((directory/'voice.json').read_text(encoding='utf-8'))
    reference=(directory/'reference.wav').resolve(strict=True)
    if reference.parent != directory or record['id'] != key:
        raise ValueError('VOICE_PROFILE_INVALID')
    sha=hashlib.sha256(reference.read_bytes()).hexdigest()
    if sha != record['referenceSha256']:
        raise ValueError('VOICE_REFERENCE_CHANGED')
    if request.get('referenceSha256') != sha:
        raise ValueError('VOICE_REFERENCE_CHANGED_AFTER_SUBMISSION')
    text=record['referenceText']
    if not isinstance(text,str) or not text.strip() or len(text)>500 or any(c in text for c in ('\0','<','>')):
        raise ValueError('VOICE_REFERENCE_TEXT_INVALID')
    # The gentle preset uses the unmodified CosyVoice checkpoint. Only the
    # speaker reference changes; no Feiyu fine-tune or runtime RVC is applied.
    selected=dict(manifest['styles']['gentle'],reference_sha256=sha,reference_text=text)
    if selected['llm_checkpoint'] != manifest['base_model_dir']+'/llm.pt':
        raise ValueError('VOICE_BASE_CHECKPOINT_INVALID')
    return selected, reference
