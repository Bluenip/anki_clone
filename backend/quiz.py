"""Graded review exercises so students cannot self-rate their way past cards.

Unless a deck turns ``quiz_mode`` off (it is on by default), the study screen no longer offers the
Again/Hard/Good/Easy buttons. Each card instead becomes one exercise
(multiple choice, listening, typing, cloze, scramble, or copy for new cards)
and the server derives the rating from the student's first answer:

* correct, no hint            -> Good (3)
* almost correct or hint used -> Hard (2)
* wrong                       -> Again (1)

The exercise type is chosen deterministically from the card's scheduling
version, so reloading the page cannot reroll an easier exercise, and the
review endpoint re-plans the same exercise to grade the answer without
trusting the client's idea of what was asked.
"""
import json
import random
import re
import unicodedata
from urllib.parse import quote


from models import Card, NoteCard, Note
from note_rendering import text_only

QUIZ_TYPES = ('multiple_choice', 'listening', 'typing', 'cloze', 'scramble')
ALL_TYPES = QUIZ_TYPES + ('copy',)
DEFAULT_SETTINGS = {
    'quiz_mode': True,
    'quiz_types': list(QUIZ_TYPES),
    'quiz_copy_new_cards': True,
    'quiz_word_field': '',
    'quiz_meaning_field': '',
    'quiz_example_field': '',
    'quiz_tts_lang': '',
}

_SOUND = re.compile(r'\[sound:([^\]]+)\]')
_EXAMPLE_NAME = re.compile(r'example|sentence|explanation|ví\s*dụ|vi\s*du|câu|例', re.I)
_AUDIO_NAME = re.compile(r'audio|sound|âm\s*thanh|phát\s*âm|pronunciation', re.I)
_CJK = re.compile(r'[぀-ヿ㐀-鿿가-힯]')
_SPLIT = re.compile(r'\s*[,;/、，；|]\s*')
_WORD_NAME = re.compile(r'^(?:front|word|keyword|vocab\w*|term|expression|english|hanzi|kanji|từ(?:\s*vựng)?|tu\s*vung|mặt\s*trước)$', re.I)
_MEANING_NAME = re.compile(r'^(?:back|meaning|nghĩa|nghia|definition|translation|vietnamese|tiếng\s*việt|short\s*vietnamese|mặt\s*sau)$|meaning|nghĩa|vietnamese', re.I)
_LABELLED_EXAMPLE = re.compile(r'^\s*(?:ví\s*dụ|vd|example|e\.g\.?|ex)\s*[:：]\s*(.+)$', re.I)
_BLOCK = re.compile(r'<\s*(?:br|hr)\b[^>]*>|<\s*/\s*(?:div|p|li|tr|h\d)\s*>', re.I)


def settings_for(raw):
    merged = dict(DEFAULT_SETTINGS)
    merged.update({k: raw[k] for k in DEFAULT_SETTINGS if k in raw})
    return merged


# --------------------------------------------------------------------------- text helpers

def plain(value):
    """Visible text of a field without sound tags or Anki furigana brackets."""
    text = text_only(_SOUND.sub('', value or ''))
    if _CJK.search(text):
        text = re.sub(r'\[[^\]]*\]', '', text).replace(' ', '')
    return re.sub(r'\s+', ' ', text).strip()


def lines(value):
    """Visible text split on HTML line breaks and block ends."""
    text = text_only(_SOUND.sub('', _BLOCK.sub('\n', value or '')))
    return [re.sub(r'\s+', ' ', line).strip() for line in text.split('\n') if line.strip()]


def first_line(value):
    """The headline of a rich field, e.g. 'thức giấc' out of 'thức giấc<br>Cách dùng: …'."""
    parts = lines(value)
    return plain(parts[0]) if parts else ''


def mask(text, word):
    """Hide the answer if the prompt happens to contain it."""
    if not text or not word or len(word) < 2:
        return text
    return re.sub(re.escape(word), '_____', text, flags=re.I)


def normalize(value):
    value = unicodedata.normalize('NFKC', value or '').casefold()
    value = ''.join(ch for ch in value if not unicodedata.category(ch).startswith('P'))
    return re.sub(r'\s+', ' ', value).strip()


def variants(target):
    """Accept the whole answer, any comma/slash part, and parts without (notes)."""
    found = set()
    for candidate in [target] + _SPLIT.split(target):
        for form in (candidate, re.sub(r'\([^)]*\)', '', candidate)):
            norm = normalize(form)
            if norm:
                found.add(norm)
    return found


