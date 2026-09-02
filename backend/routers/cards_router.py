from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List

from database import get_db
from models import User, Deck, Card, StudyProgress
from schemas import CardCreate, CardUpdate, CardResponse, BrowseCardResponse
from auth import get_current_user

router = APIRouter(prefix="/api", tags=["Cards"])


def verify_deck_ownership(deck_id: int, user_id: int, db: Session) -> Deck:
    deck = db.query(Deck).filter(Deck.id == deck_id, Deck.user_id == user_id).first()
    if not deck:
        raise HTTPException(status_code=404, detail="Deck not found")
    return deck


@router.get("/cards/browse", response_model=List[BrowseCardResponse])
def browse_cards(
    search: str = "",
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = (
        db.query(Card, Deck.name.label("deck_name"), StudyProgress.next_review, StudyProgress.interval_days)
        .join(Deck, Deck.id == Card.deck_id)
        .outerjoin(StudyProgress, (StudyProgress.card_id == Card.id) & (StudyProgress.user_id == current_user.id))
        .filter(Deck.user_id == current_user.id)
    )

    if search:
        query = query.filter(
            (Card.front.ilike(f"%{search}%")) | (Card.back.ilike(f"%{search}%"))
        )

    results = query.order_by(Card.created_at.desc()).limit(1000).all()

    cards = []
    for card, deck_name, next_review, interval_days in results:
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
        })
    
    return cards


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
    db.commit()
