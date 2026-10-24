import json
import pytest
from models import Card, Deck, Note, NoteType


def make_deck(client, headers, name='Selected'):
    return client.post('/api/decks', headers=headers, json={'name': name}).json()['id']


SOURCE = '#separator:tab\n#html:true\n#guid column:1\n#notetype column:2\n#deck column:3\n#tags column:6\nabc123\tBasic\tLanguage::Basic\tQuestion\tAnswer\tvi\ndef456\tCloze\tLanguage::Cloze\t{{c1::one}} {{c2::two}}\tExtra\tcloze\n'


def test_mixed_preview_and_atomic_confirm(client, db_session, auth_headers_a):
    did = make_deck(client, auth_headers_a)
    url = f'/api/decks/{did}/import'
    response = client.post(url, headers=auth_headers_a, json={'text':SOURCE, 'preview':True})
    assert response.status_code == 400
    assert 'Use deck names' in response.text
    data = {'text':SOURCE,'preview':True,'use_file_decks':True}
    response = client.post(url, headers=auth_headers_a, json=data)
    assert response.status_code == 200, response.text
    assert response.json()['added'] == 2
    assert response.json()['new_decks'] == ['Language','Language::Basic','Language::Cloze']
    assert db_session.query(Deck).count() == 1
    assert db_session.query(Note).count() == db_session.query(NoteType).count() == 0
    data['preview'] = False
    response = client.post(url, headers=auth_headers_a, json=data)
    assert response.status_code == 200, response.text
    assert db_session.query(Note).count() == 2
    assert db_session.query(Card).count() == 3
    assert {deck.name for deck in db_session.query(Deck).all()} == {'Selected','Language','Language::Basic','Language::Cloze'}
    before = sorted(card.id for card in db_session.query(Card).all())
    data['duplicate_policy'] = 'update'
    response = client.post(url, headers=auth_headers_a, json=data)
    assert response.status_code == 200, response.text
    assert response.json()['updated'] == 2
    assert sorted(card.id for card in db_session.query(Card).all()) == before


@pytest.mark.parametrize('source', [
    SOURCE.replace('Cloze\tLanguage::Cloze', 'Unknown\tLanguage::Cloze'),
    SOURCE.replace('def456', 'abc123'),
    SOURCE.replace('{{c1::one}} {{c2::two}}', 'no deletion'),
    SOURCE.replace('#tags column:6', '#tags column:2'),
    SOURCE.replace('Extra\tcloze', 'Extra\tcloze\tDATA'),
    SOURCE.replace('Language::Cloze', 'Language::::Cloze'),
])
def test_invalid_mixed_batch_no_metadata_or_decks(client, db_session, auth_headers_a, source):
    did = make_deck(client, auth_headers_a)
    response = client.post(f'/api/decks/{did}/import', headers=auth_headers_a,
                           json={'text':source,'use_file_decks':True})
    assert response.status_code == 400, response.text
    assert db_session.query(Deck).count() == 1
    assert db_session.query(Note).count() == db_session.query(Card).count() == db_session.query(NoteType).count() == 0


def test_mixed_types_padding_and_hash_source(client, db_session, auth_headers_a):
    did = make_deck(client, auth_headers_a)
    source = '#separator:Comma\n#notetype column:1\nBasic,#Question,Answer,\nBasic (optional reversed card),Q,A,yes\n'
    response = client.post(f'/api/decks/{did}/import', headers=auth_headers_a, json={'text':source})
    assert response.status_code == 200, response.text
    assert response.json()['added'] == 2
    assert db_session.query(Card).count() == 3
    assert any(json.loads(note.fields_json)[0] == '#Question' for note in db_session.query(Note).all())


def test_per_row_type_cannot_override_explicit_mapping(client, db_session, auth_headers_a):
    did = make_deck(client, auth_headers_a)
    response = client.post(f'/api/decks/{did}/import', headers=auth_headers_a,
                           json={'kind':'basic','text':SOURCE,'use_file_decks':True})
    assert response.status_code == 400
    assert 'Disable advanced mapping' in response.text


def test_global_deck_and_notetype(client, db_session, auth_headers_a):
    did = make_deck(client, auth_headers_a)
    source = '#deck:New::Child\n#notetype:Cloze\n{{c1::text}}\tExtra\n'
    response = client.post(f'/api/decks/{did}/import', headers=auth_headers_a,
                           json={'text':source,'use_file_decks':True})
    assert response.status_code == 200, response.text
    card = db_session.query(Card).one()
    assert card.deck.name == 'New::Child'


