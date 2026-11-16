"""Generate pronunciation audio for vocabulary notes with Gemini TTS.

Audio is saved once per (voice, text) as a WAV in the user's media folder and
attached to the note as ``[sound:tts-....wav]``: in an empty audio-named field
if the note type has one, otherwise at the end of the meaning field. The word
field is never modified, so first-field duplicate detection on re-import keeps
working.

The Gemini free tier allows only ~10 TTS requests per model per day, so bulk
jobs read many words in one request separated by ``<long pause>`` tags, cut
the audio at the N-1 longest silences, and verify every clip by having a cheap
text model transcribe them (one extra request per batch). A clip that does not
match its word is discarded and retried later, so audio is never attached to
the wrong word. When every configured model is out of daily quota the job
waits for the reset (midnight Pacific time) and continues by itself.

Configuration (environment):
    GEMINI_API_KEY        required; without it every entry point is a no-op
    GEMINI_TTS_MODELS     comma-separated, tried in order when one runs out
                          (default gemini-3.8-flash-lite-tts,gemini-3.8-flash-tts)
    GEMINI_TTS_VOICE      default Kore
    GEMINI_TTS_BATCH      words per request, default 40
    GEMINI_TTS_RPM        request pacing, default 3 per minute (free-tier limit)
    GEMINI_VERIFY_MODEL   default gemini-3.5-flash-lite
"""
import array
import base64
import datetime as dt
import hashlib
import io
import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.request
import wave
from dataclasses import dataclass, field

log = logging.getLogger(__name__)
if not log.handlers:  # make batch results visible in `docker compose logs backend`
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter('%(levelname)s:     tts: %(message)s'))
    log.addHandler(_handler)
    log.setLevel(logging.INFO)
    log.propagate = False

API_BASE = 'https://generativelanguage.googleapis.com/v1beta'
API_URL = API_BASE + '/interactions'
STYLE = 'clear, natural dictionary pronunciation'
_SOUND = re.compile(r'\[sound:[^\]]+\]')
_AUDIO_FIELD = re.compile(r'audio|sound|âm\s*thanh|phát\s*âm|pronunciation', re.I)
_SEPARATORS = re.compile(r'\s*[–—/|;,]\s*|\s+-\s+')


def api_key():
    return os.getenv('GEMINI_API_KEY', '').strip()


def enabled():
    """Audio can be generated with Gemini, or offline with Piper."""
    return bool(api_key()) or piper_available()


# --------------------------------------------------------------------------- Piper fallback

GEMINI_RATE = 24000  # Gemini TTS always returns 24 kHz; Piper voices use other rates (lessac: 22.05 kHz)
_piper_voice = None
_piper_lock = threading.Lock()


def piper_voice_path():
    return os.getenv('PIPER_VOICE', '/opt/voices/en_US-lessac-medium.onnx')


def piper_available():
    if os.getenv('TTS_PIPER_FALLBACK', '1').strip().lower() in ('0', 'false', 'no', 'off'):
        return False
    if not os.path.exists(piper_voice_path()):
        return False
    try:
        import piper  # noqa: F401
    except ImportError:
        return False
    return True


def piper_wav(word):
    """Offline pronunciation; parts like 'go – went' are read separately with a clear pause between."""
    global _piper_voice
    from piper import PiperVoice
    with _piper_lock:
        if _piper_voice is None:
            _piper_voice = PiperVoice.load(piper_voice_path())
        voice = _piper_voice
        parts = [part.strip() for part in _SEPARATORS.split(word or '') if part.strip()]
        rate, frames = None, array.array('h')
        for index, part in enumerate(parts):
            buffer = io.BytesIO()
            with wave.open(buffer, 'wb') as out:
                voice.synthesize_wav(part, out)
            with wave.open(io.BytesIO(buffer.getvalue())) as source:
                rate = source.getframerate()
                frames.extend(array.array('h', source.readframes(source.getnframes())))
            if index < len(parts) - 1:
                frames.extend([0] * int(rate * 0.35))
    if rate is None:
        raise TTSError('bad_response', 'Nothing to say')
    return _wav_bytes(rate, frames.tobytes())


