"""Use verified local WeText assets; avoid network requests during inference."""
import hashlib
import json
import os
from pathlib import Path

directory = os.environ.get('WECHATAGENT_FEIYU_WETEXT')
if directory:
    import modelscope
    original = modelscope.snapshot_download

    def local_snapshot(model_id, *args, **kwargs):
        if model_id != 'pengzhendong/wetext':
            return original(model_id, *args, **kwargs)
        root = Path(directory)
        checks = json.loads((root/'verified-files.json').read_text())
        for name, digest in checks.items():
            path = (root/name).resolve()
            if not path.is_relative_to(root.resolve()) or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                raise RuntimeError('FEIYU_NORMALIZER_INTEGRITY_FAILED')
        return str(root)

    modelscope.snapshot_download = local_snapshot
