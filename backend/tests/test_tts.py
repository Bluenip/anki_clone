import array
import base64
import io
import json
import os
import urllib.error
import wave

import pytest

import tts_service
from models import Card, Deck, Note
from quiz import card_material, settings_for


def fake_wav(seconds=0.5):
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(24000)
        out.writeframes(b'\0\0' * int(24000 * seconds))
    return buffer.getvalue()


class FakeSynth:
    def __init__(self, failures=()):
        self.calls = []
        self.failures = list(failures)

    def __call__(self, text):
        self.calls.append(text)
        if self.failures:
            raise self.failures.pop(0)
        return fake_wav()


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'test-key-not-real')
    monkeypatch.setenv('GEMINI_TTS_MODEL', 'gemini-3.8-test-tts')
    monkeypatch.setenv('GEMINI_TTS_VOICE', 'TestVoice')
    monkeypatch.setenv('TTS_PIPER_FALLBACK', '0')  # tests that need Piper pass a fake explicitly
    # Notes created in tests must not start real Gemini requests in the background.
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


def test_speech_text_turns_separators_into_pauses():
    assert tts_service.speech_text('Go – went') == 'Go, went'
    assert tts_service.speech_text('Be – was/were') == 'Be, was, were'
    assert tts_service.speech_text('Fizzy drinks') == 'Fizzy drinks'
    assert tts_service.speech_text("Sleep over at a friend's house") == "Sleep over at a friend's house"


def test_synthesize_builds_documented_request_and_reads_audio(configured):
    seen = {}
    audio = fake_wav()

    class Response:
        def __init__(self, body): self.body = body
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return self.body

    def opener(request, timeout):
        seen['url'], seen['headers'], seen['body'] = request.full_url, dict(request.header_items()), json.loads(request.data)
        return Response(json.dumps({'steps': [{'type': 'model_output', 'content': [
            {'type': 'audio', 'data': base64.b64encode(audio).decode()}]}]}).encode())

    assert tts_service.synthesize('sunburn', opener=opener) == audio
    assert seen['url'] == tts_service.API_URL
    assert seen['headers']['X-goog-api-key'] == 'test-key-not-real'
    body = seen['body']
    assert body['model'] == 'gemini-3.8-test-tts'
    assert body['input'][0]['content'][0]['text'] == 'sunburn'  # verbatim transcript, style kept separate
    assert body['input'][0]['content'][0]['annotations'][0]['type'] == 'speech_metadata'
    assert body['generation_config']['speech_config'] == [{'voice': 'TestVoice'}]


def test_style_metadata_only_for_models_that_accept_it():
    assert tts_service.supports_style('gemini-3.8-flash-lite-tts')
    assert tts_service.supports_style('gemini-4.0-flash-tts')
    assert not tts_service.supports_style('gemini-3.1-flash-tts-preview')
    assert not tts_service.supports_style('gemini-2.5-flash-preview-tts')


def test_daily_quota_message_is_recognised(configured):
    body = (b'{"error":{"message":"Rate limit exceeded for model gemini-3.8-flash-tts (limit: 10 requests per day '
            b'on Free Tier). Please retry in 17h29s","code":"too_many_requests"}}')

    def opener(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 429, 'err', {'Retry-After': '61229'}, io.BytesIO(body))

    with pytest.raises(tts_service.TTSError) as caught:
        tts_service.synthesize('x', opener=opener)
    assert caught.value.kind == 'daily_limit' and caught.value.retry_after == 61229


