"""Supplier contact catalogs from dedicated APIs, without database access."""
import re

from wechat_contacts import RELATIONSHIP_ERROR, SYSTEM_CONTACTS, integer


_USER = re.compile(r'[A-Za-z0-9_.@-]{1,128}')


def text(value):
    if isinstance(value, dict):
        value = value.get('String')
    return value.strip() if isinstance(value, str) else ''


def _response_ok(value, error):
    for key in ('code', 'errCode'):
        if key in value and integer(value[key]) != 1:
            raise RuntimeError(error)
    if 'baseResponse' in value:
        base = value['baseResponse']
        if not isinstance(base, dict) or integer(base.get('ret')) != 0:
            raise RuntimeError(error)


def _rows(result, keys, error, *, group_map=False):
    """Unwrap only recognized list envelopes, not arbitrary success objects."""
    value = result
    for _ in range(4):
        if isinstance(value, list):
            if len(value) > 50000:
                raise RuntimeError(error)
            return value
        if not isinstance(value, dict):
            raise RuntimeError(error)
        _response_ok(value, error)
        present = [key for key in keys if key in value]
        if len(present) > 1:
            raise RuntimeError(error)
        if present:
            value = value[present[0]]
            continue
        if group_map and value and all(isinstance(key, str) and key.endswith('@chatroom') for key in value):
            rows = []
            for username, item in value.items():
                if isinstance(item, str):
                    rows.append({'userName': username, 'nickName': item})
                elif isinstance(item, dict):
                    rows.append({'username': username, 'contact': item.get('contact', item)})
                else:
                    raise RuntimeError(error)
            return rows
        raise RuntimeError(error)
    raise RuntimeError(error)


def _contact(row, error):
    if not isinstance(row, dict):
        raise RuntimeError(error)
    if 'ret' in row and integer(row['ret']) != 0:
        return None
    contact = row.get('contact', row)
    if not isinstance(contact, dict):
        raise RuntimeError(error)
    outer = text(row.get('username'))
    inner = next((text(contact.get(key)) for key in ('userName', 'username', 'wxid', 'room_id', 'chatroomUserName') if text(contact.get(key))), '')
    if outer and inner and outer != inner:
        raise RuntimeError(error)
    username = inner or outer
    if not _USER.fullmatch(username):
        raise RuntimeError(error)
    terms = [text(contact.get(key)) for key in ('remark', 'nickName', 'nick_name', 'alias', 'pyinitial', 'quanPin', 'remarkPyinitial', 'remarkQuanPin')]
    name = next((term for term in terms[:4] if term), username)
    return username, name, terms, contact


def load_contacts(api, own_wxid):
    """Return names, confirmed private friends, and friendship metadata error."""
    error = 'HOOK_CONTACTS_RESPONSE_INVALID'
    rows = _rows(api.post('/api/get_frien_lists'), ('data', 'list', 'friends', 'friendList', 'contacts', 'contact_list'), error)
    names, friends, incomplete = {}, {}, False
    for row in rows:
        parsed = _contact(row, error)
        if parsed is None:
            continue
        username, name, terms, contact = parsed
        names[username] = name
        if username == own_wxid or '@' in username or username.startswith('gh_') or username in SYSTEM_CONTACTS:
            continue
        flag = integer(contact.get('bitVal', contact.get('flag')))
        verified = integer(contact.get('verifyFlag', contact.get('verify_flag')))
        if flag is None or verified is None:
            incomplete = True
            continue
        local_type = integer(contact.get('local_type', 1))
        deleted = integer(contact.get('delete_flag', contact.get('deleted', 0)))
        if local_type != 1 or not flag & 1 or deleted != 0 or verified != 0:
            continue
        friends[username] = {'displayName': name, 'searchTerms': [term for term in terms if term]}
    return names, friends, RELATIONSHIP_ERROR if incomplete else ''


def load_groups(api):
    """Read the dedicated group catalog; unknown schemas stay explicit errors."""
    error = 'HOOK_GROUPS_RESPONSE_INVALID'
    rows = _rows(api.post('/api/get_chatroom_list'), ('data', 'list', 'groups', 'chatrooms', 'roomList', 'chatroomList'), error, group_map=True)
    names = {}
    for row in rows:
        if isinstance(row, str):
            if not _USER.fullmatch(row) or not row.endswith('@chatroom'):
                raise RuntimeError(error)
            names[row] = row
            continue
        parsed = _contact(row, error)
        if parsed is None:
            continue
        username, name, _, _ = parsed
        if not username.endswith('@chatroom'):
            raise RuntimeError(error)
        names[username] = name
    return names


def load_members(api, room_id):
    """Read documented room members through its dedicated API, never SQL."""
    error = 'HOOK_GROUP_MEMBERS_RESPONSE_INVALID'
    if not isinstance(room_id, str) or not _USER.fullmatch(room_id) or not room_id.endswith('@chatroom'):
        raise RuntimeError('HOOK_ROOM_ID_INVALID')
    result = api.post('/api/get_room_members', {'room_id': room_id})
    keys = ('data', 'list', 'members', 'memberList', 'newChatroomData', 'chatRoomMember')
    # The documented response identifies the room outside newChatroomData.
    # Do not accept a different room's cached member list.
    value = result
    for _ in range(4):
        if not isinstance(value, dict):
            break
        for key in ('chatroomUserName', 'chatRoomUserName', 'room_id'):
            returned_room = text(value.get(key))
            if returned_room and returned_room != room_id:
                raise RuntimeError(error)
        present = [key for key in keys if key in value]
        if len(present) != 1:
            break
        value = value[present[0]]
    rows = _rows(result, keys, error)
    members, seen = [], set()
    for row in rows:
        parsed = _contact(row, error)
        if parsed is None:
            continue
        username, _, _, contact = parsed
        if '@' in username:
            raise RuntimeError(error)
        if username in seen:
            continue
        seen.add(username)
        nickname = next((text(contact.get(key)) for key in ('nickName', 'nickname', 'nick_name') if text(contact.get(key))), '')
        card = next((text(contact.get(key)) for key in ('displayName', 'roomNickName', 'card') if text(contact.get(key))), '')
        members.append({'username': username, 'displayName': card or nickname or username,
                        'nickname': nickname, 'card': card})
    return members
