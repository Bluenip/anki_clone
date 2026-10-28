import json
import time
import threading
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import User, Card, Deck
from test_input_validation import _create_test_apkg_bytes
import import_jobs


@pytest.fixture
def jobs(tmp_path, monkeypatch, user_a, user_b):
    engine = create_engine('sqlite:///' + str(tmp_path / 'jobs-test.db'), connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as db:
        for user in (user_a, user_b):
            db.add(User(id=user.id, email=user.email, username=user.username, password_hash='unused'))
        db.commit()
    monkeypatch.setattr(import_jobs, 'ROOT', tmp_path / 'jobs')
    monkeypatch.setattr(import_jobs, 'SessionLocal', factory)
    yield factory
    engine.dispose()


def wait_job(client, job_id, headers, expected):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        response = client.get(f'/api/apkg/jobs/{job_id}', headers=headers)
        assert response.status_code == 200, response.text
        data = response.json()
        if data['status'] in expected:
            return data
        assert data['status'] not in {'failed', 'interrupted'}, data
        time.sleep(0.01)
    pytest.fail('Job did not reach expected state')


def upload(client, headers, data=None):
    response = client.post('/api/apkg/jobs', headers=headers, files={
        'file': ('sample.apkg', data or _create_test_apkg_bytes(cards_count=2), 'application/octet-stream')})
    assert response.status_code == 202, response.text
    return response.json()['id']


def test_job_preview_confirm_and_reimport(client, auth_headers_a, auth_headers_b, jobs):
    job_id = upload(client, auth_headers_a)
    preview = wait_job(client, job_id, auth_headers_a, {'awaiting_confirmation'})
    assert preview['result']['cards_imported'] == 2
    with jobs() as db:
        assert db.query(Card).count() == db.query(Deck).count() == 0
    for suffix in ['', '/confirm', '/cancel']:
        response = (client.get if not suffix else client.post)(f'/api/apkg/jobs/{job_id}{suffix}', headers=auth_headers_b)
        assert response.status_code == 404
    response = client.post(f'/api/apkg/jobs/{job_id}/confirm', headers=auth_headers_a)
    assert response.status_code == 202, response.text
    done = wait_job(client, job_id, auth_headers_a, {'completed'})
    assert done['result']['cards_imported'] == 2
    assert not (import_jobs.directory(job_id) / 'package.apkg').exists()
    with jobs() as db:
        assert db.query(Card).count() == 2
    assert client.post(f'/api/apkg/jobs/{job_id}/confirm', headers=auth_headers_a).status_code == 409


def test_preview_cancel_and_expiry(client, auth_headers_a, jobs):
    job_id = upload(client, auth_headers_a)
    wait_job(client, job_id, auth_headers_a, {'awaiting_confirmation'})
    response = client.post(f'/api/apkg/jobs/{job_id}/cancel', headers=auth_headers_a)
    assert response.json()['status'] == 'cancelled'
    assert not (import_jobs.directory(job_id) / 'package.apkg').exists()
    with jobs() as db:
        assert db.query(Card).count() == 0
    job_id = upload(client, auth_headers_a)
    data = wait_job(client, job_id, auth_headers_a, {'awaiting_confirmation'})
    data['updated_at'] = time.time() - 86401
    (import_jobs.directory(job_id) / 'status.json').write_text(json.dumps(data))
    assert client.get(f'/api/apkg/jobs/{job_id}', headers=auth_headers_a).json()['status'] == 'expired'
    assert not (import_jobs.directory(job_id) / 'package.apkg').exists()


def test_running_job_cancellation_and_gate(client, auth_headers_a, jobs, monkeypatch):
    import apkg_handler
    entered, release = threading.Event(), threading.Event()
    actual = apkg_handler.import_apkg
    def blocked(*args, progress, **kwargs):
        entered.set()
        assert release.wait(5)
        return actual(*args, progress=progress, **kwargs)
    monkeypatch.setattr(apkg_handler, 'import_apkg', blocked)
    job_id = upload(client, auth_headers_a)
    try:
        assert entered.wait(5)
        blocked_response = client.post('/api/apkg/jobs', headers=auth_headers_a, files={'file': ('another.apkg', _create_test_apkg_bytes())})
        assert blocked_response.status_code == 409
        assert client.post(f'/api/apkg/jobs/{job_id}/cancel', headers=auth_headers_a).status_code == 200
    finally:
        release.set()
    wait_job(client, job_id, auth_headers_a, {'cancelled'})
    with jobs() as db:
        assert db.query(Card).count() == 0


def test_cancel_during_media_copy_rolls_back(jobs, user_a, tmp_path):
    from apkg_handler import import_apkg
    package = tmp_path / 'cancel.apkg'
    package.write_bytes(_create_test_apkg_bytes(cards_count=2, media_dict={'0': 'a.mp3', '1': 'b.mp3'}, raw_files={'0': b'ID3a', '1': b'ID3b'}))
    media = tmp_path / 'media'
    def progress(stage, completed, total):
        if stage == 'copying_media' and completed == 1:
            raise import_jobs.ImportCancelled()
    with jobs() as db:
        with pytest.raises(import_jobs.ImportCancelled):
            import_apkg(str(package), user_a.id, db, media_directory=str(media), progress=progress)
        assert db.query(Card).count() == db.query(Deck).count() == 0
    assert not list(media.iterdir())


def test_invalid_jobs_and_interrupted_state(client, auth_headers_a, jobs, user_a):
    job_id = upload(client, auth_headers_a, b'corrupt zip')
    data = wait_job(client, job_id, auth_headers_a, {'failed'})
    assert data['error_code'] == 'invalid_package'
    assert not (import_jobs.directory(job_id) / 'package.apkg').exists()
    path = import_jobs.ROOT / ('a' * 32)
    path.mkdir()
    import_jobs.write_status(path, dict(id=path.name, user_id=user_a.id, status='extracting'))
    (path / 'package.apkg').write_bytes(b'partial')
    assert client.get(f'/api/apkg/jobs/{path.name}', headers=auth_headers_a).json()['status'] == 'interrupted'
    assert client.get('/api/apkg/jobs/bad-id', headers=auth_headers_a).status_code == 404


def test_limit_error_is_clear_and_configurable(client, auth_headers_a, monkeypatch):
    from routers import import_jobs_router
    monkeypatch.setattr(import_jobs_router, 'MAX_UPLOAD_BYTES', 100)
    response = client.post('/api/apkg/jobs', headers=auth_headers_a, files={'file': ('big.apkg', b'x' * 101)})
    assert response.status_code == 413
    assert 'Maximum allowed size' in response.json()['detail']
    assert client.get('/api/apkg/limits', headers=auth_headers_a).json()['max_cards'] == 100000


def test_static_svg_removes_active_content_and_outside_links():
    from static_svg import sanitize_svg
    source = b'''<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><foreignObject/><rect width="5" height="5" fill="red"/><use href="https://evil.example/x"/><g style="fill:url(https://evil.example)"><path d="M0 0" fill="url(#safe)"/></g></svg>'''
    clean = sanitize_svg(source)
    assert b'script' not in clean and b'foreignObject' not in clean and b'onload' not in clean
    assert b'https://evil' not in clean and b'style=' not in clean
    assert b'width="5"' in clean and b'url(#safe)' in clean
    with pytest.raises(ValueError):
        sanitize_svg(b'<!DOCTYPE svg [<!ENTITY x "bad">]><svg/>')


def test_svg_import_opt_in_preserves_graphics_and_warns(jobs, user_a, tmp_path):
    from apkg_handler import import_apkg
    package = tmp_path / 'svg.apkg'
    package.write_bytes(_create_test_apkg_bytes(cards_count=1, media_dict={'0': 'shape.svg'}, raw_files={'0': b'<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script><circle r="4"/></svg>'}))
    media = tmp_path / 'media'
    with jobs() as db:
        result = import_apkg(str(package), user_a.id, db, media_directory=str(media), sanitize_svg=True)
        assert result['warnings']
    assert b'script' not in (media / 'shape.svg').read_bytes()
    assert b'circle' in (media / 'shape.svg').read_bytes()


def test_status_does_not_overwrite_worker_completion(jobs, user_a, monkeypatch):
    path = import_jobs.ROOT / ('b' * 32)
    path.mkdir(parents=True)
    import_jobs.write_status(path, dict(id=path.name, user_id=user_a.id, status='committing'))
    original_loads = json.loads
    switched = False
    def finish_between_read_and_lock(source, *args, **kwargs):
        nonlocal switched
        data = original_loads(source, *args, **kwargs)
        if isinstance(data, dict) and data.get('id') == path.name and not switched:
            switched = True
            import_jobs.write_status(path, dict(data, status='completed', result={'cards_imported': 1}))
        return data
    monkeypatch.setattr(import_jobs.json, 'loads', finish_between_read_and_lock)
    data = import_jobs.read_status(path.name, user_a.id)
    assert switched
    assert data['status'] == 'completed'


def test_upload_low_disk_space_reports_reason_without_temp_file(client, auth_headers_a, jobs, monkeypatch):
    from routers import import_jobs_router
    def no_space(*args):
        raise ValueError('Insufficient disk space: need 1024 bytes, available 0 bytes')
    monkeypatch.setattr(import_jobs_router, 'check_space', no_space)
    response = client.post('/api/apkg/jobs', headers=auth_headers_a,
                           files={'file': ('disk.apkg', _create_test_apkg_bytes())})
    assert response.status_code == 400
    assert 'Insufficient disk space' in response.json()['detail']
    assert not list(import_jobs.ROOT.iterdir())
