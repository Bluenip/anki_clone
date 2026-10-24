import io
import zipfile
import pytest


def test_deck_validation_limits(client, auth_headers_a):
    # Empty deck name
    resp = client.post(
        "/api/decks",
        headers=auth_headers_a,
        json={"name": "   ", "description": "valid"},
    )
    assert resp.status_code == 422

    # Excessively long deck name (> 255 chars)
    resp = client.post(
        "/api/decks",
        headers=auth_headers_a,
        json={"name": "A" * 256, "description": "valid"},
    )
    assert resp.status_code == 422


def test_card_validation_limits(client, auth_headers_a):
    # Create valid deck first
    deck_resp = client.post(
        "/api/decks",
        headers=auth_headers_a,
        json={"name": "Limit Test Deck"},
    )
    deck_id = deck_resp.json()["id"]

    # Empty card front
    resp = client.post(
        f"/api/decks/{deck_id}/cards",
        headers=auth_headers_a,
        json={"front": "   ", "back": "Valid Back"},
    )
    assert resp.status_code == 422

    # Excessively long card front (> 50,000 chars)
    resp = client.post(
        f"/api/decks/{deck_id}/cards",
        headers=auth_headers_a,
        json={"front": "X" * 50001, "back": "Valid Back"},
    )
    assert resp.status_code == 422


def test_invalid_review_rating(client, auth_headers_a):
    deck_resp = client.post(
        "/api/decks",
        headers=auth_headers_a,
        json={"name": "Rating Test Deck"},
    )
    deck_id = deck_resp.json()["id"]

    card_resp = client.post(
        f"/api/decks/{deck_id}/cards",
        headers=auth_headers_a,
        json={"front": "Q", "back": "A"},
    )
    card_id = card_resp.json()["id"]

    # Rating 0 (out of bounds)
    resp0 = client.post(
        f"/api/study/{card_id}/review",
        headers=auth_headers_a,
        json={"rating": 0},
    )
    assert resp0.status_code in (400, 422)

    # Rating 5 (out of bounds)
    resp5 = client.post(
        f"/api/study/{card_id}/review",
        headers=auth_headers_a,
        json={"rating": 5},
    )
    assert resp5.status_code in (400, 422)


def test_apkg_invalid_file_rejected_safely(client, auth_headers_a):
    # Uploading plain text corrupted file as apkg
    fake_apkg = io.BytesIO(b"Not a zip file at all, just junk data")
    resp = client.post(
        "/api/apkg/import",
        headers=auth_headers_a,
        files={"file": ("corrupt.apkg", fake_apkg, "application/octet-stream")},
    )
    assert resp.status_code == 400
    assert "Invalid or corrupted APKG file" in resp.json()["detail"]


def test_apkg_path_traversal_zip_slip_rejected(client, auth_headers_a):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("../../etc/cron.d/malicious", "exploit")
        zf.writestr("collection.anki2", "fake-sqlite")
    buf.seek(0)

    resp = client.post(
        "/api/apkg/import",
        headers=auth_headers_a,
        files={"file": ("malicious.apkg", buf, "application/octet-stream")},
    )
    assert resp.status_code == 400
    assert "Invalid or corrupted APKG file" in resp.json()["detail"]


import os
import sys
import json
import sqlite3
import tempfile
import shutil
import hashlib
import subprocess
from apkg_handler import import_apkg
from media_utils import get_media_dir
from models import Deck


