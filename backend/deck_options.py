"""Resolve shared preset, deck limits, and expiring study-day overrides."""
import json
from datetime import datetime, timezone

LIMIT_KEYS = {'new_cards_per_day','maximum_reviews_per_day'}


def base_settings(deck):
    binding = deck.options_binding
    return json.loads(binding.preset.settings_json if binding and binding.preset else deck.settings or '{}')


def day_key(settings, now=None):
    from scheduling import study_day
    from sm2 import parse_settings_to_config
    return study_day(now or datetime.now(timezone.utc), parse_settings_to_config(settings)).isoformat()


def effective_settings(deck, now=None, include_today=True):
    settings = base_settings(deck)
    binding = deck.options_binding
    if binding:
        settings.update({k:v for k,v in json.loads(binding.overrides_json).items() if k in LIMIT_KEYS})
        today = json.loads(binding.today_json)
        if include_today and today.get('day') == day_key(settings, now):
            settings.update({k:v for k,v in today.get('limits',{}).items() if k in LIMIT_KEYS})
    return settings