@pytest.mark.parametrize('include_guid', [False, True])
def test_mixed_tree_export_native_anki_and_web(client, db_session, auth_headers_a, auth_headers_b, tmp_path, include_guid):
    from anki.collection import Collection
    from anki.import_export_pb2 import ImportCsvRequest
    did = make_deck(client, auth_headers_a)
    response = client.post(f'/api/decks/{did}/import', headers=auth_headers_a, json={'text':SOURCE,'use_file_decks':True})
    assert response.status_code == 200, response.text
    root = db_session.query(Deck).filter_by(name='Language').one()
    exported = client.get(f'/api/decks/{root.id}/export/text?format=csv&include_guid={str(include_guid).lower()}', headers=auth_headers_a)
    assert exported.status_code == 200, exported.text
    path = tmp_path/'mixed.csv'; path.write_text(exported.text, encoding='utf-8')
    collection = Collection(str(tmp_path/'mixed-native.anki2'))
    try:
        metadata = collection.get_csv_metadata(str(path), None)
        collection.import_csv(ImportCsvRequest(path=str(path),metadata=metadata))
        assert collection.note_count() == 2
        assert collection.card_count() == 3
        actual = {tuple(collection.get_note(nid).fields) for nid in collection.find_notes('')}
        assert actual == {('Question','Answer'),('{{c1::one}} {{c2::two}}','Extra')}
        assert {collection.decks.name(collection.get_card(cid).did) for cid in collection.find_cards('')} == {'Language::Basic','Language::Cloze'}
    finally:
        collection.close()
    target = make_deck(client, auth_headers_b, 'Target')
    response = client.post(f'/api/decks/{target}/import', headers=auth_headers_b,
                           json={'text':exported.text,'use_file_decks':True})
    assert response.status_code == 200, response.text
    assert response.json()['added'] == 2
    assert db_session.query(Card).count() == 6


def test_runtime_failure_rolls_back_all_groups_and_decks(client, db_session, auth_headers_a, monkeypatch):
    import mixed_text_import
    did = make_deck(client, auth_headers_a)
    original = mixed_text_import.import_notes_text
    count = 0
    def fail_second_apply(db, target, data, **kwargs):
        nonlocal count
        if not data.preview:
            count += 1
            if count == 2:
                raise ValueError('Injected failure after first group was written')
        return original(db,target,data,**kwargs)
    monkeypatch.setattr(mixed_text_import,'import_notes_text',fail_second_apply)
    response = client.post(f'/api/decks/{did}/import', headers=auth_headers_a,
                           json={'text':SOURCE,'use_file_decks':True})
    assert response.status_code == 400, response.text
    assert count == 2
    assert db_session.query(Deck).count() == 1
    assert db_session.query(Note).count() == db_session.query(Card).count() == db_session.query(NoteType).count() == 0


def test_native_anki_mixed_export_import(client, db_session, auth_headers_a, tmp_path):
    from anki.collection import Collection
    collection = Collection(str(tmp_path/'native-mixed.anki2'))
    path = tmp_path/'notes.txt'
    try:
        for name, fields in [('Basic',['Q','A']),('Cloze',['{{c1::one}} {{c2::two}}','Extra']),
                             ('Basic (optional reversed card)',['Q2','A2','yes'])]:
            note = collection.new_note(collection.models.by_name(name));note.fields = fields;note.tags = ['native']
            collection.add_note(note,1)
        collection.export_note_csv(out_path=str(path),limit=None,with_html=True,with_tags=True,with_deck=True,with_notetype=True,with_guid=True)
    finally:
        collection.close()
    did = make_deck(client, auth_headers_a)
    response = client.post(f'/api/decks/{did}/import', headers=auth_headers_a,
                           json={'text':path.read_text(), 'use_file_decks':True})
    assert response.status_code == 200, response.text
    assert response.json()['added'] == 3
    assert db_session.query(Card).count() == 5
    assert {tuple(json.loads(note.fields_json)) for note in db_session.query(Note).all()} == {('Q','A'),('{{c1::one}} {{c2::two}}','Extra'),('Q2','A2','yes')}


def test_existing_imported_stock_name_uses_original_templates(client, db_session, auth_headers_a, user_a):
    did = make_deck(client, auth_headers_a)
    model = NoteType(user_id=user_a.id, name='Basic', fields_json='["Front", "Back"]',
                     templates_json=json.dumps([{'name':'Imported','qfmt':'<b>{{Front}}</b>','afmt':'{{Back}}'}]),css='')
    db_session.add(model); db_session.commit()
    response = client.post(f'/api/decks/{did}/import', headers=auth_headers_a,
                           json={'text':'#notetype:Basic\nQuestion\tAnswer'})
    assert response.status_code == 200, response.text
    assert db_session.query(Note).one().note_type_id == model.id
    assert db_session.query(Card).one().front == '<b>Question</b>'


