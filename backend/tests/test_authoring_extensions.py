import json
import pytest
from cloze import parse, render, typed
from note_rendering import render_template, text_only
from models import ReviewLog


def test_nested_cloze_render_and_typing():
    source = 'A {{c1::outer {{c2::inner::hint}} end::outer hint}} Z'
    assert parse(source)[1] == [0, 1]
    assert text_only(render(source, 0, False)) == 'A [outer hint] Z'
    assert text_only(render(source, 1, False)) == 'A outer [hint] end Z'
    assert text_only(render(source, 0, True)) == 'A outer inner end Z'
    assert typed(source, 0) == 'outer inner end'
    assert typed(source, 1) == 'inner'
    assert typed('{{c1::same}} {{c1::same}}', 0) == 'same'


@pytest.mark.parametrize('source', ['{{c0::bad}}', '{{c1001::bad}}', '{{c1::outer {{c2::unclosed}}', '{{c1::' * 21 + 'x' + '}}' * 21])
def test_bad_or_excessive_cloze_rejected(source):
    with pytest.raises(ValueError): parse(source)


def test_tts_filter_blocks_and_cloze_only():
    html = render_template('{{tts en_US speed=0.8:Front}}', {'Front': '<b>Hello</b> &amp; goodbye'})
    assert 'data-tts="Hello &amp; goodbye"' in html and 'data-tts-rate="0.8"' in html
    block = render_template('[anki:tts lang=vi_VN speed=1.2]{{Front}} {{Back}}[/anki:tts]', {'Front': 'Xin', 'Back': 'chào'})
    assert 'data-tts="Xin chào"' in block and 'data-tts-lang="vi-VN"' in block
    cloze = render_template('{{tts en_US:cloze-only:Text}}', {'Text': '{{c1::answer}} {{c2::other}}'})
    assert 'data-tts="answer"' in cloze
    for invalid in ['[anki:tts lang=en_US]unclosed', '[anki:tts speed=1]text[/anki:tts]', '{{tts en_US speed=nan:Front}}']:
        with pytest.raises(ValueError): render_template(invalid, {'Front': 'text'})


def test_rename_preserves_values_templates_ids_history_and_cas(client, auth_headers_a, auth_headers_b, db_session):
    headers = auth_headers_a
    definition = {'name': 'Rename test', 'fields': ['Q', 'A'], 'templates': [{'name': 'One', 'qfmt': '{{#Q}}{{text:Q}}{{/Q}}', 'afmt': '{{FrontSide}} {{A}}'}], 'css': ''}
    model = client.post('/api/models', headers=headers, json=definition).json()
    deck = client.post('/api/decks', headers=headers, json={'name': 'Rename'}).json()['id']
    note = client.post('/api/notes', headers=headers, json={'deck_id': deck, 'note_type_id': model['id'], 'fields': {'Q': 'Question', 'A': 'Answer'}}).json()
    cid = note['cards'][0]['id']
    assert client.post(f'/api/study/{cid}/review', headers=headers, json={'rating': 3}).status_code == 200
    body = {'old_name': 'Q', 'new_name': 'Prompt', 'expected_revision': model['revision']}
    url = f"/api/models/{model['id']}/rename-field"
    assert client.post(url, headers=auth_headers_b, json=body).status_code == 404
    result = client.post(url, headers=headers, json=body)
    assert result.status_code == 200, result.text
    assert result.json()['templates'][0]['qfmt'] == '{{#Prompt}}{{text:Prompt}}{{/Prompt}}'
    after = client.get(f"/api/notes/{note['id']}", headers=headers).json()
    assert after['fields'] == {'Prompt': 'Question', 'A': 'Answer'}
    assert after['cards'][0]['id'] == cid
    assert db_session.query(ReviewLog).filter_by(card_id=cid).count() == 1
    assert client.post(url, headers=headers, json=body).status_code == 409
