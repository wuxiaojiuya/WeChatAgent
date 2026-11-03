"""Use verified local WeText assets; avoid network requests during inference."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import uuid


def native_directory(root, checks):
    # kaldifst's Windows file API cannot open Unicode filenames. Keep canonical
    # resources in the project; prefer an existing 8.3 alias for native loading.
    if os.name != 'nt' or str(root).isascii():
        return root
    import ctypes

    def short_name(folder):
        buffer = ctypes.create_unicode_buffer(32768)
        count = ctypes.windll.kernel32.GetShortPathNameW(str(folder), buffer, len(buffer))
        return Path(buffer.value) if 0 < count < len(buffer) else folder

    short = short_name(root)
    if str(short).isascii():
        return short
    base = short_name(Path(tempfile.gettempdir()))
    if not str(base).isascii():
        raise RuntimeError('FEIYU_NORMALIZER_ASCII_PATH_REQUIRED')
    key = hashlib.sha256((str(root.resolve()) + json.dumps(checks, sort_keys=True)).encode()).hexdigest()[:24]
    cache = base/'wechatagent-wetext'/key
    cache.mkdir(parents=True, exist_ok=True)
    if cache.is_symlink() or not cache.resolve().is_relative_to(base.resolve()):
        raise RuntimeError('FEIYU_NORMALIZER_CACHE_INVALID')
    for name, digest in checks.items():
        file = cache/name
        if not file.resolve().is_relative_to(cache.resolve()):
            raise RuntimeError('FEIYU_NORMALIZER_CACHE_INVALID')
        if file.is_file() and hashlib.sha256(file.read_bytes()).hexdigest() == digest:
            continue
        file.parent.mkdir(parents=True, exist_ok=True)
        temporary = file.with_name(file.name + '.' + uuid.uuid4().hex)
        shutil.copyfile(root/name, temporary)
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != digest:
            temporary.unlink()
            raise RuntimeError('FEIYU_NORMALIZER_INTEGRITY_FAILED')
        temporary.replace(file)
    return cache

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
        return str(native_directory(root, checks))

    modelscope.snapshot_download = local_snapshot