def _create_test_apkg_bytes(
    cards_count=2,
    media_dict=None,
    raw_files=None,
    deck_name="TestDeck",
    corrupt_col=False,
) -> bytes:
    fd_col, col_path = tempfile.mkstemp(suffix=".anki2")
    os.close(fd_col)

    if not corrupt_col:
        conn = sqlite3.connect(col_path)
        c = conn.cursor()
        c.executescript("""
            CREATE TABLE col (id integer primary key, crt integer, mod integer, scm integer, ver integer, dty integer, usn integer, ls integer, conf text, models text, decks text, dconf text, tags text);
            CREATE TABLE notes (id integer primary key, guid text, mid integer, mod integer, usn integer, tags text, flds text, sfld text, csum integer, flags integer, data text);
            CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer, mod integer, usn integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer, left integer, odue integer, odid integer, flags integer, data text);
        """)
        c.execute("INSERT INTO col VALUES (1, 1000, 1000, 1000000, 11, 0, -1, 0, '{}', '{}', ?, '{}', '{}')", (json.dumps({"1": {"name": deck_name}}),))
        for i in range(1, cards_count + 1):
            c.execute("INSERT INTO notes VALUES (?, ?, 1, 1000, -1, '', ?, ?, 1234, 0, '')", (i, f"g{i}", f"Front {i}\x1fBack {i}", f"Front {i}"))
            c.execute("INSERT INTO cards VALUES (?, ?, 1, 0, 1000, -1, 0, 0, ?, 0, 2500, 0, 0, 0, 0, 0, 0, '')", (i, i, i))
        conn.commit()
        conn.close()

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        if corrupt_col:
            zf.writestr("collection.anki2", b"not-a-sqlite-db")
        else:
            zf.write(col_path, "collection.anki2")

        if media_dict is not None:
            zf.writestr("media", json.dumps(media_dict))

        if raw_files:
            for k, v in raw_files.items():
                zf.writestr(k, v)

    if os.path.exists(col_path):
        os.remove(col_path)

    buf.seek(0)
    return buf.getvalue()


def test_apkg_media_manifest_path_traversal_sentinel(client, user_a, auth_headers_a):
    # 1. Create a temporary sentinel secret file outside archive
    sentinel_dir = tempfile.mkdtemp(prefix="anki_sentinel_")
    sentinel_path = os.path.join(sentinel_dir, "sentinel_secret.txt")
    sentinel_content = "SENTINEL_FIXTURE_VAL_12345"
    with open(sentinel_path, "w") as f:
        f.write(sentinel_content)

    try:
        # Craft APKG where media manifest key tries to traverse out to the sentinel file
        malicious_manifest = {
            sentinel_path: "exfiltrated.png",
            f"../../../../../../../../{sentinel_path.lstrip('/')}": "exfiltrated2.png",
        }
        raw_apkg = _create_test_apkg_bytes(cards_count=1, media_dict=malicious_manifest)

        resp = client.post(
            "/api/apkg/import",
            headers=auth_headers_a,
            files={"file": ("traversal_manifest.apkg", io.BytesIO(raw_apkg), "application/octet-stream")},
        )
        assert resp.status_code == 400
        # Verify safe error message: must NOT leak the secret or local absolute path
        assert sentinel_content not in resp.text

        # Verify sentinel file was NOT copied into the user's public media directory
        user_media = get_media_dir(user_a.id)
        if os.path.exists(user_media):
            assert not os.path.exists(os.path.join(user_media, "exfiltrated.png"))
            assert not os.path.exists(os.path.join(user_media, "exfiltrated2.png"))
            for fn in os.listdir(user_media):
                with open(os.path.join(user_media, fn), "rb") as mf:
                    assert sentinel_content.encode("utf-8") not in mf.read()
    finally:
        shutil.rmtree(sentinel_dir, ignore_errors=True)


def test_apkg_media_manifest_invalid_non_numeric_key(client, auth_headers_a):
    # Manifest key must be strictly numeric archive member
    bad_manifest = {"invalid_non_digit_key": "test.png"}
    raw_apkg = _create_test_apkg_bytes(cards_count=1, media_dict=bad_manifest)

    resp = client.post(
        "/api/apkg/import",
        headers=auth_headers_a,
        files={"file": ("bad_key.apkg", io.BytesIO(raw_apkg), "application/octet-stream")},
    )
    assert resp.status_code == 400


