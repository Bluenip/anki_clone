import json
from models import Card, Note, StudyProgress


def deck(client, headers):
    return client.post('/api/decks', headers=headers, json={'name': 'Notes'}).json()['id']


def test_reversed_note_edit_keeps_both_card_identities_and_progress(client, auth_headers_a, db_session):
    deck_id = deck(client, auth_headers_a)
    response = client.post('/api/notes', headers=auth_headers_a, json={'deck_id': deck_id, 'kind': 'reversed', 'fields': {'Front':'Q', 'Back':'A'}, 'tags':['language::vi']})
    assert response.status_code == 201, response.text
    note = response.json()
    assert len(note['cards']) == 2
    assert note['cards'][1]['front'] == 'A'
    ids = [c['id'] for c in note['cards']]
    progress = StudyProgress(user_id=db_session.get(Note, note['id']).user_id, card_id=ids[1], card_state='review', interval_days=27)
    db_session.add(progress); db_session.commit()
    response = client.put(f"/api/notes/{note['id']}", headers=auth_headers_a, json={'fields': {'Front':'New Q', 'Back':'New A'}, 'tags':['updated']})
    assert response.status_code == 200, response.text
    assert response.json()['guid'] == note['guid']
    assert [c['id'] for c in response.json()['cards']] == ids
    assert response.json()['cards'][1]['front'] == 'New A'
    db_session.refresh(progress)
    assert progress.interval_days == 27


def test_cloze_multiple_indexes_and_hint_preserve_original_fields(client, auth_headers_a):
    fields = {'Text':'{{c1::Hà Nội::capital}} và {{c3::Huế}}; {{c1::Việt Nam}}', 'Extra':''}
    response = client.post('/api/notes', headers=auth_headers_a, json={'deck_id':deck(client, auth_headers_a), 'kind':'cloze', 'fields':fields})
    assert response.status_code == 201, response.text
    note = response.json()
    assert note['fields'] == fields
    assert [c['template_ord'] for c in note['cards']] == [0,2]
    assert '[capital]' in note['cards'][0]['front']
    assert 'Huế' in note['cards'][0]['front']
    assert 'Hà Nội' in note['cards'][0]['back']


def test_removing_studied_cloze_is_rejected_without_losing_data(client, auth_headers_a, db_session):
    response = client.post('/api/notes', headers=auth_headers_a, json={'deck_id':deck(client, auth_headers_a), 'kind':'cloze', 'fields':{'Text':'{{c1::one}} {{c2::two}}','Extra':''}})
    note = response.json()
    card = db_session.get(Card, note['cards'][1]['id'])
    db_session.add(StudyProgress(user_id=card.deck.user_id, card_id=card.id, card_state='review', interval_days=8)); db_session.commit()
    response = client.put(f"/api/notes/{note['id']}", headers=auth_headers_a, json={'fields':{'Text':'{{c1::one}} two','Extra':''}})
    assert response.status_code == 400
    stored = client.get(f"/api/notes/{note['id']}", headers=auth_headers_a).json()
    assert stored['fields'] == note['fields']
    assert len(stored['cards']) == 2


def test_optional_reverse_and_cross_user_access(client, auth_headers_a, auth_headers_b):
    note = client.post('/api/notes', headers=auth_headers_a, json={'deck_id':deck(client, auth_headers_a), 'kind':'optional_reversed', 'fields':{'Front':'Q','Back':'A','Add Reverse':''}}).json()
    assert len(note['cards']) == 1
    response = client.put(f"/api/notes/{note['id']}", headers=auth_headers_a, json={'fields':{'Front':'Q','Back':'A','Add Reverse':'yes'}})
    assert response.status_code == 200, response.text
    assert len(response.json()['cards']) == 2
    assert client.get(f"/api/notes/{note['id']}", headers=auth_headers_b).status_code == 404
    assert client.get(f"/api/cards/{note['cards'][0]['id']}/note", headers=auth_headers_b).status_code == 404


def test_invalid_cloze_does_not_create_note_or_card(client, auth_headers_a, db_session):
    deck_id = deck(client, auth_headers_a)
    for text in ['No cloze', '{{c1::unclosed {{c2::cloze}}', '{{c0::bad}}']:
        response = client.post('/api/notes', headers=auth_headers_a, json={'deck_id':deck_id,'kind':'cloze','fields':{'Text':text,'Extra':''}})
        assert response.status_code == 400, response.text
    assert db_session.query(Card).filter_by(deck_id=deck_id).count() == 0
    assert db_session.query(Note).count() == 0


def test_edit_invalidates_question_open_in_another_tab(client, auth_headers_a):
    did = deck(client, auth_headers_a)
    note = client.post('/api/notes', headers=auth_headers_a, json={'deck_id':did,'kind':'basic','fields':{'Front':'Original','Back':'A'}}).json()
    card_id = note['cards'][0]['id']
    opened = client.get(f'/api/study/{did}', headers=auth_headers_a).json()
    edited = client.put(f"/api/notes/{note['id']}", headers=auth_headers_a, json={'fields':{'Front':'Changed','Back':'A'},'tags':[]})
    assert edited.status_code == 200, edited.text
    review = client.post(f'/api/study/{card_id}/review', headers=auth_headers_a,
                         json={'rating':4,'expected_version':opened['version']})
    assert review.status_code == 409
    refreshed = client.get(f'/api/study/{did}', headers=auth_headers_a).json()
    assert refreshed['front'] == 'Changed'
    assert refreshed['version'] > opened['version']
