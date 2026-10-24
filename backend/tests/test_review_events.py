import json
from datetime import datetime, timedelta, timezone

from fsrs import Card as MemoryCard, Rating
from models import Card, Deck, ReviewLog, StudyProgress, SchedulerState
from scheduling import fsrs_scheduler, next_study_day, study_day, utc
from sm2 import DeckSchedulingConfig


def setup_note(client, headers, settings=None, kind='basic'):
    deck = client.post('/api/decks', headers=headers, json={'name': 'Events'}).json()
    if settings:
        result = client.put(f"/api/decks/{deck['id']}", headers=headers, json={'settings': json.dumps(settings)})
        assert result.status_code == 200, result.text
    note = client.post('/api/notes', headers=headers, json={'deck_id': deck['id'], 'kind': kind,
                       'fields': {'Front': 'question', 'Back': 'answer'}}).json()
    return deck['id'], [c['id'] for c in note['cards']]


def test_retry_is_idempotent_and_stale_tab_cannot_change_progress(client, auth_headers_a, db_session):
    _, (card_id,) = setup_note(client, auth_headers_a)
    url = f'/api/study/{card_id}/review'
    body = {'rating': 3, 'request_id': 'one-event', 'expected_version': 0, 'duration_ms': 1234}
    first = client.post(url, headers=auth_headers_a, json=body)
    assert first.status_code == 200, first.text
    assert client.post(url, headers=auth_headers_a, json=body).json() == first.json()
    assert db_session.query(ReviewLog).count() == 1
    summary = client.get('/api/study/summary/today', headers=auth_headers_a)
    assert summary.status_code == 200
    assert summary.json() == {'reviews': 1, 'seconds': 1.2, 'seconds_per_card': 1.2}
    assert json.loads(db_session.query(ReviewLog).one().record.payload)['duration_ms'] == 1234
    progress = db_session.query(StudyProgress).one()
    due = progress.next_review
    conflict = client.post(url, headers=auth_headers_a, json={**body, 'request_id': 'stale', 'rating': 1})
    assert conflict.status_code == 409
    db_session.refresh(progress)
    assert progress.next_review == due
    assert db_session.query(ReviewLog).count() == 1


def test_sibling_bury_and_undo_restore_new_cards_and_logs(client, auth_headers_a, db_session):
    deck_id, (first, second) = setup_note(client, auth_headers_a, {'bury_new_siblings': True}, 'reversed')
    reviewed = client.post(f'/api/study/{first}/review', headers=auth_headers_a,
                           json={'rating': 4, 'expected_version': 0}).json()
    assert reviewed['version'] == 1
    assert db_session.get(SchedulerState, second).buried_until is not None
    assert client.get(f'/api/study/{deck_id}', headers=auth_headers_a).json() is None
    undone = client.post('/api/study/undo/latest', headers=auth_headers_a)
    assert undone.status_code == 200, undone.text
    assert db_session.query(StudyProgress).count() == 0
    assert db_session.query(ReviewLog).count() == 0
    assert db_session.get(SchedulerState, second).buried_until is None
    assert client.get(f'/api/study/{deck_id}', headers=auth_headers_a).json()['card_id'] in (first, second)


def test_action_ownership_and_version_guard(client, auth_headers_a, auth_headers_b, db_session):
    deck_id, (card_id,) = setup_note(client, auth_headers_a)
    url = f'/api/study/{card_id}/action'
    assert client.post(url, headers=auth_headers_b, json={'action': 'suspend'}).status_code == 404
    assert client.post(url, headers=auth_headers_a, json={'action': 'bury', 'expected_version': 0}).status_code == 200
    assert client.get(f'/api/study/{deck_id}', headers=auth_headers_a).json() is None
    assert client.post(url, headers=auth_headers_a, json={'action': 'unbury', 'expected_version': 0}).status_code == 409
    assert client.post(url, headers=auth_headers_a, json={'action': 'unbury', 'expected_version': 1}).status_code == 200
    assert client.post(url, headers=auth_headers_a, json={'action': 'suspend', 'expected_version': 2}).status_code == 200
    assert db_session.query(StudyProgress).one().is_suspended
    assert client.get(f'/api/study/{deck_id}', headers=auth_headers_a).json() is None


