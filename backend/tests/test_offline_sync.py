from datetime import datetime, timezone, timedelta
import uuid
from models import ReviewLog, Card, Deck


def setup_card(client, headers):
    deck = client.post('/api/decks', headers=headers, json={'name': 'Offline'}).json()['id']
    response = client.post('/api/notes', headers=headers, json={'deck_id': deck, 'kind': 'basic', 'fields': {'Front': 'Question', 'Back': 'Answer'}})
    assert response.status_code == 201, response.text
    return deck, response.json()['cards'][0]['id']


def pull(client, headers, deck, known=None):
    response = client.post('/api/sync/pull', headers=headers, json={'deck_id': deck, 'known': known or {}})
    assert response.status_code == 200, response.text
    return response.json()


def answer(card):
    return dict(request_id=str(uuid.uuid4()), card_id=card['card_id'], expected_version=card['version'], settings_hash=card['settings_hash'], rating=3, duration_ms=1000, reviewed_at=datetime.now(timezone.utc).isoformat())


def test_download_replay_idempotent_and_conflict(client, auth_headers_a, db_session):
    deck, cid = setup_card(client, auth_headers_a)
    downloaded = pull(client, auth_headers_a, deck)
    assert downloaded['cards'][0]['eligible']
    payload = answer(downloaded['cards'][0])
    response = client.post('/api/sync/review', headers=auth_headers_a, json=payload)
    assert response.status_code == 200, response.text
    retry = client.post('/api/sync/review', headers=auth_headers_a, json=payload)
    assert retry.status_code == 200, retry.text
    assert retry.json() == response.json()
    assert db_session.query(ReviewLog).filter_by(card_id=cid).count() == 1
    payload['request_id'] = str(uuid.uuid4())
    assert client.post('/api/sync/review', headers=auth_headers_a, json=payload).status_code == 409
    assert db_session.query(ReviewLog).filter_by(card_id=cid).count() == 1
    changed = pull(client, auth_headers_a, deck, downloaded['versions'])
    assert [c['card_id'] for c in changed['cards']] == [cid]


def test_download_ownership_and_deleted_cards(client, auth_headers_a, auth_headers_b, db_session):
    deck, cid = setup_card(client, auth_headers_a)
    assert client.post('/api/sync/pull', headers=auth_headers_b, json={'deck_id': deck}).status_code == 404
    data = pull(client, auth_headers_a, deck)
    assert client.post('/api/sync/review', headers=auth_headers_b, json=answer(data['cards'][0])).status_code == 409
    db_session.delete(db_session.get(Card, cid)); db_session.commit()
    deleted = pull(client, auth_headers_a, deck, data['versions'])
    assert deleted['deleted'] == [str(cid)] and not deleted['cards']


def test_settings_and_timestamp_conflicts(client, auth_headers_a, db_session):
    deck, _ = setup_card(client, auth_headers_a)
    payload = answer(pull(client, auth_headers_a, deck)['cards'][0])
    payload['reviewed_at'] = (datetime.now(timezone.utc) - timedelta(days=31)).isoformat()
    assert client.post('/api/sync/review', headers=auth_headers_a, json=payload).status_code == 422
    payload['reviewed_at'] = datetime.now(timezone.utc).isoformat()
    payload['settings_hash'] = '0' * 64
    assert client.post('/api/sync/review', headers=auth_headers_a, json=payload).status_code == 409
    assert db_session.query(ReviewLog).count() == 0


def test_unchanged_pull_and_invalid_inputs(client, auth_headers_a):
    deck, _ = setup_card(client, auth_headers_a)
    data = pull(client, auth_headers_a, deck)
    assert pull(client, auth_headers_a, deck, data['versions'])['cards'] == []
    payload = answer(data['cards'][0]); payload['rating'] = 5
    assert client.post('/api/sync/review', headers=auth_headers_a, json=payload).status_code == 422
    assert client.post('/api/sync/pull', json={'deck_id': deck}).status_code == 401


