"""Regression tests for bugs confirmed in the November 2026 review."""
import io
import json
import os
import sqlite3
import zipfile

from auth import create_access_token
from media_utils import get_media_dir
from models import Card, SchedulerState
from test_review_events import setup_note
from test_quiz import make_deck as make_quiz_deck


def test_bulk_reschedule_turns_fsrs_learning_state_into_review(client, auth_headers_a, db_session):
    _, (card_id,) = setup_note(client, auth_headers_a, {'fsrs': True}, 'basic')
    reviewed = client.post(f'/api/study/{card_id}/review', headers=auth_headers_a,
                           json={'rating': 3, 'expected_version': 0, 'request_id': 'learn-once'})
    assert reviewed.status_code == 200, reviewed.text
    db_session.expire_all()
    state = db_session.get(SchedulerState, card_id)
    assert json.loads(state.fsrs_json)['card']['state'] == 1  # still on a learning step

    response = client.post('/api/cards/bulk-action', headers=auth_headers_a, json={
        'action': 'reschedule', 'due_days': 5, 'cards': [{'card_id': card_id, 'expected_version': state.version}]})
    assert response.status_code == 200, response.text
    db_session.expire_all()
    saved = json.loads(db_session.get(SchedulerState, card_id).fsrs_json)['card']
    assert saved['state'] == 2 and saved['step'] is None
    assert saved['stability'] is not None and saved['difficulty'] is not None


def test_quiz_options_stay_the_same_on_reload(client, auth_headers_a, db_session):
    from quiz import _distractors, settings_for
    from deck_options import effective_settings
    words = [(f'word{i}', f'meaning {i}') for i in range(30)]
    deck_id = make_quiz_deck(client, auth_headers_a, {'quiz_mode': True}, words=words)
    card = db_session.query(Card).filter_by(deck_id=deck_id).order_by(Card.id).first()
    settings = settings_for(effective_settings(card.deck))
    first = _distractors(db_session, card, settings, 'word', 'word0', version=1)
    assert len(first) == 3
    assert all(_distractors(db_session, card, settings, 'word', 'word0', version=1) == first for _ in range(5))


def test_token_with_non_numeric_subject_is_rejected(client):
    token = create_access_token({'sub': 'not-a-number'})
    response = client.get('/api/decks', headers={'Authorization': f'Bearer {token}'})
    assert response.status_code == 401


def test_tts_job_for_deleted_deck_fails_cleanly(db_session):
    import tts_service
    from test_tts import shared
    job = tts_service.Job(deck_id=987654, user_id=1)
    tts_service.run_job(job, shared(db_session), synth=lambda text: b'', sleep=lambda s: None)
    assert job.state == 'failed' and job.error == 'Deck was deleted'


def test_downloaded_shared_deck_gets_its_own_notes_and_media(client, auth_headers_a, auth_headers_b, user_a, user_b, db_session):
    os.makedirs(get_media_dir(user_a.id), exist_ok=True)
    with open(os.path.join(get_media_dir(user_a.id), 'shared-pic.png'), 'wb') as out:
        out.write(b'\x89PNG fake')
    deck = client.post('/api/decks', headers=auth_headers_a, json={'name': 'Pictures'}).json()
    front = f'<img src="/api/media/{user_a.id}/shared-pic.png"> cat'
    added = client.post('/api/notes', headers=auth_headers_a, json={
        'deck_id': deck['id'], 'kind': 'basic', 'fields': {'Front': front, 'Back': 'mèo'}})
    assert added.status_code == 201, added.text
    shared = client.post(f"/api/shared/decks/{deck['id']}/share", headers=auth_headers_a, json={'title': 'Pictures'})
    assert shared.status_code == 200, shared.text

    downloaded = client.post(f"/api/shared/decks/{shared.json()['id']}/download", headers=auth_headers_b)
    assert downloaded.status_code == 200, downloaded.text
    db_session.expire_all()
    copy = db_session.query(Card).filter_by(deck_id=downloaded.json()['deck_id']).one()
    assert f'/api/media/{user_b.id}/shared-pic.png' in copy.front
    assert copy.note_link is not None
    assert os.path.isfile(os.path.join(get_media_dir(user_b.id), 'shared-pic.png'))

    exported = client.get(f"/api/apkg/export/{downloaded.json()['deck_id']}", headers=auth_headers_b)
    assert exported.status_code == 200, exported.text


def test_export_keeps_a_literal_percent_in_a_media_name(client, auth_headers_a, user_a):
    os.makedirs(get_media_dir(user_a.id), exist_ok=True)
    with open(os.path.join(get_media_dir(user_a.id), 'odd%41.png'), 'wb') as out:
        out.write(b'\x89PNG odd')
    deck = client.post('/api/decks', headers=auth_headers_a, json={'name': 'Percent'}).json()
    front = f'<img src="/api/media/{user_a.id}/odd%2541.png">'
    added = client.post('/api/notes', headers=auth_headers_a, json={
        'deck_id': deck['id'], 'kind': 'basic', 'fields': {'Front': front, 'Back': 'x'}})
    assert added.status_code == 201, added.text
    exported = client.get(f"/api/apkg/export/{deck['id']}", headers=auth_headers_a)
    assert exported.status_code == 200, exported.text
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        assert 'odd%41.png' in json.loads(archive.read('media')).values()
