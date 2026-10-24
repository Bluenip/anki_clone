import io
import json
import sqlite3
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
import pytest
from models import Card, Deck, Note, NoteType, StudyProgress, ReviewLog
from anki.collection import Collection
from anki.import_export_pb2 import ImportAnkiPackageRequest
from media_utils import get_media_dir, cleanup_orphaned_media


@pytest.mark.parametrize('modern',[False,True])
@pytest.mark.parametrize('kind,fields,expected',[
    ('reversed',{'Front':'Q','Back':'A'},2),
    ('cloze',{'Text':'{{c1::Hà Nội}} và {{c2::Huế}}','Extra':'<b>Extra</b>'},2),
])
def test_real_anki_and_web_roundtrip(client,auth_headers_a,auth_headers_b,db_session,tmp_path,modern,kind,fields,expected):
    did=client.post('/api/decks',headers=auth_headers_a,json={'name':'Parent::Child'}).json()['id']
    response=client.post('/api/notes',headers=auth_headers_a,json={'deck_id':did,'kind':kind,'fields':fields,'tags':['vi','topic::test']})
    assert response.status_code==201,response.text
    original=response.json()
    exported=client.get(f'/api/apkg/export/{did}?modern={str(modern).lower()}',headers=auth_headers_a)
    assert exported.status_code==200,exported.text[:500]
    package=tmp_path/'roundtrip.apkg';package.write_bytes(exported.content)
    # Use the pinned upstream backend as an independent consumer of the writer.
    collection=Collection(str(tmp_path/'actual-anki.anki2'))
    try:
        collection.import_anki_package(ImportAnkiPackageRequest(package_path=str(package)))
        assert collection.card_count()==expected
        assert collection.note_count()==1
        nid=collection.find_notes('')[0]
        actual=collection.get_note(nid)
        assert actual.guid==original['guid']
        assert list(actual.fields)==list(fields.values())
        assert set(actual.tags)=={'vi','topic::test'}
        actual_card = collection.get_card(collection.find_cards('')[0])
        assert collection.decks.name(actual_card.did) == 'Parent::Child'
    finally:collection.close()
    imported=client.post('/api/apkg/import',headers=auth_headers_b,files={'file':('roundtrip.apkg',exported.content,'application/octet-stream')})
    assert imported.status_code==200,imported.text
    assert imported.json()['cards_imported']==expected
    target=client.get(f"/api/decks/{imported.json()['deck_id']}/cards",headers=auth_headers_b).json()
    note=client.get(f"/api/cards/{target[0]['id']}/note",headers=auth_headers_b).json()
    assert note['guid']==original['guid']
    assert note['fields']==fields
    assert set(note['tags'])=={'vi','topic::test'}
    count=db_session.query(Card).count()
    again=client.post('/api/apkg/import',headers=auth_headers_b,files={'file':('roundtrip.apkg',exported.content,'application/octet-stream')})
    assert again.status_code==200,again.text
    assert again.json()['cards_imported']==0
    assert db_session.query(Card).count()==count


@pytest.mark.parametrize('modern', [False, True])
def test_media_roundtrip_keeps_unicode_bytes_and_css_font(client, auth_headers_a, auth_headers_b, db_session, user_a, tmp_path, modern):
    media = Path(get_media_dir(user_a.id))
    media.mkdir(parents=True, exist_ok=True)
    files = {'ảnh.png': b'\x89PNG\r\n\x1a\nfixture', 'a&b.png': b'\x89PNGfixture', 'voice.mp3': b'ID3fixture', '_font.woff2': b'wOF2fixture'}
    for name, data in files.items():
        (media/name).write_bytes(data)
    did = client.post('/api/decks', headers=auth_headers_a, json={'name': 'Media'}).json()['id']
    fields = {'Front': '<img src="ảnh.png"><img src="a&amp;b.png">[sound:voice.mp3]', 'Back': 'answer'}
    created = client.post('/api/notes', headers=auth_headers_a, json={'deck_id': did, 'kind': 'basic', 'fields': fields}).json()
    model = db_session.get(Note, created['id']).note_type
    model.css = '@font-face {font-family: local; src: url("_font.woff2")} .card {font-family: local}'
    db_session.commit()
    cleanup_orphaned_media(user_a.id, db_session)
    assert all((media/name).read_bytes() == data for name, data in files.items())
    exported = client.get(f'/api/apkg/export/{did}?modern={str(modern).lower()}', headers=auth_headers_a)
    assert exported.status_code == 200, exported.text[:500]
    response = client.post('/api/apkg/import', headers=auth_headers_b, files={'file': ('media.apkg', exported.content)})
    assert response.status_code == 200, response.text
    imported_user_id = db_session.get(Deck, response.json()['deck_id']).user_id
    imported_media = Path(get_media_dir(imported_user_id))
    for name, data in files.items():
        assert (imported_media/name).read_bytes() == data
    imported_cards = client.get(f"/api/decks/{response.json()['deck_id']}/cards", headers=auth_headers_b).json()
    note = client.get(f"/api/cards/{imported_cards[0]['id']}/note", headers=auth_headers_b).json()
    assert note['fields'] == fields
    assert '_font.woff2' in note['css']


