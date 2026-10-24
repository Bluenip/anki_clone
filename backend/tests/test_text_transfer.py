import json
import pytest
from models import Card, Note, NoteCard, StudyProgress, ReviewLog
from text_transfer import parse_text, export_text


def make_deck(client, headers, name='Transfer'):
    response = client.post('/api/decks', headers=headers, json={'name': name})
    assert response.status_code == 201
    return response.json()['id']


def test_parser_roundtrip_unicode_quotes_multiline():
    source = [('  Việt, "one"\nsecond line  ', '<b>日本語</b>\tanswer', 'stableGuid')]
    for separator in (',', '\t'):
        result = parse_text('\ufeff' + export_text(source, separator))
        assert [(r.front, r.back, r.guid) for r in result] == source


@pytest.mark.parametrize('text', ['Q\tA\textra', 'Q\tA\nmissing', '"unterminated\tA', '#notetype:Cloze\nQ\tA', '#guid column:0\nQ\tA'])
def test_no_silent_data_loss(text):
    with pytest.raises(ValueError):
        parse_text(text)


def test_plain_text_and_mapping():
    row = parse_text('answer;<tag>', separator=';', front_column=1, back_column=0, allow_html=False)[0]
    assert row.front == '&lt;tag&gt;'
    assert row.back == 'answer'


def test_preview_atomic_import_and_guid_updates_preserve_progress(client, db_session, auth_headers_a):
    deck = make_deck(client, auth_headers_a)
    url = f'/api/decks/{deck}/import'
    data = {'text': '"Q,one",A', 'separator': ',', 'preview': True}
    preview = client.post(url, headers=auth_headers_a, json=data)
    assert preview.status_code == 200, preview.text
    assert preview.json()['added'] == 1
    assert db_session.query(Card).filter_by(deck_id=deck).count() == 0
    assert db_session.query(Note).count() == 0
    data['preview'] = False
    assert client.post(url, headers=auth_headers_a, json=data).json()['added'] == 1
    card = db_session.query(Card).filter_by(deck_id=deck).one()
    progress = StudyProgress(user_id=card.deck.user_id, card_id=card.id, interval_days=17, card_state='review')
    db_session.add(progress); db_session.commit()
    export_url = f'/api/decks/{deck}/export/text?format=csv'
    output = client.get(export_url, headers=auth_headers_a)
    assert output.status_code == 200
    assert 'text/csv' in output.headers['content-type']
    assert client.get(export_url, headers=auth_headers_a).text == output.text
    assert client.post(url, headers=auth_headers_a, json={'text': output.text, 'duplicate_policy': 'skip'}).json()['skipped'] == 1
    changed = output.text.replace('Q,one', 'Q,two').replace(',A,', ',Answer,')
    response = client.post(url, headers=auth_headers_a, json={'text': changed, 'duplicate_policy': 'update'})
    assert response.status_code == 200, response.text
    assert response.json()['updated'] == 1
    db_session.refresh(card); db_session.refresh(progress)
    assert card.front == 'Q,two'
    assert card.back == 'Answer'
    assert progress.interval_days == 17
    assert db_session.query(Card).filter_by(deck_id=deck).count() == 1
    assert json.loads(card.note_link.note.fields_json) == [card.front, card.back]


def test_invalid_batch_no_partial_write_and_cross_user_denied(client, db_session, auth_headers_a, auth_headers_b):
    deck = make_deck(client, auth_headers_a)
    url = f'/api/decks/{deck}/import'
    response = client.post(url, headers=auth_headers_a, json={'text': 'Q\tA\nbad'})
    assert response.status_code == 400
    assert db_session.query(Card).filter_by(deck_id=deck).count() == 0
    assert client.post(url, headers=auth_headers_b, json={'text':'Q\tA'}).status_code == 404
    assert client.get(f'/api/decks/{deck}/export/text', headers=auth_headers_b).status_code == 404


def test_note_identity_stays_on_edit_and_removed_with_last_card(client, db_session, auth_headers_a):
    deck = make_deck(client, auth_headers_a)
    card = client.post(f'/api/decks/{deck}/cards', headers=auth_headers_a, json={'front':'Q', 'back':'A'}).json()
    stored = db_session.get(Card, card['id'])
    guid = stored.note_link.note.guid
    client.put(f"/api/cards/{card['id']}", headers=auth_headers_a, json={'back':'New answer'})
    db_session.refresh(stored)
    assert stored.note_link.note.guid == guid
    assert json.loads(stored.note_link.note.fields_json)[1] == 'New answer'
    client.post(f"/api/study/{card['id']}/review", headers=auth_headers_a, json={'rating':4})
    assert client.delete(f"/api/cards/{card['id']}", headers=auth_headers_a).status_code == 204
    assert db_session.query(NoteCard).filter_by(card_id=card['id']).count() == 0
    assert db_session.query(ReviewLog).filter_by(card_id=card['id']).count() == 0
    assert db_session.query(Note).filter_by(guid=guid).count() == 0


@pytest.mark.parametrize('settings', [{'maximum_reviews_per_day':-1}, {'learning_steps':'broken'}, {'easy_interval':0}, {'starting_ease':float('nan')}, []])
def test_settings_reject_invalid_known_values(client, auth_headers_a, settings):
    deck = make_deck(client, auth_headers_a)
    assert client.put(f'/api/decks/{deck}', headers=auth_headers_a, json={'settings':json.dumps(settings)}).status_code == 422


def test_settings_preserve_unknown_keys(client, auth_headers_a):
    deck = make_deck(client, auth_headers_a)
    settings = {'maximum_reviews_per_day':0, 'future_feature':{'data':123}}
    response = client.put(f'/api/decks/{deck}', headers=auth_headers_a, json={'settings':json.dumps(settings)})
    assert response.status_code == 200, response.text
    assert json.loads(response.json()['settings']) == settings
