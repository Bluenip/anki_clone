import re
import pytest
from models import Card, Note, SchedulerState, StudyProgress


HEX_64_PATTERN = re.compile(r"^[0-9a-f]{64}$")


def create_deck(client, headers, name="Concurrency Test Deck"):
    response = client.post("/api/decks", headers=headers, json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def create_note(client, headers, deck_id, kind="basic", fields=None, tags=None):
    if fields is None:
        fields = {"Front": "Question 1", "Back": "Answer 1"}
    payload = {
        "deck_id": deck_id,
        "kind": kind,
        "fields": fields,
        "tags": tags if tags is not None else [],
    }
    response = client.post("/api/notes", headers=headers, json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def test_persisted_note_adds_revision_opaque64hex(client, auth_headers_a):
    deck_id = create_deck(client, auth_headers_a, "Revision Format Deck")
    note = create_note(client, auth_headers_a, deck_id, kind="reversed",
                       fields={"Front": "Front Q", "Back": "Back A"}, tags=["tag1"])

    # POST response includes 64-character lowercase hex revision
    assert "revision" in note
    assert isinstance(note["revision"], str)
    assert len(note["revision"]) == 64
    assert HEX_64_PATTERN.match(note["revision"])

    # GET persisted note endpoint adds the same opaque 64-hex revision
    get_resp = client.get(f"/api/notes/{note['id']}", headers=auth_headers_a)
    assert get_resp.status_code == 200, get_resp.text
    note_get = get_resp.json()
    assert note_get["revision"] == note["revision"]
    assert HEX_64_PATTERN.match(note_get["revision"])

    # GET /api/cards/{card_id}/note on a persisted note's card also returns the same revision
    card_id = note["cards"][0]["id"]
    card_note_resp = client.get(f"/api/cards/{card_id}/note", headers=auth_headers_a)
    assert card_note_resp.status_code == 200, card_note_resp.text
    card_note = card_note_resp.json()
    assert card_note["id"] == note["id"]
    assert card_note["revision"] == note["revision"]
    assert HEX_64_PATTERN.match(card_note["revision"])


def test_two_editors_same_revision_first_succeeds_second_409(client, auth_headers_a):
    deck_id = create_deck(client, auth_headers_a, "Two Editors Deck")
    note = create_note(client, auth_headers_a, deck_id, kind="reversed",
                       fields={"Front": "Original Q", "Back": "Original A"}, tags=["shared"])
    note_id = note["id"]
    initial_revision = note["revision"]
    original_card_ids = [c["id"] for c in note["cards"]]
    assert len(original_card_ids) == 2

    # Two editors load the note at the same initial revision
    editor1_expected_rev = initial_revision
    editor2_expected_rev = initial_revision

    # Editor 1 saves first -> succeeds (200)
    e1_payload = {
        "fields": {"Front": "Editor 1 Q", "Back": "Editor 1 A"},
        "tags": ["shared", "from_editor_1"],
        "expected_revision": editor1_expected_rev,
    }
    e1_resp = client.put(f"/api/notes/{note_id}", headers=auth_headers_a, json=e1_payload)
    assert e1_resp.status_code == 200, e1_resp.text
    e1_data = e1_resp.json()
    new_revision = e1_data["revision"]
    assert new_revision != initial_revision
    assert HEX_64_PATTERN.match(new_revision)
    assert e1_data["fields"] == {"Front": "Editor 1 Q", "Back": "Editor 1 A"}
    assert e1_data["tags"] == ["shared", "from_editor_1"]

    # Editor 2 attempts to save with now-stale initial_revision -> rejects with 409
    e2_payload = {
        "fields": {"Front": "Editor 2 Overwrite Q", "Back": "Editor 2 Overwrite A"},
        "tags": ["shared", "from_editor_2"],
        "expected_revision": editor2_expected_rev,
    }
    e2_resp = client.put(f"/api/notes/{note_id}", headers=auth_headers_a, json=e2_payload)
    assert e2_resp.status_code == 409, e2_resp.text

    # Editor 1's fields, tags, and cards are strictly preserved
    stored = client.get(f"/api/notes/{note_id}", headers=auth_headers_a).json()
    assert stored["revision"] == new_revision
    assert stored["fields"] == {"Front": "Editor 1 Q", "Back": "Editor 1 A"}
    assert stored["tags"] == ["shared", "from_editor_1"]
    assert len(stored["cards"]) == 2
    assert [c["id"] for c in stored["cards"]] == original_card_ids
    assert stored["cards"][0]["front"] == "Editor 1 Q"
    assert "Editor 1 A" in stored["cards"][0]["back"]
    assert stored["cards"][1]["front"] == "Editor 1 A"
    assert "Editor 1 Q" in stored["cards"][1]["back"]


def test_backward_callers_omit_expected_revision_allowed(client, auth_headers_a):
    deck_id = create_deck(client, auth_headers_a, "Backward Compat Deck")
    note = create_note(client, auth_headers_a, deck_id, kind="basic",
                       fields={"Front": "Initial Q", "Back": "Initial A"}, tags=["init"])
    note_id = note["id"]
    rev_before = note["revision"]

    # Backward caller sends PUT without expected_revision field
    payload = {
        "fields": {"Front": "Backward Front", "Back": "Backward Back"},
        "tags": ["init", "backward_caller"],
    }
    resp = client.put(f"/api/notes/{note_id}", headers=auth_headers_a, json=payload)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["fields"] == {"Front": "Backward Front", "Back": "Backward Back"}
    assert data["tags"] == ["init", "backward_caller"]
    assert data["revision"] != rev_before
    assert HEX_64_PATTERN.match(data["revision"])

    # Reloading returns updated state and new revision
    reloaded = client.get(f"/api/notes/{note_id}", headers=auth_headers_a).json()
    assert reloaded["fields"] == data["fields"]
    assert reloaded["tags"] == data["tags"]
    assert reloaded["revision"] == data["revision"]


def test_bulk_tag_on_hidden_reversed_sibling_invalidates_loaded_note(client, auth_headers_a):
    deck_id = create_deck(client, auth_headers_a, "Sibling Bulk Tag Deck")
    note = create_note(client, auth_headers_a, deck_id, kind="reversed",
                       fields={"Front": "Question", "Back": "Answer"}, tags=["original"])
    note_id = note["id"]
    loaded_revision = note["revision"]

    # Note has two cards: Card 1 (direct) and Card 2 (reversed sibling)
    assert len(note["cards"]) == 2
    sibling_card_id = note["cards"][1]["id"]

    # While note is loaded in an editor tab, user in browser applies bulk tag to the sibling card
    bulk_resp = client.post("/api/cards/bulk-action", headers=auth_headers_a, json={
        "action": "add_tags",
        "cards": [{"card_id": sibling_card_id, "expected_version": 0}],
        "tags": ["marked-reverse"],
    })
    assert bulk_resp.status_code == 200, bulk_resp.text

    # Editor now attempts to save using the previously loaded revision -> 409 Conflict
    save_resp = client.put(f"/api/notes/{note_id}", headers=auth_headers_a, json={
        "fields": {"Front": "Stale Save Q", "Back": "Answer"},
        "tags": ["original"],
        "expected_revision": loaded_revision,
    })
    assert save_resp.status_code == 409, save_resp.text

    # Reloading note reflects the added tag and provides the new revision
    refreshed = client.get(f"/api/notes/{note_id}", headers=auth_headers_a).json()
    assert "marked-reverse" in refreshed["tags"]
    assert refreshed["revision"] != loaded_revision

    # Subsequent save with new revision succeeds
    valid_resp = client.put(f"/api/notes/{note_id}", headers=auth_headers_a, json={
        "fields": {"Front": "Fresh Save Q", "Back": "Answer"},
        "tags": refreshed["tags"],
        "expected_revision": refreshed["revision"],
    })
    assert valid_resp.status_code == 200, valid_resp.text
    assert valid_resp.json()["fields"]["Front"] == "Fresh Save Q"


def test_card_move_invalidates_revision(client, auth_headers_a):
    deck_1 = create_deck(client, auth_headers_a, "Source Deck")
    deck_2 = create_deck(client, auth_headers_a, "Target Deck")
    note = create_note(client, auth_headers_a, deck_1, kind="reversed",
                       fields={"Front": "Move Q", "Back": "Move A"})
    note_id = note["id"]
    loaded_revision = note["revision"]
    first_card_id = note["cards"][0]["id"]

    # Move first card to deck_2 via bulk action
    move_resp = client.post("/api/cards/bulk-action", headers=auth_headers_a, json={
        "action": "move",
        "target_deck_id": deck_2,
        "cards": [{"card_id": first_card_id, "expected_version": 0}],
    })
    assert move_resp.status_code == 200, move_resp.text

    # Saving note using stale revision before the card move is rejected with 409
    save_resp = client.put(f"/api/notes/{note_id}", headers=auth_headers_a, json={
        "fields": {"Front": "Moved Edit Q", "Back": "Move A"},
        "expected_revision": loaded_revision,
    })
    assert save_resp.status_code == 409, save_resp.text

    # Reloaded note reflects new deck_id on card and new revision
    reloaded = client.get(f"/api/notes/{note_id}", headers=auth_headers_a).json()
    assert reloaded["revision"] != loaded_revision
    cards_by_id = {c["id"]: c for c in reloaded["cards"]}
    assert cards_by_id[first_card_id]["deck_id"] == deck_2

    # Saving with updated revision succeeds
    valid_save = client.put(f"/api/notes/{note_id}", headers=auth_headers_a, json={
        "fields": {"Front": "Moved Edit Q", "Back": "Move A"},
        "expected_revision": reloaded["revision"],
    })
    assert valid_save.status_code == 200, valid_save.text


def test_card_deletion_invalidates_revision(client, auth_headers_a):
    deck_id = create_deck(client, auth_headers_a, "Deletion Invalidation Deck")
    note = create_note(client, auth_headers_a, deck_id, kind="reversed",
                       fields={"Front": "Del Q", "Back": "Del A"})
    note_id = note["id"]
    loaded_revision = note["revision"]
    second_card_id = note["cards"][1]["id"]

    # Delete the second card
    del_resp = client.delete(f"/api/cards/{second_card_id}", headers=auth_headers_a)
    assert del_resp.status_code == 204, del_resp.text

    # Attempting to save note with pre-deletion revision is rejected with 409
    save_resp = client.put(f"/api/notes/{note_id}", headers=auth_headers_a, json={
        "fields": {"Front": "Del Edit Q", "Back": "Del A"},
        "expected_revision": loaded_revision,
    })
    assert save_resp.status_code == 409, save_resp.text

    # Note still exists with the remaining card and has a new revision
    reloaded = client.get(f"/api/notes/{note_id}", headers=auth_headers_a).json()
    assert reloaded["revision"] != loaded_revision
    assert len(reloaded["cards"]) == 1
    assert reloaded["cards"][0]["id"] == note["cards"][0]["id"]


def test_failed_invalid_rendering_does_not_consume_revision(client, auth_headers_a):
    deck_id = create_deck(client, auth_headers_a, "Rendering Deck")
    note = create_note(client, auth_headers_a, deck_id, kind="cloze",
                       fields={"Text": "{{c1::Paris}} is the capital", "Extra": "France"})
    note_id = note["id"]
    original_revision = note["revision"]

    # Attempt an edit with invalid cloze rendering (no cloze tag in Text)
    invalid_resp = client.put(f"/api/notes/{note_id}", headers=auth_headers_a, json={
        "fields": {"Text": "Text without any cloze tag", "Extra": "France"},
        "expected_revision": original_revision,
    })
    assert invalid_resp.status_code == 400, invalid_resp.text

    # The note's revision was not consumed or altered by the failure
    check_resp = client.get(f"/api/notes/{note_id}", headers=auth_headers_a)
    assert check_resp.status_code == 200
    assert check_resp.json()["revision"] == original_revision
    assert check_resp.json()["fields"]["Text"] == "{{c1::Paris}} is the capital"

    # Saving valid cloze fields with the original revision succeeds
    valid_resp = client.put(f"/api/notes/{note_id}", headers=auth_headers_a, json={
        "fields": {"Text": "{{c1::Rome}} is the capital", "Extra": "Italy"},
        "expected_revision": original_revision,
    })
    assert valid_resp.status_code == 200, valid_resp.text
    assert valid_resp.json()["revision"] != original_revision
    assert valid_resp.json()["fields"]["Text"] == "{{c1::Rome}} is the capital"


def test_get_revision_deterministic_read_only_no_scheduler_state_writes(client, auth_headers_a, db_session):
    deck_id = create_deck(client, auth_headers_a, "Deterministic Read Only Deck")
    note = create_note(client, auth_headers_a, deck_id, kind="reversed",
                       fields={"Front": "Det Q", "Back": "Det A"})
    note_id = note["id"]
    card_ids = [c["id"] for c in note["cards"]]

    # Ensure no SchedulerState rows exist for newly created note's cards
    initial_sched_count = (
        db_session.query(SchedulerState).filter(SchedulerState.card_id.in_(card_ids)).count()
    )
    assert initial_sched_count == 0

    # Calling GET /api/notes/{id} multiple times yields identical revision
    rev1 = client.get(f"/api/notes/{note_id}", headers=auth_headers_a).json()["revision"]
    rev2 = client.get(f"/api/notes/{note_id}", headers=auth_headers_a).json()["revision"]
    rev3 = client.get(f"/api/notes/{note_id}", headers=auth_headers_a).json()["revision"]
    assert rev1 == rev2 == rev3
    assert HEX_64_PATTERN.match(rev1)

    # Calling GET /api/cards/{card_id}/note also yields identical matching revision
    card_rev1 = client.get(f"/api/cards/{card_ids[0]}/note", headers=auth_headers_a).json()["revision"]
    card_rev2 = client.get(f"/api/cards/{card_ids[1]}/note", headers=auth_headers_a).json()["revision"]
    assert card_rev1 == rev1
    assert card_rev2 == rev1

    # Zero SchedulerState rows were written by any of the GET requests
    db_session.expire_all()
    final_sched_count = (
        db_session.query(SchedulerState).filter(SchedulerState.card_id.in_(card_ids)).count()
    )
    assert final_sched_count == 0


def test_foreign_user_cannot_access_or_probe_note_and_gets_404(client, auth_headers_a, auth_headers_b):
    deck_a = create_deck(client, auth_headers_a, "User A Deck")
    note_a = create_note(client, auth_headers_a, deck_a, kind="basic",
                         fields={"Front": "Private A", "Back": "Secret A"})
    note_id = note_a["id"]
    card_id = note_a["cards"][0]["id"]
    rev_a = note_a["revision"]

    # User B cannot read User A's note
    assert client.get(f"/api/notes/{note_id}", headers=auth_headers_b).status_code == 404

    # User B cannot edit User A's note with expected_revision
    put_resp_1 = client.put(f"/api/notes/{note_id}", headers=auth_headers_b, json={
        "fields": {"Front": "Hacked Front", "Back": "Hacked Back"},
        "expected_revision": rev_a,
    })
    assert put_resp_1.status_code == 404

    # User B cannot edit User A's note without expected_revision
    put_resp_2 = client.put(f"/api/notes/{note_id}", headers=auth_headers_b, json={
        "fields": {"Front": "Hacked Front", "Back": "Hacked Back"},
    })
    assert put_resp_2.status_code == 404

    # User B cannot read User A's card/note
    assert client.get(f"/api/cards/{card_id}/note", headers=auth_headers_b).status_code == 404

    # User A's note is unchanged
    owner_check = client.get(f"/api/notes/{note_id}", headers=auth_headers_a).json()
    assert owner_check["revision"] == rev_a
    assert owner_check["fields"] == {"Front": "Private A", "Back": "Secret A"}


def test_versioned_cloze_removal_rollback(client, auth_headers_a, user_a, db_session):
    deck_id = create_deck(client, auth_headers_a, "Cloze Rollback Deck")
    note = create_note(client, auth_headers_a, deck_id, kind="cloze",
                       fields={"Text": "{{c1::First}} and {{c2::Second}}", "Extra": "Clues"})
    note_id = note["id"]
    c1_id = note["cards"][0]["id"]
    c2_id = note["cards"][1]["id"]
    initial_revision = note["revision"]

    # Add study progress to c2 card
    progress = StudyProgress(
        user_id=user_a.id,
        card_id=c2_id,
        card_state="review",
        interval_days=20,
    )
    db_session.add(progress)
    db_session.commit()

    # Get current revision after progress was committed
    current_rev = client.get(f"/api/notes/{note_id}", headers=auth_headers_a).json()["revision"]

    # Attempt to remove c2 card which has study progress -> 400 Bad Request
    remove_c2_payload = {
        "fields": {"Text": "{{c1::First}} only without second cloze", "Extra": "Clues"},
        "expected_revision": current_rev,
    }
    resp = client.put(f"/api/notes/{note_id}", headers=auth_headers_a, json=remove_c2_payload)
    assert resp.status_code == 400, resp.text
    assert "study progress" in resp.text

    # Rollback verification: revision, cards, and fields remain intact
    stored = client.get(f"/api/notes/{note_id}", headers=auth_headers_a).json()
    assert stored["revision"] == current_rev
    assert stored["fields"]["Text"] == "{{c1::First}} and {{c2::Second}}"
    assert len(stored["cards"]) == 2
    assert [c["id"] for c in stored["cards"]] == [c1_id, c2_id]

    # Subsequent valid edit with current_rev succeeds
    valid_payload = {
        "fields": {"Text": "{{c1::First}} and {{c2::Second}}", "Extra": "Updated Clues"},
        "expected_revision": current_rev,
    }
    valid_resp = client.put(f"/api/notes/{note_id}", headers=auth_headers_a, json=valid_payload)
    assert valid_resp.status_code == 200, valid_resp.text
    assert valid_resp.json()["fields"]["Extra"] == "Updated Clues"
    assert valid_resp.json()["revision"] != current_rev


def test_legacy_get_card_note_returns_id_null_and_version_read_only(client, auth_headers_a, db_session):
    deck_id = create_deck(client, auth_headers_a, "Legacy Card Deck")

    # Insert a card directly into db_session with no NoteCard link
    legacy_card = Card(deck_id=deck_id, front="Legacy Front", back="Legacy Back")
    db_session.add(legacy_card)
    db_session.commit()
    db_session.refresh(legacy_card)

    card_id = legacy_card.id
    assert legacy_card.note_link is None

    # Initial legacy card without SchedulerState
    resp = client.get(f"/api/cards/{card_id}/note", headers=auth_headers_a)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["id"] is None
    assert data["version"] == 0
    assert data["kind"] == "basic"
    assert data["fields"] == {"Front": "Legacy Front", "Back": "Legacy Back"}
    assert data["cards"] == [{
        "id": card_id,
        "deck_id": deck_id,
        "front": "Legacy Front",
        "back": "Legacy Back",
        "template_ord": 0,
    }]

    # Confirm read-only: No Note or SchedulerState rows were written to the database
    db_session.expire_all()
    assert db_session.query(SchedulerState).filter_by(card_id=card_id).first() is None
    assert db_session.query(Note).count() == 0

    # When card has a SchedulerState row with version > 0, legacy version is returned
    sched_state = SchedulerState(card_id=card_id, version=15)
    db_session.add(sched_state)
    db_session.commit()

    resp_versioned = client.get(f"/api/cards/{card_id}/note", headers=auth_headers_a)
    assert resp_versioned.status_code == 200, resp_versioned.text
    data_versioned = resp_versioned.json()
    assert data_versioned["id"] is None
    assert data_versioned["version"] == 15
    assert db_session.query(Note).count() == 0


def test_expected_revision_format_validation_and_mismatch(client, auth_headers_a):
    deck_id = create_deck(client, auth_headers_a, "Validation Deck")
    note = create_note(client, auth_headers_a, deck_id, kind="basic",
                       fields={"Front": "Val Q", "Back": "Val A"})
    note_id = note["id"]

    # Malformed expected_revision (non-hex, wrong length) rejected with 422
    for bad_rev in ["not-hex", "12345", "a" * 63, "g" * 64, "A" * 64]:
        resp = client.put(f"/api/notes/{note_id}", headers=auth_headers_a, json={
            "fields": {"Front": "Val Q", "Back": "Val A"},
            "expected_revision": bad_rev,
        })
        assert resp.status_code == 422, f"Expected 422 for bad_rev '{bad_rev}', got {resp.status_code}"

    # Valid 64-hex string that does not match current revision rejected with 409
    mismatched_rev = "0" * 64
    assert mismatched_rev != note["revision"]
    resp = client.put(f"/api/notes/{note_id}", headers=auth_headers_a, json={
        "fields": {"Front": "Val Q", "Back": "Val A"},
        "expected_revision": mismatched_rev,
    })
    assert resp.status_code == 409, resp.text
