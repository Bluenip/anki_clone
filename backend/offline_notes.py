"""Three-way field merge for offline edits, under the account write lock."""
import hashlib
import json
from fastapi import HTTPException
from note_service import note_response, update_note


def schema_hash(note):
    model = note.note_type
    return hashlib.sha256(json.dumps([model.id, model.fields_json, model.templates_json, model.css], ensure_ascii=False).encode()).hexdigest()


def snapshot(note):
    data = note_response(note)
    return {key: data[key] for key in ('id', 'guid', 'kind', 'fields', 'tags')} | {'schema_hash': schema_hash(note)}


def merge(base, local, remote):
    if local == base: return remote
    if remote == base or remote == local: return local
    raise ValueError('Both devices changed this field')


def apply_edit(db, note, data):
    remote = snapshot(note)
    if note.guid != data.guid or remote['schema_hash'] != data.schema_hash:
        raise HTTPException(409, detail={'message': 'The note identity or note type changed. Download it again before editing.', 'remote': remote, 'fields': []})
    if set(data.base_fields) != set(remote['fields']) or set(data.fields) != set(remote['fields']):
        raise HTTPException(422, 'Supply all fields from the downloaded note')
    fields, conflicts = {}, []
    for name, value in remote['fields'].items():
        try: fields[name] = merge(data.base_fields[name], data.fields[name], value)
        except ValueError: conflicts.append(name)
    # Tags are independent set membership changes, so additions/removals merge.
    base, local, server = set(data.base_tags), set(data.tags), set(remote['tags'])
    tags = sorted((server - (base - local)) | (local - base))
    if conflicts:
        raise HTTPException(409, detail={'message': 'The same fields were edited on both devices.', 'remote': remote, 'fields': conflicts})
    from routers.notes_router import NoteFields
    try: NoteFields(fields=fields, tags=tags)
    except ValueError: raise HTTPException(422, 'Merged note exceeds field or tag limits') from None
    if fields != remote['fields'] or set(tags) != server:
        update_note(db, note, fields, tags)
    return snapshot(note)