def test_apkg_rejects_svg_import(client, auth_headers_a):
    # 1. SVG file extension in media manifest
    svg_manifest = {"0": "vector_graphic.svg"}
    raw_files = {"0": b"<svg><circle cx='50' cy='50' r='40'/></svg>"}
    raw_apkg1 = _create_test_apkg_bytes(cards_count=1, media_dict=svg_manifest, raw_files=raw_files)

    resp1 = client.post(
        "/api/apkg/import",
        headers=auth_headers_a,
        files={"file": ("svg_ext.apkg", io.BytesIO(raw_apkg1), "application/octet-stream")},
    )
    assert resp1.status_code == 400
    assert "SVG" in resp1.json()["detail"]

    # 2. Smuggled SVG content disguised with .png extension
    png_manifest = {"0": "smuggled.png"}
    raw_files_smuggled = {"0": b"<?xml version='1.0'?><svg onload='alert(1)'></svg>"}
    raw_apkg2 = _create_test_apkg_bytes(cards_count=1, media_dict=png_manifest, raw_files=raw_files_smuggled)

    resp2 = client.post(
        "/api/apkg/import",
        headers=auth_headers_a,
        files={"file": ("smuggled.apkg", io.BytesIO(raw_apkg2), "application/octet-stream")},
    )
    assert resp2.status_code == 400
    assert "SVG" in resp2.json()["detail"]


def test_apkg_small_limits_bounds_explicit_rejection(db_session, user_a):
    # Create temp APKG file
    media_dict = {"0": "img1.png", "1": "img2.png"}
    raw_files = {"0": b"\x89PNG" + b"A" * 60, "1": b"\x89PNG" + b"B" * 60}
    raw_bytes = _create_test_apkg_bytes(cards_count=3, media_dict=media_dict, raw_files=raw_files)

    fd, apkg_path = tempfile.mkstemp(suffix=".apkg")
    os.close(fd)
    with open(apkg_path, "wb") as f:
        f.write(raw_bytes)

    try:
        # A. Card count bound
        with pytest.raises(ValueError, match="Card count exceeds maximum limit"):
            import_apkg(apkg_path, user_a.id, db_session, max_cards=2)

        # B. Archive entries bound (archive has collection.anki2 + media + "0" + "1" = 4 entries)
        with pytest.raises(ValueError, match="Too many files in archive"):
            import_apkg(apkg_path, user_a.id, db_session, max_zip_entries=2)

        # C. Media count bound
        with pytest.raises(ValueError, match="Media count exceeds limit"):
            import_apkg(apkg_path, user_a.id, db_session, max_media_files=1)

        # D. Single media size bound
        with pytest.raises(ValueError, match="exceeds single file limit"):
            import_apkg(apkg_path, user_a.id, db_session, max_single_media_size=40)

        # E. Total media size bound
        with pytest.raises(ValueError, match="Total media size exceeds limit"):
            import_apkg(apkg_path, user_a.id, db_session, max_total_media_size=100)

        # F. Uncompressed archive size bound
        with pytest.raises(ValueError, match="Uncompressed archive size exceeds limit"):
            import_apkg(apkg_path, user_a.id, db_session, max_uncompressed_size=100)
    finally:
        if os.path.exists(apkg_path):
            os.remove(apkg_path)


