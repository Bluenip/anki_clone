from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func
from datetime import datetime, timedelta, timezone
from typing import Optional

from database import get_db
from models import User, Deck, Card, StudyProgress, ReviewLog
from schemas import ReviewRequest, StudyCardResponse, StudyStatsResponse, ReviewResponse
from auth import get_current_user
from sm2 import sm2_algorithm, get_next_intervals

router = APIRouter(prefix="/api/study", tags=["Study"])


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

    import json
    settings = {}
    if deck.settings:
        try:
            settings = json.loads(deck.settings)
        except:
            pass
            
    new_limit = int(settings.get("new_cards_per_day", 20))
    rev_limit = int(settings.get("maximum_reviews_per_day", 200))

    start_of_today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    
    new_studied_today = db.query(ReviewLog).join(Card, Card.id == ReviewLog.card_id).filter(
        Card.deck_id == deck_id, ReviewLog.user_id == current_user.id,
        ReviewLog.was_new == True, ReviewLog.review_date >= start_of_today
    ).count()
    
    rev_studied_today = db.query(ReviewLog).join(Card, Card.id == ReviewLog.card_id).filter(
        Card.deck_id == deck_id, ReviewLog.user_id == current_user.id,
        ReviewLog.was_new == False, ReviewLog.review_date >= start_of_today
    ).count()

    remaining_new_limit = max(0, new_limit - new_studied_today)
    remaining_rev_limit = max(0, rev_limit - rev_studied_today)

    now = datetime.now(timezone.utc)

    # Priority 1: Cards that are due for review (only if we have review limit remaining)
    if remaining_rev_limit > 0:
        due_progress = (
            db.query(StudyProgress)
            .join(Card, Card.id == StudyProgress.card_id)
            .filter(
                Card.deck_id == deck_id,
                StudyProgress.user_id == current_user.id,
                StudyProgress.next_review <= now,
            )
            .order_by(StudyProgress.next_review.asc())
            .first()
        )

        if due_progress:
            card = db.query(Card).filter(Card.id == due_progress.card_id).first()
            intervals = get_next_intervals(
                due_progress.repetitions, due_progress.ease_factor, due_progress.interval_days
            )
            return {
                "card_id": card.id,
                "front": card.front,
                "back": card.back,
                "deck_name": deck.name,
                "is_new": due_progress.repetitions == 0,
                "intervals": intervals,
            }

    # Priority 2: New cards (never studied) - only if we have new limit remaining
    new_card = None
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
        intervals = get_next_intervals(0, 2.5, 0)
        return {
            "card_id": new_card.id,
            "front": new_card.front,
            "back": new_card.back,
            "deck_name": deck.name,
            "is_new": True,
            "intervals": intervals,
        }

    # Priority 3: Cards in learning phase that are not strictly due yet (fallback if queue is empty)
    # This prevents the user from being locked out if they hit "Again" and have no other cards.
    learning_progress = (
        db.query(StudyProgress)
        .join(Card, Card.id == StudyProgress.card_id)
        .filter(
            Card.deck_id == deck_id,
            StudyProgress.user_id == current_user.id,
            StudyProgress.interval_days == 0,
        )
        .order_by(StudyProgress.next_review.asc())
        .first()
    )

    if learning_progress:
        card = db.query(Card).filter(Card.id == learning_progress.card_id).first()
        intervals = get_next_intervals(
            learning_progress.repetitions, learning_progress.ease_factor, learning_progress.interval_days
        )
        return {
            "card_id": card.id,
            "front": card.front,
            "back": card.back,
            "deck_name": deck.name,
            "is_new": False,
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

    # Get or create study progress
    progress = (
        db.query(StudyProgress)
        .filter(
            StudyProgress.card_id == card_id,
            StudyProgress.user_id == current_user.id,
        )
        .first()
    )

    if not progress:
        progress = StudyProgress(
            user_id=current_user.id,
            card_id=card_id,
            ease_factor=2.5,
            interval_days=0,
            repetitions=0,
        )
        db.add(progress)

    # Apply SM-2 algorithm
    result = sm2_algorithm(
        rating=data.rating,
        repetitions=progress.repetitions,
        ease_factor=progress.ease_factor,
        interval_days=progress.interval_days,
    )

    now = datetime.now(timezone.utc)
    
    # Check if this was a new card before this review
    was_new = progress.repetitions == 0
    
    progress.ease_factor = result.ease_factor
    progress.interval_days = result.interval_days
    progress.repetitions = result.repetitions
    
    if result.interval_days == 0:
        progress.next_review = now + timedelta(minutes=1)
    else:
        progress.next_review = now + timedelta(days=result.interval_days)
        
    progress.last_reviewed = now

    # Log the review
    review_log = ReviewLog(
        user_id=current_user.id,
        card_id=card_id,
        rating=data.rating,
        was_new=was_new,
        review_date=now
    )
    db.add(review_log)

    db.commit()
    db.refresh(progress)

    rating_labels = {1: "Again", 2: "Hard", 3: "Good", 4: "Easy"}
    return ReviewResponse(
        next_review=progress.next_review,
        interval_days=result.interval_days,
        ease_factor=result.ease_factor,
        message=f"Rated '{rating_labels[data.rating]}'. Next review in {result.interval_days} day(s).",
    )


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

    now = datetime.now(timezone.utc)
    total_cards = db.query(Card).filter(Card.deck_id == deck_id).count()

    # Studied cards
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

    due_cards = (
        db.query(StudyProgress)
        .join(Card, Card.id == StudyProgress.card_id)
        .filter(
            Card.deck_id == deck_id,
            StudyProgress.user_id == current_user.id,
            StudyProgress.next_review <= now,
        )
        .count()
    )

    learn_cards = (
        db.query(StudyProgress)
        .join(Card, Card.id == StudyProgress.card_id)
        .filter(
            Card.deck_id == deck_id,
            StudyProgress.user_id == current_user.id,
            StudyProgress.interval_days == 0,
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
    avg_ease = round(avg_ease_result, 2) if avg_ease_result else 2.5

    import json
    settings = {}
    if deck.settings:
        try:
            settings = json.loads(deck.settings)
        except:
            pass
    
    new_limit = int(settings.get("new_cards_per_day", 20))
    rev_limit = int(settings.get("maximum_reviews_per_day", 200))

    # Calculate studied today from ReviewLog
    start_of_today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    
    new_studied_today = (
        db.query(ReviewLog)
        .join(Card, Card.id == ReviewLog.card_id)
        .filter(
            Card.deck_id == deck_id,
            ReviewLog.user_id == current_user.id,
            ReviewLog.was_new == True,
            ReviewLog.review_date >= start_of_today
        )
        .count()
    )
    
    rev_studied_today = (
        db.query(ReviewLog)
        .join(Card, Card.id == ReviewLog.card_id)
        .filter(
            Card.deck_id == deck_id,
            ReviewLog.user_id == current_user.id,
            ReviewLog.was_new == False,
            ReviewLog.review_date >= start_of_today
        )
        .count()
    )

    remaining_new_limit = max(0, new_limit - new_studied_today)
    remaining_rev_limit = max(0, rev_limit - rev_studied_today)

    new_cards = min(new_cards, remaining_new_limit)
    due_cards = min(due_cards, remaining_rev_limit)

    return StudyStatsResponse(
        total_cards=total_cards,
        new_cards=new_cards,
        learn_cards=learn_cards,
        due_cards=due_cards,
        learned_cards=learned_cards,
        avg_ease=avg_ease,
    )
