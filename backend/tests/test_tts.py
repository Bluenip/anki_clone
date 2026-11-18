import io
import json
import os
import urllib.error
import wave

import pytest

import tts_service
from models import Card, Deck
from quiz import card_material, settings_for


def fake_wav(seconds=0.5, rate=24000):
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(b'\1\0' * int(rate * seconds))
    return buffer.getvalue()


class FakeSynth:
    """Stands in for the Kokoro service; ``failures`` are raised first, one per call."""

    def __init__(self, failures=(), rate=24000):
        self.calls = []
        self.failures = list(failures)
        self.rate = rate

    def __call__(self, text):
        self.calls.append(text)
        if self.failures:
            raise self.failures.pop(0)
        return fake_wav(rate=self.rate)


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setenv('TTS_URL', 'http://tts.test:8880')
    monkeypatch.setenv('KOKORO_VOICE', 'af_test')
    # Notes created in tests must not call the service in the background.
    monkeypatch.setattr(tts_service, 'attach_in_background', lambda *a, **k: None)


class SharedSession:
    """Lets a job use the test's transactional session without closing it."""

    def __init__(self, session):
        self._session = session

    def __getattr__(self, name):
        return getattr(self._session, name)

    def close(self):
        pass


def shared(db_session):
    return lambda: SharedSession(db_session)


def make_deck(client, headers, rows, kind='basic', name='Words'):
    deck = client.post('/api/decks', headers=headers, json={'name': name}).json()
    for front, back in rows:
        fields = {'Front': front, 'Back': back}
        assert client.post('/api/notes', headers=headers, json={'deck_id': deck['id'], 'kind': kind, 'fields': fields}).status_code == 201
    return deck['id']


def fields_of(db, card):
    note = card.note_link.note
    db.refresh(note)
    return dict(zip(json.loads(note.note_type.fields_json), json.loads(note.fields_json)))


def run(job, db_session, synth, **kw):
    return tts_service.run_job(job, shared(db_session), synth=synth, sleep=lambda s: None, **kw)


class FakeResponse:
    def __init__(self, data):
        self.data = data

    def read(self):
        return self.data

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_speech_text_turns_separators_into_pauses():
    assert tts_service.speech_text('Go – went') == 'Go, went'
    assert tts_service.speech_text('was/were') == 'was, were'
    assert tts_service.speech_text('  look up ') == 'look up'


def test_synthesize_posts_text_and_voice_to_the_service(configured):
    seen = {}

    def opener(request, timeout):
        seen['url'], seen['body'], seen['timeout'] = request.full_url, json.loads(request.data), timeout
        return FakeResponse(fake_wav())

    data = tts_service.synthesize('apple', opener=opener)
    assert seen == {'url': 'http://tts.test:8880/speak', 'body': {'text': 'apple', 'voice': 'af_test'}, 'timeout': 120}
    assert tts_service.wave.open(io.BytesIO(data)).getframerate() == 24000


def test_synthesize_classifies_errors(configured):
    def fails(exc):
        def opener(request, timeout):
            raise exc
        return opener

    cases = [
        (urllib.error.HTTPError('u', 503, 'busy', {}, io.BytesIO(b'loading')), 'busy'),
        (urllib.error.HTTPError('u', 422, 'bad', {}, io.BytesIO(b'Nothing to say')), 'other'),
        (urllib.error.URLError('refused'), 'network'),
        (TimeoutError('slow'), 'network'),
    ]
    for exc, kind in cases:
        with pytest.raises(tts_service.TTSError) as caught:
            tts_service.synthesize('apple', opener=fails(exc))
        assert caught.value.kind == kind
    with pytest.raises(tts_service.TTSError) as caught:
        tts_service.synthesize('apple', opener=lambda r, timeout: FakeResponse(b'not a wav'))
    assert caught.value.kind == 'bad_response'


def test_service_is_off_without_url(monkeypatch):
    monkeypatch.delenv('TTS_URL', raising=False)
    assert tts_service.enabled() is False
    with pytest.raises(tts_service.TTSError):
        tts_service.synthesize('apple')