def test_offline_learning_sequence_replays_in_order(client, auth_headers_a, db_session):
    deck, cid = setup_card(client, auth_headers_a)
    assert client.put(f'/api/decks/{deck}',headers=auth_headers_a,json={'settings':'{"learning_steps":"1s 2s"}'}).status_code==200
    data=pull(client,auth_headers_a,deck)['cards'][0]
    start=datetime.now(timezone.utc)-timedelta(seconds=5)
    for index,rating in enumerate([1,3,4]):
        payload=answer(data);payload.update(expected_version=index,rating=rating,reviewed_at=(start+timedelta(seconds=index)).isoformat())
        response=client.post('/api/sync/review',headers=auth_headers_a,json=payload)
        assert response.status_code==200,response.text
        assert client.post('/api/sync/review',headers=auth_headers_a,json=payload).status_code==200
    assert db_session.query(ReviewLog).filter_by(card_id=cid).count()==3
    assert pull(client,auth_headers_a,deck)['cards'][0]['offline_state']['card_state']=='review'


def test_fsrs_new_download_is_stable(client,auth_headers_a):
    deck,_=setup_card(client,auth_headers_a)
    assert client.put(f'/api/decks/{deck}',headers=auth_headers_a,json={'settings':'{"fsrs":true}'}).status_code==200
    data=pull(client,auth_headers_a,deck)
    assert pull(client,auth_headers_a,deck,data['versions'])['cards']==[]


def offline_edit(snapshot, **changes):
    note = snapshot['notes'][0]
    return dict(request_id=str(uuid.uuid4()), note_id=note['id'], guid=note['guid'], schema_hash=note['schema_hash'], base_fields=note['fields'], base_tags=note['tags'], fields=note['fields'] | changes, tags=note['tags'])


def test_offline_edit_merge_idempotency_and_ownership(client, auth_headers_a, auth_headers_b):
    deck, cid = setup_card(client, auth_headers_a)
    data = pull(client, auth_headers_a, deck)
    edit = offline_edit(data, Front='Local question')
    assert client.post('/api/sync/note', headers=auth_headers_b, json=edit).status_code == 404
    note_id = edit['note_id']
    assert client.put(f'/api/notes/{note_id}', headers=auth_headers_a, json={'fields': {'Front': 'Question', 'Back': 'Server answer'}, 'tags': ['remote']}).status_code == 200
    edit['tags'] = ['local']
    response = client.post('/api/sync/note', headers=auth_headers_a, json=edit)
    assert response.status_code == 200, response.text
    assert response.json()['fields'] == {'Front': 'Local question', 'Back': 'Server answer'}
    assert set(response.json()['tags']) == {'local', 'remote'}
    before = client.get(f'/api/notes/{note_id}', headers=auth_headers_a).json()
    assert client.post('/api/sync/note', headers=auth_headers_a, json=edit).json() == response.json()
    after = client.get(f'/api/notes/{note_id}', headers=auth_headers_a).json()
    assert before['revision'] == after['revision'] and after['cards'][0]['id'] == cid
    edit['fields']['Back'] = 'Payload reuse'
    assert client.post('/api/sync/note', headers=auth_headers_a, json=edit).status_code == 409


def test_offline_field_conflict_and_manual_rebase(client, auth_headers_a):
    deck, _ = setup_card(client, auth_headers_a)
    edit = offline_edit(pull(client, auth_headers_a, deck), Front='Local')
    assert client.put(f"/api/notes/{edit['note_id']}", headers=auth_headers_a, json={'fields': {'Front': 'Remote', 'Back': 'Answer'}}).status_code == 200
    response = client.post('/api/sync/note', headers=auth_headers_a, json=edit)
    assert response.status_code == 409
    detail = response.json()['detail']
    assert detail['fields'] == ['Front'] and detail['remote']['fields']['Front'] == 'Remote'
    edit.update(request_id=str(uuid.uuid4()), base_fields=detail['remote']['fields'])
    assert client.post('/api/sync/note', headers=auth_headers_a, json=edit).status_code == 200