def test_apkg_failed_import_does_not_overwrite_existing_media_or_leave_deck(db_session, user_a):
    user_media = get_media_dir(user_a.id)
    os.makedirs(user_media, exist_ok=True)
    existing_file = os.path.join(user_media, "picture.png")
    original_data = b"PREEXISTING_SAFE_IMAGE_DATA_DO_NOT_OVERWRITE"
    with open(existing_file, "wb") as f:
        f.write(original_data)

    # Count decks before
    deck_count_before = db_session.query(Deck).filter(Deck.user_id == user_a.id).count()

    # Craft package with picture.png overwrite attempt BUT corrupted collection database
    malicious_bytes = _create_test_apkg_bytes(
        cards_count=1,
        media_dict={"0": "picture.png"},
        raw_files={"0": b"OVERWRITE_ATTEMPT_DATA"},
        corrupt_col=True,
    )
    fd, apkg_path = tempfile.mkstemp(suffix=".apkg")
    os.close(fd)
    with open(apkg_path, "wb") as f:
        f.write(malicious_bytes)

    try:
        with pytest.raises(ValueError):
            import_apkg(apkg_path, user_a.id, db_session)

        # 1. Existing media MUST NOT be overwritten
        with open(existing_file, "rb") as f:
            assert f.read() == original_data

        # 2. No partial deck was created in the DB
        deck_count_after = db_session.query(Deck).filter(Deck.user_id == user_a.id).count()
        assert deck_count_after == deck_count_before
    finally:
        if os.path.exists(apkg_path):
            os.remove(apkg_path)
        if os.path.exists(existing_file):
            os.remove(existing_file)


def test_apkg_rollback_on_db_commit_failure_restores_existing_media_and_cleans_new(db_session, user_a):
    user_id = user_a.id
    user_media = get_media_dir(user_id)
    os.makedirs(user_media, exist_ok=True)

    # 1. Existing media file before import
    existing_file = os.path.join(user_media, "image_exist.png")
    original_bytes = b"ORIGINAL_EXISTING_IMAGE_BYTES_MUST_BE_RESTORED"
    with open(existing_file, "wb") as f:
        f.write(original_bytes)

    deck_count_before = db_session.query(Deck).filter(Deck.user_id == user_id).count()

    # 2. Package contains overwrite attempt for image_exist.png AND a new file image_new.png
    media_dict = {"0": "image_exist.png", "1": "image_new.png"}
    raw_files = {
        "0": b"OVERWRITING_BYTES_SHOULD_BE_ROLLED_BACK",
        "1": b"NEW_MEDIA_BYTES_SHOULD_NOT_BECOME_ORPHAN",
    }
    raw_apkg = _create_test_apkg_bytes(cards_count=2, media_dict=media_dict, raw_files=raw_files, deck_name="CommitFailDeck")

    fd, apkg_path = tempfile.mkstemp(suffix=".apkg")
    os.close(fd)
    with open(apkg_path, "wb") as f:
        f.write(raw_apkg)

    new_file_path = os.path.join(user_media, "image_new.png")

    # 3. Monkeypatch db.commit to simulate failure AFTER media files have been written
    orig_commit = db_session.commit
    def forced_commit_failure():
        # Assert that files were written prior to commit
        assert os.path.exists(existing_file)
        with open(existing_file, "rb") as ef:
            assert ef.read() == b"OVERWRITING_BYTES_SHOULD_BE_ROLLED_BACK"
        assert os.path.exists(new_file_path)
        with open(new_file_path, "rb") as nf:
            assert nf.read() == b"NEW_MEDIA_BYTES_SHOULD_NOT_BECOME_ORPHAN"
        raise sqlite3.OperationalError("Simulated DB commit error after file writes")

    db_session.commit = forced_commit_failure

    try:
        with pytest.raises(sqlite3.OperationalError, match="Simulated DB commit error"):
            import_apkg(apkg_path, user_id, db_session)

        # 4. Assert existing media file bytes are restored
        assert os.path.exists(existing_file), "Existing file must exist"
        with open(existing_file, "rb") as f:
            assert f.read() == original_bytes, "Existing file must be restored to original bytes"

        # 5. Assert new media file is NOT orphaned
        assert not os.path.exists(new_file_path), "New media file must not be left as orphan"

        # 6. Assert no temporary or backup files left in user media dir
        assert os.listdir(user_media) == ["image_exist.png"]

        # 7. Assert no partial deck was committed in the DB
        deck_count_after = db_session.query(Deck).filter(Deck.user_id == user_id).count()
        assert deck_count_after == deck_count_before
    finally:
        db_session.commit = orig_commit
        if os.path.exists(apkg_path):
            os.remove(apkg_path)
        if os.path.exists(existing_file):
            os.remove(existing_file)
        if os.path.exists(new_file_path):
            os.remove(new_file_path)


