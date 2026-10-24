from copy import deepcopy

DEFINITION = dict(name='Custom', fields=['Question', 'Answer'], templates=[dict(name='Card 1', qfmt='{{Question}}', afmt='{{FrontSide}}<hr>{{Answer}}')], css='.card {color: red}')


def test_create_edit_preview_and_stale(client, auth_headers_a, auth_headers_b):
    h = auth_headers_a
    model = client.post('/api/models', headers=h, json=DEFINITION)
    assert model.status_code == 201, model.text
    model = model.json()
    deck = client.post('/api/decks', headers=h, json={'name': 'Home'}).json()
    note = client.post('/api/notes', headers=h, json=dict(deck_id=deck['id'], note_type_id=model['id'], fields={'Question': 'Q', 'Answer': 'A'})).json()
    edit = {**model, 'expected_revision': model['revision'], 'templates': [dict(name='Card 1', qfmt='{{Deck}}: {{Question}}', afmt='{{Answer}}')]}
    saved = client.put(f"/api/models/{model['id']}", headers=h, json=edit)
    assert saved.status_code == 200, saved.text
    after = client.get(f"/api/notes/{note['id']}", headers=h).json()
    assert after['cards'][0]['id'] == note['cards'][0]['id']
    assert after['cards'][0]['front'] == 'Home: Q'
    assert after['revision'] != note['revision']
    assert client.put(f"/api/models/{model['id']}", headers=h, json=edit).status_code == 409
    assert client.put(f"/api/models/{model['id']}", headers=auth_headers_b, json=edit).status_code == 404
    preview = client.post('/api/models/preview', headers=h, json={**DEFINITION, 'values': {'Question': 'Preview Q', 'Answer': 'Preview A'}})
    assert preview.status_code == 200, preview.text
    assert preview.json()['cards'][0]['front'] == 'Preview Q'
    assert client.get('/api/models', headers=auth_headers_b).json() == []


def test_atomic_field_removal_and_invalid_templates(client, auth_headers_a):
    h = auth_headers_a
    model = client.post('/api/models', headers=h, json=DEFINITION).json()
    deck = client.post('/api/decks', headers=h, json={'name': 'Home'}).json()
    note = client.post('/api/notes', headers=h, json=dict(deck_id=deck['id'], note_type_id=model['id'], fields={'Question': 'Q', 'Answer': 'A'})).json()
    bad = {**model, 'expected_revision': model['revision'], 'fields': ['Question'], 'templates': [dict(name='Card 1', qfmt='{{Question}}', afmt='{{Question}}')]}
    assert client.put(f"/api/models/{model['id']}", headers=h, json=bad).status_code == 422
    assert client.get(f"/api/notes/{note['id']}", headers=h).json() == note
    invalid = deepcopy(DEFINITION)
    invalid['templates'][0]['qfmt'] = '{{missing}}'
    assert client.post('/api/models', headers=h, json=invalid).status_code == 422
    # Adding an empty field preserves values by name, regardless of order.
    good = {**model, 'expected_revision': model['revision'], 'fields': ['Answer', 'Question', 'Extra']}
    assert client.put(f"/api/models/{model['id']}", headers=h, json=good).status_code == 200
    assert client.get(f"/api/notes/{note['id']}", headers=h).json()['fields'] == {'Question': 'Q', 'Answer': 'A', 'Extra': ''}


def test_template_change_failure_rolls_back_every_note(client, auth_headers_a):
    h = auth_headers_a
    model = client.post('/api/models', headers=h, json=DEFINITION).json()
    deck = client.post('/api/decks', headers=h, json={'name': 'Atomic'}).json()
    notes = [client.post('/api/notes', headers=h, json=dict(deck_id=deck['id'], note_type_id=model['id'], fields={'Question': 'Q', 'Answer': value})).json() for value in ['A', '']]
    bad = {**model, 'expected_revision': model['revision'], 'templates': [dict(name='Card 1', qfmt='{{Answer}}', afmt='{{Question}}')]}
    assert client.put(f"/api/models/{model['id']}", headers=h, json=bad).status_code == 422
    for original in notes:
        assert client.get(f"/api/notes/{original['id']}", headers=h).json() == original
    assert client.get('/api/models', headers=h).json()[0] == model