def _distance(a, b, limit):
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


def compare(response, target):
    """Return 'correct', 'close' (small typo) or 'wrong'."""
    answer = normalize(response)
    if not answer:
        return 'wrong'
    accepted = variants(target)
    if answer in accepted:
        return 'correct'
    for option in accepted:
        limit = 2 if len(option) >= 8 else 1 if len(option) >= 4 else 0
        if limit and not _CJK.search(option) and _distance(answer, option, limit) <= limit:
            return 'close'
    return 'wrong'


def tts_lang(text, configured):
    if configured:
        return configured
    if re.search(r'[぀-ヿ]', text):
        return 'ja-JP'
    if re.search(r'[가-힯]', text):
        return 'ko-KR'
    if re.search(r'[㐀-鿿]', text):
        return 'zh-CN'
    return 'en-US'


# --------------------------------------------------------------------------- card fields

def _fields(card):
    link = card.note_link
    if link is None:
        return {'Front': card.front, 'Back': card.back}, None, 0
    note = link.note
    names = json.loads(note.note_type.fields_json)
    values = json.loads(note.fields_json)
    if len(names) != len(values):
        return None, None, 0
    return dict(zip(names, values)), note, link.template_ord


def _usable(value):
    text = plain(value)
    return bool(text) and not re.fullmatch(r'[\d\s.,|#№-]+', text)


def pick_fields(fields, settings):
    """Choose word/meaning/example fields: teacher's choice, then field names, then order."""
    names = list(fields)
    usable = [n for n in names if _usable(fields[n])]

    def choose(configured, pattern, exclude, position):
        if configured and configured in fields:
            return configured
        for name in usable:
            if name not in exclude and pattern.search(name.strip()):
                return name
        rest = [n for n in usable if n not in exclude]
        return rest[position] if len(rest) > position else None

    word = choose(settings['quiz_word_field'], _WORD_NAME, set(), 0)
    meaning = choose(settings['quiz_meaning_field'], _MEANING_NAME, {word}, 0)
    example = settings['quiz_example_field'] if settings['quiz_example_field'] in fields else next(
        (n for n in usable if n not in (word, meaning) and _EXAMPLE_NAME.search(n)), None)
    return word, meaning, example


def _example_from(fields, example_name, meaning_name, word):
    """A sentence containing the word: the example field, else a 'Ví dụ:' line, else any line with the word."""
    sources = []
    if example_name:
        sources.append(fields[example_name])
    for name in (example_name, meaning_name):
        if name:
            sources.append(fields[name])
    labelled, loose = [], []
    for source in sources:
        # Cloze markup inside an example field marks exactly where the word goes.
        source = re.sub(r'\{\{c\d+::(.*?)(?:::.*?)?\}\}', r'\1', source or '', flags=re.S)
        for line in lines(source):
            line = _clean(line.lstrip('→-•* ').strip())
            match = _LABELLED_EXAMPLE.match(line)
            if match:
                labelled.append(match[1].strip())
            elif not re.match(r'^[^:：]{1,25}[:：]', line):
                loose.append(line)
    for line in labelled + loose:
        if word and re.search(re.escape(word), line, re.I) and normalize(line) != normalize(word):
            return line
    return ''


def _clean(text):
    """Drop stray cloze punctuation left behind by malformed deletions."""
    return re.sub(r'\s+', ' ', re.sub(r'\{\{c\d+::|::|\{\{|\}\}', ' ', text)).strip()


def _cloze_answer(fields, ordinal):
    from cloze import render, typed
    for value in fields.values():
        if not re.search(r'\{\{c\d+::', value or ''):
            continue
        try:
            answer = plain(typed(value, ordinal))
            if not answer:
                continue
            front = render(value, ordinal, False)
        except ValueError:
            continue
        front = re.sub(r'<span class="cloze">.*?</span>', ' _____ ', front, flags=re.S)
        lines_ = [_clean(line) for line in lines(front)]
        sentence = next((line for line in lines_ if '_____' in line), '')
        return mask(sentence, answer), answer
    return None


def _is_cloze_type(note):
    try:
        return any('{{cloze:' in t.get('qfmt', '') for t in json.loads(note.note_type.templates_json))
    except (ValueError, AttributeError):
        return False