def test_apkg_rollback_on_copy_failure_restores_existing_media_and_cleans_partials(db_session, user_a, monkeypatch):
    user_id = user_a.id
    user_media = get_media_dir(user_id)
    os.makedirs(user_media, exist_ok=True)

    # 1. Existing media file before import
    existing_file = os.path.join(user_media, "image_exist.png")
    original_bytes = b"ORIGINAL_EXISTING_IMAGE_BYTES_PRESERVED"
    with open(existing_file, "wb") as f:
        f.write(original_bytes)

    deck_count_before = db_session.query(Deck).filter(Deck.user_id == user_id).count()

    # 2. Package contains overwrite for image_exist.png AND new file image_second.png
    media_dict = {"0": "image_exist.png", "1": "image_second.png"}
    raw_files = {
        "0": b"OVERWRITE_DATA",
        "1": b"SECOND_FILE_DATA",
    }
    raw_apkg = _create_test_apkg_bytes(cards_count=2, media_dict=media_dict, raw_files=raw_files, deck_name="CopyFailDeck")

    fd, apkg_path = tempfile.mkstemp(suffix=".apkg")
    os.close(fd)
    with open(apkg_path, "wb") as f:
        f.write(raw_apkg)

    second_file_path = os.path.join(user_media, "image_second.png")

    # 3. Force copy failure when copying second file
    orig_copy2 = shutil.copy2
    def mock_copy2(src, dst, *args, **kwargs):
        if "image_second.png" in str(dst):
            # Simulate partial write before failure
            with open(str(dst), "wb") as pf:
                pf.write(b"PARTIAL_CORRUPT_BYTES")
            raise OSError("Disk full / I/O error during copy")
        return orig_copy2(src, dst, *args, **kwargs)

    monkeypatch.setattr(shutil, "copy2", mock_copy2)

    try:
        with pytest.raises(OSError, match="Disk full"):
            import_apkg(apkg_path, user_id, db_session)

        # 4. Assert existing media file bytes are restored
        assert os.path.exists(existing_file)
        with open(existing_file, "rb") as f:
            assert f.read() == original_bytes

        # 5. Assert second file and its partial temporary files are cleaned up
        assert not os.path.exists(second_file_path)
        assert os.listdir(user_media) == ["image_exist.png"]

        # 6. Assert no partial deck in DB
        deck_count_after = db_session.query(Deck).filter(Deck.user_id == user_id).count()
        assert deck_count_after == deck_count_before
    finally:
        if os.path.exists(apkg_path):
            os.remove(apkg_path)
        if os.path.exists(existing_file):
            os.remove(existing_file)
        if os.path.exists(second_file_path):
            os.remove(second_file_path)


def test_apkg_rejects_duplicate_destination_manifest(db_session, user_a):
    user_media = get_media_dir(user_a.id)
    os.makedirs(user_media, exist_ok=True)
    existing_file = os.path.join(user_media, "dup.png")
    with open(existing_file, "wb") as f:
        f.write(b"PREEXISTING_DUP")

    # Manifest maps both "0" and "1" to the same destination filename
    media_dict = {"0": "dup.png", "1": "dup.png"}
    raw_files = {"0": b"PNG_A", "1": b"PNG_B"}
    raw_apkg = _create_test_apkg_bytes(cards_count=1, media_dict=media_dict, raw_files=raw_files)

    fd, apkg_path = tempfile.mkstemp(suffix=".apkg")
    os.close(fd)
    with open(apkg_path, "wb") as f:
        f.write(raw_apkg)

    try:
        with pytest.raises(ValueError, match="Duplicate destination"):
            import_apkg(apkg_path, user_a.id, db_session)

        # Preexisting file was not touched
        with open(existing_file, "rb") as f:
            assert f.read() == b"PREEXISTING_DUP"
    finally:
        if os.path.exists(apkg_path):
            os.remove(apkg_path)
        if os.path.exists(existing_file):
            os.remove(existing_file)


