from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy import func
from datetime import datetime, timezone
from typing import List

from database import get_db
from models import User, Deck, Card, StudyProgress, ReviewLog
from schemas import DeckCreate, DeckUpdate, DeckResponse
from auth import get_current_user

router = APIRouter(prefix="/api/decks", tags=["Decks"])


def get_deck_with_stats(deck: Deck, user_id: int, db: Session) -> DeckResponse:
    """Build a DeckResponse with computed card counts."""
    total_cards = db.query(Card).filter(Card.deck_id == deck.id).count()

    now = datetime.now(timezone.utc)

    # Due cards: studied, interval > 0, and review time is reached
    due_cards = (
        db.query(StudyProgress)
        .join(Card, Card.id == StudyProgress.card_id)
        .filter(
            Card.deck_id == deck.id,
            StudyProgress.user_id == user_id,
            StudyProgress.next_review <= now,
            StudyProgress.interval_days > 0,
        )
        .count()
    )

    # Learn cards: studied, but interval == 0 (still in learning phase)
    learn_cards = (
        db.query(StudyProgress)
        .join(Card, Card.id == StudyProgress.card_id)
        .filter(
            Card.deck_id == deck.id,
            StudyProgress.user_id == user_id,
            StudyProgress.interval_days == 0,
        )
        .count()
    )

    # New cards: never studied
    studied_card_ids = (
        db.query(StudyProgress.card_id)
        .join(Card, Card.id == StudyProgress.card_id)
        .filter(
            Card.deck_id == deck.id,
            StudyProgress.user_id == user_id,
        )
        .subquery()
    )
    new_cards = (
        db.query(Card)
        .filter(Card.deck_id == deck.id, ~Card.id.in_(studied_card_ids))
        .count()
    )

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
            Card.deck_id == deck.id,
            ReviewLog.user_id == user_id,
            ReviewLog.was_new == True,
            ReviewLog.review_date >= start_of_today
        )
        .count()
    )
    
    rev_studied_today = (
        db.query(ReviewLog)
        .join(Card, Card.id == ReviewLog.card_id)
        .filter(
            Card.deck_id == deck.id,
            ReviewLog.user_id == user_id,
            ReviewLog.was_new == False,
            ReviewLog.review_date >= start_of_today
        )
        .count()
    )

    remaining_new_limit = max(0, new_limit - new_studied_today)
    remaining_rev_limit = max(0, rev_limit - rev_studied_today)

    new_cards = min(new_cards, remaining_new_limit)
    due_cards = min(due_cards, remaining_rev_limit)

    return DeckResponse(
        id=deck.id,
        name=deck.name,
        description=deck.description,
        settings=deck.settings,
        is_shared=deck.is_shared,
        created_at=deck.created_at,
        updated_at=deck.updated_at,
        total_cards=total_cards,
        new_cards=new_cards,
        learn_cards=learn_cards,
        due_cards=due_cards,
    )


@router.get("", response_model=List[DeckResponse])
def list_decks(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    decks = db.query(Deck).filter(Deck.user_id == current_user.id).all()
    return [get_deck_with_stats(d, current_user.id, db) for d in decks]


@router.post("", response_model=DeckResponse, status_code=status.HTTP_201_CREATED)
def create_deck(
    data: DeckCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    deck = Deck(
        user_id=current_user.id,
        name=data.name,
        description=data.description or "",
    )
    db.add(deck)
    db.commit()
    db.refresh(deck)
    return get_deck_with_stats(deck, current_user.id, db)


@router.get("/{deck_id}", response_model=DeckResponse)
def get_deck(
    deck_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    deck = (
        db.query(Deck)
        .filter(Deck.id == deck_id, Deck.user_id == current_user.id)
        .first()
    )
    if not deck:
        raise HTTPException(status_code=404, detail="Deck not found")
    return get_deck_with_stats(deck, current_user.id, db)


@router.put("/{deck_id}", response_model=DeckResponse)
def update_deck(
    deck_id: int,
    data: DeckUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    deck = (
        db.query(Deck)
        .filter(Deck.id == deck_id, Deck.user_id == current_user.id)
        .first()
    )
    if not deck:
        raise HTTPException(status_code=404, detail="Deck not found")

    if data.name is not None:
        deck.name = data.name
    if data.description is not None:
        deck.description = data.description
    if data.settings is not None:
        deck.settings = data.settings

    db.commit()
    db.refresh(deck)
    return get_deck_with_stats(deck, current_user.id, db)


@router.delete("/{deck_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_deck(
    deck_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    deck = (
        db.query(Deck)
        .filter(Deck.id == deck_id, Deck.user_id == current_user.id)
        .first()
    )
    if not deck:
        raise HTTPException(status_code=404, detail="Deck not found")

    # Explicitly delete related ReviewLog entries
    card_ids = db.query(Card.id).filter(Card.deck_id == deck.id).all()
    card_ids = [c[0] for c in card_ids]
    if card_ids:
        db.query(ReviewLog).filter(ReviewLog.card_id.in_(card_ids)).delete(synchronize_session=False)

    db.delete(deck)
    db.commit()

from schemas import ImportRequest
@router.post("/{deck_id}/import", response_model=dict)
def import_cards(
    deck_id: int,
    data: ImportRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    deck = (
        db.query(Deck)
        .filter(Deck.id == deck_id, Deck.user_id == current_user.id)
        .first()
    )
    if not deck:
        raise HTTPException(status_code=404, detail="Deck not found")

    added_count = 0
    for line in data.text.strip().split("\n"):
        parts = line.split(data.separator)
        if len(parts) >= 2:
            front = parts[0].strip()
            back = parts[1].strip()
            if front and back:
                card = Card(deck_id=deck.id, front=front, back=back)
                db.add(card)
                added_count += 1

    db.commit()
    return {"message": f"Successfully imported {added_count} cards."}

