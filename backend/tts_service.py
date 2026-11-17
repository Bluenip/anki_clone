"""Generate pronunciation audio for vocabulary notes with Kokoro.

Speech comes from the ``tts`` service (hexgrad/kokoro on the server's GPU, see
``tts/app.py``); this module only calls it over HTTP. Audio is saved once per
(voice, text) as a WAV in the user's media folder and attached to the note as
``[sound:tts-....wav]``: in an empty audio-named field if the note type has
one, otherwise at the end of the meaning field. The word field is never
modified, so first-field duplicate detection on re-import keeps working.

Older decks may still hold audio from the offline Piper voice (22.05 kHz).
"Upgrade" re-voices those words with Kokoro in place, keeping the file names.
Audio made earlier by Gemini (24 kHz, like Kokoro) is kept as it is.

Configuration (environment):
    TTS_URL        base URL of the Kokoro service, e.g. http://tts:8880;
                   without it every entry point is a no-op
    KOKORO_VOICE   default af_heart
"""
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
if not log.handlers:  # make job results visible in `docker compose logs backend`
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter('%(levelname)s:     tts: %(message)s'))
    log.addHandler(_handler)
    log.setLevel(logging.INFO)
    log.propagate = False

KOKORO_RATE = 24000
PIPER_RATE = 22050   # the offline voice used before Kokoro (en_US-lessac-medium)
_SOUND = re.compile(r'\[sound:[^\]]+\]')
_AUDIO_FIELD = re.compile(r'audio|sound|âm\s*thanh|phát\s*âm|pronunciation', re.I)
_SEPARATORS = re.compile(r'\s*[–—/|;,]\s*|\s+-\s+')


def service_url():
    return os.getenv('TTS_URL', '').strip().rstrip('/')


def enabled():
    return bool(service_url())


def voice_name():
    return os.getenv('KOKORO_VOICE', 'af_heart').strip() or 'af_heart'


class TTSError(Exception):
    """kind: busy | network | bad_response | other."""

    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind


def speech_text(word):
    """What to say for one word: separators such as 'go – went' or 'was/were' become short pauses."""
    text = _SEPARATORS.sub(', ', word or '')
    return re.sub(r'\s+', ' ', text).strip(' ,')


def media_name(text, voice=None):
    digest = hashlib.sha1(f'{voice or voice_name()}|{text}'.encode()).hexdigest()[:20]
    return f'tts-{digest}.wav'


def synthesize(text, *, timeout=120, opener=urllib.request.urlopen):
    """Return WAV bytes for ``text`` from the Kokoro service. Raises TTSError."""
    if not enabled():
        raise TTSError('other', 'TTS_URL is not configured')
    request = urllib.request.Request(
        service_url() + '/speak', method='POST', headers={'Content-Type': 'application/json'},
        data=json.dumps({'text': text, 'voice': voice_name()}).encode())
    try:
        with opener(request, timeout=timeout) as response:
            data = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read()[:300].decode('utf-8', 'replace')
        kind = 'busy' if exc.code in (500, 502, 503, 504) else 'other'
        raise TTSError(kind, f'TTS service error {exc.code}: {detail}') from None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise TTSError('network', f'Could not reach the TTS service: {exc}') from None
    try:
        with wave.open(io.BytesIO(data)) as source:
            if source.getnframes() == 0:
                raise TTSError('bad_response', 'The TTS service returned empty audio')
    except (wave.Error, EOFError) as exc:
        raise TTSError('bad_response', f'The TTS service returned unreadable audio: {exc}') from None
    return data


def is_piper_audio(path):
    """True for audio made by the old offline Piper voice (22.05 kHz)."""
    try:
        with wave.open(path) as source:
            return source.getframerate() == PIPER_RATE
    except (OSError, wave.Error, EOFError):
        return False


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
    state: str = 'queued'          # queued | running | stopping | done | stopped | failed
    total: int = 0                 # distinct words that need audio
    added: int = 0                 # notes that received audio (upgrade: words re-voiced)
    done_words: int = 0
    failed: int = 0
    skipped: int = 0               # cards that already had audio or nothing to say
    mode: str = 'fill'             # fill: give words audio; upgrade: replace Piper audio with Kokoro
    error: str = ''
    started_at: float = field(default_factory=time.time)
    cancel: threading.Event = field(default_factory=threading.Event, repr=False)

    def public(self):
        return {'state': self.state, 'mode': self.mode,
                'total': self.total, 'done': self.done_words, 'added': self.added,
                'skipped': self.skipped, 'failed': self.failed, 'error': self.error,
                'remaining': max(0, self.total - self.done_words - self.failed)}


ACTIVE_STATES = ('queued', 'running', 'stopping')  # a job in any of these can be stopped
RETRIES = 3          # attempts per word when the service is busy or unreachable
MAX_ERRORS = 10      # consecutive failed words before the job gives up (service down)

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


def upgrade_targets(db, deck):
    """{word: audio path} for notes whose generated audio still uses the old Piper voice."""
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
        if os.path.exists(path) and is_piper_audio(path):
            found.setdefault(material['word'], path)
    return found


def _speak_with_retries(job, text, synth, sleep):
    """Kokoro audio for one word; a busy or briefly unreachable service is retried."""
    for attempt in range(RETRIES):
        try:
            return synth(text)
        except TTSError as exc:
            if exc.kind not in ('busy', 'network') or attempt == RETRIES - 1 or job.cancel.is_set():
                raise
            sleep(2.0 * (attempt + 1))
    raise TTSError('other', 'unreachable')  # pragma: no cover


def run_job(job, session_factory, *, synth=None, sleep=time.sleep):
    """Fill: give every word in the deck audio. Upgrade: replace Piper audio with Kokoro audio in place.
    Both are safe to re-run."""
    from models import Card, Deck
    synth = synth or synthesize
    db = session_factory()
    job.state = 'running'
    try:
        deck = db.get(Deck, job.deck_id)
        words = {}  # fill: word -> [card ids]; upgrade: word -> audio path
        if job.mode == 'upgrade':
            words = upgrade_targets(db, deck)
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

        errors = 0
        started = time.time()
        for word in words:
            if job.cancel.is_set():
                job.state = 'stopped'
                return job
            if job.mode == 'fill' and os.path.exists(_media_path(job.user_id, word)):
                attach_word(word)  # another deck already has this word's audio
                continue
            try:
                data = _speak_with_retries(job, speech_text(word), synth, sleep)
            except TTSError as exc:
                log.warning('TTS failed for %r: %s (%s)', word, exc.kind, exc)
                job.failed += 1
                job.error = str(exc)
                errors += 1
                if errors >= MAX_ERRORS:
                    job.state = 'failed'
                    return job
                continue
            errors = 0
            if job.mode == 'upgrade':
                _save(words[word], data)  # same file name, so notes need no change
                job.added += 1
                job.done_words += 1
            else:
                _save(_media_path(job.user_id, word), data)
                attach_word(word)
        log.info('TTS %s job for deck %s: %d/%d words in %.0fs, %d failed', job.mode, job.deck_id,
                 job.done_words, job.total, time.time() - started, job.failed)
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
                    attach(db, card, synth=synthesize)
                    db.commit()
                except (TTSError, ValueError) as exc:
                    db.rollback()
                    log.warning('TTS for card %s skipped: %s', card_id, exc)
        finally:
            db.close()

    threading.Thread(target=work, daemon=True, name='tts-note').start()
