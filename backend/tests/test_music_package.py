"""Optional real-world regression: ANKI_TEST_MUSIC_APKG=/path/to/file.apkg pytest ..."""
import hashlib
import json
import os
import zipfile

import pytest
from anki.collection import Collection
from apkg_handler import import_apkg
from models import Card, Note, Deck


@pytest.mark.skipif(not os.getenv('ANKI_TEST_MUSIC_APKG'), reason='Set ANKI_TEST_MUSIC_APKG to run the real music fixture')
def test_real_music_package_preview_import_reimport(db_session, user_a, tmp_path):
    package = os.environ['ANKI_TEST_MUSIC_APKG']
    media = tmp_path / 'media'
    preview = import_apkg(package, user_a.id, db_session, media_directory=str(media), preview=True, sanitize_svg=True)
    assert preview['cards_imported'] == preview['notes_in_package'] == 545
    assert db_session.query(Card).count() == db_session.query(Note).count() == db_session.query(Deck).count() == 0
    assert not list(media.iterdir())
    imported = import_apkg(package, user_a.id, db_session, media_directory=str(media), sanitize_svg=True)
    assert imported['cards_imported'] == imported['media_imported'] == 545
    again = import_apkg(package, user_a.id, db_session, media_directory=str(media), sanitize_svg=True)
    assert again['cards_imported'] == 0 and again['cards_skipped'] == 545
    with zipfile.ZipFile(package) as archive:
        mapping = json.loads(archive.read('media'))
        for key, name in mapping.items():
            assert hashlib.sha256((media / name).read_bytes()).digest() == hashlib.sha256(archive.read(key)).digest()
        reference_path = tmp_path / 'reference.anki2'
        reference_path.write_bytes(archive.read('collection.anki2'))
    reference = Collection(str(reference_path))
    try:
        assert reference.note_count() == db_session.query(Note).count() == 545
        assert reference.card_count() == db_session.query(Card).count() == 545
        by_guid = {note.guid: json.loads(note.fields_json) for note in db_session.query(Note)}
        for nid in reference.find_notes(''):
            actual = reference.get_note(nid)
            assert by_guid[actual.guid] == list(actual.fields)
    finally:
        reference.close()

# These fixtures create an independent SQLite database for worker-owned sessions.
from test_import_jobs import jobs, wait_job


@pytest.mark.skipif(not os.getenv('ANKI_TEST_MUSIC_APKG'), reason='Set ANKI_TEST_MUSIC_APKG to run the real music fixture')
def test_real_music_package_through_background_http(client, auth_headers_a, jobs):
    import import_jobs
    with open(os.environ['ANKI_TEST_MUSIC_APKG'], 'rb') as package:
        response = client.post('/api/apkg/jobs', headers=auth_headers_a,
                               files={'file': ('music.apkg', package, 'application/octet-stream')})
    assert response.status_code == 202, response.text
    job_id = response.json()['id']
    preview = wait_job(client, job_id, auth_headers_a, {'awaiting_confirmation'})
    assert preview['result']['cards_imported'] == preview['result']['media_imported'] == 545
    with jobs() as db:
        assert db.query(Card).count() == 0
    assert client.post(f'/api/apkg/jobs/{job_id}/confirm', headers=auth_headers_a).status_code == 202
    completed = wait_job(client, job_id, auth_headers_a, {'completed'})
    assert completed['result']['cards_imported'] == 545
    assert not (import_jobs.directory(job_id) / 'package.apkg').exists()
    with jobs() as db:
        assert db.query(Card).count() == db.query(Note).count() == 545
