"""Explicit, additive Basic-note migration; dry-run by default.

Run with the application stopped. Does not change card IDs or study schedules.
The SQLite backup includes the database only, not media.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3


def backfill(database, apply=False):
    path = Path(database).resolve(strict=True)
    # Read-only preflight never creates a new DB or changes journal mode.
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as source:
        tables = {r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {'users', 'decks', 'cards'}.issubset(tables):
            raise ValueError('Not an Anki Clone database')
        total = source.execute('SELECT count(*) FROM cards').fetchone()[0]
        linked = source.execute('SELECT count(*) FROM note_cards').fetchone()[0] if 'note_cards' in tables else 0
        summary = {'cards': total, 'already_linked': linked, 'to_backfill': total - linked, 'applied': False}
        if not apply:
            return summary
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        backup = path.with_name(f'{path.name}.before-notes-{stamp}.bak')
        # Reserve the path with private permissions and refuse overwrite.
        with backup.open('xb'):
            backup.chmod(0o600)
        with sqlite3.connect(backup) as target:
            source.backup(target)
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session, joinedload
    from models import Card, Note, NoteCard, NoteType
    from notes import attach_basic_note
    from database import Base
    engine = create_engine('sqlite:///' + str(path))
    try:
        Base.metadata.create_all(engine, tables=[NoteType.__table__, Note.__table__, NoteCard.__table__])
        with Session(engine) as session:
            for card in session.query(Card).options(joinedload(Card.deck)).order_by(Card.id):
                if card.note_link is None:
                    attach_basic_note(session, card, card.deck.user_id)
            session.commit()
        return {**summary, 'applied': True, 'backup': str(backup)}
    finally:
        engine.dispose()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True, help='Explicit SQLite file path')
    parser.add_argument('--apply', action='store_true', help='Create backup and backfill note metadata')
    args = parser.parse_args()
    print(json.dumps(backfill(args.database, args.apply), indent=2))