def test_synthesize_wraps_raw_pcm_and_classifies_errors(configured):
    class Response:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self):
            return json.dumps({'steps': [{'content': [{'type': 'audio', 'data': base64.b64encode(b'\1\0' * 2400).decode()}]}]}).encode()

    wav_bytes = tts_service.synthesize('x', opener=lambda r, timeout: Response())
    assert wav_bytes[:4] == b'RIFF' and abs(tts_service.wav_seconds(wav_bytes) - 0.1) < 1e-6

    def failing(code, body=b'{}'):
        def opener(request, timeout):
            raise urllib.error.HTTPError(request.full_url, code, 'err', {}, io.BytesIO(body))
        return opener

    for code, body, kind in ((429, b'{}', 'rate_limit'), (403, b'{}', 'auth'),
                             (400, b'{"error":{"message":"API key not valid. Please pass a valid API key."}}', 'auth'),
                             (400, b'User location is not supported', 'location'), (500, b'boom', 'other')):
        with pytest.raises(tts_service.TTSError) as caught:
            tts_service.synthesize('x', opener=failing(code, body))
        assert caught.value.kind == kind


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
    name = material['sound']
    user_id = db_session.query(Deck).get(deck_id).user_id
    from media_utils import get_media_dir
    assert os.path.exists(os.path.join(get_media_dir(user_id), name))


def test_cards_that_already_have_audio_or_no_word_are_skipped(client, auth_headers_a, db_session, configured):
    deck_id = make_deck(client, auth_headers_a, [('apple [sound:apple.mp3]', 'quả táo'), ('Vitamin', 'Vitamin'),
                                                 ('[sound:theme.mp3]', 'Schubert'),
                                                 ('Thứ tự gợi nhớ theo âm Hán - Việt: phết xiêu, chủ chấm, dẫn chậm, sước đi', 'Giới thiệu')])
    synth = FakeSynth()
    for card in db_session.query(Card).filter_by(deck_id=deck_id):
        assert tts_service.attach(db_session, card, synth=synth) == 'skipped'
    assert synth.calls == []


def tone_wav(pattern):
    """pattern: list of ('tone'|'gap', seconds) -> WAV bytes (24 kHz)."""
    import math
    frames = array.array('h')
    for kind, seconds in pattern:
        n = int(24000 * seconds)
        if kind == 'tone':
            frames.extend(int(8000 * math.sin(2 * math.pi * 220 * i / 24000)) for i in range(n))
        else:
            frames.extend([0] * n)
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as out:
        out.setnchannels(1); out.setsampwidth(2); out.setframerate(24000)
        out.writeframes(frames.tobytes())
    return buffer.getvalue()


def test_speech_pieces_cut_at_every_pause():
    recording = tone_wav([('gap', .2), ('tone', .5), ('gap', .9), ('tone', .3), ('gap', .35), ('tone', .3),
                          ('gap', .1), ('tone', .3), ('gap', .2)])
    rate, step, pcm, spans = tts_service.speech_pieces(recording)
    # The 0.1 s dip inside the last word is not a pause; the 0.35 s one is.
    assert [round((end - start) / 100, 1) for start, end in spans] == [0.5, 0.3, 0.7]


def test_align_pieces_matches_by_content_and_recovers_after_a_bad_piece():
    words = ['Sunburn', 'Go – went', 'Irresponsible', 'Polite', "Sleep over at a friend's house"]
    heard = ['sunburn', 'go', 'went', 'ear', 'responsible', 'polite', 'sleep over', "at a friend's house"]
    found = tts_service.align_pieces(words, heard)
    assert found == {'Sunburn': (0, 0), 'Go – went': (1, 2), 'Polite': (5, 5),
                     "Sleep over at a friend's house": (6, 7)}  # the misheard word is dropped, nothing shifts


def test_synthesize_batch_keeps_only_verified_audio():
    recording = tone_wav([('tone', .4), ('gap', .9), ('tone', .3), ('gap', .4), ('tone', .3), ('gap', .9), ('tone', .4)])
    sent = {}

    def synth(text, model):
        sent['text'], sent['model'] = text, model
        return recording

    def transcribe(clips):
        assert len(clips) == 4
        return ['Sunburn', 'go', 'went', 'litter bin']  # last word is wrong

    out = tts_service.synthesize_batch(['Sunburn', 'Go – went', 'Litter'], 'm1', synth=synth, transcribe=transcribe)
    assert sent == {'text': 'Sunburn. <long pause> Go, went. <long pause> Litter.', 'model': 'm1'}
    assert sorted(out) == ['Go – went', 'Sunburn']
    assert round(tts_service.wav_seconds(out['Go – went']), 2) == 1.13  # both pieces plus the pause between them


