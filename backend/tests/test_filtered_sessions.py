import json
from datetime import datetime, timedelta, timezone

import pytest
from models import Card, Deck, FilteredItem, FilteredSession, ReviewLog, SchedulerState, StudyOperation, StudyProgress


def make_deck(client, headers, name='Test Deck', settings=None):
    res = client.post('/api/decks', headers=headers, json={'name': name})
    assert res.status_code in (200, 201), res.text
    deck = res.json()
    if settings:
        res = client.put(f"/api/decks/{deck['id']}", headers=headers, json={'settings': json.dumps(settings)})
        assert res.status_code == 200, res.text
    return deck['id']


def make_card(client, headers, deck_id, front='Front', back='Back', tags=None):
    payload = {'deck_id': deck_id, 'kind': 'basic', 'fields': {'Front': front, 'Back': back}}
    if tags:
        payload['tags'] = tags
    res = client.post('/api/notes', headers=headers, json=payload)
    assert res.status_code == 201, res.text
    return res.json()['cards'][0]['id']


def browse(client, headers, search):
    res = client.get('/api/cards/browse', headers=headers, params={'search': search})
    assert res.status_code == 200, res.text
    return {c['id'] for c in res.json()}


# ==============================================================================
# Group 1: create / search scope / limit / ownership
# ==============================================================================

def test_create_session_validation(client, auth_headers_a):
    deck_id = make_deck(client, auth_headers_a, 'Deck A')
    make_card(client, auth_headers_a, deck_id, 'Q1', 'A1')

    # Blank name or whitespace name
    assert client.post('/api/filtered', headers=auth_headers_a, json={'name': ''}).status_code == 422
    assert client.post('/api/filtered', headers=auth_headers_a, json={'name': '   '}).status_code == 422

    # Extra fields forbidden
    res = client.post('/api/filtered', headers=auth_headers_a, json={'name': 'Valid', 'bogus_field': 123})
    assert res.status_code == 422

    # Limits: limit must be 1 <= limit <= 1000
    assert client.post('/api/filtered', headers=auth_headers_a, json={'name': 'Zero', 'limit': 0}).status_code == 422
    assert client.post('/api/filtered', headers=auth_headers_a, json={'name': 'Neg', 'limit': -1}).status_code == 422
    assert client.post('/api/filtered', headers=auth_headers_a, json={'name': 'TooBig', 'limit': 1001}).status_code == 422

    # Invalid order
    assert client.post('/api/filtered', headers=auth_headers_a, json={'name': 'BadOrder', 'order': 'invalid'}).status_code == 422

    # Invalid search syntax
    assert client.post('/api/filtered', headers=auth_headers_a, json={'name': 'BadSearch', 'search': 'tag:'}).status_code == 422

    # Valid creation with defaults
    res = client.post('/api/filtered', headers=auth_headers_a, json={'name': 'My Filtered Session', 'search': ''})
    assert res.status_code == 201
    data = res.json()
    assert data['name'] == 'My Filtered Session'
    assert data['search'] == ''
    assert data['limit'] == 100
    assert data['order'] == 'oldest'
    assert data['reschedule'] is False
    assert data['preview_again_seconds'] == 60
    assert data['preview_hard_seconds'] == 600
    assert data['preview_good_seconds'] == 0
    assert data['version'] == 0
    assert data['remaining'] == 1


def test_create_configurable_preview_delays(client, auth_headers_a):
    deck_id = make_deck(client, auth_headers_a, 'ConfigPreviewDeck')
    make_card(client, auth_headers_a, deck_id, 'Q', 'A')

    res = client.post('/api/filtered', headers=auth_headers_a, json={
        'name': 'CustomDelays',
        'search': '',
        'reschedule': False,
        'preview_again_seconds': 30,
        'preview_hard_seconds': 120,
        'preview_good_seconds': 300,
    })
    assert res.status_code == 201
    data = res.json()
    assert data['preview_again_seconds'] == 30
    assert data['preview_hard_seconds'] == 120
    assert data['preview_good_seconds'] == 300


def test_search_scope_and_user_isolation(client, auth_headers_a, auth_headers_b):
    deck_a = make_deck(client, auth_headers_a, 'Deck A')
    c_a1 = make_card(client, auth_headers_a, deck_a, 'A1', 'Ans')
    c_a2 = make_card(client, auth_headers_a, deck_a, 'A2', 'Ans')

    deck_b = make_deck(client, auth_headers_b, 'Deck B')
    c_b1 = make_card(client, auth_headers_b, deck_b, 'B1', 'Ans')

    # User A creates session with search='' -> must only find User A cards
    res_a = client.post('/api/filtered', headers=auth_headers_a, json={'name': 'Session A', 'search': ''})
    assert res_a.status_code == 201
    session_a = res_a.json()
    assert session_a['remaining'] == 2

    # User B list should not show Session A
    list_b = client.get('/api/filtered', headers=auth_headers_b).json()
    assert list_b == []

    # User B cannot access User A's session
    sid = session_a['id']
    assert client.get(f'/api/filtered/{sid}/next', headers=auth_headers_b).status_code == 404
    assert client.post(f'/api/filtered/{sid}/answer', headers=auth_headers_b,
                       json={'expected_session_version': 0, 'card_id': c_a1, 'expected_version': 1, 'rating': 3}).status_code == 404
    assert client.post(f'/api/filtered/{sid}/rebuild', headers=auth_headers_b, json={'expected_version': 0}).status_code == 404
    assert client.post(f'/api/filtered/{sid}/empty', headers=auth_headers_b, json={'expected_version': 0}).status_code == 404
    assert client.delete(f'/api/filtered/{sid}?expected_version=0', headers=auth_headers_b).status_code == 404
    assert client.post(f'/api/filtered/{sid}/undo', headers=auth_headers_b).status_code == 404


