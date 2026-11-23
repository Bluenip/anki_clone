"""Regression tests for the second review round (media access, sessions, rate limits, TTS, leeches…)."""
import json
import os

import pytest
from sqlalchemy import text

from auth import create_reset_token
from media_utils import get_media_dir
from models import Card, Note, NoteType, SharedDeck, StudyProgress


def _media_file(user, name='private.png', data=b'\x89PNG secret'):
    os.makedirs(get_media_dir(user.id), exist_ok=True)
    with open(os.path.join(get_media_dir(user.id), name), 'wb') as out:
        out.write(data)
    return name


# ----------------------------------------------------------------------------- media access

def test_media_needs_the_owner_signed_in(client, auth_headers_a, auth_headers_b, user_a):
    name = _media_file(user_a)
    client.cookies.clear()
    assert client.get(f'/api/media/{user_a.id}/{name}').status_code == 401
    assert client.get(f'/api/media/{user_a.id}/{name}', headers=auth_headers_b).status_code == 404
    owner = client.get(f'/api/media/{user_a.id}/{name}', headers=auth_headers_a)
    assert owner.status_code == 200 and owner.content == b'\x89PNG secret'
    assert 'sandbox' in owner.headers['content-security-policy']


def test_media_cookie_from_sign_in_loads_images(client, auth_headers_a, user_a):
    name = _media_file(user_a)
    client.cookies.clear()
    me = client.get('/api/auth/me', headers=auth_headers_a)
    assert me.status_code == 200 and 'anki_media' in me.cookies
    # <img> requests carry only the cookie.
    assert client.get(f'/api/media/{user_a.id}/{name}').status_code == 200
    client.post('/api/auth/logout')
    client.cookies.clear()
    assert client.get(f'/api/media/{user_a.id}/{name}').status_code == 401


def test_media_rejects_path_tricks(client, auth_headers_a, user_a):
    _media_file(user_a)
    for name in ('..%2Fsecret', '.hidden', 'missing.png'):
        assert client.get(f'/api/media/{user_a.id}/{name}', headers=auth_headers_a).status_code == 404


def test_old_shared_copies_may_still_load_the_sharers_media(client, auth_headers_a, auth_headers_b, user_a, user_b, db_session):
    name = _media_file(user_a, 'legacy.png')
    deck = client.post('/api/decks', headers=auth_headers_b, json={'name': 'Old copy'}).json()
    db_session.add(Card(deck_id=deck['id'], front=f'<img src="/api/media/{user_a.id}/{name}">', back='x'))
    db_session.commit()
    assert client.get(f'/api/media/{user_a.id}/{name}', headers=auth_headers_b).status_code == 200


# ----------------------------------------------------------------------------- sessions and rate limits

def test_changing_the_password_signs_other_sessions_out(client, auth_headers_a):
    changed = client.put('/api/auth/me/password', headers=auth_headers_a,
                         json={'current_password': 'password123', 'new_password': 'brand-new-pass-9'})
    assert changed.status_code == 200, changed.text
    assert client.get('/api/auth/me', headers=auth_headers_a).status_code == 401  # the old token is dead
    fresh = {'Authorization': f"Bearer {changed.json()['access_token']}"}
    assert client.get('/api/auth/me', headers=fresh).status_code == 200


def test_a_password_reset_signs_every_session_out(client, auth_headers_a, user_a):
    reset = client.post('/api/auth/reset-password', json={'token': create_reset_token(user_a), 'new_password': 'another-pass-7'})
    assert reset.status_code == 200, reset.text
    assert client.get('/api/auth/me', headers=auth_headers_a).status_code == 401


def test_login_attempts_are_rate_limited(client, user_a):
    codes = [client.post('/api/auth/login', json={'email': 'user_a@example.com', 'password': 'wrong-guess'}).status_code
             for _ in range(11)]
    assert codes[:10] == [401] * 10 and codes[10] == 429
    # Even the right password waits until the window passes.
    assert client.post('/api/auth/login', json={'email': 'user_a@example.com', 'password': 'password123'}).status_code == 429