def test_transcribe_clips_maps_by_clip_number(configured):
    class Response:
        def __init__(self, text): self.text = text
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self):
            return json.dumps({'candidates': [{'content': {'parts': [{'text': self.text}]}}]}).encode()

    extra = json.dumps([{'clip': 0, 'text': 'a'}, {'clip': 5, 'text': 'ghost'}, {'clip': 1, 'text': 'b'}])
    assert tts_service.transcribe_clips([b'x', b'y'], opener=lambda r, timeout: Response(extra)) == ['a', 'b']
    misaligned = json.dumps(['a', 'b', 'c'])
    assert tts_service.transcribe_clips([b'x', b'y'], opener=lambda r, timeout: Response(misaligned)) == ['', '']


class FakeBatch:
    """synth_batch stand-in: per-model daily quotas and words that fail verification once."""

    def __init__(self, quota=None, flaky=()):
        self.calls = []
        self.quota = dict(quota or {})
        self.flaky = set(flaky)

    def __call__(self, words, model):
        self.calls.append((model, list(words)))
        if model in self.quota:
            if self.quota[model] <= 0:
                raise tts_service.TTSError('daily_limit', 'quota')
            self.quota[model] -= 1
        out = {}
        for word in words:
            if word in self.flaky:
                self.flaky.discard(word)
                continue
            out[word] = fake_wav()
        return out


class Clock:
    def __init__(self):
        self.t = 1_800_000_000.0

    def now(self):
        return self.t

    def sleep(self, seconds):
        self.t += seconds


def run(job, db_session, synth, clock=None, **kw):
    clock = clock or Clock()
    return tts_service.run_job(job, shared(db_session), synth_batch=synth, sleep=clock.sleep, now=clock.now, rpm=6000, **kw)


def test_job_batches_words_retries_mismatches_and_reuses_audio(client, auth_headers_a, db_session, configured, monkeypatch):
    monkeypatch.setenv('GEMINI_TTS_BATCH', '2')
    deck_id = make_deck(client, auth_headers_a, [('Fizzy drinks', 'Nước ngọt có ga'), ('Lip balm', 'Son dưỡng môi'),
                                                 ('Volunteer', 'Tình nguyện viên'), ('Fizzy drinks', 'Nước có ga (trùng)')],
                        kind='reversed')
    user_id = db_session.query(Deck).get(deck_id).user_id
    synth = FakeBatch(flaky={'Lip balm'})
    job = tts_service.Job(deck_id=deck_id, user_id=user_id)
    run(job, db_session, synth)
    assert job.state == 'done', job.error
    assert job.total == 3 and job.done_words == 3 and job.failed == 0
    assert job.added == 4  # both "Fizzy drinks" notes get the same file
    assert synth.calls[0][1] == ['Fizzy drinks', 'Lip balm'] and synth.calls[1][1] == ['Volunteer', 'Lip balm']
    # A finished deck needs no further requests.
    again = tts_service.Job(deck_id=deck_id, user_id=user_id)
    run(again, db_session, synth)
    assert again.total == 0 and len(synth.calls) == 2


