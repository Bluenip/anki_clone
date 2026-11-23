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


class _MediaCopier:
    """Copies the sharer's media into the downloader's folder (once per file, never overwriting a
    different file) and rewrites references: /api/media links in rendered cards, and the bare file
    names ([sound:x], src="x", CSS url(x)) that note fields and note type CSS use."""

    def __init__(self, source_user_id, target_user_id):
        from media_utils import get_media_dir
        self.source, self.target = source_user_id, target_user_id
        self.source_dir, self.target_dir = get_media_dir(source_user_id), get_media_dir(target_user_id)
        self.copied = {}

    def name(self, raw):
        """The downloader's name for the sharer's file `raw`, or None when it cannot be copied."""
        import os, shutil
        if self.source == self.target:
            return raw
        if raw not in self.copied:
            source = os.path.join(self.source_dir, raw)
            if os.path.basename(raw) != raw or raw.startswith('.') or not os.path.isfile(source):
                self.copied[raw] = None
            else:
                os.makedirs(self.target_dir, exist_ok=True)
                stem, ext = os.path.splitext(raw)
                target_name, n = raw, 1
                while os.path.exists(os.path.join(self.target_dir, target_name)):
                    with open(source, 'rb') as a, open(os.path.join(self.target_dir, target_name), 'rb') as b:
                        if a.read() == b.read():
                            break
                    target_name, n = f'{stem}_{n}{ext}', n + 1
                else:
                    shutil.copy2(source, os.path.join(self.target_dir, target_name))
                self.copied[raw] = target_name
        return self.copied[raw]

    def rendered(self, html):
        import re
        from urllib.parse import quote, unquote

        def link(match):
            if int(match[1]) != self.source:
                return match[0]
            target = self.name(unquote(match[2]))
            return match[0] if target is None else f'/api/media/{self.target}/{quote(target, safe="")}'
        return re.sub(r'/api/media/(\d+)/([^"\'<>\s)]+)', link, html or '')

    def source_text(self, text):
        """Note fields and CSS: bare file names, plus any /api/media links pasted into them."""
        import re
        from urllib.parse import quote, unquote

        def local(raw, rebuild):
            if re.match(r'^(?:[a-z][a-z0-9+.-]*:|/|#)', raw, re.I):
                return None
            target = self.name(unquote(raw))
            # Keep the reference's own spelling: URL-encoded stays encoded, a plain name stays plain.
            return None if target is None else rebuild(quote(target, safe='') if raw != unquote(raw) else target)

        text = self.rendered(text)
        text = re.sub(r'\[sound:([^\]]+)\]', lambda m: (local(m[1], lambda t: f'[sound:{t}]') or m[0]), text)
        text = re.sub(r'((?:src|href)=["\'])([^"\']+)(["\'])',
                      lambda m: (local(m[2], lambda t: m[1] + t + m[3]) or m[0]), text, flags=re.I)
        return re.sub(r'url\(\s*(["\']?)([^)"\']+)\1\s*\)',
                      lambda m: (local(m[2], lambda t: f'url({m[1]}{t}{m[1]})') or m[0]), text, flags=re.I)


def _free_deck_name(db, user_id, wanted):
    """`wanted`, or `wanted (2)`, `wanted (3)`… when the downloader already has a deck by that name."""
    name, n = wanted, 2
    while db.query(Deck.id).filter_by(user_id=user_id, name=name).first():
        name, n = f'{wanted} ({n})', n + 1
    return name


def _copy_note_type(db, model, user_id, media, cache):
    """The downloader's copy of a note type: an identical one they already have, else a new one."""
    import json
    from models import NoteType, PackageModel
    if model.id in cache:
        return cache[model.id]
    css = media.source_text(model.css or '')
    candidates = db.query(NoteType).filter(NoteType.user_id == user_id,
                                           NoteType.name.like(model.name.replace('%', r'\%').replace('_', r'\_') + '%', escape='\\')).all()
    same = next((c for c in candidates if c.fields_json == model.fields_json and c.templates_json == model.templates_json
                 and (c.css or '') == css), None)
    if same is None:
        names = {c.name for c in candidates}
        name, n = model.name, 2
        while name in names:
            name, n = f'{model.name} ({n})', n + 1
        same = NoteType(user_id=user_id, name=name, fields_json=model.fields_json, templates_json=model.templates_json, css=css)
        if model.package_data:
            same.package_data = PackageModel(payload=model.package_data.payload)
        db.add(same)
        db.flush()
    cache[model.id] = same
    return same


