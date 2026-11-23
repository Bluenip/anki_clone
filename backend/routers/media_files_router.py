"""Serves /api/media/{user_id}/{filename} to signed-in owners only (replaces a public static mount)."""
import mimetypes
import os

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from auth import media_user_id
from database import get_db
from media_utils import get_media_dir

router = APIRouter(prefix='/api/media', tags=['Media'])


@router.get('/{owner_id}/{filename}')
def media_file(owner_id: int, filename: str, request: Request, db: Session = Depends(get_db)):
    viewer = media_user_id(request, db)
    if viewer is None:
        raise HTTPException(401, 'Sign in to load media')
    # Only the owner. Card text is written by the viewer, so it can never grant access to another
    # account's files; shared decks copy their media into the downloader's folder instead.
    if viewer != owner_id:
        raise HTTPException(404, 'Not found')
    if os.path.basename(filename) != filename or filename.startswith('.') or '\\' in filename:
        raise HTTPException(404, 'Not found')
    folder = os.path.realpath(get_media_dir(owner_id))
    path = os.path.realpath(os.path.join(folder, filename))
    if os.path.dirname(path) != folder or not os.path.isfile(path):
        raise HTTPException(404, 'Not found')
    media_type = mimetypes.guess_type(filename)[0] or 'application/octet-stream'
    return FileResponse(path, media_type=media_type, headers={
        'Cache-Control': 'private, max-age=3600',
        # Opened directly, an SVG or HTML file must not run as a page of this site.
        'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    })
