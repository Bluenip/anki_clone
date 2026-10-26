"""Incremental device snapshots and idempotent offline review replay.

The server owns scheduling. Offline answers never overwrite a newer version;
conflicts remain on the device until the user resolves them.
"""
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, ConfigDict
from sqlalchemy.orm import Session
from sqlalchemy import update
from auth import get_current_user
from database import get_db
from models import User, Deck, Card, StudyOperation, StudyProgress
from scheduling import utc
from deck_options import effective_settings
from media_utils import extract_media_filenames, get_media_dir

router = APIRouter(prefix='/api/sync', tags=['Sync'])


def settings_hash(deck):
    return hashlib.sha256(json.dumps(effective_settings(deck), sort_keys=True).encode()).hexdigest()


class Pull(BaseModel):
    deck_id: int
    known: dict[str, str] = Field(default_factory=dict, max_length=100000)
    after_id: int = Field(default=0, ge=0)
    page_size: int = Field(default=1000, ge=1, le=5000)


class OfflineReview(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: str = Field(min_length=16, max_length=100)
    card_id: int = Field(gt=0)
    expected_version: int = Field(ge=0)
    settings_hash: str = Field(pattern=r'^[0-9a-f]{64}$')
    rating: int = Field(ge=1, le=4)
    duration_ms: int = Field(default=0, ge=0, le=3600000)
    reviewed_at: datetime


@router.post('/pull')
def pull(data: Pull, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    root = db.query(Deck).filter_by(id=data.deck_id, user_id=user.id).first()
    if root is None: raise HTTPException(404, 'Deck not found')
    decks = [d for d in db.query(Deck).filter_by(user_id=user.id) if d.id == root.id or d.name.startswith(root.name + '::')]
    from models import SchedulerState
    query = db.query(Card).filter(Card.deck_id.in_([d.id for d in decks]))
    manifest = query.with_entities(Card.id, Card.deck_id, SchedulerState.version).outerjoin(SchedulerState, SchedulerState.card_id == Card.id).order_by(Card.id).all()
    if len(manifest) > 100000: raise HTTPException(422, 'Download subdecks of at most 100000 cards')
    revision = hashlib.sha256(json.dumps([list(map(tuple, manifest)), [(d.id, settings_hash(d)) for d in decks]], sort_keys=True).encode()).hexdigest()
    cards = query.filter(Card.id > data.after_id).order_by(Card.id).limit(data.page_size + 1).all()
    more = len(cards) > data.page_size
    cards = cards[:data.page_size]
    from study_queue import snapshot
    from routers.filtered_router import card_payload
    now = datetime.now(timezone.utc)
    eligible = set(snapshot(db, root, user.id, now)['eligible_ids'])
    updates, versions, media, notes = [], {}, {}, {}
    media_root = Path(get_media_dir(user.id))
    for card in cards:
        if card.note_link:
            from offline_notes import snapshot as note_snapshot
            note = card.note_link.note
            if str(note.id) not in notes: notes[str(note.id)] = note_snapshot(note)
        payload = card_payload(db, card, user.id, now, True)
        from dataclasses import asdict
        from study_queue import config_for
        cfg = config_for(card.deck, now)
        progress = db.query(StudyProgress).filter_by(card_id=card.id, user_id=user.id).first()
        local = {key: getattr(progress, key) for key in ('card_state', 'learning_step', 'interval_days', 'ease_factor', 'repetitions', 'lapse_count', 'is_suspended')} if progress else {'card_state': 'new', 'learning_step': 0, 'interval_days': 0, 'ease_factor': cfg.starting_ease, 'repetitions': 0, 'lapse_count': 0, 'is_suspended': False}
        local['next_review'] = utc(progress.next_review).isoformat() if progress and progress.next_review else None
        if cfg.fsrs:
            from scheduling import fsrs_state
            memory, _ = fsrs_state(db, card, progress, cfg, now)
            local['fsrs_card'] = memory.to_dict()
            if progress is None: local['fsrs_card']['due'] = utc(card.created_at).isoformat()
        payload.update(offline_state=local, offline_config=asdict(cfg))
        payload.update(deck_id=card.deck_id, study_deck_id=root.id, settings_hash=settings_hash(card.deck), eligible=card.id in eligible)
        digest = hashlib.sha256(json.dumps({k: v for k, v in payload.items() if k != 'intervals'}, sort_keys=True, default=str).encode()).hexdigest()
        versions[str(card.id)] = digest
        if data.known.get(str(card.id)) != digest: updates.append(payload)
        for name in set(extract_media_filenames(payload['front'] + payload['back'] + payload['card_css'])):
            path = media_root / name
            if path.name != name or path.is_symlink() or not path.is_file(): continue
            if name not in media:
                media[name] = {'hash': hashlib.sha256(path.read_bytes()).hexdigest(), 'size': path.stat().st_size}
    return {'deck': {'id': root.id, 'name': root.name}, 'server_time': now.isoformat(), 'cards': updates,
            'notes': list(notes.values()), 'versions': versions, 'deleted': sorted(set(data.known) - {str(row[0]) for row in manifest}), 'media': media,
            'next_cursor': cards[-1].id if more else None, 'revision': revision}


@router.post('/review')
def replay(data: OfflineReview, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    from review_service import review
    from schemas import ReviewRequest
    try:
        db.execute(update(User).where(User.id == user.id).values(id=User.id)); db.expire_all()
        previous = db.query(StudyOperation).filter_by(user_id=user.id, request_id=data.request_id).first()
        card = db.query(Card).join(Deck).filter(Card.id == data.card_id, Deck.user_id == user.id).first()
        if card is None: raise HTTPException(409, 'This card was deleted or moved out of your account')
        if not previous:
            now = datetime.now(timezone.utc); when = utc(data.reviewed_at)
            if when > now + timedelta(minutes=5) or when < now - timedelta(days=30): raise HTTPException(422, 'Offline review timestamp must be within the last 30 days')
            if settings_hash(card.deck) != data.settings_hash: raise HTTPException(409, 'Deck settings changed since download; review this conflict before applying')
            progress = next((p for p in card.study_progress if p.user_id == user.id), None)
            if progress and progress.last_reviewed and utc(progress.last_reviewed) > when: raise HTTPException(409, 'A newer review is already saved for this card')
        request = ReviewRequest(rating=data.rating, expected_version=data.expected_version, request_id=data.request_id, duration_ms=data.duration_ms)
        response = review(db, card, user.id, request, now=utc(data.reviewed_at))
        db.commit()
        return response
    except BaseException:
        db.rollback(); raise


from routers.notes_router import NoteFields


class OfflineNoteEdit(NoteFields):
    model_config = ConfigDict(extra='forbid')
    request_id: str = Field(min_length=16, max_length=100)
    note_id: int = Field(gt=0)
    guid: str = Field(min_length=1, max_length=100)
    schema_hash: str = Field(pattern=r'^[0-9a-f]{64}$')
    base_fields: dict[str, str]
    base_tags: list[str] = Field(default_factory=list)

    @classmethod
    def validate_base(cls, data):
        return NoteFields(fields=data.base_fields, tags=data.base_tags)


@router.post('/note')
def sync_note(data: OfflineNoteEdit, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    from models import OfflineNoteReceipt
    from routers.notes_router import owned_note
    from offline_notes import apply_edit
    from pydantic import ValidationError
    try:
        data.validate_base(data)
    except ValidationError:
        raise HTTPException(422, 'Downloaded base fields or tags exceed limits') from None
    digest = hashlib.sha256(data.model_dump_json().encode()).hexdigest()
    try:
        db.execute(update(User).where(User.id == user.id).values(id=User.id)); db.expire_all()
        receipt = db.query(OfflineNoteReceipt).filter_by(user_id=user.id, request_id=data.request_id).first()
        if receipt:
            if receipt.payload_hash != digest: raise HTTPException(409, 'This request ID was used for a different edit')
            result = json.loads(receipt.response_json)
        else:
            result = apply_edit(db, owned_note(db, data.note_id, user.id), data)
            db.add(OfflineNoteReceipt(user_id=user.id, request_id=data.request_id, payload_hash=digest, response_json=json.dumps(result)))
        db.commit()
        return result
    except ValueError as exc:
        db.rollback(); raise HTTPException(400, str(exc)) from None
    except BaseException:
        db.rollback(); raise
