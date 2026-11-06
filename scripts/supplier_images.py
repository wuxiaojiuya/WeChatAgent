"""Download exact-message photos through the configured local supplier Hook."""
import os
import pathlib
import re
import tempfile
import time

from supplier_api import runtime_directory
from wechat_image_normalize import decode_image_source, normalize_image

MAX_IMAGE_BYTES = 20 * 1024 * 1024


def image_fields(node):
    attrs = {key.lower(): value for key, value in node.attrib.items()} if node is not None else {}
    size = 0
    for key in ('cdnmidimgurl_size', 'length', 'hevc_mid_size'):
        value = attrs.get(key, '')
        if re.fullmatch(r'[0-9]{1,10}', value) and 0 < int(value) <= MAX_IMAGE_BYTES:
            size = int(value)
            break
    file_id = attrs.get('cdnmidimgurl') or attrs.get('fileid') or ''
    aes_key = attrs.get('aeskey') or attrs.get('asekey') or ''
    cdn = bool(file_id and len(file_id) <= 8192 and re.fullmatch(r'[a-fA-F0-9]{32}', aes_key))
    return size, file_id if cdn else '', aes_key if cdn else ''


def preview_file(file, timeout=5):
    stat = file.lstat()
    if file.is_symlink() or not file.is_file() or getattr(stat, 'st_file_attributes', 0) & 0x400:
        raise RuntimeError('IMAGE_DOWNLOAD_FILE_INVALID')
    if not 0 < stat.st_size <= MAX_IMAGE_BYTES:
        raise RuntimeError('IMAGE_TOO_LARGE_OR_EMPTY')
    raw = file.read_bytes()
    current = file.stat()
    if len(raw) != stat.st_size or (current.st_size,current.st_mtime_ns) != (stat.st_size,stat.st_mtime_ns):
        raise OSError('Image is still being written')
    if not raw.startswith((b'\xff\xd8\xff', b'\x89PNG\r\n\x1a\n', b'GIF87a', b'GIF89a', b'RIFF', b'BM', b'II*\0', b'MM\0*', b'wxgf', b'WXGF')):
        raise RuntimeError('IMAGE_FORMAT_UNSUPPORTED')
    return normalize_image(decode_image_source(raw,timeout=timeout), max_side=2048, max_source_bytes=MAX_IMAGE_BYTES)


def wait_preview(file, deadline):
    previous, stable = None, 0
    while time.monotonic() < deadline:
        try:
            stat = file.lstat()
            if file.is_symlink() or getattr(stat, 'st_file_attributes', 0) & 0x400:
                raise RuntimeError('IMAGE_DOWNLOAD_FILE_INVALID')
            if stat.st_size > MAX_IMAGE_BYTES:
                raise RuntimeError('IMAGE_TOO_LARGE_OR_EMPTY')
            fingerprint = (stat.st_size, stat.st_mtime_ns)
            stable = stable + 1 if stat.st_size and fingerprint == previous else 0
            previous = fingerprint
            if stable >= 2:
                try:
                    return preview_file(file,timeout=max(.05,deadline-time.monotonic()))
                except (OSError, ValueError):
                    pass  # An incomplete image can already have the right header.
        except (FileNotFoundError, PermissionError):
            pass
        time.sleep(min(.1, max(0, deadline-time.monotonic())))
    raise RuntimeError('IMAGE_DOWNLOAD_PENDING')


def download_image(reader, image_id, descriptor, node):
    if not re.fullmatch(r'[a-f0-9]{64}', image_id):
        raise RuntimeError('IMAGE_REFERENCE_NOT_ALLOWED')
    size, file_id, aes_key = image_fields(node)
    with reader.callback_lock:
        callback = dict(reader.callback_messages.get(str(descriptor['serverId']), {}))
    msg_id = callback.get('msgId')
    if isinstance(msg_id, str) and re.fullmatch(r'[0-9]{1,10}', msg_id):
        msg_id = int(msg_id)
    bound = (type(msg_id) is int and 0 < msg_id <= 0xffffffff
             and callback.get('type', 3) == 3 and callback.get('from') == descriptor['talker']
             and callback.get('to') == reader.own_wxid)
    if not file_id and not size:
        raise RuntimeError('IMAGE_DOWNLOAD_METADATA_MISSING')
    if not file_id and not bound:
        raise RuntimeError('IMAGE_CALLBACK_METADATA_REQUIRED')
    # This Hook's native paths must be ASCII. Keep downloads beside its runtime,
    # even if the installed workspace contains Chinese characters.
    directory = runtime_directory(reader.root)/'incoming-images'
    directory.mkdir(parents=True, exist_ok=True)
    file = directory/(image_id+'.image')
    if file.exists() or file.is_symlink():
        try:
            return preview_file(file)
        except (OSError, ValueError):
            pass
    attempts = []
    if file_id:
        for image_type in (2, 3):
            attempts.append(('/api/cdn_download', {'fileid':file_id,'asekey':aes_key,'imgType':image_type},'out'))
    if size and bound:
        attempts.append(('/api/download_img', {'to_user':reader.own_wxid,'from_user':descriptor['talker'],
            'start_pos':0,'total_len':size,'data_len':size,'compress_type':0,'MsgId':msg_id},'path'))
    deadline = time.monotonic()+9
    for route, body, field in attempts:
        remaining = deadline-time.monotonic()
        if remaining < .3:
            break
        handle, temporary = tempfile.mkstemp(dir=directory, suffix='.jpg.part')
        os.close(handle)
        temporary = pathlib.Path(temporary)
        try:
            reader.active_identity()
            try:
                reader.api.post(route, {**body,field:str(temporary)}, timeout=min(2.5,remaining))
            except RuntimeError:
                pass  # File validation, not an API acknowledgement, proves readiness.
            result = wait_preview(temporary, min(deadline,time.monotonic()+2))
            reader.active_identity()
            if not reader.image_talker_allowed(descriptor['talker']):
                raise PermissionError('IMAGE_REFERENCE_NOT_ALLOWED')
            os.replace(temporary,file)
            return result
        except RuntimeError as error:
            if str(error) not in ('IMAGE_DOWNLOAD_PENDING','IMAGE_FORMAT_UNSUPPORTED','IMAGE_WXGF_DECODE_FAILED'):
                raise
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass  # A native asynchronous writer may still own an abandoned part.
    raise RuntimeError('IMAGE_DOWNLOAD_PENDING')
