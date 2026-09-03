"""
SM-2 Spaced Repetition Algorithm Implementation (Enhanced)

Based on the SuperMemo 2 algorithm by Piotr Wozniak,
extended with Anki-style deck settings support.

Rating scale:
    1 = Again (complete failure)
    2 = Hard  (recalled with serious difficulty)
    3 = Good  (recalled with some difficulty)
    4 = Easy  (perfect recall)

Card states:
    "new"        - Never studied
    "learning"   - Going through learning steps (new card)
    "review"     - Graduated, on normal review schedule
    "relearning" - Lapsed, going through relearning steps
"""

from dataclasses import dataclass, field
from typing import List, Optional
import re


@dataclass
class DeckSchedulingConfig:
    """Deck-level scheduling parameters (mirrors Anki's deck options)."""
    # Daily limits
    new_cards_per_day: int = 20
    maximum_reviews_per_day: int = 200

    # New cards
    learning_steps: str = "1m 10m"
    graduating_interval: int = 1       # days after passing all learning steps
    easy_interval: int = 4             # days when pressing Easy during learning
    insertion_order: str = "Sequential (oldest cards first)"

    # Lapses
    relearning_steps: str = "10m"
    minimum_interval: int = 1          # minimum interval after a lapse
    leech_threshold: int = 8           # number of lapses to mark as leech
    leech_action: str = "Tag Only"     # "Tag Only" or "Suspend Card"

    # Advanced
    starting_ease: float = 2.50
    easy_bonus: float = 1.30
    hard_interval: float = 1.20
    interval_modifier: float = 1.00
    new_interval: float = 0.00         # % of old interval kept on lapse
    maximum_interval: int = 36500


def parse_settings_to_config(settings: dict) -> DeckSchedulingConfig:
    """Convert a JSON settings dict to a DeckSchedulingConfig."""
    config = DeckSchedulingConfig()
    for key, value in settings.items():
        if hasattr(config, key):
            expected_type = type(getattr(config, key))
            try:
                setattr(config, key, expected_type(value))
            except (ValueError, TypeError):
                pass  # Keep default if conversion fails
    return config


def parse_steps(steps_str: str) -> List[int]:
    """
    Parse a steps string like '1m 10m' or '1h 1d' into a list of seconds.

    Supported suffixes:
        s = seconds, m = minutes, h = hours, d = days
        No suffix = minutes (Anki default)

    Examples:
        '1m 10m' -> [60, 600]
        '10m'    -> [600]
        '1h'     -> [3600]
        '1d'     -> [86400]
        ''       -> []
    """
    if not steps_str or not steps_str.strip():
        return []

    result = []
    tokens = steps_str.strip().split()
    for token in tokens:
        token = token.strip().lower()
        if not token:
            continue

        # Match number + optional unit
        match = re.match(r'^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$', token)
        if match:
            value = float(match.group(1))
            unit = match.group(2) or 'm'  # Default to minutes

            if unit == 's':
                result.append(int(value))
            elif unit == 'm':
                result.append(int(value * 60))
            elif unit == 'h':
                result.append(int(value * 3600))
            elif unit == 'd':
                result.append(int(value * 86400))

    return result


@dataclass
class SM2Result:
    ease_factor: float
    interval_days: int
    repetitions: int


def sm2_algorithm(
    rating: int,
    repetitions: int,
    ease_factor: float,
    interval_days: int,
    config: Optional[DeckSchedulingConfig] = None,
) -> SM2Result:
    """
    Calculate next review parameters based on SM-2 algorithm with Anki-style enhancements.

    This handles GRADUATED/REVIEW cards only.
    Learning/relearning step logic is handled separately in study_router.

    Args:
        rating: User's rating (1-4)
        repetitions: Number of consecutive successful reviews
        ease_factor: Current ease factor (minimum 1.3)
        interval_days: Current interval in days
        config: Deck scheduling configuration

    Returns:
        SM2Result with updated parameters
    """
    if config is None:
        config = DeckSchedulingConfig()

    max_ivl = config.maximum_interval

    # Convert our 1-4 scale to SM-2's 0-5 scale for ease factor calculation
    quality = {1: 0, 2: 3, 3: 4, 4: 5}.get(rating, 4)

    if rating == 1:
        # Again — lapse
        # New interval = old_interval * new_interval percentage
        new_ivl = max(
            int(interval_days * config.new_interval),
            config.minimum_interval
        ) if interval_days > 0 else 0

        return SM2Result(
            ease_factor=max(round(ease_factor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)), 2), 1.3),
            interval_days=new_ivl,
            repetitions=0,
        )

    elif rating == 2:
        # Hard
        if repetitions == 0:
            interval_days = 1
        elif repetitions == 1:
            # First successful review after first rep
            interval_days = max(int(1 * config.hard_interval * config.interval_modifier), 1)
        else:
            interval_days = max(
                int(interval_days * config.hard_interval * config.interval_modifier),
                interval_days + 1  # Must be at least 1 day more than current
            )
        repetitions += 1

    elif rating == 3:
        # Good
        if repetitions == 0:
            interval_days = config.graduating_interval
        elif repetitions == 1:
            interval_days = 6
        else:
            interval_days = max(
                int(interval_days * ease_factor * config.interval_modifier),
                interval_days + 1
            )
        repetitions += 1

    elif rating == 4:
        # Easy
        if repetitions == 0:
            interval_days = config.easy_interval
        elif repetitions == 1:
            interval_days = max(
                int(6 * config.easy_bonus * config.interval_modifier),
                7
            )
        else:
            interval_days = max(
                int(interval_days * ease_factor * config.easy_bonus * config.interval_modifier),
                interval_days + 1
            )
        repetitions += 1

    # Cap by maximum interval
    interval_days = min(interval_days, max_ivl)

    # Update ease factor using SM-2 formula
    new_ease = ease_factor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
    new_ease = max(new_ease, 1.3)

    return SM2Result(
        ease_factor=round(new_ease, 2),
        interval_days=interval_days,
        repetitions=repetitions,
    )


