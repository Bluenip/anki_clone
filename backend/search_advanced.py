"""Study-day date searches and time-bounded regular expressions."""
import json
import subprocess
import sys
from pathlib import Path
from datetime import timedelta
from sqlalchemy import and_, or_, false, func, select
from sqlalchemy.orm import joinedload
from models import Card, Deck, NoteCard, Note, ReviewLog
from scheduling import study_day
from study_queue import config_for


def dates(db, uid, key, argument, now):
    parts = argument.split(':')
    if len(parts) > (2 if key == 'rated' else 1) or not parts[0].isascii() or not parts[0].isdigit() or not 1 <= int(parts[0]) <= 36500:
        raise ValueError(f'{key}: expects 1 to 36500 study days')
    rating = None
    if len(parts) == 2:
        if parts[1] not in ('1', '2', '3', '4'): raise ValueError('rated: rating must be 1 through 4')
        rating = int(parts[1])
    terms = []
    for deck in db.query(Deck).filter_by(user_id=uid):
        cfg = config_for(deck, now)
        # Subtract calendar days in the home timezone, preserving rollover/DST.
        from zoneinfo import ZoneInfo
        cutoff = study_day(now, cfg).astimezone(ZoneInfo(cfg.timezone)) - timedelta(days=int(parts[0]) - 1)
        from scheduling import utc
        cutoff = utc(cutoff)
        if key == 'added':
            predicate = and_(Card.created_at >= cutoff, Card.created_at <= now)
        else:
            conditions = [ReviewLog.card_id == Card.id, ReviewLog.user_id == uid, ReviewLog.rating.in_([1, 2, 3, 4]), ReviewLog.review_date >= cutoff, ReviewLog.review_date <= now]
            if rating is not None: conditions.append(ReviewLog.rating == rating)
            predicate = select(1).select_from(ReviewLog).where(*conditions).correlate(Card).exists()
        terms.append(and_(Card.deck_id == deck.id, predicate))
    return or_(*terms) if terms else false()


def regex_predicate(db, uid, expression, field=None):
    if not expression or len(expression) > 512:
        raise ValueError('Regular expressions must contain 1 to 512 characters')
    rows = db.query(Card).join(Deck).filter(Deck.user_id == uid).options(joinedload(Card.note_link).joinedload(NoteCard.note).joinedload(Note.note_type)).limit(100001).all()
    if len(rows) > 100000: raise ValueError('Regex search is limited to 100000 cards')
    items, size = [], 0
    for card in rows:
        if card.note_link:
            note = card.note_link.note
            values = dict(zip(json.loads(note.note_type.fields_json), json.loads(note.fields_json)))
        else: values = {'Front': card.front, 'Back': card.back}
        texts = [value for name, value in values.items() if field is None or name.casefold() == field.casefold()]
        size += sum(len(v) for v in texts)
        if size > 20000000: raise ValueError('Regex source exceeds 20 million characters; use a smaller collection')
        items.append((card.id, texts))
    try:
        run = subprocess.run([sys.executable, str(Path(__file__).with_name('search_regex_worker.py'))], input=json.dumps({'pattern': expression, 'items': items}), text=True, capture_output=True, timeout=3)
    except subprocess.TimeoutExpired:
        raise ValueError('Regex exceeded its time limit; simplify the expression') from None
    if run.returncode: raise ValueError('Invalid or too expensive regular expression')
    ids = json.loads(run.stdout)
    values = func.json_each(json.dumps(ids)).table_valued('value')
    return Card.id.in_(select(values.c.value))


def due_days(db, uid, argument, now):
    import re
    from models import StudyProgress
    from scheduling import next_study_day
    match = re.fullmatch(r'due(<=|>=|!=|=|<|>)(-?\d{1,5})', argument)
    if not match or abs(int(match[2])) > 36500: raise ValueError('Use prop:due with a study-day comparison')
    operator, days = match[1], int(match[2])
    terms = []
    for deck in db.query(Deck).filter_by(user_id=uid):
        cfg = config_for(deck, now)
        start, end = next_study_day(now, cfg, days), next_study_day(now, cfg, days + 1)
        due = StudyProgress.next_review
        predicate = {'=': and_(due >= start, due < end), '!=': or_(due < start, due >= end), '<': due < start, '<=': due < end, '>': due >= end, '>=': due >= start}[operator]
        exists = select(1).select_from(StudyProgress).where(StudyProgress.card_id == Card.id, StudyProgress.user_id == uid, StudyProgress.card_state != 'new', predicate).correlate(Card).exists()
        terms.append(and_(Card.deck_id == deck.id, exists))
    return or_(*terms) if terms else false()
