import json
import hashlib
from sqlalchemy.dialects.sqlite import insert
from models import Card, Note, NoteCard, NoteType, StudyProgress, PackageNote
from notes import new_guid
from note_rendering import render_cards
import image_occlusion


BUILTINS = {
    'image_occlusion': {'name': 'Image Occlusion', 'fields': image_occlusion.FIELDS, 'templates': image_occlusion.TEMPLATES},
    'typed': {'name': 'Basic (type in the answer)', 'fields': ['Front', 'Back'], 'templates': [
        {'name': 'Card 1', 'qfmt': '{{Front}}<br>{{type:Back}}', 'afmt': '{{FrontSide}}<hr id=answer>{{Back}}'}]},
    'basic': {'name': 'Basic', 'fields': ['Front', 'Back'], 'templates': [
        {'name': 'Card 1', 'qfmt': '{{Front}}', 'afmt': '{{FrontSide}}<hr id=answer>{{Back}}'}]},
    'reversed': {'name': 'Basic (and reversed card)', 'fields': ['Front', 'Back'], 'templates': [
        {'name': 'Card 1', 'qfmt': '{{Front}}', 'afmt': '{{FrontSide}}<hr id=answer>{{Back}}'},
        {'name': 'Card 2', 'qfmt': '{{Back}}', 'afmt': '{{FrontSide}}<hr id=answer>{{Front}}'}]},
    'optional_reversed': {'name': 'Basic (optional reversed card)', 'fields': ['Front', 'Back', 'Add Reverse'], 'templates': [
        {'name': 'Card 1', 'qfmt': '{{Front}}', 'afmt': '{{FrontSide}}<hr id=answer>{{Back}}'},
        {'name': 'Card 2', 'qfmt': '{{#Add Reverse}}{{Back}}{{/Add Reverse}}', 'afmt': '{{FrontSide}}<hr id=answer>{{Front}}'}]},
    'cloze': {'name': 'Cloze', 'fields': ['Text', 'Extra'], 'templates': [
        {'name': 'Cloze', 'qfmt': '{{cloze:Text}}', 'afmt': '{{cloze:Text}}<hr id=answer>{{Extra}}'}]},
}


def builtin_model(db, user_id, kind):
    definition = BUILTINS[kind]
    db.execute(insert(NoteType).values(user_id=user_id, name=definition['name'],
        fields_json=json.dumps(definition['fields']), templates_json=json.dumps(definition['templates']),
        css=image_occlusion.CSS if kind == 'image_occlusion' else '.cloze {color:#77b7ff;font-weight:bold}').on_conflict_do_nothing(index_elements=['user_id', 'name']))
    model = db.query(NoteType).filter_by(user_id=user_id, name=definition['name']).one()
    if json.loads(model.fields_json) != definition['fields'] or json.loads(model.templates_json) != definition['templates']:
        raise ValueError('A different note type already uses this built-in name')
    return model


def kind_for(model):
    if json.loads(model.fields_json) == image_occlusion.FIELDS and image_occlusion.is_occlusion(json.loads(model.templates_json)):
        return 'image_occlusion'
    for kind, definition in BUILTINS.items():
        if kind != 'image_occlusion' and model.name == definition['name'] and json.loads(model.fields_json) == definition['fields']:
            return kind
    return 'custom'


def values_for(model, fields):
    names = json.loads(model.fields_json)
    if set(names) != set(fields):
        raise ValueError('Supply exactly the fields defined by this note type')
    values = [fields[name] for name in names]
    kind = kind_for(model)
    required = ['Image', 'Occlusion'] if kind == 'image_occlusion' else ['Text'] if kind == 'cloze' else ['Front'] if kind in BUILTINS else []
    if any(not fields[name].strip() for name in required):
        raise ValueError('Required note fields cannot be empty')
    return values


def create_note(db, deck, kind, fields, tags):
    model = builtin_model(db, deck.user_id, kind)
    return create_note_from_model(db, deck, model, fields, tags)


