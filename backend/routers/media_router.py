"""Content-addressed media uploads; source markup remains portable to Anki."""
import hashlib
import os
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy.orm import Session
from auth import get_current_user
from database import get_db
from models import User
from media_utils import get_media_dir, get_all_referenced_media

router = APIRouter(prefix='/api/media-tools', tags=['Media'])
LIMIT = 20 * 1024 * 1024


def extension(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n'): return 'png'
    if data.startswith(b'\xff\xd8\xff'): return 'jpg'
    if data.startswith((b'GIF87a', b'GIF89a')): return 'gif'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP': return 'webp'
    if data[:4] == b'RIFF' and data[8:12] == b'WAVE': return 'wav'
    if data.startswith(b'OggS'): return 'ogg'
    if data.startswith(b'fLaC'): return 'flac'
    if data.startswith(b'ID3') or (len(data) > 2 and data[0] == 255 and data[1] & 0xE0 == 0xE0): return 'mp3'
    if data.startswith(b'\x1aE\xdf\xa3'): return 'webm'
    if len(data) > 12 and data[4:8] == b'ftyp': return 'mp4'
    raise HTTPException(415, 'Use PNG, JPEG, GIF, WebP, MP3, WAV, Ogg, FLAC, WebM or MP4 media')


@router.post('/upload', status_code=201)
async def upload(file: UploadFile, user: User = Depends(get_current_user)):
    try:
        data = await file.read(LIMIT + 1)
    finally:
        await file.close()
    if len(data) > LIMIT:
        raise HTTPException(413, 'Media exceeds 20 MB')
    ext = extension(data)
    filename = hashlib.sha256(data).hexdigest() + '.' + ext
    folder = Path(get_media_dir(user.id))
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / filename
    try:
        # Exclusive creation prevents overwriting package media or another upload.
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        if path.is_symlink() or path.read_bytes() != data:
            raise HTTPException(409, 'Media filename conflict') from None
    else:
        try:
            with os.fdopen(fd, 'wb') as out:
                out.write(data)
        except Exception:
            path.unlink(missing_ok=True)
            raise
    markup = f'<img src="{filename}">' if ext in ('png', 'jpg', 'gif', 'webp') else f'[sound:{filename}]'
    return dict(filename=filename, markup=markup, size=len(data))


@router.get('/check')
def check(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    folder = Path(get_media_dir(user.id))
    files = {p.name for p in folder.iterdir() if p.is_file() and not p.is_symlink()} if folder.exists() else set()
    referenced = get_all_referenced_media(user.id, db)
    return dict(missing=sorted(referenced - files), unused=sorted(files - referenced), total=len(files))