def test_review_then_edit_and_schema_change_guard(client, auth_headers_a, db_session):
    from models import Note
    deck, cid = setup_card(client, auth_headers_a)
    data = pull(client, auth_headers_a, deck)
    edit = offline_edit(data, Back='Updated answer')
    assert client.post('/api/sync/review', headers=auth_headers_a, json=answer(data['cards'][0])).status_code == 200
    response = client.post('/api/sync/note', headers=auth_headers_a, json=edit)
    assert response.status_code == 200, response.text
    assert db_session.query(ReviewLog).filter_by(card_id=cid).count() == 1
    edit = offline_edit(pull(client, auth_headers_a, deck), Front='New question')
    db_session.get(Note, edit['note_id']).note_type.css = '.card { color: red }'
    db_session.commit()
    assert client.post('/api/sync/note', headers=auth_headers_a, json=edit).status_code == 409


def test_paginated_pull_has_stable_manifest_and_no_missing_cards(client, auth_headers_a):
    deck, cid = setup_card(client, auth_headers_a)
    for i in range(3):
        assert client.post('/api/notes', headers=auth_headers_a, json={'deck_id': deck, 'kind': 'basic', 'fields': {'Front': str(i), 'Back': 'Answer'}}).status_code == 201
    pages, cursor = [], 0
    while True:
        response = client.post('/api/sync/pull', headers=auth_headers_a, json={'deck_id': deck, 'page_size': 2, 'after_id': cursor})
        assert response.status_code == 200, response.text
        pages.append(response.json())
        cursor = response.json()['next_cursor']
        if cursor is None: break
    assert len(pages) == 2 and pages[0]['revision'] == pages[1]['revision']
    assert len({c['card_id'] for p in pages for c in p['cards']}) == 4
    payload = answer(pages[0]['cards'][0])
    assert client.post('/api/sync/review', headers=auth_headers_a, json=payload).status_code == 200
    assert pull(client, auth_headers_a, deck)['revision'] != pages[0]['revision']


def test_download_over_old_5000_limit(client, auth_headers_a, db_session):
    deck, first = setup_card(client, auth_headers_a)
    db_session.execute(Card.__table__.insert(), [{'deck_id': deck, 'front': f'Q {i}', 'back': 'A'} for i in range(5000)])
    db_session.commit()
    response = client.post('/api/sync/pull', headers=auth_headers_a, json={'deck_id': deck, 'page_size': 1})
    assert response.status_code == 200, response.text
    assert len(response.json()['cards']) == 1 and response.json()['next_cursor'] == first
    last = client.post('/api/sync/pull', headers=auth_headers_a, json={'deck_id': deck, 'after_id': first + 4999, 'page_size': 2})
    assert last.status_code == 200, last.text
    assert len(last.json()['cards']) == 1 and last.json()['next_cursor'] is None


def test_merged_limits_are_checked_before_writing(client, auth_headers_a):
    deck, _ = setup_card(client, auth_headers_a)
    edit = offline_edit(pull(client, auth_headers_a, deck), Front='Local')
    note_id = edit['note_id']
    remote_tags = [f'remote{i}' for i in range(100)]
    assert client.put(f'/api/notes/{note_id}', headers=auth_headers_a, json={'fields': edit['base_fields'], 'tags': remote_tags}).status_code == 200
    edit['tags'] = ['local']
    response = client.post('/api/sync/note', headers=auth_headers_a, json=edit)
    assert response.status_code == 422
    note = client.get(f'/api/notes/{note_id}', headers=auth_headers_a).json()
    assert note['tags'] == remote_tags and note['fields'] == edit['base_fields']
