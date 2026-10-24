import json
from models import Note


def test_edit_renders_each_sibling_in_its_home_deck(client,auth_headers_a,db_session):
    first=client.post('/api/decks',headers=auth_headers_a,json={'name':'First home'}).json()['id']
    second=client.post('/api/decks',headers=auth_headers_a,json={'name':'Second home'}).json()['id']
    note=client.post('/api/notes',headers=auth_headers_a,json={'deck_id':first,'kind':'reversed','fields':{'Front':'Q','Back':'A'}}).json()
    model=db_session.get(Note,note['id']).note_type
    templates=json.loads(model.templates_json)
    for template in templates:
        template['qfmt']+=' @{{Deck}}'
        template['afmt']+=' @{{Deck}}'
    model.templates_json=json.dumps(templates);db_session.commit()
    moved=client.post('/api/cards/bulk-action',headers=auth_headers_a,json={'action':'move','target_deck_id':second,
        'cards':[{'card_id':note['cards'][1]['id'],'expected_version':0}]})
    assert moved.status_code==200,moved.text
    loaded=client.get(f"/api/notes/{note['id']}",headers=auth_headers_a).json()
    edited=client.put(f"/api/notes/{note['id']}",headers=auth_headers_a,json={'fields':{'Front':'Changed','Back':'Answer'},'tags':[],
        'expected_revision':loaded['revision']})
    assert edited.status_code==200,edited.text
    cards=edited.json()['cards']
    assert 'First home' in cards[0]['front'] and 'First home' in cards[0]['back']
    assert 'Second home' in cards[1]['front'] and 'Second home' in cards[1]['back']
    assert [c['id'] for c in cards]==[c['id'] for c in note['cards']]
