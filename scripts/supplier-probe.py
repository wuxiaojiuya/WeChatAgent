"""Read-only component/contact probe; no database handle or SQL calls."""
import json
import pathlib
import re
import sys

try:
    root = pathlib.Path(__file__).resolve().parent.parent
    # The embedded Python _pth configuration omits the entry script directory.
    sys.path.insert(0, str(root / 'scripts'))
    from supplier_api import SupplierApi
    from supplier_contacts import load_contacts, load_groups
    if sys.argv[1:] == ['--check-runtime']:
        print(json.dumps({'ok': True, 'probeReady': True}))
        sys.exit(0)
    if sys.argv[1:]:
        raise RuntimeError('HOOK_PROBE_ARGUMENT_INVALID')
    api = SupplierApi(root)
    identity = api.identity()
    _, friends, contact_error = load_contacts(api, identity['wxid'])
    if contact_error:
        raise RuntimeError('HOOK_CONTACTS_RELATIONSHIP_UNAVAILABLE')
    groups = load_groups(api)
    print(json.dumps({'ok': True, **identity, 'messageSource': 'supplier-callback',
                     'contactCount': len(friends), 'groupCount': len(groups)}))
except Exception as error:
    code = 'HOOK_PROBE_DEPENDENCY_MISSING' if isinstance(error, ModuleNotFoundError) else str(error) if re.fullmatch(r'HOOK_[A-Z0-9_]{2,79}', str(error)) else 'HOOK_PROBE_FAILED'
    result = {'ok': False, 'code': code, 'exceptionType': type(error).__name__}
    module = getattr(error, 'name', '') or ''
    if isinstance(error, ModuleNotFoundError) and re.fullmatch(r'[A-Za-z0-9_.]{1,80}', module):
        result['module'] = module
    print(json.dumps(result))
    sys.exit(1)
