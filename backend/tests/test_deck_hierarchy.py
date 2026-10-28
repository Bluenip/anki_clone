import json
from deck_hierarchy import repair_missing_parents
from models import Deck


def test_repair_creates_real_parents_with_options_and_preserves_cards(db_session, user_a, user_b, client, auth_headers_a):
    child = Deck(user_id=user_a.id, name='Book::Part::Unit 01', settings=json.dumps({'new_cards_per_day': 17}))
    other = Deck(user_id=user_b.id, name='Book::Unit 02', settings='{}')
    db_session.add_all([child, other]); db_session.commit()
    assert len(repair_missing_parents(db_session, user_a.id)) == 2
    db_session.commit()
    assert not repair_missing_parents(db_session, user_a.id)
    parent = db_session.query(Deck).filter_by(user_id=user_a.id, name='Book').one()
    assert json.loads(parent.settings)['new_cards_per_day'] == 17
    assert db_session.query(Deck).filter_by(user_id=user_b.id).count() == 1
    response = client.get(f'/api/decks/{parent.id}/options', headers=auth_headers_a)
    assert response.status_code == 200, response.text
    data = client.get('/api/decks', headers=auth_headers_a).json()
    assert {d['name'] for d in data} == {'Book', 'Book::Part', 'Book::Part::Unit 01'}


def test_package_import_preserves_cardless_parent_options(client, auth_headers_a, db_session, user_a, tmp_path):
    import io
    import sqlite3
    import zipfile
    from test_input_validation import _create_test_apkg_bytes
    package = _create_test_apkg_bytes(deck_name='Book::Unit 01')
    with zipfile.ZipFile(io.BytesIO(package)) as archive:
        files = {name: archive.read(name) for name in archive.namelist()}
    source = tmp_path / 'collection.anki2'
    source.write_bytes(files['collection.anki2'])
    with sqlite3.connect(source) as db:
        db.execute('update col set decks=?, dconf=?', (json.dumps({
            '1': {'name': 'Book::Unit 01', 'conf': 1},
            '2': {'name': 'Book', 'conf': 2},
        }), json.dumps({
            '1': {'name': 'Child options', 'new': {'perDay': 20}},
            '2': {'name': 'Parent options', 'new': {'perDay': 10}},
        })))
    files['collection.anki2'] = source.read_bytes()
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as archive:
        for name, data in files.items(): archive.writestr(name, data)
    response = client.post('/api/apkg/import', headers=auth_headers_a,
                           files={'file': ('nested.apkg', output.getvalue(), 'application/octet-stream')})
    assert response.status_code == 200, response.text
    parent = db_session.query(Deck).filter_by(user_id=user_a.id, name='Book').one()
    assert len(parent.cards) == 0
    options = client.get(f'/api/decks/{parent.id}/options', headers=auth_headers_a)
    assert options.status_code == 200
    assert json.loads(options.json()['settings'])['new_cards_per_day'] == 10
    assert response.json()['deck_id'] != parent.id
