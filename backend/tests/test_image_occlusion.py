from pathlib import Path
import pytest
from anki.collection import Collection
from anki.import_export_pb2 import ImportAnkiPackageRequest
from models import Card, Note, StudyProgress
from media_utils import get_media_dir


@pytest.fixture(autouse=True)
def isolated_media(tmp_path, monkeypatch):
    monkeypatch.setattr("media_utils.MEDIA_BASE", str(tmp_path / "media"))
    monkeypatch.setattr("apkg_handler.MEDIA_BASE", str(tmp_path / "media"))


def fields(all=True):
    return {'Occlusion': ''.join('{{c%d::image-occlusion:rect:left=.1:top=%s:width=.3:height=.1%s}}<br>' % (i, top, ':oi=1' if all else '') for i, top in [(1, '.2'), (3, '.6')]), 'Image': '<img src="diagram.png">', 'Header': 'Identify', 'Back Extra': 'Explanation', 'Comments': 'Private source'}


def create(client, headers, values=None):
    did = client.post('/api/decks', headers=headers, json={'name': 'Occlusion'}).json()['id']
    response = client.post('/api/notes', headers=headers, json={'deck_id': did, 'kind': 'image_occlusion', 'fields': values or fields()})
    assert response.status_code == 201, response.text
    return did, response.json()


@pytest.mark.parametrize('all', [True, False])
def test_modes_and_study(client, auth_headers_a, auth_headers_b, all):
    did, note = create(client, auth_headers_a, fields(all))
    assert note['kind'] == 'image_occlusion'
    assert [c['template_ord'] for c in note['cards']] == [0, 2]
    front, back = note['cards'][0]['front'], note['cards'][0]['back']
    assert front.count('data-io-mask=') == (2 if all else 1)
    assert 'background:#ffca64' in front and 'background:transparent' in back
    assert 'Explanation' not in front and 'Explanation' in back
    assert 'Private source' not in front + back and '<script' not in front + back
    assert 'data-io-mask' in client.get(f'/api/study/{did}', headers=auth_headers_a).json()['front']
    assert client.get(f"/api/notes/{note['id']}", headers=auth_headers_b).status_code == 404


def test_identity_history_and_rollback(client, auth_headers_a, db_session):
    _, note = create(client, auth_headers_a)
    card = db_session.get(Card, note['cards'][1]['id'])
    progress = StudyProgress(user_id=card.deck.user_id, card_id=card.id, card_state='review', interval_days=31)
    db_session.add(progress); db_session.commit()
    current = client.get(f"/api/notes/{note['id']}", headers=auth_headers_a).json()
    changed = fields(); changed['Occlusion'] = changed['Occlusion'].replace('top=.6', 'top=.4')
    url = f"/api/notes/{note['id']}"
    response = client.put(url, headers=auth_headers_a, json={'fields': changed, 'expected_revision': current['revision']})
    assert response.status_code == 200, response.text
    assert [c['id'] for c in response.json()['cards']] == [c['id'] for c in note['cards']]
    db_session.refresh(progress); assert progress.interval_days == 31
    assert client.put(url, headers=auth_headers_a, json={'fields': fields(), 'expected_revision': current['revision']}).status_code == 409
    changed['Occlusion'] = changed['Occlusion'].split('<br>')[0]
    assert client.put(url, headers=auth_headers_a, json={'fields': changed}).status_code == 400
    stored = client.get(url, headers=auth_headers_a).json()
    assert len(stored['cards']) == 2 and 'top=.4' in stored['fields']['Occlusion']


@pytest.mark.parametrize('old,new', [('rect:', 'ellipse:'), ('left=.1', 'left=nan'), ('left=.1', 'left=.9'), ('width=.3', 'width=0'), ('height=.1', 'height=.1:angle=NaN'), ('height=.1', 'height=.1:left=.2')])
def test_invalid_masks_atomic(client, auth_headers_a, db_session, old, new):
    did = client.post('/api/decks', headers=auth_headers_a, json={'name': 'Invalid'}).json()['id']
    data = fields(); data['Occlusion'] = data['Occlusion'].replace(old, new)
    response = client.post('/api/notes', headers=auth_headers_a, json={'deck_id': did, 'kind': 'image_occlusion', 'fields': data})
    assert response.status_code == 400, response.text
    assert db_session.query(Note).count() == db_session.query(Card).count() == 0