def create_note_from_model(db, deck, model, fields, tags):
    values = values_for(model, fields)
    rendered = render_cards(model, values, deck.user_id, tags, deck.name)
    note = Note(user_id=deck.user_id, note_type=model, guid=new_guid(),
                fields_json=json.dumps(values, ensure_ascii=False), tags_json=json.dumps(tags, ensure_ascii=False))
    note.package_data = PackageNote(payload=json.dumps({'_web_rendered': True}))
    db.add(note)
    for ordinal, (front, back) in rendered.items():
        card = Card(deck_id=deck.id, front=front, back=back)
        db.add(card)
        note.card_links.append(NoteCard(card=card, template_ord=ordinal))
    db.flush()
    return note


def update_note(db, note, fields, tags):
    values = values_for(note.note_type, fields)
    links = {link.template_ord: link for link in note.card_links}
    if not links:
        raise ValueError('Note has no cards')
    deck = next(iter(links.values())).card.deck
    rendered = render_cards(note.note_type, values, note.user_id, tags, deck.name)
    by_deck = {deck.id: rendered.copy()}
    # Siblings can live in different decks. Re-render existing cards in their
    # own context, including Deck-dependent conditional templates.
    for ordinal, link in links.items():
        home = link.card.deck
        if home.id not in by_deck:
            by_deck[home.id] = render_cards(note.note_type, values, note.user_id, tags, home.name)
        if ordinal in by_deck[home.id]:
            rendered[ordinal] = by_deck[home.id][ordinal]
        else:
            rendered.pop(ordinal, None)
    removed = [link for ordinal, link in links.items() if ordinal not in rendered]
    if removed and db.query(StudyProgress.id).filter(StudyProgress.card_id.in_([link.card_id for link in removed])).first():
        raise ValueError('This edit would remove a card with study progress; keep its cloze/reverse field or manage that card explicitly')
    # All rendering/validation is complete before modifying the note or cards.
    note.fields_json, note.tags_json = json.dumps(values, ensure_ascii=False), json.dumps(tags, ensure_ascii=False)
    source = json.loads(note.package_data.payload) if note.package_data else {}
    source['_web_rendered'] = True
    if note.package_data:
        note.package_data.payload = json.dumps(source)
    else:
        note.package_data = PackageNote(payload=json.dumps(source))
    for link in removed:
        note.card_links.remove(link)
        db.delete(link.card)
    for ordinal, (front, back) in rendered.items():
        if ordinal in links:
            card = links[ordinal].card
            from review_service import state_for, claim_version
            state = state_for(db, card)
            claim_version(db, state, state.version)
            card.front, card.back = front, back
        else:
            note.card_links.append(NoteCard(card=Card(deck_id=deck.id, front=front, back=back), template_ord=ordinal))
    db.flush()
    return note


def note_revision(note):
    """Read-only snapshot token: any changed sibling or source invalidates an editor."""
    model = note.note_type
    snapshot = [note.id, note.guid, note.fields_json, note.tags_json,
                model.id, model.fields_json, model.templates_json, model.css,
                [(link.card_id, link.template_ord, link.card.deck_id,
                  link.card.scheduling.version if link.card.scheduling else 0)
                 for link in sorted(note.card_links, key=lambda link: link.card_id)]]
    return hashlib.sha256(json.dumps(snapshot, ensure_ascii=False).encode()).hexdigest()


def lock_note_revision(db, note, expected):
    # SQLite is the configured database. Acquire its write lock BEFORE refreshing
    # the snapshot, so another writer cannot change siblings between check/save.
    # This avoids a schema migration and covers legacy/import/tag mutations too.
    from sqlalchemy import update
    from fastapi import HTTPException
    result = db.execute(update(Note).where(Note.id == note.id, Note.user_id == note.user_id)
                        .values(id=Note.id).execution_options(synchronize_session=False))
    if result.rowcount != 1:
        raise HTTPException(status_code=404, detail='Note not found')
    db.expire_all()
    if note_revision(note) != expected:
        raise HTTPException(status_code=409, detail='This note changed in another tab; reload the latest note before saving')


def note_response(note):
    return {'id': note.id, 'guid': note.guid, 'kind': kind_for(note.note_type), 'revision': note_revision(note),
            'fields': dict(zip(json.loads(note.note_type.fields_json), json.loads(note.fields_json))),
            'tags': json.loads(note.tags_json), 'css': note.note_type.css,
            'cards': [{'id': link.card.id, 'deck_id': link.card.deck_id, 'front': link.card.front,
                       'back': link.card.back, 'template_ord': link.template_ord}
                      for link in sorted(note.card_links, key=lambda link: link.template_ord)]}
