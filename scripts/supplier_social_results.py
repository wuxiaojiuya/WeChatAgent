"""Bounded public results for supplier Moments/profile APIs.

The first-page/detail documentation leaves response schemas unspecified. Only
the explicitly documented Moments callback object is recognized here; unknown
envelopes fail visibly rather than exporting raw private/CDN metadata or making
up usable IDs. Comment records are likewise not documented and are not guessed.
"""
import base64
import binascii
import json
import re
import xml.etree.ElementTree as ET


MAX_UINT64 = (1 << 64) - 1
MAX_XML_BYTES = 2 * 1024 * 1024
MAX_MOMENTS = 100
MAX_MOMENTS_PAGE_BYTES = 128 * 1024
MAX_MOMENT_PREVIEW_BYTES = 1024
_USER = re.compile(r'[A-Za-z0-9_-]{1,128}')
_MUTATIONS = {
    '/PostMoment', '/PostImageMoment', '/ReplyMoment', '/SetSelfNickname',
    '/SetSelfAvatar', '/SetSelfSignature', '/SetGroupName',
}


def _unknown():
    raise RuntimeError('HOOK_MOMENTS_RESPONSE_UNKNOWN')


def _identifier(value):
    if type(value) is int:
        value = str(value)
    if not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]{0,19}', value) or int(value) > MAX_UINT64:
        _unknown()
    return value


def _string(value, *, maximum=16000):
    if not isinstance(value, str) or '\0' in value or len(value.encode('utf-8')) > maximum:
        _unknown()
    return value


def _number(value, maximum=0xffffffff):
    if type(value) is not int or not 0 <= value <= maximum:
        _unknown()
    return value


def _status(value, *, error='HOOK_SOCIAL_RESPONSE_UNKNOWN'):
    """Return recognized API acceptance evidence, without final-state claims."""
    statuses = []
    for name, success in (('code', 1), ('errCode', 1), ('ret', 0)):
        if name in value:
            if type(value[name]) is not int:
                raise RuntimeError(error)
            statuses.append(value[name] == success)
    if 'baseResponse' in value:
        base = value['baseResponse']
        if not isinstance(base, dict) or type(base.get('ret')) is not int:
            raise RuntimeError(error)
        statuses.append(base['ret'] == 0)
    if 'oplogRet' in value:
        operations = value['oplogRet']
        if not isinstance(operations, dict):
            raise RuntimeError(error)
        count, returns = operations.get('count'), operations.get('ret')
        if type(count) is not int or not 1 <= count <= 100 or not isinstance(returns, list) or len(returns) != count or any(type(item) is not int for item in returns):
            raise RuntimeError(error)
        statuses.append(all(item == 0 for item in returns))
    return all(statuses) if statuses else None


def normalize_social_mutation(route, result, expected=None):
    """Normalize API acceptance; never assert a post/profile change is final.

    ``expected`` is the mapped request body. It binds the nickname-only echo
    success example to the requested newName. Empty/undocumented responses raise
    HOOK_SOCIAL_RESPONSE_UNKNOWN; explicit native failures remain rejections.
    """
    if route not in _MUTATIONS:
        raise ValueError('HOOK_ROUTE_UNSUPPORTED')
    if not isinstance(result, dict):
        raise RuntimeError('HOOK_SOCIAL_RESPONSE_UNKNOWN')
    statuses, value = [], result
    for _ in range(4):
        status = _status(value)
        if status is not None:
            statuses.append(status)
        if 'data' not in value or value['data'] is None:
            break
        if not isinstance(value['data'], dict):
            raise RuntimeError('HOOK_SOCIAL_RESPONSE_UNKNOWN')
        value = value['data']
    else:
        raise RuntimeError('HOOK_SOCIAL_RESPONSE_UNKNOWN')
    if route == '/SetSelfNickname' and 'newName' in value:
        if not isinstance(expected, dict) or not isinstance(expected.get('newName'), str) or value['newName'] != expected['newName']:
            raise RuntimeError('HOOK_SOCIAL_RESPONSE_UNKNOWN')
        statuses.append(True)
    if not statuses:
        raise RuntimeError('HOOK_SOCIAL_RESPONSE_UNKNOWN')
    accepted = all(statuses)
    return {'ret': 0 if accepted else -1, 'submitted': accepted, 'apiAcknowledged': accepted, 'confirmed': False}


