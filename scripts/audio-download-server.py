"""Read-only package origin with resumable downloads; run behind a reverse proxy."""
import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import urllib.parse


class Packages(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def serve(self, head=False):
        name=urllib.parse.urlsplit(self.path).path.lstrip('/')
        if not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,180}\.(?:zip|json)',name):
            self.send_error(404);return
        file=Path(self.directory)/name
        if not file.is_file() or file.is_symlink():
            self.send_error(404);return
        size=file.stat().st_size;start=0;end=size-1
        selected=self.headers.get('Range')
        if selected:
            match=re.fullmatch(r'bytes=(\d+)-(\d*)',selected)
            if not match:
                self.send_error(416);return
            start=int(match[1]);end=int(match[2]) if match[2] else end
            if not 0<=start<=end<size:
                self.send_response(416);self.send_header('Content-Range',f'bytes */{size}');self.end_headers();return
        self.send_response(206 if selected else 200)
        self.send_header('Content-Type','application/zip' if name.endswith('.zip') else 'application/json')
        self.send_header('Content-Length',str(end-start+1))
        self.send_header('Accept-Ranges','bytes')
        self.send_header('X-Content-Type-Options','nosniff')
        if selected:self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
        self.end_headers()
        if head:return
        try:
            with file.open('rb') as stream:
                stream.seek(start);remaining=end-start+1
                while remaining:
                    chunk=stream.read(min(1024*1024,remaining))
                    if not chunk:break
                    self.wfile.write(chunk);remaining-=len(chunk)
        except (BrokenPipeError,ConnectionResetError):pass

    def do_GET(self):self.serve()
    def do_HEAD(self):self.serve(head=True)


if __name__=='__main__':
    from functools import partial
    p=argparse.ArgumentParser();p.add_argument('--directory',required=True);p.add_argument('--bind',default='127.0.0.1');p.add_argument('--port',type=int,default=18085);a=p.parse_args()
    ThreadingHTTPServer((a.bind,a.port),partial(Packages,directory=a.directory)).serve_forever()
