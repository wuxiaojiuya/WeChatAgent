"""Read-only identity/schema probe used by the explicit account binding action."""
import json
import pathlib
import re
import sys

try:
    root = pathlib.Path(__file__).resolve().parent.parent
    # The embedded Python _pth configuration omits the entry script directory.
    sys.path.insert(0, str(root / 'scripts'))
    from supplier_api import SupplierApi, RemoteConnection
    if sys.argv[1:] == ['--check-runtime']:
        print(json.dumps({'ok': True, 'probeReady': True}))
        sys.exit(0)
    if sys.argv[1:]:
        raise RuntimeError('HOOK_PROBE_ARGUMENT_INVALID')
    api = SupplierApi(root)
    identity = api.identity()
    names = api.databases()
    if 'contact.db' not in names or not any(re.fullmatch(r'message_\d+\.db', n) for n in names):
        raise RuntimeError('HOOK_MESSAGE_DATABASES_UNAVAILABLE')
    contacts = RemoteConnection(api, 'contact.db').execute('SELECT COUNT(*) FROM contact').fetchone()
    if not contacts or contacts[0] < 1:
        raise RuntimeError('HOOK_CONTACTS_UNAVAILABLE')
    # Query the real shard schema now; a listening port alone isn't readiness.
    for name in names:
        if re.fullmatch(r'message_\d+\.db', name):
            schema = RemoteConnection(api, name).execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").fetchone()
            if not schema or schema[0] < 1:
                raise RuntimeError('HOOK_MESSAGE_DATABASE_UNREADABLE')
    api.identity(identity['wxid'])
    print(json.dumps({'ok': True, **identity}))
except Exception as error:
    code = 'HOOK_PROBE_DEPENDENCY_MISSING' if isinstance(error, ModuleNotFoundError) else str(error) if re.fullmatch(r'HOOK_[A-Z0-9_]{2,79}', str(error)) else 'HOOK_PROBE_FAILED'
    result = {'ok': False, 'code': code, 'exceptionType': type(error).__name__}
    module = getattr(error, 'name', '') or ''
    if isinstance(error, ModuleNotFoundError) and re.fullmatch(r'[A-Za-z0-9_.]{1,80}', module):
        result['module'] = module
    print(json.dumps(result))
    sys.exit(1)
