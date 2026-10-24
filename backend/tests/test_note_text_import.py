import json
import pytest
from models import Card, Note, NoteType, StudyProgress


def deck(client, headers):
    return client.post('/api/decks', headers=headers, json={'name': 'Multifield'}).json()['id']


def test_preview_multifield_is_read_only(client, db_session, auth_headers_a):
    did = deck(client, auth_headers_a)
    data = {'kind': 'optional_reversed', 'text': 'Q,A,yes,tag1 tag2', 'separator': ',',
            'field_columns': {'Front': 0, 'Back': 1, 'Add Reverse': 2}, 'tags_column': 3, 'preview': True}
    response = client.post(f'/api/decks/{did}/import', headers=auth_headers_a, json=data)
    assert response.status_code == 200, response.text
    assert response.json()['added'] == 1
    assert db_session.query(NoteType).count() == db_session.query(Note).count() == 0
    data['preview'] = False
    assert client.post(f'/api/decks/{did}/import', headers=auth_headers_a, json=data).status_code == 200
    assert db_session.query(Card).count() == 2
    assert json.loads(db_session.query(Note).one().tags_json) == ['tag1', 'tag2']


@pytest.mark.parametrize('kind,text,count', [('cloze', '{{c1::one}} and {{c2::two}}\tExtra', 2),
                                           ('reversed', 'Q\tA', 2),
                                           ('optional_reversed', 'Q\tA\t', 1)])
def test_export_reimport_source_identity(client, db_session, auth_headers_a, kind, text, count):
    did = deck(client, auth_headers_a)
    url = f'/api/decks/{did}/import'
    response = client.post(url, headers=auth_headers_a, json={'kind': kind, 'text': text, 'tags': ['日本語']})
    assert response.status_code == 200, response.text
    note = db_session.query(Note).one()
    original = (note.guid, note.fields_json, note.tags_json)
    ids = [c.id for c in db_session.query(Card).all()]
    assert len(ids) == count
    exported = client.get(f'/api/decks/{did}/export/text?format=csv', headers=auth_headers_a)
    assert exported.status_code == 200, exported.text
    response = client.post(url, headers=auth_headers_a, json={'text': exported.text, 'duplicate_policy': 'update'})
    assert response.status_code == 200, response.text
    assert response.json()['updated'] == 1
    db_session.refresh(note)
    assert (note.guid, note.fields_json, note.tags_json) == original
    assert [c.id for c in db_session.query(Card).all()] == ids


def test_cloze_removal_preview_and_apply_atomic(client, db_session, auth_headers_a):
    did = deck(client, auth_headers_a)
    url = f'/api/decks/{did}/import'
    client.post(url, headers=auth_headers_a, json={'kind':'cloze', 'text':'{{c1::one}} {{c2::two}}\tExtra'})
    note = db_session.query(Note).one()
    studied = next(link.card for link in note.card_links if link.template_ord == 1)
    db_session.add(StudyProgress(user_id=note.user_id, card_id=studied.id, interval_days=17, card_state='review'))
    db_session.commit()
    text = f'{{{{c1::one}}}}\tChanged\t{note.guid}'
    for preview in (True, False):
        response = client.post(url, headers=auth_headers_a, json={'kind':'cloze','text':text,'guid_column':2,
                                      'duplicate_policy':'update','preview':preview})
        assert response.status_code == 400, response.text
        assert db_session.query(Card).count() == 2
        db_session.refresh(note)
        assert json.loads(note.fields_json)[1] == 'Extra'


@pytest.mark.parametrize('extra', [
    {'field_columns': {'Text': 0, 'Extra': 0}},
    {'field_columns': {'Text': 0, 'Extra': 2}},
    {'tags': ['bad tag']},
    {'text':'{{c1::ok}}\tExtra\nunclosed'},
    {'text':'{{c1::ok}}\tExtra\tunknown'},
])
def test_invalid_multifield_batch_no_writes(client, db_session, auth_headers_a, extra):
    did = deck(client, auth_headers_a)
    response = client.post(f'/api/decks/{did}/import', headers=auth_headers_a,
                           json={'kind':'cloze','text':'{{c1::ok}}\tExtra', **extra})
    assert response.status_code == 400, response.text
    assert db_session.query(Note).count() == db_session.query(Card).count() == 0


def test_custom_type_roundtrip_and_ownership(client, db_session, auth_headers_a, auth_headers_b, user_a, user_b):
    did = deck(client, auth_headers_a)
    model = NoteType(user_id=user_a.id, name='Vocabulary custom', fields_json=json.dumps(['Word','Meaning','Example']),
                     templates_json=json.dumps([{'name':'Word', 'qfmt':'{{Word}}', 'afmt':'{{Meaning}}<hr>{{Example}}'}]), css='')
    foreign = NoteType(user_id=user_b.id, name='Secret', fields_json='["Secret"]', templates_json='[]', css='')
    db_session.add_all([model, foreign]); db_session.commit()
    available = client.get('/api/note-types/available', headers=auth_headers_a).json()
    assert [item['id'] for item in available] == [model.id]
    url = f'/api/decks/{did}/import'
    response = client.post(url, headers=auth_headers_a, json={'note_type_id':foreign.id,'text':'secret'})
    assert response.status_code == 400
    data = {'note_type_id':model.id, 'text':'word,meaning,example', 'separator':','}
    response = client.post(url, headers=auth_headers_a, json=data)
    assert response.status_code == 200, response.text
    note = db_session.query(Note).one()
    guid = note.guid
    exported = client.get(f'/api/decks/{did}/export/text', headers=auth_headers_a)
    assert exported.status_code == 200, exported.text
    response = client.post(url, headers=auth_headers_a, json={'text':exported.text,'duplicate_policy':'update'})
    assert response.status_code == 200, response.text
    assert db_session.query(Note).count() == 1
    db_session.refresh(note)
    assert note.guid == guid
    assert json.loads(note.fields_json) == ['word','meaning','example']


