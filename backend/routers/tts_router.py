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
    return {'enabled': tts_service.enabled(), 'gemini': bool(tts_service.api_key()), 'piper': tts_service.piper_available(),
            'model': tts_service.model_name(), 'voice': tts_service.voice_name()}


@router.get('/decks/{deck_id}/tts/summary')
def deck_tts_summary(deck_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """How many words in the deck still use the offline Piper voice (and can be upgraded)."""
    deck = _owned_deck(db, user, deck_id)
    return {'piper_words': len(tts_service._upgrade_targets(db, deck))}


@router.get('/decks/{deck_id}/tts')
def deck_tts_job(deck_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _owned_deck(db, user, deck_id)
    job = tts_service.job_for(user.id, deck_id)
    return job.public() if job else {'state': 'idle'}


@router.post('/decks/{deck_id}/tts', status_code=202)
def start_deck_tts(deck_id: int, mode: Literal['fill', 'upgrade'] = 'fill',
                   db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _owned_deck(db, user, deck_id)
    if not tts_service.enabled():
        raise HTTPException(status_code=503, detail='Audio generation is not configured on this server (GEMINI_API_KEY)')
    if mode == 'upgrade' and not tts_service.api_key():
        raise HTTPException(status_code=503, detail='Upgrading to Gemini needs GEMINI_API_KEY on this server')
    return tts_service.start_job(user.id, deck_id, session_factory_for(db), mode).public()


@router.post('/decks/{deck_id}/tts/cancel')
def cancel_deck_tts(deck_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _owned_deck(db, user, deck_id)
    job = tts_service.job_for(user.id, deck_id)
    if job and job.state in tts_service.ACTIVE_STATES:
        job.cancel.set()
        if job.state == 'waiting':
            job.state = 'stopped'  # nothing is mid-write while waiting, so report it at once
    return job.public() if job else {'state': 'idle'}