def test_reset_emails_are_rate_limited(client, monkeypatch):
    import routers.auth_router as auth_router
    monkeypatch.setattr(auth_router, 'send_reset_email', lambda *a: None)
    codes = [client.post('/api/auth/forgot-password', json={'email': 'someone@example.com'}).status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]


# ----------------------------------------------------------------------------- background audio

def test_audio_made_during_an_edit_keeps_the_edit(client, auth_headers_a, db_session, monkeypatch):
    import tts_service
    from test_tts import make_deck
    monkeypatch.setenv('TTS_URL', 'http://tts.invalid')
    deck_id = make_deck(client, auth_headers_a, [('river', 'dòng sông')])
    card = db_session.query(Card).filter_by(deck_id=deck_id).one()
    note_id = card.note_link.note_id

    def slow_synth(text):
        # The user saves a better meaning while the audio is being made.
        db_session.execute(text_sql, {'fields': json.dumps(['river', 'con sông']), 'id': note_id})
        db_session.commit()
        return b'RIFF....WAVEfmt '
    text_sql = text('UPDATE notes SET fields_json = :fields WHERE id = :id')
    assert tts_service.attach(db_session, card, synth=slow_synth) == 'added'
    db_session.commit()
    fields = json.loads(db_session.get(Note, note_id).fields_json)
    assert fields[1].startswith('con sông [sound:tts-')


def test_audio_is_not_written_for_a_deleted_account(user_a):
    import account_lifecycle
    import tts_service
    account_lifecycle.mark_deleted(user_a.id)
    target = os.path.join(get_media_dir(user_a.id), 'tts-deleted.wav')
    with pytest.raises(tts_service.TTSError):
        tts_service._save(target, b'data')
    assert not os.path.exists(target)


# ----------------------------------------------------------------------------- leeches

def test_an_unsuspended_leech_is_not_suspended_again_by_a_good_answer(client, auth_headers_a, db_session, user_a):
    deck = client.post('/api/decks', headers=auth_headers_a, json={'name': 'Leeches'}).json()
    client.put(f"/api/decks/{deck['id']}", headers=auth_headers_a,
               json={'settings': json.dumps({'leech_threshold': 3, 'leech_action': 'Suspend Card'})})
    card_id = client.post(f"/api/decks/{deck['id']}/cards", headers=auth_headers_a, json={'front': 'f', 'back': 'b'}).json()['id']
    client.post(f'/api/study/{card_id}/review', headers=auth_headers_a, json={'rating': 4})
    progress = db_session.query(StudyProgress).filter_by(card_id=card_id).one()
    progress.lapse_count, progress.is_leech, progress.is_suspended = 3, True, False  # the user unsuspended it
    from datetime import datetime, timezone
    progress.next_review = datetime.now(timezone.utc)
    db_session.commit()
    good = client.post(f'/api/study/{card_id}/review', headers=auth_headers_a, json={'rating': 3})
    assert good.status_code == 200, good.text
    db_session.expire_all()
    assert db_session.query(StudyProgress).filter_by(card_id=card_id).one().is_suspended is False


# ----------------------------------------------------------------------------- CSS, search and uploads

def test_unusual_css_urls_do_not_break_studying():
    from note_rendering import css_for_web
    css = '@font-face { src: url(fonts/a.woff2); } /* url() */ .x { background: url(ok.png) }'
    out = css_for_web(css, 7)
    assert 'url("")' in out and 'url("/api/media/7/ok.png")' in out
    with pytest.raises(ValueError):
        css_for_web(css, 7, strict=True)


def test_one_search_runs_at_most_four_regexes():
    from browser_search import tokenize
    tokenize(' '.join(f're:a{i}' for i in range(4)))
    with pytest.raises(ValueError, match='Too many regular expressions'):
        tokenize(' '.join(f'front:re:a{i}' for i in range(5)))


def test_an_account_has_at_most_three_unfinished_uploads(user_a):
    from fastapi import HTTPException
    import import_uploads
    options = lambda: {'collection_restore': False, 'include_scheduling': False}
    made = [import_uploads.create(user_a.id, f'p{i}.apkg', 1000, options()) for i in range(3)]
    with pytest.raises(HTTPException) as refused:
        import_uploads.create(user_a.id, 'p4.apkg', 1000, options())
    assert refused.value.status_code == 429
    import shutil
    for data in made:
        shutil.rmtree(import_uploads.root() / data['id'], ignore_errors=True)