def test_word_failing_three_times_is_given_up(client, auth_headers_a, db_session, configured, monkeypatch):
    monkeypatch.setenv('GEMINI_TTS_BATCH', '5')

    class AlwaysWrong(FakeBatch):
        def __call__(self, words, model):
            self.calls.append((model, list(words)))
            return {w: fake_wav() for w in words if w != 'Scenery'}

    deck_id = make_deck(client, auth_headers_a, [('Scenery', 'Phong cảnh'), ('Polite', 'Lịch sự')])
    user_id = db_session.query(Deck).get(deck_id).user_id
    synth = AlwaysWrong()
    job = tts_service.Job(deck_id=deck_id, user_id=user_id)
    run(job, db_session, synth)
    assert job.state == 'done' and job.failed == 1 and job.done_words == 1
    assert [words for _, words in synth.calls] == [['Scenery', 'Polite'], ['Scenery'], ['Scenery']]


def test_job_switches_models_then_waits_for_quota_reset(client, auth_headers_a, db_session, configured, monkeypatch):
    monkeypatch.setenv('GEMINI_TTS_BATCH', '1')
    monkeypatch.setenv('GEMINI_TTS_MODELS', 'lite,flash')
    deck_id = make_deck(client, auth_headers_a, [('Campsite', 'Khu cắm trại'), ('Wooden', 'Bằng gỗ'),
                                                 ('Remote', 'Xa xôi'), ('Dive', 'Lặn')])
    user_id = db_session.query(Deck).get(deck_id).user_id
    synth = FakeBatch(quota={'lite': 1, 'flash': 1})
    clock = Clock()
    job = tts_service.Job(deck_id=deck_id, user_id=user_id)
    original_reset = tts_service.next_quota_reset

    def reset(now):
        synth.quota = {'lite': 5, 'flash': 5}  # quotas refill when the day rolls over
        return original_reset(now)

    monkeypatch.setattr(tts_service, 'next_quota_reset', reset)
    start = clock.t
    run(job, db_session, synth, clock)
    assert job.state == 'done', job.error
    assert job.done_words == 4
    used = [model for model, _ in synth.calls]
    assert used[:3] == ['lite', 'lite', 'flash']  # 2nd lite call hits the daily cap, so it switches model
    assert clock.t - start > 3600          # waited for the reset instead of failing
    assert job.error == ''


def test_job_stops_cleanly_on_bad_key(client, auth_headers_a, db_session, configured):
    deck_id = make_deck(client, auth_headers_a, [('Campfire', 'Lửa trại'), ('Crime', 'Tội phạm')])
    user_id = db_session.query(Deck).get(deck_id).user_id

    def bad_key(words, model):
        raise tts_service.TTSError('auth', 'bad key')

    job = tts_service.Job(deck_id=deck_id, user_id=user_id)
    run(job, db_session, bad_key)
    assert job.state == 'failed' and 'bad key' in job.error and job.added == 0


def test_quota_reset_is_after_pacific_midnight():
    import datetime as dt
    from zoneinfo import ZoneInfo
    noon = dt.datetime(2026, 11, 15, 12, 0, tzinfo=ZoneInfo('America/Los_Angeles')).timestamp()
    reset = dt.datetime.fromtimestamp(tts_service.next_quota_reset(noon), ZoneInfo('America/Los_Angeles'))
    assert (reset.day, reset.hour, reset.minute) == (16, 0, 5)


def test_endpoints_report_configuration_and_ownership(client, auth_headers_a, auth_headers_b, monkeypatch):
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    monkeypatch.setenv('TTS_PIPER_FALLBACK', '0')  # neither Gemini nor Piper: the feature is off
    deck_id = make_deck(client, auth_headers_a, [('Sunburn', 'Cháy nắng')])
    assert client.get('/api/tts/status', headers=auth_headers_a).json()['enabled'] is False
    assert client.post(f'/api/decks/{deck_id}/tts', headers=auth_headers_a).status_code == 503
    assert client.get(f'/api/decks/{deck_id}/tts', headers=auth_headers_a).json() == {'state': 'idle'}
    assert client.get(f'/api/decks/{deck_id}/tts', headers=auth_headers_b).status_code == 404
    assert client.post(f'/api/decks/{deck_id}/tts', headers=auth_headers_b).status_code == 404


