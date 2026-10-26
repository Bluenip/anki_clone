"""Account-scoped snapshots for guarded undo/restore; never include credentials."""
import hashlib
import json
from datetime import datetime
from sqlalchemy import select, delete
import models as m

# Dependency order. User IDs remain attached to the same authenticated account.
TABLES = [m.OptionPreset, m.Deck, m.NoteType, m.PackageModel, m.PackageDeck, m.DeckOptionsBinding,
          m.Note, m.PackageNote, m.Card, m.NoteCard, m.StudyProgress, m.SchedulerState, m.PackageCard,
          m.ReviewLog, m.ReviewRecord, m.FilteredSession, m.FilteredDefinition, m.FilteredItem, m.StudyOperation, m.SharedDeck]


def scoped_ids(db, uid):
    decks = select(m.Deck.id).where(m.Deck.user_id == uid)
    cards = select(m.Card.id).where(m.Card.deck_id.in_(decks))
    notes = select(m.Note.id).where(m.Note.user_id == uid)
    types = select(m.NoteType.id).where(m.NoteType.user_id == uid)
    logs = select(m.ReviewLog.id).where(m.ReviewLog.user_id == uid)
    return decks, cards, notes, types, logs


def condition(model, uid, ids):
    decks, cards, notes, types, logs = ids
    table = model.__table__
    if 'session_id' in table.c and model is m.FilteredDefinition: return table.c.session_id.in_(select(m.FilteredSession.id).where(m.FilteredSession.user_id == uid))
    if 'user_id' in table.c: return table.c.user_id == uid
    for key, values in [('card_id', cards), ('note_id', notes), ('note_type_id', types), ('deck_id', decks), ('review_log_id', logs)]:
        if key in table.c: return table.c[key].in_(values)
    raise ValueError('Unscoped snapshot table')


def capture(db, uid):
    db.flush()
    ids = scoped_ids(db, uid)
    result = {}
    count = 0
    for model in TABLES:
        table = model.__table__
        rows = db.execute(select(table).where(condition(model, uid, ids)).order_by(*table.primary_key.columns)).mappings().all()
        count += len(rows)
        if count > 1000000: raise ValueError('Collection snapshot exceeds one million records')
        result[table.name] = [{key: value.isoformat() if isinstance(value, datetime) else value for key, value in row.items()} for row in rows]
    if len(json.dumps(result)) > 100 * 1024 * 1024: raise ValueError('Collection snapshot exceeds 100 MB')
    return result


def fingerprint(snapshot):
    return hashlib.sha256(json.dumps(snapshot, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def restore(db, uid, saved):
    """Caller holds write lock and verifies current fingerprint before restoring."""
    from fastapi import HTTPException
    current = capture(db, uid)
    versions = {row['card_id']: row['version'] for row in current['scheduler_states']}
    session_versions = {row['id']: row['version'] for row in current['filtered_sessions']}
    # SQLite may reuse deleted integer IDs. Never overwrite another account.
    for model in TABLES:
        table = model.__table__
        pk = list(table.primary_key.columns)[0].name
        owned = {r[pk] for r in current[table.name]}
        wanted = {r[pk] for r in saved[table.name]}
        for start in range(0, len(wanted), 500):
            subset = list(wanted)[start:start+500]
            occupied = set(db.execute(select(table.c[pk]).where(table.c[pk].in_(subset))).scalars())
            if occupied - owned: raise HTTPException(409, 'Snapshot IDs are now used elsewhere; restore through a collection package instead')
    # Freeze concrete keys before deleting parents used in ownership predicates.
    for model in reversed(TABLES):
        table = model.__table__; pk = list(table.primary_key.columns)[0].name
        keys = [r[pk] for r in current[table.name]]
        for start in range(0, len(keys), 500): db.execute(delete(table).where(table.c[pk].in_(keys[start:start+500])))
    for model in TABLES:
        table = model.__table__
        rows = []
        for item in saved[table.name]:
            row = dict(item)
            for col in table.columns:
                if isinstance(col.type, m.DateTime) and row[col.name] is not None: row[col.name] = datetime.fromisoformat(row[col.name])
            if model is m.SchedulerState: row['version'] = max(row['version'], versions.get(row['card_id'], 0)) + 1
            if model is m.FilteredSession: row['version'] = max(row['version'], session_versions.get(row['id'], 0)) + 1
            rows.append(row)
        for start in range(0, len(rows), 500): db.execute(table.insert(), rows[start:start+500])
    states = {r['card_id'] for r in saved['scheduler_states']}
    for card in saved['cards']:
        if card['id'] not in states: db.execute(m.SchedulerState.__table__.insert().values(card_id=card['id'], version=versions.get(card['id'], 0)+1))
    db.expire_all()


def clear(db, uid):
    current = capture(db, uid)
    for model in reversed(TABLES):
        table = model.__table__; pk = list(table.primary_key.columns)[0].name
        keys = [row[pk] for row in current[table.name]]
        for start in range(0, len(keys), 500): db.execute(delete(table).where(table.c[pk].in_(keys[start:start+500])))
    db.expire_all()
