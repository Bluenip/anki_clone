from datetime import datetime, timedelta, timezone
import json
from models import Deck, Card, ReviewLog, ReviewRecord
from fsrs_optimizer import training_items, optimize


def test_training_requires_complete_history_and_interday(client, db_session, user_a, auth_headers_a, auth_headers_b):
    deck = Deck(user_id=user_a.id, name='Training', settings='{}'); db_session.add(deck); db_session.flush()
    card = Card(deck_id=deck.id, front='Q', back='A'); db_session.add(card); db_session.flush()
    now = datetime(2026, 10, 23, 12, tzinfo=timezone.utc)
    for offset, kind, new in [(0, 'review', False), (1, 'new', True), (1.01, 'learning', False), (3, 'review', False), (8, 'review', False)]:
        log = ReviewLog(user_id=user_a.id, card_id=card.id, review_date=now-timedelta(days=10)+timedelta(days=offset), rating=3, was_new=new)
        log.record = ReviewRecord(payload=json.dumps({'kind': kind})); db_session.add(log)
    db_session.flush()
    items, count = training_items(db_session, user_a.id, [deck], now)
    assert count == 5 and len(items) == 2
    assert [r['delta_t'] for r in items[-1]] == [0, 0, 2, 5]
    assert client.post(f'/api/optimizer/{deck.id}', headers=auth_headers_b).status_code == 404
    response = client.post(f'/api/optimizer/{deck.id}', headers=auth_headers_a)
    assert response.status_code == 422
    assert 'Need 400' in response.json()['detail']
    assert db_session.query(ReviewLog).count() == 5


def test_native_optimizer_returns_valid_21_weights():
    # Small deterministic smoke validates the pinned native worker/protobuf contract.
    parameters = optimize([[{'rating': 3, 'delta_t': 0}, {'rating': 3, 'delta_t': 3}]])
    assert len(parameters) == 21
    assert all(isinstance(p, float) for p in parameters)


def test_optimizer_result_does_not_apply_settings(client, db_session, user_a, auth_headers_a, monkeypatch):
    from routers import optimizer_router
    deck = Deck(user_id=user_a.id, name='Preview optimization', settings='{"fsrs":true}')
    db_session.add(deck); db_session.commit()
    weights = optimize([[{'rating': 3, 'delta_t': 0}, {'rating': 3, 'delta_t': 3}]])
    monkeypatch.setattr(optimizer_router, 'training_items', lambda *args: ([[]] * 400, 800))
    monkeypatch.setattr(optimizer_router, 'optimize', lambda items: weights)
    response = client.post(f'/api/optimizer/{deck.id}', headers=auth_headers_a)
    assert response.status_code == 200, response.text
    assert response.json()['applied'] is False
    assert response.json()['parameters'] == weights
    db_session.expire_all()
    assert db_session.get(Deck, deck.id).settings == '{"fsrs":true}'
    assert db_session.query(ReviewLog).count() == 0
