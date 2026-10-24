"""Anki text metadata columns, with read-only preflight and one atomic commit."""
import csv
import io
import json

from models import Deck, DeckOptionsBinding, NoteType
from note_service import BUILTINS
from note_text_import import import_notes_text
from schemas import DeckCreate
from text_transfer import SEPARATORS


def resolve_type(db, user_id, name, data):
    if not name:
        if data.note_type_id is not None:
            model = db.query(NoteType).filter_by(id=data.note_type_id, user_id=user_id).first()
            if model is None:
                raise ValueError('Note type not found')
            return None, model.id, json.loads(model.fields_json), model.name
        kind = data.kind or 'basic'
        return kind, None, BUILTINS[kind]['fields'], BUILTINS[kind]['name']
    model = db.query(NoteType).filter_by(user_id=user_id, name=name).first()
    if model is None and name.isdecimal():
        model = db.query(NoteType).filter_by(user_id=user_id, id=int(name)).first()
    for kind, definition in BUILTINS.items():
        if (model.name if model is not None else name) == definition['name'] and (model is None or (
                json.loads(model.fields_json) == definition['fields'] and
                json.loads(model.templates_json) == definition['templates'])):
            return kind, None, definition['fields'], definition['name']
    if model is not None:
        return None, model.id, json.loads(model.fields_json), model.name
    raise ValueError(f'Unknown note type {name!r}; import its templates with APKG first')


