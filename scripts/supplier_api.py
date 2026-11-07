"""Adapter for the user-supplied 4.1.8.27 HTTP Hook. No old DLL or DB key.

The upstream API has no authentication. Only loopback request URLs are accepted;
the application gateway authenticates its own callers and checks the actual
listening process, client version and loaded DLL. Login metadata is read once
during explicit connection setup, never compared against a selected account.
"""
import ctypes
from ctypes import wintypes as W
import hashlib
import json
import os
import pathlib
import re
import socket
import struct
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

VERSION = '4.1.8.27'
BACKEND = 'supplier-http'
VOICE_UPLOAD_TIMEOUT_SECONDS = 30
IMAGE_UPLOAD_TIMEOUT_SECONDS = 30
DEDICATED_ROUTES = frozenset({
    '/api/get_profile_new', '/api/get_frien_lists', '/api/get_chatroom_list', '/api/get_room_members',
    '/api/send_text_msg', '/api/send_at_text', '/api/send_quote', '/api/send_pat',
    '/api/send_file_msg', '/api/send_image_msg', '/api/send_emotion_msg', '/api/send_voice', '/api/send_mp3_voice',
    '/api/download_voice', '/api/download_img', '/api/download_video', '/api/download_file', '/api/cdn_download',
    '/api/sns_post', '/api/sns_send_img', '/api/sns_comment_reply', '/api/sns_get_first_page', '/api/sns_get_detail',
    '/api/mod_self_nick_name', '/api/upload_head_img', '/api/mod_self_nick_signature', '/api/mod_chatroom_topic',
})
# The supplied build ignores HttpServerHost and constructs http://0.0.0.0:PORT.
# Accept that behavior only for this reviewed binary, while still verifying
# the real owner, loaded module, client version and current account below.
SUPPLIER_WILDCARD_SHA256 = '0f66f21d86d8d273e6da0fb8d0fbeae59fa0a501e633504aed52f77b79c7a528'


def listener_address_allowed(address, dll_digest):
    return address == '127.0.0.1' or (address == '0.0.0.0' and dll_digest == SUPPLIER_WILDCARD_SHA256)


def runtime_directory(root):
    base = os.environ.get('LOCALAPPDATA', '')
    if not base:
        raise RuntimeError('HOOK_ASCII_RUNTIME_REQUIRED')
    project_id = hashlib.sha256(str(pathlib.Path(root).resolve()).lower().encode('utf-8')).hexdigest()[:16]
    directory = pathlib.Path(base) / 'WeChatAgent' / 'supplier-41827' / project_id
    if not str(directory).isascii():
        raise RuntimeError('HOOK_ASCII_RUNTIME_REQUIRED')
    return directory


def read_json(file):
    return json.loads(pathlib.Path(file).read_text(encoding='utf-8-sig'))


def origin(value):
    u = urlsplit(value)
    if u.scheme != 'http' or u.hostname != '127.0.0.1' or u.username or u.password or u.path not in ('', '/') or u.query or u.fragment or not u.port:
        raise RuntimeError('HOOK_LOOPBACK_REQUIRED')
    return 'http://127.0.0.1:' + str(u.port)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('HOOK_REDIRECT_DENIED')