def test_attach_adds_audio_to_meaning_and_is_idempotent(client, auth_headers_a, db_session, configured):
    deck_id = make_deck(client, auth_headers_a, [('Go – went', 'Đi – đã đi')])
    card = db_session.query(Card).filter_by(deck_id=deck_id).one()
    synth = FakeSynth()
    assert tts_service.attach(db_session, card, synth=synth) == 'added'
    db_session.commit()
    fields = fields_of(db_session, card)
    assert fields['Front'] == 'Go – went'  # the word field is never touched
    assert fields['Back'].startswith('Đi – đã đi [sound:tts-') and fields['Back'].endswith('.wav]')
    assert synth.calls == ['Go, went']
    assert tts_service.attach(db_session, card, synth=synth) == 'skipped'
    assert synth.calls == ['Go, went']
    # The quiz now has real audio for listening exercises, and the meaning prompt stays clean.
    material = card_material(card, settings_for({}))
    assert material['sound'].startswith('tts-') and material['meaning'] == 'Đi – đã đi'
    user_id = db_session.query(Deck).get(deck_id).user_id
    from media_utils import get_media_dir
    assert os.path.exists(os.path.join(get_media_dir(user_id), material['sound']))


def test_cards_that_already_have_audio_or_no_word_are_skipped(client, auth_headers_a, db_session, configured):
    deck_id = make_deck(client, auth_headers_a, [('apple [sound:apple.mp3]', 'quả táo'), ('Vitamin', 'Vitamin'),
                                                 ('[sound:theme.mp3]', 'Schubert'),
                                                 ('Thứ tự gợi nhớ theo âm Hán - Việt: phết xiêu, chủ chấm, dẫn chậm, sước đi', 'Giới thiệu')])
    synth = FakeSynth()
    for card in db_session.query(Card).filter_by(deck_id=deck_id):
        assert tts_service.attach(db_session, card, synth=synth) == 'skipped'
    assert synth.calls == []


def test_job_voices_each_word_once_and_reuses_audio(client, auth_headers_a, db_session, configured):
    deck_id = make_deck(client, auth_headers_a, [('Fizzy drinks', 'Nước ngọt có ga'), ('Lip balm', 'Son dưỡng môi'),
                                                 ('Volunteer', 'Tình nguyện viên'), ('Fizzy drinks', 'Nước có ga (trùng)')],
                        kind='reversed')
    user_id = db_session.query(Deck).get(deck_id).user_id
    synth = FakeSynth()
    job = tts_service.Job(deck_id=deck_id, user_id=user_id)
    run(job, db_session, synth)
    assert job.state == 'done', job.error
    assert job.total == 3 and job.done_words == 3 and job.failed == 0
    assert job.added == 4  # both "Fizzy drinks" notes get the same file
    assert sorted(synth.calls) == ['Fizzy drinks', 'Lip balm', 'Volunteer']
    # A finished deck needs no further requests.
    again = tts_service.Job(deck_id=deck_id, user_id=user_id)
    run(again, db_session, synth)
    assert again.total == 0 and len(synth.calls) == 3


def test_busy_service_is_retried_and_a_bad_word_does_not_stop_the_deck(client, auth_headers_a, db_session, configured):
    deck_id = make_deck(client, auth_headers_a, [('Sunrise', 'Bình minh'), ('Sunset', 'Hoàng hôn')])
    user_id = db_session.query(Deck).get(deck_id).user_id
    busy = tts_service.TTSError('busy', 'loading')
    bad = tts_service.TTSError('other', 'Nothing to say')
    synth = FakeSynth(failures=[busy, busy, bad])  # Sunrise: 2 busy then a hard error; Sunset: fine
    job = tts_service.Job(deck_id=deck_id, user_id=user_id)
    run(job, db_session, synth)
    assert job.state == 'done' and job.failed == 1 and job.done_words == 1
    assert synth.calls == ['Sunrise', 'Sunrise', 'Sunrise', 'Sunset']