def card_material(card, settings):
    """Extract word/meaning/example/audio, or None when the card cannot be quizzed."""
    fields, note, ordinal = _fields(card)
    if not fields:
        return None
    if note is not None and 'Occlusion' in fields:
        return None
    has_cloze = any(re.search(r'\{\{c\d+::', value or '') for value in fields.values())

    def cloze_material():
        cloze = _cloze_answer(fields, ordinal) if has_cloze and note is not None and _is_cloze_type(note) else None
        if not cloze or not cloze[0]:
            return None
        return {'kind': 'cloze_note', 'sentence': cloze[0], 'word': cloze[1], 'meaning': '', 'example': '', 'sound': None}

    # Prefer a vocabulary card (word + meaning); a cloze field then only supplies the example sentence.
    word_name, meaning_name, example_name = pick_fields(fields, settings)
    if not word_name or not meaning_name or word_name == meaning_name or re.search(r'\{\{c\d+::', fields[word_name] or ''):
        return cloze_material()
    word, meaning = first_line(fields[word_name]), first_line(fields[meaning_name])
    if not word or not meaning or normalize(word) == normalize(meaning):
        return cloze_material()
    sound = None
    for name in [word_name] + [n for n in fields if _AUDIO_NAME.search(n)]:
        match = _SOUND.search(fields.get(name) or '')
        if match and '/' not in match[1] and '\\' not in match[1]:
            sound = match[1]
            break
    if sound is None:
        # Generated pronunciation (tts_service) is stored with the meaning so the word field stays untouched.
        sound = next((m[1] for value in fields.values() for m in [re.search(r'\[sound:(tts-[0-9a-f]+\.wav)\]', value or '')] if m), None)
    return {'kind': 'vocab', 'word': word, 'meaning': mask(meaning, word),
            'example': _example_from(fields, example_name, meaning_name, word), 'sound': sound}


def _blank_example(example, word):
    if not example or not word:
        return None
    pattern = re.compile(re.escape(word), re.I)
    if not pattern.search(example):
        return None
    return pattern.sub('_____', example)


def _sibling_query(db, card):
    """Other notes in the deck of the same note type (so a cloze or image note never becomes an option)."""
    query = db.query(Note.fields_json, Note.note_type_id).join(NoteCard, NoteCard.note_id == Note.id).join(
        Card, Card.id == NoteCard.card_id).filter(Card.deck_id == card.deck_id, Card.id != card.id)
    if card.note_link is not None:
        query = query.filter(Note.note_type_id == card.note_link.note.note_type_id, Note.id != card.note_link.note_id)
    return query.distinct()


# --------------------------------------------------------------------------- planning

def plan(db, card, raw_settings, progress, version):
    """Pick (type, direction) deterministically, or None to keep the normal flip flow."""
    settings = settings_for(raw_settings)
    if not settings['quiz_mode']:
        return None
    material = card_material(card, settings)
    if material is None:
        return None
    if material['kind'] == 'cloze_note':
        return {'type': 'cloze', 'direction': 'note', 'material': material, 'settings': settings}
    is_new = progress is None or progress.card_state == 'new'
    if is_new and settings['quiz_copy_new_cards']:
        return {'type': 'copy', 'direction': 'meaning_to_word', 'material': material, 'settings': settings}
    allowed = [t for t in settings['quiz_types'] if t in QUIZ_TYPES]
    eligible = []
    for kind in allowed:
        if kind == 'cloze' and not _blank_example(material['example'], material['word']):
            continue
        if kind == 'scramble' and not 3 <= len(material['word'].replace(' ', '')) <= 40:
            continue
        if kind == 'multiple_choice' and _sibling_query(db, card).limit(3).count() < 3:
            continue
        eligible.append(kind)
    if not eligible:
        eligible = ['typing']
    rng = random.Random(f'{card.id}:{version}:{progress.repetitions if progress else 0}:{progress.lapse_count if progress else 0}')
    kind = rng.choice(eligible)
    direction = rng.choice(['meaning_to_word', 'word_to_meaning']) if kind == 'multiple_choice' else 'meaning_to_word'
    return {'type': kind, 'direction': direction, 'material': material, 'settings': settings}