def is_gemini_audio(path):
    """True for audio made by Gemini (24 kHz); False for Piper or anything else."""
    try:
        with wave.open(path) as source:
            return source.getframerate() == GEMINI_RATE
    except (OSError, wave.Error, EOFError):
        return False


def models():
    raw = os.getenv('GEMINI_TTS_MODELS') or os.getenv('GEMINI_TTS_MODEL') or 'gemini-3.8-flash-lite-tts,gemini-3.8-flash-tts'
    return [m.strip() for m in raw.split(',') if m.strip()]


def model_name():
    return models()[0]


def voice_name():
    return os.getenv('GEMINI_TTS_VOICE', 'Kore').strip()


def verify_model():
    return os.getenv('GEMINI_VERIFY_MODEL', 'gemini-3.5-flash-lite').strip()


def batch_size():
    return max(1, int(os.getenv('GEMINI_TTS_BATCH', '40') or 40))


class TTSError(Exception):
    """kind: rate_limit | daily_limit | busy | auth | location | bad_response | network | other."""

    def __init__(self, kind, message, retry_after=None):
        super().__init__(message)
        self.kind = kind
        self.retry_after = retry_after


def speech_text(word):
    """What to say for one word: separators such as 'go – went' or 'was/were' become short pauses."""
    text = _SEPARATORS.sub(', ', word or '')
    return re.sub(r'\s+', ' ', text).strip(' ,')


def media_name(text, voice=None):
    digest = hashlib.sha1(f'{voice or voice_name()}|{text}'.encode()).hexdigest()[:20]
    return f'tts-{digest}.wav'


# --------------------------------------------------------------------------- HTTP

