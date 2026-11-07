"""Contact names and friendship metadata are different catalogs in WeChat 4.x."""
import re


RELATIONSHIP_ERROR = 'CONTACT_FRIENDSHIP_METADATA_UNAVAILABLE'
SYSTEM_CONTACTS = frozenset(('filehelper', 'fmessage', 'medianote', 'floatbottle',
    'newsapp', 'notification_messages', 'weixin', 'weixinreminder', 'qqmail',
    'tmessage', 'qmessage', 'qqsync', 'lbsapp', 'shakeapp', 'feedsapp',
    'brandsessionholder', 'officialaccounts', 'voipapp', 'voicevoipapp'))


def integer(value):
    # The supplied SQL API returns some INTEGER columns as decimal strings.
    if type(value) is int:
        return value
    if isinstance(value, str) and re.fullmatch(r'-?\d{1,20}', value):
        return int(value)
    return None


def read_contact_catalog(connection, own_wxid):
    columns = {row[1] for row in connection.execute('PRAGMA table_info(contact)')}
    relationship = {'local_type', 'flag', 'delete_flag', 'verify_flag'} <= columns
    fields = ['username', 'remark', 'nick_name', 'alias']
    if relationship:
        fields += ['local_type', 'flag', 'delete_flag', 'verify_flag']
    names, friends = {}, {}
    for row in connection.execute('SELECT '+','.join(fields)+' FROM contact'):
        username = row[0]
        if not isinstance(username, str) or not username:
            continue
        terms = [value.strip() if isinstance(value, str) else '' for value in row[1:4]]
        name = next((term for term in terms if term), username)
        # Keep group members/strangers here for incoming sender-name resolution.
        names[username] = name
        if not relationship:
            continue
        local_type, flag, deleted, verified = map(integer, row[4:8])
        if (local_type != 1 or flag is None or not flag & 1 or deleted != 0 or verified != 0
                or username == own_wxid or '@' in username or username.startswith('gh_')
                or username in SYSTEM_CONTACTS):
            continue
        friends[username] = {'displayName': name, 'searchTerms': terms}
    return names, friends, '' if relationship else RELATIONSHIP_ERROR