def process_identity(port, executable, dll):
    """Bind API identity to the real IPv4 listener, rather than a declared version."""
    if not hasattr(ctypes, 'WinDLL') or struct.calcsize('P') != 8:
        raise RuntimeError('HOOK_WINDOWS_X64_REQUIRED')
    ip = ctypes.WinDLL('iphlpapi', use_last_error=True)
    size = W.DWORD(0)
    ip.GetExtendedTcpTable(None, ctypes.byref(size), False, 2, 5, 0)
    buffer = ctypes.create_string_buffer(size.value)
    if ip.GetExtendedTcpTable(buffer, ctypes.byref(size), False, 2, 5, 0):
        raise RuntimeError('HOOK_PROCESS_INSPECTION_FAILED')
    owners = set()
    for offset in range(4, 4 + struct.unpack_from('I', buffer)[0] * 24, 24):
        state, address, raw_port, _, _, pid = struct.unpack_from('6I', buffer, offset)
        if state == 2 and socket.ntohs(raw_port & 65535) == port:
            local_address = socket.inet_ntoa(struct.pack('I', address))
            digest = hashlib.sha256(dll.read_bytes()).hexdigest() if local_address != '127.0.0.1' and dll.is_file() else ''
            if not listener_address_allowed(local_address, digest):
                raise RuntimeError('HOOK_NON_LOOPBACK_LISTENER')
            owners.add(pid)
    if not owners:
        raise RuntimeError('HOOK_NOT_LISTENING')
    if len(owners) != 1:
        raise RuntimeError('HOOK_PROCESS_AMBIGUOUS')
    pid = owners.pop()
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes, kernel.OpenProcess.restype = [W.DWORD, W.BOOL, W.DWORD], W.HANDLE
    kernel.CloseHandle.argtypes = [W.HANDLE]
    kernel.QueryFullProcessImageNameW.argtypes = [W.HANDLE, W.DWORD, W.LPWSTR, ctypes.POINTER(W.DWORD)]
    handle = kernel.OpenProcess(0x410, False, pid)
    if not handle:
        raise RuntimeError('HOOK_PROCESS_ACCESS_DENIED')
    try:
        file, length = ctypes.create_unicode_buffer(32768), W.DWORD(32768)
        if not kernel.QueryFullProcessImageNameW(handle, 0, file, ctypes.byref(length)) or pathlib.Path(file.value).resolve() != executable.resolve():
            raise RuntimeError('HOOK_PROCESS_PATH_MISMATCH')
        psapi = ctypes.WinDLL('psapi', use_last_error=True)
        modules, needed = (W.HMODULE * 2048)(), W.DWORD()
        psapi.EnumProcessModulesEx.argtypes = [W.HANDLE, ctypes.c_void_p, W.DWORD, ctypes.POINTER(W.DWORD), W.DWORD]
        psapi.GetModuleFileNameExW.argtypes = [W.HANDLE, W.HMODULE, W.LPWSTR, W.DWORD]
        if not psapi.EnumProcessModulesEx(handle, modules, ctypes.sizeof(modules), ctypes.byref(needed), 3) or needed.value > ctypes.sizeof(modules):
            raise RuntimeError('HOOK_MODULE_INSPECTION_FAILED')
        loaded, core = False, None
        for module in modules[:needed.value // ctypes.sizeof(W.HMODULE)]:
            if not psapi.GetModuleFileNameExW(handle, module, file, len(file)):
                continue
            module_file = pathlib.Path(file.value).resolve()
            if module_file == dll.resolve():
                loaded = True
            if module_file.name.lower() == 'weixin.dll':
                core = module_file
            if module_file.parent == executable.resolve().parent and module_file.name.lower() in ('version.dll', 'wechatvoice.dll'):
                raise RuntimeError('HOOK_LEGACY_COMPONENT_LOADED')
        if not loaded:
            raise RuntimeError('HOOK_SUPPLIED_DLL_NOT_LOADED')
        if core is None:
            raise RuntimeError('HOOK_INITIALIZATION_PENDING')
        if not core.is_relative_to(executable.resolve().parent):
            raise RuntimeError('HOOK_PROCESS_PATH_MISMATCH')
    finally:
        kernel.CloseHandle(handle)
    for target in (executable, core):
        if file_version(target) != VERSION:
            raise RuntimeError('HOOK_VERSION_MISMATCH')
    return pid


def file_version(executable):
    version = ctypes.WinDLL('version', use_last_error=True)
    version.GetFileVersionInfoSizeW.argtypes = [W.LPCWSTR, ctypes.c_void_p]
    version.GetFileVersionInfoW.argtypes = [W.LPCWSTR, W.DWORD, W.DWORD, ctypes.c_void_p]
    version.VerQueryValueW.argtypes = [ctypes.c_void_p, W.LPCWSTR, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(W.UINT)]
    n = version.GetFileVersionInfoSizeW(str(executable), None)
    if not n:
        raise RuntimeError('HOOK_VERSION_UNAVAILABLE')
    data, pointer, length = ctypes.create_string_buffer(n), ctypes.c_void_p(), W.UINT()
    if not version.GetFileVersionInfoW(str(executable), 0, n, data) or not version.VerQueryValueW(data, '\\', ctypes.byref(pointer), ctypes.byref(length)) or length.value < 16:
        raise RuntimeError('HOOK_VERSION_UNAVAILABLE')
    fields = ctypes.cast(pointer, ctypes.POINTER(W.DWORD))
    actual = '.'.join(map(str, (fields[2] >> 16, fields[2] & 65535, fields[3] >> 16, fields[3] & 65535)))
    return actual


class SupplierApi:
    def __init__(self, root, transport=None, inspect_process=process_identity):
        self.root = pathlib.Path(root)
        self.config = read_json(self.root / 'config/wechatagent.json')
        self.hook = self.config['hook']
        if self.hook.get('backend') != BACKEND or self.hook['expectedVersion'] != VERSION:
            raise RuntimeError('HOOK_PROVIDER_CONFIG_INVALID')
        self.url = origin(self.hook['upstreamUrl'])
        self.transport, self.inspect_process = transport, inspect_process
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def post(self, route, body=None, *, timeout=5):
        if route not in DEDICATED_ROUTES:
            raise ValueError('HOOK_ROUTE_INVALID')
        if self.transport:
            return self.transport(route, body or {})
        request = urllib.request.Request(self.url + route, json.dumps(body or {}, ensure_ascii=False).encode(), {'Content-Type': 'application/json'}, method='POST')
        try:
            with self.opener.open(request, timeout=timeout) as response:
                raw = response.read(16 * 1024 * 1024 + 1)
                if len(raw) > 16 * 1024 * 1024:
                    raise RuntimeError('HOOK_RESPONSE_TOO_LARGE')
                return json.loads(raw)
        except RuntimeError:
            raise
        except TimeoutError:
            raise RuntimeError('HOOK_UPSTREAM_TIMEOUT') from None
        except urllib.error.URLError as error:
            code = 'HOOK_UPSTREAM_TIMEOUT' if isinstance(error.reason, TimeoutError) else 'HOOK_UPSTREAM_UNAVAILABLE'
            raise RuntimeError(code) from None
        except Exception:
            raise RuntimeError('HOOK_UPSTREAM_UNAVAILABLE') from None

    def component_identity(self):
        """Inspect the running component without querying the login account."""
        directory = self.root / 'state/hook/supplier-4.1.8.27'
        manifest = read_json(directory / 'manifest.json')
        runtime = runtime_directory(self.root)
        if pathlib.Path(manifest.get('runtimeDirectory', '')).resolve() != runtime.resolve():
            raise RuntimeError('HOOK_RUNTIME_PATH_MISMATCH')
        dll = runtime / 'libGLESv1.dll'
        staged = directory / 'libGLESv1.dll'
        if manifest.get('version') != VERSION or any(hashlib.sha256(file.read_bytes()).hexdigest() != manifest.get('dllSha256') for file in (dll, staged)):
            raise RuntimeError('HOOK_SUPPLIED_DLL_HASH_MISMATCH')
        pid = self.inspect_process(urlsplit(self.url).port, (self.root / self.hook['wechatExecutable']).resolve(), dll)
        return {'pid': pid, 'version': VERSION}

    def identity(self):
        """Read single-account metadata once during connection setup."""
        component = self.component_identity()
        # This route is present in the supplied binary; get_profile_cache isn't.
        profile = self.post('/api/get_profile_new')
        wxid = profile.get('userInfo', {}).get('userName', {}).get('String', '') if isinstance(profile, dict) else ''
        if profile.get('baseResponse', {}).get('ret') != 0 or not isinstance(wxid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', wxid):
            raise RuntimeError('HOOK_LOGIN_REQUIRED')
        return {'wxid': wxid, **component}
