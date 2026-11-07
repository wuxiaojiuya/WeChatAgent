"""Validated mappings for dedicated supplier Hook message actions.

This module only builds requests. It never sends messages, reads a WeChat
database, accepts SQL, or treats a submission acknowledgement as delivery.
Quote provenance must be supplied by the gateway from its received-event cache.
"""
import pathlib
import re


MAX_TEXT_BYTES = 16_000
MAX_MP3_BYTES = 16 * 1024 * 1024
MAX_VOICE_DURATION_MS = 60_000
_USER = re.compile(r'[A-Za-z0-9_-]{1,128}')
_GROUP = re.compile(r'[A-Za-z0-9_-]{1,128}@chatroom')
_SERVER_ID = re.compile(r'[1-9][0-9]{0,19}')


def _user(value):
    if not isinstance(value, str) or not _USER.fullmatch(value):
        raise ValueError('HOOK_USER_INVALID')
    return value


def _target(value, *, group_only=False):
    if not isinstance(value, str) or not (_GROUP.fullmatch(value) or (not group_only and _USER.fullmatch(value))):
        raise ValueError('HOOK_TARGET_INVALID')
    return value


def _text(value, *, limit=MAX_TEXT_BYTES, empty=False, code='HOOK_TEXT_INVALID'):
    if not isinstance(value, str) or '\0' in value or (not empty and not value.strip()) or len(value.encode('utf-8')) > limit:
        raise ValueError(code)
    return value


def _members(values, known_members=None):
    if isinstance(values, str):
        values = values.split(',')
    if not isinstance(values, (list, tuple)) or not 1 <= len(values) <= 100:
        raise ValueError('HOOK_AT_MEMBERS_INVALID')
    if values == ['notify@all']:
        return 'notify@all'
    if any(not isinstance(value, str) or not _USER.fullmatch(value) for value in values):
        raise ValueError('HOOK_AT_MEMBERS_INVALID')
    if known_members is not None and any(value not in known_members for value in values):
        raise PermissionError('HOOK_GROUP_MEMBER_NOT_ALLOWED')
    return ','.join(dict.fromkeys(values))


def _mp3_file(value):
    if not isinstance(value, str) or not value or '\0' in value:
        raise ValueError('HOOK_MP3_PATH_INVALID')
    file = pathlib.Path(value)
    if not file.is_absolute() or file.suffix.lower() != '.mp3' or file.is_symlink():
        raise ValueError('HOOK_MP3_PATH_INVALID')
    try:
        if not file.is_file() or not 0 < file.stat().st_size <= MAX_MP3_BYTES:
            raise ValueError('HOOK_MP3_FILE_INVALID')
        with file.open('rb') as stream:
            # ID3 metadata is skipped according to its bounded synchsafe size;
            # an ID3 marker by itself is not accepted as MP3 audio.
            header = stream.read(10)
            offset = 0
            if header.startswith(b'ID3'):
                if len(header) != 10 or header[3] not in (2, 3, 4) or any(byte & 0x80 for byte in header[6:10]):
                    raise ValueError('HOOK_MP3_FORMAT_INVALID')
                tag_size = sum(byte << (7 * (3 - index)) for index, byte in enumerate(header[6:10]))
                offset = 10 + tag_size + (10 if header[3] == 4 and header[5] & 0x10 else 0)
                if offset > min(file.stat().st_size - 4, 1024 * 1024):
                    raise ValueError('HOOK_MP3_FORMAT_INVALID')
            stream.seek(offset)
            frame = stream.read(4)
            if len(frame) != 4:
                raise ValueError('HOOK_MP3_FORMAT_INVALID')
            bits = int.from_bytes(frame, 'big')
            version, layer = (bits >> 19) & 3, (bits >> 17) & 3
            bitrate, sample_rate = (bits >> 12) & 15, (bits >> 10) & 3
            # MPEG-1/2/2.5 Layer III only; reject reserved/free-format values.
            if bits >> 21 != 0x7ff or version == 1 or layer != 1 or bitrate in (0, 15) or sample_rate == 3:
                raise ValueError('HOOK_MP3_FORMAT_INVALID')
            bitrates = (32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320) if version == 3 else (8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160)
            rate = (44100, 48000, 32000)[sample_rate] // (1 if version == 3 else 2 if version == 2 else 4)
            frame_size = ((144 if version == 3 else 72) * bitrates[bitrate - 1] * 1000 // rate) + ((bits >> 9) & 1)
            if file.stat().st_size - offset < frame_size:
                raise ValueError('HOOK_MP3_FORMAT_INVALID')
    except OSError:
        raise ValueError('HOOK_MP3_FILE_INVALID') from None
    return str(file.resolve())


def map_supplier_action(route, body, *, quote=None, members=None):
    """Return the documented upstream route/body for a gateway action.

    ``body.wxidorgid`` is the already-authorized conversation. ``members`` may
    contain its trusted group member IDs. ``quote`` must come from a received
    event in that conversation, not from request-supplied original XML or IDs.
    Authorization of the conversation itself remains the gateway's job.
    """
    if not isinstance(body, dict):
        raise ValueError('HOOK_REQUEST_INVALID')
    target = _target(body.get('wxidorgid'))
    if route == '/SendAtText':
        _target(target, group_only=True)
        return '/api/send_at_text', {
            'roomId': target,
            'msg': _text(body.get('msg')),
            'wxids': _members(body.get('wxids'), members),
        }
    if route == '/SendPatMsg':
        member = _user(body.get('memberWxid', body.get('wxid')))
        if _GROUP.fullmatch(target):
            if members is not None and member not in members:
                raise PermissionError('HOOK_GROUP_MEMBER_NOT_ALLOWED')
        elif member != target:
            raise PermissionError('HOOK_TARGET_NOT_ALLOWED')
        return '/api/send_pat', {'roomId': target, 'wxid': member}
    if route == '/SendMp3VoiceMsg':
        duration = body.get('duration')
        if duration is not None and (type(duration) is not int or not 1 <= duration <= MAX_VOICE_DURATION_MS):
            raise ValueError('HOOK_VOICE_DURATION_INVALID')
        return '/api/send_mp3_voice', {'wxid': target, 'mp3Path': _mp3_file(body.get('path'))}
    if route == '/SendQuoteMsg':
        if not isinstance(quote, dict):
            raise ValueError('HOOK_QUOTE_SOURCE_REQUIRED')
        conversation = quote.get('conversationWxid')
        if conversation is not None and conversation != target:
            raise PermissionError('HOOK_QUOTE_CONVERSATION_MISMATCH')
        server_id, created = quote.get('newmsgid'), quote.get('createTime')
        if not isinstance(server_id, str) or not _SERVER_ID.fullmatch(server_id) or type(created) is not int or not 0 <= created <= 0x7fffffffffffffff:
            raise ValueError('HOOK_QUOTE_METADATA_INVALID')
        mapped = {
            'reply': _text(body.get('msg', body.get('reply'))),
            'referContent': _text(quote.get('referContent'), limit=128 * 1024, code='HOOK_QUOTE_CONTENT_INVALID'),
            'fromUsr': _user(quote.get('fromUsr')),
            'newmsgid': server_id,
            'createTime': created,
            'sendto': target,
        }
        if quote.get('msgSource') is not None:
            mapped['msgSource'] = _text(quote['msgSource'], limit=64 * 1024, empty=True, code='HOOK_QUOTE_SOURCE_INVALID')
        return '/api/send_quote', mapped
    raise ValueError('HOOK_ROUTE_UNSUPPORTED')
