from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, sessionmaker

from auth import get_current_user
from database import get_db
from models import Deck, User
import tts_service

router = APIRouter(prefix='/api', tags=['Text-to-speech'])


def _owned_deck(db, user, deck_id):
    deck = db.query(Deck).filter_by(id=deck_id, user_id=user.id).first()
    if deck is None:
        raise HTTPException(status_code=404, detail='Deck not found')
    return deck


def session_factory_for(db: Session):
    """Background work uses the same database as the request (also in tests)."""
    return sessionmaker(autocommit=False, autoflush=False, bind=db.get_bind())


@router.get('/tts/status')
def tts_status(user: User = Depends(get_current_user)):
    return {'enabled': tts_service.enabled(), 'engine': 'kokoro', 'voice': tts_service.voice_name()}


@router.get('/decks/{deck_id}/tts/summary')
def deck_tts_summary(deck_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Words still using the old Piper voice, and notes whose generated audio says a word changed since."""
    deck = _owned_deck(db, user, deck_id)
    return {'piper_words': len(tts_service.upgrade_targets(db, deck)), 'stale_notes': len(tts_service.stale_notes(db, deck))}


@router.get('/decks/{deck_id}/tts')
def deck_tts_job(deck_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _owned_deck(db, user, deck_id)
    job = tts_service.job_for(user.id, deck_id)
    return job.public() if job else {'state': 'idle'}


@router.post('/decks/{deck_id}/tts', status_code=202)
def start_deck_tts(deck_id: int, mode: Literal['fill', 'upgrade', 'fix'] = 'fill',
                   db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _owned_deck(db, user, deck_id)
    if not tts_service.enabled():
        raise HTTPException(status_code=503, detail='Audio generation is not configured on this server (TTS_URL)')
    return tts_service.start_job(user.id, deck_id, session_factory_for(db), mode).public()


@router.post('/decks/{deck_id}/tts/cancel')
def cancel_deck_tts(deck_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _owned_deck(db, user, deck_id)
    job = tts_service.job_for(user.id, deck_id)
    if job and job.state in tts_service.ACTIVE_STATES:
        job.cancel.set()
        if job.state != 'stopped':
            job.state = 'stopping'  # one word may still be in flight; the job stops right after it
    return job.public() if job else {'state': 'idle'}
