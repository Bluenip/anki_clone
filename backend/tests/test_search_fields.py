import json
from models import Card, PackageCard


def test_field_search_exact_wildcard_empty_and_flags(client, auth_headers_a, db_session):
    h = auth_headers_a
    deck = client.post('/api/decks', headers=h, json={'name': 'Fields'}).json()
    notes = [client.post('/api/notes', headers=h, json={'deck_id': deck['id'], 'fields': {'Front': front, 'Back': back}}).json() for front, back in [('dog', ''), ('a dog', 'dog'), ('cat', 'other')]]
    ids = [n['cards'][0]['id'] for n in notes]
    card = db_session.get(Card, ids[1]);card.package_data = PackageCard(payload=json.dumps({'flags': 11}));db_session.commit()
    def search(query):
        response = client.get('/api/cards/browse', headers=h, params={'search': query})
        assert response.status_code == 200, response.text
        return {c['id'] for c in response.json()}
    assert search('Front:dog') == {ids[0]}
    assert search('Front:*dog*') == {ids[0], ids[1]}
    assert search('Back:') == {ids[0]}
    assert search('Back:dog') == {ids[1]}
    assert search('flag:3') == {ids[1]}
    assert search('flag:0') == {ids[0], ids[2]}
    assert search('Front:*dog* -flag:3') == {ids[0]}
    assert client.get('/api/cards/browse', headers=h, params={'search': 'flag:9'}).status_code == 422


def test_set_flag_preserves_other_bits_and_rejects_stale(client, auth_headers_a, db_session):
    h = auth_headers_a
    deck = client.post('/api/decks', headers=h, json={'name': 'Flags'}).json()
    note = client.post('/api/notes', headers=h, json={'deck_id': deck['id'], 'fields': {'Front': 'Q', 'Back': 'A'}}).json()
    cid = note['cards'][0]['id']
    card = db_session.get(Card, cid);card.package_data = PackageCard(payload=json.dumps({'flags': 8, 'data': 'preserve'}));db_session.commit()
    payload = {'action': 'flag', 'flag': 5, 'cards': [{'card_id': cid, 'expected_version': 0}]}
    assert client.post('/api/cards/bulk-action', headers=h, json=payload).status_code == 200
    db_session.expire_all()
    assert json.loads(db_session.get(Card, cid).package_data.payload) == {'flags': 13, 'data': 'preserve'}
    assert client.post('/api/cards/bulk-action', headers=h, json=payload).status_code == 409
    result = client.get('/api/cards/browse', headers=h, params={'search': 'flag:5'}).json()
    assert [row['id'] for row in result] == [cid]
