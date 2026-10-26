"""Explicit, loss-aware field mapping for built-in multi-card text imports."""
import csv
import html
import io
import json
import re

from models import Card, Deck, Note, NoteCard, NoteType
from note_service import BUILTINS, builtin_model, create_note_from_model, update_note, values_for
from note_rendering import render_cards
from text_transfer import SEPARATORS


def import_notes_text(db, deck, data, *, commit=True):
    kind = data.kind or 'basic'
    custom = None
    if data.note_type_id is not None:
        if data.kind is not None:
            raise ValueError('Select a kind or note_type_id, not both')
        custom = db.query(NoteType).filter_by(id=data.note_type_id, user_id=deck.user_id).first()
        if custom is None:
            raise ValueError('Note type not found')
    definition = {'name': custom.name, 'fields': json.loads(custom.fields_json),
                  'templates': json.loads(custom.templates_json)} if custom else BUILTINS[kind]
    mapping = data.field_columns or {name: i for i, name in enumerate(definition['fields'])}
    if set(mapping) != set(definition['fields']):
        raise ValueError('Map exactly the fields defined by the selected note type')
    separator, allow_html = data.separator, data.allow_html
    guid_column, tags_column = data.guid_column, data.tags_column
    tags = list(data.tags)
    stream = io.StringIO(data.text.removeprefix('\ufeff'), newline='')
    columns = None
    while True:
        position = stream.tell()
        line = stream.readline()
        if not line.startswith('#'):
            stream.seek(position)
            break
        directive = line.rstrip('\r\n')[1:]
        if ':' not in directive:
            continue
        key, value = directive.split(':', 1)
        key, value = key.strip().lower(), value.strip()
        if key == 'separator':
            separator = next((delimiter for name, delimiter in SEPARATORS.items() if name.lower() == value.lower()), value)
        elif key == 'html':
            if value.lower() not in ('true', 'false'):
                raise ValueError('Invalid #html directive')
            allow_html = value.lower() == 'true'
        elif key in ('guid column', 'tags column'):
            try:
                column = int(value) - 1
            except ValueError:
                raise ValueError(f'Invalid #{key} directive') from None
            if key == 'guid column':
                guid_column = column
            else:
                tags_column = column
        elif key == 'tags':
            tags.extend(value.split())
        elif key == 'notetype':
            if value != definition['name']:
                raise ValueError('The #notetype directive must match the selected note type')
        elif key == 'columns':
            columns = value
        else:
            raise ValueError(f'Unsupported text directive #{key}')
    if len(separator) != 1 or separator in '\r\n\0"':
        raise ValueError('Invalid separator')
    if data.field_columns is None:
        special = {c for c in (guid_column, tags_column) if c is not None}
        regular = [i for i in range(len(definition['fields']) + len(special)) if i not in special]
        mapping = dict(zip(definition['fields'], regular))
    selected = list(mapping.values()) + [c for c in (guid_column, tags_column) if c is not None]
    if any(type(c) is not int or not 0 <= c < 100 for c in selected) or len(set(selected)) != len(selected):
        raise ValueError('Mapped columns must be distinct indexes between 0 and 99')
    if set(selected) != set(range(len(selected))):
        raise ValueError('Every source column must be mapped; unmapped fields cannot be discarded')
    model = custom or db.query(NoteType).filter_by(user_id=deck.user_id, name=definition['name']).first()
    if model and (json.loads(model.fields_json) != definition['fields'] or json.loads(model.templates_json) != definition['templates']):
        raise ValueError('A different note type already uses this built-in name')
    # A transient model keeps previews read-only, including the very first import.
    model = model or NoteType(name=definition['name'], fields_json=json.dumps(definition['fields']),
                             templates_json=json.dumps(definition['templates']), css='')
    notes = db.query(Note).filter_by(user_id=deck.user_id).all()
    by_guid = {n.guid: n for n in notes}
    legacy_cards = []
    if custom is None and kind == 'basic':
        from notes import legacy_guid
        legacy_cards = (db.query(Card).join(Deck).outerjoin(NoteCard, NoteCard.card_id == Card.id)
                        .filter(Deck.user_id == deck.user_id, NoteCard.card_id.is_(None)).all())
        by_guid.update({legacy_guid(card, deck.user_id): card for card in legacy_cards})
    by_first = {}
    for note in notes:
        if note.note_type.name == model.name and (data.match_scope == 'collection' or any(link.card.deck_id == deck.id for link in note.card_links)):
            values = json.loads(note.fields_json)
            by_first.setdefault(tuple(values) if data.match_fields == 'all' else values[0], []).append(note)
    for card in legacy_cards:
        if data.match_scope == 'collection' or card.deck_id == deck.id:
            by_first.setdefault((card.front, card.back) if data.match_fields == 'all' else card.front, []).append(card)
    plan, seen, targets = [], set(), set()
    counts = dict(added=0, updated=0, skipped=0)
    reader = csv.reader(stream, delimiter=separator, strict=True)
    try:
        if columns is not None and len(next(csv.reader([columns], delimiter=separator, strict=True))) != len(selected):
            raise ValueError('Column header count does not match the field mapping')
        if data.has_header:
            next(reader, None)
        for row in reader:
            if not row or all(not cell for cell in row):
                continue
            if len(row) != len(selected):
                raise ValueError(f'Record line {reader.line_num}: expected {len(selected)} columns, got {len(row)}')
            fields = {name: row[index] for name, index in mapping.items()}
            if not allow_html:
                fields = {k: html.escape(v).replace('\r\n', '\n').replace('\n', '<br>') for k, v in fields.items()}
            if any(len(v) > 50000 for v in fields.values()):
                raise ValueError('Field exceeds 50,000 characters')
            row_tags = list(dict.fromkeys(tags + (row[tags_column].split() if tags_column is not None else [])))
            if len(row_tags) > 100 or any(not t or len(t) > 100 or any(c.isspace() for c in t) for t in row_tags):
                raise ValueError('Tags must be nonempty names without whitespace (max 100)')
            guid = row[guid_column] if guid_column is not None else None
            if guid is not None and not re.fullmatch(r'[!-~]{1,100}', guid):
                raise ValueError('Invalid GUID')
            values = values_for(model, fields)
            render_cards(model, values, deck.user_id, row_tags, deck.name)
            match_key = tuple(values) if data.match_fields == 'all' else values[0]
            identity = ('guid', guid) if guid else ('fields', match_key)
            if identity in seen and (guid or data.duplicate_policy != 'add'):
                raise ValueError('Input contains repeated note identity')
            seen.add(identity)
            existing = by_guid.get(guid) if guid else None
            if not guid and data.duplicate_policy != 'add':
                matches = by_first.get(match_key, [])
                if len(matches) > 1:
                    raise ValueError('Ambiguous first field; use GUIDs to update')
                existing = matches[0] if matches else None
            legacy = isinstance(existing, Card)
            wrong_target = existing and ((data.match_scope == 'deck' and existing.deck_id != deck.id) if legacy else (existing.note_type.name != model.name or data.match_scope == 'deck' and any(link.card.deck_id != deck.id for link in existing.card_links)))
            if wrong_target:
                raise ValueError('Existing GUID belongs to another note type or deck')
            if existing and data.duplicate_policy == 'add':
                raise ValueError('GUID already exists; select Skip or Update')
            target = ('card' if legacy else 'note', existing.id) if existing else None
            if target in targets:
                raise ValueError('Several records target the same note')
            if existing:
                targets.add(target)
            action = 'added' if existing is None else 'skipped' if data.duplicate_policy == 'skip' else 'updated'
            if existing and tags_column is None and not tags:
                row_tags = [] if legacy else json.loads(existing.tags_json)
            if action == 'updated' and not legacy:
                from models import StudyProgress
                rendered = render_cards(model, values, deck.user_id, row_tags, deck.name)
                removed = [link.card_id for link in existing.card_links if link.template_ord not in rendered]
                if removed and db.query(StudyProgress.id).filter(StudyProgress.card_id.in_(removed)).first():
                    raise ValueError('This update would remove a card with study progress')
            counts[action] += 1
            plan.append((action, fields, row_tags, guid, existing))
            if len(plan) > 10000:
                raise ValueError('At most 10,000 notes may be imported at once')
    except csv.Error as exc:
        raise ValueError(f'Invalid CSV near line {reader.line_num}: {exc}') from None
    if not plan:
        raise ValueError('No notes found')
    if not data.preview:
        for action, fields, row_tags, guid, existing in plan:
            if action == 'added':
                persisted_model = custom or builtin_model(db, deck.user_id, kind)
                note = create_note_from_model(db, deck, persisted_model, fields, row_tags)
                if guid:
                    note.guid = guid
            elif action == 'updated':
                if isinstance(existing, Card):
                    from notes import attach_basic_note
                    existing = attach_basic_note(db, existing, deck.user_id)
                update_note(db, existing, fields, row_tags)
        if commit:
            db.commit()
    return {**counts, 'preview': data.preview, 'records': len(plan),
            'message': f"{'Preview' if data.preview else 'Imported'}: {counts['added']} added, {counts['updated']} updated, {counts['skipped']} skipped."}