# ----------------------------------------------------------------------------- LaTeX service

def test_latex_goes_to_the_compiler_service(monkeypatch):
    import io
    import latex_rendering
    sent = {}

    class Reply(io.BytesIO):
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_open(request, timeout):
        sent.update(json.loads(request.data))
        return Reply(b'\x89PNG fake')
    monkeypatch.setenv('LATEX_URL', 'http://latex:8890')
    monkeypatch.setattr('urllib.request.urlopen', fake_open)
    assert latex_rendering.available()
    assert latex_rendering.compile_png('$x$', 'H', 'F') == b'\x89PNG fake'
    assert sent == {'body': '$x$', 'header': 'H', 'footer': 'F'}


def test_latex_service_reports_compile_errors(monkeypatch):
    from fastapi.testclient import TestClient
    import latex_service
    def broken(*a): raise ValueError('LaTeX compilation failed: oops')
    monkeypatch.setattr(latex_service, 'compile_local', broken)
    reply = TestClient(latex_service.app).post('/compile', json={'body': 'x', 'header': 'h', 'footer': 'f'})
    assert reply.status_code == 422 and 'oops' in reply.json()['detail']


# ----------------------------------------------------------------------------- shared decks

def _share(client, headers, name, notes):
    deck = client.post('/api/decks', headers=headers, json={'name': name}).json()
    for kind, fields in notes:
        added = client.post('/api/notes', headers=headers, json={'deck_id': deck['id'], 'kind': kind, 'fields': fields})
        assert added.status_code == 201, added.text
    shared = client.post(f"/api/shared/decks/{deck['id']}/share", headers=headers, json={'title': name})
    assert shared.status_code == 200, shared.text
    return shared.json()['id']


def test_downloading_keeps_note_types_and_avoids_name_clashes(client, auth_headers_a, auth_headers_b, user_a, user_b, db_session):
    _media_file(user_a, 'bell.mp3', b'ID3 bell')
    shared_id = _share(client, auth_headers_a, 'Lang::Words', [
        ('cloze', {'Text': 'The {{c1::bell}} rang [sound:bell.mp3]', 'Extra': ''}),
        ('basic', {'Front': 'cat', 'Back': 'mèo'})])
    client.post('/api/decks', headers=auth_headers_b, json={'name': 'Lang::Words'})
    got = client.post(f'/api/shared/decks/{shared_id}/download', headers=auth_headers_b)
    assert got.status_code == 200, got.text
    db_session.expire_all()
    deck_id = got.json()['deck_id']
    from models import Deck
    copy = db_session.get(Deck, deck_id)
    assert copy.name == 'Lang::Words (2)' and copy.user_id == user_b.id
    cards = db_session.query(Card).filter_by(deck_id=deck_id).all()
    kinds = sorted(card.note_link.note.note_type.name for card in cards)
    assert len(cards) == 2 and any('Cloze' in k for k in kinds)
    cloze = next(c for c in cards if 'Cloze' in c.note_link.note.note_type.name)
    assert cloze.note_link.note.user_id == user_b.id
    assert '[sound:bell.mp3]' in cloze.note_link.note.fields_json
    assert os.path.isfile(os.path.join(get_media_dir(user_b.id), 'bell.mp3'))
    assert db_session.get(NoteType, cloze.note_link.note.note_type_id).user_id == user_b.id


def test_each_account_rates_a_shared_deck_once(client, auth_headers_a, auth_headers_b, db_session):
    shared_id = _share(client, auth_headers_a, 'Rated', [('basic', {'Front': 'a', 'Back': 'b'})])
    for value in (5, 5, 5, 1):
        assert client.post(f'/api/shared/decks/{shared_id}/rate', headers=auth_headers_b, json={'rating': value}).status_code == 200
    db_session.expire_all()
    deck = db_session.get(SharedDeck, shared_id)
    assert deck.rating_count == 1 and deck.rating == 1.0