def test_hash_prefixed_legacy_field_roundtrip():
    from text_transfer import export_text, parse_text
    text = export_text([('#notetype:Cloze','Answer','guid123')])
    parsed = parse_text(text)
    assert len(parsed) == 1
    assert parsed[0].front == '#notetype:Cloze'


def test_export_scope_subdecks_and_literal_sql_wildcards(client, db_session, auth_headers_a):
    root = make_deck(client, auth_headers_a, 'Percent%_')
    child = make_deck(client, auth_headers_a, 'Percent%_::Child')
    other = make_deck(client, auth_headers_a, 'PercentXY::Child')
    for did, front in [(root,'ROOT'),(child,'CHILD'),(other,'OTHER')]:
        response = client.post(f'/api/decks/{did}/import',headers=auth_headers_a,json={'text':front+'\tAnswer'})
        assert response.status_code == 200
    exported = client.get(f'/api/decks/{root}/export/text',headers=auth_headers_a)
    assert exported.status_code == 200, exported.text
    assert 'ROOT' in exported.text and 'CHILD' in exported.text and 'OTHER' not in exported.text
    direct = client.get(f'/api/decks/{root}/export/text?include_subdecks=false',headers=auth_headers_a)
    assert 'ROOT' in direct.text and 'CHILD' not in direct.text


def test_type_name_and_id_aliases_cannot_update_same_note_twice(client, db_session, auth_headers_a):
    did = make_deck(client, auth_headers_a)
    client.post(f'/api/decks/{did}/import', headers=auth_headers_a, json={'kind':'basic','text':'Same\tOriginal'})
    model_id = db_session.query(Note).one().note_type_id
    source = f'#notetype column:1\nBasic\tSame\tFirst update\n{model_id}\tSame\tSecond update\n'
    response = client.post(f'/api/decks/{did}/import', headers=auth_headers_a,
                           json={'text':source,'duplicate_policy':'update'})
    assert response.status_code == 400, response.text
    assert json.loads(db_session.query(Note).one().fields_json) == ['Same','Original']


def test_global_type_conflict_does_not_override_user_selection(client, db_session, auth_headers_a):
    did = make_deck(client, auth_headers_a)
    source = '#deck:New\n#notetype:Cloze\n{{c1::one}}\tExtra'
    response = client.post(f'/api/decks/{did}/import', headers=auth_headers_a,
                           json={'text':source,'kind':'basic','use_file_decks':True})
    assert response.status_code == 400, response.text
    assert db_session.query(Deck).count() == 1
    assert db_session.query(Note).count() == 0


def test_distinct_guids_same_front_in_different_decks(client, db_session, auth_headers_a):
    did = make_deck(client, auth_headers_a)
    source = '#separator:tab\n#notetype column:1\n#deck column:2\n#guid column:3\nBasic\tDeckA\tguid-x\tSameFirstField\tAnswer1\nBasic\tDeckB\tguid-y\tSameFirstField\tAnswer2\n'
    response = client.post(f'/api/decks/{did}/import', headers=auth_headers_a,
                           json={'text':source,'use_file_decks':True,'duplicate_policy':'skip'})
    assert response.status_code == 200, response.text
    assert response.json()['added'] == 2
    assert response.json()['skipped'] == 0
    assert db_session.query(Note).count() == 2
    assert {note.guid for note in db_session.query(Note).all()} == {'guid-x','guid-y'}


def test_field_map_alone_rejected_before_per_row_resolution(client, db_session, auth_headers_a):
    did = make_deck(client, auth_headers_a)
    source = '#notetype column:1\nBasic\tQ\tA\nUnknownType\tQ2\tA2\n'
    response = client.post(f'/api/decks/{did}/import', headers=auth_headers_a,
                           json={'text':source,'field_columns':{'Front':0,'Back':1}})
    assert response.status_code == 400, response.text
    assert 'Disable advanced mapping' in response.text
    assert db_session.query(Note).count() == db_session.query(NoteType).count() == 0


def test_existing_leaf_not_reported_as_new(client, db_session, auth_headers_a):
    did = make_deck(client, auth_headers_a)
    make_deck(client, auth_headers_a, 'Existing::Leaf')
    source = '#deck:Existing::Leaf\nQuestion\tAnswer'
    response = client.post(f'/api/decks/{did}/import', headers=auth_headers_a,
                           json={'text':source,'use_file_decks':True,'preview':True})
    assert response.status_code == 200, response.text
    assert response.json()['new_decks'] == []
    assert db_session.query(Deck).count() == 3
    assert db_session.query(Note).count() == 0
