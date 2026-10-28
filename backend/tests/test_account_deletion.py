import json
from pathlib import Path
import threading
import uuid

import pytest
from fastapi import HTTPException

import account_lifecycle
import import_jobs
import media_utils
from collection_snapshot import TABLES, capture
from models import User, CollectionOperation


@pytest.fixture
def account_files(tmp_path, monkeypatch):
    monkeypatch.setattr(account_lifecycle, 'LOCK_ROOT', tmp_path / 'locks')
    monkeypatch.setattr(import_jobs, 'ROOT', tmp_path / 'jobs')
    monkeypatch.setattr(media_utils, 'MEDIA_BASE', str(tmp_path / 'media'))
    monkeypatch.setenv('BACKUP_DIR', str(tmp_path / 'backups'))
    return tmp_path


def seed(client, headers, db, uid):
    from test_input_validation import _create_test_apkg_bytes
    response = client.post('/api/apkg/import', headers=headers, files={
        'file': ('data.apkg', _create_test_apkg_bytes(cards_count=2), 'application/octet-stream')})
    assert response.status_code == 200, response.text
    rows = capture(db, uid)
    cid = rows['cards'][0]['id']
    response = client.post(f'/api/study/{cid}/review', headers=headers, json={'rating': 4})
    assert response.status_code == 200, response.text
    db.add(CollectionOperation(id=str(uuid.uuid4()), user_id=uid, action='test', before_json='{}', after_hash='hash'))
    db.commit()


def disk_fixture(root, uid):
    paths = []
    for folder in ('media', 'backups'):
        path = root / folder / str(uid)
        path.mkdir(parents=True, exist_ok=True)
        for name in ('data.bin', 'pending-restore.colpkg', 'backup.zip', 'partial.tmp'):
            (path / name).write_bytes(b'private data')
        paths.append(path)
    for folder in ('jobs', 'jobs/uploads'):
        for state in ('completed', 'awaiting_confirmation', 'uploading', 'failed'):
            path = root / folder / uuid.uuid4().hex
            path.mkdir(parents=True)
            (path / 'status.json').write_text(json.dumps({'user_id': uid, 'status': state}))
            (path / 'package.apkg').write_bytes(b'package')
            paths.append(path)
    return paths


def test_remove_account_purges_database_media_backups_and_imports_only_for_owner(
        client, db_session, user_a, user_b, auth_headers_a, auth_headers_b, account_files):
    uid = user_a.id
    seed(client, auth_headers_a, db_session, uid)
    seed(client, auth_headers_b, db_session, user_b.id)
    before_b = capture(db_session, user_b.id)
    own_paths = disk_fixture(account_files, uid)
    other_paths = disk_fixture(account_files, user_b.id)
    other_bytes = {p: p.read_bytes() for root in other_paths for p in root.rglob('*') if p.is_file()}
    response = client.delete('/api/auth/me', headers=auth_headers_a)
    assert response.status_code == 200, response.text
    assert not any(p.exists() for p in own_paths)
    assert all(p.read_bytes() == content for p, content in other_bytes.items())
    db_session.expire_all()
    assert db_session.get(User, uid) is None
    assert all(not rows for rows in capture(db_session, uid).values())
    assert db_session.query(CollectionOperation).filter_by(user_id=uid).count() == 0
    assert capture(db_session, user_b.id) == before_b
    # Every collection row still belongs to the surviving fixture.
    remaining = capture(db_session, user_b.id)
    for model in TABLES:
        assert db_session.query(model).count() == len(remaining[model.__tablename__])
    assert client.get('/api/auth/me', headers=auth_headers_a).status_code == 401
    assert client.get('/api/auth/me', headers=auth_headers_b).status_code == 200


def test_delete_waits_for_active_requests_and_does_not_block_other_accounts(
        client, user_a, user_b, auth_headers_a, auth_headers_b, account_files):
    with account_lifecycle.account_lock(user_a.id):
        response = client.delete('/api/auth/me', headers=auth_headers_a)
        assert response.status_code == 409
        assert client.get('/api/auth/me', headers=auth_headers_b).status_code == 200
    assert client.delete('/api/auth/me', headers=auth_headers_a).status_code == 200


def test_deletion_lock_rejects_new_writes(client, user_a, auth_headers_a, account_files):
    with account_lifecycle.account_lock(user_a.id, deleting=True):
        response = client.post('/api/decks', headers=auth_headers_a, json={'name': 'Race'})
        assert response.status_code == 409


def test_failed_file_cleanup_keeps_account_for_retry(client, db_session, user_a, auth_headers_a, account_files, monkeypatch):
    uid = user_a.id
    def failed(path):
        raise PermissionError('fixture deletion denied')
    monkeypatch.setattr(account_lifecycle, 'remove_tree', failed)
    with pytest.raises(PermissionError):
        client.delete('/api/auth/me', headers=auth_headers_a)
    db_session.expire_all()
    assert db_session.get(User, uid) is not None
    assert client.get('/api/auth/me', headers=auth_headers_a).status_code == 200


def test_re_registration_does_not_reuse_deleted_identity(client, account_files):
    body = {'email': 'fresh@example.com', 'username': 'Fresh', 'password': 'Password123!'}
    first = client.post('/api/auth/register', json=body).json()
    headers = {'Authorization': 'Bearer ' + first['access_token']}
    assert client.delete('/api/auth/me', headers=headers).status_code == 200
    second = client.post('/api/auth/register', json=body).json()
    assert second['user']['id'] != first['user']['id']
    assert client.get('/api/auth/me', headers=headers).status_code == 401


def test_background_import_holds_account_lock_until_worker_finishes(account_files, user_a, monkeypatch):
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    import apkg_handler
    from contextlib import nullcontext
    monkeypatch.setattr(import_jobs, 'SessionLocal', lambda: nullcontext(None))
    def blocked(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return {'cards_imported': 1}
    monkeypatch.setattr(apkg_handler, 'import_apkg', blocked)
    path = import_jobs.ROOT / uuid.uuid4().hex
    path.mkdir(parents=True)
    (path / 'package.apkg').write_bytes(b'fixture')
    data = dict(id=path.name, user_id=user_a.id, status='queued', options={})
    import_jobs.write_status(path, data)
    gate = import_jobs.acquire_gate()
    import_jobs.start(path, data, gate, preview=True)
    try:
        assert entered.wait(5)
        with pytest.raises(HTTPException) as error:
            with account_lifecycle.account_lock(user_a.id, deleting=True):
                pass
        assert error.value.status_code == 409
    finally:
        release.set()
        # A queued sentinel runs only after the worker's final lock release.
        import_jobs.EXECUTOR.submit(finished.set)
        assert finished.wait(5)
    with account_lifecycle.account_lock(user_a.id, deleting=True):
        account_lifecycle.purge_account_files(user_a.id)
    assert not path.exists()


def test_cleanup_unlinks_media_symlink_without_touching_other_users(account_files, user_a, user_b):
    target = account_files / 'media' / str(user_b.id)
    target.mkdir(parents=True)
    (target / 'keep.mp3').write_bytes(b'other account media')
    link = target.parent / str(user_a.id)
    link.symlink_to(target, target_is_directory=True)
    with account_lifecycle.account_lock(user_a.id, deleting=True):
        account_lifecycle.purge_account_files(user_a.id)
    assert not link.is_symlink()
    assert (target / 'keep.mp3').read_bytes() == b'other account media'
