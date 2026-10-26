"""Preview-first collection replacement with durable, account-scoped backups."""
import json
import os
from pathlib import Path
import shutil
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import create_engine, event, func
from sqlalchemy.orm import Session
from auth import get_current_user
from database import get_db, Base, BASE_DIR
from models import User, CollectionOperation, StudyOperation
from media_utils import get_media_dir
from collection_snapshot import capture, fingerprint, restore, clear, TABLES
from bulk_history import begin

router = APIRouter(prefix='/api/backups', tags=['Backups'])


def folder(uid):
    path = Path(os.getenv('BACKUP_DIR', str(Path(BASE_DIR) / 'backups'))) / str(uid)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def identifier(value):
    try: return str(uuid.UUID(value))
    except ValueError: raise HTTPException(404, 'Backup not found') from None


def create_backup(db, uid, snapshot=None):
    data = snapshot if snapshot is not None else capture(db, uid)
    key = str(uuid.uuid4()); path = folder(uid) / (key + '.zip')
    temporary = path.with_suffix('.tmp')
    try:
        with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('snapshot.json', json.dumps({'user_id': uid, 'created_at': datetime.now(timezone.utc).isoformat(), 'data': data}))
            media = Path(get_media_dir(uid))
            if media.exists():
                for file in media.iterdir():
                    if file.is_file() and not file.is_symlink(): archive.write(file, 'media/' + file.name)
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True); raise
    return key


class Guard(BaseModel):
    expected_revision: str = Field(pattern=r'^[0-9a-f]{64}$')


class Apply(Guard):
    token: str


