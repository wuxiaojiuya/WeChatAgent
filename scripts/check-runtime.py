"""Read-only verification of the packaged reader dependencies."""
import sys
import hashlib
import importlib.util
import pathlib
import subprocess
import json


def verify_hook_components(root):
    config_file = root / 'config/wechatagent.json'
    config = json.loads(config_file.read_text(encoding='utf-8-sig'))
    hook = config.get('hook', {})
    if hook.get('backend') != 'supplier-http':
        if not (root / 'components/weflow-cli/resources/key/win32/x64/wx_key.dll').is_file():
            raise RuntimeError('Reader key component missing')
        return
    if hook.get('expectedVersion') != '4.1.8.27':
        raise RuntimeError('Bundled Hook version unsupported')
    directory = root / 'components/supplier-hook/4.1.8.27'
    manifest_file = directory / 'files.sha256.json'
    if not manifest_file.is_file():
        raise RuntimeError('Bundled Hook manifest missing')
    manifest = json.loads(manifest_file.read_text(encoding='utf-8-sig'))
    expected = {'libGLESv1.dll', 'x64 inject.exe'}
    if not isinstance(manifest, list) or len(manifest) != 2 or any(not isinstance(item, dict) for item in manifest) or {item.get('file') for item in manifest} != expected:
        raise RuntimeError('Bundled Hook manifest invalid')
    for item in manifest:
        file = directory / item['file']
        if not file.is_file():
            raise RuntimeError('Bundled Hook component missing: ' + item['file'])
        if file.stat().st_size != item.get('bytes') or hashlib.sha256(file.read_bytes()).hexdigest() != item.get('sha256'):
            raise RuntimeError('Bundled Hook component integrity failed: ' + item['file'])


def main():
    import sqlcipher3
    import cryptography
    import zstandard
    import Crypto
    import PIL
    import imageio_ffmpeg
    from sqlcipher3 import dbapi2

    connection = dbapi2.connect(':memory:')
    assert connection.execute('select 1').fetchone() == (1,)
    connection.close()
    root = pathlib.Path(__file__).resolve().parent.parent
    sys.path.insert(0, str(root / 'scripts'))
    for name in ('wechat_media', 'wechat_forwarded', 'wechat_quote', 'wechat_sticker_send', 'wechat_sticker', 'wechat_sticker_labels', 'supplier_images', 'supplier_videos', 'supplier_api', 'supplier_reader', 'supplier_contacts', 'supplier_events', 'supplier_actions', 'supplier_social_actions', 'supplier_social_results', 'supplier_social_gateway'):
        if not (root / 'scripts' / (name + '.py')).is_file():
            raise RuntimeError('Reader module missing: ' + name)
    spec = importlib.util.spec_from_file_location('reader_runtime_probe', root / 'scripts/reader-api.py')
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    verify_hook_components(root)
    config = json.loads((root / 'config/wechatagent.json').read_text(encoding='utf-8-sig'))
    if config.get('hook', {}).get('backend') == 'supplier-http':
        startup = subprocess.run([sys.executable, '-B', str(root / 'scripts/supplier-probe.py'), '--check-runtime'],
            capture_output=True, text=True, encoding='utf-8', timeout=20,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            ready = json.loads(startup.stdout)
        except ValueError:
            raise RuntimeError('Hook probe startup check failed') from None
        if startup.returncode or ready.get('probeReady') is not True:
            module = ready.get('module', '')
            raise RuntimeError('Hook probe startup check failed: ' + ready.get('code', 'HOOK_PROBE_FAILED') + (' (' + module + ')' if module else ''))
    # This must run in a fresh child, rather than inheriting the reader's sys.path.
    probe = subprocess.run([sys.executable, '-B', str(root / 'scripts/resolve-wechat-image.py'), '--check-runtime'],
        capture_output=True, text=True, encoding='utf-8', timeout=20,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if probe.returncode:
        code, _ = reader.image_worker_failure(probe.stderr)
        raise RuntimeError('Image worker startup check failed: ' + code)
    try:
        result = json.loads(probe.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise RuntimeError('Image worker returned an invalid startup result') from None
    if result.get('success') is not True or result.get('imageWorkerReady') is not True:
        raise RuntimeError('Image worker startup check did not pass')
    print('Bundled Python reader dependencies, Hook components and image worker verified: ' + sys.version.split()[0])


if __name__ == '__main__':
    main()