def test_fsrs_review_matches_library_and_undo_restores_memory(client, auth_headers_a, db_session):
    from review_service import review, undo
    from schemas import ReviewRequest
    _, (card_id,) = setup_note(client, auth_headers_a, {'fsrs': True})
    card = db_session.get(Card, card_id)
    config = DeckSchedulingConfig(fsrs=True)
    now = datetime(2026, 10, 22, 6, tzinfo=timezone.utc)
    expected, _ = fsrs_scheduler(config).review_card(MemoryCard(card_id=card_id, due=now), Rating.Good, review_datetime=now)
    result = review(db_session, card, card.deck.user_id, ReviewRequest(rating=3), now=now)
    progress = db_session.query(StudyProgress).one()
    assert utc(progress.next_review) == expected.due
    memory = json.loads(card.scheduling.fsrs_json)['card']
    assert memory['stability'] == expected.stability
    assert memory['difficulty'] == expected.difficulty
    assert result['scheduler'] == 'fsrs'
    undo(db_session, card.deck.user_id)
    assert card.scheduling.fsrs_json is None
    assert db_session.query(StudyProgress).count() == 0


def test_learning_waits_for_due_instead_of_reappearing_immediately(client, auth_headers_a, db_session):
    deck_id, (card_id,) = setup_note(client, auth_headers_a)
    result = client.post(f'/api/study/{card_id}/review', headers=auth_headers_a, json={'rating': 1})
    assert result.status_code == 200
    assert client.get(f'/api/study/{deck_id}', headers=auth_headers_a).json() is None
    stats = client.get(f'/api/study/{deck_id}/stats', headers=auth_headers_a).json()
    assert stats['learn_cards'] == 1
    assert stats['next_learning_at'] is not None


def test_daily_clock_uses_calendar_days_across_dst():
    config = DeckSchedulingConfig(timezone='America/New_York', day_starts_at=4)
    now = datetime(2026, 3, 7, 12, tzinfo=timezone.utc)
    start = study_day(now, config)
    next_start = next_study_day(now, config)
    assert next_start - start == timedelta(hours=23)
    assert next_start.hour == 8


def test_multiple_undo_keeps_versions_monotonic_and_rejects_stale_review(client, auth_headers_a, db_session):
    _, (card_id,) = setup_note(client, auth_headers_a)
    url = f'/api/study/{card_id}/review'
    for version in (0, 1):
        response = client.post(url, headers=auth_headers_a, json={'rating': 3, 'expected_version': version})
        assert response.status_code == 200, response.text
    for version in (3, 4):
        response = client.post('/api/study/undo/latest', headers=auth_headers_a)
        assert response.status_code == 200, response.text
        assert response.json()['version'] == version
    assert db_session.query(StudyProgress).count() == 0
    assert db_session.query(ReviewLog).count() == 0
    assert client.post(url, headers=auth_headers_a, json={'rating': 4, 'expected_version': 0}).status_code == 409


def test_child_quota_caps_parent_counts(client, auth_headers_a, db_session):
    root = client.post('/api/decks', headers=auth_headers_a, json={'name': 'Root'}).json()['id']
    child = client.post('/api/decks', headers=auth_headers_a, json={'name': 'Root::Child', 'settings': json.dumps({'new_cards_per_day': 2})}).json()['id']
    # Update explicitly: creation and update share validation, but this also checks loaded settings.
    client.put(f'/api/decks/{child}', headers=auth_headers_a, json={'settings': json.dumps({'new_cards_per_day': 2})})
    for index in range(5):
        client.post('/api/notes', headers=auth_headers_a, json={'deck_id': child, 'kind': 'basic', 'fields': {'Front': str(index), 'Back': 'A'}})
    stats = client.get(f'/api/study/{root}/stats', headers=auth_headers_a)
    assert stats.status_code == 200, stats.text
    assert stats.json()['new_cards'] == 2


def test_review_rechecks_parent_quota_against_another_tab(client, auth_headers_a, db_session):
    deck_id, (first,) = setup_note(client, auth_headers_a, {'new_cards_per_day': 1})
    second = client.post('/api/notes', headers=auth_headers_a, json={'deck_id': deck_id,'kind':'basic','fields':{'Front':'Second','Back':'A'}}).json()['cards'][0]['id']
    for cid, status in [(first,200),(second,409)]:
        response=client.post(f'/api/study/{cid}/review', headers=auth_headers_a,
                             json={'rating':4,'expected_version':0,'study_deck_id':deck_id})
        assert response.status_code==status,response.text
    assert db_session.query(ReviewLog).count()==1
    assert db_session.query(StudyProgress).count()==1
