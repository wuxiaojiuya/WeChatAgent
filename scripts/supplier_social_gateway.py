"""Local tool execution and task records, without touching WeChat databases."""
import base64
import hashlib
import json
import os
import pathlib
import re
import tempfile
import threading
import time

from supplier_api import read_json, runtime_directory
from supplier_social_actions import map_social_action
from supplier_social_results import normalize_moments_response, normalize_social_mutation


MUTATIONS = {'/PostMoment', '/PostImageMoment', '/ReplyMoment', '/SetSelfNickname',
             '/SetSelfAvatar', '/SetSelfSignature', '/SetGroupName'}
READS = {'/GetMoments', '/GetMomentDetail', '/ManagementOperationStatus'}
SOCIAL_ROUTES = MUTATIONS | READS


def no_links(file):
    for item in (file, *file.parents):
        if item.exists() and (item.is_symlink() or getattr(item.lstat(), 'st_file_attributes', 0) & 0x400):
            raise RuntimeError('HOOK_MANAGEMENT_STORAGE_INVALID')


class SupplierSocialGateway:
    def __init__(self, reader, stage):
        self.reader, self.stage = reader, stage
        self.file = reader.account/'management/operations.json'
        self.lock = threading.Lock()
        no_links(self.file)
        if self.file.exists() and self.file.stat().st_size > 16*1024*1024:
            raise RuntimeError('HOOK_MANAGEMENT_STORAGE_INVALID')
        value = read_json(self.file) if self.file.exists() else {'version': 1, 'operations': {}}
        if value.get('version') != 1 or not isinstance(value.get('operations'), dict):
            raise RuntimeError('HOOK_MANAGEMENT_STORAGE_INVALID')
        self.records = value['operations']

    def persist(self, records):
        no_links(self.file)
        self.file.parent.mkdir(parents=True, exist_ok=True)
        content = json.dumps({'version': 1, 'operations': records}, ensure_ascii=False).encode()
        if len(records) > 10000 or len(content) > 16*1024*1024:
            raise RuntimeError('HOOK_MANAGEMENT_STORAGE_FULL')
        handle, temporary = tempfile.mkstemp(dir=self.file.parent, suffix='.tmp')
        try:
            with os.fdopen(handle, 'wb') as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.file)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        self.records = records

    def conversation(self, key):
        match = re.fullmatch(r'wechat:(private|group):([1-9]\d{0,15})', key or '')
        if not match:
            raise PermissionError('HOOK_MANAGEMENT_SCOPE_DENIED')
        matches = [talker for talker in self.reader.selected_talkers()
                   if self.reader.conversation_id(talker) == match[2]
                   and talker.endswith('@chatroom') == (match[1] == 'group')]
        if len(matches) != 1:
            raise PermissionError('HOOK_MANAGEMENT_SCOPE_DENIED')
        return matches[0]

    def image(self, key, talker, body, avatar=False):
        images = [body['imageId']] if 'imageId' in body else body.get('imageIds', [])
        jobs = [body['drawingJobId']] if 'drawingJobId' in body else body.get('drawingJobIds', [])
        if not isinstance(images, list) or not isinstance(jobs, list) or len(images)+len(jobs) != 1:
            raise ValueError('HOOK_MOMENT_SINGLE_IMAGE_REQUIRED')
        if images:
            image_id = images[0]
            descriptor = self.reader.image_index.get(image_id) if isinstance(image_id, str) else None
            if not descriptor or descriptor.get('talker') != talker:
                raise PermissionError('IMAGE_REFERENCE_NOT_ALLOWED')
            normalized = self.reader.resolve_image(image_id)
            raw = base64.b64decode(normalized['b64'], validate=True)
            if len(raw) > 16*1024*1024 or hashlib.sha256(raw).hexdigest() != normalized.get('sha256'):
                raise RuntimeError('HOOK_SOCIAL_IMAGE_INVALID')
            directory = runtime_directory(self.reader.root)/'management-images'
            directory.mkdir(parents=True, exist_ok=True)
            file = directory/(hashlib.sha256(raw).hexdigest()+'.jpg')
            no_links(file)
            if not file.exists():
                handle, temporary = tempfile.mkstemp(dir=directory, suffix='.tmp')
                try:
                    with os.fdopen(handle, 'wb') as stream:
                        stream.write(raw)
                    os.replace(temporary, file)
                finally:
                    if os.path.exists(temporary):
                        os.unlink(temporary)
            if file.read_bytes() != raw:
                raise RuntimeError('HOOK_SOCIAL_IMAGE_CHANGED')
            return str(file)
        job_id = jobs[0]
        if not isinstance(job_id, str) or not re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}', job_id):
            raise ValueError('HOOK_DRAWING_REFERENCE_INVALID')
        folder = self.reader.root/'state/drawing/jobs'/job_id
        file, meta = folder/'image.png', folder/'job.json'
        no_links(meta)
        no_links(file)
        if not meta.is_file() or meta.stat().st_size > 24000:
            raise RuntimeError('HOOK_DRAWING_REFERENCE_UNAVAILABLE')
        job = read_json(meta)
        # This is saved project resource ownership, never a live login probe.
        scope = read_json(self.reader.root/'state/weflow/active-account.json').get('id')
        if (not scope or job.get('id') != job_id or job.get('state') != 'success'
                or job.get('conversationKey') != key or job.get('accountScope') != scope):
            raise PermissionError('HOOK_DRAWING_REFERENCE_NOT_ALLOWED')
        return str(file)

    def execute(self, route, body):
        if route not in SOCIAL_ROUTES or not isinstance(body, dict):
            raise ValueError('HOOK_ROUTE_UNSUPPORTED')
        key = body.get('conversationKey')
        talker = self.conversation(key)
        operation = body.get('operationId')
        if route == '/ManagementOperationStatus':
            if not isinstance(operation, str) or not re.fullmatch(r'[a-f0-9]{64}', operation):
                raise ValueError('HOOK_OPERATION_ID_INVALID')
            with self.lock:
                record = self.records.get(operation)
                if not record or record['conversationKey'] != key:
                    raise PermissionError('HOOK_MANAGEMENT_SCOPE_DENIED')
                return {**record['result'], 'operationId': operation}
        fingerprint = None
        if route in MUTATIONS:
            if not isinstance(operation, str) or not re.fullmatch(r'[a-f0-9]{64}', operation):
                raise ValueError('HOOK_OPERATION_ID_INVALID')
            fingerprint = hashlib.sha256(json.dumps([route, key, {k: v for k, v in body.items()
                if k != 'operationId'}], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            with self.lock:
                prior = self.records.get(operation)
                if prior:
                    if prior.get('fingerprint') != fingerprint or prior.get('conversationKey') != key:
                        raise ValueError('HOOK_OPERATION_CONFLICT')
                    return {**prior['result'], 'operationId': operation, 'reused': True}
        mapped_body = dict(body)
        if route in ('/PostMoment', '/PostImageMoment'):
            mapped_body['content'] = body.get('text', '')
        if route == '/SetGroupName':
            if not talker.endswith('@chatroom'):
                raise PermissionError('HOOK_GROUP_REQUIRED')
            mapped_body['wxidorgid'] = talker
        if route in ('/PostImageMoment', '/SetSelfAvatar'):
            mapped_body['path'] = self.image(key, talker, body, avatar=route == '/SetSelfAvatar')
        upstream, payload = map_social_action(route, mapped_body)
        if route in READS:
            return normalize_moments_response(route, self.reader.api.post(upstream, payload),
                expected_id=str(payload['sns_id']) if route == '/GetMomentDetail' else None)
        with self.lock:
            prior = self.records.get(operation)
            if prior:
                if prior.get('fingerprint') != fingerprint or prior.get('conversationKey') != key:
                    raise ValueError('HOOK_OPERATION_CONFLICT')
                return {**prior['result'], 'operationId': operation, 'reused': True}
            if route in ('/PostImageMoment', '/SetSelfAvatar'):
                field = 'filelist' if route == '/PostImageMoment' else 'filepath'
                payload[field] = str(self.stage(self.reader.root, pathlib.Path(payload[field])))
            result = {'state': 'unconfirmed', 'apiAcknowledged': False, 'confirmed': False}
            record = {'fingerprint': fingerprint, 'conversationKey': key, 'route': route,
                      'createdAt': time.time(), 'result': result}
            self.persist({**self.records, operation: record})
            try:
                raw = self.reader.api.post(upstream, payload, timeout=30)
                acknowledgement = normalize_social_mutation(route, raw, expected=payload)
                result = {**acknowledgement, 'state': 'api-acknowledged' if acknowledgement.get('apiAcknowledged') else 'rejected'}
            except Exception as error:
                code = str(error)
                result = {**result, 'code': code if re.fullmatch(r'HOOK_[A-Z0-9_]{2,79}', code) else 'HOOK_MANAGEMENT_RESULT_UNKNOWN'}
            record = {**record, 'finishedAt': time.time(), 'result': result}
            # If final persistence fails, the pre-submit unknown record remains;
            # subsequent requests still cannot submit this action a second time.
            self.persist({**self.records, operation: record})
            return {**result, 'operationId': operation}
