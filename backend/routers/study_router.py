from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func
from datetime import datetime, timedelta, timezone
from typing import Optional
import json

from database import get_db
from models import User, Deck, Card, StudyProgress, ReviewLog
from schemas import ReviewRequest, StudyCardResponse, StudyStatsResponse, ReviewResponse
from auth import get_current_user
from sm2 import (
    sm2_algorithm, get_next_intervals, parse_steps,
    parse_settings_to_config, DeckSchedulingConfig,
    get_interval_display,
)

router = APIRouter(prefix="/api/study", tags=["Study"])


def _load_deck_config(deck: Deck) -> DeckSchedulingConfig:
    """Load deck settings and return a DeckSchedulingConfig."""
    settings = {}
    if deck.settings:
        try:
            settings = json.loads(deck.settings)
        except (json.JSONDecodeError, TypeError):
            pass
    return parse_settings_to_config(settings)


def _start_of_today() -> datetime:
    """Return the start of today in UTC."""
    return datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)


def _count_studied_today(db: Session, deck_id: int, user_id: int):
    """Count new and review cards studied today."""
    sot = _start_of_today()
    
    new_studied = db.query(ReviewLog).join(Card, Card.id == ReviewLog.card_id).filter(
        Card.deck_id == deck_id, ReviewLog.user_id == user_id,
        ReviewLog.was_new == True, ReviewLog.review_date >= sot
    ).count()
    
    rev_studied = db.query(ReviewLog).join(Card, Card.id == ReviewLog.card_id).filter(
        Card.deck_id == deck_id, ReviewLog.user_id == user_id,
        ReviewLog.was_new == False, ReviewLog.review_date >= sot
    ).count()
    
    return new_studied, rev_studied


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

    config = _load_deck_config(deck)
    now = datetime.now(timezone.utc)

    new_studied_today, rev_studied_today = _count_studied_today(db, deck_id, current_user.id)
    remaining_new_limit = max(0, config.new_cards_per_day - new_studied_today)
    remaining_rev_limit = max(0, config.maximum_reviews_per_day - rev_studied_today)

    # ── Priority 1: Learning/relearning cards that are due ──
    # These always take priority (like Anki), and don't count against review limit
    learning_due = (
        db.query(StudyProgress)
        .join(Card, Card.id == StudyProgress.card_id)
        .filter(
            Card.deck_id == deck_id,
            StudyProgress.user_id == current_user.id,
            StudyProgress.is_suspended == False,
            StudyProgress.card_state.in_(["learning", "relearning"]),
            StudyProgress.next_review <= now,
        )
        .order_by(StudyProgress.next_review.asc())
        .first()
    )

    if learning_due:
        card = db.query(Card).filter(Card.id == learning_due.card_id).first()
        intervals = get_next_intervals(
            learning_due.repetitions, learning_due.ease_factor, learning_due.interval_days,
            config=config, card_state=learning_due.card_state, learning_step=learning_due.learning_step,
        )
        return {
            "card_id": card.id,
            "front": card.front,
            "back": card.back,
            "deck_name": deck.name,
            "is_new": False,
            "card_state": learning_due.card_state,
            "learning_step": learning_due.learning_step,
            "intervals": intervals,
        }

    # ── Priority 2: Review cards that are due ──
    if remaining_rev_limit > 0:
        due_review = (
            db.query(StudyProgress)
            .join(Card, Card.id == StudyProgress.card_id)
            .filter(
                Card.deck_id == deck_id,
                StudyProgress.user_id == current_user.id,
                StudyProgress.is_suspended == False,
                StudyProgress.card_state == "review",
                StudyProgress.next_review <= now,
            )
            .order_by(StudyProgress.next_review.asc())
            .first()
        )

        if due_review:
            card = db.query(Card).filter(Card.id == due_review.card_id).first()
            intervals = get_next_intervals(
                due_review.repetitions, due_review.ease_factor, due_review.interval_days,
                config=config, card_state="review", learning_step=0,
            )
            return {
                "card_id": card.id,
                "front": card.front,
                "back": card.back,
                "deck_name": deck.name,
                "is_new": False,
                "card_state": "review",
                "learning_step": 0,
                "intervals": intervals,
            }

    # ── Priority 3: New cards ──
    if remaining_new_limit > 0:
        studied_card_ids = (
            db.query(StudyProgress.card_id)
            .join(Card, Card.id == StudyProgress.card_id)
            .filter(
                Card.deck_id == deck_id,
                StudyProgress.user_id == current_user.id,
            )
        )
        new_card = (
            db.query(Card)
            .filter(Card.deck_id == deck_id, ~Card.id.in_(studied_card_ids))
            .order_by(Card.created_at.asc())
            .first()
        )

        if new_card:
            intervals = get_next_intervals(
                0, config.starting_ease, 0,
                config=config, card_state="new", learning_step=0,
            )
            return {
                "card_id": new_card.id,
                "front": new_card.front,
                "back": new_card.back,
                "deck_name": deck.name,
                "is_new": True,
                "card_state": "new",
                "learning_step": 0,
                "intervals": intervals,
            }

    # ── Priority 4: Learning cards not yet due (fallback) ──
    # Prevents user from being stuck if they pressed Again and have nothing else
    learning_not_due = (
        db.query(StudyProgress)
        .join(Card, Card.id == StudyProgress.card_id)
        .filter(
            Card.deck_id == deck_id,
            StudyProgress.user_id == current_user.id,
            StudyProgress.is_suspended == False,
            StudyProgress.card_state.in_(["learning", "relearning"]),
        )
        .order_by(StudyProgress.next_review.asc())
        .first()
    )

    if learning_not_due:
        card = db.query(Card).filter(Card.id == learning_not_due.card_id).first()
        intervals = get_next_intervals(
            learning_not_due.repetitions, learning_not_due.ease_factor,
            learning_not_due.interval_days, config=config,
            card_state=learning_not_due.card_state, learning_step=learning_not_due.learning_step,
        )
        return {
            "card_id": card.id,
            "front": card.front,
            "back": card.back,
            "deck_name": deck.name,
            "is_new": False,
            "card_state": learning_not_due.card_state,
            "learning_step": learning_not_due.learning_step,
            "intervals": intervals,
        }

    return None  # No cards to study


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

    card = db.query(Card).filter(Card.id == card_id).first()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")

    # Load deck config
    deck = db.query(Deck).filter(Deck.id == card.deck_id).first()
    config = _load_deck_config(deck)

    # Get or create study progress
    progress = (
        db.query(StudyProgress)
        .filter(
            StudyProgress.card_id == card_id,
            StudyProgress.user_id == current_user.id,
        )
        .first()
    )

    was_new = False

    if not progress:
        progress = StudyProgress(
            user_id=current_user.id,
            card_id=card_id,
            ease_factor=config.starting_ease,
            interval_days=0,
            repetitions=0,
            card_state="new",
            learning_step=0,
            lapse_count=0,
        )
        db.add(progress)
        was_new = True
    else:
        was_new = progress.card_state == "new"

    now = datetime.now(timezone.utc)
    is_leech = False

    # ── Handle based on current card state ──

    if progress.card_state in ("new", "learning"):
        _handle_learning(progress, data.rating, config, now)

    elif progress.card_state == "relearning":
        _handle_relearning(progress, data.rating, config, now)

    elif progress.card_state == "review":
        if data.rating == 1:
            # Lapse! Enter relearning
            _handle_lapse(progress, config, now)
            is_leech = progress.is_leech
        else:
            # Normal review
            _handle_review(progress, data.rating, config, now)

    else:
        # Unknown state — treat as review
        _handle_review(progress, data.rating, config, now)

    progress.last_reviewed = now

    # Log the review
    review_log = ReviewLog(
        user_id=current_user.id,
        card_id=card_id,
        rating=data.rating,
        was_new=was_new,
        review_date=now,
    )
    db.add(review_log)

    db.commit()
    db.refresh(progress)

    rating_labels = {1: "Again", 2: "Hard", 3: "Good", 4: "Easy"}
    
    # Build message
    if progress.card_state in ("learning", "relearning"):
        msg = f"Rated '{rating_labels[data.rating]}'. Card is in {progress.card_state}."
    else:
        msg = f"Rated '{rating_labels[data.rating]}'. Next review in {progress.interval_days} day(s)."

    if is_leech:
        msg += " ⚠️ This card is a leech!"

    return ReviewResponse(
        next_review=progress.next_review,
        interval_days=progress.interval_days,
        ease_factor=progress.ease_factor,
        message=msg,
        card_state=progress.card_state,
        is_leech=is_leech,
        lapse_count=progress.lapse_count,
    )


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
        progress.next_review = now + timedelta(days=progress.interval_days)
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
        step_time = steps[current_step]
        # Anki gives 50% between current and next for Hard during learning
        if current_step + 1 < len(steps):
            next_time = steps[current_step + 1]
            step_time = (step_time + next_time) // 2
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
    progress.next_review = now + timedelta(days=progress.interval_days)


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
    progress.next_review = now + timedelta(days=result.interval_days)


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
        progress.next_review = now + timedelta(days=new_ivl)


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
        progress.next_review = now + timedelta(seconds=steps[current_step])

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
    progress.next_review = now + timedelta(days=new_ivl)


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

    config = _load_deck_config(deck)
    now = datetime.now(timezone.utc)
    total_cards = db.query(Card).filter(Card.deck_id == deck_id).count()

    # Cards never studied
    studied_card_ids = (
        db.query(StudyProgress.card_id)
        .join(Card, Card.id == StudyProgress.card_id)
        .filter(
            Card.deck_id == deck_id,
            StudyProgress.user_id == current_user.id,
        )
    )

    new_cards = (
        db.query(Card)
        .filter(Card.deck_id == deck_id, ~Card.id.in_(studied_card_ids))
        .count()
    )

    # Due review cards
    due_cards = (
        db.query(StudyProgress)
        .join(Card, Card.id == StudyProgress.card_id)
        .filter(
            Card.deck_id == deck_id,
            StudyProgress.user_id == current_user.id,
            StudyProgress.card_state == "review",
            StudyProgress.is_suspended == False,
            StudyProgress.next_review <= now,
        )
        .count()
    )

    # Learning + relearning cards
    learn_cards = (
        db.query(StudyProgress)
        .join(Card, Card.id == StudyProgress.card_id)
        .filter(
            Card.deck_id == deck_id,
            StudyProgress.user_id == current_user.id,
            StudyProgress.is_suspended == False,
            StudyProgress.card_state.in_(["learning", "relearning"]),
        )
        .count()
    )

    learned_cards = total_cards - new_cards - learn_cards

    # Average ease factor
    avg_ease_result = (
        db.query(func.avg(StudyProgress.ease_factor))
        .join(Card, Card.id == StudyProgress.card_id)
        .filter(
            Card.deck_id == deck_id,
            StudyProgress.user_id == current_user.id,
        )
        .scalar()
    )
    avg_ease = round(avg_ease_result, 2) if avg_ease_result else config.starting_ease

    # Apply daily limits
    new_studied_today, rev_studied_today = _count_studied_today(db, deck_id, current_user.id)
    remaining_new = max(0, config.new_cards_per_day - new_studied_today)
    remaining_rev = max(0, config.maximum_reviews_per_day - rev_studied_today)

    new_cards = min(new_cards, remaining_new)
    due_cards = min(due_cards, remaining_rev)

    return StudyStatsResponse(
        total_cards=total_cards,
        new_cards=new_cards,
        learn_cards=learn_cards,
        due_cards=due_cards,
        learned_cards=learned_cards,
        avg_ease=avg_ease,
    )
