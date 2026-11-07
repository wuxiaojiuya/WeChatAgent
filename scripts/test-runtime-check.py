"""Read-only backend component checks; no Hook loading or WeChat processes."""
import hashlib
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('runtime_check', pathlib.Path(__file__).with_name('check-runtime.py'))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class RuntimeCheck(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        (self.root / 'config').mkdir()
        self.config = self.root / 'config/wechatagent.json'
        self.config.write_text(json.dumps({'hook': {'backend': 'supplier-http', 'expectedVersion': '4.1.8.27'}}))
        self.folder = self.root / 'components/supplier-hook/4.1.8.27'
        self.folder.mkdir(parents=True)
        self.manifest = []
        for name in ('libGLESv1.dll', 'x64 inject.exe'):
            data = ('fixture-only-' + name).encode()
            (self.folder / name).write_bytes(data)
            self.manifest.append({'file': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        self.manifest_file = self.folder / 'files.sha256.json'
        self.manifest_file.write_text(json.dumps(self.manifest))

    def test_supplier_passes_without_database_components_and_does_not_execute_hook(self):
        with patch.object(check.subprocess, 'run', side_effect=AssertionError('must not launch')):
            check.verify_hook_components(self.root)
        self.assertEqual(sorted(item.name for item in (self.root / 'components').iterdir()), ['supplier-hook'])

    def test_missing_hook_has_precise_error(self):
        (self.folder / 'libGLESv1.dll').unlink()
        with self.assertRaisesRegex(RuntimeError, 'Bundled Hook component missing: libGLESv1.dll'):
            check.verify_hook_components(self.root)

    def test_corrupt_hook_fails_integrity_check(self):
        (self.folder / 'x64 inject.exe').write_bytes(b'corrupted')
        with self.assertRaisesRegex(RuntimeError, 'integrity failed: x64 inject.exe'):
            check.verify_hook_components(self.root)

    def test_unknown_or_duplicate_manifest_names_are_rejected(self):
        for manifest in ([self.manifest[0], self.manifest[0]], [self.manifest[0], {'file': '../../escape'}]):
            self.manifest_file.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(RuntimeError, 'manifest invalid'):
                check.verify_hook_components(self.root)

    def test_unsupported_supplier_version_does_not_pass(self):
        self.config.write_text(json.dumps({'hook': {'backend': 'supplier-http', 'expectedVersion': '4.1.10.27'}}))
        with self.assertRaisesRegex(RuntimeError, 'Only the bundled WeChat 4.1.8.27 Hook is supported'):
            check.verify_hook_components(self.root)

    def test_other_backends_are_rejected_without_fallback(self):
        for hook in ({'backend': 'wechat-hook'}, {'backend': 'anything', 'expectedVersion': '4.1.8.27'}, {}):
            with self.subTest(hook=hook):
                self.config.write_text(json.dumps({'hook': hook}))
                with self.assertRaisesRegex(RuntimeError, 'Only the bundled WeChat 4.1.8.27 Hook is supported'):
                    check.verify_hook_components(self.root)

    def test_receiver_runtime_probe_does_not_require_a_connection(self):
        entry = pathlib.Path(__file__).with_name('hook-receiver.py')
        result = subprocess.run([sys.executable, '-B', str(entry), '--check-runtime'], cwd=self.root,
                                capture_output=True, text=True, encoding='utf-8', timeout=20,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'ok': True, 'receiverReady': True,
                                                    'backend': 'supplier-http', 'wechatVersion': '4.1.8.27'})
        self.assertFalse((self.root / 'state').exists())


if __name__ == '__main__':
    unittest.main()
