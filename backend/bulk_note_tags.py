"""Transactional note-level tags for Browser card selections.

The caller owns the transaction. Every sibling version is advanced so stale
review/undo/edit operations cannot overwrite changes to a shared note.
"""
import json
from fastapi import HTTPException
from notes import attach_basic_note
from review_service import state_for, claim_version
from note_rendering import render_cards


def change_tags(db, cards, expected, user_id, action, tags):
    # Acquire selected versions before creating legacy note metadata or editing tags.
    for card in cards:
        state = state_for(db, card)
        claim_version(db, state, expected[card.id])
    notes = {}
    for card in cards:
        note = attach_basic_note(db, card, user_id)
        if note.user_id != user_id:
            raise HTTPException(status_code=404, detail='Note not found')
        notes[note.id] = note
    siblings = {link.card_id: link.card for note in notes.values() for link in note.card_links}
    if len(siblings) > 1000:
        raise HTTPException(status_code=422, detail='Too many sibling cards (maximum 1000); select fewer notes')
    for cid, card in sorted(siblings.items()):
        if card.deck.user_id != user_id:
            raise HTTPException(status_code=404, detail='Note card not found')
        if cid not in expected:
            state = state_for(db, card)
            claim_version(db, state, state.version)
    requested = {tag.casefold(): tag for tag in tags}
    for note in notes.values():
        previous = json.loads(note.tags_json)
        merged = {tag.casefold(): tag for tag in previous}
        if action == 'add_tags':
            for key, tag in requested.items():
                merged.setdefault(key, tag)
        else:
            # Anki removes a named tag together with its descendant tags.
            merged = {key: tag for key, tag in merged.items()
                      if not any(key == parent or key.startswith(parent + '::') for parent in requested)}
        updated = list(merged.values())
        if len(updated) > 100:
            raise HTTPException(status_code=422, detail='A note would exceed 100 tags')
        fields = json.loads(note.fields_json)
        if len(fields) != len(json.loads(note.note_type.fields_json)):
            raise ValueError('Note fields do not match its note type')
        # Plain legacy Basic cards have no tag-dependent rendered cache.
        if note.package_data and json.loads(note.package_data.payload).get('_web_rendered'):
            rendered_by_deck = {}
            for link in note.card_links:
                card = link.card
                if card.deck_id not in rendered_by_deck:
                    before = render_cards(note.note_type, fields, user_id, previous, card.deck.name)
                    after = render_cards(note.note_type, fields, user_id, updated, card.deck.name)
                    if set(before) != set(after):
                        raise ValueError('Tag change would add or remove generated cards; use the note editor')
                    rendered_by_deck[card.deck_id] = after
                rendered = rendered_by_deck[card.deck_id]
                if link.template_ord not in rendered:
                    raise ValueError('An existing card has an empty template; inspect its note first')
                card.front, card.back = rendered[link.template_ord]
        note.tags_json = json.dumps(updated, ensure_ascii=False)
    return {'updated': len(siblings), 'updated_notes': len(notes)}