def test_limit_and_order_modes(client, auth_headers_a, db_session, user_a):
    deck_id = make_deck(client, auth_headers_a, 'OrderDeck')
    now = datetime.now(timezone.utc)
    cids = []
    for i in range(5):
        cid = make_card(client, auth_headers_a, deck_id, f'Front {i}', f'Back {i}')
        cids.append(cid)

    # Setup progress for due and lapses order
    db_session.add(StudyProgress(card_id=cids[0], user_id=user_a.id, card_state='review',
                                 next_review=now + timedelta(days=5), lapse_count=10))
    db_session.add(StudyProgress(card_id=cids[1], user_id=user_a.id, card_state='review',
                                 next_review=now + timedelta(days=1), lapse_count=1))
    db_session.add(StudyProgress(card_id=cids[2], user_id=user_a.id, card_state='review',
                                 next_review=now + timedelta(days=3), lapse_count=5))
    db_session.add(StudyProgress(card_id=cids[3], user_id=user_a.id, card_state='review',
                                 next_review=now + timedelta(days=2), lapse_count=0))
    db_session.add(StudyProgress(card_id=cids[4], user_id=user_a.id, card_state='review',
                                 next_review=now + timedelta(days=4), lapse_count=8))
    db_session.commit()

    # Test limit=2 with oldest
    res = client.post('/api/filtered', headers=auth_headers_a,
                      json={'name': 'Limit2', 'search': '', 'limit': 2, 'order': 'oldest'})
    assert res.status_code == 201
    s_id = res.json()['id']
    items = db_session.query(FilteredItem).filter_by(session_id=s_id).order_by(FilteredItem.position).all()
    assert [it.card_id for it in items] == [cids[0], cids[1]]
    client.delete(f'/api/filtered/{s_id}?expected_version=0', headers=auth_headers_a)

    # Test order='newest'
    res = client.post('/api/filtered', headers=auth_headers_a,
                      json={'name': 'Newest', 'search': '', 'limit': 3, 'order': 'newest'})
    s_id = res.json()['id']
    items = db_session.query(FilteredItem).filter_by(session_id=s_id).order_by(FilteredItem.position).all()
    assert [it.card_id for it in items] == [cids[4], cids[3], cids[2]]
    client.delete(f'/api/filtered/{s_id}?expected_version=0', headers=auth_headers_a)

    # Test order='due' (next_review asc -> cids[1], cids[3], cids[2])
    res = client.post('/api/filtered', headers=auth_headers_a,
                      json={'name': 'Due', 'search': '', 'limit': 3, 'order': 'due'})
    s_id = res.json()['id']
    items = db_session.query(FilteredItem).filter_by(session_id=s_id).order_by(FilteredItem.position).all()
    assert [it.card_id for it in items] == [cids[1], cids[3], cids[2]]
    client.delete(f'/api/filtered/{s_id}?expected_version=0', headers=auth_headers_a)

    # Test order='lapses' (lapse_count desc -> cids[0] (10), cids[4] (8), cids[2] (5))
    res = client.post('/api/filtered', headers=auth_headers_a,
                      json={'name': 'Lapses', 'search': '', 'limit': 3, 'order': 'lapses'})
    s_id = res.json()['id']
    items = db_session.query(FilteredItem).filter_by(session_id=s_id).order_by(FilteredItem.position).all()
    assert [it.card_id for it in items] == [cids[0], cids[4], cids[2]]
    client.delete(f'/api/filtered/{s_id}?expected_version=0', headers=auth_headers_a)


# ==============================================================================
# Group 2: excludes suspended / buried / alreadyotherfiltered
# ==============================================================================

def test_excludes_suspended_buried_and_other_filtered(client, auth_headers_a, db_session, user_a):
    deck_id = make_deck(client, auth_headers_a, 'ExclusionDeck')
    now = datetime.now(timezone.utc)

    c_normal = make_card(client, auth_headers_a, deck_id, 'Normal', 'A')
    c_suspended = make_card(client, auth_headers_a, deck_id, 'Suspended', 'A')
    c_buried = make_card(client, auth_headers_a, deck_id, 'Buried', 'A')
    c_in_other = make_card(client, auth_headers_a, deck_id, 'InOther', 'A')

    # Card 2 is suspended
    db_session.add(StudyProgress(card_id=c_suspended, user_id=user_a.id, card_state='review',
                                 next_review=now, is_suspended=True))
    # Card 3 is buried until tomorrow
    db_session.add(SchedulerState(card_id=c_buried, version=0, buried_until=now + timedelta(days=1)))
    db_session.commit()

    # Put c_in_other into Session 1
    res1 = client.post('/api/filtered', headers=auth_headers_a,
                       json={'name': 'Session 1', 'search': f'cid:{c_in_other}'})
    assert res1.status_code == 201
    assert res1.json()['remaining'] == 1

    # Now create Session 2 with search='' to match all cards
    res2 = client.post('/api/filtered', headers=auth_headers_a, json={'name': 'Session 2', 'search': ''})
    assert res2.status_code == 201
    s2_id = res2.json()['id']

    # Session 2 should ONLY contain c_normal!
    items2 = db_session.query(FilteredItem).filter_by(session_id=s2_id).all()
    assert [it.card_id for it in items2] == [c_normal]