@router.post("/decks/{shared_id}/download")
def download_shared_deck(
    shared_id: int, current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    import json
    from models import Note, NoteCard, PackageNote
    from note_rendering import render_cards
    from notes import attach_basic_note, new_guid
    from routers.decks_router import ensure_parents
    sd = db.query(SharedDeck).filter(SharedDeck.id == shared_id).first()
    if not sd:
        raise HTTPException(status_code=404, detail="Shared deck not found")
    original_deck = db.query(Deck).filter(Deck.id == sd.deck_id).first()
    if not original_deck:
        raise HTTPException(status_code=404, detail="Original deck not found")
    name = _free_deck_name(db, current_user.id, sd.title.strip() or 'Shared deck')
    parent = ensure_parents(db, current_user.id, name)
    new_deck = Deck(user_id=current_user.id, name=name, description=sd.description,
                    settings=parent.settings if parent else '{}')
    db.add(new_deck)
    db.flush()
    media = _MediaCopier(original_deck.user_id, current_user.id)
    note_types, done_notes = {}, set()
    try:
        for card in db.query(Card).filter(Card.deck_id == sd.deck_id).order_by(Card.id).all():
            link = card.note_link
            if link is None:
                copy = Card(deck_id=new_deck.id, front=media.rendered(card.front), back=media.rendered(card.back))
                db.add(copy)
                attach_basic_note(db, copy, current_user.id)
                continue
            source = link.note
            if source.id in done_notes:
                continue
            done_notes.add(source.id)
            # The note with its own note type, fields and tags, so cloze, image occlusion and styling survive.
            model = _copy_note_type(db, source.note_type, current_user.id, media, note_types)
            values = [media.source_text(value) for value in json.loads(source.fields_json)]
            tags = json.loads(source.tags_json or '[]')
            rendered = render_cards(model, values, current_user.id, tags, new_deck.name)
            wanted = {l.template_ord for l in source.card_links if l.card.deck_id == sd.deck_id}
            note = Note(user_id=current_user.id, note_type=model, guid=new_guid(),
                        fields_json=json.dumps(values, ensure_ascii=False), tags_json=json.dumps(tags, ensure_ascii=False))
            note.package_data = PackageNote(payload=json.dumps({'_web_rendered': True}))
            db.add(note)
            for ordinal, (front, back) in sorted(rendered.items()):
                if ordinal in wanted:
                    copy = Card(deck_id=new_deck.id, front=front, back=back)
                    db.add(copy)
                    note.card_links.append(NoteCard(card=copy, template_ord=ordinal))
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail=f'This shared deck could not be copied: {exc}') from None
    sd.download_count += 1
    db.commit()
    return {"message": f"Deck '{name}' added to your collection", "deck_id": new_deck.id}


@router.post("/decks/{shared_id}/rate")
def rate_shared_deck(
    shared_id: int, data: RateDeckRequest,
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db),
):
    sd = db.query(SharedDeck).filter(SharedDeck.id == shared_id).first()
    if not sd:
        raise HTTPException(status_code=404, detail="Shared deck not found")
    from sqlalchemy import func
    from models import SharedDeckRating
    # One vote per account: rating again replaces the earlier vote. The shown average is always
    # recomputed from the votes, so it cannot drift outside 1–5.
    vote = db.query(SharedDeckRating).filter_by(shared_deck_id=sd.id, user_id=current_user.id).first()
    if vote is None:
        db.add(SharedDeckRating(shared_deck_id=sd.id, user_id=current_user.id, rating=data.rating))
    else:
        vote.rating = data.rating
    db.flush()
    count, average = db.query(func.count(SharedDeckRating.id), func.avg(SharedDeckRating.rating)).filter(
        SharedDeckRating.shared_deck_id == sd.id).one()
    sd.rating_count, sd.rating = count, round(float(average or 0), 1)
    db.commit()
    return {"message": "Rating submitted", "new_rating": sd.rating}