@router.get('')
def list_backups(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    data = capture(db, user.id)
    return {'revision': fingerprint(data), 'cards': len(data['cards']), 'notes': len(data['notes']),
            'backups': [{'id': p.stem, 'size': p.stat().st_size, 'created_at': datetime.fromtimestamp(p.stat().st_mtime, timezone.utc).isoformat()} for p in sorted(folder(user.id).glob('*.zip'), key=lambda p: p.stat().st_mtime, reverse=True)]}


@router.post('')
def backup(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    try:
        snapshot = begin(db, user.id)
        key = create_backup(db, user.id, snapshot)
        db.commit()
        return {'id': key}
    except BaseException:
        db.rollback(); raise


@router.get('/{backup_id}/download')
def download(backup_id: str, user: User = Depends(get_current_user)):
    path = folder(user.id) / (identifier(backup_id) + '.zip')
    if not path.is_file(): raise HTTPException(404, 'Backup not found')
    return FileResponse(path, filename='anki-clone-backup-' + backup_id + '.zip')


@router.post('/{backup_id}/restore')
def restore_backup(backup_id: str, guard: Guard, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    path = folder(user.id) / (identifier(backup_id) + '.zip')
    if not path.is_file(): raise HTTPException(404, 'Backup not found')
    current = begin(db, user.id)
    if fingerprint(current) != guard.expected_revision:
        db.rollback(); raise HTTPException(409, 'Collection changed; reload before restoring')
    safety = create_backup(db, user.id, current)
    media = Path(get_media_dir(user.id)); media.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='anki_restore_media_') as temporary:
        overwritten, created = [], []
        try:
            with zipfile.ZipFile(path) as archive:
                saved = json.loads(archive.read('snapshot.json'))
                if saved['user_id'] != user.id: raise HTTPException(403, 'Backup belongs to another account')
                restore(db, user.id, saved['data'])
                for entry in archive.infolist():
                    if not entry.filename.startswith('media/'): continue
                    name = entry.filename[6:]
                    if not name or Path(name).name != name or '\\' in name: raise ValueError('Unsafe backup media filename')
                    target = media / name
                    if target.is_symlink(): raise ValueError('Unsafe backup media destination')
                    if target.exists():
                        backup_path = Path(temporary) / str(len(overwritten)); shutil.copy2(target, backup_path); overwritten.append((target, backup_path))
                    else: created.append(target)
                    staged = Path(temporary) / 'staged'
                    with archive.open(entry) as source, staged.open('wb') as output: shutil.copyfileobj(source, output)
                    shutil.copy2(staged, target)
            db.query(CollectionOperation).filter_by(user_id=user.id).delete(synchronize_session=False)
            db.query(StudyOperation).filter_by(user_id=user.id).update({'undone': True}, synchronize_session=False)
            db.commit()
        except BaseException as exc:
            db.rollback()
            for target in created: target.unlink(missing_ok=True)
            for target, original in overwritten: shutil.copy2(original, target)
            if isinstance(exc, (ValueError, KeyError, zipfile.BadZipFile)): raise HTTPException(422, 'Invalid backup: ' + str(exc)) from None
            raise
    return {'restored': True, 'safety_backup': safety}


@router.post('/preview')
async def preview(file: UploadFile = File(...), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if not file.filename or not file.filename.lower().endswith('.colpkg'):
        await file.close(); raise HTTPException(422, 'Choose an Anki collection package (.colpkg)')
    key = str(uuid.uuid4()); path = folder(user.id) / ('pending-' + key + '.colpkg')
    size = 0
    try:
        with path.open('wb') as output:
            while chunk := await file.read(65536):
                size += len(chunk)
                if size > 50 * 1024 * 1024: raise HTTPException(413, 'Collection package exceeds 50 MB')
                output.write(chunk)
        from apkg_handler import import_apkg
        with tempfile.TemporaryDirectory(prefix='anki_restore_preview_') as directory:
            engine = create_engine('sqlite:///' + str(Path(directory) / 'validation.db'))
            try:
                Base.metadata.create_all(engine)
                with Session(engine) as staging:
                    staging.add(User(id=user.id, email='preview@example.invalid', username='Preview', password_hash='not-a-login')); staging.commit()
                    import_apkg(str(path), user.id, staging, include_scheduling=True, whole_collection=True, media_directory=str(Path(directory) / 'media'))
                    data = capture(staging, user.id)
                    counts = {key: len(data[key]) for key in ('decks', 'notes', 'cards', 'review_logs')}
            finally: engine.dispose()
        return {'token': key, 'expected_revision': fingerprint(capture(db, user.id)), 'incoming': counts,
                'message': 'Applying replaces this account collection. A complete backup is saved first.'}
    except BaseException as exc:
        path.unlink(missing_ok=True)
        if isinstance(exc, (ValueError, KeyError, zipfile.BadZipFile)): raise HTTPException(422, str(exc)) from None
        raise
    finally: await file.close()


@router.post('/apply')
def apply(data: Apply, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    path = folder(user.id) / ('pending-' + identifier(data.token) + '.colpkg')
    if not path.is_file(): raise HTTPException(404, 'Preview upload not found')
    if datetime.now(timezone.utc).timestamp() - path.stat().st_mtime > 86400: raise HTTPException(409, 'Preview expired; upload again')
    current = begin(db, user.id)
    if fingerprint(current) != data.expected_revision:
        db.rollback(); raise HTTPException(409, 'Collection changed since preview; preview again')
    safety = create_backup(db, user.id, current)
    # Keep newly imported IDs above the old global maximum so stale tabs cannot
    # accidentally address a different card that reused a deleted SQLite ID.
    floors = {model: db.query(func.max(model.id)).scalar() or 0 for model in TABLES if hasattr(model, 'id') and model.__table__.c.id.type.python_type is int}
    def allocate(session, context, instances):
        for obj in session.new:
            model = type(obj)
            if model in floors and obj.id is None: floors[model] += 1; obj.id = floors[model]
    event.listen(db, 'before_flush', allocate)
    try:
        clear(db, user.id)
        db.query(CollectionOperation).filter_by(user_id=user.id).delete(synchronize_session=False)
        from apkg_handler import import_apkg
        result = import_apkg(str(path), user.id, db, include_scheduling=True, whole_collection=True, media_conflicts='rename')
        path.unlink(missing_ok=True)
        return {'restored': True, 'safety_backup': safety, **result}
    except BaseException:
        db.rollback(); raise
    finally: event.remove(db, 'before_flush', allocate)