@pytest.mark.parametrize('kind,text,count', [('cloze', '{{c1::one}} {{c2::two}}\tExtra',2),
                                           ('reversed', 'Q\tA',2),
                                           ('basic', 'Q\tA',1)])
def test_text_export_consumed_by_native_anki(client, auth_headers_a, tmp_path, kind, text, count):
    from anki.collection import Collection
    from anki.import_export_pb2 import ImportCsvRequest
    did = deck(client, auth_headers_a)
    response = client.post(f'/api/decks/{did}/import', headers=auth_headers_a,
                           json={'kind':kind,'text':text,'tags':['vi','tag::nested']})
    assert response.status_code == 200, response.text
    exported = client.get(f'/api/decks/{did}/export/text?format=csv', headers=auth_headers_a)
    assert exported.status_code == 200, exported.text
    path = tmp_path/'notes.csv'; path.write_text(exported.text, encoding='utf-8')
    collection = Collection(str(tmp_path/'text-native.anki2'))
    try:
        metadata = collection.get_csv_metadata(str(path), None)
        collection.import_csv(ImportCsvRequest(path=str(path), metadata=metadata))
        assert collection.note_count() == 1
        assert collection.card_count() == count
        note = collection.get_note(collection.find_notes('')[0])
        assert list(note.fields) == text.split('\t')
        assert set(note.tags) == {'vi','tag::nested'}
    finally:
        collection.close()


def test_basic_empty_answer_and_tag_directives(client, db_session, auth_headers_a):
    did = deck(client, auth_headers_a)
    response = client.post(f'/api/decks/{did}/import', headers=auth_headers_a,
                           json={'text':'#tags:global\n#tags column:3\nQuestion\t\tlocal'})
    assert response.status_code == 200, response.text
    note = db_session.query(Note).one()
    assert json.loads(note.fields_json) == ['Question', '']
    assert json.loads(note.tags_json) == ['global', 'local']


@pytest.mark.parametrize('explicit_mapping', [False, True])
def test_native_anki_text_import_with_mapping(client, db_session, auth_headers_a, tmp_path, explicit_mapping):
    from anki.collection import Collection
    collection = Collection(str(tmp_path/'native-export.anki2'))
    path = tmp_path/'native.txt'
    try:
        note = collection.new_note(collection.models.by_name('Cloze'))
        note.fields = ['{{c1::Hà Nội}} và {{c2::Huế}}', 'Back extra']
        note.tags = ['vi']
        collection.add_note(note, 1)
        guid = note.guid
        collection.export_note_csv(out_path=str(path), limit=None, with_html=True, with_tags=True,
                                   with_deck=False, with_notetype=False, with_guid=True)
    finally:
        collection.close()
    did = deck(client, auth_headers_a)
    data = {'kind':'cloze', 'text':path.read_text()}
    if explicit_mapping:
        data['field_columns'] = {'Text':1,'Extra':2}
    response = client.post(f'/api/decks/{did}/import', headers=auth_headers_a, json=data)
    assert response.status_code == 200, response.text
    actual = db_session.query(Note).one()
    assert actual.guid == guid
    assert json.loads(actual.fields_json) == ['{{c1::Hà Nội}} và {{c2::Huế}}', 'Back extra']
    assert json.loads(actual.tags_json) == ['vi']
    assert len(actual.card_links) == 2


def test_advanced_import_updates_legacy_card_without_preview_backfill(client, db_session, auth_headers_a, user_a):
    from notes import legacy_guid
    did = deck(client, auth_headers_a)
    card = Card(deck_id=did, front='Old', back='Answer')
    db_session.add(card); db_session.commit()
    guid = legacy_guid(card, user_a.id)
    data = {'kind':'basic', 'text':f'New\tAnswer\t{guid}', 'guid_column':2,
            'duplicate_policy':'update', 'preview':True}
    response = client.post(f'/api/decks/{did}/import', headers=auth_headers_a, json=data)
    assert response.status_code == 200, response.text
    assert response.json()['updated'] == 1
    assert db_session.query(Note).count() == db_session.query(NoteType).count() == 0
    data['preview'] = False
    response = client.post(f'/api/decks/{did}/import', headers=auth_headers_a, json=data)
    assert response.status_code == 200, response.text
    db_session.refresh(card)
    assert card.front == 'New'
    assert card.note_link.note.guid == guid
    assert db_session.query(Card).count() == 1