def test_job_gives_up_when_the_service_stays_down(client, auth_headers_a, db_session, configured, monkeypatch):
    monkeypatch.setattr(tts_service, 'MAX_ERRORS', 2)
    deck_id = make_deck(client, auth_headers_a, [('One', 'Một'), ('Two', 'Hai'), ('Three', 'Ba')])
    user_id = db_session.query(Deck).get(deck_id).user_id
    down = [tts_service.TTSError('network', 'refused')] * 20
    synth = FakeSynth(failures=down)
    job = tts_service.Job(deck_id=deck_id, user_id=user_id)
    run(job, db_session, synth)
    assert job.state == 'failed' and 'refused' in job.error
    assert len(synth.calls) == 2 * tts_service.RETRIES  # two words, three tries each, then it stops


def test_cancel_stops_before_the_next_word(client, auth_headers_a, db_session, configured):
    deck_id = make_deck(client, auth_headers_a, [('One', 'Một'), ('Two', 'Hai')])
    user_id = db_session.query(Deck).get(deck_id).user_id
    job = tts_service.Job(deck_id=deck_id, user_id=user_id)

    def synth(text):
        job.cancel.set()
        return fake_wav()

    run(job, db_session, synth)
    assert job.state == 'stopped' and job.done_words == 1


def test_upgrade_replaces_piper_audio_with_kokoro_in_place(client, auth_headers_a, db_session, configured):
    deck_id = make_deck(client, auth_headers_a, [('Amphibious', 'Lưỡng cư'), ('Prehistoric', 'Tiền sử'), ('Tadpole', 'Nòng nọc')])
    user_id = db_session.query(Deck).get(deck_id).user_id
    # Older audio: two words from the Piper voice (22.05 kHz), one from Gemini (24 kHz).
    run(tts_service.Job(deck_id=deck_id, user_id=user_id), db_session, FakeSynth(rate=22050))
    from media_utils import get_media_dir
    tadpole = next(c for c in db_session.query(Card).filter_by(deck_id=deck_id) if c.front.startswith('Tadpole'))
    gemini_file = os.path.join(get_media_dir(user_id), card_material(tadpole, settings_for({}))['sound'])
    with open(gemini_file, 'wb') as out:
        out.write(fake_wav(rate=24000))
    assert client.get(f'/api/decks/{deck_id}/tts/summary', headers=auth_headers_a).json()['piper_words'] == 2
    before = {c.id: (c.front, c.back) for c in db_session.query(Card).filter_by(deck_id=deck_id)}

    synth = FakeSynth()
    job = tts_service.Job(deck_id=deck_id, user_id=user_id, mode='upgrade')
    run(job, db_session, synth)
    assert job.state == 'done' and job.added == 2 and sorted(synth.calls) == ['Amphibious', 'Prehistoric']
    assert client.get(f'/api/decks/{deck_id}/tts/summary', headers=auth_headers_a).json()['piper_words'] == 0
    # Same file names, so the cards themselves did not change.
    assert {c.id: (c.front, c.back) for c in db_session.query(Card).filter_by(deck_id=deck_id)} == before


def test_endpoints_report_configuration_and_ownership(client, auth_headers_a, auth_headers_b, monkeypatch):
    monkeypatch.delenv('TTS_URL', raising=False)
    deck_id = make_deck(client, auth_headers_a, [('Sunburn', 'Cháy nắng')])
    assert client.get('/api/tts/status', headers=auth_headers_a).json()['enabled'] is False
    assert client.post(f'/api/decks/{deck_id}/tts', headers=auth_headers_a).status_code == 503
    assert client.get(f'/api/decks/{deck_id}/tts', headers=auth_headers_a).json() == {'state': 'idle'}
    assert client.get(f'/api/decks/{deck_id}/tts', headers=auth_headers_b).status_code == 404
    assert client.post(f'/api/decks/{deck_id}/tts', headers=auth_headers_b).status_code == 404
    monkeypatch.setenv('TTS_URL', 'http://tts.test:8880')
    status = client.get('/api/tts/status', headers=auth_headers_a).json()
    assert status['enabled'] is True and status['engine'] == 'kokoro'


