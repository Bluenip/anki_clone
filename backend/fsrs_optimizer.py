"""Build training examples from complete, owned histories; native Anki trains weights."""
import json
import os
from pathlib import Path
import subprocess
import sys
from zoneinfo import ZoneInfo
from sqlalchemy.orm import joinedload
from models import ReviewLog, Card, Deck
from scheduling import study_day, utc
from study_queue import config_for


def training_items(db, user_id, decks, now):
    configs = {d.id: config_for(d, now) for d in decks}
    logs = (db.query(ReviewLog).join(Card).filter(ReviewLog.user_id == user_id,
            Card.deck_id.in_(configs), ReviewLog.review_date <= now)
            .options(joinedload(ReviewLog.card), joinedload(ReviewLog.record))
            .order_by(ReviewLog.card_id, ReviewLog.review_date, ReviewLog.id).limit(50001).all())
    if len(logs) > 50000:
        raise ValueError('This scope exceeds 50000 history entries; select a smaller deck')
    histories = {}
    outcomes = []
    events = 0
    for log in logs:
        if log.rating not in (1, 2, 3, 4):
            histories.pop(log.card_id, None)
            continue
        metadata = json.loads(log.record.payload) if log.record else {}
        # Unknown/imported manual entries cannot establish complete history.
        kind = metadata.get('kind')
        if kind not in ('new', 'learning', 'relearning', 'review'):
            histories.pop(log.card_id, None)
            continue
        cfg = configs[log.card.deck_id]
        day = study_day(utc(log.review_date), cfg).astimezone(ZoneInfo(cfg.timezone)).date()
        if log.was_new or kind == 'new':
            histories[log.card_id] = ([], day)
        if log.card_id not in histories:
            continue
        history, previous = histories[log.card_id]
        delta = max(0, (day - previous).days)
        history.append({'rating': log.rating, 'delta_t': delta})
        histories[log.card_id] = (history, day)
        if len(history) > 1 and delta > 0:
            events += len(history)
            if events > 1000000 or len(outcomes) >= 20000:
                raise ValueError('Training history is too large; select a smaller deck')
            outcomes.append((utc(log.review_date), [dict(r) for r in history]))
    outcomes.sort(key=lambda item: item[0])
    return [item[1] for item in outcomes], len(logs)


def optimize(items):
    worker = Path(__file__).with_name('fsrs_optimizer_worker.py')
    try:
        result = subprocess.run([sys.executable, str(worker)], input=json.dumps(items),
                                text=True, capture_output=True, timeout=120,
                                env={**os.environ, 'RAYON_NUM_THREADS': '2', 'OMP_NUM_THREADS': '2'})
    except subprocess.TimeoutExpired:
        raise ValueError('Optimization exceeded two minutes; use a smaller deck') from None
    if result.returncode != 0:
        raise ValueError('Native optimizer failed; current settings were not changed')
    try:
        params = json.loads(result.stdout)['parameters']
        from schemas import DeckSettings
        DeckSettings(fsrs_parameters=params)
    except (ValueError, KeyError, TypeError):
        raise ValueError('Native optimizer returned invalid parameters') from None
    return params
