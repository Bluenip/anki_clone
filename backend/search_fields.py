"""Read-only field-name lookup for Browser and filtered deck searches."""
import json
from functools import cache
from sqlalchemy import and_, or_, func, false
from models import NoteType, Note, Card


def field_lookup(db, uid):
    @cache
    def lookup(key, argument):
        from browser_search import matches, in_note
        clauses = []
        for model in db.query(NoteType).filter_by(user_id=uid):
            for ordinal, name in enumerate(json.loads(model.fields_json)):
                if name.casefold() == key.casefold():
                    clauses.append(and_(Note.note_type_id == model.id,
                        matches(func.json_extract(Note.fields_json, f'$[{ordinal}]'), argument)))
        legacy = []
        if key.casefold() == 'front': legacy.append(matches(Card.front, argument))
        if key.casefold() == 'back': legacy.append(matches(Card.back, argument))
        if not clauses and not legacy:
            return None
        if len(clauses) > 500:
            raise ValueError('Field search spans too many note types')
        return or_(in_note(or_(*clauses)) if clauses else false(),
                   and_(~Card.note_link.has(), or_(*legacy)) if legacy else false())
    return lookup
