from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func
from datetime import datetime, timedelta, timezone
from typing import Optional
import json
from pydantic import BaseModel, Field
from typing import Literal

from database import get_db
from models import User, Deck, Card, StudyProgress, ReviewLog
from schemas import ReviewRequest, StudyCardResponse, StudyStatsResponse, ReviewResponse
from auth import get_current_user
from sm2 import (
    sm2_algorithm, get_next_intervals, parse_steps,
    parse_settings_to_config, DeckSchedulingConfig,
    get_interval_display, learning_hard_seconds,
)

router = APIRouter(prefix="/api/study", tags=["Study"])


def _load_deck_config(deck: Deck) -> DeckSchedulingConfig:
    """Load deck settings and return a DeckSchedulingConfig."""
    from study_queue import config_for
    return config_for(deck)


def _start_of_today() -> datetime:
    """Return the start of today in UTC."""
    return datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)


def _start_of_target_day(now: datetime, days: int) -> datetime:
    """Return the start of the target day in UTC."""
    return (now + timedelta(days=days)).replace(hour=0, minute=0, second=0, microsecond=0)


def _count_studied_today(db: Session, deck_id: int, user_id: int):
    """Count new and review cards studied today."""
    sot = _start_of_today()
    
    new_studied = db.query(ReviewLog).join(Card, Card.id == ReviewLog.card_id).filter(
        Card.deck_id == deck_id, ReviewLog.user_id == user_id,
        ReviewLog.was_new == True, ReviewLog.rating.in_([1,2,3,4]), ReviewLog.review_date >= sot
    ).count()
    
    rev_studied = db.query(ReviewLog).join(Card, Card.id == ReviewLog.card_id).filter(
        Card.deck_id == deck_id, ReviewLog.user_id == user_id,
        ReviewLog.was_new == False, ReviewLog.rating.in_([1,2,3,4]), ReviewLog.review_date >= sot
    ).count()
    
    return new_studied, rev_studied


