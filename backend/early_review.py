"""Anki-style SM-2 early-review intervals for filtered sessions.

Formula reference: ankitects/anki rslib/src/scheduler/states/review.rs,
passing_early_review_intervals. Early intervals are not fuzzed.
"""
import math
from zoneinfo import ZoneInfo
from scheduling import study_day, utc


def intervals(progress, config, now):
    if not progress or config.fsrs or progress.card_state != 'review' or not progress.next_review:
        return None
    zone=ZoneInfo(config.timezone)
    today=study_day(now,config).astimezone(zone).date()
    due=study_day(utc(progress.next_review),config).astimezone(zone).date()
    remaining=(due-today).days
    if remaining<=0:return None
    scheduled=max(1,progress.interval_days)
    elapsed=max(0,scheduled-remaining)
    base=max(scheduled,elapsed*progress.ease_factor)
    raw={2:max(elapsed*config.hard_interval,scheduled*config.hard_interval/2),
         3:base,4:base*(1+(config.easy_bonus-1)/2)}
    return {rating:max(1,min(config.maximum_interval,math.floor(value*config.interval_modifier+0.5)))
            for rating,value in raw.items()}
