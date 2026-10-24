from datetime import datetime, timezone
import pytest
from models import StudyProgress
from sm2 import DeckSchedulingConfig, get_next_intervals
from routers.study_router import _handle_learning, _handle_relearning


@pytest.mark.parametrize('steps,index,expected', [('1m 10m', 0, 330), ('1m 10m 1h', 1, 600), ('1m', 0, 90), ('2d', 0, 259200)])
@pytest.mark.parametrize('state,apply', [('learning', _handle_learning), ('relearning', _handle_relearning)])
def test_hard_preview_matches_scheduled_delay(steps, index, expected, state, apply):
    config = DeckSchedulingConfig(learning_steps=steps, relearning_steps=steps)
    preview = get_next_intervals(1, 2.5, 7, config=config, card_state=state, learning_step=index)
    now = datetime(2026, 10, 22, 12, tzinfo=timezone.utc)
    progress = StudyProgress(card_state=state, learning_step=index)
    apply(progress, 2, config, now)
    assert (progress.next_review - now).total_seconds() == expected
    assert preview['hard']['seconds'] == expected
