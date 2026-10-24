"""Owned note type editing with atomic re-rendering and optimistic concurrency."""
import hashlib
import json
from types import SimpleNamespace
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import update
from sqlalchemy.orm import Session
from auth import get_current_user
from database import get_db
from models import NoteType, Note, User
from note_rendering import render_cards, render_template, css_for_web, TOKEN
from note_service import update_note

router = APIRouter(prefix='/api/models', tags=['Note types'])


class Template(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    qfmt: str = Field(min_length=1, max_length=200000)
    afmt: str = Field(max_length=200000)


class Definition(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    fields: list[str] = Field(min_length=1, max_length=100)
    templates: list[Template] = Field(min_length=1, max_length=100)
    css: str = Field(default='', max_length=200000)

    @model_validator(mode='after')
    def validate_definition(self):
        if not self.name.strip() or len(set(self.fields)) != len(self.fields):
            raise ValueError('Name and unique field names are required')
        if any(not f.strip() or len(f) > 100 or any(c in f for c in ':{}') or f.startswith(('#', '^', '/')) for f in self.fields):
            raise ValueError('Invalid field name')
        if len({t.name for t in self.templates}) != len(self.templates):
            raise ValueError('Template names must be unique')
        # Validate both branches, including branches hidden by empty fields.
        for values in ({f: 'sample' for f in self.fields}, {f: '' for f in self.fields}):
            for t in self.templates:
                for body in (t.qfmt, t.afmt):
                    render_template(body, values, context={'Tags': '', 'Deck': '', 'Subdeck': '', 'Type': self.name, 'Card': t.name})
        context = dict(Tags='', Deck='', Subdeck='', Type=self.name, Card='')
        for t in self.templates:
            for body in (t.qfmt, t.afmt):
                for match in TOKEN.finditer(body):
                    if not match[1].strip().startswith(('#', '^', '/')):
                        render_template(match[0], {f: 'sample' for f in self.fields}, context=context)
        css_for_web(self.css, 0)
        if any('{{cloze:' in t.qfmt for t in self.templates) and len(self.templates) != 1:
            raise ValueError('Cloze note types require one template')
        return self


class EditDefinition(Definition):
    expected_revision: str = Field(pattern=r'^[0-9a-f]{64}$')


class Preview(Definition):
    values: dict[str, str]
    deck_name: str = Field(default='Preview', max_length=1000)


def revision(model):
    return hashlib.sha256(json.dumps([model.name, model.fields_json, model.templates_json, model.css]).encode()).hexdigest()


def response(model):
    return dict(id=model.id, name=model.name, fields=json.loads(model.fields_json),
                templates=json.loads(model.templates_json), css=model.css or '', revision=revision(model))


def owned(db, user, model_id):
    model = db.query(NoteType).filter_by(id=model_id, user_id=user.id).first()
    if model is None:
        raise HTTPException(404, 'Note type not found')
    return model


def assign(model, data):
    model.name = data.name
    model.fields_json = json.dumps(data.fields, ensure_ascii=False)
    model.templates_json = json.dumps([t.model_dump() for t in data.templates], ensure_ascii=False)
    model.css = data.css


def unique_name(db, user, data, model_id=None):
    q = db.query(NoteType).filter_by(user_id=user.id, name=data.name)
    if model_id is not None:
        q = q.filter(NoteType.id != model_id)
    if q.first():
        raise HTTPException(409, 'A note type already uses this name')


@router.get('')
def list_models(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return [response(m) for m in db.query(NoteType).filter_by(user_id=user.id).order_by(NoteType.name)]


@router.post('/preview')
def preview(data: Preview, user: User = Depends(get_current_user)):
    if set(data.values) != set(data.fields) or sum(len(v) for v in data.values.values()) > 500000:
        raise HTTPException(422, 'Supply the defined fields (maximum 500000 characters)')
    model = SimpleNamespace()
    assign(model, data)
    try:
        cards = render_cards(model, [data.values[f] for f in data.fields], user.id, deck_name=data.deck_name)
        return dict(cards=[dict(ordinal=o, front=f, back=b) for o, (f, b) in cards.items()], css=css_for_web(data.css, user.id))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


@router.post('', status_code=201)
def create(data: Definition, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    unique_name(db, user, data)
    model = NoteType(user_id=user.id)
    assign(model, data)
    db.add(model)
    db.commit()
    return response(model)


@router.put('/{model_id}')
def edit(model_id: int, data: EditDefinition, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    model = owned(db, user, model_id)
    try:
        db.execute(update(NoteType).where(NoteType.id == model.id).values(id=NoteType.id))
        db.expire_all()
        if revision(model) != data.expected_revision:
            raise HTTPException(409, 'Note type changed; reload before saving')
        unique_name(db, user, data, model_id)
        old_fields = json.loads(model.fields_json)
        notes = db.query(Note).filter_by(note_type_id=model.id, user_id=user.id).all()
        # Existing template ordinals identify cards: do not shift them by deleting
        # templates. Additional templates append; edits preserve their card IDs.
        if notes and len(data.templates) < len(json.loads(model.templates_json)):
            raise HTTPException(422, 'Cannot remove templates while notes use this type')
        snapshots = [(n, dict(zip(old_fields, json.loads(n.fields_json))), json.loads(n.tags_json)) for n in notes]
        removed = set(old_fields) - set(data.fields)
        if any(values.get(f) for _, values, _ in snapshots for f in removed):
            raise HTTPException(422, 'Cannot remove a field containing data; copy or clear its values first')
        old_templates = json.loads(model.templates_json)
        if notes and any('{{cloze:' in t['qfmt'] for t in old_templates) != any('{{cloze:' in t.qfmt for t in data.templates):
            raise HTTPException(422, 'Cannot change between cloze and regular templates while notes use this type')
        if model.package_data:
            original = json.loads(model.package_data.payload)
            sort_index = original.get('sortf', 0)
            sort_name = old_fields[sort_index] if isinstance(sort_index, int) and 0 <= sort_index < len(old_fields) else None
            original['sortf'] = data.fields.index(sort_name) if sort_name in data.fields else 0
            original.pop('req', None)
            model.package_data.payload = json.dumps(original)
        assign(model, data)
        for note, values, tags in snapshots:
            update_note(db, note, {f: values.get(f, '') for f in data.fields}, tags)
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from None
    except Exception:
        db.rollback()
        raise
    return response(model)