def test_stop_marks_a_running_job_as_stopping(client, auth_headers_a, db_session, configured):
    deck_id = make_deck(client, auth_headers_a, [('Oath', 'Lời thề')])
    user_id = db_session.query(Deck).get(deck_id).user_id
    job = tts_service.Job(deck_id=deck_id, user_id=user_id, state='running')
    with tts_service._jobs_lock:
        tts_service._jobs[(user_id, deck_id)] = job
    try:
        assert client.post(f'/api/decks/{deck_id}/tts/cancel', headers=auth_headers_a).json()['state'] == 'stopping'
        assert job.cancel.is_set()
        # Pressing Stop again does not restart anything or change the state.
        assert client.post(f'/api/decks/{deck_id}/tts/cancel', headers=auth_headers_a).json()['state'] == 'stopping'
    finally:
        with tts_service._jobs_lock:
            tts_service._jobs.pop((user_id, deck_id), None)


@pytest.mark.skipif(not os.getenv('KOKORO_TEST_URL'), reason='Set KOKORO_TEST_URL to a running Kokoro service')
def test_real_kokoro_service_voices_words_and_pairs(monkeypatch):
    monkeypatch.setenv('TTS_URL', os.environ['KOKORO_TEST_URL'])
    for word in ('apple', 'go – went'):
        data = tts_service.synthesize(tts_service.speech_text(word))
        with wave.open(io.BytesIO(data)) as source:
            assert source.getframerate() == 24000
            assert 0.2 < source.getnframes() / 24000 < 5


# --------------------------------------------------------------------------- audio follows edits

def voiced_note(client, headers, db_session, front='aple', back='quả táo', kind='basic'):
    """A note whose pronunciation was generated for its current word."""
    deck_id = make_deck(client, headers, [(front, back)], kind=kind)
    card = db_session.query(Card).filter_by(deck_id=deck_id).first()
    assert tts_service.attach(db_session, card, synth=FakeSynth()) == 'added'
    db_session.commit()
    return deck_id, card.note_link.note


def edit(client, headers, note, fields):
    response = client.put(f'/api/notes/{note.id}', headers=headers, json={'fields': fields, 'tags': []})
    assert response.status_code == 200, response.text
    return response.json()


def sound_names(note_json):
    import re
    return re.findall(r'\[sound:([^\]]+)\]', ' '.join(note_json['fields'].values()))


def test_fixing_the_word_re_voices_its_pronunciation(client, auth_headers_a, db_session, configured, monkeypatch):
    deck_id, note = voiced_note(client, auth_headers_a, db_session)
    old = sound_names({'fields': json.loads(note.fields_json) and dict(zip(['Front', 'Back'], json.loads(note.fields_json)))})
    calls = FakeSynth()
    monkeypatch.setattr(tts_service, 'synthesize', lambda text, **kw: calls(text))
    back = json.loads(note.fields_json)[1]
    result = edit(client, auth_headers_a, note, {'Front': 'apple', 'Back': back})
    assert calls.calls == ['apple']
    new = sound_names(result)
    assert len(new) == 1 and new != old and new[0] == tts_service.media_name('apple')
    assert result['fields']['Back'].startswith('quả táo [sound:tts-')
    from media_utils import get_media_dir
    assert os.path.exists(os.path.join(get_media_dir(note.user_id), new[0]))
    # Nothing is stale any more, and the deck summary agrees.
    assert client.get(f'/api/decks/{deck_id}/tts/summary', headers=auth_headers_a).json()['stale_notes'] == 0


def test_editing_only_the_meaning_keeps_the_audio(client, auth_headers_a, db_session, configured, monkeypatch):
    _, note = voiced_note(client, auth_headers_a, db_session, front='apple')
    back = json.loads(note.fields_json)[1]
    monkeypatch.setattr(tts_service, 'synthesize', lambda text, **kw: pytest.fail('must not re-voice'))
    result = edit(client, auth_headers_a, note, {'Front': 'apple', 'Back': back.replace('quả táo', 'trái táo')})
    assert sound_names(result) == [tts_service.media_name('apple')]


