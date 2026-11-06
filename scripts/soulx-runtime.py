"""Pinned SoulX files, verified before loading any serialized checkpoint."""
import hashlib
import json
from pathlib import Path


def digest(file):
    with Path(file).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def specification():
    return json.loads(Path(__file__).with_name('soulx-assets.json').read_text('utf-8'))


def verify_runtime(runtime):
    runtime = Path(runtime)
    spec = specification()
    for relative, expected in spec['sourceFiles'].items():
        file = runtime/'source'/relative
        if not file.is_file() or digest(file) != expected:
            raise RuntimeError('AUDIO_SOULX_SOURCE_INVALID')
    for asset in spec['assets']:
        file = runtime/'source/pretrained_models'/asset['destination']
        if not file.is_file() or file.stat().st_size != asset['bytes'] or digest(file) != asset['sha256']:
            raise RuntimeError('AUDIO_SOULX_MODEL_INVALID')
    for asset in spec['nltk']:
        file = runtime/'nltk_data'/asset['destination']
        if not file.is_file() or digest(file) != asset['sha256']:
            raise RuntimeError('AUDIO_SOULX_RESOURCE_INVALID')
    for relative, expected in spec['nltkFiles'].items():
        file = runtime/'nltk_data'/relative
        if not file.is_file() or digest(file) != expected:
            raise RuntimeError('AUDIO_SOULX_RESOURCE_INVALID')
    return spec