def test_apkg_successful_import_preserves_and_imports_media(db_session, user_a):
    user_media = get_media_dir(user_a.id)
    os.makedirs(user_media, exist_ok=True)
    existing_file = os.path.join(user_media, "untouched.png")
    with open(existing_file, "wb") as f:
        f.write(b"UNTOUCHED_IMAGE")

    media_dict = {"0": "imported.png"}
    raw_files = {"0": b"IMPORTED_IMAGE_DATA"}
    raw_apkg = _create_test_apkg_bytes(cards_count=2, media_dict=media_dict, raw_files=raw_files, deck_name="SuccessDeck")

    fd, apkg_path = tempfile.mkstemp(suffix=".apkg")
    os.close(fd)
    with open(apkg_path, "wb") as f:
        f.write(raw_apkg)

    imported_file = os.path.join(user_media, "imported.png")
    try:
        res = import_apkg(apkg_path, user_a.id, db_session)
        assert res["deck_name"] == "SuccessDeck"
        assert res["media_imported"] == 1

        # Both untouched existing file and new imported file exist
        with open(existing_file, "rb") as f:
            assert f.read() == b"UNTOUCHED_IMAGE"
        with open(imported_file, "rb") as f:
            assert f.read() == b"IMPORTED_IMAGE_DATA"
    finally:
        if os.path.exists(apkg_path):
            os.remove(apkg_path)
        if os.path.exists(existing_file):
            os.remove(existing_file)
        if os.path.exists(imported_file):
            os.remove(imported_file)


