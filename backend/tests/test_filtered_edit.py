def test_edit_rebuild_stale_and_rollback(client, auth_headers_a, auth_headers_b):
    h = auth_headers_a
    deck = client.post('/api/decks', headers=h, json={'name': 'Edit session'}).json()
    note = client.post('/api/notes', headers=h, json={'deck_id': deck['id'], 'fields': {'Front': 'Q', 'Back': 'A'}}).json()
    session = client.post('/api/filtered', headers=h, json={'name': 'Original', 'search': ''}).json()
    payload = dict(name='Edited', search=f"nid:{note['id']}", reschedule=True, limit=5, expected_version=session['version'])
    url = f"/api/filtered/{session['id']}"
    assert client.put(url, headers=auth_headers_b, json=payload).status_code == 404
    changed = client.put(url, headers=h, json=payload)
    assert changed.status_code == 200, changed.text
    assert changed.json()['remaining'] == 1
    assert changed.json()['name'] == 'Edited'
    assert changed.json()['reschedule'] is True
    assert client.put(url, headers=h, json=payload).status_code == 409
    bad = {**payload, 'expected_version': changed.json()['version'], 'search': 'is:unknown'}
    assert client.put(url, headers=h, json=bad).status_code == 422
    current = client.get('/api/filtered', headers=h).json()[0]
    assert current == changed.json()
    assert client.get(f"/api/notes/{note['id']}", headers=h).json()['cards'][0]['deck_id'] == deck['id']
