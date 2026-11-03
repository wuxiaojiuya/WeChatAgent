"""Read-only backend component checks; no Hook loading or WeChat processes."""
import hashlib
import importlib.util
import json
import pathlib
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

    def test_supplier_passes_without_legacy_key_and_does_not_execute_hook(self):
        with patch.object(check.subprocess, 'run', side_effect=AssertionError('must not launch')):
            check.verify_hook_components(self.root)
        self.assertFalse((self.root / 'components/weflow-cli/resources/key/win32/x64/wx_key.dll').exists())

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
        with self.assertRaisesRegex(RuntimeError, 'version unsupported'):
            check.verify_hook_components(self.root)

    def test_legacy_backend_still_requires_key_component(self):
        self.config.write_text(json.dumps({'hook': {'backend': 'wechat-hook'}}))
        with self.assertRaisesRegex(RuntimeError, 'Reader key component missing'):
            check.verify_hook_components(self.root)
        key = self.root / 'components/weflow-cli/resources/key/win32/x64/wx_key.dll'
        key.parent.mkdir(parents=True)
        key.write_bytes(b'fixture-only')
        check.verify_hook_components(self.root)


if __name__ == '__main__':
    unittest.main()
