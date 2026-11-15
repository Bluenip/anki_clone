from datetime import datetime, timezone


def test_waiting_time_is_sent_with_its_timezone(client, auth_headers_a):
    deck = client.post('/api/decks', headers=auth_headers_a, json={'name': 'Clock'}).json()
    note = client.post('/api/notes', headers=auth_headers_a, json={'deck_id': deck['id'], 'kind': 'basic',
                                                                  'fields': {'Front': 'sunset', 'Back': 'hoàng hôn'}}).json()
    card_id = note['cards'][0]['id']
    assert client.post(f'/api/study/{card_id}/review', headers=auth_headers_a, json={'rating': 1}).status_code == 200
    stats = client.get(f"/api/study/{deck['id']}/stats", headers=auth_headers_a).json()
    waiting = stats['next_learning_at']
    # Without an offset a browser in Vietnam would show the UTC clock time as local time (7 hours off).
    assert waiting.endswith('Z') or waiting.endswith('+00:00'), waiting
    parsed = datetime.fromisoformat(waiting.replace('Z', '+00:00'))
    assert 0 < (parsed - datetime.now(timezone.utc)).total_seconds() < 3600
    deck_info = client.get(f"/api/decks/{deck['id']}", headers=auth_headers_a).json()
    assert deck_info['created_at'].endswith(('Z', '+00:00'))
