"""
SM-2 Spaced Repetition Algorithm Implementation

Based on the SuperMemo 2 algorithm by Piotr Wozniak.

Rating scale:
    1 = Again (complete failure)
    2 = Hard  (recalled with serious difficulty)
    3 = Good  (recalled with some difficulty)
    4 = Easy  (perfect recall)
"""

from dataclasses import dataclass


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
) -> SM2Result:
    """
    Calculate next review parameters based on SM-2 algorithm.

    Args:
        rating: User's rating (1-4)
        repetitions: Number of consecutive successful reviews
        ease_factor: Current ease factor (minimum 1.3)
        interval_days: Current interval in days

    Returns:
        SM2Result with updated parameters
    """
    # Convert our 1-4 scale to SM-2's 0-5 scale
    quality = {1: 0, 2: 3, 3: 4, 4: 5}.get(rating, 4)

    # If rating is "Again" (quality < 3), reset
    if quality < 3:
        repetitions = 0
        interval_days = 0
    else:
        if repetitions == 0:
            interval_days = 1
        elif repetitions == 1:
            interval_days = 6
        else:
            interval_days = round(interval_days * ease_factor)
        repetitions += 1

    # Update ease factor
    ease_factor = ease_factor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))

    # Minimum ease factor is 1.3
    if ease_factor < 1.3:
        ease_factor = 1.3

    return SM2Result(
        ease_factor=round(ease_factor, 2),
        interval_days=interval_days,
        repetitions=repetitions,
    )


def get_interval_display(interval_days: int) -> str:
    """Return a human-readable interval string."""
    if interval_days == 0:
        return "< 1m"
    elif interval_days == 1:
        return "1d"
    elif interval_days < 30:
        return f"{interval_days}d"
    elif interval_days < 365:
        months = interval_days // 30
        return f"{months}mo"
    else:
        years = interval_days // 365
        return f"{years}y"


def get_next_intervals(
    repetitions: int, ease_factor: float, interval_days: int
) -> dict:
    """
    Preview what intervals each rating would produce.
    Used to show users the next review time for each button.
    """
    intervals = {}
    for rating, label in [(1, "again"), (2, "hard"), (3, "good"), (4, "easy")]:
        result = sm2_algorithm(rating, repetitions, ease_factor, interval_days)
        intervals[label] = {
            "days": result.interval_days,
            "display": get_interval_display(result.interval_days),
        }
    return intervals
