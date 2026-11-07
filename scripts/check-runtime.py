"""Offline verification of the Hook-only runtime; never inspect a WeChat database."""
import sys
import hashlib
import pathlib
import subprocess
import json


def verify_hook_components(root):
    config_file = root / 'config/wechatagent.json'
    config = json.loads(config_file.read_text(encoding='utf-8-sig'))
    hook = config.get('hook', {})
    if hook.get('backend') != 'supplier-http' or hook.get('expectedVersion') != '4.1.8.27':
        raise RuntimeError('Only the bundled WeChat 4.1.8.27 Hook is supported')
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
    import Crypto
    import PIL
    import imageio_ffmpeg
    root = pathlib.Path(__file__).resolve().parent.parent
    sys.path.insert(0, str(root / 'scripts'))
    for name in ('wechat_media', 'wechat_forwarded', 'wechat_quote', 'wechat_sticker_send', 'wechat_sticker', 'wechat_sticker_labels', 'supplier_images', 'supplier_videos', 'supplier_api', 'supplier_reader', 'supplier_contacts', 'supplier_events', 'supplier_actions', 'supplier_social_actions', 'supplier_social_results', 'supplier_social_gateway'):
        if not (root / 'scripts' / (name + '.py')).is_file():
            raise RuntimeError('Hook module missing: ' + name)
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
    # A fresh process verifies the receiver without connecting to WeChat.
    probe = subprocess.run([sys.executable, '-B', str(root / 'scripts/hook-receiver.py'), '--check-runtime'],
        capture_output=True, text=True, encoding='utf-8', timeout=20,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if probe.returncode:
        raise RuntimeError('Hook receiver runtime import check failed')
    try:
        result = json.loads(probe.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise RuntimeError('Hook receiver returned an invalid startup result') from None
    if result.get('receiverReady') is not True:
        raise RuntimeError('Hook receiver startup check did not pass')
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-version'], check=True, capture_output=True, timeout=20,
                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    print('Bundled Hook receiver, media codecs and WeChat 4.1.8.27 components verified: ' + sys.version.split()[0])


if __name__ == '__main__':
    main()
