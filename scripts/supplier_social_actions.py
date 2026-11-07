"""Pure mappings for the documented supplier Moments/profile APIs.

This module never calls the Hook or reads a WeChat database. Callers authorize
the operation and stage validated local images to the ASCII Hook runtime before
submitting. An upstream HTTP response alone is not proof of publication.
"""
import io
import pathlib
import re


MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_TEXT_BYTES = 16_000
MAX_UINT64 = (1 << 64) - 1
_USER = re.compile(r'[A-Za-z0-9_-]{1,128}')
_GROUP = re.compile(r'[A-Za-z0-9_-]{1,128}@chatroom')


def _text(value, *, empty=False, maximum=MAX_TEXT_BYTES, code='HOOK_SOCIAL_TEXT_INVALID'):
    if not isinstance(value, str) or '\0' in value or (not empty and not value.strip()) or len(value.encode('utf-8')) > maximum:
        raise ValueError(code)
    return value


def _uint64(value, *, zero=False):
    # IDs must cross the JavaScript boundary as strings. Python then emits an
    # exact JSON integer only for the one endpoint whose contract requires it.
    if not isinstance(value, str) or not re.fullmatch(r'0|[1-9][0-9]{0,19}', value) or not (0 if zero else 1) <= int(value) <= MAX_UINT64:
        raise ValueError('HOOK_MOMENT_ID_INVALID')
    return value


def _users(value):
    if not isinstance(value, str) or len(value) > 33024:
        raise ValueError('HOOK_MOMENT_USERS_INVALID')
    if not value:
        return ''
    values = value.split(',')
    if len(values) > 256 or any(not _USER.fullmatch(item) for item in values):
        raise ValueError('HOOK_MOMENT_USERS_INVALID')
    return ','.join(dict.fromkeys(values))


def _image(value):
    if not isinstance(value, str) or not value or '\0' in value:
        raise ValueError('HOOK_SOCIAL_IMAGE_INVALID')
    file = pathlib.Path(value)
    if not file.is_absolute() or file.suffix.lower() not in ('.jpg', '.jpeg', '.png'):
        raise ValueError('HOOK_SOCIAL_IMAGE_INVALID')
    try:
        stat = file.lstat()
        if file.is_symlink() or not file.is_file() or getattr(stat, 'st_file_attributes', 0) & 0x400 or not 0 < stat.st_size <= MAX_IMAGE_BYTES:
            raise ValueError('HOOK_SOCIAL_IMAGE_INVALID')
        with file.open('rb') as stream:
            raw = stream.read(MAX_IMAGE_BYTES + 1)
        after = file.stat()
        if len(raw) != stat.st_size or (after.st_size, after.st_mtime_ns) != (stat.st_size, stat.st_mtime_ns):
            raise ValueError('HOOK_SOCIAL_IMAGE_CHANGED')
        from PIL import Image
        try:
            with Image.open(io.BytesIO(raw)) as image:
                if image.format not in ('JPEG', 'PNG') or not 0 < image.width <= 8192 or not 0 < image.height <= 8192 or image.width * image.height > 40_000_000:
                    raise ValueError('HOOK_SOCIAL_IMAGE_FORMAT_INVALID')
                image.verify()
            with Image.open(io.BytesIO(raw)) as image:
                image.load()
        except (OSError, SyntaxError, Image.DecompressionBombError):
            raise ValueError('HOOK_SOCIAL_IMAGE_FORMAT_INVALID') from None
    except OSError:
        raise ValueError('HOOK_SOCIAL_IMAGE_INVALID') from None
    return str(file.resolve())


def _image_moment_path(body):
    value = body.get('path', body.get('filelist', body.get('paths')))
    if isinstance(value, list):
        # The published contract demonstrates one local path. No multi-image
        # separator is specified, so do not guess one or silently drop images.
        if len(value) != 1:
            raise ValueError('HOOK_MOMENT_SINGLE_IMAGE_REQUIRED')
        value = value[0]
    return _image(value)


def map_social_action(route, body):
    """Return ``(upstream_api_route, exact_documented_body)`` without sending.

    Group rename uses the gateway-authorized ``wxidorgid``. Other profile and
    Moments actions operate on the Hook's one logged-in account. Read helpers
    expose the dedicated first-page/detail endpoints for reply context.
    """
    if not isinstance(body, dict):
        raise ValueError('HOOK_REQUEST_INVALID')
    if route == '/PostMoment':
        return '/api/sns_post', {
            'content': _text(body.get('content')),
            'blackList': _users(body.get('blackList', '')),
            'withauserList': _users(body.get('withauserList', '')),
        }
    if route == '/PostImageMoment':
        return '/api/sns_send_img', {
            'filelist': _image_moment_path(body),
            'content': _text(body.get('content', ''), empty=True),
        }
    if route == '/ReplyMoment':
        comment_id = body.get('comment_id', body.get('commentId'))
        if type(comment_id) is not int or not 0 <= comment_id <= 0xffffffff:
            raise ValueError('HOOK_MOMENT_COMMENT_ID_INVALID')
        return '/api/sns_comment_reply', {
            'content': _text(body.get('content')),
            'sns_id': _uint64(body.get('sns_id', body.get('momentId'))),
            'comment_id': comment_id,
        }
    if route == '/SetSelfNickname':
        return '/api/mod_self_nick_name', {
            'newName': _text(body.get('newName', body.get('nickname')), maximum=512, code='HOOK_SELF_NICKNAME_INVALID'),
        }
    if route == '/SetSelfAvatar':
        return '/api/upload_head_img', {'filepath': _image(body.get('path', body.get('filepath')))}
    if route == '/SetSelfSignature':
        return '/api/mod_self_nick_signature', {
            'newSignature': _text(body.get('newSignature', body.get('signature')), empty=True, maximum=4096, code='HOOK_SELF_SIGNATURE_INVALID'),
        }
    if route == '/SetGroupName':
        target = body.get('wxidorgid', body.get('wxid'))
        if not isinstance(target, str) or not _GROUP.fullmatch(target):
            raise ValueError('HOOK_ROOM_ID_INVALID')
        return '/api/mod_chatroom_topic', {
            'wxid': target,
            'topic': _text(body.get('topic', body.get('name')), maximum=1024, code='HOOK_GROUP_NAME_INVALID'),
        }
    if route == '/GetMoments':
        md5 = body.get('firstPageMd5', '')
        if not isinstance(md5, str) or md5 and not re.fullmatch(r'[a-fA-F0-9]{32}', md5):
            raise ValueError('HOOK_MOMENT_PAGE_MD5_INVALID')
        maximum = body.get('maxId', '')
        if maximum != '':
            maximum = _uint64(maximum, zero=True)
        return '/api/sns_get_first_page', {'firstPageMd5': md5, 'maxId': maximum}
    if route == '/GetMomentDetail':
        return '/api/sns_get_detail', {'sns_id': int(_uint64(body.get('sns_id', body.get('momentId'))))}
    raise ValueError('HOOK_ROUTE_UNSUPPORTED')
