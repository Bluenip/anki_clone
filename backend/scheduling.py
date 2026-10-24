"""Scheduler adapter and study-day clock, with deterministic preview/apply."""
from datetime import datetime, timedelta, timezone
import json
from zoneinfo import ZoneInfo
from fsrs import Card as FSRSCard, Rating, Scheduler, State
from models import ReviewLog, SchedulerState
from sm2 import parse_steps, get_interval_display

ENGINE = 'py-fsrs-6.3.2'


def utc(value):
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def study_day(now, config):
    zone = ZoneInfo(config.timezone)
    local = utc(now).astimezone(zone)
    day = local.date() - (timedelta(days=1) if local.hour < config.day_starts_at else timedelta())
    return datetime(day.year, day.month, day.day, config.day_starts_at, tzinfo=zone).astimezone(timezone.utc)


def next_study_day(now, config, days=1):
    zone = ZoneInfo(config.timezone)
    day = study_day(now, config).astimezone(zone).date() + timedelta(days=days)
    return datetime(day.year, day.month, day.day, config.day_starts_at, tzinfo=zone).astimezone(timezone.utc)


def fsrs_scheduler(config):
    options = {'desired_retention': config.fsrs_desired_retention,
               'learning_steps': tuple(timedelta(seconds=s) for s in parse_steps(config.learning_steps)),
               'relearning_steps': tuple(timedelta(seconds=s) for s in parse_steps(config.relearning_steps)),
               'maximum_interval': config.maximum_interval, 'enable_fuzzing': False}
    if config.fsrs_parameters is not None:
        options['parameters'] = config.fsrs_parameters
    return Scheduler(**options)


def fsrs_state(db, card, progress, config, now):
    if card.scheduling and card.scheduling.fsrs_json:
        stored = json.loads(card.scheduling.fsrs_json)
        if stored['engine'] != ENGINE:
            raise ValueError('Unsupported FSRS state version; migrate explicitly before reviewing')
        return FSRSCard.from_dict(stored['card']), stored.get('initialization', 'saved')
    state = FSRSCard(card_id=card.id, due=now)
    history = db.query(ReviewLog).filter_by(card_id=card.id, user_id=card.deck.user_id).order_by(ReviewLog.review_date, ReviewLog.id).all()
    scheduler = fsrs_scheduler(config)
    reviewed = False
    for log in history:
        if log.rating in (1,2,3,4):
            state, _ = scheduler.review_card(state, Rating(log.rating), review_datetime=utc(log.review_date))
            reviewed = True
    if reviewed:
        return state, 'replayed_history'
    if progress and progress.card_state == 'review':
        # No history can recover an original memory state. Mark this estimate
        # explicitly; enabling FSRS never batch-reschedules existing due dates.
        return FSRSCard(card_id=card.id, state=State.Review, stability=max(0.1, progress.interval_days),
                        difficulty=5, due=utc(progress.next_review),
                        last_review=utc(progress.last_reviewed) if progress.last_reviewed else now-timedelta(days=max(1,progress.interval_days))), 'estimated_without_history'
    if progress and progress.card_state in ('learning', 'relearning'):
        # Imported/legacy learning cards may have no revlog or FSRS memory.
        # Keep their current step instead of silently restarting learning.
        relearning = progress.card_state == 'relearning'
        return FSRSCard(card_id=card.id, state=State.Relearning if relearning else State.Learning,
                        step=max(0, progress.learning_step or 0),
                        stability=max(0.1, progress.interval_days) if relearning else None,
                        difficulty=5 if relearning else None,
                        due=utc(progress.next_review) if progress.next_review else now,
                        last_review=utc(progress.last_reviewed) if progress.last_reviewed else None), 'preserved_steps_without_history'
    return state, 'new'


def fsrs_transition(db, card, progress, rating, config, now, duration_ms=None):
    state, initialization = fsrs_state(db, card, progress, config, now)
    updated, _ = fsrs_scheduler(config).review_card(state, Rating(rating), review_datetime=now, review_duration=duration_ms)
    delay = max(0, (updated.due-now).total_seconds())
    interval = max(1, round(delay/86400)) if updated.state == State.Review else 0
    if updated.state == State.Review and config.fsrs_fuzz:
        from review_fuzz import fuzzed_interval, review_seed
        previous = progress.interval_days if progress and progress.card_state == 'review' and rating > 1 else 0
        interval = fuzzed_interval(delay / 86400, config.maximum_interval, review_seed(card, progress), previous)
    if updated.state == State.Review:
        updated.due = next_study_day(now, config, interval)
    elif delay >= 86400:
        updated.due = next_study_day(now, config, max(1,round(delay/86400)))
    return updated, initialization, interval


def fsrs_preview(db, card, progress, config, now):
    result = {}
    for rating, label in [(1,'again'), (2,'hard'), (3,'good'), (4,'easy')]:
        updated, initialization, interval = fsrs_transition(db, card, progress, rating, config, now)
        seconds = max(0, int((updated.due-now).total_seconds()))
        result[label] = {'days':interval,'seconds':seconds,'display':get_interval_display(days=interval) if interval else get_interval_display(seconds=seconds)}
    return result


def apply_fsrs(db, card, progress, rating, config, now, duration_ms):
    before_state = progress.card_state
    updated, initialization, interval = fsrs_transition(db, card, progress, rating, config, now, duration_ms)
    progress.card_state = {State.Learning:'learning',State.Review:'review',State.Relearning:'relearning'}[updated.state]
    progress.learning_step = updated.step or 0
    progress.interval_days = interval if updated.state == State.Review else progress.interval_days
    progress.next_review = updated.due
    progress.repetitions += 1
    if before_state == 'review' and rating == 1:
        progress.lapse_count += 1
    card.scheduling.fsrs_json = json.dumps({'engine':ENGINE,'card':updated.to_dict(),'initialization':initialization})
    return initialization
