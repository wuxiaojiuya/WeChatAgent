"""Download the exact CDN variant described by a bound video message."""
import os
import pathlib
import re
import tempfile
import time

from supplier_api import runtime_directory
from wechat_files import hashes
from wechat_video import MAX_VIDEO_BYTES


def verified_video(file, item):
    stat = file.lstat()
    if file.is_symlink() or not file.is_file() or getattr(stat, 'st_file_attributes', 0) & 0x400:
        raise RuntimeError('VIDEO_DOWNLOAD_FILE_INVALID')
    if stat.st_size > MAX_VIDEO_BYTES:
        raise RuntimeError('VIDEO_TOO_LARGE')
    if stat.st_size != item['size']:
        raise OSError('Video is still being written')
    if item['md5'] and hashes(file)[0] != item['md5']:
        raise RuntimeError('VIDEO_INTEGRITY_FAILED')
    current = file.stat()
    if (current.st_size, current.st_mtime_ns) != (stat.st_size, stat.st_mtime_ns):
        raise OSError('Video is still being written')
    return file


def wait_video(file, item, deadline):
    previous, stable = None, 0
    while time.monotonic() < deadline:
        try:
            stat = file.lstat()
            if file.is_symlink() or not file.is_file() or getattr(stat, 'st_file_attributes', 0) & 0x400:
                raise RuntimeError('VIDEO_DOWNLOAD_FILE_INVALID')
            if stat.st_size > MAX_VIDEO_BYTES:
                raise RuntimeError('VIDEO_TOO_LARGE')
            fingerprint = (stat.st_size, stat.st_mtime_ns)
            stable = stable + 1 if fingerprint == previous and stat.st_size == item['size'] else 0
            previous = fingerprint
            if stable >= 2:
                return verified_video(file, item)
        except (FileNotFoundError, OSError):
            pass
        time.sleep(min(.1, max(0, deadline-time.monotonic())))
    raise RuntimeError('VIDEO_DOWNLOAD_PENDING')


def download_video(reader, video_id, item, node):
    if not re.fullmatch(r'[a-f0-9]{64}', video_id):
        raise RuntimeError('VIDEO_REFERENCE_NOT_ALLOWED')
    directory = runtime_directory(reader.root)/'incoming-video'
    directory.mkdir(parents=True, exist_ok=True)
    file = directory/(video_id+'.mp4')
    reader.active_identity()
    if file.exists() or file.is_symlink():
        try:
            verified_video(file, item)
            reader.active_identity()
            if not reader.image_talker_allowed(item['talker']):
                raise PermissionError('VIDEO_REFERENCE_NOT_ALLOWED')
            return file
        except OSError:
            pass
        except RuntimeError as error:
            if str(error) != 'VIDEO_INTEGRITY_FAILED':
                raise

    attrs = node.attrib if node is not None else {}
    file_id, aes_key = attrs.get('cdnvideourl', ''), attrs.get('aeskey', '')
    attempts = []
    # download_video can fetch another encoded variant and truncate it at the
    # XML's length. CDN type 4 requests the precise variant paired with its MD5.
    if file_id and len(file_id) <= 8192 and re.fullmatch(r'[a-fA-F0-9]{32}', aes_key):
        attempts.append(('/api/cdn_download', {'fileid':file_id, 'asekey':aes_key, 'imgType':4}, 'out'))
    with reader.callback_lock:
        callback = dict(reader.callback_messages.get(item['serverId'], {}))
    msg_id = callback.get('msgId')
    if isinstance(msg_id, str) and re.fullmatch(r'[0-9]{1,10}', msg_id):
        msg_id = int(msg_id)
    if (callback.get('type') == 43 and callback.get('from') == item['talker']
            and callback.get('to') == reader.own_wxid and type(msg_id) is int and 0 < msg_id <= 0xffffffff):
        attempts.append(('/api/download_video', {'total_len':item['size'], 'NewMsgId':int(item['serverId']), 'MsgId':msg_id}, 'path'))
    if not attempts:
        raise RuntimeError('VIDEO_CALLBACK_METADATA_REQUIRED')

    deadline = time.monotonic()+18
    last_error = 'VIDEO_DOWNLOAD_PENDING'
    for route, body, field in attempts:
        if deadline-time.monotonic() < .3:
            break
        handle, temporary = tempfile.mkstemp(dir=directory, suffix='.mp4.part')
        os.close(handle)
        temporary = pathlib.Path(temporary)
        try:
            reader.active_identity()
            try:
                reader.api.post(route, {**body, field:str(temporary)}, timeout=min(3, deadline-time.monotonic()))
            except RuntimeError:
                pass  # An HTTP timeout can still leave a completed native download.
            wait_video(temporary, item, min(deadline, time.monotonic()+7))
            reader.active_identity()
            if not reader.image_talker_allowed(item['talker']):
                raise PermissionError('VIDEO_REFERENCE_NOT_ALLOWED')
            os.replace(temporary, file)
            return file
        except RuntimeError as error:
            if str(error) not in ('VIDEO_DOWNLOAD_PENDING', 'VIDEO_INTEGRITY_FAILED'):
                raise
            last_error = str(error)
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass  # The asynchronous native writer may still own the part.
    raise RuntimeError(last_error)
