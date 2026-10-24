"""Deterministic review-date spreading using Anki's published fuzz bounds.

Bounds reference: ankitects/anki, rslib/src/scheduler/states/fuzz.rs.
The web seed is intentionally independent of Anki's Rust RNG. This does not
implement load balancing, Easy Days, or bulk rescheduling.
"""
import hashlib
import math


def rounded_days(value):
    return math.floor(value + 0.5)


def fuzz_bounds(interval, minimum=1, maximum=36500):
    minimum = min(minimum, maximum)
    interval = min(max(interval, minimum), maximum)
    delta = 0.0
    if interval >= 2.5:
        delta = 1.0 + 0.15 * max(0, min(interval, 7) - 2.5)
        delta += 0.1 * max(0, min(interval, 20) - 7)
        delta += 0.05 * max(0, interval - 20)
    low = min(max(rounded_days(interval - delta), minimum), maximum)
    high = min(max(rounded_days(interval + delta), minimum), maximum)
    if low == high and 2 < high < maximum:
        high += 1
    return low, high


def review_seed(card, progress):
    # Repetitions are unchanged between preview and apply, including when the
    # review service claims a new optimistic-lock version before scheduling.
    repetitions = progress.repetitions if progress else 0
    source = f'fsrs-fuzz-v1:{card.deck.user_id}:{card.id}:{repetitions}'
    return int.from_bytes(hashlib.sha256(source.encode()).digest()[:8], 'big')


def fuzzed_interval(interval, maximum, seed, previous_interval=0):
    minimum = 1
    if previous_interval:
        _, upper = fuzz_bounds(interval, 1, maximum)
        if rounded_days(interval) > previous_interval:
            minimum = previous_interval + 1
        elif previous_interval <= upper:
            minimum = previous_interval
    low, high = fuzz_bounds(interval, minimum, maximum)
    # Integer arithmetic avoids rounding a fraction to 1.0 at the upper edge.
    return low + seed * (high - low + 1) // (1 << 64)