def test_ineligible_card_during_study_flow(client, auth_headers_a, db_session, user_a):
    deck_id = make_deck(client, auth_headers_a, 'IneligibleDuringStudy')
    cid = make_card(client, auth_headers_a, deck_id, 'Q', 'A')

    # Put card into session
    res = client.post('/api/filtered', headers=auth_headers_a, json={'name': 'StudySession', 'search': ''})
    assert res.status_code == 201
    sid = res.json()['id']

    # Card is available
    nxt = client.get(f'/api/filtered/{sid}/next', headers=auth_headers_a).json()
    assert nxt['card']['card_id'] == cid
    card_ver = nxt['card']['version']

    # Now suspend the card in DB while in session
    progress = db_session.query(StudyProgress).filter_by(card_id=cid, user_id=user_a.id).first()
    if not progress:
        progress = StudyProgress(card_id=cid, user_id=user_a.id, card_state='new', is_suspended=True)
        db_session.add(progress)
    else:
        progress.is_suspended = True
    db_session.commit()

    # GET /next now skips this card because it is ineligible
    nxt_after = client.get(f'/api/filtered/{sid}/next', headers=auth_headers_a).json()
    assert nxt_after['card'] is None
    assert nxt_after['next_available_at'] is None

    # Answering this card returns 409
    ans = client.post(f'/api/filtered/{sid}/answer', headers=auth_headers_a,
                      json={'expected_session_version': 0, 'card_id': cid,
                            'expected_version': card_ver, 'rating': 3})
    assert ans.status_code == 409
    assert 'not available' in ans.json()['detail'].lower()


# ==============================================================================
# Group 3: previewAgain delays60s Good removes without progress/log/fsrsmutation, preserves homedeck
# ==============================================================================

def test_preview_mode_ratings_delays_and_mutations(client, auth_headers_a, db_session, user_a):
    deck_id = make_deck(client, auth_headers_a, 'HomeDeck')
    cid = make_card(client, auth_headers_a, deck_id, 'Front1', 'Back1')

    # Preview session (reschedule=False)
    res = client.post('/api/filtered', headers=auth_headers_a,
                      json={'name': 'Preview', 'search': '', 'reschedule': False})
    assert res.status_code == 201
    sid = res.json()['id']
    assert res.json()['reschedule'] is False

    # GET /next -> intervals is None in preview mode
    nxt = client.get(f'/api/filtered/{sid}/next', headers=auth_headers_a).json()
    assert nxt['card']['intervals'] is None
    assert nxt['card']['deck_name'] == 'HomeDeck'
    card_ver = nxt['card']['version']

    # Rating validation: ratings 0 and 5 are rejected with 422
    for invalid_rating in (0, 5):
        bad_ans = client.post(f'/api/filtered/{sid}/answer', headers=auth_headers_a,
                              json={'expected_session_version': 0, 'card_id': cid,
                                    'expected_version': card_ver, 'rating': invalid_rating})
        assert bad_ans.status_code == 422

    # Rating 1 (Again): delays 60s, keeps card in session, no progress/log/fsrs mutation
    ans_again = client.post(f'/api/filtered/{sid}/answer', headers=auth_headers_a,
                            json={'expected_session_version': 0, 'card_id': cid,
                                  'expected_version': card_ver, 'rating': 1})
    assert ans_again.status_code == 200
    assert ans_again.json()['session']['remaining'] == 1
    assert ans_again.json()['session']['version'] == 1

    # Check database state after Again:
    # 1. No StudyProgress
    assert db_session.query(StudyProgress).filter_by(card_id=cid).count() == 0
    # 2. No ReviewLog
    assert db_session.query(ReviewLog).filter_by(card_id=cid).count() == 0
    # 3. No FSRS mutation on SchedulerState
    state = db_session.get(SchedulerState, cid)
    assert state.fsrs_json is None
    # 4. Home deck preserved
    card = db_session.get(Card, cid)
    assert card.deck_id == deck_id
    # 5. FilteredItem available_at is ~60s in the future
    item = db_session.get(FilteredItem, cid)
    assert item is not None
    now_utc = datetime.now(timezone.utc)
    diff = (item.available_at.replace(tzinfo=timezone.utc) - now_utc).total_seconds()
    assert 50 <= diff <= 70

    # Has StudyOperation snapshot for undo
    op = db_session.query(StudyOperation).filter_by(user_id=user_a.id, card_id=cid, undone=False).one()
    op_resp = json.loads(op.response_json)
    assert op_resp.get('preview') is True
    assert op_resp.get('log_id') is None

    # GET /next returns card: None, with next_available_at string
    nxt2 = client.get(f'/api/filtered/{sid}/next', headers=auth_headers_a).json()
    assert nxt2['card'] is None
    assert nxt2['next_available_at'] is not None

    # Simulate 60s passing by moving available_at to the past
    item.available_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    db_session.commit()

    # Now GET /next returns the card again
    nxt3 = client.get(f'/api/filtered/{sid}/next', headers=auth_headers_a).json()
    assert nxt3['card'] is not None
    assert nxt3['card']['card_id'] == cid
    new_card_ver = nxt3['card']['version']
    assert new_card_ver == card_ver + 1  # version bumped on answer

    # Answer Good (rating 3): removes item (default preview_good_seconds=0) without mutating progress/log/fsrs
    ans_good = client.post(f'/api/filtered/{sid}/answer', headers=auth_headers_a,
                           json={'expected_session_version': 1, 'card_id': cid,
                                 'expected_version': new_card_ver, 'rating': 3})
    assert ans_good.status_code == 200
    assert ans_good.json()['session']['remaining'] == 0
    assert ans_good.json()['session']['version'] == 2

    # Card removed from FilteredItem
    assert db_session.get(FilteredItem, cid) is None
    # Still no StudyProgress
    assert db_session.query(StudyProgress).filter_by(card_id=cid).count() == 0
    # Still no ReviewLog
    assert db_session.query(ReviewLog).filter_by(card_id=cid).count() == 0
    # Home deck still intact
    db_session.refresh(card)
    assert card.deck_id == deck_id


