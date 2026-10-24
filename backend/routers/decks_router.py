from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from sqlalchemy.exc import IntegrityError
from typing import Literal
from sqlalchemy.orm import Session
from sqlalchemy import func
from datetime import datetime, timezone
from typing import List
import json

from database import get_db
from models import User, Deck, Card, StudyProgress, ReviewLog
from schemas import DeckCreate, DeckUpdate, DeckResponse
from auth import get_current_user
from sm2 import parse_settings_to_config
from media_utils import get_card_media_filenames, get_orphaned_media, cleanup_media_files, cleanup_orphaned_media

router = APIRouter(prefix="/api/decks", tags=["Decks"])


def ensure_parents(db, user_id, name):
    from models import DeckOptionsBinding
    parent = None
    parts = name.split('::')
    for index in range(1,len(parts)):
        prefix='::'.join(parts[:index])
        found=db.query(Deck).filter_by(user_id=user_id,name=prefix).first()
        if not found:
            found=Deck(user_id=user_id,name=prefix,settings=parent.settings if parent else '{}')
            if parent and parent.options_binding and parent.options_binding.preset:
                found.options_binding=DeckOptionsBinding(preset=parent.options_binding.preset,overrides_json='{}',today_json='{}')
            db.add(found);db.flush()
        parent=found
    return parent


def get_deck_with_stats(deck: Deck, user_id: int, db: Session) -> DeckResponse:
    """Counts and reviewer share the same queue/limit rules."""
    from study_queue import snapshot
    from deck_options import effective_settings
    view=snapshot(db,deck,user_id,datetime.now(timezone.utc))
    return DeckResponse(id=deck.id,name=deck.name,description=deck.description,settings=json.dumps(effective_settings(deck)),
        is_shared=deck.is_shared,created_at=deck.created_at,updated_at=deck.updated_at,
        total_cards=len(view['cards']),new_cards=view['new_cards'],learn_cards=view['learn_cards'],due_cards=view['due_cards'])


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
    if db.query(Deck).filter_by(user_id=current_user.id,name=data.name).first():
        raise HTTPException(status_code=409,detail='A deck with this name already exists')
    parent=ensure_parents(db,current_user.id,data.name)
    deck = Deck(
        user_id=current_user.id,
        name=data.name,
        description=data.description or "",
        settings=parent.settings if parent else '{}',
    )
    if parent and parent.options_binding and parent.options_binding.preset:
        from models import DeckOptionsBinding
        deck.options_binding=DeckOptionsBinding(preset=parent.options_binding.preset,overrides_json='{}',today_json='{}')
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

    if data.settings is not None and deck.options_binding and deck.options_binding.preset:
        raise HTTPException(status_code=409, detail='This deck uses a shared preset; save through its Options page with the current preset version')
    if data.name is not None:
        if data.name.startswith(deck.name+'::'):
            raise HTTPException(status_code=400,detail='A deck cannot be moved inside itself')
        owned=db.query(Deck).filter_by(user_id=current_user.id).all()
        subtree=[d for d in owned if d.id==deck.id or d.name.startswith(deck.name+'::')]
        renames={d.id:data.name+d.name[len(deck.name):] for d in subtree}
        if any(len(name)>255 for name in renames.values()):
            raise HTTPException(status_code=400,detail='A descendant deck name would exceed 255 characters')
        if any(d.id not in renames and d.name in renames.values() for d in owned):
            raise HTTPException(status_code=409,detail='Renaming would collide with an existing deck')
        ensure_parents(db,current_user.id,data.name)
        for child in subtree:child.name=renames[child.id]
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

    # ORM cascades also remove ReviewRecord children; a bulk log DELETE would
    # leave their metadata orphaned. Include the entire named subtree.
    subtree=[d for d in db.query(Deck).filter_by(user_id=current_user.id)
             if d.id==deck.id or d.name.startswith(deck.name+'::')]
    for child in subtree:db.delete(child)
    from notes import cleanup_empty_notes
    cleanup_empty_notes(db, current_user.id)
    db.commit()

    # After DB delete, scan disk and remove ALL orphaned media files
    # This catches both referenced files AND unreferenced files (e.g. images
    # that were copied during .apkg import but not linked in card HTML)
    cleanup_orphaned_media(current_user.id, db)

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

    from note_import import import_text
    try:
        return import_text(db, deck, data)
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="The collection changed during import; preview and retry") from None


@router.get("/{deck_id}/export/text")
def export_deck_text(
    deck_id: int,
    format: Literal['csv', 'txt', 'tsv'] = 'txt',
    include_guid: bool = True,
    include_subdecks: bool = True,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from notes import card_guid
    from text_transfer import export_text
    deck = db.query(Deck).filter(Deck.id == deck_id, Deck.user_id == current_user.id).first()
    if not deck:
        raise HTTPException(status_code=404, detail="Deck not found")
    query = db.query(Card).join(Deck).filter(Deck.user_id == current_user.id)
    if include_subdecks:
        query = query.filter((Deck.id == deck.id) | Deck.name.startswith(deck.name + '::', autoescape=True))
    else:
        query = query.filter(Deck.id == deck.id)
    cards = query.order_by(Card.id).all()
    complex_notes = len({c.deck_id for c in cards}) > 1 or any(c.note_link and (len(c.note_link.note.card_links) != 1 or c.note_link.note.note_type.name != 'Basic' or any(not value.strip() for value in json.loads(c.note_link.note.fields_json)) or json.loads(c.note_link.note.tags_json) or json.loads(c.note_link.note.note_type.fields_json) != ['Front', 'Back']) for c in cards)
    if complex_notes:
        from note_text_export import export_notes_text
        try:
            content = export_notes_text(cards, current_user.id, ',' if format == 'csv' else '\t', include_guid)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        return Response(content=content, media_type='text/csv' if format == 'csv' else 'text/plain',
                        headers={'Content-Disposition': f'attachment; filename="deck-{deck_id}.{format}"'})
    def fields(card):
        if card.note_link:
            values=json.loads(card.note_link.note.fields_json)
            return values[0],values[1],card_guid(card,current_user.id)
        return card.front,card.back,card_guid(card,current_user.id)
    content = export_text((fields(c) for c in cards),
                          separator=',' if format == 'csv' else '\t', include_guid=include_guid)
    return Response(content=content, media_type='text/csv' if format == 'csv' else 'text/plain',
                    headers={'Content-Disposition': f'attachment; filename="deck-{deck_id}.{format}"'})

