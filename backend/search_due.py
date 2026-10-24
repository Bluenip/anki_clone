"""Read-only Anki due search, using each home deck's study clock.

Due search ignores daily quotas. Intraday learning includes learning-ahead;
review and interday learning use the current study day, not a 24-hour window.
"""
import json
from datetime import timedelta
from sqlalchemy import func, select
from sqlalchemy.orm import joinedload
from models import Card, Deck, StudyProgress
from scheduling import next_study_day, utc
from study_queue import config_for, interday


def due_predicate(db, user_id, now):
    decks = db.query(Deck).filter_by(user_id=user_id).all()
    configs = {deck.id: config_for(deck, now) for deck in decks}
    rows = (db.query(StudyProgress).join(Card).join(Deck)
            .filter(Deck.user_id == user_id, StudyProgress.user_id == user_id,
                    StudyProgress.card_state.in_(['review', 'learning', 'relearning']),
                    StudyProgress.is_suspended.is_(False))
            .options(joinedload(StudyProgress.card).joinedload(Card.scheduling),
                     joinedload(StudyProgress.card).joinedload(Card.package_data)))
    ids = []
    for progress in rows.yield_per(500):
        card = progress.card
        if not progress.next_review:
            continue
        if card.scheduling and card.scheduling.buried_until and utc(card.scheduling.buried_until) > now:
            continue
        cfg = configs[card.deck_id]
        due = utc(progress.next_review)
        if progress.card_state == 'review' or interday(progress, cfg, now):
            matches = due < next_study_day(now, cfg)
        else:
            matches = due <= now + timedelta(seconds=cfg.learning_ahead_seconds)
        if matches:
            ids.append(card.id)
    # A single bound JSON parameter avoids SQLite's variable limit on collections
    # with many due cards; the outer search still supplies ownership/pagination.
    values = func.json_each(json.dumps(ids)).table_valued('value')
    return Card.id.in_(select(values.c.value))