def test_preview_mode_hard_and_easy_ratings(client, auth_headers_a, db_session):
    deck_id = make_deck(client, auth_headers_a, 'PreviewAllRatingsDeck')
    c_hard = make_card(client, auth_headers_a, deck_id, 'QHard', 'AHard')
    c_easy = make_card(client, auth_headers_a, deck_id, 'QEasy', 'AEasy')

    res = client.post('/api/filtered', headers=auth_headers_a,
                      json={'name': 'PreviewAll', 'search': '', 'reschedule': False})
    sid = res.json()['id']
    assert res.json()['remaining'] == 2

    nxt = client.get(f'/api/filtered/{sid}/next', headers=auth_headers_a).json()
    cid1 = nxt['card']['card_id']
    c_ver1 = nxt['card']['version']

    # Rating 2 (Hard): delays 600s (default preview_hard_seconds) and stays in session
    ans_hard = client.post(f'/api/filtered/{sid}/answer', headers=auth_headers_a,
                           json={'expected_session_version': 0, 'card_id': cid1,
                                 'expected_version': c_ver1, 'rating': 2})
    assert ans_hard.status_code == 200
    assert ans_hard.json()['session']['remaining'] == 2
    item_hard = db_session.get(FilteredItem, cid1)
    assert item_hard is not None
    now_utc = datetime.now(timezone.utc)
    diff = (item_hard.available_at.replace(tzinfo=timezone.utc) - now_utc).total_seconds()
    assert 580 <= diff <= 620

    # Rating 4 (Easy): exits session immediately
    nxt2 = client.get(f'/api/filtered/{sid}/next', headers=auth_headers_a).json()
    cid2 = nxt2['card']['card_id']
    c_ver2 = nxt2['card']['version']
    ans_easy = client.post(f'/api/filtered/{sid}/answer', headers=auth_headers_a,
                           json={'expected_session_version': 1, 'card_id': cid2,
                                 'expected_version': c_ver2, 'rating': 4})
    assert ans_easy.status_code == 200
    assert ans_easy.json()['session']['remaining'] == 1
    assert db_session.get(FilteredItem, cid2) is None


# ==============================================================================
# Group 4: reschedule4ratings useshomedeck schedule createsreview and undorestores membership/progress
# ==============================================================================

def test_reschedule_supports_all_ratings_and_uses_home_deck_schedule(client, auth_headers_a, db_session, user_a):
    # Setup home deck with custom starting ease 2.8 and string learning steps '1m 10m'
    deck_settings = {'starting_ease': 2.8, 'learning_steps': '1m 10m'}
    deck_id = make_deck(client, auth_headers_a, 'HomeScheduleDeck', settings=deck_settings)
    cid = make_card(client, auth_headers_a, deck_id, 'ReschedQ', 'ReschedA')

    # Create reschedule session
    res = client.post('/api/filtered', headers=auth_headers_a,
                      json={'name': 'RescheduleSession', 'search': '', 'reschedule': True})
    assert res.status_code == 201
    sid = res.json()['id']
    assert res.json()['reschedule'] is True

    # GET /next -> intervals is populated based on home deck config
    nxt = client.get(f'/api/filtered/{sid}/next', headers=auth_headers_a).json()
    assert nxt['card']['intervals'] is not None
    card_ver = nxt['card']['version']

    # Rating 1 (Again): card enters learning step 0. It stays in the session!
    ans = client.post(f'/api/filtered/{sid}/answer', headers=auth_headers_a,
                      json={'expected_session_version': 0, 'card_id': cid,
                            'expected_version': card_ver, 'rating': 1, 'duration_ms': 1500})
    assert ans.status_code == 200
    assert ans.json()['session']['remaining'] == 1  # Still in session!
    assert ans.json()['session']['version'] == 1

    # Check StudyProgress and ReviewLog were created
    progress = db_session.query(StudyProgress).filter_by(card_id=cid).one()
    assert progress.card_state == 'learning'
    assert progress.ease_factor == 2.8  # Used home deck's starting ease!
    assert db_session.query(ReviewLog).filter_by(card_id=cid).count() == 1

    # FilteredItem has available_at set to progress.next_review
    item = db_session.get(FilteredItem, cid)
    assert item is not None
    assert item.available_at == progress.next_review

    # Card home deck is preserved
    card = db_session.get(Card, cid)
    assert card.deck_id == deck_id


