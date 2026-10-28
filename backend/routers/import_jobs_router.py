"""Two-phase package import: upload/preview, then explicit confirmation."""
import os
import tempfile
from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from auth import get_current_user
from models import User
from import_config import MAX_UPLOAD_BYTES, check_space, limits
import import_jobs

router = APIRouter(prefix='/api/apkg', tags=['APKG Import/Export'])


@router.get('/limits')
def import_limits(user: User = Depends(get_current_user)):
    return limits()


@router.post('/jobs', status_code=202)
async def create_job(file: UploadFile = File(...), include_scheduling: bool = False,
                     collection_restore: bool = False,
                     media_conflicts: Literal['error', 'rename'] = 'error',
                     duplicate_policy: Literal['newer', 'skip', 'update', 'add'] = 'newer',
                     sanitize_svg: bool = True, user: User = Depends(get_current_user)):
    if not file.filename or not file.filename.lower().endswith(('.apkg', '.colpkg')):
        raise HTTPException(400, 'Only .apkg and .colpkg files are supported')
    whole_collection = file.filename.lower().endswith('.colpkg')
    if whole_collection and not collection_restore:
        raise HTTPException(400, 'COLPKG requires explicit collection_restore=true and an empty collection')
    if file.size is not None and file.size > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f'File too large. Maximum allowed size is {MAX_UPLOAD_BYTES // 1024**2} MiB.')
    import_jobs.ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        check_space(import_jobs.ROOT, file.size or 0)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    fd, path = tempfile.mkstemp(suffix='.apkg', dir=import_jobs.ROOT)
    try:
        total = 0
        with os.fdopen(fd, 'wb') as stream:
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, f'File too large. Maximum allowed size is {MAX_UPLOAD_BYTES // 1024**2} MiB.')
                check_space(import_jobs.ROOT, len(chunk))
                stream.write(chunk)
        # submit transfers ownership of the uploaded temporary file.
        return import_jobs.submit(path, user.id, dict(include_scheduling=include_scheduling or whole_collection,
                                  whole_collection=whole_collection, media_conflicts=media_conflicts,
                                  duplicate_policy=duplicate_policy, sanitize_svg=sanitize_svg))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    finally:
        if os.path.exists(path):
            os.unlink(path)


@router.get('/jobs')
def pending_jobs(user: User = Depends(get_current_user)):
    return import_jobs.pending(user.id)


@router.get('/jobs/{job_id}')
def get_job(job_id: str, user: User = Depends(get_current_user)):
    return import_jobs.read_status(job_id, user.id)


@router.post('/jobs/{job_id}/confirm', status_code=202)
def confirm_job(job_id: str, user: User = Depends(get_current_user)):
    return import_jobs.confirm(job_id, user.id)


@router.post('/jobs/{job_id}/cancel')
def cancel_job(job_id: str, user: User = Depends(get_current_user)):
    return import_jobs.cancel(job_id, user.id)


from fastapi import Request, Query
from pydantic import BaseModel, Field
import import_uploads


class UploadRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    size: int = Field(gt=0)
    include_scheduling: bool = False
    collection_restore: bool = False
    media_conflicts: Literal['error', 'rename'] = 'error'
    duplicate_policy: Literal['newer', 'skip', 'update', 'add'] = 'newer'
    sanitize_svg: bool = True


@router.post('/uploads', status_code=201)
def create_upload(body: UploadRequest, user: User = Depends(get_current_user)):
    try:
        return import_uploads.create(user.id, body.filename, body.size,
                                     body.model_dump(exclude={'filename', 'size'}))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


@router.get('/uploads/{upload_id}')
def get_upload(upload_id: str, user: User = Depends(get_current_user)):
    return import_uploads.get(upload_id, user.id)


@router.put('/uploads/{upload_id}')
async def append_upload(upload_id: str, request: Request, offset: int = Query(ge=0),
                        user: User = Depends(get_current_user)):
    try:
        return await import_uploads.append(upload_id, user.id, offset, request)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


@router.post('/uploads/{upload_id}/finish', status_code=202)
def finish_upload(upload_id: str, user: User = Depends(get_current_user)):
    return import_uploads.finish(upload_id, user.id)


@router.delete('/uploads/{upload_id}')
def delete_upload(upload_id: str, user: User = Depends(get_current_user)):
    return import_uploads.cancel(upload_id, user.id)