def test_stop_works_while_waiting_for_the_quota_reset(client, auth_headers_a, db_session, configured):
    deck_id = make_deck(client, auth_headers_a, [('Sunrise', 'Bình minh')])
    user_id = db_session.query(Deck).get(deck_id).user_id
    job = tts_service.Job(deck_id=deck_id, user_id=user_id, state='waiting')
    with tts_service._jobs_lock:
        tts_service._jobs[(user_id, deck_id)] = job
    try:
        response = client.post(f'/api/decks/{deck_id}/tts/cancel', headers=auth_headers_a)
        assert response.status_code == 200 and response.json()['state'] == 'stopped'
        assert job.cancel.is_set()
        # The waiting loop notices the cancel on its next check.
        assert tts_service._wait(job, 3600, lambda s: None) is False
    finally:
        with tts_service._jobs_lock:
            tts_service._jobs.pop((user_id, deck_id), None)



def piper_fake_wav(seconds=0.4):
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as out:
        out.setnchannels(1); out.setsampwidth(2); out.setframerate(22050)
        out.writeframes(b'\1\0' * int(22050 * seconds))
    return buffer.getvalue()


class FakePiper:
    def __init__(self):
        self.words = []

    def __call__(self, word):
        self.words.append(word)
        return piper_fake_wav()


def test_out_of_gemini_quota_falls_back_to_piper_at_once(client, auth_headers_a, db_session, configured, monkeypatch):
    monkeypatch.setenv('GEMINI_TTS_BATCH', '2')
    monkeypatch.setenv('GEMINI_TTS_MODELS', 'lite')
    deck_id = make_deck(client, auth_headers_a, [('Bleach', 'Tẩy trắng'), ('Shaver', 'Máy cạo râu'),
                                                 ('Forehand', 'Cú thuận tay'), ('Ventilate', 'Thông gió')])
    user_id = db_session.query(Deck).get(deck_id).user_id
    synth, piper, clock = FakeBatch(quota={'lite': 1}), FakePiper(), Clock()
    start = clock.t
    job = tts_service.Job(deck_id=deck_id, user_id=user_id)
    tts_service.run_job(job, shared(db_session), synth_batch=synth, sleep=clock.sleep, now=clock.now, rpm=6000, piper=piper)
    assert job.state == 'done', job.error
    assert job.done_words == 4 and job.piper_words == 2 and job.added == 4
    assert sorted(piper.words) == ['Forehand', 'Ventilate']  # the batch Gemini could not take
    assert clock.t - start < 60                               # no waiting for tomorrow's reset


def test_without_a_gemini_key_everything_uses_piper(client, auth_headers_a, db_session, configured, monkeypatch):
    monkeypatch.delenv('GEMINI_API_KEY')
    deck_id = make_deck(client, auth_headers_a, [('Neutral', 'Trung lập'), ('Downward', 'Đi xuống')])
    user_id = db_session.query(Deck).get(deck_id).user_id
    synth, piper = FakeBatch(), FakePiper()
    job = tts_service.Job(deck_id=deck_id, user_id=user_id)
    run(job, db_session, synth, piper=piper)
    assert job.state == 'done' and job.piper_words == 2 and synth.calls == []


def test_words_gemini_cannot_verify_get_piper_audio(client, auth_headers_a, db_session, configured, monkeypatch):
    monkeypatch.setenv('GEMINI_TTS_BATCH', '5')

    class NeverVerifies(FakeBatch):
        def __call__(self, words, model):
            self.calls.append((model, list(words)))
            return {w: fake_wav() for w in words if w != 'Forte'}

    deck_id = make_deck(client, auth_headers_a, [('Forte', 'Sở trường'), ('Batch', 'Mẻ, lô')])
    user_id = db_session.query(Deck).get(deck_id).user_id
    piper = FakePiper()
    job = tts_service.Job(deck_id=deck_id, user_id=user_id)
    run(job, db_session, NeverVerifies(), piper=piper)
    assert job.state == 'done' and job.failed == 0 and piper.words == ['Forte']


