import json
from models import Card, Deck, Note, ReviewLog, ReviewRecord, StudyProgress


def test_create_child_builds_parents_and_rename_preserves_identity(client,auth_headers_a,db_session):
    created=client.post('/api/decks',headers=auth_headers_a,json={'name':'Root::Child::Leaf'})
    assert created.status_code==201,created.text
    leaf=created.json()['id']
    decks=client.get('/api/decks',headers=auth_headers_a).json()
    names={d['name']:d['id'] for d in decks}
    assert set(names)=={'Root','Root::Child','Root::Child::Leaf'}
    note=client.post('/api/notes',headers=auth_headers_a,json={'deck_id':leaf,'kind':'basic','fields':{'Front':'Q','Back':'A'}}).json()
    cid=note['cards'][0]['id']
    client.post(f'/api/study/{cid}/review',headers=auth_headers_a,json={'rating':4})
    progress=db_session.query(StudyProgress).one()
    due=progress.next_review
    response=client.put(f"/api/decks/{names['Root']}",headers=auth_headers_a,json={'name':'Renamed'})
    assert response.status_code==200,response.text
    assert db_session.get(Deck,leaf).name=='Renamed::Child::Leaf'
    assert db_session.get(Card,cid).deck_id==leaf
    db_session.refresh(progress)
    assert progress.next_review==due
    assert client.get(f"/api/notes/{note['id']}",headers=auth_headers_a).json()['guid']==note['guid']


def test_delete_parent_cleans_descendant_metadata_but_keeps_other_user(client,auth_headers_a,auth_headers_b,db_session):
    child=client.post('/api/decks',headers=auth_headers_a,json={'name':'Delete::Child'}).json()['id']
    parent=next(d['id'] for d in client.get('/api/decks',headers=auth_headers_a).json() if d['name']=='Delete')
    note=client.post('/api/notes',headers=auth_headers_a,json={'deck_id':child,'kind':'reversed','fields':{'Front':'Q','Back':'A'}}).json()
    client.post(f"/api/study/{note['cards'][0]['id']}/review",headers=auth_headers_a,json={'rating':4})
    other=client.post('/api/decks',headers=auth_headers_b,json={'name':'Delete::Child'}).json()['id']
    response=client.delete(f'/api/decks/{parent}',headers=auth_headers_a)
    assert response.status_code==204,response.text
    assert db_session.get(Deck,other) is not None
    for model in (Card,Note,ReviewLog,ReviewRecord,StudyProgress):assert db_session.query(model).count()==0


def test_rename_collision_and_self_move_are_atomic(client,auth_headers_a,db_session):
    a=client.post('/api/decks',headers=auth_headers_a,json={'name':'A::Child'}).json()['id']
    b=client.post('/api/decks',headers=auth_headers_a,json={'name':'B::Child'}).json()['id']
    root=next(d['id'] for d in client.get('/api/decks',headers=auth_headers_a).json() if d['name']=='A')
    assert client.put(f'/api/decks/{root}',headers=auth_headers_a,json={'name':'B'}).status_code==409
    assert client.put(f'/api/decks/{root}',headers=auth_headers_a,json={'name':'A::Child::Nested'}).status_code==400
    assert db_session.get(Deck,a).name=='A::Child'
    assert db_session.get(Deck,b).name=='B::Child'


def test_template_deck_context_tracks_rename_without_overwriting_note(client,auth_headers_a,db_session):
    did=client.post('/api/decks',headers=auth_headers_a,json={'name':'Before'}).json()['id']
    note=client.post('/api/notes',headers=auth_headers_a,json={'deck_id':did,'kind':'basic','fields':{'Front':'Q','Back':'A'}}).json()
    stored=db_session.get(Note,note['id'])
    templates=json.loads(stored.note_type.templates_json)
    templates[0]['qfmt']='{{Deck}} / {{Front}}'
    stored.note_type.templates_json=json.dumps(templates)
    db_session.commit()
    client.put(f'/api/decks/{did}',headers=auth_headers_a,json={'name':'After'})
    card=client.get(f'/api/study/{did}',headers=auth_headers_a).json()
    assert card['front']=='After / Q'
    assert json.loads(stored.fields_json)==['Q','A']
