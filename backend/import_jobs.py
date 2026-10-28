"""Disk-backed package jobs. A file lock serializes imports across API workers.

Workers use their own SQLAlchemy sessions. Status writes use atomic rename and
never compete with the collection transaction. Interrupted jobs are not retried.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import fcntl
import json
import logging
import os
from pathlib import Path
import re
import tempfile
import time
import uuid

from fastapi import HTTPException
from database import BASE_DIR, SessionLocal

logger = logging.getLogger(__name__)
ROOT = Path(BASE_DIR) / 'import-jobs'
EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix='anki-import')
ACTIVE = {'validating', 'extracting', 'decompressing', 'checking_media', 'checking_templates',
          'importing_notes', 'backing_up_media', 'copying_media', 'committing', 'queued'}


class ImportCancelled(ValueError):
    pass


def error_info(exc):
    message = str(exc)
    if isinstance(exc, ImportCancelled):
        return 'cancelled', 'Import cancelled; collection changes were rolled back.'
    if isinstance(exc, ValueError):
        code = 'limit_exceeded' if any(w in message.lower() for w in ('limit', 'too many', 'too large', 'space')) else 'invalid_package'
        if any(w in message.lower() for w in ('unsupported', 'template', 'filter')):
            code = 'unsupported_feature'
        # Never expose server paths, while keeping ordinary validation useful.
        if re.search(r'/(?:home|tmp|var|etc|usr|mnt|data)(?:/|\b)|\\', message):
            message = 'Invalid or corrupted APKG file: invalid path or unsupported media reference.'
        return code, message[:1000] or 'Invalid Anki package.'
    import sqlite3
    import zipfile
    if isinstance(exc, (sqlite3.DatabaseError, zipfile.BadZipFile, KeyError)):
        return 'invalid_package', 'Invalid or corrupted APKG file: invalid database/archive.'
    return 'processing_failed', 'Import failed. See server logs for details.'


def directory(job_id):
    if not re.fullmatch(r'[0-9a-f]{32}', job_id):
        raise HTTPException(404, 'Import job not found')
    return ROOT / job_id


def write_status(path, data):
    data['updated_at'] = time.time()
    fd, temporary = tempfile.mkstemp(dir=path, prefix='.status-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream)
        os.replace(temporary, path / 'status.json')
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def acquire_gate():
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    stream = (ROOT / '.import.lock').open('a+')
    try:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        stream.close()
        raise HTTPException(409, 'Another package import is active. Wait for it to finish.') from None
    return stream


@contextmanager
def import_gate():
    gate = acquire_gate()
    try:
        yield
    finally:
        gate.close()


def read_status(job_id, user_id):
    path = directory(job_id)
    try:
        data = json.loads((path / 'status.json').read_text())
    except FileNotFoundError:
        raise HTTPException(404, 'Import job not found') from None
    if data['user_id'] != user_id:
        raise HTTPException(404, 'Import job not found')
    if data['status'] in ACTIVE or data['status'] == 'awaiting_confirmation':
        # Re-read after acquiring: a worker may have finished since the first
        # snapshot. Never mark a successfully completed transaction interrupted.
        with (path / '.lock').open('a+') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                pass
            else:
                data = json.loads((path / 'status.json').read_text())
                if data['status'] in ACTIVE:
                    data.update(status='interrupted', error_code='interrupted',
                                detail='Server stopped during import. Check your collection before uploading again.')
                    write_status(path, data)
                    (path / 'package.apkg').unlink(missing_ok=True)
                elif data['status'] == 'awaiting_confirmation' and time.time() - data['updated_at'] > 86400:
                    data.update(status='expired', detail='Preview expired. Upload the package again.')
                    write_status(path, data)
                    (path / 'package.apkg').unlink(missing_ok=True)

    return data


def cleanup_expired():
    """Bound retained uploads/status records; invoked on new submissions."""
    import shutil
    if not ROOT.exists():
        return
    for path in ROOT.iterdir():
        if not path.is_dir() or not re.fullmatch(r'[0-9a-f]{32}', path.name):
            continue
        try:
            data = json.loads((path / 'status.json').read_text())
            data = read_status(path.name, data['user_id'])
            if data['status'] not in ACTIVE and time.time() - data['updated_at'] > 7 * 86400:
                shutil.rmtree(path)
        except (OSError, ValueError):
            logger.exception('Could not clean expired import job')


def submit(package_path, user_id, options):
    cleanup_expired()
    gate = acquire_gate()
    path = ROOT / uuid.uuid4().hex
    try:
        path.mkdir(mode=0o700)
        # copyfile permits upload temp storage on another filesystem.
        import shutil
        shutil.move(package_path, path / 'package.apkg')
        data = dict(id=path.name, user_id=user_id, status='queued', completed=0, total=0,
                    options=options, result=None, detail=None)
        write_status(path, data)
        start(path, data, gate, preview=True)
    except Exception:
        import shutil
        shutil.rmtree(path, ignore_errors=True)
        gate.close()
        raise
    return data


def start(path, data, gate, preview):
    from account_lifecycle import acquire_account_lock
    account = acquire_account_lock(data['user_id'])
    lock = None
    try:
        lock = (path / '.lock').open('a+')
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not preview:
            latest = json.loads((path / 'status.json').read_text())
            if latest['status'] != 'awaiting_confirmation':
                raise HTTPException(409, 'This import is no longer awaiting confirmation')
        data.update(status='queued', completed=0, total=0, detail=None)
        write_status(path, data)
        EXECUTOR.submit(run, path, dict(data), gate, lock, preview, account)
    except Exception:
        if lock is not None:
            lock.close()
        account.close()
        gate.close()
        raise


def confirm(job_id, user_id):
    gate = acquire_gate()
    try:
        data = read_status(job_id, user_id)
        if data['status'] != 'awaiting_confirmation':
            raise HTTPException(409, 'This import is not awaiting confirmation')
        start(directory(job_id), data, gate, preview=False)
        return data
    except Exception:
        gate.close()
        raise


def cancel(job_id, user_id):
    data = read_status(job_id, user_id)
    path = directory(job_id)
    if data['status'] in ACTIVE:
        if data['status'] == 'committing':
            raise HTTPException(409, 'Import is committing; wait for the result')
        (path / 'cancel').touch()
        return dict(data, cancel_requested=True)
    if data['status'] == 'awaiting_confirmation':
        # Serialize confirmation and cancellation across processes.
        with import_gate():
            data = read_status(job_id, user_id)
            if data['status'] == 'awaiting_confirmation':
                data.update(status='cancelled', detail='Import cancelled; collection was not changed.')
                write_status(path, data)
                (path / 'package.apkg').unlink(missing_ok=True)
    return data


def run(path, data, gate, lock, preview, account):
    from apkg_handler import import_apkg
    last_write = 0
    def progress(stage, completed=0, total=0):
        nonlocal last_write
        if (path / 'cancel').exists():
            raise ImportCancelled()
        now = time.monotonic()
        if stage != data['status'] or now - last_write > 0.25:
            data.update(status=stage, completed=completed, total=total)
            write_status(path, data)
            last_write = now
    try:
        with SessionLocal() as db:
            result = import_apkg(str(path / 'package.apkg'), data['user_id'], db,
                                 **data['options'], preview=preview, progress=progress)
        data.update(status='awaiting_confirmation' if preview else 'completed', result=result,
                    completed=1, total=1)
    except Exception as exc:
        logger.exception('Package job %s failed', path.name)
        code, detail = error_info(exc)
        data.update(status='cancelled' if code == 'cancelled' else 'failed', error_code=code, detail=detail)
    finally:
        try:
            if data['status'] != 'awaiting_confirmation':
                (path / 'package.apkg').unlink(missing_ok=True)
            write_status(path, data)
        finally:
            lock.close()
            gate.close()
            account.close()


def pending(user_id):
    """Recover an account's active jobs even after a lost browser response/tab."""
    if not ROOT.exists():
        return []
    found = []
    for path in ROOT.glob('*/status.json'):
        if not re.fullmatch(r'[0-9a-f]{32}', path.parent.name):
            continue
        try:
            data = json.loads(path.read_text())
            if data.get('user_id') != user_id or data.get('status') not in ACTIVE | {'awaiting_confirmation'}:
                continue
            data = read_status(path.parent.name, user_id)
            if data['status'] in ACTIVE | {'awaiting_confirmation'}:
                found.append(data)
        except (OSError, ValueError):
            logger.warning('Could not inspect import job %s', path.parent.name)
    return sorted(found, key=lambda data: data['updated_at'], reverse=True)[:20]