def test_upgrade_replaces_piper_audio_with_gemini_in_place(client, auth_headers_a, db_session, configured, monkeypatch):
    monkeypatch.setenv('GEMINI_TTS_BATCH', '5')
    deck_id = make_deck(client, auth_headers_a, [('Amphibious', 'Lưỡng cư'), ('Prehistoric', 'Tiền sử')])
    user_id = db_session.query(Deck).get(deck_id).user_id
    # First pass: no Gemini key, so both words are voiced by Piper.
    monkeypatch.delenv('GEMINI_API_KEY')
    run(tts_service.Job(deck_id=deck_id, user_id=user_id), db_session, FakeBatch(), piper=FakePiper())
    monkeypatch.setenv('GEMINI_API_KEY', 'test-key-not-real')
    assert client.get(f'/api/decks/{deck_id}/tts/summary', headers=auth_headers_a).json() == {'piper_words': 2}
    before = {c.id: (c.front, c.back) for c in db_session.query(Card).filter_by(deck_id=deck_id)}

    synth = FakeBatch()
    job = tts_service.Job(deck_id=deck_id, user_id=user_id, mode='upgrade')
    run(job, db_session, synth)
    assert job.state == 'done' and job.added == 2 and job.piper_words == 0
    assert client.get(f'/api/decks/{deck_id}/tts/summary', headers=auth_headers_a).json() == {'piper_words': 0}
    # Same file names, so the cards themselves did not change.
    assert {c.id: (c.front, c.back) for c in db_session.query(Card).filter_by(deck_id=deck_id)} == before


def test_new_note_audio_falls_back_to_piper(configured, monkeypatch):
    def out_of_quota(text, model=None):
        raise tts_service.TTSError('daily_limit', 'quota')

    monkeypatch.setattr(tts_service, 'synthesize', out_of_quota)
    monkeypatch.setattr(tts_service, 'piper_available', lambda: True)
    monkeypatch.setattr(tts_service, 'piper_wav', lambda text: piper_fake_wav())
    data = tts_service.synthesize_any_model('Bleach')
    assert not tts_service.is_gemini_audio(io.BytesIO(data))


@pytest.mark.skipif(not os.path.exists(os.getenv('PIPER_VOICE', '/opt/voices/en_US-lessac-medium.onnx')),
                    reason='Piper voice not installed (it is in the Docker image)')
def test_real_piper_voices_words_and_pairs(monkeypatch):
    monkeypatch.setenv('TTS_PIPER_FALLBACK', '1')
    assert tts_service.piper_available()
    single = tts_service.piper_wav('Ventilate')
    pair = tts_service.piper_wav('Go – went')
    assert not tts_service.is_gemini_audio(io.BytesIO(single))
    assert 0.3 < tts_service.wav_seconds(single) < 3
    # Two parts plus a 0.35 s pause between them.
    assert tts_service.wav_seconds(pair) > tts_service.wav_seconds(tts_service.piper_wav('Go')) + 0.35



def test_piper_alone_enables_audio_but_not_upgrades(client, auth_headers_a, monkeypatch):
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    monkeypatch.setattr(tts_service, 'piper_available', lambda: True)
    monkeypatch.setattr(tts_service, 'start_job', lambda *a, **k: tts_service.Job(deck_id=0, user_id=0))
    deck_id = make_deck(client, auth_headers_a, [('Skill', 'Kỹ năng')])
    status = client.get('/api/tts/status', headers=auth_headers_a).json()
    assert status['enabled'] is True and status['gemini'] is False and status['piper'] is True
    assert client.post(f'/api/decks/{deck_id}/tts', headers=auth_headers_a).status_code == 202
    assert client.post(f'/api/decks/{deck_id}/tts', headers=auth_headers_a, params={'mode': 'upgrade'}).status_code == 503