def _moment(value):
    if not isinstance(value, dict):
        _unknown()
    moment_id, author = _identifier(value.get('id')), value.get('username')
    if not isinstance(author, str) or not _USER.fullmatch(author):
        _unknown()
    nickname = _string(value.get('nickname', ''), maximum=4096)
    created = _number(value.get('createTime'), maximum=4102444800)
    count = _number(value.get('commentCount'))
    descriptor = value.get('objectDesc')
    if not isinstance(descriptor, dict):
        _unknown()
    length, encoded = descriptor.get('iLen'), descriptor.get('buffer')
    if type(length) is not int or not 0 < length <= MAX_XML_BYTES or not isinstance(encoded, str) or len(encoded) > ((MAX_XML_BYTES + 2) // 3) * 4:
        _unknown()
    try:
        raw = base64.b64decode(encoded, validate=True)
        if len(raw) != length:
            _unknown()
        xml = raw.decode('utf-8')
        if '\0' in xml or re.search(r'<!\s*(?:DOCTYPE|ENTITY)\b', xml, re.I):
            _unknown()
        root = ET.fromstring(xml)
    except (binascii.Error, UnicodeError, ET.ParseError):
        _unknown()
    if root.tag != 'TimelineObject' or sum(1 for _ in root.iter()) > 10000:
        _unknown()
    if root.findtext('id') != moment_id or root.findtext('username') != author or root.findtext('createTime') != str(created):
        _unknown()
    text = _string(root.findtext('contentDesc', ''))
    media = root.findall('ContentObject/mediaList/media')
    result = {'id': moment_id, 'author': author, 'nickname': nickname, 'text': text,
              'createTime': created, 'mediaCount': len(media), 'comments': [],
              'commentCount': count, 'commentsAvailable': count == 0}
    if count:
        result['commentsUnavailableReason'] = 'HOOK_MOMENT_COMMENTS_SCHEMA_UNDOCUMENTED'
    return result


def _moment_page(moments, *, truncated=False):
    """Bound the serialized gateway response, with full IDs and source fields.

    List entries are previews; callers can request a detail for the complete
    allowed text. Measure the same UTF-8 JSON representation as the gateway so
    multibyte characters, escaping and source metadata all count in the budget.
    """
    page = []
    for moment in moments:
        preview = dict(moment)
        text = preview['text'].encode('utf-8')
        if len(text) > MAX_MOMENT_PREVIEW_BYTES:
            preview['text'] = text[:MAX_MOMENT_PREVIEW_BYTES].decode('utf-8', errors='ignore')
            preview['textTruncated'] = True
            truncated = True
        candidate = {'moments': [*page, preview], 'truncated': True}
        if len(json.dumps(candidate, ensure_ascii=False).encode('utf-8')) > MAX_MOMENTS_PAGE_BYTES:
            truncated = True
            break
        page.append(preview)
    return {'moments': page, **({'truncated': True} if truncated else {})}


def normalize_moments_response(route, result, expected_id=None):
    """Return a strict public page/detail from recognized callback objects.

    A bare object, a list, or a generic ``data`` envelope may contain the
    documented callback shape. Unspecified ``objectList``/comment schemas are
    not inferred. Empty/unknown success objects never become empty timelines.
    """
    if route not in ('/GetMoments', '/GetMomentDetail'):
        raise ValueError('HOOK_ROUTE_UNSUPPORTED')
    value = result
    for _ in range(4):
        if isinstance(value, list):
            break
        if not isinstance(value, dict):
            _unknown()
        status = _status(value, error='HOOK_MOMENTS_RESPONSE_UNKNOWN')
        if status is False:
            raise RuntimeError('HOOK_MOMENTS_REQUEST_REJECTED')
        if 'objectDesc' in value:
            break
        if 'data' not in value:
            _unknown()
        value = value['data']
    else:
        _unknown()
    if isinstance(value, dict):
        values = [value]
    elif isinstance(value, list):
        values = value
    else:
        _unknown()
    if route == '/GetMomentDetail' and len(values) != 1:
        _unknown()
    moments = [_moment(item) for item in values[:MAX_MOMENTS]]
    if len({item['id'] for item in moments}) != len(moments):
        _unknown()
    if route == '/GetMomentDetail':
        if expected_id is not None and moments[0]['id'] != _identifier(expected_id):
            raise RuntimeError('HOOK_MOMENT_IDENTITY_MISMATCH')
        return {'moment': moments[0]}
    return _moment_page(moments, truncated=len(values) > MAX_MOMENTS)
