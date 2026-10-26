import json
import zipfile
from io import BytesIO
from pathlib import Path
from datetime import datetime, timezone
import pytest
from models import Card, Deck, ReviewLog, SchedulerState, StudyProgress, CollectionOperation, StudyOperation
from scheduling import fsrs_state
from study_queue import config_for
from collection_snapshot import capture, fingerprint


def make(client, headers, name='Original', fsrs=False):
    deck = client.post('/api/decks', headers=headers, json={'name': name}).json()['id']
    if fsrs:
        assert client.put(f'/api/decks/{deck}', headers=headers, json={'settings': json.dumps({'fsrs': True})}).status_code == 200
    note = client.post('/api/notes', headers=headers, json={'deck_id': deck, 'kind': 'basic', 'fields': {'Front': 'Question', 'Back': 'Answer'}}).json()
    return deck, note['cards'][0]['id']


def bulk(client, headers, action, cid, version, **extra):
    return client.post('/api/cards/bulk-action', headers=headers, json={'action': action, 'cards': [{'card_id': cid, 'expected_version': version}], **extra})


def test_reset_restarts_memory_keeps_history_and_undo(client, auth_headers_a, db_session):
    _, cid = make(client, auth_headers_a, fsrs=True)
    response = client.post(f'/api/study/{cid}/review', headers=auth_headers_a, json={'rating': 4, 'expected_version': 0})
    assert response.status_code == 200, response.text
    memory = db_session.get(SchedulerState, cid).fsrs_json
    assert bulk(client, auth_headers_a, 'reset', cid, 1).status_code == 200
    db_session.expire_all(); card = db_session.get(Card, cid)
    state, origin = fsrs_state(db_session, card, None, config_for(card.deck), datetime.now(timezone.utc))
    assert state.stability is None and origin == 'new'
    assert db_session.query(ReviewLog).filter(ReviewLog.rating > 0).count() == 1
    assert db_session.query(StudyProgress).count() == 0
    undo = client.post('/api/cards/bulk-undo', headers=auth_headers_a)
    assert undo.status_code == 200, undo.text
    db_session.expire_all()
    assert db_session.get(SchedulerState, cid).fsrs_json == memory
    assert db_session.query(ReviewLog).count() == 1
    assert db_session.query(StudyProgress).one().card_state == 'review'
    assert bulk(client, auth_headers_a, 'reset', cid, 1).status_code == 409


def test_chained_bulk_undo_delete_and_intervening_edit(client, auth_headers_a, db_session):
    _, cid = make(client, auth_headers_a)
    assert bulk(client, auth_headers_a, 'reschedule', cid, 0, due_days=7).status_code == 200
    assert bulk(client, auth_headers_a, 'delete', cid, 1).status_code == 200
    assert db_session.get(Card, cid) is None
    assert client.post('/api/cards/bulk-undo', headers=auth_headers_a).status_code == 200
    assert client.post('/api/cards/bulk-undo', headers=auth_headers_a).status_code == 200
    db_session.expire_all()
    assert db_session.query(StudyProgress).count() == 0
    version = db_session.get(SchedulerState, cid).version
    assert bulk(client, auth_headers_a, 'suspend', cid, version).status_code == 200
    client.post('/api/decks', headers=auth_headers_a, json={'name': 'New work'})
    assert client.post('/api/cards/bulk-undo', headers=auth_headers_a).status_code == 409
    assert db_session.query(StudyProgress).one().is_suspended


@pytest.fixture
def backups(tmp_path, monkeypatch):
    monkeypatch.setenv('BACKUP_DIR', str(tmp_path / 'backups'))
    return tmp_path / 'backups'


