from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List, Optional

from database import get_db
from models import User, Deck, Card, SharedDeck
from schemas import (
    ShareDeckRequest, SharedDeckResponse, SharedDeckDetailResponse, RateDeckRequest,
)
from auth import get_current_user
from text_fold import folded_like

router = APIRouter(prefix="/api/shared", tags=["Shared Decks"])

CATEGORIES = {
    "languages": [
        "Arabic", "Chinese", "English", "French", "German",
        "Hebrew", "Japanese", "Korean", "Russian", "Spanish",
    ],
    "sciences": [
        "Anatomy", "Biology", "Chemistry", "Geography", "History",
        "Law", "Math", "Music", "Pathology", "Physics",
    ],
}


@router.get("/categories")
def get_categories():
    return CATEGORIES


@router.get("/decks", response_model=List[SharedDeckResponse])
def browse_shared_decks(
    search: str = "", category: str = "", db: Session = Depends(get_db),
):
    query = db.query(SharedDeck).join(User, User.id == SharedDeck.user_id)
    if search:
        query = query.filter(
            folded_like(SharedDeck.title, f"%{search}%")
            | folded_like(SharedDeck.description, f"%{search}%")
        )
    if category:
        query = query.filter(SharedDeck.category == category)

    shared_decks = query.order_by(SharedDeck.download_count.desc()).all()
    results = []
    for sd in shared_decks:
        user = db.query(User).filter(User.id == sd.user_id).first()
        results.append(SharedDeckResponse(
            id=sd.id, title=sd.title, description=sd.description,
            category=sd.category, download_count=sd.download_count,
            rating=sd.rating, rating_count=sd.rating_count,
            notes_count=sd.notes_count, has_audio=sd.has_audio,
            has_images=sd.has_images, shared_at=sd.shared_at,
            username=user.username if user else "Unknown",
        ))
    return results


@router.get("/decks/{shared_id}", response_model=SharedDeckDetailResponse)
def get_shared_deck(shared_id: int, db: Session = Depends(get_db)):
    sd = db.query(SharedDeck).filter(SharedDeck.id == shared_id).first()
    if not sd:
        raise HTTPException(status_code=404, detail="Shared deck not found")
    user = db.query(User).filter(User.id == sd.user_id).first()
    return SharedDeckDetailResponse(
        id=sd.id, deck_id=sd.deck_id, user_id=sd.user_id,
        title=sd.title, description=sd.description, category=sd.category,
        download_count=sd.download_count, rating=sd.rating,
        rating_count=sd.rating_count, notes_count=sd.notes_count,
        has_audio=sd.has_audio, has_images=sd.has_images,
        shared_at=sd.shared_at, username=user.username if user else "Unknown",
    )


@router.post("/decks/{deck_id}/share", response_model=SharedDeckResponse)
def share_deck(
    deck_id: int, data: ShareDeckRequest,
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db),
):
    deck = db.query(Deck).filter(Deck.id == deck_id, Deck.user_id == current_user.id).first()
    if not deck:
        raise HTTPException(status_code=404, detail="Deck not found")
    existing = db.query(SharedDeck).filter(SharedDeck.deck_id == deck_id).first()
    if existing:
        raise HTTPException(status_code=400, detail="Deck already shared")
    notes_count = db.query(Card).filter(Card.deck_id == deck_id).count()
    shared = SharedDeck(
        deck_id=deck_id, user_id=current_user.id, title=data.title,
        description=data.description or "", category=data.category,
        notes_count=notes_count, has_audio=data.has_audio, has_images=data.has_images,
    )
    db.add(shared)
    deck.is_shared = True
    db.commit()
    db.refresh(shared)
    return SharedDeckResponse(
        id=shared.id, title=shared.title, description=shared.description,
        category=shared.category, download_count=0, rating=0.0, rating_count=0,
        notes_count=shared.notes_count, has_audio=shared.has_audio,
        has_images=shared.has_images, shared_at=shared.shared_at,
        username=current_user.username,
    )


def _media_copier(source_user_id, target_user_id):
    """Rewrites /api/media links to the downloader's own media folder, copying each file once."""
    import os, re, shutil
    from urllib.parse import quote, unquote
    from media_utils import get_media_dir
    if source_user_id == target_user_id:
        return lambda html: html or ''
    source_dir, target_dir = get_media_dir(source_user_id), get_media_dir(target_user_id)
    copied = {}

    def copy_one(match):
        name = match[2]
        if int(match[1]) != source_user_id:
            return match[0]
        if name not in copied:
            raw = unquote(name)
            source = os.path.join(source_dir, raw)
            if os.path.basename(raw) != raw or raw.startswith('.') or not os.path.isfile(source):
                copied[name] = None
            else:
                os.makedirs(target_dir, exist_ok=True)
                stem, ext = os.path.splitext(raw)
                target_name, n = raw, 1
                # Never overwrite a different file the downloader already has under that name.
                while os.path.exists(os.path.join(target_dir, target_name)):
                    with open(source, 'rb') as a, open(os.path.join(target_dir, target_name), 'rb') as b:
                        if a.read() == b.read():
                            break
                    target_name, n = f'{stem}_{n}{ext}', n + 1
                else:
                    shutil.copy2(source, os.path.join(target_dir, target_name))
                copied[name] = name if target_name == raw else quote(target_name)
        target = copied[name]
        return match[0] if target is None else f'/api/media/{target_user_id}/{target}'

    return lambda html: re.sub(r'/api/media/(\d+)/([^"\'<>\s)]+)', copy_one, html or '')


@router.post("/decks/{shared_id}/download")
def download_shared_deck(
    shared_id: int, current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    sd = db.query(SharedDeck).filter(SharedDeck.id == shared_id).first()
    if not sd:
        raise HTTPException(status_code=404, detail="Shared deck not found")
    original_deck = db.query(Deck).filter(Deck.id == sd.deck_id).first()
    if not original_deck:
        raise HTTPException(status_code=404, detail="Original deck not found")
    new_deck = Deck(user_id=current_user.id, name=sd.title, description=sd.description)
    db.add(new_deck)
    db.flush()
    original_cards = db.query(Card).filter(Card.deck_id == sd.deck_id).all()
    copy_media = _media_copier(original_deck.user_id, current_user.id)
    from notes import attach_basic_note
    for card in original_cards:
        copy = Card(deck_id=new_deck.id, front=copy_media(card.front), back=copy_media(card.back))
        db.add(copy)
        # A note of its own, so the copy can be edited and exported like any other card.
        attach_basic_note(db, copy, current_user.id)
    sd.download_count += 1
    db.commit()
    return {"message": f"Deck '{sd.title}' added to your collection", "deck_id": new_deck.id}


@router.post("/decks/{shared_id}/rate")
def rate_shared_deck(
    shared_id: int, data: RateDeckRequest,
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db),
):
    if not (1.0 <= data.rating <= 5.0):
        raise HTTPException(status_code=400, detail="Rating must be between 1 and 5")
    sd = db.query(SharedDeck).filter(SharedDeck.id == shared_id).first()
    if not sd:
        raise HTTPException(status_code=404, detail="Shared deck not found")
    total = sd.rating * sd.rating_count + data.rating
    sd.rating_count += 1
    sd.rating = round(total / sd.rating_count, 1)
    db.commit()
    return {"message": "Rating submitted", "new_rating": sd.rating}
