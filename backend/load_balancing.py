"""Choose a due day within fuzz bounds using weekday capacity and actual load.

The same pure decision is used by preview and review. Existing due dates are
never moved merely by changing settings. Intraday learning is unaffected.
"""
from collections import Counter
from zoneinfo import ZoneInfo
from models import Card, StudyProgress
from scheduling import next_study_day, study_day, utc
from review_fuzz import fuzz_bounds, review_seed

DAYS = ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun')


def choose_interval(db, card, progress, config, now, interval):
    weights = config.easy_days
    if not config.load_balancing and all(weights.get(day, 100) == 100 for day in DAYS): return interval
    low, high = fuzz_bounds(interval, 1, config.maximum_interval)
    if low == high: return low
    # A window is bounded even at maximum_interval; do not scan the collection.
    zone = ZoneInfo(config.timezone)
    load = Counter()
    if config.load_balancing:
        rows = db.query(StudyProgress.next_review).join(Card).filter(
            Card.deck_id == card.deck_id, Card.id != card.id, StudyProgress.user_id == card.deck.user_id,
            StudyProgress.card_state == 'review', StudyProgress.is_suspended.is_(False),
            StudyProgress.next_review >= next_study_day(now, config, low),
            StudyProgress.next_review < next_study_day(now, config, high + 1)).all()
        load.update(study_day(utc(due), config).astimezone(zone).date() for due, in rows)
    seed = review_seed(card, None)
    candidates = []
    for days in range(low, high + 1):
        date = next_study_day(now, config, days).astimezone(zone).date()
        capacity = weights.get(DAYS[date.weekday()], 100) / 100
        # Minimum is a preference, not a guarantee to skip all reviews that day.
        score = (load[date] + 1) / max(.05, capacity) if config.load_balancing else 1 / max(.05, capacity)
        candidates.append((score, abs(days - interval), (seed ^ (days * 2654435761)) % 1000003, days))
    return min(candidates)[-1]


def adjust_preview(db, card, progress, config, now, intervals):
    from sm2 import get_interval_display
    for value in intervals.values():
        if value.get('days', 0) > 0:
            days = choose_interval(db, card, progress, config, now, value['days'])
            value.update(days=days, seconds=max(0, int((next_study_day(now, config, days) - now).total_seconds())), display=get_interval_display(days=days))
    return intervals