def test_backup_restore_media_ownership_and_stale_undo(client, auth_headers_a, auth_headers_b, db_session, user_a, backups):
    from media_utils import get_media_dir
    _, cid = make(client, auth_headers_a)
    media = Path(get_media_dir(user_a.id)); media.mkdir(parents=True, exist_ok=True)
    file = media / 'restore-test.png'; file.write_bytes(b'original')
    saved = client.post('/api/backups', headers=auth_headers_a)
    assert saved.status_code == 200, saved.text
    key = saved.json()['id']
    assert client.get(f'/api/backups/{key}/download', headers=auth_headers_b).status_code == 404
    downloaded = client.get(f'/api/backups/{key}/download', headers=auth_headers_a)
    with zipfile.ZipFile(BytesIO(downloaded.content)) as archive:
        assert archive.read('media/restore-test.png') == b'original'
        assert 'password_hash' not in archive.read('snapshot.json').decode()
    assert bulk(client, auth_headers_a, 'reschedule', cid, 0, due_days=20).status_code == 200
    file.write_bytes(b'changed')
    status = client.get('/api/backups', headers=auth_headers_a).json()
    result = client.post(f'/api/backups/{key}/restore', headers=auth_headers_a, json={'expected_revision': status['revision']})
    assert result.status_code == 200, result.text
    assert file.read_bytes() == b'original'
    assert db_session.query(CollectionOperation).count() == 0
    assert db_session.query(StudyProgress).count() == 0
    assert db_session.get(SchedulerState, cid).version > 1
    assert client.post(f'/api/backups/{key}/restore', headers=auth_headers_a, json={'expected_revision': status['revision']}).status_code == 409
    file.unlink()


def test_populated_collection_preview_apply_and_safety_backup(client, auth_headers_a, auth_headers_b, user_a, db_session, backups):
    _, old_cid = make(client, auth_headers_a)
    make(client, auth_headers_b, name='Incoming')
    exported = client.get('/api/apkg/export-collection', headers=auth_headers_b)
    assert exported.status_code == 200, exported.text
    before = fingerprint(capture(db_session, user_a.id))
    preview = client.post('/api/backups/preview', headers=auth_headers_a, files={'file': ('collection.colpkg', exported.content)})
    assert preview.status_code == 200, preview.text
    data = preview.json()
    assert data['incoming']['cards'] == 1
    assert fingerprint(capture(db_session, user_a.id)) == before
    assert client.post('/api/backups/apply', headers=auth_headers_b, json={'token': data['token'], 'expected_revision': data['expected_revision']}).status_code == 404
    result = client.post('/api/backups/apply', headers=auth_headers_a, json={'token': data['token'], 'expected_revision': data['expected_revision']})
    assert result.status_code == 200, result.text
    db_session.expire_all()
    cards = db_session.query(Card).join(Deck).filter(Deck.user_id == user_a.id).all()
    assert len(cards) == 1 and cards[0].id > old_cid
    assert cards[0].deck.name == 'Incoming'
    assert (backups / str(user_a.id) / (result.json()['safety_backup'] + '.zip')).is_file()
    assert client.post('/api/backups/apply', headers=auth_headers_a, json={'token': data['token'], 'expected_revision': data['expected_revision']}).status_code == 404


def test_invalid_preview_leaves_collection_and_pending_files_unchanged(client, auth_headers_a, user_a, db_session, backups):
    make(client, auth_headers_a)
    before = fingerprint(capture(db_session, user_a.id))
    result = client.post('/api/backups/preview', headers=auth_headers_a, files={'file': ('bad.colpkg', b'not a zip')})
    assert result.status_code == 422, result.text
    assert fingerprint(capture(db_session, user_a.id)) == before
    assert not list((backups / str(user_a.id)).glob('pending-*'))


def test_restore_commit_failure_rolls_back_media_and_collection(client, auth_headers_a, user_a, db_session, backups, monkeypatch):
    from media_utils import get_media_dir
    import sqlite3
    make(client, auth_headers_a)
    media=Path(get_media_dir(user_a.id));media.mkdir(parents=True,exist_ok=True)
    path=media/'rollback-restore.png';path.write_bytes(b'old backup')
    key=client.post('/api/backups',headers=auth_headers_a).json()['id']
    path.write_bytes(b'current bytes')
    before=capture(db_session,user_a.id)
    def fail():raise sqlite3.OperationalError('commit failed')
    with monkeypatch.context() as patch:
        patch.setattr(db_session,'commit',fail)
        with pytest.raises(sqlite3.OperationalError):
            client.post(f'/api/backups/{key}/restore',headers=auth_headers_a,json={'expected_revision':fingerprint(before)})
    assert path.read_bytes()==b'current bytes'
    assert fingerprint(capture(db_session,user_a.id))==fingerprint(before)
    path.unlink()
