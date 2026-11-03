"""Adapter for the user-supplied 4.1.8.27 HTTP Hook. No old DLL or DB key.

The upstream API has no authentication. Only loopback request URLs are accepted;
the application gateway authenticates its own callers and verifies the actual
listening process, client version, loaded DLL and current account before use.
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
import urllib.request
from urllib.parse import urlsplit

VERSION = '4.1.8.27'
BACKEND = 'supplier-http'
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

    def post(self, route, body=None):
        if not re.fullmatch(r'/api/[a-z0-9_]+', route):
            raise ValueError('HOOK_ROUTE_INVALID')
        if self.transport:
            return self.transport(route, body or {})
        request = urllib.request.Request(self.url + route, json.dumps(body or {}, ensure_ascii=False).encode(), {'Content-Type': 'application/json'}, method='POST')
        try:
            with self.opener.open(request, timeout=5) as response:
                raw = response.read(16 * 1024 * 1024 + 1)
                if len(raw) > 16 * 1024 * 1024:
                    raise RuntimeError('HOOK_RESPONSE_TOO_LARGE')
                return json.loads(raw)
        except RuntimeError:
            raise
        except Exception:
            raise RuntimeError('HOOK_UPSTREAM_UNAVAILABLE') from None

    def identity(self, expected=None):
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
        # This route is present in the supplied binary; get_profile_cache isn't.
        profile = self.post('/api/get_profile_new')
        wxid = profile.get('userInfo', {}).get('userName', {}).get('String', '') if isinstance(profile, dict) else ''
        if profile.get('baseResponse', {}).get('ret') != 0 or not isinstance(wxid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', wxid):
            raise RuntimeError('HOOK_LOGIN_REQUIRED')
        if expected and wxid.lower() != expected.lower():
            raise RuntimeError('HOOK_ACCOUNT_MISMATCH')
        return {'wxid': wxid, 'pid': pid, 'version': VERSION}

    def databases(self):
        result = self.post('/api/get_db_handle')
        values = result.get('data') if isinstance(result, dict) else None
        if not isinstance(values, list):
            raise RuntimeError('HOOK_DATABASE_LIST_INVALID')
        names = [row.get('name') for row in values if isinstance(row, dict)]
        if any(not isinstance(n, str) or not re.fullmatch(r'[A-Za-z0-9_]+\.db', n) for n in names) or len(names) != len(set(names)):
            raise RuntimeError('HOOK_DATABASE_LIST_INVALID')
        return names

    def query(self, db, sql):
        if not re.fullmatch(r'[A-Za-z0-9_]+\.db', db):
            raise ValueError('HOOK_DATABASE_INVALID')
        # All SQL comes from fixed application queries, never model/user input.
        stripped = re.sub(r"'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"", '', sql)
        if not re.match(r'^\s*(SELECT\b|PRAGMA\s+table_info\()', sql, re.I) or re.search(r';|--|/\*|\b(load_extension|writefile|readfile|attach|insert|update|delete)\b', stripped, re.I):
            raise ValueError('HOOK_SQL_READ_ONLY_REQUIRED')
        result = self.post('/api/sqlite3_exec', {'db_name': db, 'sql_fmt': sql})
        # The delivered build wraps rows, whereas the published example was an array.
        if isinstance(result, dict) and result.get('code') == 1:
            result = result.get('data')
        elif isinstance(result, dict) and result.get('code') == 0 and result.get('msg') == 'no data' and result.get('total') == 0:
            result = []
        if not isinstance(result, list) or any(not isinstance(row, dict) for row in result):
            raise RuntimeError('HOOK_SQL_RESPONSE_INVALID')
        return result


def bind_sql(sql, params):
    parts, at, quote = [], 0, None
    index = 0
    while index < len(sql):
        ch = sql[index]
        if quote:
            parts.append(ch)
            if ch == quote:
                if index + 1 < len(sql) and sql[index + 1] == quote:
                    parts.append(ch)
                    index += 1
                else:
                    quote = None
        elif ch in "'\"":
            quote = ch
            parts.append(ch)
        elif ch == '?':
            if at >= len(params):
                raise ValueError('HOOK_SQL_PARAMETERS_INVALID')
            value, at = params[at], at + 1
            if value is None:
                parts.append('NULL')
            elif isinstance(value, int):
                parts.append(str(value))
            elif isinstance(value, str) and '\0' not in value:
                parts.append("'" + value.replace("'", "''") + "'")
            else:
                raise ValueError('HOOK_SQL_PARAMETERS_INVALID')
        else:
            parts.append(ch)
        index += 1
    if at != len(params) or quote:
        raise ValueError('HOOK_SQL_PARAMETERS_INVALID')
    return ''.join(parts)


def split_projection(text):
    result, start, depth, quote = [], 0, 0, None
    for i, ch in enumerate(text):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "'\"":
            quote = ch
        elif ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        elif ch == ',' and depth == 0:
            result.append(text[start:i].strip())
            start = i + 1
    return result + [text[start:].strip()]


class RemoteCursor:
    """Small read-only DB-API surface used by the existing message parser.

    Explicit aliases preserve column order even if the upstream JSON object is
    sorted alphabetically. Hex transports BLOBs omitted by the supplier API.
    """
    def __init__(self, api, name):
        self.api, self.name, self.rows = api, name, []

    def execute(self, sql, params=()):
        if sql in ('PRAGMA query_only=ON', 'PRAGMA busy_timeout=2000'):
            self.rows = []
            return self
        sql = bind_sql(sql, params)
        # This supplied build miscounts sqlite_master by name alone for Msg_*
        # tables. Constrain the fixed parser existence query to actual tables.
        sql = re.sub(r"\bFROM sqlite_master WHERE name=", "FROM sqlite_master WHERE type='table' AND name=", sql, flags=re.I)
        pragma = re.fullmatch(r'PRAGMA table_info\(["\']?([A-Za-z0-9_]+)["\']?\)', sql, re.I)
        if pragma:
            rows = self.api.query(self.name, sql)
            self.rows = [(int(r['cid']), r['name'], r.get('type', ''), int(r.get('notnull', 0)), r.get('dflt_value'), int(r.get('pk', 0))) for r in rows]
            return self
        match = re.match(r'^SELECT (.+?) FROM (.+)$', sql, re.I | re.S)
        if not match:
            raise ValueError('HOOK_SQL_SHAPE_UNSUPPORTED')
        fields = split_projection(match[1])
        numeric = {'local_id', 'server_id', 'local_type', 'real_sender_id', 'create_time', 'rowid'}
        blobs = {'message_content', 'voice_data', 'packed_info'}
        expressions, kinds = [], []
        for i, field in enumerate(fields):
            name = field.strip('"').split('.')[-1].strip('"')
            kind = 'blob' if name in blobs else 'int' if name in numeric or re.fullmatch(r'COUNT\(\*\)', field, re.I) else 'text'
            expressions.append(('hex(CAST(' + field + ' AS BLOB))' if kind == 'blob' else field) + ' AS "__c' + str(i) + '"')
            kinds.append(kind)
        rows = self.api.query(self.name, 'SELECT ' + ','.join(expressions) + ' FROM ' + match[2])
        self.rows = []
        for row in rows:
            values = []
            for i, kind in enumerate(kinds):
                key = '__c' + str(i)
                if key not in row:
                    raise RuntimeError('HOOK_SQL_COLUMN_MISSING')
                value = row[key]
                values.append(bytes.fromhex(value or '') if kind == 'blob' else int(value or 0) if kind == 'int' else value)
            self.rows.append(tuple(values))
        return self

    def fetchall(self):
        rows, self.rows = self.rows, []
        return rows

    def fetchone(self):
        return self.rows.pop(0) if self.rows else None

    def __iter__(self):
        return iter(self.fetchall())

    def close(self):
        self.rows = []


class RemoteConnection:
    def __init__(self, api, name):
        self.api, self.name = api, name

    def cursor(self):
        return RemoteCursor(self.api, self.name)

    def execute(self, sql, params=()):
        return self.cursor().execute(sql, params)

    def close(self):
        pass
