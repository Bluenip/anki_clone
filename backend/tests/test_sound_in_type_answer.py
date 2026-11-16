import re

from note_rendering import media_for_web


def test_sound_tags_inside_attributes_stay_untouched():
    html = '<span data-type-answer="Cháy nắng [sound:tts-1.wav]" data-type-options="type"></span> [sound:tts-1.wav]'
    out = media_for_web(html, 6)
    # The attribute keeps its text; only the visible [sound:] becomes a player.
    assert out.startswith('<span data-type-answer="Cháy nắng [sound:tts-1.wav]" data-type-options="type"></span> ')
    assert out.count('<audio') == 1 and out.endswith('controls></audio>')


def test_typed_answer_ignores_audio_in_the_answer_field(client, auth_headers_a):
    deck = client.post('/api/decks', headers=auth_headers_a, json={'name': 'Typed'}).json()
    created = client.post('/api/notes', headers=auth_headers_a, json={
        'deck_id': deck['id'], 'kind': 'typed', 'fields': {'Front': 'Sunburn', 'Back': 'Cháy nắng [sound:tts-abc.wav]'}})
    assert created.status_code == 201, created.text
    card = client.get(f"/api/study/{deck['id']}", headers=auth_headers_a).json()
    answer = re.search(r'data-type-answer="([^"]*)"', card['front'])[1]
    assert answer == 'Cháy nắng'
    # The answer side still plays the pronunciation, and no markup leaks into attributes.
    assert '<audio src="/api/media/' in card['back']
    assert not re.search(r'="[^"]*<audio', card['front'] + card['back'])