def _post(url, body, *, timeout, opener):
    request = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST', headers={
        'Content-Type': 'application/json', 'x-goog-api-key': api_key()})
    try:
        with opener(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read()[:2000].decode('utf-8', 'replace')
        retry = exc.headers.get('Retry-After') if exc.headers else None
        retry = float(retry) if retry and retry.replace('.', '', 1).isdigit() else None
        if exc.code == 429:
            daily = re.search(r'per ?day|PerDay|RequestsPerDay', detail, re.I)
            raise TTSError('daily_limit' if daily else 'rate_limit', 'Gemini quota reached', retry) from None
        if exc.code in (401, 403) or 'api key not valid' in detail.lower() or 'API_KEY_INVALID' in detail:
            raise TTSError('auth', f'Gemini rejected the API key ({exc.code})') from None
        if exc.code in (500, 502, 503, 504):
            raise TTSError('busy', f'Gemini is overloaded right now ({exc.code})', retry) from None
        if exc.code == 400 and 'location' in detail.lower():
            raise TTSError('location', 'Gemini API is not available from this server location') from None
        raise TTSError('other', f'Gemini error {exc.code}: {detail[:200]}') from None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise TTSError('network', f'Could not reach Gemini: {exc}') from None


def supports_style(model):
    """Only Gemini 3.8+ TTS accepts speech_metadata; older preview models reject the request."""
    match = re.match(r'gemini-(\d+)\.(\d+)', model or '')
    return bool(match) and (int(match[1]), int(match[2])) >= (3, 8)


def synthesize(text, *, model=None, timeout=300, opener=urllib.request.urlopen):
    """Return WAV bytes for ``text`` (a verbatim transcript). Raises TTSError."""
    if not api_key():
        raise TTSError('auth', 'GEMINI_API_KEY is not configured')
    model = model or model_name()
    content = {'type': 'text', 'text': text}
    if supports_style(model):
        content['annotations'] = [{'type': 'speech_metadata', 'style': STYLE}]
    payload = _post(API_URL, {
        'model': model,
        'input': [{'type': 'user_input', 'content': [content]}],
        'response_format': {'type': 'audio'},
        'generation_config': {'speech_config': [{'voice': voice_name()}]},
    }, timeout=timeout, opener=opener)
    audio = None
    for step in payload.get('steps', []):
        for content in step.get('content', []) or []:
            if content.get('type') == 'audio' and content.get('data'):
                audio = content['data']
    if not audio:
        raise TTSError('bad_response', 'Gemini returned no audio')
    try:
        return _as_wav(base64.b64decode(audio))
    except (ValueError, wave.Error) as exc:
        raise TTSError('bad_response', f'Gemini returned unreadable audio: {exc}') from None


def transcribe_clips(clips, *, timeout=180, opener=urllib.request.urlopen):
    """What a listener hears in each clip, via one text-model request. Missing clips come back as ''."""
    parts = []
    for index, clip in enumerate(clips):
        parts.append({'text': f'Clip {index}:'})
        parts.append({'inline_data': {'mime_type': 'audio/wav', 'data': base64.b64encode(clip).decode()}})
    parts.append({'text': 'Transcribe exactly what is spoken in each clip. Reply with only a JSON array with one '
                          'object per clip: {"clip": <clip number>, "text": "<transcript>"}.'})
    payload = _post(f'{API_BASE}/models/{verify_model()}:generateContent', {
        'contents': [{'parts': parts}], 'generationConfig': {'responseMimeType': 'application/json'},
    }, timeout=timeout, opener=opener)
    try:
        items = json.loads(payload['candidates'][0]['content']['parts'][0]['text'])
    except (KeyError, IndexError, ValueError) as exc:
        raise TTSError('bad_response', f'Verification returned no transcript: {exc}') from None
    if not isinstance(items, list):
        raise TTSError('bad_response', 'Verification returned no list')
    heard = [''] * len(clips)
    for position, item in enumerate(items):
        if isinstance(item, dict):
            try:
                index = int(item.get('clip'))
            except (TypeError, ValueError):
                continue
            text = str(item.get('text') or '')
        else:  # a bare list of strings is accepted only when it lines up exactly
            if len(items) != len(clips):
                return heard
            index, text = position, str(item)
        if 0 <= index < len(clips) and not heard[index]:
            heard[index] = text
    return heard


# --------------------------------------------------------------------------- audio

def _as_wav(data):
    if data[:4] == b'RIFF':
        return data
    # Headerless 16-bit mono PCM at 24 kHz (older models / streaming defaults).
    return _wav_bytes(24000, data)


def _wav_bytes(rate, frames):
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(frames)
    return buffer.getvalue()


def wav_seconds(data):
    with wave.open(io.BytesIO(data)) as source:
        return source.getnframes() / float(source.getframerate())


def speech_pieces(data, *, min_gap=0.15, min_len=0.08):
    """Cut a recording at every pause of at least ``min_gap`` seconds.

    Returns (rate, frames_per_step, pcm, [(start_step, end_step), ...]) with 10 ms steps.
    """
    with wave.open(io.BytesIO(data)) as source:
        rate = source.getframerate()
        pcm = array.array('h', source.readframes(source.getnframes()))
    step = max(1, rate // 100)
    levels = [(sum(x * x for x in pcm[i:i + step]) / step) ** 0.5 for i in range(0, len(pcm) - step + 1, step)]
    spans = []
    if not levels or max(levels) == 0:
        return rate, step, pcm, spans
    threshold = max(levels) * 0.03
    loud = [level > threshold for level in levels]
    gap_steps, len_steps = int(min_gap * 100), int(min_len * 100)
    index = 0
    while index < len(loud):
        if not loud[index]:
            index += 1
            continue
        start = end = index
        quiet = 0
        while index < len(loud):
            if loud[index]:
                quiet, end = 0, index + 1
            else:
                quiet += 1
                if quiet >= gap_steps:
                    break
            index += 1
        if end - start >= len_steps:
            spans.append((start, end))
    return rate, step, pcm, spans


def _tokens(text):
    return re.findall(r'\w+', (text or '').casefold())


def same_words(expected, heard):
    return _tokens(expected) == _tokens(heard)


def align_pieces(words, heard, *, lookahead=4, max_pieces=6):
    """Match words in order to runs of consecutive pieces whose transcripts spell exactly that word.

    Returns {word: (first_piece, last_piece)}. Matching by content means one bad piece only
    loses that word; it cannot shift every later word onto the wrong audio.
    """
    tokens = [_tokens(text) for text in heard]
    found, position = {}, 0
    for word in words:
        want = _tokens(speech_text(word))
        if not want:
            continue
        match = None
        for start in range(position, min(position + lookahead, len(tokens))):
            collected = []
            for end in range(start, min(start + max_pieces, len(tokens))):
                collected = collected + tokens[end]
                if collected == want:
                    match = (start, end)
                    break
                if len(collected) >= len(want) or collected != want[:len(collected)]:
                    break
            if match:
                break
        if match:
            found[word] = match
            position = match[1] + 1
    return found


def synthesize_batch(words, model, *, synth=synthesize, transcribe=transcribe_clips):
    """{word: wav} for the words whose audio was verified; others are simply missing."""
    recording = synth(' <long pause> '.join(speech_text(word) + '.' for word in words), model=model)
    rate, step, pcm, spans = speech_pieces(recording)
    if not spans:
        return {}

    def clip(first, last):
        start = max(0, spans[first][0] - 5)           # 50 ms lead-in
        end = min(len(pcm) // step, spans[last][1] + 8)  # 80 ms tail
        return _wav_bytes(rate, pcm[start * step:end * step].tobytes())

    heard = transcribe([clip(i, i) for i in range(len(spans))])
    return {word: clip(first, last) for word, (first, last) in align_pieces(words, heard).items()}


def next_quota_reset(now=None):
    """Gemini daily quotas reset at midnight Pacific time; add a small margin."""
    from zoneinfo import ZoneInfo
    pacific = ZoneInfo('America/Los_Angeles')
    current = dt.datetime.fromtimestamp(now if now is not None else time.time(), pacific)
    midnight = (current + dt.timedelta(days=1)).replace(hour=0, minute=5, second=0, microsecond=0)
    return midnight.timestamp()


# --------------------------------------------------------------------------- notes

def note_target(card):
    """(note, word, field_to_write) for a card that should get audio, or None to skip."""
    from quiz import card_material, pick_fields, settings_for
    from deck_options import effective_settings
    link = card.note_link
    if link is None:
        return None
    note = link.note
    names = json.loads(note.note_type.fields_json)
    values = json.loads(note.fields_json)
    if len(names) != len(values):
        return None
    fields = dict(zip(names, values))
    settings = settings_for(effective_settings(card.deck))
    material = card_material(card, settings)
    if material is None or material['kind'] != 'vocab' or material['sound']:
        return None
    if len(material['word']) > 60:
        return None  # a paragraph (e.g. a deck's intro card) is not a word to pronounce
    word_name, meaning_name, _ = pick_fields(fields, settings)
    if any(_SOUND.search(fields.get(name) or '') for name in fields if _AUDIO_FIELD.search(name)):
        return None
    if any('[sound:tts-' in (value or '') for value in values):
        return None
    empty_audio = next((n for n in names if _AUDIO_FIELD.search(n) and not (fields[n] or '').strip()), None)
    return note, material['word'], empty_audio or meaning_name


def _media_path(user_id, word):
    from media_utils import get_media_dir
    return os.path.join(get_media_dir(user_id), media_name(speech_text(word)))


def _save(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.part'
    with open(tmp, 'wb') as out:
        out.write(data)
    os.replace(tmp, path)


def attach(db, card, *, synth=None):
    """Attach audio to one card's note. Uses an existing file, else ``synth(text)``.

    Returns 'added' or 'skipped'; raises TTSError from synth.
    """
    from note_service import update_note
    target = note_target(card)
    if target is None:
        return 'skipped'
    note, word, field_name = target
    if not speech_text(word):
        return 'skipped'
    path = _media_path(note.user_id, word)
    if not os.path.exists(path):
        if synth is None:
            return 'skipped'
        _save(path, synth(speech_text(word)))
    filename = os.path.basename(path)
    names = json.loads(note.note_type.fields_json)
    fields = dict(zip(names, json.loads(note.fields_json)))
    current = fields[field_name] or ''
    fields[field_name] = (current + ' ' if current.strip() else '') + f'[sound:{filename}]'
    update_note(db, note, fields, json.loads(note.tags_json))
    return 'added'


# --------------------------------------------------------------------------- background jobs

@dataclass
class Job:
    deck_id: int
    user_id: int
    state: str = 'queued'          # queued | running | waiting | done | stopped | failed
    total: int = 0                 # distinct words that need audio
    added: int = 0                 # notes that received audio
    done_words: int = 0
    failed: int = 0
    skipped: int = 0               # cards that already had audio or nothing to say
    piper_words: int = 0           # words voiced by the offline fallback
    mode: str = 'fill'             # fill: give words audio; upgrade: replace Piper audio with Gemini
    error: str = ''
    resume_at: float = 0.0
    started_at: float = field(default_factory=time.time)
    cancel: threading.Event = field(default_factory=threading.Event, repr=False)

    def public(self):
        return {'state': self.state, 'mode': self.mode, 'piper': self.piper_words,
                'total': self.total, 'done': self.done_words, 'added': self.added,
                'skipped': self.skipped, 'failed': self.failed, 'error': self.error,
                'remaining': max(0, self.total - self.done_words - self.failed),
                'resume_at': int(self.resume_at) if self.state == 'waiting' else None}


ACTIVE_STATES = ('queued', 'running', 'waiting', 'stopping')  # a job in any of these can be stopped

_jobs = {}
_jobs_lock = threading.Lock()


def job_for(user_id, deck_id):
    with _jobs_lock:
        return _jobs.get((user_id, deck_id))


def _deck_card_ids(db, deck):
    from models import Card, Deck
    pattern = deck.name.replace('\\', '\\\\').replace('%', r'\%').replace('_', r'\_') + '::%'
    decks = db.query(Deck.id).filter(Deck.user_id == deck.user_id).filter(
        (Deck.id == deck.id) | Deck.name.like(pattern, escape='\\'))
    return [cid for (cid,) in db.query(Card.id).filter(Card.deck_id.in_(decks)).order_by(Card.id)]


def _wait(job, seconds, sleep, now=time.time):
    """Sleep in small steps so cancel stays responsive. Returns False if cancelled."""
    deadline = now() + seconds
    while True:
        if job.cancel.is_set():
            return False
        left = deadline - now()
        if left <= 0:
            return True
        sleep(min(left, 5.0))


def _upgrade_targets(db, deck):
    """{word: audio path} for notes whose generated audio is not Gemini's (i.e. Piper)."""
    from models import Card
    from quiz import card_material, settings_for
    from deck_options import effective_settings
    from media_utils import get_media_dir
    found, seen = {}, set()
    for card_id in _deck_card_ids(db, deck):
        card = db.get(Card, card_id)
        if card is None or card.note_link is None or card.note_link.note_id in seen:
            continue
        seen.add(card.note_link.note_id)
        material = card_material(card, settings_for(effective_settings(card.deck)))
        sound = (material or {}).get('sound') or ''
        if not sound.startswith('tts-'):
            continue
        path = os.path.join(get_media_dir(deck.user_id), sound)
        if os.path.exists(path) and not is_gemini_audio(path):
            found.setdefault(material['word'], path)
    return found


def run_job(job, session_factory, *, synth_batch=synthesize_batch, sleep=time.sleep, rpm=None, now=time.time,
            piper=None):
    """Fill: give every word in the deck audio (Gemini first, Piper when Gemini cannot).
    Upgrade: replace Piper audio with Gemini audio in place. Both are safe to re-run."""
    from models import Card, Deck
    rpm = rpm or max(1, int(os.getenv('GEMINI_TTS_RPM', '3') or 3))
    gap = 60.0 / rpm + 1.0
    if piper is None and job.mode == 'fill' and piper_available():
        piper = piper_wav
    db = session_factory()
    job.state = 'running'
    try:
        deck = db.get(Deck, job.deck_id)
        words = {}  # fill: word -> [card ids]; upgrade: word -> audio path
        if job.mode == 'upgrade':
            words = _upgrade_targets(db, deck)
        else:
            seen_notes = set()
            for card_id in _deck_card_ids(db, deck):
                card = db.get(Card, card_id)
                if card is None or card.note_link is None or card.note_link.note_id in seen_notes:
                    continue
                seen_notes.add(card.note_link.note_id)
                target = note_target(card)
                if target is None or not speech_text(target[1]):
                    job.skipped += 1
                    continue
                words.setdefault(target[1], []).append(card_id)
        job.total = len(words)

        def attach_word(word):
            for card_id in words[word]:
                card = db.get(Card, card_id)
                try:
                    if card is not None and attach(db, card) == 'added':
                        job.added += 1
                    db.commit()
                except ValueError as exc:  # note edited meanwhile so it no longer renders
                    db.rollback()
                    job.error = str(exc)
            job.done_words += 1

        def store(word, data):
            if job.mode == 'upgrade':
                _save(words[word], data)  # same file name, so notes need no change
                job.added += 1
                job.done_words += 1
            else:
                _save(_media_path(job.user_id, word), data)
                attach_word(word)

        def piper_rest(remaining):
            for word in remaining:
                if job.cancel.is_set():
                    return False
                try:
                    store(word, piper(word))
                    job.piper_words += 1
                except Exception as exc:  # one odd word must not stop the deck
                    log.warning('Piper failed for %r: %s', word, exc)
                    job.failed += 1
            return True

        pending = []
        for word in words:
            if job.mode == 'fill' and os.path.exists(_media_path(job.user_id, word)):
                attach_word(word)  # another deck already has this word's audio
            else:
                pending.append(word)

        attempts = {}     # word -> failed verifications
        errors = 0        # consecutive request errors
        plain_429 = 0     # consecutive 429s without Retry-After
        busy = {}         # model -> consecutive overload / timeout errors
        exhausted = set() if api_key() else set(models())
        last_call = 0.0
        while pending:
            if job.cancel.is_set():
                job.state = 'stopped'
                return job
            available = [m for m in models() if m not in exhausted]
            if not available:
                if piper is not None:
                    # Gemini is out of free quota (or not configured): voice the rest offline right now.
                    if not piper_rest(pending):
                        job.state = 'stopped'
                        return job
                    pending = []
                    break
                job.state, job.resume_at = 'waiting', next_quota_reset(now())
                job.error = 'Free daily quota used up; continuing automatically after the reset'
                if not _wait(job, max(0.0, job.resume_at - now()), sleep, now):
                    job.state = 'stopped'
                    return job
                job.state, job.error = 'running', ''
                exhausted.clear()
                continue
            batch, pending = pending[:batch_size()], pending[batch_size():]
            wait = gap - (now() - last_call)
            if wait > 0 and not _wait(job, wait, sleep, now):
                job.state = 'stopped'
                return job
            last_call = now()
            started = time.time()
            try:
                clips = synth_batch(batch, available[0])
            except TTSError as exc:
                log.warning('TTS batch of %d with %s failed: %s (%s)', len(batch), available[0], exc.kind, exc)
                pending = batch + pending
                if exc.kind == 'daily_limit':
                    exhausted.add(available[0])
                    continue
                if exc.kind in ('auth', 'location'):
                    if piper is not None:
                        exhausted.update(models())  # Gemini unusable: fall back for everything
                        continue
                    job.state, job.error = 'failed', str(exc)  # nothing else would work
                    return job
                if exc.kind in ('busy', 'network'):
                    # Google overloaded or the request timed out: after two in a row, stop using this model
                    # for this run (the next model, then Piper, takes over) instead of retrying for minutes.
                    busy[available[0]] = busy.get(available[0], 0) + 1
                    if busy[available[0]] >= 2:
                        exhausted.add(available[0])
                        continue
                errors += 1
                if errors > 6:
                    if piper is not None:
                        exhausted.update(models())
                        continue
                    job.state, job.error = 'failed', str(exc)
                    return job
                if exc.kind == 'rate_limit' and exc.retry_after is None:
                    # The free tier may report its daily cap as a plain 429; switch model after two in a row.
                    plain_429 += 1
                    if plain_429 >= 2:
                        exhausted.add(available[0])
                        plain_429 = 0
                        continue
                if not _wait(job, exc.retry_after or 30, sleep, now):
                    job.state = 'stopped'
                    return job
                continue
            errors = plain_429 = 0
            busy.pop(available[0], None)
            log.info('TTS batch: %d/%d verified with %s in %.0fs', len(clips), len(batch), available[0],
                     time.time() - started)
            given_up = []
            for word in batch:
                if word in clips:
                    store(word, clips[word])
                    continue
                # Unverified words ride along in a later batch (never alone: each request is precious).
                attempts[word] = attempts.get(word, 0) + 1
                if attempts[word] >= 3:
                    given_up.append(word)
                else:
                    pending.append(word)
            if given_up:
                if piper is not None:
                    piper_rest(given_up)
                else:
                    job.failed += len(given_up)
        job.state = 'done'
        return job
    except Exception as exc:  # never let a background thread die silently
        log.exception('TTS job failed')
        db.rollback()
        job.state, job.error = 'failed', str(exc)
        return job
    finally:
        db.close()


def start_job(user_id, deck_id, session_factory, mode='fill'):
    with _jobs_lock:
        current = _jobs.get((user_id, deck_id))
        if current and current.state in ACTIVE_STATES:
            return current
        job = Job(deck_id=deck_id, user_id=user_id, mode=mode)
        _jobs[(user_id, deck_id)] = job
    threading.Thread(target=run_job, args=(job, session_factory), daemon=True, name=f'tts-{deck_id}').start()
    return job


def synthesize_any_model(text):
    """One word for a freshly added note: each Gemini model in turn, then Piper."""
    last = None
    if api_key():
        for model in models():
            try:
                return synthesize(text, model=model)
            except TTSError as exc:
                if exc.kind in ('auth', 'location'):
                    last = exc
                    break
                if exc.kind not in ('daily_limit', 'rate_limit', 'network', 'busy'):
                    raise
                last = exc
    if piper_available():
        return piper_wav(text)
    raise last or TTSError('daily_limit', 'No TTS model has quota left')


def attach_in_background(card_ids, session_factory):
    """Best-effort audio for freshly added notes; failures are logged, never raised."""
    if not enabled() or not card_ids:
        return

    def work():
        from models import Card
        db = session_factory()
        try:
            for card_id in card_ids:
                card = db.get(Card, card_id)
                if card is None:
                    continue
                try:
                    attach(db, card, synth=synthesize_any_model)
                    db.commit()
                except (TTSError, ValueError) as exc:
                    db.rollback()
                    log.warning('TTS for card %s skipped: %s', card_id, exc)
        finally:
            db.close()

    threading.Thread(target=work, daemon=True, name='tts-note').start()