def test_reschedule_graduation_removes_card_and_undo_restores_membership(client, auth_headers_a, db_session, user_a):
    deck_id = make_deck(client, auth_headers_a, 'GraduationDeck')
    cid = make_card(client, auth_headers_a, deck_id, 'GradQ', 'GradA')

    res = client.post('/api/filtered', headers=auth_headers_a,
                      json={'name': 'GradSession', 'search': '', 'reschedule': True})
    sid = res.json()['id']

    nxt = client.get(f'/api/filtered/{sid}/next', headers=auth_headers_a).json()
    card_ver = nxt['card']['version']

    # Rating 4 (Easy) graduates new card immediately to 'review' state
    ans = client.post(f'/api/filtered/{sid}/answer', headers=auth_headers_a,
                      json={'expected_session_version': 0, 'card_id': cid,
                            'expected_version': card_ver, 'rating': 4, 'duration_ms': 2000})
    assert ans.status_code == 200
    assert ans.json()['session']['remaining'] == 0  # Graduated and removed!
    assert ans.json()['session']['version'] == 1

    # Card has progress in review state and review log
    progress = db_session.query(StudyProgress).filter_by(card_id=cid).one()
    assert progress.card_state == 'review'
    assert db_session.query(ReviewLog).filter_by(card_id=cid).count() == 1
    assert db_session.get(FilteredItem, cid) is None

    # Now UNDO the review via /api/study/undo/latest
    undo_res = client.post('/api/study/undo/latest', headers=auth_headers_a)
    assert undo_res.status_code == 200, undo_res.text

    # Undo restored:
    # 1. FilteredItem membership and position!
    item = db_session.get(FilteredItem, cid)
    assert item is not None
    assert item.session_id == sid
    assert item.position == 0
    # 2. Session remaining count is 1 again, version incremented
    s_row = db_session.get(FilteredSession, sid)
    assert s_row.version == 2
    # 3. StudyProgress deleted (card was new before)
    assert db_session.query(StudyProgress).filter_by(card_id=cid).first() is None
    # 4. ReviewLog deleted
    assert db_session.query(ReviewLog).filter_by(card_id=cid).count() == 0


def test_reschedule_consecutive_reviews_and_undos(client, auth_headers_a, db_session):
    deck_id = make_deck(client, auth_headers_a, 'ConsecutiveDeck')
    c1 = make_card(client, auth_headers_a, deck_id, 'Q1', 'A1')
    c2 = make_card(client, auth_headers_a, deck_id, 'Q2', 'A2')

    res = client.post('/api/filtered', headers=auth_headers_a,
                      json={'name': 'MultiUndoSession', 'search': '', 'reschedule': True})
    sid = res.json()['id']
    assert res.json()['remaining'] == 2

    # Card 1 answer (Easy) -> session version 0 -> 1
    nxt1 = client.get(f'/api/filtered/{sid}/next', headers=auth_headers_a).json()
    assert nxt1['card']['card_id'] == c1
    ans1 = client.post(f'/api/filtered/{sid}/answer', headers=auth_headers_a,
                       json={'expected_session_version': 0, 'card_id': c1,
                             'expected_version': nxt1['card']['version'], 'rating': 4})
    assert ans1.status_code == 200

    # Card 2 answer (Easy) -> session version 1 -> 2
    nxt2 = client.get(f'/api/filtered/{sid}/next', headers=auth_headers_a).json()
    assert nxt2['card']['card_id'] == c2
    ans2 = client.post(f'/api/filtered/{sid}/answer', headers=auth_headers_a,
                       json={'expected_session_version': 1, 'card_id': c2,
                             'expected_version': nxt2['card']['version'], 'rating': 4})
    assert ans2.status_code == 200
    assert db_session.query(FilteredItem).filter_by(session_id=sid).count() == 0

    # Undo Card 2:
    undo2 = client.post('/api/study/undo/latest', headers=auth_headers_a)
    assert undo2.status_code == 200
    assert db_session.get(FilteredItem, c2) is not None
    assert db_session.get(FilteredItem, c1) is None

    # Undo Card 1: retargeted version guard allows consecutive undo!
    undo1 = client.post('/api/study/undo/latest', headers=auth_headers_a)
    assert undo1.status_code == 200
    assert db_session.get(FilteredItem, c1) is not None
    assert db_session.get(FilteredItem, c2) is not None
    assert db_session.query(FilteredItem).filter_by(session_id=sid).count() == 2


# ==============================================================================
# Group 5: normalqueue skipsfiltered and oldregularreview rejects
# ==============================================================================