@pytest.mark.parametrize('geometry', ['rect', 'mixed', 'annotated'])
@pytest.mark.parametrize('modern', [True, False])
def test_native_web_roundtrip(client, auth_headers_a, auth_headers_b, user_a, tmp_path, modern, geometry):
    media = Path(get_media_dir(user_a.id)); media.mkdir(parents=True, exist_ok=True)
    (media / 'diagram.png').write_bytes(b'\x89PNG\r\n\x1a\nfixture')
    values = fields()
    if geometry == 'mixed':
        values['Occlusion'] = '{{c1::image-occlusion:ellipse:left=.1:top=.2:rx=.15:ry=.05:oi=1}}<br>{{c1::image-occlusion:polygon:left=.5:top=.6:points=.1,.1 .3,.1 .2,.2:oi=1}}<br>{{c3::image-occlusion:rect:left=.1:top=.8:width=.2:height=.1:oi=1}}'
    if geometry == 'annotated':
        values['Occlusion'] = values['Occlusion'].replace('height=.1', 'height=.1:angle=1250:fill=#00aaff') + r'{{c0::image-occlusion:text:left=.1:top=.1:text=Heart\: left=right:scale=1:fs=.05:fill=#000000}}'
    did, note = create(client, auth_headers_a, values)
    exported = client.get(f'/api/apkg/export/{did}?modern={str(modern).lower()}', headers=auth_headers_a)
    assert exported.status_code == 200, exported.text[:500]
    package = tmp_path / 'io.apkg'; package.write_bytes(exported.content)
    col = Collection(str(tmp_path / 'native.anki2'))
    try:
        col.import_anki_package(ImportAnkiPackageRequest(package_path=str(package)))
        assert col.card_count() == 2 and col.note_count() == 1
        native = col.get_note(col.find_notes('')[0])
        assert native.guid == note['guid'] and native['Occlusion'] == note['fields']['Occlusion']
        assert native.note_type()['originalStockKind'] == 6
        question = col.get_card(col.find_cards('')[0]).question()
        assert 'data-shape="rect"' in question and 'anki.imageOcclusion.setup()' in question
        if geometry == 'mixed':
            assert 'data-shape="ellipse"' in question and 'data-shape="polygon"' in question
    finally:
        col.close()
    imported = client.post('/api/apkg/import', headers=auth_headers_b, files={'file': ('io.apkg', exported.content)})
    assert imported.status_code == 200, imported.text
    cards = client.get(f"/api/decks/{imported.json()['deck_id']}/cards", headers=auth_headers_b).json()
    actual = client.get(f"/api/cards/{cards[0]['id']}/note", headers=auth_headers_b).json()
    assert actual['kind'] == 'image_occlusion' and actual['fields'] == note['fields'] and actual['guid'] == note['guid']
    assert all('data-io-mask' in c['front'] for c in actual['cards'])


def test_grouped_rectangles():
    from image_occlusion import render
    data = fields(); data['Occlusion'] = data['Occlusion'].replace('c3::', 'c1::')
    result = render(data, 1)
    assert list(result) == [0] and result[0][0].count('background:#ffca64') == 2


@pytest.mark.parametrize('unsupported', [False, True])
def test_import_native_created_note(client, auth_headers_a, tmp_path, db_session, unsupported):
    from anki.import_export_pb2 import ExportAnkiPackageOptions, ExportLimit
    col = Collection(str(tmp_path / 'source.anki2'))
    package = tmp_path / 'native-source.apkg'
    try:
        col._backend.add_image_occlusion_notetype()
        model = col.models.by_name('Image Occlusion')
        native = col.new_note(model)
        for name, value in fields().items():
            native[name] = value.replace('rect:', 'ellipse:') if unsupported and name == 'Occlusion' else value
        col.media.write_data('diagram.png', b'\x89PNG\r\n\x1a\nfixture')
        col.add_note(native, col.decks.id('Native IO'))
        col.export_anki_package(out_path=str(package), options=ExportAnkiPackageOptions(with_media=True), limit=ExportLimit(whole_collection={}))
    finally:
        col.close()
    response = client.post('/api/apkg/import', headers=auth_headers_a, files={'file': ('native.apkg', package.read_bytes())})
    if unsupported:
        assert response.status_code == 400, response.text
        assert db_session.query(Note).count() == 0
        return
    assert response.status_code == 200, response.text
    cards = client.get(f"/api/decks/{response.json()['deck_id']}/cards", headers=auth_headers_a).json()
    assert len(cards) == 2 and all('data-io-mask' in c['front'] for c in cards)
    note = client.get(f"/api/cards/{cards[0]['id']}/note", headers=auth_headers_a).json()
    assert note['kind'] == 'image_occlusion' and note['fields'] == fields()


