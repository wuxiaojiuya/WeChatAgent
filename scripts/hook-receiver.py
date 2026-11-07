"""Run the single supported WeChat 4.1.8.27 Hook receiver."""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT/'scripts'))

def main():
    from hook_receiver_core import HookReceiver, read_json, serve
    if sys.argv[1:] == ['--check-runtime']:
        print(json.dumps({'ok': True, 'receiverReady': True, 'backend': 'supplier-http', 'wechatVersion': '4.1.8.27'}))
        return
    if sys.argv[1:] not in ([], ['--check']):
        raise RuntimeError('HOOK_RECEIVER_ARGUMENT_INVALID')
    reader = HookReceiver(ROOT)
    if sys.argv[1:] == ['--check']:
        print(json.dumps({'messageSource': 'supplier-callback', 'historySource': 'project-cache',
                          'wechatDatabaseAccess': False, 'contactNamesLoaded': bool(reader.names),
                          'selectedConversations': len(reader.selected_talkers())}))
        return
    config = read_json(ROOT/'config/wechatagent.json')
    token = read_json(ROOT/'state/wechat-io-config.json')['receiver_token']
    serve(reader, config['ports']['receiver'], token)

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r'[A-Z][A-Z0-9_]{2,79}', str(error)) else type(error).__name__
        print('Hook receiver initialization failed: '+code, file=sys.stderr)
        sys.exit(1)