def test_collection_package_restores_all_decks_only_into_empty_account(client, auth_headers_a, auth_headers_b, db_session):
    client.post('/api/decks', headers=auth_headers_a, json={'name':'Empty deck'})
    from note_service import builtin_model
    uid = db_session.query(Deck).filter_by(name='Empty deck').one().user_id
    builtin_model(db_session, uid, 'optional_reversed')
    db_session.commit()
    for name in ('Languages::Vietnamese', 'Separate'):
        did = client.post('/api/decks', headers=auth_headers_a, json={'name': name}).json()['id']
        note = client.post('/api/notes', headers=auth_headers_a, json={'deck_id': did, 'kind': 'basic',
                           'fields': {'Front': name, 'Back': 'Answer'}}).json()
        rated = client.post(f"/api/study/{note['cards'][0]['id']}/review", headers=auth_headers_a, json={'rating': 4, 'duration_ms': 1500})
        assert rated.status_code == 200, rated.text
    exported = client.get('/api/apkg/export-collection', headers=auth_headers_a)
    assert exported.status_code == 200, exported.text[:500]
    assert 'collection.colpkg' in exported.headers['content-disposition']
    files = {'file': ('collection.colpkg', exported.content)}
    assert client.post('/api/apkg/import', headers=auth_headers_b, files=files).status_code == 400
    imported = client.post('/api/apkg/import?collection_restore=true', headers=auth_headers_b, files=files)
    assert imported.status_code == 200, imported.text
    assert imported.json()['collection_restore']
    assert imported.json()['cards_imported'] == 2
    decks = client.get('/api/decks', headers=auth_headers_b).json()
    assert {'Languages::Vietnamese', 'Separate', 'Empty deck'} <= {d['name'] for d in decks}
    assert next(d for d in decks if d['name']=='Empty deck')['total_cards']==0
    assert db_session.query(Card).join(Deck).filter(Deck.user_id!=uid).count()==2
    assert db_session.query(NoteType).filter(NoteType.user_id!=uid, NoteType.name=='Basic (optional reversed card)').count()==1
    rejected = client.post('/api/apkg/import?collection_restore=true', headers=auth_headers_b, files=files)
    assert rejected.status_code == 409
    assert db_session.query(StudyProgress).count() == 4


@pytest.mark.parametrize('modern', [False, True])
def test_scheduling_and_real_duration_survive_package_exchange(client, auth_headers_a, auth_headers_b, db_session, modern):
    did = client.post('/api/decks', headers=auth_headers_a, json={'name': 'Scheduled'}).json()['id']
    note = client.post('/api/notes', headers=auth_headers_a, json={'deck_id': did, 'kind': 'basic', 'fields': {'Front': 'Q', 'Back': 'A'}}).json()
    cid = note['cards'][0]['id']
    client.post(f'/api/study/{cid}/review', headers=auth_headers_a, json={'rating': 4, 'duration_ms': 2718})
    before = db_session.query(StudyProgress).filter_by(card_id=cid).one()
    due = before.next_review
    exported = client.get(f'/api/apkg/export/{did}?include_scheduling=true&modern={str(modern).lower()}', headers=auth_headers_a)
    assert exported.status_code == 200
    imported = client.post('/api/apkg/import?include_scheduling=true', headers=auth_headers_b, files={'file': ('schedule.apkg', exported.content)})
    assert imported.status_code == 200, imported.text
    target_card = db_session.query(Card).filter_by(deck_id=imported.json()['deck_id']).one()
    target = db_session.query(StudyProgress).filter_by(card_id=target_card.id).one()
    assert target.interval_days == before.interval_days
    assert target.repetitions == before.repetitions
    assert target.next_review.date() == due.date()
    record = db_session.query(ReviewLog).filter_by(card_id=target_card.id).one().record
    assert json.loads(record.payload)['duration_ms'] == 2718


