"""Bounded, resumable uploads for proxies with request-size/time limits."""
from contextlib import contextmanager
import fcntl
import json
from pathlib import Path
import time
import uuid

from fastapi import HTTPException
import import_jobs
from import_config import MAX_UPLOAD_BYTES, check_space

CHUNK_BYTES = 8 * 1024**2


def root():
    return import_jobs.ROOT / 'uploads'


@contextmanager
def locked(upload_id, user_id):
    if not __import__('re').fullmatch(r'[0-9a-f]{32}', upload_id):
        raise HTTPException(404, 'Upload not found')
    path = root() / upload_id
    if not (path / 'status.json').is_file():
        raise HTTPException(404, 'Upload not found')
    with (path / '.lock').open('a+') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise HTTPException(409, 'Upload is busy; retry this request') from None
        data = json.loads((path / 'status.json').read_text())
        if data['user_id'] != user_id:
            raise HTTPException(404, 'Upload not found')
        if data['status'] == 'uploading':
            package = path / 'package.apkg'
            if not package.exists() or package.stat().st_size < data['received']:
                raise HTTPException(409, 'Upload was interrupted. Select the file again.')
            # A process may stop after writing bytes but before acknowledging.
            if package.stat().st_size > data['received']:
                with package.open('r+b') as stream:
                    stream.truncate(data['received'])
            if time.time() - data['updated_at'] > 86400:
                data['status'] = 'expired'
                package.unlink(missing_ok=True)
                import_jobs.write_status(path, data)
        yield path, data


def cleanup():
    import shutil
    if not root().exists():
        return
    for path in root().iterdir():
        if not path.is_dir():
            continue
        try:
            data = json.loads((path / 'status.json').read_text())
            with locked(path.name, data['user_id']) as (_, current):
                if time.time() - current['updated_at'] > 7 * 86400:
                    shutil.rmtree(path)
        except (OSError, ValueError, HTTPException):
            continue


def create(user_id, filename, size, options):
    if not filename.lower().endswith(('.apkg', '.colpkg')):
        raise HTTPException(400, 'Only .apkg and .colpkg files are supported')
    if size <= 0 or size > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f'Package must be between 1 and {MAX_UPLOAD_BYTES} bytes')
    whole_collection = filename.lower().endswith('.colpkg')
    if whole_collection and not options.pop('collection_restore'):
        raise HTTPException(400, 'COLPKG requires explicit collection_restore=true and an empty collection')
    options.pop('collection_restore', None)
    options['whole_collection'] = whole_collection
    options['include_scheduling'] = options['include_scheduling'] or whole_collection
    root().mkdir(parents=True, exist_ok=True, mode=0o700)
    cleanup()
    check_space(root(), size)
    path = root() / uuid.uuid4().hex
    path.mkdir(mode=0o700)
    (path / 'package.apkg').touch(mode=0o600)
    data = dict(id=path.name, user_id=user_id, filename=Path(filename).name, size=size,
                received=0, status='uploading', chunk_bytes=CHUNK_BYTES, options=options)
    import_jobs.write_status(path, data)
    return data


def get(upload_id, user_id):
    with locked(upload_id, user_id) as (_, data):
        return data


async def append(upload_id, user_id, offset, request):
    import os
    with locked(upload_id, user_id) as (path, data):
        if data['status'] != 'uploading':
            raise HTTPException(409, 'Upload is no longer accepting data')
        if offset != data['received']:
            raise HTTPException(409, f'Upload offset mismatch; expected {data["received"]}')
        length = request.headers.get('content-length')
        if length and int(length) > CHUNK_BYTES:
            raise HTTPException(413, f'Chunk exceeds {CHUNK_BYTES} bytes')
        count = 0
        with (path / 'package.apkg').open('r+b') as stream:
            stream.seek(offset)
            try:
                async for chunk in request.stream():
                    count += len(chunk)
                    if count > CHUNK_BYTES or offset + count > data['size']:
                        raise HTTPException(413, 'Chunk exceeds upload budget')
                    check_space(path, len(chunk))
                    stream.write(chunk)
                if count == 0:
                    raise HTTPException(400, 'Empty chunk')
                stream.flush()
                os.fsync(stream.fileno())
                data['received'] = offset + count
                import_jobs.write_status(path, data)
            except BaseException:
                stream.truncate(offset)
                raise
        return data


def finish(upload_id, user_id):
    with locked(upload_id, user_id) as (path, data):
        if data.get('job_id'):
            return import_jobs.read_status(data['job_id'], user_id)
        if data['status'] != 'uploading' or data['received'] != data['size']:
            raise HTTPException(409, 'Upload is incomplete; send the remaining bytes first')
        job = import_jobs.submit(str(path / 'package.apkg'), user_id, data['options'])
        data.update(status='submitted', job_id=job['id'])
        import_jobs.write_status(path, data)
        return job


def cancel(upload_id, user_id):
    with locked(upload_id, user_id) as (path, data):
        if data.get('job_id'):
            return import_jobs.cancel(data['job_id'], user_id)
        (path / 'package.apkg').unlink(missing_ok=True)
        data['status'] = 'cancelled'
        import_jobs.write_status(path, data)
        return data