def test_normal_queue_skips_filtered_and_regular_review_rejects(client, auth_headers_a, db_session):
    deck_id = make_deck(client, auth_headers_a, 'RegularQueueDeck')
    c1 = make_card(client, auth_headers_a, deck_id, 'Q1', 'A1')
    c2 = make_card(client, auth_headers_a, deck_id, 'Q2', 'A2')

    # Both cards are currently in regular queue
    reg_card = client.get(f'/api/study/{deck_id}', headers=auth_headers_a).json()
    assert reg_card['card_id'] in (c1, c2)

    # Put c1 into a filtered session
    res = client.post('/api/filtered', headers=auth_headers_a,
                      json={'name': 'FilterOne', 'search': f'cid:{c1}'})
    assert res.status_code == 201
    sid = res.json()['id']
    assert res.json()['remaining'] == 1

    # Regular queue now ONLY returns c2! c1 is skipped!
    reg_card_after = client.get(f'/api/study/{deck_id}', headers=auth_headers_a).json()
    assert reg_card_after['card_id'] == c2

    # Attempting regular review on c1 is rejected with 409
    c1_state = db_session.get(SchedulerState, c1)
    rev_res = client.post(f'/api/study/{c1}/review', headers=auth_headers_a,
                          json={'rating': 3, 'expected_version': c1_state.version})
    assert rev_res.status_code == 409
    assert 'Card is in a custom study session' in rev_res.json()['detail']

    # Empty the session
    emp = client.post(f'/api/filtered/{sid}/empty', headers=auth_headers_a, json={'expected_version': 0})
    assert emp.status_code == 200

    # Now regular review on c1 succeeds!
    db_session.refresh(c1_state)
    rev_res_after = client.post(f'/api/study/{c1}/review', headers=auth_headers_a,
                                json={'rating': 3, 'expected_version': c1_state.version})
    assert rev_res_after.status_code == 200


# ==============================================================================
# Group 6: empty / delete releasecards neverdeletecards
# ==============================================================================

def test_empty_releases_cards_never_deletes(client, auth_headers_a, db_session):
    deck_id = make_deck(client, auth_headers_a, 'EmptyDeck')
    c1 = make_card(client, auth_headers_a, deck_id, 'Q1', 'A1')
    c2 = make_card(client, auth_headers_a, deck_id, 'Q2', 'A2')

    res = client.post('/api/filtered', headers=auth_headers_a,
                      json={'name': 'EmptyMe', 'search': ''})
    sid = res.json()['id']
    assert res.json()['remaining'] == 2

    # Empty session
    emp = client.post(f'/api/filtered/{sid}/empty', headers=auth_headers_a, json={'expected_version': 0})
    assert emp.status_code == 200
    assert emp.json()['remaining'] == 0
    assert emp.json()['version'] == 1

    # Verify cards still exist in database and belong to their deck!
    assert db_session.get(Card, c1) is not None
    assert db_session.get(Card, c2) is not None
    assert db_session.get(Card, c1).deck_id == deck_id
    assert db_session.get(Card, c2).deck_id == deck_id
    assert db_session.query(FilteredItem).filter_by(session_id=sid).count() == 0


def test_delete_releases_cards_never_deletes(client, auth_headers_a, db_session):
    deck_id = make_deck(client, auth_headers_a, 'DeleteDeck')
    c1 = make_card(client, auth_headers_a, deck_id, 'Q1', 'A1')

    res = client.post('/api/filtered', headers=auth_headers_a, json={'name': 'DeleteMe', 'search': ''})
    sid = res.json()['id']
    assert res.json()['remaining'] == 1

    # Delete session
    del_res = client.delete(f'/api/filtered/{sid}?expected_version=0', headers=auth_headers_a)
    assert del_res.status_code == 200
    assert del_res.json() == {'deleted': True}

    # Session is gone
    assert db_session.get(FilteredSession, sid) is None
    # Card is NOT deleted
    assert db_session.get(Card, c1) is not None
    assert db_session.get(Card, c1).deck_id == deck_id
    assert db_session.get(FilteredItem, c1) is None


# ==============================================================================
# Group 7: stale session/card revisions atomic rollback
# ==============================================================================

def test_stale_session_version_guard(client, auth_headers_a, db_session):
    deck_id = make_deck(client, auth_headers_a, 'StaleSessionDeck')
    cid = make_card(client, auth_headers_a, deck_id, 'Q', 'A')

    res = client.post('/api/filtered', headers=auth_headers_a, json={'name': 'StaleSess', 'search': ''})
    sid = res.json()['id']
    card_ver = client.get(f'/api/filtered/{sid}/next', headers=auth_headers_a).json()['card']['version']

    # Wrong expected_session_version on answer -> 409
    ans_bad = client.post(f'/api/filtered/{sid}/answer', headers=auth_headers_a,
                          json={'expected_session_version': 99, 'card_id': cid,
                                'expected_version': card_ver, 'rating': 3})
    assert ans_bad.status_code == 409
    assert 'session changed' in ans_bad.json()['detail'].lower()

    # Wrong expected_version on rebuild -> 409
    assert client.post(f'/api/filtered/{sid}/rebuild', headers=auth_headers_a,
                       json={'expected_version': 99}).status_code == 409

    # Wrong expected_version on empty -> 409
    assert client.post(f'/api/filtered/{sid}/empty', headers=auth_headers_a,
                       json={'expected_version': 99}).status_code == 409

    # Wrong expected_version on delete -> 409
    assert client.delete(f'/api/filtered/{sid}?expected_version=99', headers=auth_headers_a).status_code == 409

    # Session version remains unchanged (0)
    assert db_session.get(FilteredSession, sid).version == 0