@pytest.mark.parametrize('image', ['<img src="/api/media/999/secret.png">', '<img src="/api/media/1/%2e%2e/secret.png">', '<img src="https://example.com/a.png">', '<img src="a.png" onerror="alert(1)">'])
def test_invalid_image_is_rejected(image):
    from image_occlusion import render
    data = fields(); data['Image'] = image
    with pytest.raises(ValueError):
        render(data, 1)


def test_delete_unstudied_and_add_keeps_other_card(client, auth_headers_a):
    _, note = create(client, auth_headers_a)
    data = fields(); data['Occlusion'] = data['Occlusion'].split('<br>')[1] + '<br>'
    response = client.put(f"/api/notes/{note['id']}", headers=auth_headers_a, json={'fields': data})
    assert response.status_code == 200, response.text
    assert [c['id'] for c in response.json()['cards']] == [note['cards'][1]['id']]
    data['Occlusion'] += data['Occlusion'].replace('c3::', 'c4::')
    response = client.put(f"/api/notes/{note['id']}", headers=auth_headers_a, json={'fields': data})
    assert response.status_code == 200, response.text
    assert response.json()['cards'][0]['id'] == note['cards'][1]['id']
    assert [c['template_ord'] for c in response.json()['cards']] == [2, 3]


@pytest.mark.parametrize('geometry', [
    'ellipse:left=.1:top=.1:rx=nan:ry=.1',
    'ellipse:left=.9:top=.1:rx=.1:ry=.1',
    'polygon:left=.1:top=.1:points=0,0 .1,.1',
    'polygon:left=.1:top=.1:points=0,0 .1,.1 .2,.2',
    'polygon:left=.1:top=.1:points=0,0 NaN,.1 .1,0',
    'polygon:left=.9:top=.1:points=0,0 .2,0 .1,.1',
])
def test_invalid_new_geometry(geometry):
    from image_occlusion import masks
    with pytest.raises(ValueError):
        masks('{{c1::image-occlusion:' + geometry + '}}')


def test_polygon_outline_and_ellipse_answer():
    from image_occlusion import render
    from urllib.parse import unquote
    data = fields()
    data['Occlusion'] = '{{c1::image-occlusion:ellipse:left=.1:top=.1:rx=.1:ry=.2:oi=1}}<br>{{c1::image-occlusion:polygon:left=.5:top=.1:points=.2,.3 .4,.3 .3,.5:oi=1}}'
    front, back = render(data, 1)[0]
    assert front.count('data-io-mask="1"') == 2
    assert 'border-radius:50%' in front
    assert 'points="0.000000,0.000000 100.000000,0.000000 50.000000,100.000000"' in unquote(front)
    assert 'fill="transparent"' in unquote(back)


def test_annotation_escaping_rotation_and_color():
    from image_occlusion import render, masks
    data = fields()
    data['Occlusion'] = data['Occlusion'].replace('height=.1', 'height=.1:angle=2500:fill=#aabbcc') + r'{{c0::image-occlusion:text:left=.1:top=.1:text=<img onerror=evil> A\:B\\C:scale=2:fs=.04}}'
    shapes = masks(data['Occlusion'])
    assert shapes[-1]['text'] == r'<img onerror=evil> A:B\C'
    cards = render(data, 1)
    assert list(cards) == [0, 2]
    front, back = cards[0]
    assert 'rotate(90.000000deg)' in front and 'background:#aabbcc' in front
    assert '&lt;img onerror=evil&gt;' in front and '&lt;img onerror=evil&gt;' in back
    assert 'data-io-text="0"' in front and '<img onerror=evil>' not in front
    for suffix in ['fill=url(evil)', 'angle=Infinity', 'fill=red;position=fixed']:
        with pytest.raises(ValueError): masks(fields()['Occlusion'].replace('height=.1', 'height=.1:' + suffix))