def test_audio_made_by_the_earlier_gemini_voice_still_counts_as_matching(client, auth_headers_a, db_session, configured):
    deck_id = make_deck(client, auth_headers_a, [('banana', 'quả chuối')])
    card = db_session.query(Card).filter_by(deck_id=deck_id).one()
    gemini_name = tts_service.media_name('banana', 'Kore')
    note = card.note_link.note
    edit(client, auth_headers_a, note, {'Front': 'banana', 'Back': f'quả chuối [sound:{gemini_name}]'})
    assert tts_service.stale_audio(note) is None
    assert client.get(f'/api/decks/{deck_id}/tts/summary', headers=auth_headers_a).json()['stale_notes'] == 0


def test_own_recordings_and_removed_audio_are_left_alone(client, auth_headers_a, db_session, configured, monkeypatch):
    _, note = voiced_note(client, auth_headers_a, db_session)
    monkeypatch.setattr(tts_service, 'synthesize', lambda text, **kw: pytest.fail('must not re-voice'))
    # The user removed the generated chip while fixing the word: it is not added back.
    result = edit(client, auth_headers_a, note, {'Front': 'apple', 'Back': 'quả táo'})
    assert sound_names(result) == []
    # A recording of their own is never replaced, whatever the word says.
    result = edit(client, auth_headers_a, note, {'Front': 'pear', 'Back': 'quả lê [sound:recording.webm]'})
    assert sound_names(result) == ['recording.webm']


def test_a_down_tts_service_does_not_block_saving(client, auth_headers_a, db_session, configured, monkeypatch):
    deck_id, note = voiced_note(client, auth_headers_a, db_session, front='kumkwat')
    def down(text, **kw):
        raise tts_service.TTSError('network', 'refused')
    monkeypatch.setattr(tts_service, 'synthesize', down)
    monkeypatch.setattr(tts_service.threading, 'Thread', lambda *a, **k: type('T', (), {'start': lambda self: None})())
    back = json.loads(note.fields_json)[1]
    result = edit(client, auth_headers_a, note, {'Front': 'kumquat', 'Back': back})
    assert result['fields']['Front'] == 'kumquat'  # the edit itself is saved
    # The old audio is still attached and reported as stale, so the deck's fix button can repair it later.
    assert client.get(f'/api/decks/{deck_id}/tts/summary', headers=auth_headers_a).json()['stale_notes'] == 1


def test_fix_job_re_voices_every_stale_note_in_the_deck(client, auth_headers_a, db_session, configured):
    deck_id = make_deck(client, auth_headers_a, [('mangoe', 'xoài'), ('papya', 'đu đủ'), ('cherry', 'anh đào')])
    user_id = db_session.query(Deck).get(deck_id).user_id
    run(tts_service.Job(deck_id=deck_id, user_id=user_id), db_session, FakeSynth())
    # Fix two words directly in the database (as an import with "update" would), leaving their old audio.
    for card in db_session.query(Card).filter_by(deck_id=deck_id):
        note = card.note_link.note
        values = json.loads(note.fields_json)
        if values[0] in ('mangoe', 'papya'):
            values[0] = {'mangoe': 'mango', 'papya': 'papaya'}[values[0]]
            note.fields_json = json.dumps(values, ensure_ascii=False)
    db_session.commit()
    assert client.get(f'/api/decks/{deck_id}/tts/summary', headers=auth_headers_a).json()['stale_notes'] == 2
    synth = FakeSynth()
    job = tts_service.Job(deck_id=deck_id, user_id=user_id, mode='fix')
    run(job, db_session, synth)
    assert job.state == 'done' and job.total == 2 and job.added == 2 and job.failed == 0
    assert sorted(synth.calls) == ['mango', 'papaya']
    assert client.get(f'/api/decks/{deck_id}/tts/summary', headers=auth_headers_a).json()['stale_notes'] == 0
    assert client.post(f'/api/decks/{deck_id}/tts', headers=auth_headers_a, params={'mode': 'fix'}).status_code == 202
