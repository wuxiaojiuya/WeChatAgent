"""Douyin shares; optional local cookies stay in the official domain jar."""
import ipaddress
import pathlib
import re
import socket
import time
import urllib.parse
import urllib.request
import urllib.error
import http.cookiejar
import http.cookies


def douyin_url(value):
    if not isinstance(value, str) or len(value) > 2048:
        raise RuntimeError('VIDEO_DOUYIN_URL_INVALID')
    url = urllib.parse.urlsplit(value)
    if url.scheme != 'https' or url.username or url.password or url.port not in (None, 443) or url.fragment:
        raise RuntimeError('VIDEO_DOUYIN_URL_INVALID')
    host = (url.hostname or '').lower()
    path = url.path
    if host == 'v.douyin.com' and re.fullmatch(r'/[A-Za-z0-9_-]{4,80}/?', path):
        return 'https://'+host+path
    if host in ('www.douyin.com', 'douyin.com'):
        match = re.fullmatch(r'/video/(\d{10,30})/?', path)
        modal = urllib.parse.parse_qs(url.query).get('modal_id', [''])[0]
        identity = match[1] if match else modal if path in ('', '/') and re.fullmatch(r'\d{10,30}', modal) else None
        if identity:
            return 'https://www.douyin.com/video/'+identity
    if host == 'www.iesdouyin.com' and re.fullmatch(r'/share/video/\d{10,30}/?', path):
        return 'https://www.douyin.com/video/'+path.strip('/').split('/')[-1]
    raise RuntimeError('VIDEO_DOUYIN_URL_INVALID')


def public_media_url(value):
    url = urllib.parse.urlsplit(value)
    domains = ('douyinvod.com', 'douyin.com', 'douyincdn.com', 'bytecdn.cn', 'bytecdn.com', 'zjcdn.com', 'ixigua.com', 'snssdk.com')
    host = (url.hostname or '').lower()
    if url.scheme != 'https' or url.username or url.password or url.port not in (None, 443) or not any(host == domain or host.endswith('.'+domain) for domain in domains):
        raise RuntimeError('VIDEO_DOUYIN_MEDIA_REJECTED')
    addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(entry[4][0]).is_global for entry in addresses):
        raise RuntimeError('VIDEO_DOUYIN_MEDIA_REJECTED')
    return value


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        public_media_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def resolve_share(value):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_):
            return None
    opener = urllib.request.build_opener(NoRedirect())
    for _ in range(4):
        value = douyin_url(value)
        if urllib.parse.urlsplit(value).hostname != 'v.douyin.com':
            return value
        try:
            with opener.open(urllib.request.Request(value,headers={'User-Agent':'Mozilla/5.0'}),timeout=12):
                raise RuntimeError('VIDEO_DOUYIN_UNAVAILABLE')
        except urllib.error.HTTPError as error:
            if error.code not in (301,302,303,307,308) or not error.headers.get('Location'):
                raise RuntimeError('VIDEO_DOUYIN_UNAVAILABLE') from error
            value = douyin_url(urllib.parse.urljoin(value,error.headers['Location']))
    raise RuntimeError('VIDEO_DOUYIN_UNAVAILABLE')


def download_douyin(value, target, max_bytes, cookie=''):
    value = douyin_url(value)
    try:
        import yt_dlp
    except ImportError as error:
        raise RuntimeError('VIDEO_DOUYIN_RUNTIME_MISSING') from error
    class Quiet:
        def debug(self, *_): pass
        def warning(self, *_): pass
        def error(self, *_): pass
    try:
        # Metadata comes only from the official Douyin extractor. Downloads
        # below separately validate every media host and redirect.
        value = resolve_share(value)
        with yt_dlp.YoutubeDL({'quiet': True, 'no_warnings': True, 'logger': Quiet(),
                'noplaylist': True, 'socket_timeout': 12, 'retries': 0,
                'extractor_retries': 0, 'allowed_extractors': ['Douyin', 'TikTokVM'],
                'format': 'best[ext=mp4][acodec!=none][height<=720]/best[ext=mp4][acodec!=none]'}) as ydl:
            if not isinstance(cookie,str) or len(cookie)>32768 or re.search(r'[\r\n\0]',cookie):
                raise RuntimeError('VIDEO_DOUYIN_COOKIE_INVALID')
            values=http.cookies.SimpleCookie()
            values.load(cookie)
            for key, morsel in values.items():
                ydl.cookiejar.set_cookie(http.cookiejar.Cookie(0,key,morsel.value,None,False,'.douyin.com',True,True,'/',True,True,None,True,None,None,{},False))
            info = ydl.extract_info(value, download=False)
        if not info or info.get('_type') in ('playlist', 'multi_video') or not info.get('url') or info.get('is_live'):
            raise RuntimeError('VIDEO_DOUYIN_UNAVAILABLE')
        if info.get('filesize', 0) and info['filesize'] > max_bytes:
            raise RuntimeError('VIDEO_DOUYIN_TOO_LARGE')
        media = public_media_url(info['url'])
        temporary = pathlib.Path(str(target)+'.download')
        try:
            opener = urllib.request.build_opener(SafeRedirect())
            request = urllib.request.Request(media, headers={'User-Agent':'Mozilla/5.0', 'Referer':'https://www.douyin.com/'})
            size = 0
            deadline = time.monotonic()+55
            with opener.open(request, timeout=15) as response, temporary.open('wb') as stream:
                if int(response.headers.get('Content-Length', '0')) > max_bytes:
                    raise RuntimeError('VIDEO_DOUYIN_TOO_LARGE')
                while True:
                    chunk = response.read(128*1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > max_bytes or time.monotonic() > deadline:
                        raise RuntimeError('VIDEO_DOUYIN_TOO_LARGE' if size > max_bytes else 'VIDEO_DOUYIN_TIMEOUT')
                    stream.write(chunk)
            if size < 32:
                raise RuntimeError('VIDEO_DOUYIN_UNAVAILABLE')
            temporary.replace(target)
        finally:
            if temporary.exists():
                temporary.unlink()
    except RuntimeError:
        raise
    except Exception as error:
        # Do not relay extractor output, signed media URLs or page cookies.
        if 'cookie' in str(error).lower() or 'login' in str(error).lower():
            raise RuntimeError('VIDEO_DOUYIN_LOGIN_REQUIRED') from error
        raise RuntimeError('VIDEO_DOUYIN_UNAVAILABLE') from error