@router.get('/summary/today')
def today_summary(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    from scheduling import study_day, utc
    now = datetime.now(timezone.utc)
    decks = db.query(Deck).filter_by(user_id=current_user.id).all()
    starts = {deck.id: study_day(now, _load_deck_config(deck)) for deck in decks}
    if not starts:
        return {'reviews': 0, 'seconds': 0, 'seconds_per_card': 0}
    logs = db.query(ReviewLog).join(Card).filter(
        ReviewLog.user_id == current_user.id, Card.deck_id.in_(starts),
        ReviewLog.review_date >= min(starts.values()), ReviewLog.rating.in_([1,2,3,4])).all()
    count = duration = 0
    for log in logs:
        if utc(log.review_date) < starts[log.card.deck_id]:
            continue
        count += 1
        payload = json.loads(log.record.payload) if log.record else {}
        duration += payload.get('duration_ms', 0)
    seconds = round(duration / 1000, 1)
    return {'reviews': count, 'seconds': seconds, 'seconds_per_card': round(seconds/count, 1) if count else 0}


@router.get("/{deck_id}", response_model=Optional[StudyCardResponse])
def get_next_study_card(
    deck_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get the next card to study from a deck."""
    deck = (
        db.query(Deck)
        .filter(Deck.id == deck_id, Deck.user_id == current_user.id)
        .first()
    )
    if not deck:
        raise HTTPException(status_code=404, detail="Deck not found")

    from study_queue import snapshot, config_for
    from scheduling import fsrs_preview
    from note_rendering import css_for_web, media_for_web, render_cards
    from deck_options import effective_settings
    view = snapshot(db, deck, current_user.id, datetime.now(timezone.utc))
    card = view['card']
    if card is None:
        return None
    progress = view['progress'].get(card.id)
    config = config_for(card.deck)
    now = datetime.now(timezone.utc)
    intervals = fsrs_preview(db, card, progress, config, now) if config.fsrs else get_next_intervals(
        progress.repetitions if progress else 0, progress.ease_factor if progress else config.starting_ease,
        progress.interval_days if progress else 0, config=config,
        card_state=progress.card_state if progress else 'new', learning_step=progress.learning_step if progress else 0)
    if not config.fsrs:
        from load_balancing import adjust_preview
        intervals = adjust_preview(db, card, progress, config, now, intervals)
    rendered=bool(card.note_link and card.note_link.note.package_data and json.loads(card.note_link.note.package_data.payload).get('_web_rendered'))
    front,back=media_for_web(card.front,current_user.id),media_for_web(card.back,current_user.id)
    if rendered:
        note=card.note_link.note
        faces=render_cards(note.note_type,json.loads(note.fields_json),current_user.id,json.loads(note.tags_json),card.deck.name)
        if card.note_link.template_ord not in faces:
            raise HTTPException(status_code=409,detail='This card has an empty or changed template; inspect its note before studying')
        front,back=faces[card.note_link.template_ord]
    return {'card_id':card.id,'front':front,'back':back,'deck_name':card.deck.name,
            'is_new':progress is None or progress.card_state=='new', 'card_state':progress.card_state if progress else 'new',
            'learning_step':progress.learning_step if progress else 0, 'intervals':intervals,
            'version':card.scheduling.version if card.scheduling else 0,
            'note_id':card.note_link.note_id if card.note_link else None,
            'card_css':css_for_web(card.note_link.note.note_type.css, current_user.id) if card.note_link else '',
            'rendered':rendered,
            'settings':effective_settings(card.deck)}


@router.post("/{card_id}/review", response_model=ReviewResponse)
def review_card(
    card_id: int,
    data: ReviewRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Submit a review rating for a card."""
    if data.rating not in (1, 2, 3, 4):
        raise HTTPException(status_code=400, detail="Rating must be 1-4")

    # P0.2: Kiểm tra card tồn tại VÀ thuộc deck của user hiện tại
    card = (
        db.query(Card)
        .join(Deck, Deck.id == Card.deck_id)
        .filter(Card.id == card_id, Deck.user_id == current_user.id)
        .first()
    )
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")

    from review_service import review
    try:
        return review(db,card,current_user.id,data)
    except HTTPException:
        db.rollback()
        raise
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400,detail=str(exc)) from None


@router.post('/undo/latest')
def undo_review(db: Session=Depends(get_db), current_user: User=Depends(get_current_user)):
    from review_service import undo
    try:
        return undo(db,current_user.id)
    except HTTPException:
        db.rollback()
        raise


class StudyActionRequest(BaseModel):
    action: Literal['bury', 'suspend', 'unbury', 'unsuspend']
    expected_version: Optional[int] = Field(default=None, ge=0)


@router.post('/{card_id}/action')
def study_action(card_id: int, data: StudyActionRequest,
                 db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    from review_service import state_for, claim_version
    from scheduling import next_study_day
    card = db.query(Card).join(Deck).filter(Card.id == card_id, Deck.user_id == current_user.id).first()
    if card is None:
        raise HTTPException(status_code=404, detail='Card not found')
    try:
        state = state_for(db, card)
        claim_version(db, state, data.expected_version)
        if data.action in ('bury', 'unbury'):
            state.buried_until = next_study_day(datetime.now(timezone.utc), _load_deck_config(card.deck)) if data.action == 'bury' else None
        else:
            progress = db.query(StudyProgress).filter_by(card_id=card_id, user_id=current_user.id).first()
            if progress is None:
                progress = StudyProgress(card_id=card_id, user_id=current_user.id)
                db.add(progress)
            progress.is_suspended = data.action == 'suspend'
        db.commit()
        return {'card_id': card_id, 'version': state.version, 'action': data.action}
    except HTTPException:
        db.rollback()
        raise


def _handle_learning(progress: StudyProgress, rating: int, config: DeckSchedulingConfig, now: datetime):
    """
    Handle a review for a card in 'new' or 'learning' state.
    Implements multi-step learning: e.g. 1m → 10m → graduated.
    """
    steps = parse_steps(config.learning_steps)

    if not steps:
        # No learning steps — graduate immediately
        progress.card_state = "review"
        progress.learning_step = 0
        result = sm2_algorithm(rating, 0, progress.ease_factor, 0, config)
        progress.ease_factor = result.ease_factor
        progress.interval_days = max(result.interval_days, config.graduating_interval)
        progress.repetitions = result.repetitions
        progress.next_review = _start_of_target_day(now, progress.interval_days)
        return

    # Card enters learning on first review
    if progress.card_state == "new":
        progress.card_state = "learning"

    if rating == 1:
        # Again → back to step 0
        progress.learning_step = 0
        progress.next_review = now + timedelta(seconds=steps[0])

    elif rating == 2:
        # Hard → repeat current step (or slightly longer)
        current_step = min(progress.learning_step, len(steps) - 1)
        step_time = learning_hard_seconds(steps, current_step)
        progress.next_review = now + timedelta(seconds=step_time)

    elif rating == 3:
        # Good → advance to next step
        progress.learning_step += 1
        if progress.learning_step >= len(steps):
            # Graduate!
            _graduate(progress, config, now, use_easy_interval=False)
            return
        else:
            progress.next_review = now + timedelta(seconds=steps[progress.learning_step])

    elif rating == 4:
        # Easy → graduate immediately with easy_interval
        _graduate(progress, config, now, use_easy_interval=True)
        return


def _graduate(progress: StudyProgress, config: DeckSchedulingConfig, now: datetime, use_easy_interval: bool):
    """Graduate a card from learning to review state."""
    progress.card_state = "review"
    progress.learning_step = 0

    if use_easy_interval:
        progress.interval_days = config.easy_interval
    else:
        progress.interval_days = config.graduating_interval

    progress.interval_days = min(progress.interval_days, config.maximum_interval)
    progress.repetitions = 1
    progress.next_review = _start_of_target_day(now, progress.interval_days)


def _handle_review(progress: StudyProgress, rating: int, config: DeckSchedulingConfig, now: datetime):
    """Handle a review for a card in 'review' state (not a lapse)."""
    result = sm2_algorithm(
        rating=rating,
        repetitions=progress.repetitions,
        ease_factor=progress.ease_factor,
        interval_days=progress.interval_days,
        config=config,
    )

    progress.ease_factor = result.ease_factor
    progress.interval_days = result.interval_days
    progress.repetitions = result.repetitions
    progress.next_review = _start_of_target_day(now, result.interval_days)


def _handle_lapse(progress: StudyProgress, config: DeckSchedulingConfig, now: datetime):
    """Handle a lapse (rating=1 on a review card) → enter relearning."""
    # Update ease factor (it still drops on Again)
    quality = 0  # Again = quality 0 in SM-2
    new_ease = progress.ease_factor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
    progress.ease_factor = max(round(new_ease, 2), 1.3)

    # Increment lapse count
    progress.lapse_count += 1

    # Check leech
    if progress.lapse_count >= config.leech_threshold:
        progress.is_leech = True
        if config.leech_action == "Suspend Card":
            progress.is_suspended = True

    # Enter relearning
    relearn_steps = parse_steps(config.relearning_steps)

    if relearn_steps:
        progress.card_state = "relearning"
        progress.learning_step = 0
        progress.next_review = now + timedelta(seconds=relearn_steps[0])
    else:
        # No relearning steps — stay in review with reduced interval
        progress.card_state = "review"
        new_ivl = max(int(progress.interval_days * config.new_interval), config.minimum_interval)
        new_ivl = min(new_ivl, config.maximum_interval)
        progress.interval_days = new_ivl
        progress.repetitions = 0
        progress.next_review = _start_of_target_day(now, new_ivl)


def _handle_relearning(progress: StudyProgress, rating: int, config: DeckSchedulingConfig, now: datetime):
    """Handle a review for a card in 'relearning' state."""
    steps = parse_steps(config.relearning_steps)

    if not steps:
        # No steps — graduate back to review immediately
        _graduate_from_relearning(progress, config, now)
        return

    if rating == 1:
        # Again → back to step 0
        progress.learning_step = 0
        progress.next_review = now + timedelta(seconds=steps[0])

    elif rating == 2:
        # Hard → repeat current step
        current_step = min(progress.learning_step, len(steps) - 1)
        progress.next_review = now + timedelta(seconds=learning_hard_seconds(steps, current_step))

    elif rating == 3:
        # Good → advance to next step
        progress.learning_step += 1
        if progress.learning_step >= len(steps):
            _graduate_from_relearning(progress, config, now)
            return
        else:
            progress.next_review = now + timedelta(seconds=steps[progress.learning_step])

    elif rating == 4:
        # Easy → graduate immediately
        _graduate_from_relearning(progress, config, now)
        return


def _graduate_from_relearning(progress: StudyProgress, config: DeckSchedulingConfig, now: datetime):
    """Graduate a card from relearning back to review state."""
    progress.card_state = "review"
    progress.learning_step = 0

    # New interval after lapse
    new_ivl = max(int(progress.interval_days * config.new_interval), config.minimum_interval)
    new_ivl = min(new_ivl, config.maximum_interval)
    progress.interval_days = new_ivl
    progress.repetitions = 0
    progress.next_review = _start_of_target_day(now, new_ivl)


@router.get("/{deck_id}/stats", response_model=StudyStatsResponse)
def get_study_stats(
    deck_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get study statistics for a deck."""
    deck = (
        db.query(Deck)
        .filter(Deck.id == deck_id, Deck.user_id == current_user.id)
        .first()
    )
    if not deck:
        raise HTTPException(status_code=404, detail="Deck not found")

    from study_queue import snapshot
    from scheduling import study_day
    from zoneinfo import ZoneInfo
    view=snapshot(db,deck,current_user.id,datetime.now(timezone.utc))
    progress=list(view['progress'].values())
    ease=sum(p.ease_factor for p in progress)/len(progress) if progress else view['config'].starting_ease
    dates={study_day(date,view['config']).astimezone(ZoneInfo(view['config'].timezone)).date()
           for (date,) in db.query(ReviewLog.review_date).filter(ReviewLog.user_id==current_user.id,ReviewLog.card_id.in_([c.id for c in view['cards']]))}
    today=study_day(datetime.now(timezone.utc),view['config']).astimezone(ZoneInfo(view['config'].timezone)).date()
    day=today if today in dates else today-timedelta(days=1)
    streak=0
    while day in dates:
        streak+=1
        day-=timedelta(days=1)
    return StudyStatsResponse(total_cards=len(view['cards']),new_cards=view['new_cards'],learn_cards=view['learn_cards'],
        due_cards=view['due_cards'],learned_cards=sum(1 for p in progress if p.card_state=='review'),avg_ease=round(ease,2),
        streak_days=streak,next_learning_at=view['next_learning_at'])
