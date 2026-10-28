"""Coordinate deletion with requests/jobs and remove account-owned disk data."""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import shutil

from fastapi import HTTPException
from database import BASE_DIR
from media_utils import get_media_dir

LOCK_ROOT = Path(BASE_DIR) / '.account-locks'


def allocate_user_id(db):
    # SQLite otherwise reuses a removed highest ID, making old JWT subjects
    # address a new account. Numeric lock files retain only an ID high-water mark.
    from sqlalchemy import func, update
    from models import User
    db.execute(update(User).where(User.id == -1).values(id=User.id))
    used = [int(p.name) for p in LOCK_ROOT.iterdir() if p.name.isdecimal()] if LOCK_ROOT.exists() else []
    next_id = max([db.query(func.max(User.id)).scalar() or 0, *used]) + 1
    with account_lock(next_id):
        pass
    return next_id


def acquire_account_lock(user_id, *, deleting=False):
    LOCK_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    stream = (LOCK_ROOT / str(int(user_id))).open('a+')
    try:
        fcntl.flock(stream, (fcntl.LOCK_EX if deleting else fcntl.LOCK_SH) | fcntl.LOCK_NB)
    except BlockingIOError:
        stream.close()
        raise HTTPException(409, 'Account is busy. Wait for active requests/imports to finish, then retry.') from None
    return stream


@contextmanager
def account_lock(user_id, *, deleting=False):
    stream = acquire_account_lock(user_id, deleting=deleting)
    try:
        yield
    finally:
        stream.close()


def remove_tree(path):
    """Do not follow a symlink or silently ignore a failed deletion."""
    path = Path(path)
    try:
        if path.is_symlink():
            path.unlink()
        elif path.exists():
            shutil.rmtree(path)
    except FileNotFoundError:
        pass


def purge_account_files(user_id):
    """Caller holds the account's exclusive lock, including against import workers."""
    import import_jobs
    import import_uploads

    owned = []
    for root in (import_jobs.ROOT, import_uploads.root()):
        if not root.exists():
            continue
        for path in root.iterdir():
            if path.is_symlink() or not path.is_dir() or not re.fullmatch(r'[0-9a-f]{32}', path.name):
                continue
            try:
                data = json.loads((path / 'status.json').read_text())
            except FileNotFoundError:
                continue
            if data.get('user_id') == user_id:
                owned.append(path)
    # Includes ordinary backups, pending restore packages and partial .tmp files.
    backups = Path(os.getenv('BACKUP_DIR', str(Path(BASE_DIR) / 'backups'))) / str(user_id)
    for path in [*owned, backups, Path(get_media_dir(user_id))]:
        remove_tree(path)
