"""Serves /api/media/{user_id}/{filename} to signed-in owners only (replaces a public static mount)."""
import mimetypes
import os
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from auth import media_user_id
from database import get_db
from media_utils import get_media_dir
from models import Card, Deck

router = APIRouter(prefix='/api/media', tags=['Media'])


def _referenced_by_own_card(db, viewer_id, owner_id, filename):
    """Decks downloaded before shared media was copied still point at the sharer's folder."""
    needles = {f'/api/media/{owner_id}/{filename}', f'/api/media/{owner_id}/{quote(filename, safe="")}'}
    own_decks = db.query(Deck.id).filter(Deck.user_id == viewer_id)
    found = or_(*[func.instr(column, needle) > 0 for needle in needles for column in (Card.front, Card.back)])
    return db.query(Card.id).filter(Card.deck_id.in_(own_decks), found).first() is not None


@router.get('/{owner_id}/{filename}')
def media_file(owner_id: int, filename: str, request: Request, db: Session = Depends(get_db)):
    viewer = media_user_id(request, db)
    if viewer is None:
        raise HTTPException(401, 'Sign in to load media')
    if os.path.basename(filename) != filename or filename.startswith('.') or '\\' in filename:
        raise HTTPException(404, 'Not found')
    folder = os.path.realpath(get_media_dir(owner_id))
    path = os.path.realpath(os.path.join(folder, filename))
    if os.path.dirname(path) != folder or not os.path.isfile(path):
        raise HTTPException(404, 'Not found')
    # Another account's file is as good as missing, so ids and names cannot be probed.
    if viewer != owner_id and not _referenced_by_own_card(db, viewer, owner_id, filename):
        raise HTTPException(404, 'Not found')
    media_type = mimetypes.guess_type(filename)[0] or 'application/octet-stream'
    return FileResponse(path, media_type=media_type, headers={
        'Cache-Control': 'private, max-age=3600',
        # Opened directly, an SVG or HTML file must not run as a page of this site.
        'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    })