def test_modern_package_preserves_fsrs_memory_in_real_anki_and_web(client, auth_headers_a, auth_headers_b, db_session, tmp_path):
    from anki.import_export_pb2 import ImportAnkiPackageOptions
    did = client.post('/api/decks', headers=auth_headers_a, json={'name':'Memory'}).json()['id']
    client.put(f'/api/decks/{did}', headers=auth_headers_a, json={'settings':json.dumps({'fsrs':True})})
    note = client.post('/api/notes', headers=auth_headers_a, json={'deck_id':did,'kind':'basic','fields':{'Front':'Q','Back':'A'}}).json()
    cid = note['cards'][0]['id']
    result = client.post(f'/api/study/{cid}/review', headers=auth_headers_a, json={'rating':4})
    assert result.status_code == 200, result.text
    memory = json.loads(db_session.get(Card,cid).scheduling.fsrs_json)['card']
    response = client.get(f'/api/apkg/export/{did}?modern=true&include_scheduling=true',headers=auth_headers_a)
    assert response.status_code == 200, response.text
    package=tmp_path/'memory.apkg';package.write_bytes(response.content)
    collection=Collection(str(tmp_path/'memory.anki2'))
    try:
        collection.import_anki_package(ImportAnkiPackageRequest(package_path=str(package),options=ImportAnkiPackageOptions(with_scheduling=True)))
        actual=collection.get_card(collection.find_cards('')[0])
        assert actual.memory_state is not None
        assert actual.memory_state.stability == pytest.approx(memory['stability'],rel=1e-6)
        assert actual.memory_state.difficulty == pytest.approx(memory['difficulty'],rel=1e-6)
    finally:collection.close()
    imported=client.post('/api/apkg/import?include_scheduling=true',headers=auth_headers_b,files={'file':('memory.apkg',response.content)})
    assert imported.status_code == 200, imported.text
    target=db_session.query(Card).filter_by(deck_id=imported.json()['deck_id']).one()
    assert target.scheduling is not None
    state=json.loads(target.scheduling.fsrs_json)['card']
    assert state['stability'] == pytest.approx(memory['stability'],rel=1e-6)
    assert state['difficulty'] == pytest.approx(memory['difficulty'],rel=1e-6)


def test_collection_with_only_empty_deck_roundtrips(client, auth_headers_a, auth_headers_b):
    client.post('/api/decks', headers=auth_headers_a, json={'name':'No cards yet'})
    response=client.get('/api/apkg/export-collection',headers=auth_headers_a)
    assert response.status_code==200,response.text
    imported=client.post('/api/apkg/import?collection_restore=true',headers=auth_headers_b,files={'file':('empty.colpkg',response.content)})
    assert imported.status_code==200,imported.text
    decks=client.get('/api/decks',headers=auth_headers_b).json()
    assert any(d['name']=='No cards yet' and d['total_cards']==0 for d in decks)


def test_package_cannot_change_media_owned_by_existing_note(client,auth_headers_a,auth_headers_b,user_a,user_b,tmp_path):
    for headers,user,data in [(auth_headers_a,user_a,b'NEW'),(auth_headers_b,user_b,b'ORIGINAL')]:
        root=Path(get_media_dir(user.id));root.mkdir(parents=True,exist_ok=True)
        (root/'collision.png').write_bytes(data)
        did=client.post('/api/decks',headers=headers,json={'name':f'Media {user.id}'}).json()['id']
        client.post('/api/notes',headers=headers,json={'deck_id':did,'kind':'basic','fields':{'Front':'<img src="collision.png">','Back':'A'}})
        if user.id==user_a.id:source=did
    package=client.get(f'/api/apkg/export/{source}',headers=auth_headers_a)
    response=client.post('/api/apkg/import',headers=auth_headers_b,files={'file':('conflict.apkg',package.content)})
    assert response.status_code==400,response.text
    assert 'conflicts' in response.json()['detail']
    assert (Path(get_media_dir(user_b.id))/'collision.png').read_bytes()==b'ORIGINAL'
    assert len(client.get('/api/decks',headers=auth_headers_b).json())==1


@pytest.mark.parametrize('modern',[False,True])
def test_suspended_review_does_not_export_epoch_as_day_offset(client,auth_headers_a,auth_headers_b,db_session,modern):
    did=client.post('/api/decks',headers=auth_headers_a,json={'name':'Suspended'}).json()['id']
    note=client.post('/api/notes',headers=auth_headers_a,json={'deck_id':did,'kind':'basic','fields':{'Front':'Q','Back':'A'}}).json()
    cid=note['cards'][0]['id']
    client.post(f'/api/study/{cid}/review',headers=auth_headers_a,json={'rating':4})
    client.post(f'/api/study/{cid}/action',headers=auth_headers_a,json={'action':'suspend'})
    original=db_session.query(StudyProgress).filter_by(card_id=cid).one()
    exported=client.get(f'/api/apkg/export/{did}?modern={str(modern).lower()}&include_scheduling=true',headers=auth_headers_a)
    assert exported.status_code==200,exported.text[:500]
    imported=client.post('/api/apkg/import?include_scheduling=true',headers=auth_headers_b,files={'file':('suspended.apkg',exported.content)})
    assert imported.status_code==200,imported.text
    target=db_session.query(StudyProgress).join(Card).filter(Card.deck_id==imported.json()['deck_id']).one()
    assert target.is_suspended
    assert target.next_review.date()==original.next_review.date()
    assert target.interval_days==original.interval_days
