import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
import threading
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import unittest
import zipfile

spec=importlib.util.spec_from_file_location('installer',Path(__file__).with_name('install-audio-runtime.py'))
installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def test_invalid_archives_never_extract_any_members(self):
        for name in ['../outside','C:/outside','/absolute','a/../b','a:stream','NUL.txt','dir./file']:
            with self.subTest(name=name),tempfile.TemporaryDirectory() as temp:
                root=Path(temp);archive=root/'test.zip'
                with zipfile.ZipFile(archive,'w') as z:z.writestr('good.txt','ok');z.writestr(name,'bad')
                with self.assertRaisesRegex(RuntimeError,'AUDIO_ARCHIVE_PATH_INVALID'):installer.extract(archive,root/'out')
                self.assertFalse((root/'out/good.txt').exists())
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);archive=root/'test.zip'
            with zipfile.ZipFile(archive,'w') as z:
                link=zipfile.ZipInfo('link');link.external_attr=(stat.S_IFLNK|0o777)<<16;z.writestr(link,'../out')
            with self.assertRaisesRegex(RuntimeError,'AUDIO_ARCHIVE_PATH_INVALID'):installer.extract(archive,root/'out')

    def test_windows_case_alias_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);archive=root/'test.zip'
            with zipfile.ZipFile(archive,'w') as z:z.writestr('A.txt','1');z.writestr('a.txt','2')
            with self.assertRaisesRegex(RuntimeError,'DUPLICATE'):installer.extract(archive,root/'out')

    def test_resumable_download_and_digest_gate(self):
        payload=b'actual trusted package'*100;requests=[]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*_):pass
            def do_GET(self):
                offset=int(self.headers.get('Range','bytes=0-')[6:-1]);requests.append(offset)
                self.send_response(206 if offset else 200);self.send_header('Content-Length',str(len(payload)-offset))
                self.send_header('Content-Range',f'bytes {offset}-{len(payload)-1}/{len(payload)}');self.end_headers();self.wfile.write(payload[offset:])
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with tempfile.TemporaryDirectory() as temp,contextlib.redirect_stdout(io.StringIO()):
                target=Path(temp)/'bundle.zip';target.with_suffix('.zip.partial').write_bytes(payload[:100])
                url=f'http://127.0.0.1:{server.server_port}/bundle.zip'
                installer.download(url,target,hashlib.sha256(payload).hexdigest(),len(payload));self.assertEqual(requests,[100]);self.assertEqual(target.read_bytes(),payload)
                target.unlink()
                with self.assertRaisesRegex(RuntimeError,'HASH_MISMATCH'):installer.download(url,target,'0'*64,len(payload))
                self.assertFalse(target.exists());self.assertFalse(target.with_suffix('.zip.partial').exists())
        finally:server.shutdown();server.server_close();thread.join()

    def test_failed_activation_restores_environment_and_preserves_private_data(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);target=root/'state/maintenance/audio-capabilities/feiyu-tts/venv';target.mkdir(parents=True);(target/'old').write_text('old')
            (target/'old').chmod(stat.S_IREAD)
            secret=target.parent/'service-data/api_key.txt';secret.parent.mkdir();secret.write_text('private-test-value')
            staged=root/'state/audio-install/staging/one/venv';staged.mkdir(parents=True);(staged/'new').write_text('new')
            def fail():self.assertTrue((target/'new').exists());raise ValueError('validation failed')
            with self.assertRaisesRegex(ValueError,'validation failed'):installer.activate(root,[(staged,target)],fail,root/'unused')
            self.assertEqual((target/'old').read_text(),'old');self.assertFalse((target/'new').exists());self.assertEqual(secret.read_text(),'private-test-value')
            self.assertEqual(json.loads((root/'state/audio-install/activation.json').read_text())['state'],'rolled-back')

    def test_interrupted_activation_recovers_on_next_run(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);target=root/'state/maintenance/audio-capabilities/feiyu-cover/venv';target.mkdir(parents=True);(target/'new').touch()
            old=root/'state/audio-install/backups/one/0';old.mkdir(parents=True);(old/'old').touch()
            staged=root/'state/audio-install/staging/one/venv'
            installer.write_json(root/'state/audio-install/activation.json',{'state':'activating','operations':[{'target':str(target),'staged':str(staged),'backup':str(old),'hadOriginal':True}]})
            installer.recover(root);self.assertTrue((target/'old').exists());self.assertFalse((target/'new').exists())

    def test_journal_cannot_delete_unowned_project_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);important=root/'config';important.mkdir();(important/'keep').touch()
            installer.write_json(root/'state/audio-install/activation.json',{'state':'activating','operations':[{'target':str(important),'staged':str(root/'state/audio-install/staging/none'),'backup':str(root/'state/audio-install/backups/none'),'hadOriginal':False}]})
            with self.assertRaisesRegex(RuntimeError,'TARGET_INVALID'):installer.recover(root)
            self.assertTrue((important/'keep').exists())


if __name__=='__main__':unittest.main()
