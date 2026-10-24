"""Preflight imports before any write; changes and metadata commit together."""
import json
from sqlalchemy.orm import joinedload
from models import Card, Deck, NoteCard
from notes import attach_basic_note, card_guid, new_guid, sync_basic_note
from text_transfer import parse_text


def import_text(db, deck, data):
    for line in data.text.removeprefix('\ufeff').splitlines():
        if not line.startswith('#'):
            break
        if line.partition(':')[0].strip().lower() in ('#notetype column', '#deck column', '#deck'):
            from mixed_text_import import import_mixed_text
            return import_mixed_text(db, deck, data)
    # Our multi-field exports carry an Anki note type directive. Detect only
    # leading directives, never text inside a quoted CSV record.
    if data.kind is None and data.note_type_id is None:
        advanced_headers = False
        detected = {}
        for line in data.text.removeprefix('\ufeff').splitlines():
            if not line.startswith('#'):
                break
            key, _, value = line.partition(':')
            key = key.strip().lower()
            if key in ('#tags', '#tags column'):
                advanced_headers = True
            if key == '#notetype':
                name = value.strip()
                from mixed_text_import import resolve_type
                kind, model_id, _, _ = resolve_type(db, deck.user_id, name, data)
                detected = {'note_type_id': model_id} if model_id is not None else {'kind': kind}
        if detected or advanced_headers:
            data = data.model_copy(update=detected or {'kind': 'basic'})
    if data.kind is not None or data.note_type_id is not None or data.field_columns is not None or data.tags_column is not None or data.tags:
        from note_text_import import import_notes_text
        return import_notes_text(db, deck, data)
    rows = parse_text(data.text, data.separator, data.front_column, data.back_column,
                      data.guid_column, data.has_header, data.allow_html)
    cards = (db.query(Card).join(Deck).filter(Deck.user_id == deck.user_id)
             .options(joinedload(Card.note_link).joinedload(NoteCard.note)).all())
    by_guid = {card_guid(card, deck.user_id): card for card in cards}
    by_front = {}
    for card in cards:
        if card.deck_id == deck.id:
            by_front.setdefault(card.front, []).append(card)
    plan, seen, target_ids = [], set(), set()
    counts = {'added': 0, 'updated': 0, 'skipped': 0}
    for row in rows:
        key = ('guid', row.guid) if row.guid else ('front', row.front)
        if key in seen and (row.guid or data.duplicate_policy != 'add'):
            raise ValueError(f'Input contains repeated note identity near line {row.line}; resolve duplicates before importing')
        seen.add(key)
        existing = by_guid.get(row.guid) if row.guid else None
        if existing and existing.deck_id != deck.id:
            raise ValueError('A GUID already belongs to another deck; this import will not move or overwrite it')
        if existing and data.duplicate_policy == 'add':
            raise ValueError('A GUID already exists; select Skip or Update instead of Add')
        if not row.guid and data.duplicate_policy != 'add':
            matches = by_front.get(row.front, [])
            if len(matches) > 1:
                raise ValueError('Multiple notes have the same first field; export with GUIDs to update unambiguously')
            existing = matches[0] if matches else None
        if existing and existing.id in target_ids:
            raise ValueError('Several input records target the same note; resolve duplicate records first')
        if existing:
            target_ids.add(existing.id)
        action = 'added' if existing is None else ('skipped' if data.duplicate_policy == 'skip' else 'updated')
        if action == 'updated' and existing.note_link:
            # This initial transfer endpoint handles Basic notes only.
            note = existing.note_link.note
            if note.note_type.name != 'Basic' or json.loads(note.note_type.fields_json) != ['Front', 'Back'] or len(note.card_links) != 1:
                raise ValueError('Updating custom or multi-card notes through two-field text import is not supported')
            if note.package_data and json.loads(note.package_data.payload).get('_web_rendered'):
                from note_rendering import render_cards
                rendered=render_cards(note.note_type,[row.front,row.back],deck.user_id,json.loads(note.tags_json),existing.deck.name)
                if set(rendered)!={existing.note_link.template_ord}:
                    raise ValueError('This text update would change the note card structure')
        counts[action] += 1
        plan.append((action, row, existing))
    if not data.preview:
        for action, row, card in plan:
            if action == 'added':
                card = Card(deck_id=deck.id, front=row.front, back=row.back)
                db.add(card)
                attach_basic_note(db, card, deck.user_id, guid=row.guid or new_guid())
            elif action == 'updated':
                note=card.note_link.note if card.note_link else None
                if note and note.package_data and json.loads(note.package_data.payload).get('_web_rendered'):
                    from note_service import update_note
                    update_note(db,note,{'Front':row.front,'Back':row.back},json.loads(note.tags_json))
                else:
                    card.front, card.back = row.front, row.back
                    sync_basic_note(db, card, deck.user_id)
        db.commit()
    return {**counts, 'preview': data.preview, 'records': len(rows),
            'message': f"{'Preview' if data.preview else 'Imported'}: {counts['added']} added, {counts['updated']} updated, {counts['skipped']} skipped."}