def get_interval_display(seconds: int = 0, days: int = 0) -> str:
    """
    Return a human-readable interval string.

    Can accept either seconds (for learning steps) or days (for review intervals).
    """
    if days > 0 and seconds == 0:
        seconds = days * 86400

    if seconds < 60:
        return f"{seconds}s" if seconds > 0 else "< 1m"
    elif seconds < 3600:
        minutes = seconds // 60
        return f"{minutes}m"
    elif seconds < 86400:
        hours = seconds // 3600
        return f"{hours}h"
    else:
        total_days = seconds // 86400
        if total_days < 30:
            return f"{total_days}d"
        elif total_days < 365:
            months = total_days // 30
            return f"{months}mo"
        else:
            years = round(total_days / 365, 1)
            if years == int(years):
                return f"{int(years)}y"
            return f"{years}y"


def get_next_intervals(
    repetitions: int,
    ease_factor: float,
    interval_days: int,
    config: Optional[DeckSchedulingConfig] = None,
    card_state: str = "review",
    learning_step: int = 0,
) -> dict:
    """
    Preview what intervals each rating would produce.
    Used to show users the next review time for each button.

    For learning/relearning cards, shows step times instead of SM-2 intervals.
    For review cards, shows SM-2 calculated intervals.
    """
    if config is None:
        config = DeckSchedulingConfig()

    intervals = {}

    if card_state in ("learning", "new"):
        steps = parse_steps(config.learning_steps)
        _get_learning_intervals(intervals, steps, learning_step, config)

    elif card_state == "relearning":
        steps = parse_steps(config.relearning_steps)
        _get_relearning_intervals(intervals, steps, learning_step, config, interval_days, ease_factor)

    else:
        # Review card — use SM-2
        for rating, label in [(1, "again"), (2, "hard"), (3, "good"), (4, "easy")]:
            result = sm2_algorithm(rating, repetitions, ease_factor, interval_days, config)
            if rating == 1:
                # Again goes to relearning — show first relearning step time
                relearn_steps = parse_steps(config.relearning_steps)
                if relearn_steps:
                    intervals[label] = {
                        "days": 0,
                        "display": get_interval_display(seconds=relearn_steps[0]),
                    }
                else:
                    intervals[label] = {
                        "days": result.interval_days,
                        "display": get_interval_display(days=result.interval_days),
                    }
            else:
                intervals[label] = {
                    "days": result.interval_days,
                    "display": get_interval_display(days=result.interval_days),
                }

    return intervals


def _get_learning_intervals(intervals: dict, steps: List[int], current_step: int, config: DeckSchedulingConfig):
    """Calculate interval previews for learning cards."""
    # Again → back to step 0
    if steps:
        intervals["again"] = {
            "days": 0,
            "display": get_interval_display(seconds=steps[0]),
        }
    else:
        intervals["again"] = {"days": 0, "display": "< 1m"}

    # Hard → repeat current step
    if steps and current_step < len(steps):
        intervals["hard"] = {
            "days": 0,
            "display": get_interval_display(seconds=steps[current_step]),
        }
    else:
        intervals["hard"] = {"days": 0, "display": "< 1m"}

    # Good → next step, or graduate
    next_step = current_step + 1
    if steps and next_step < len(steps):
        intervals["good"] = {
            "days": 0,
            "display": get_interval_display(seconds=steps[next_step]),
        }
    else:
        # Graduating
        intervals["good"] = {
            "days": config.graduating_interval,
            "display": get_interval_display(days=config.graduating_interval),
        }

    # Easy → graduate immediately with easy_interval
    intervals["easy"] = {
        "days": config.easy_interval,
        "display": get_interval_display(days=config.easy_interval),
    }


def _get_relearning_intervals(
    intervals: dict, steps: List[int], current_step: int,
    config: DeckSchedulingConfig, old_interval: int, ease_factor: float
):
    """Calculate interval previews for relearning cards."""
    # Again → back to step 0
    if steps:
        intervals["again"] = {
            "days": 0,
            "display": get_interval_display(seconds=steps[0]),
        }
    else:
        intervals["again"] = {"days": 0, "display": "< 1m"}

    # Hard → repeat current step
    if steps and current_step < len(steps):
        intervals["hard"] = {
            "days": 0,
            "display": get_interval_display(seconds=steps[current_step]),
        }
    else:
        intervals["hard"] = {"days": 0, "display": "< 1m"}

    # Good → next step, or graduate back to review
    next_step = current_step + 1
    if steps and next_step < len(steps):
        intervals["good"] = {
            "days": 0,
            "display": get_interval_display(seconds=steps[next_step]),
        }
    else:
        # Graduate from relearning
        new_ivl = max(int(old_interval * config.new_interval), config.minimum_interval)
        new_ivl = min(new_ivl, config.maximum_interval)
        intervals["good"] = {
            "days": new_ivl,
            "display": get_interval_display(days=new_ivl),
        }

    # Easy → graduate immediately from relearning
    new_ivl = max(int(old_interval * config.new_interval), config.minimum_interval)
    new_ivl = min(new_ivl, config.maximum_interval)
    intervals["easy"] = {
        "days": new_ivl,
        "display": get_interval_display(days=new_ivl),
    }
