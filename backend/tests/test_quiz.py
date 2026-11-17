import json

from models import ReviewLog
from quiz import compare, normalize, plain

WORDS = [('apple', 'quả táo'), ('banana', 'quả chuối'), ('orange', 'quả cam'), ('grape', 'quả nho'), ('lemon', 'quả chanh')]


def make_deck(client, headers, settings, words=WORDS, kind='basic'):
    deck = client.post('/api/decks', headers=headers, json={'name': 'Quiz'}).json()
    result = client.put(f"/api/decks/{deck['id']}", headers=headers, json={'settings': json.dumps(settings)})
    assert result.status_code == 200, result.text
    for front, back in words:
        fields = {'Front': front, 'Back': back} if kind == 'basic' else {'Text': front, 'Extra': back}
        note = client.post('/api/notes', headers=headers, json={'deck_id': deck['id'], 'kind': kind, 'fields': fields})
        assert note.status_code in (200, 201), note.text
    return deck['id']


def next_card(client, headers, deck_id):
    response = client.get(f'/api/study/{deck_id}', headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_answer_matching_is_forgiving_but_not_lenient():
    assert compare('  Apple! ', 'apple') == 'correct'
    assert compare('run', 'run, ran') == 'correct'
    assert compare('look', 'look (v)') == 'correct'
    assert compare('banan', 'banana') == 'close'
    assert compare('pear', 'apple') == 'wrong'
    assert compare('', 'apple') == 'wrong'
    assert compare('cat', 'car') == 'wrong'  # short words get no typo tolerance
    assert plain('<b>食べる[たべる]</b>[sound:x.mp3]') == '食べる'
    assert normalize('Ｈｅｌｌｏ') == 'hello'


def test_new_decks_quiz_by_default(client, auth_headers_a):
    deck_id = make_deck(client, auth_headers_a, {})
    card = next_card(client, auth_headers_a, deck_id)
    assert card['quiz']['type'] == 'copy'
    refused = client.post(f"/api/study/{card['card_id']}/review", headers=auth_headers_a, json={'rating': 4})
    assert refused.status_code == 400


def test_quiz_disabled_keeps_normal_flow(client, auth_headers_a):
    deck_id = make_deck(client, auth_headers_a, {'quiz_mode': False})
    card = next_card(client, auth_headers_a, deck_id)
    assert card['quiz'] is None
    ok = client.post(f"/api/study/{card['card_id']}/review", headers=auth_headers_a, json={'rating': 4})
    assert ok.status_code == 200, ok.text


def test_new_card_copy_exercise_and_server_derived_rating(client, auth_headers_a, db_session):
    deck_id = make_deck(client, auth_headers_a, {'quiz_mode': True})
    card = next_card(client, auth_headers_a, deck_id)
    quiz = card['quiz']
    assert quiz['type'] == 'copy'
    word = quiz['word']
    # Rating buttons are not trusted: no answer means the review is refused.
    refused = client.post(f"/api/study/{card['card_id']}/review", headers=auth_headers_a, json={'rating': 4})
    assert refused.status_code == 400
    check = client.post(f"/api/study/{card['card_id']}/quiz/check", headers=auth_headers_a, json={'response': 'nope'})
    assert check.json() == {'type': 'copy', 'result': 'wrong', 'correct': False, 'expected': word, 'rating': 1}
    # A wrong first answer is recorded as Again even if the client claims Easy.
    reviewed = client.post(f"/api/study/{card['card_id']}/review", headers=auth_headers_a,
                           json={'rating': 4, 'quiz': {'response': 'nope'}})
    assert reviewed.status_code == 200, reviewed.text
    assert db_session.query(ReviewLog).one().rating == 1


def test_review_cards_get_tests_without_leaking_the_answer(client, auth_headers_a, db_session):
    deck_id = make_deck(client, auth_headers_a, {'quiz_mode': True, 'quiz_copy_new_cards': False,
                                                 'quiz_types': ['typing', 'multiple_choice', 'scramble', 'listening']})
    seen = set()
    for _ in range(len(WORDS)):
        card = next_card(client, auth_headers_a, deck_id)
        quiz = card['quiz']
        seen.add(quiz['type'])
        word = next(w for w, m in WORDS if m == quiz['meaning'] or w == quiz.get('word') or
                    sorted(w) == sorted(quiz.get('letters', [])) or (quiz.get('tts') or {}).get('text') == w)
        if quiz['type'] in ('typing', 'scramble'):
            assert 'word' not in quiz and quiz['tts'] is None and quiz['audio'] is None
        if quiz['type'] == 'listening':
            assert quiz['meaning'] == '' and quiz['tts'] == {'text': word, 'lang': 'en-US'}
        if quiz['type'] == 'multiple_choice':
            assert len(quiz['options']) == 4
        answer = word
        if quiz['type'] == 'multiple_choice' and quiz['direction'] == 'word_to_meaning':
            answer = dict(WORDS)[word]
        # Reloading must not reroll an easier exercise.
        assert next_card(client, auth_headers_a, deck_id)['quiz']['type'] == quiz['type']
        reviewed = client.post(f"/api/study/{card['card_id']}/review", headers=auth_headers_a,
                               json={'rating': 1, 'quiz': {'response': answer, 'hint_used': False}})
        assert reviewed.status_code == 200, reviewed.text
    assert {log.rating for log in db_session.query(ReviewLog).all()} == {3}
    assert len(seen) >= 2


def test_hint_or_typo_downgrades_to_hard(client, auth_headers_a, db_session):
    deck_id = make_deck(client, auth_headers_a, {'quiz_mode': True, 'quiz_copy_new_cards': False, 'quiz_types': ['typing']})
    card = next_card(client, auth_headers_a, deck_id)
    word = next(w for w, m in WORDS if m == card['quiz']['meaning'])
    check = client.post(f"/api/study/{card['card_id']}/quiz/check", headers=auth_headers_a, json={'response': word, 'hint_used': True})
    assert check.json()['rating'] == 2
    client.post(f"/api/study/{card['card_id']}/review", headers=auth_headers_a, json={'rating': 3, 'quiz': {'response': word[:-1] + 'x'}})
    assert db_session.query(ReviewLog).one().rating in (1, 2)


def test_cloze_notes_and_example_sentences(client, auth_headers_a):
    deck_id = make_deck(client, auth_headers_a, {'quiz_mode': True},
                        [('I eat an {{c1::apple}} every day.', '')], kind='cloze')
    card = next_card(client, auth_headers_a, deck_id)
    assert card['quiz']['type'] == 'cloze'
    assert card['quiz']['sentence'] == 'I eat an _____ every day.'
    check = client.post(f"/api/study/{card['card_id']}/quiz/check", headers=auth_headers_a, json={'response': 'Apple'})
    assert check.json()['correct'] is True


def test_invalid_quiz_settings_are_rejected(client, auth_headers_a):
    deck = client.post('/api/decks', headers=auth_headers_a, json={'name': 'Bad'}).json()
    for bad in ({'quiz_types': ['dance']}, {'quiz_types': []}, {'quiz_tts_lang': 'not a lang'}):
        result = client.put(f"/api/decks/{deck['id']}", headers=auth_headers_a, json={'settings': json.dumps(bad)})
        assert result.status_code in (400, 422), (bad, result.text)


def test_choice_options_never_come_from_other_note_types(client, auth_headers_a):
    deck_id = make_deck(client, auth_headers_a, {'quiz_mode': True, 'quiz_copy_new_cards': False, 'quiz_types': ['multiple_choice']})
    for text in ('I eat an {{c1::apple}}.', 'A {{c1::lemon}} is sour.', 'Monkeys like {{c1::bananas}}.'):
        client.post('/api/notes', headers=auth_headers_a, json={'deck_id': deck_id, 'kind': 'cloze', 'fields': {'Text': text, 'Extra': ''}})
    for _ in range(len(WORDS)):
        card = next_card(client, auth_headers_a, deck_id)
        quiz = card['quiz']
        if quiz['type'] == 'multiple_choice':
            assert len(quiz['options']) == 4
            assert not any('{{' in option for option in quiz['options'])
        client.post(f"/api/study/{card['card_id']}/review", headers=auth_headers_a, json={'rating': 3, 'quiz': {'response': 'x'}})


def test_rich_meaning_field_gives_clean_prompt_and_example():
    from types import SimpleNamespace
    from quiz import card_material, settings_for
    back = ('<b>ra khỏi giường; dậy</b><br><br><b>Cách dùng:</b> get up<br><b>Ví dụ:</b> I get up at six.<br>'
            '<i>Tôi dậy lúc sáu giờ.</i><br><b>Lưu ý:</b> get up khác wake up.')
    card = SimpleNamespace(note_link=None, front='get up', back=back)
    material = card_material(card, settings_for({}))
    assert material['word'] == 'get up'
    assert material['meaning'] == 'ra khỏi giường; dậy'
    assert material['example'] == 'I get up at six.'
    # Without a matching example sentence, labelled lines such as "Cách dùng:" are never used.
    card.back = back.replace('I get up at six.', 'My sister got up late.')
    assert card_material(card, settings_for({}))['example'] == ''


def test_number_fields_are_skipped_and_named_fields_win():
    from quiz import pick_fields, settings_for
    fields = {'№': '8', 'Keyword': 'cruel', 'Suggestion': 'c__ __l', 'Short Vietnamese': 'Độc ác',
              'Keyword_Sound': '[sound:cruel.mp3]', 'Explanation': 'The {{c1::cruel}} man yelled.'}
    assert pick_fields(fields, settings_for({})) == ('Keyword', 'Short Vietnamese', 'Explanation')
    assert pick_fields({'Số thứ tự': '1', 'Hanzi': '人', 'Meaning': 'người'}, settings_for({}))[:2] == ('Hanzi', 'Meaning')


def test_hint_never_reveals_a_short_answer(client, auth_headers_a):
    deck_id = make_deck(client, auth_headers_a, {'quiz_mode': True, 'quiz_copy_new_cards': False, 'quiz_types': ['typing']},
                        [('丿', 'phết'), ('人', 'người'), ('口', 'miệng'), ('apple', 'quả táo')])
    for _ in range(4):
        card = next_card(client, auth_headers_a, deck_id)
        quiz = card['quiz']
        if quiz['answer_length'] < 3:
            assert 'hint' not in quiz
        else:
            assert quiz['hint'] == 'a _ _ _ _'
        client.post(f"/api/study/{card['card_id']}/review", headers=auth_headers_a, json={'rating': 3, 'quiz': {'response': 'x'}})


def test_custom_study_uses_the_quiz_and_server_rating(client, auth_headers_a, db_session):
    deck_id = make_deck(client, auth_headers_a, {'quiz_mode': True, 'quiz_copy_new_cards': False, 'quiz_types': ['typing']})
    session = client.post('/api/filtered', headers=auth_headers_a,
                          json={'name': 'Before the test', 'search': '', 'reschedule': True}).json()
    sid = session['id']
    nxt = client.get(f'/api/filtered/{sid}/next', headers=auth_headers_a).json()
    card = nxt['card']
    assert card['quiz']['type'] == 'typing'  # same exercise as the normal study screen
    body = {'expected_session_version': nxt['session']['version'], 'card_id': card['card_id'],
            'expected_version': card['version'], 'rating': 4}
    # Self-rating is refused while the home deck is in student test mode.
    assert client.post(f'/api/filtered/{sid}/answer', headers=auth_headers_a, json=body).status_code == 400
    ok = client.post(f'/api/filtered/{sid}/answer', headers=auth_headers_a, json={**body, 'quiz': {'response': 'wrong'}})
    assert ok.status_code == 200, ok.text
    assert db_session.query(ReviewLog).filter_by(card_id=card['card_id']).one().rating == 1


def test_custom_study_without_quiz_mode_still_self_rates(client, auth_headers_a, db_session):
    make_deck(client, auth_headers_a, {'quiz_mode': False})
    session = client.post('/api/filtered', headers=auth_headers_a, json={'name': 'Plain', 'search': '', 'reschedule': True}).json()
    nxt = client.get(f"/api/filtered/{session['id']}/next", headers=auth_headers_a).json()
    assert nxt['card']['quiz'] is None
    res = client.post(f"/api/filtered/{session['id']}/answer", headers=auth_headers_a,
                      json={'expected_session_version': nxt['session']['version'], 'card_id': nxt['card']['card_id'],
                            'expected_version': nxt['card']['version'], 'rating': 4})
    assert res.status_code == 200, res.text
    assert db_session.query(ReviewLog).filter_by(card_id=nxt['card']['card_id']).one().rating == 4