def test_stale_card_version_rejection_and_atomic_rollback(client, auth_headers_a, db_session):
    deck_id = make_deck(client, auth_headers_a, 'StaleCardDeck')
    cid1 = make_card(client, auth_headers_a, deck_id, 'Q1', 'A1')
    cid2 = make_card(client, auth_headers_a, deck_id, 'Q2', 'A2')

    # Test in preview mode with cid1
    res = client.post('/api/filtered', headers=auth_headers_a,
                      json={'name': 'StaleCardPreview', 'search': f'cid:{cid1}', 'reschedule': False})
    sid = res.json()['id']

    # Valid session version (0), but wrong card version (999)
    ans = client.post(f'/api/filtered/{sid}/answer', headers=auth_headers_a,
                      json={'expected_session_version': 0, 'card_id': cid1,
                            'expected_version': 999, 'rating': 3})
    assert ans.status_code == 409
    assert 'changed in another tab' in ans.json()['detail'].lower()

    # Verify atomic rollback: session version was NOT incremented!
    assert db_session.get(FilteredSession, sid).version == 0
    # Card is still in session!
    assert db_session.get(FilteredItem, cid1) is not None

    # Test in reschedule mode with fresh card cid2
    res2 = client.post('/api/filtered', headers=auth_headers_a,
                       json={'name': 'StaleCardResched', 'search': f'cid:{cid2}', 'reschedule': True})
    sid2 = res2.json()['id']

    ans2 = client.post(f'/api/filtered/{sid2}/answer', headers=auth_headers_a,
                       json={'expected_session_version': 0, 'card_id': cid2,
                             'expected_version': 999, 'rating': 4})
    assert ans2.status_code == 409
    assert 'changed in another tab' in ans2.json()['detail'].lower()

    # Atomic rollback: session version 0, no ReviewLog created
    assert db_session.get(FilteredSession, sid2).version == 0
    assert db_session.query(ReviewLog).filter_by(card_id=cid2).count() == 0


# ==============================================================================
# Group 8: rebuild invalidates old answer / undo
# ==============================================================================

def test_rebuild_invalidates_stale_answer(client, auth_headers_a):
    deck_id = make_deck(client, auth_headers_a, 'RebuildDeck')
    cid = make_card(client, auth_headers_a, deck_id, 'Q', 'A')

    res = client.post('/api/filtered', headers=auth_headers_a, json={'name': 'RebuildAns', 'search': ''})
    sid = res.json()['id']
    nxt = client.get(f'/api/filtered/{sid}/next', headers=auth_headers_a).json()
    card_ver = nxt['card']['version']

    # Tab B rebuilds the session
    reb = client.post(f'/api/filtered/{sid}/rebuild', headers=auth_headers_a, json={'expected_version': 0})
    assert reb.status_code == 200
    assert reb.json()['version'] == 1

    # Tab A answers with old expected_session_version 0 -> rejected with 409!
    ans = client.post(f'/api/filtered/{sid}/answer', headers=auth_headers_a,
                      json={'expected_session_version': 0, 'card_id': cid,
                            'expected_version': card_ver, 'rating': 3})
    assert ans.status_code == 409
    assert 'session changed' in ans.json()['detail'].lower()


def test_empty_or_rebuild_invalidates_old_undo(client, auth_headers_a):
    deck_id = make_deck(client, auth_headers_a, 'RebuildUndoDeck')
    cid = make_card(client, auth_headers_a, deck_id, 'Q', 'A')

    res = client.post('/api/filtered', headers=auth_headers_a,
                      json={'name': 'RebuildUndo', 'search': '', 'reschedule': True})
    sid = res.json()['id']
    nxt = client.get(f'/api/filtered/{sid}/next', headers=auth_headers_a).json()

    # Review card (graduates) -> session version becomes 1
    ans = client.post(f'/api/filtered/{sid}/answer', headers=auth_headers_a,
                      json={'expected_session_version': 0, 'card_id': cid,
                            'expected_version': nxt['card']['version'], 'rating': 4})
    assert ans.status_code == 200

    # Empty the session -> session version becomes 2
    emp = client.post(f'/api/filtered/{sid}/empty', headers=auth_headers_a, json={'expected_version': 1})
    assert emp.status_code == 200
    assert emp.json()['version'] == 2

    # Attempt undo: fails because session changed!
    undo_res = client.post('/api/study/undo/latest', headers=auth_headers_a)
    assert undo_res.status_code == 409
    assert 'Custom study session changed' in undo_res.json()['detail']


def test_deleted_session_invalidates_undo(client, auth_headers_a):
    deck_id = make_deck(client, auth_headers_a, 'DeleteUndoDeck')
    cid = make_card(client, auth_headers_a, deck_id, 'Q', 'A')

    res = client.post('/api/filtered', headers=auth_headers_a,
                      json={'name': 'DelUndo', 'search': '', 'reschedule': True})
    sid = res.json()['id']
    nxt = client.get(f'/api/filtered/{sid}/next', headers=auth_headers_a).json()

    # Review card
    client.post(f'/api/filtered/{sid}/answer', headers=auth_headers_a,
                json={'expected_session_version': 0, 'card_id': cid,
                      'expected_version': nxt['card']['version'], 'rating': 4})

    # Delete session
    client.delete(f'/api/filtered/{sid}?expected_version=1', headers=auth_headers_a)

    # Undo rejected
    undo_res = client.post('/api/study/undo/latest', headers=auth_headers_a)
    assert undo_res.status_code == 409
    assert 'Custom study session changed' in undo_res.json()['detail']


