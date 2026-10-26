from typing import Literal
from pydantic import BaseModel, Field, field_validator
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from database import get_db
from auth import get_current_user
from models import User, Note, Card, Deck
from note_service import BUILTINS, create_note, update_note, note_response, lock_note_revision
from notes import legacy_guid

router = APIRouter(prefix='/api', tags=['Notes'])


class NoteFields(BaseModel):
    fields: dict[str, str]
    tags: list[str] = Field(default_factory=list)

    @field_validator('fields')
    @classmethod
    def field_limits(cls, fields):
        if not 1 <= len(fields) <= 100 or any(len(k) > 100 or len(v) > 50000 for k, v in fields.items()) or sum(len(v) for v in fields.values()) > 500000:
            raise ValueError('Note fields exceed the supported limits')
        return fields

    @field_validator('tags')
    @classmethod
    def tag_limits(cls, tags):
        if len(tags) > 100 or any(not t or len(t) > 100 or any(c.isspace() for c in t) for t in tags):
            raise ValueError('Tags must be nonempty names without whitespace (max 100)')
        return list(dict.fromkeys(tags))


class NoteUpdate(NoteFields):
    expected_revision: str | None = Field(default=None, pattern=r'^[0-9a-f]{64}$')


class NoteCreate(NoteFields):
    deck_id: int
    note_type_id: int | None = None
    kind: Literal['basic', 'reversed', 'optional_reversed', 'cloze', 'typed', 'image_occlusion'] = 'basic'


def owned_note(db, note_id, user_id):
    note = db.query(Note).filter_by(id=note_id, user_id=user_id).first()
    if not note:
        raise HTTPException(status_code=404, detail='Note not found')
    return note


@router.get('/note-types')
def get_note_types(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    import json
    from models import NoteType
    models = db.query(NoteType).filter_by(user_id=user.id).order_by(NoteType.name).all()
    from note_service import kind_for
    names = {m.name for m in models}
    return ([{'kind': key, 'name': value['name'], 'fields': value['fields']} for key, value in BUILTINS.items() if value['name'] not in names]
            + [{'kind': kind_for(m) if kind_for(m) in BUILTINS and m.name == BUILTINS[kind_for(m)]['name'] else f'model:{m.id}', 'editor_kind': kind_for(m), 'id': m.id, 'name': m.name, 'fields': json.loads(m.fields_json)} for m in models])


@router.get('/note-types/available')
def available_note_types(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    import json
    from models import NoteType
    return [{'id': model.id, 'name': model.name, 'fields': json.loads(model.fields_json)}
            for model in db.query(NoteType).filter_by(user_id=user.id).order_by(NoteType.name).all()]


@router.post('/notes', status_code=201)
def add_note(data: NoteCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    deck = db.query(Deck).filter_by(id=data.deck_id, user_id=user.id).first()
    if not deck:
        raise HTTPException(status_code=404, detail='Deck not found')
    try:
        if data.note_type_id is not None:
            from models import NoteType
            from note_service import create_note_from_model
            model = db.query(NoteType).filter_by(id=data.note_type_id, user_id=user.id).first()
            if model is None:
                raise HTTPException(404, 'Note type not found')
            note = create_note_from_model(db, deck, model, data.fields, data.tags)
        else:
            note = create_note(db, deck, data.kind, data.fields, data.tags)
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except Exception:
        db.rollback()
        raise
    return note_response(note)


@router.get('/notes/{note_id}')
def get_note(note_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return note_response(owned_note(db, note_id, user.id))


@router.put('/notes/{note_id}')
def edit_note(note_id: int, data: NoteUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    note = owned_note(db, note_id, user.id)
    try:
        if data.expected_revision is not None:
            lock_note_revision(db, note, data.expected_revision)
        update_note(db, note, data.fields, data.tags)
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except Exception:
        db.rollback()
        raise
    return note_response(note)


@router.get('/cards/{card_id}/note')
def get_card_note(card_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    card = db.query(Card).join(Deck).filter(Card.id == card_id, Deck.user_id == user.id).first()
    if not card:
        raise HTTPException(status_code=404, detail='Card not found')
    if card.note_link:
        return note_response(card.note_link.note)
    return {'id': None, 'version': card.scheduling.version if card.scheduling else 0, 'guid': legacy_guid(card, user.id), 'kind': 'basic', 'fields': {'Front': card.front, 'Back': card.back},
            'tags': [], 'css': '', 'cards': [{'id': card.id, 'deck_id': card.deck_id, 'front': card.front, 'back': card.back, 'template_ord': 0}]}