def import_mixed_text(db, selected_deck, data):
    stream = io.StringIO(data.text.removeprefix('\ufeff'), newline='')
    headers = {}
    allowed = {'separator', 'html', 'columns', 'tags', 'guid column', 'tags column',
               'notetype column', 'deck column', 'notetype', 'deck'}
    while True:
        position = stream.tell()
        line = stream.readline()
        if not line.startswith('#'):
            stream.seek(position)
            break
        key, colon, value = line.rstrip('\r\n')[1:].partition(':')
        if not colon:
            continue
        key, value = key.strip().lower(), value.strip()
        if key not in allowed:
            raise ValueError(f'Unsupported text directive #{key}')
        if key in headers:
            raise ValueError(f'Repeated text directive #{key}')
        headers[key] = value
    separator = headers.get('separator', data.separator)
    separator = next((value for key, value in SEPARATORS.items() if key.lower() == separator.lower()), separator)
    if len(separator) != 1 or separator in '\r\n\0"':
        raise ValueError('Invalid separator')
    html_value = headers.get('html', str(data.allow_html)).lower()
    if html_value not in ('true', 'false'):
        raise ValueError('Invalid #html directive')
    specials = {}
    for name, fallback in [('guid', data.guid_column), ('tags', data.tags_column), ('notetype', None), ('deck', None)]:
        raw = headers.get(f'{name} column')
        try:
            index = int(raw) - 1 if raw is not None else fallback
        except ValueError:
            raise ValueError(f'Invalid #{name} column directive') from None
        if index is not None:
            if type(index) is not int or not 0 <= index < 100:
                raise ValueError('Metadata column indexes must be between 1 and 100')
            specials[name] = index
    if len(set(specials.values())) != len(specials):
        raise ValueError('Metadata columns must be distinct')
    if ('deck' in specials or 'deck' in headers) and not data.use_file_decks:
        raise ValueError('Enable "Use deck names from file" to honor deck metadata; no data imported')
    if 'notetype' in specials and (data.kind is not None or data.note_type_id is not None or data.field_columns is not None):
        raise ValueError('Disable advanced mapping to use the file\'s per-row note types')
    reader = csv.reader(stream, delimiter=separator, strict=True)
    try:
        if data.has_header:
            next(reader, None)
        rows = [row for row in reader if row and any(row)]
        column_labels = next(csv.reader([headers['columns']], delimiter=separator, strict=True)) if 'columns' in headers else None
    except csv.Error as exc:
        raise ValueError(f'Invalid CSV near line {reader.line_num}: {exc}') from None
    if not rows or len(rows) > 10000:
        raise ValueError('Import requires between 1 and 10,000 notes')
    width = len(column_labels) if column_labels is not None else max(map(len, rows))
    if width > 100 or any(index >= width for index in specials.values()) or any(len(row) > width for row in rows):
        raise ValueError('Invalid source column count; no fields may be discarded')
    regular = [index for index in range(width) if index not in specials.values()]
    known_decks = {deck.name: deck for deck in db.query(Deck).filter_by(user_id=selected_deck.user_id).all()}
    decks_by_id = {str(deck.id): deck for deck in known_decks.values()}
    groups, new_decks, seen_guids = {}, set(), set()
    global_tags = headers.get('tags', '').split()
    for source in rows:
        row = source + [''] * (width - len(source))
        type_name = row[specials['notetype']].strip() if 'notetype' in specials else headers.get('notetype', '')
        if 'notetype' in specials and not type_name:
            type_name = headers.get('notetype', '')
            if not type_name:
                raise ValueError('A note type column is empty')
        kind, model_id, fields, resolved_name = resolve_type(db, selected_deck.user_id, type_name, data)
        if type_name and 'notetype' not in specials and (data.kind is not None or data.note_type_id is not None):
            _, _, _, selected_name = resolve_type(db, selected_deck.user_id, '', data)
            if resolved_name != selected_name:
                raise ValueError('The #notetype directive must match the selected note type')
        target = selected_deck
        if 'deck' in specials or 'deck' in headers:
            raw_deck = row[specials['deck']].strip() if 'deck' in specials else headers['deck']
            raw_deck = raw_deck or headers.get('deck', '')
            if raw_deck:
                target = known_decks.get(raw_deck) or decks_by_id.get(raw_deck)
                if target is None:
                    name = DeckCreate(name=raw_deck).name
                    target = known_decks.get(name)
                    if target is None:
                        # Transient decks are never attached to the session in preview.
                        target = Deck(id=-(len(new_decks) + 1), user_id=selected_deck.user_id, name=name, settings='{}')
                        known_decks[name] = target
                        parts = name.split('::')
                        for length in range(1, len(parts) + 1):
                            prefix = '::'.join(parts[:length])
                            if prefix not in known_decks or prefix == name:
                                new_decks.add(prefix)
        if data.field_columns is not None:
            if set(data.field_columns) != set(fields):
                raise ValueError('Map exactly the fields defined by the selected note type')
            indexes = [data.field_columns[field] for field in fields]
            if len(set(indexes)) != len(indexes) or set(indexes) != set(regular):
                raise ValueError('Every regular source column must be mapped exactly once')
            values = [row[index] for index in indexes]
        else:
            values = [row[index] for index in regular]
            if any(values[len(fields):]):
                raise ValueError(f'Nonempty extra field for note type {type_name!r}; no data imported')
            values = values[:len(fields)] + [''] * max(0, len(fields) - len(values))
        guid = row[specials['guid']] if 'guid' in specials else None
        if guid is not None:
            if guid in seen_guids:
                raise ValueError('Input contains repeated GUIDs across note types or decks')
            seen_guids.add(guid)
        tags = row[specials['tags']] if 'tags' in specials else None
        key = (target.name, kind, model_id)
        group = groups.setdefault(key, {'deck': target, 'rows': [], 'fields': fields})
        if len(groups) > 100:
            raise ValueError('At most 100 note-type/deck combinations may be imported at once')
        group['rows'].append(values + ([tags] if tags is not None else []) + ([guid] if guid is not None else []))
    totals = dict(added=0, updated=0, skipped=0)
    prepared = []
    for (_, kind, model_id), group in groups.items():
        output = io.StringIO(newline='')
        csv.writer(output, delimiter='\t', lineterminator='\n', quoting=csv.QUOTE_ALL).writerows(group['rows'])
        size = len(group['fields'])
        child = data.model_copy(update={'text': output.getvalue(), 'kind': kind, 'note_type_id': model_id,
            'separator': '\t', 'has_header': False, 'allow_html': html_value == 'true',
            'field_columns': {field: index for index, field in enumerate(group['fields'])},
            'tags_column': size if 'tags' in specials else None,
            'guid_column': size + int('tags' in specials) if 'guid' in specials else None,
            'tags': data.tags + global_tags, 'preview': True})
        result = import_notes_text(db, group['deck'], child)
        for key in totals:
            totals[key] += result[key]
        prepared.append((group['deck'], child))
    if not data.preview:
        from routers.decks_router import ensure_parents
        for target, child in prepared:
            if target.id < 0:
                existing = db.query(Deck).filter_by(user_id=selected_deck.user_id, name=target.name).first()
                if existing is None:
                    parent = ensure_parents(db, selected_deck.user_id, target.name)
                    existing = Deck(user_id=selected_deck.user_id, name=target.name, settings=parent.settings if parent else '{}')
                    if parent and parent.options_binding and parent.options_binding.preset:
                        existing.options_binding = DeckOptionsBinding(preset=parent.options_binding.preset, overrides_json='{}', today_json='{}')
                    db.add(existing)
                    db.flush()
                target = existing
            import_notes_text(db, target, child.model_copy(update={'preview': False}), commit=False)
        db.commit()
    return {**totals, 'preview': data.preview, 'records': len(rows), 'new_decks': sorted(new_decks),
            'message': f"{'Preview' if data.preview else 'Imported'}: {totals['added']} added, {totals['updated']} updated, {totals['skipped']} skipped. "
                       f"{len(new_decks)} new deck(s): {', '.join(sorted(new_decks))}"}
