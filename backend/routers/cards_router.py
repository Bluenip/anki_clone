from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from typing import List, Literal
from datetime import datetime, timezone
from pydantic import BaseModel, Field, ConfigDict, field_validator

from database import get_db
from models import User, Deck, Card, StudyProgress, SchedulerState, NoteCard
from schemas import CardCreate, CardUpdate, CardResponse, BrowseCardResponse
from auth import get_current_user
from media_utils import cleanup_orphaned_media
from notes import attach_basic_note, new_guid, sync_basic_note, cleanup_empty_notes

router = APIRouter(prefix="/api", tags=["Cards"])


def verify_deck_ownership(deck_id: int, user_id: int, db: Session) -> Deck:
    deck = db.query(Deck).filter(Deck.id == deck_id, Deck.user_id == user_id).first()
    if not deck:
        raise HTTPException(status_code=404, detail="Deck not found")
    return deck


@router.get("/cards/browse", response_model=List[BrowseCardResponse])
def browse_cards(
    search: str = "",
    offset: int = Query(default=0, ge=0, le=9223372036854775807),
    limit: int = Query(default=1000, ge=1, le=1000),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = (
        db.query(Card, Deck.name.label("deck_name"), StudyProgress.next_review, StudyProgress.interval_days,
                 StudyProgress.card_state, StudyProgress.is_suspended, SchedulerState.version,
                 SchedulerState.buried_until, NoteCard.note_id)
        .join(Deck, Deck.id == Card.deck_id)
        .outerjoin(StudyProgress, (StudyProgress.card_id == Card.id) & (StudyProgress.user_id == current_user.id))
        .outerjoin(SchedulerState, SchedulerState.card_id == Card.id)
        .outerjoin(NoteCard, NoteCard.card_id == Card.id)
        .filter(Deck.user_id == current_user.id)
    )

    from browser_search import compile_search
    from search_fields import field_lookup
    from scheduling import utc
    now = datetime.now(timezone.utc)
    from search_due import due_predicate
    from functools import cache
    @cache
    def due():
        return due_predicate(db, current_user.id, now)
    try:
        query = query.filter(compile_search(search, now, due=due, fields=field_lookup(db, current_user.id, now)))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None

    results = query.order_by(Card.created_at.desc(), Card.id.desc()).offset(offset).limit(limit).all()

    cards = []
    for card, deck_name, next_review, interval_days, card_state, suspended, version, buried_until, note_id in results:
        cards.append({
            "id": card.id,
            "deck_id": card.deck_id,
            "front": card.front,
            "back": card.back,
            "created_at": card.created_at,
            "updated_at": card.updated_at,
            "deck_name": deck_name,
            "next_review": next_review,
            "interval_days": interval_days,
            "card_state": card_state or "new",
            "is_suspended": bool(suspended),
            "version": version or 0,
            "is_buried": bool(buried_until and utc(buried_until) > now),
            "note_id": note_id,
        })
    
    return cards


class BulkCardTarget(BaseModel):
    model_config = ConfigDict(extra='forbid')
    card_id: int = Field(gt=0, le=9223372036854775807, strict=True)
    expected_version: int = Field(ge=0, strict=True)


class BulkCardAction(BaseModel):
    model_config = ConfigDict(extra='forbid')
    action: Literal['suspend', 'unsuspend', 'bury', 'unbury', 'move', 'add_tags', 'remove_tags', 'flag', 'delete', 'reset', 'reschedule']
    cards: List[BulkCardTarget] = Field(min_length=1, max_length=500)
    target_deck_id: int | None = Field(default=None, gt=0, le=9223372036854775807, strict=True)
    due_days: int | None = Field(default=None, ge=0, le=36500, strict=True)
    flag: int | None = Field(default=None, ge=0, le=7, strict=True)
    tags: List[str] | None = Field(default=None, min_length=1, max_length=100)

    @field_validator('tags')
    @classmethod
    def validate_tags(cls, tags):
        if tags is None:
            return tags
        if any(not tag or len(tag) > 100 or any(char.isspace() for char in tag) for tag in tags):
            raise ValueError('Tags must be nonempty names without whitespace (maximum 100 characters)')
        unique = {}
        for tag in tags:
            unique.setdefault(tag.casefold(), tag)
        return list(unique.values())



@router.post('/cards/bulk-action')
def bulk_card_action(data: BulkCardAction, current_user: User = Depends(get_current_user),
                     db: Session = Depends(get_db)):
    from review_service import state_for, claim_version
    from scheduling import next_study_day
    from study_queue import config_for
    if (data.action == 'reschedule') != (data.due_days is not None):
        raise HTTPException(422, 'due_days is required only for reschedule')
    if (data.action == 'flag') != (data.flag is not None):
        raise HTTPException(422, 'A flag color is required only for flag actions')
    if (data.action in ('add_tags', 'remove_tags')) != (data.tags is not None):
        raise HTTPException(status_code=422, detail='Tags are required only for add_tags/remove_tags')
    if (data.action == 'move') != (data.target_deck_id is not None):
        raise HTTPException(status_code=422, detail='A destination deck is required only for move')
    if data.target_deck_id is not None:
        verify_deck_ownership(data.target_deck_id, current_user.id, db)
    expected = {item.card_id: item.expected_version for item in data.cards}
    if len(expected) != len(data.cards):
        raise HTTPException(status_code=422, detail='Duplicate card IDs in batch')
    cards = db.query(Card).join(Deck).filter(Deck.user_id == current_user.id,
                Card.id.in_(expected)).order_by(Card.id).all()
    if len(cards) != len(expected):
        raise HTTPException(status_code=404, detail='One or more cards were not found')
    now = datetime.now(timezone.utc)
    try:
        from bulk_history import begin, record
        before = begin(db, current_user.id)
        cards = db.query(Card).join(Deck).filter(Deck.user_id == current_user.id, Card.id.in_(expected)).order_by(Card.id).all()
        if len(cards) != len(expected): raise HTTPException(404, 'One or more cards were removed')
        if data.action in ('add_tags', 'remove_tags'):
            from bulk_note_tags import change_tags
            result = change_tags(db, cards, expected, current_user.id, data.action, data.tags)
            record(db, current_user.id, data.action, before)
            db.commit()
            return result
        for card in cards:
            state = state_for(db, card)
            claim_version(db, state, expected[card.id])
            if data.action in ('delete', 'reset', 'reschedule'):
                if card.filtered_item:
                    raise HTTPException(409, 'Empty the custom study session before changing these cards')
                if data.action == 'delete':
                    db.delete(card)
                    continue
                progress = db.query(StudyProgress).filter_by(card_id=card.id, user_id=current_user.id).first()
                if data.action == 'reset':
                    if progress is not None: db.delete(progress)
                    state.fsrs_json = None; state.buried_until = None
                    # A non-answer event preserves statistics but starts a fresh
                    # memory history, including after a later SM-2/FSRS switch.
                    from models import ReviewLog, ReviewRecord
                    import json
                    event = ReviewLog(user_id=current_user.id, card_id=card.id, rating=0, was_new=False, review_date=now)
                    event.record = ReviewRecord(payload=json.dumps({'kind': 'reset', 'anki': {'type': 4, 'ivl': 0, 'lastIvl': 0, 'time': 0}}))
                    db.add(event)
                else:
                    if progress is None:
                        progress = StudyProgress(card_id=card.id, user_id=current_user.id, ease_factor=config_for(card.deck).starting_ease)
                        db.add(progress)
                    progress.card_state = 'review'; progress.learning_step = 0
                    progress.interval_days = max(1, data.due_days)
                    progress.next_review = next_study_day(now, config_for(card.deck), data.due_days)
                    state.buried_until = None
                    if state.fsrs_json:
                        import json
                        memory = json.loads(state.fsrs_json)
                        memory['card']['due'] = progress.next_review.isoformat()
                        state.fsrs_json = json.dumps(memory)
            elif data.action == 'move':
                card.deck_id = data.target_deck_id
            elif data.action == 'flag':
                from models import PackageCard
                import json
                metadata = json.loads(card.package_data.payload) if card.package_data else {}
                metadata['flags'] = (int(metadata.get('flags', 0)) & ~7) | data.flag
                if card.package_data:
                    card.package_data.payload = json.dumps(metadata)
                else:
                    card.package_data = PackageCard(payload=json.dumps(metadata))
            elif data.action in ('bury', 'unbury'):
                state.buried_until = next_study_day(now, config_for(card.deck)) if data.action == 'bury' else None
            else:
                progress = db.query(StudyProgress).filter_by(card_id=card.id, user_id=current_user.id).first()
                if progress is None:
                    progress = StudyProgress(card_id=card.id, user_id=current_user.id,
                                             ease_factor=config_for(card.deck).starting_ease)
                    db.add(progress)
                progress.is_suspended = data.action == 'suspend'
        cleanup_empty_notes(db, current_user.id)
        record(db, current_user.id, data.action, before)
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except Exception:
        db.rollback()
        raise
    return {'updated': len(cards)}


@router.get("/decks/{deck_id}/cards", response_model=List[CardResponse])
def list_cards(
    deck_id: int,
    search: str = "",
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    verify_deck_ownership(deck_id, current_user.id, db)

    query = db.query(Card).filter(Card.deck_id == deck_id)
    if search:
        query = query.filter(
            (Card.front.ilike(f"%{search}%")) | (Card.back.ilike(f"%{search}%"))
        )
    return query.order_by(Card.created_at.desc()).all()


@router.post(
    "/decks/{deck_id}/cards",
    response_model=CardResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_card(
    deck_id: int,
    data: CardCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    verify_deck_ownership(deck_id, current_user.id, db)

    card = Card(deck_id=deck_id, front=data.front, back=data.back)
    db.add(card)
    attach_basic_note(db, card, current_user.id, guid=new_guid())
    db.commit()
    db.refresh(card)
    return card


@router.put("/cards/{card_id}", response_model=CardResponse)
def update_card(
    card_id: int,
    data: CardUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    card = db.query(Card).filter(Card.id == card_id).first()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")

    # Verify deck ownership
    verify_deck_ownership(card.deck_id, current_user.id, db)

    if data.front is not None:
        card.front = data.front
    if data.back is not None:
        card.back = data.back

    try:
        sync_basic_note(db, card, current_user.id, data.expected_version)
    except HTTPException:
        db.rollback()
        raise
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from None

    db.commit()
    db.refresh(card)
    return card


@router.delete("/cards/{card_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_card(
    card_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    card = db.query(Card).filter(Card.id == card_id).first()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")

    verify_deck_ownership(card.deck_id, current_user.id, db)

    db.delete(card)
    cleanup_empty_notes(db, current_user.id)
    db.commit()

    # After DB delete, remove any orphaned media files from disk
    cleanup_orphaned_media(current_user.id, db)



@router.post('/cards/bulk-undo')
def undo_bulk(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    from bulk_history import undo
    try:
        return undo(db, current_user.id)
    except Exception:
        db.rollback(); raise
