"""Basic note identity while legacy front/back API remains compatible.

New writes get persistent note GUIDs. Legacy exports use a deterministic fallback
without writing on GET. No real collection is backfilled automatically.
"""
import json
import secrets
import string
import uuid

from models import Note, NoteCard, NoteType
from sqlalchemy.dialects.sqlite import insert


def legacy_guid(card, user_id):
    key = f"anki-clone:{user_id}:{card.id}:{card.created_at.isoformat()}"
    return uuid.uuid5(uuid.NAMESPACE_URL, key).hex


def card_guid(card, user_id):
    return card.note_link.note.guid if card.note_link else legacy_guid(card, user_id)


def basic_type(db, user_id):
    model = db.query(NoteType).filter_by(user_id=user_id, name="Basic").first()
    if model is None:
        # SQLite is the application's configured database. A concurrent request
        # may have inserted Basic after the SELECT; never roll back its Card.
        db.execute(insert(NoteType).values(
            user_id=user_id, name="Basic", fields_json='["Front", "Back"]', css="",
            templates_json=json.dumps([{"name": "Card 1", "qfmt": "{{Front}}",
                                       "afmt": "{{FrontSide}}<hr id=answer>{{Back}}"}])
        ).on_conflict_do_nothing(index_elements=['user_id', 'name']))
        model = db.query(NoteType).filter_by(user_id=user_id, name="Basic").one()
    return model


def attach_basic_note(db, card, user_id, guid=None):
    if card.note_link:
        return card.note_link.note
    db.flush()
    if guid is None:
        guid = legacy_guid(card, user_id)
    model = basic_type(db, user_id)
    note = Note(user_id=user_id, note_type_id=model.id, guid=guid,
                fields_json=json.dumps([card.front, card.back], ensure_ascii=False))
    db.add(note)
    db.flush()
    card.note_link = NoteCard(note=note, template_ord=0)
    db.flush()
    return note


def new_guid():
    alphabet = string.ascii_letters + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(10))


def sync_basic_note(db, card, user_id, expected_version=None):
    note = attach_basic_note(db, card, user_id)
    if note.package_data and json.loads(note.package_data.payload).get('_web_rendered'):
        raise ValueError("Edit the original note fields, not this rendered card")
    # Never collapse an imported/custom model into a Basic note.
    if json.loads(note.note_type.fields_json) != ["Front", "Back"] or len(note.card_links) != 1:
        raise ValueError("This note must be edited through its note fields")
    note.fields_json = json.dumps([card.front, card.back], ensure_ascii=False)
    from review_service import state_for, claim_version
    state = state_for(db, card)
    claim_version(db, state, expected_version if expected_version is not None else state.version)
    return note


def cleanup_empty_notes(db, user_id):
    db.flush()
    for note in db.query(Note).filter(Note.user_id == user_id, ~Note.card_links.any()).all():
        db.delete(note)