def test_card_moved_to_another_session_invalidates_undo(client, auth_headers_a):
    deck_id = make_deck(client, auth_headers_a, 'MoveCardDeck')
    cid = make_card(client, auth_headers_a, deck_id, 'Q', 'A')

    # Session 1
    res1 = client.post('/api/filtered', headers=auth_headers_a,
                       json={'name': 'Sess1', 'search': '', 'reschedule': True})
    s1_id = res1.json()['id']
    nxt1 = client.get(f'/api/filtered/{s1_id}/next', headers=auth_headers_a).json()

    # Review in Session 1 (graduates, leaves Session 1)
    client.post(f'/api/filtered/{s1_id}/answer', headers=auth_headers_a,
                json={'expected_session_version': 0, 'card_id': cid,
                      'expected_version': nxt1['card']['version'], 'rating': 4})

    # Create Session 2 which captures this card
    res2 = client.post('/api/filtered', headers=auth_headers_a,
                       json={'name': 'Sess2', 'search': f'cid:{cid}'})
    assert res2.status_code == 201
    assert res2.json()['remaining'] == 1

    # Attempting to undo Session 1's review is rejected with 409
    undo_res = client.post('/api/study/undo/latest', headers=auth_headers_a)
    assert undo_res.status_code == 409


# ==============================================================================
# Group 9: deck:filtered search
# ==============================================================================

def test_deck_filtered_browser_search(client, auth_headers_a):
    deck_id = make_deck(client, auth_headers_a, 'BrowseDeck')
    c1 = make_card(client, auth_headers_a, deck_id, 'FilteredCard1', 'A')
    c2 = make_card(client, auth_headers_a, deck_id, 'FilteredCard2', 'A')
    c3 = make_card(client, auth_headers_a, deck_id, 'UnfilteredCard', 'A')

    # Initially, no cards in filtered session
    assert browse(client, auth_headers_a, 'deck:filtered') == set()
    assert {c1, c2, c3}.issubset(browse(client, auth_headers_a, '-deck:filtered'))

    # Put c1 and c2 in filtered session
    res = client.post('/api/filtered', headers=auth_headers_a,
                      json={'name': 'SearchSession', 'search': f'cid:{c1},{c2}'})
    assert res.status_code == 201
    sid = res.json()['id']

    # deck:filtered finds exactly c1 and c2
    assert browse(client, auth_headers_a, 'deck:filtered') == {c1, c2}
    # -deck:filtered excludes c1 and c2
    assert c1 not in browse(client, auth_headers_a, '-deck:filtered')
    assert c2 not in browse(client, auth_headers_a, '-deck:filtered')
    assert c3 in browse(client, auth_headers_a, '-deck:filtered')

    # Empty the session
    client.post(f'/api/filtered/{sid}/empty', headers=auth_headers_a, json={'expected_version': 0})

    # Now deck:filtered returns empty again
    assert browse(client, auth_headers_a, 'deck:filtered') == set()
    assert {c1, c2, c3}.issubset(browse(client, auth_headers_a, '-deck:filtered'))


# ==============================================================================
# Group 10: Scoped session undo protects against foreign latest operations
# ==============================================================================

def test_scoped_session_undo_and_foreign_op_protection(client, auth_headers_a, db_session):
    deck1 = make_deck(client, auth_headers_a, 'ScopedUndoDeck1')
    deck2 = make_deck(client, auth_headers_a, 'ScopedUndoDeck2')
    c1 = make_card(client, auth_headers_a, deck1, 'CardSess1', 'A')
    c2 = make_card(client, auth_headers_a, deck2, 'CardRegular', 'A')

    # Session 1 with c1
    res1 = client.post('/api/filtered', headers=auth_headers_a,
                       json={'name': 'Sess1', 'search': f'cid:{c1}', 'reschedule': False})
    s1_id = res1.json()['id']

    # Answer c1 in Session 1 (preview mode Again)
    nxt1 = client.get(f'/api/filtered/{s1_id}/next', headers=auth_headers_a).json()
    client.post(f'/api/filtered/{s1_id}/answer', headers=auth_headers_a,
                json={'expected_session_version': 0, 'card_id': c1,
                      'expected_version': nxt1['card']['version'], 'rating': 1})

    # Now perform a regular review on c2 in normal study queue
    c2_state = db_session.get(SchedulerState, c2)
    rev2 = client.post(f'/api/study/{c2}/review', headers=auth_headers_a,
                       json={'rating': 3, 'expected_version': c2_state.version if c2_state else 0})
    assert rev2.status_code == 200

    # The latest operation in user_a's history is now the review of c2!
    # Calling POST /api/filtered/{s1_id}/undo must fail because latest op is NOT from s1_id!
    scoped_undo = client.post(f'/api/filtered/{s1_id}/undo', headers=auth_headers_a)
    assert scoped_undo.status_code == 409
    assert 'The latest undoable answer is not from this session' in scoped_undo.json()['detail']

    # Undo the regular review first via global undo
    global_undo = client.post('/api/study/undo/latest', headers=auth_headers_a)
    assert global_undo.status_code == 200

    # Now the latest operation IS from s1_id! Scoped session undo succeeds!
    scoped_undo_ok = client.post(f'/api/filtered/{s1_id}/undo', headers=auth_headers_a)
    assert scoped_undo_ok.status_code == 200
    assert scoped_undo_ok.json()['session']['remaining'] == 1