def _distractors(db, card, settings, target_key, target, count=3, version=0):
    candidates = []
    seen = {normalize(target)}
    from models import NoteType
    types = {}
    # Seeded, so reloading the page shows the same options (otherwise the one option that never
    # changes gives the answer away). Every sibling is a candidate, so fewer get filtered short.
    rows = _sibling_query(db, card).order_by(Note.id).limit(2000).all()
    random.Random(f'{card.id}:{version}:distractors').shuffle(rows)
    for fields_json, note_type_id in rows:
        if note_type_id not in types:
            types[note_type_id] = json.loads(db.get(NoteType, note_type_id).fields_json)
        names = types[note_type_id]
        values = json.loads(fields_json)
        if len(names) != len(values):
            continue
        fields = dict(zip(names, values))
        word_name, meaning_name, _ = pick_fields(fields, settings)
        name = word_name if target_key == 'word' else meaning_name
        raw = (fields.get(name) or '') if name else ''
        if re.search(r'\{\{c\d+::', raw):
            continue
        value = first_line(raw)
        if value and len(value) <= 80 and normalize(value) not in seen:
            seen.add(normalize(value))
            candidates.append(value)
        if len(candidates) >= count:
            break
    return candidates


def build(db, card, raw_settings, progress, version, user_id):
    """Exercise payload for the study screen (never includes the expected answer)."""
    planned = plan(db, card, raw_settings, progress, version)
    if planned is None:
        return None
    kind, material, settings = planned['type'], planned['material'], planned['settings']
    word = material['word']
    exercise = {'type': kind, 'direction': planned['direction'], 'meaning': material['meaning'],
                'answer_length': len(word), 'audio': None, 'tts': None}
    speak_text = word
    if material['sound']:
        exercise['audio'] = f"/api/media/{user_id}/{quote(material['sound'], safe='')}"
    if kind == 'copy':
        exercise['word'] = word
        exercise['example'] = material['example']
    elif kind == 'cloze':
        exercise['sentence'] = material['sentence'] if material['kind'] == 'cloze_note' else _blank_example(material['example'], word)
        speak_text = ''
        exercise['audio'] = None
    elif kind == 'scramble':
        letters = list(word.replace(' ', ''))
        rng = random.Random(f'{card.id}:{version}:scramble')
        for _ in range(10):
            rng.shuffle(letters)
            if ''.join(letters) != word.replace(' ', ''):
                break
        exercise['letters'] = letters
    elif kind == 'multiple_choice':
        target_key = 'word' if planned['direction'] == 'meaning_to_word' else 'meaning'
        target = material[target_key]
        options = _distractors(db, card, settings, target_key, target, version=version) + [target]
        random.Random(f'{card.id}:{version}:options').shuffle(options)
        exercise['options'] = options
        if planned['direction'] == 'word_to_meaning':
            exercise['word'] = word
            exercise['meaning'] = ''
        if target_key == 'meaning':
            speak_text = word
    if kind == 'listening':
        exercise['meaning'] = ''
    if kind in ('typing', 'listening', 'cloze', 'scramble') and len(word) >= 3:
        # A hint on a one- or two-character word (e.g. a single Hanzi) would give the whole answer away.
        # Revealed only when the student asks for it, which downgrades the rating to Hard.
        exercise['hint'] = ' '.join(ch if i == 0 or ch == ' ' else '_' for i, ch in enumerate(word))
    if speak_text and not exercise['audio'] and kind in ('listening', 'copy', 'multiple_choice'):
        exercise['tts'] = {'text': speak_text, 'lang': tts_lang(speak_text, settings['quiz_tts_lang'])}
    if kind != 'listening' and kind != 'copy' and not (kind == 'multiple_choice' and planned['direction'] == 'word_to_meaning'):
        # Only listening/copy may play the word before answering; otherwise it gives the answer away.
        exercise['audio'] = None
        exercise['tts'] = None
    return exercise


def grade(db, card, raw_settings, progress, version, response, hint_used=False):
    planned = plan(db, card, raw_settings, progress, version)
    if planned is None:
        return None
    material = planned['material']
    target = material['meaning'] if planned['type'] == 'multiple_choice' and planned['direction'] == 'word_to_meaning' else material['word']
    result = compare(response, target)
    if planned['type'] == 'multiple_choice' and result == 'close':
        result = 'wrong'
    rating = 1 if result == 'wrong' else 2 if (result == 'close' or hint_used) else 3
    return {'type': planned['type'], 'result': result, 'correct': result != 'wrong',
            'expected': target, 'rating': rating}
