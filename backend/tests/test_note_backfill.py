import hashlib
import sqlite3
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from database import Base
from models import User, Deck, Card, StudyProgress, ReviewLog, SharedDeck
from backfill_notes import backfill


def test_backfill_is_explicit_idempotent_and_keeps_schedule(tmp_path):
    path = tmp_path / 'legacy.db'
    engine = create_engine('sqlite:///' + str(path))
    Base.metadata.create_all(engine, tables=[m.__table__ for m in [User, Deck, Card, StudyProgress, ReviewLog, SharedDeck]])
    with Session(engine) as session:
        user = User(email='old@example.com', username='Old user', password_hash='not-a-real-hash')
        session.add(user); session.flush()
        deck = Deck(user_id=user.id, name='Old deck')
        session.add(deck); session.flush()
        card = Card(deck_id=deck.id, front='Legacy Q', back='Legacy A')
        session.add(card); session.flush()
        session.add(StudyProgress(user_id=user.id, card_id=card.id, card_state='review', interval_days=42))
        session.commit()
    engine.dispose()
    original = hashlib.sha256(path.read_bytes()).hexdigest()
    assert backfill(path)['to_backfill'] == 1
    assert hashlib.sha256(path.read_bytes()).hexdigest() == original
    result = backfill(path, apply=True)
    assert result['applied'] is True
    with sqlite3.connect(result['backup']) as backup:
        assert backup.execute('SELECT front FROM cards').fetchone()[0] == 'Legacy Q'
    with sqlite3.connect(path) as conn:
        before = conn.execute('SELECT guid FROM notes').fetchone()[0]
        assert conn.execute('SELECT interval_days FROM study_progress').fetchone()[0] == 42
        assert conn.execute('SELECT card_id FROM note_cards').fetchone()[0] == 1
    assert backfill(path, apply=True)['to_backfill'] == 0
    with sqlite3.connect(path) as conn:
        assert conn.execute('SELECT guid FROM notes').fetchone()[0] == before
        assert conn.execute('SELECT count(*) FROM notes').fetchone()[0] == 1
