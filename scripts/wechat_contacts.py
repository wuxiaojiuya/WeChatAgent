"""Contact names and friendship metadata are different catalogs in WeChat 4.x."""
import re


RELATIONSHIP_ERROR = 'CONTACT_FRIENDSHIP_METADATA_UNAVAILABLE'
SYSTEM_CONTACTS = frozenset(('filehelper', 'fmessage', 'medianote', 'floatbottle',
    'newsapp', 'notification_messages', 'weixin', 'weixinreminder', 'qqmail',
    'tmessage', 'qmessage', 'qqsync', 'lbsapp', 'shakeapp', 'feedsapp',
    'brandsessionholder', 'officialaccounts', 'voipapp', 'voicevoipapp'))


def integer(value):
    # Hook responses can encode numeric relationship flags as decimal strings.
    if type(value) is int:
        return value
    if isinstance(value, str) and re.fullmatch(r'-?\d{1,20}', value):
        return int(value)
    return None