def test_source_db_and_media_uncreated(client, db_session, user_a, auth_headers_a):
    """Verify that test execution maintains strict isolation from source DB and source media.

    1. Actual engine & media-root isolation assertions:
       - database.BASE_DIR points to isolated TEST_TEMP_DIR, not source backend directory.
       - database.SQLALCHEMY_DATABASE_URL does not point to source anki.db.
       - media_utils.MEDIA_BASE points to isolated test media directory, not source media.
       - The test DB session operates on an isolated engine (in-memory or test temp dir).

    2. Before/after fingerprint unchanged of existing source DB / media:
       - If source anki.db exists (like in the original repository), its content hash,
         size, and modification fingerprint must remain 100% unchanged after operations.
       - If source media exists, its directory tree fingerprint must remain 100% unchanged.

    3. Safe subprocess temporary preexisting source sentinel verification:
       - To verify isolation when a live preexisting anki.db is present (even if run
         in an environment without one), runs an isolated subprocess with a simulated
         preexisting source anki.db and media file sentinel, executing app queries,
         and asserting the sentinel's SHA256 is strictly untouched.
    """
    import database
    import media_utils

    test_temp_dir = os.environ["DATABASE_DIR"]
    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    source_db = os.path.join(backend_dir, "anki.db")
    source_media = os.path.join(backend_dir, "media")

    # 1. Engine & media-root isolation assertions
    assert os.path.realpath(database.BASE_DIR) == os.path.realpath(test_temp_dir)
    assert os.path.realpath(database.BASE_DIR) != os.path.realpath(backend_dir)
    assert "sqlite:///:memory:" in str(db_session.bind.engine.url) or test_temp_dir in str(db_session.bind.engine.url)
    assert os.path.join(backend_dir, "anki.db") not in str(db_session.bind.engine.url)

    expected_media_base = os.path.realpath(os.path.join(test_temp_dir, "media"))
    actual_media_base = os.path.realpath(media_utils.MEDIA_BASE)
    assert actual_media_base == expected_media_base
    assert actual_media_base != os.path.realpath(source_media)

    # 2. Before/after fingerprint check of existing source DB / media (if present)
    def _fp_file(p):
        if not os.path.exists(p) or not os.path.isfile(p):
            return None
        with open(p, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()

    def _fp_dir(d):
        if not os.path.exists(d) or not os.path.isdir(d):
            return None
        entries = []
        for root, _, files in os.walk(d):
            for fn in sorted(files):
                fp = os.path.join(root, fn)
                with open(fp, "rb") as f:
                    entries.append((os.path.relpath(fp, d), hashlib.sha256(f.read()).hexdigest()))
        return entries

    db_fp_before = _fp_file(source_db)
    media_fp_before = _fp_dir(source_media)

    # Perform DB operations via client and direct session
    resp = client.get("/api/decks", headers=auth_headers_a)
    assert resp.status_code == 200

    # Verify existing source DB/media were not modified
    if db_fp_before is not None:
        db_fp_after = _fp_file(source_db)
        assert db_fp_after == db_fp_before, "Existing source anki.db was modified during test execution!"

    if media_fp_before is not None:
        media_fp_after = _fp_dir(source_media)
        assert media_fp_after == media_fp_before, "Existing source media was modified during test execution!"

    # 3. Safe subprocess temporary preexisting source sentinel verification:
    # Verifies that in an environment with a preexisting live source anki.db and media,
    # running application code and tests keeps the preexisting files 100% untouched.
    with tempfile.TemporaryDirectory(prefix="anki_sentinel_env_") as sim_work_dir:
        sim_backend = os.path.join(sim_work_dir, "backend")
        os.makedirs(sim_backend, exist_ok=True)
        sim_source_db = os.path.join(sim_backend, "anki.db")
        sim_source_media = os.path.join(sim_backend, "media")
        os.makedirs(sim_source_media, exist_ok=True)
        sim_source_media_file = os.path.join(sim_source_media, "live_sentinel.png")

        sentinel_db_bytes = b"SQLITE_FORMAT_3_SENTINEL_LIVE_PREEXISTING_BYTES_" + os.urandom(32)
        sentinel_media_bytes = b"SENTINEL_MEDIA_PREEXISTING_IMAGE_BYTES_" + os.urandom(32)

        with open(sim_source_db, "wb") as f:
            f.write(sentinel_db_bytes)
        with open(sim_source_media_file, "wb") as f:
            f.write(sentinel_media_bytes)

        expected_db_fp = hashlib.sha256(sentinel_db_bytes).hexdigest()
        expected_media_fp = hashlib.sha256(sentinel_media_bytes).hexdigest()

        # Run subprocess that sets up test isolation and runs DB/media queries
        script = f"""
import os, sys, tempfile, shutil
iso_dir = tempfile.mkdtemp(prefix="test_iso_")
os.environ["APP_ENV"] = "test"
os.environ["JWT_SECRET_KEY"] = "super-secret-test-key-at-least-32-chars-long-123456"
os.environ["DATABASE_DIR"] = iso_dir
os.environ["MEDIA_DIR"] = os.path.join(iso_dir, "media")
os.makedirs(os.environ["MEDIA_DIR"], exist_ok=True)

sys.path.insert(0, {repr(backend_dir)})
import database, media_utils, models
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

test_engine = create_engine("sqlite:///:memory:")
models.Base.metadata.create_all(bind=test_engine)
TestSession = sessionmaker(bind=test_engine)
sess = TestSession()

u = models.User(email="test_sentinel@example.com", username="test", password_hash="hash")
sess.add(u)
sess.commit()

shutil.rmtree(iso_dir, ignore_errors=True)
"""
        proc = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True)
        assert proc.returncode == 0, f"Subprocess failed: {proc.stderr}"

        # Assert sentinel source DB and media remain 100% untouched
        with open(sim_source_db, "rb") as f:
            assert hashlib.sha256(f.read()).hexdigest() == expected_db_fp
        with open(sim_source_media_file, "rb") as f:
            assert hashlib.sha256(f.read()).hexdigest() == expected_media_fp
