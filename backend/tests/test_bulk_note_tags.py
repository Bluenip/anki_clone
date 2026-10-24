import json
from datetime import datetime, timedelta, timezone
import pytest
from anki.collection import Collection
from anki.import_export_pb2 import ImportAnkiPackageRequest
from scheduling import utc
from models import Card, Deck, Note, NoteCard, NoteType, PackageNote, SchedulerState, StudyProgress


def create_deck(client, headers, name="Test Deck"):
    response = client.post("/api/decks", headers=headers, json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def create_note(client, headers, deck_id, kind="reversed", fields=None, tags=None):
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


def bulk_action(client, headers, action, cards, tags=None, target_deck_id=None):
    payload = {"action": action, "cards": cards}
    if tags is not None:
        payload["tags"] = tags
    if target_deck_id is not None:
        payload["target_deck_id"] = target_deck_id
    return client.post("/api/cards/bulk-action", headers=headers, json=payload)


def test_schema_errors(client, auth_headers_a):
    deck_id = create_deck(client, auth_headers_a, "Schema Deck")
    note = create_note(client, auth_headers_a, deck_id)
    cid = note["cards"][0]["id"]
    targets = [{"card_id": cid, "expected_version": 0}]

    # Blank tag
    res = bulk_action(client, auth_headers_a, "add_tags", targets, tags=[""])
    assert res.status_code == 422

    # Tags containing whitespace
    for bad_tag in ["foo bar", " leading", "trailing ", "tab\ttag", "new\nline"]:
        res = bulk_action(client, auth_headers_a, "add_tags", targets, tags=[bad_tag])
        assert res.status_code == 422

    # Oversize tag (>100 characters)
    oversize = "a" * 101
    res = bulk_action(client, auth_headers_a, "add_tags", targets, tags=[oversize])
    assert res.status_code == 422

    # Empty tags list
    res = bulk_action(client, auth_headers_a, "add_tags", targets, tags=[])
    assert res.status_code == 422

    # Oversize tag list (>100 tags)
    many_tags = [f"tag{i}" for i in range(101)]
    res = bulk_action(client, auth_headers_a, "add_tags", targets, tags=many_tags)
    assert res.status_code == 422

    # Missing tags field on add_tags and remove_tags
    res = bulk_action(client, auth_headers_a, "add_tags", targets, tags=None)
    assert res.status_code == 422
    res = bulk_action(client, auth_headers_a, "remove_tags", targets, tags=None)
    assert res.status_code == 422

    # Destination target_deck_id provided on non-move actions
    res = bulk_action(client, auth_headers_a, "add_tags", targets, tags=["foo"], target_deck_id=deck_id)
    assert res.status_code == 422
    res = bulk_action(client, auth_headers_a, "remove_tags", targets, tags=["foo"], target_deck_id=deck_id)
    assert res.status_code == 422
    res = bulk_action(client, auth_headers_a, "suspend", targets, target_deck_id=deck_id)
    assert res.status_code == 422

    # Tags provided on non-tag action (e.g. suspend or move)
    res = bulk_action(client, auth_headers_a, "suspend", targets, tags=["foo"])
    assert res.status_code == 422
    res = bulk_action(client, auth_headers_a, "move", targets, tags=["foo"], target_deck_id=deck_id)
    assert res.status_code == 422

    # Duplicate card IDs in batch
    dup_targets = [{"card_id": cid, "expected_version": 0}, {"card_id": cid, "expected_version": 0}]
    res = bulk_action(client, auth_headers_a, "add_tags", dup_targets, tags=["foo"])
    assert res.status_code == 422

    # Empty cards list
    res = bulk_action(client, auth_headers_a, "add_tags", [], tags=["foo"])
    assert res.status_code == 422


def test_add_and_remove_tags_reversed_siblings_and_dedup(client, auth_headers_a, db_session):
    deck_id = create_deck(client, auth_headers_a, "Reversed Deck")
    note_resp = create_note(
        client,
        auth_headers_a,
        deck_id,
        kind="reversed",
        fields={"Front": "Front Q", "Back": "Back A"},
        tags=["initial"],
    )
    cards = note_resp["cards"]
    assert len(cards) == 2
    c1, c2 = cards[0]["id"], cards[1]["id"]

    # Both start at version 0
    s1 = db_session.get(SchedulerState, c1)
    s2 = db_session.get(SchedulerState, c2)
    assert (s1.version if s1 else 0) == 0
    assert (s2.version if s2 else 0) == 0

    # 1. Select only ONE reversed sibling card: tags whole note and bumps both siblings' versions
    res = bulk_action(
        client,
        auth_headers_a,
        "add_tags",
        [{"card_id": c1, "expected_version": 0}],
        tags=["NewTag"],
    )
    assert res.status_code == 200, res.text
    assert res.json() == {"updated": 2, "updated_notes": 1}

    db_session.expire_all()
    note_db = db_session.get(Note, note_resp["id"])
    assert set(json.loads(note_db.tags_json)) == {"initial", "NewTag"}
    assert db_session.get(SchedulerState, c1).version == 1
    assert db_session.get(SchedulerState, c2).version == 1

    # 2. Select TWO sibling cards in the batch: deduplicates note and bumps versions once
    res = bulk_action(
        client,
        auth_headers_a,
        "add_tags",
        [
            {"card_id": c1, "expected_version": 1},
            {"card_id": c2, "expected_version": 1},
        ],
        tags=["SecondTag"],
    )
    assert res.status_code == 200, res.text
    assert res.json() == {"updated": 2, "updated_notes": 1}

    db_session.expire_all()
    note_db = db_session.get(Note, note_resp["id"])
    assert set(json.loads(note_db.tags_json)) == {"initial", "NewTag", "SecondTag"}
    assert db_session.get(SchedulerState, c1).version == 2
    assert db_session.get(SchedulerState, c2).version == 2

    # 3. Payload with duplicate casefolded tags deduplicates preserving first casing
    res = bulk_action(
        client,
        auth_headers_a,
        "add_tags",
        [{"card_id": c1, "expected_version": 2}],
        tags=["ThirdTag", "thirdtag", "THIRDTAG"],
    )
    assert res.status_code == 200, res.text
    db_session.expire_all()
    note_db = db_session.get(Note, note_resp["id"])
    tags_list = json.loads(note_db.tags_json)
    assert "ThirdTag" in tags_list
    assert sum(1 for t in tags_list if t.casefold() == "thirdtag") == 1


def test_case_insensitive_add_remove_and_parent_child_tags(client, auth_headers_a, db_session):
    deck_id = create_deck(client, auth_headers_a, "Tag Deck")
    note_resp = create_note(
        client,
        auth_headers_a,
        deck_id,
        kind="basic",
        fields={"Front": "Q", "Back": "A"},
        tags=["TagA", "parent::child", "parent"],
    )
    cid = note_resp["cards"][0]["id"]

    # Exact case-insensitive add: adding "taga" when "TagA" already exists does not duplicate
    res = bulk_action(
        client,
        auth_headers_a,
        "add_tags",
        [{"card_id": cid, "expected_version": 0}],
        tags=["taga"],
    )
    assert res.status_code == 200, res.text
    db_session.expire_all()
    note_db = db_session.get(Note, note_resp["id"])
    tags_list = json.loads(note_db.tags_json)
    assert sum(1 for t in tags_list if t.casefold() == "taga") == 1
    assert "TagA" in tags_list

    # Native Anki removes the parent and descendant tags together.
    res = bulk_action(
        client,
        auth_headers_a,
        "remove_tags",
        [{"card_id": cid, "expected_version": 1}],
        tags=["parent"],
    )
    assert res.status_code == 200, res.text
    db_session.expire_all()
    note_db = db_session.get(Note, note_resp["id"])
    tags_list = json.loads(note_db.tags_json)
    assert "parent::child" not in tags_list
    assert "parent" not in tags_list

    # Exact case-insensitive remove: "TAGA" removes "TagA"
    res = bulk_action(
        client,
        auth_headers_a,
        "remove_tags",
        [{"card_id": cid, "expected_version": 2}],
        tags=["TAGA"],
    )
    assert res.status_code == 200, res.text
    db_session.expire_all()
    note_db = db_session.get(Note, note_resp["id"])
    tags_list = json.loads(note_db.tags_json)
    assert tags_list == []


def test_cloze_siblings_tag_whole_note_and_bump_all_versions(client, auth_headers_a, db_session):
    deck_id = create_deck(client, auth_headers_a, "Cloze Deck")
    note_resp = client.post(
        "/api/notes",
        headers=auth_headers_a,
        json={
            "deck_id": deck_id,
            "kind": "cloze",
            "fields": {"Text": "{{c1::Hà Nội}} là thủ đô của {{c2::Việt Nam}}", "Extra": "Geography"},
            "tags": ["asia"],
        },
    ).json()
    assert len(note_resp["cards"]) == 2
    c1 = note_resp["cards"][0]["id"]
    c2 = note_resp["cards"][1]["id"]

    # Select only the first cloze card
    res = bulk_action(
        client,
        auth_headers_a,
        "add_tags",
        [{"card_id": c1, "expected_version": 0}],
        tags=["capital"],
    )
    assert res.status_code == 200, res.text
    assert res.json() == {"updated": 2, "updated_notes": 1}

    db_session.expire_all()
    note_db = db_session.get(Note, note_resp["id"])
    assert set(json.loads(note_db.tags_json)) == {"asia", "capital"}
    # Both cloze sibling card versions bumped
    assert db_session.get(SchedulerState, c1).version == 1
    assert db_session.get(SchedulerState, c2).version == 1


def test_siblings_across_different_decks(client, auth_headers_a, db_session):
    d1 = create_deck(client, auth_headers_a, "Deck One")
    d2 = create_deck(client, auth_headers_a, "Deck Two")
    note_resp = create_note(client, auth_headers_a, d1, kind="reversed")
    c1 = note_resp["cards"][0]["id"]
    c2 = note_resp["cards"][1]["id"]

    # Move sibling card 2 to Deck Two
    card2 = db_session.get(Card, c2)
    card2.deck_id = d2
    db_session.commit()

    # Tag using only card 1 (located in Deck One)
    res = bulk_action(
        client,
        auth_headers_a,
        "add_tags",
        [{"card_id": c1, "expected_version": 0}],
        tags=["cross-deck"],
    )
    assert res.status_code == 200, res.text
    assert res.json() == {"updated": 2, "updated_notes": 1}

    db_session.expire_all()
    assert db_session.get(SchedulerState, c1).version == 1
    assert db_session.get(SchedulerState, c2).version == 1
    note_db = db_session.get(Note, note_resp["id"])
    assert json.loads(note_db.tags_json) == ["cross-deck"]


def test_progress_due_fsrs_buried_unchanged(client, auth_headers_a, db_session):
    deck_id = create_deck(client, auth_headers_a, "Progress Deck")
    note_resp = create_note(client, auth_headers_a, deck_id, kind="basic")
    cid = note_resp["cards"][0]["id"]

    user_id = db_session.get(Card, cid).deck.user_id
    future_due = datetime.now(timezone.utc) + timedelta(days=14)
    future_buried = datetime.now(timezone.utc) + timedelta(days=2)
    fsrs_data = json.dumps({"s": 5.4, "d": 2.8, "r": 0.9})

    # Set up progress and scheduler states
    progress = StudyProgress(
        user_id=user_id,
        card_id=cid,
        card_state="review",
        interval_days=14,
        ease_factor=2.6,
        repetitions=5,
        learning_step=0,
        lapse_count=1,
        is_leech=False,
        is_suspended=True,
        next_review=future_due,
    )
    scheduler = SchedulerState(
        card_id=cid,
        version=3,
        buried_until=future_buried,
        fsrs_json=fsrs_data,
    )
    db_session.add(progress)
    db_session.add(scheduler)
    db_session.commit()

    # Execute add_tags action
    res = bulk_action(
        client,
        auth_headers_a,
        "add_tags",
        [{"card_id": cid, "expected_version": 3}],
        tags=["studied"],
    )
    assert res.status_code == 200, res.text

    db_session.expire_all()
    refreshed_progress = db_session.get(StudyProgress, progress.id)
    refreshed_scheduler = db_session.get(SchedulerState, cid)

    # Progress unchanged
    assert refreshed_progress.card_state == "review"
    assert refreshed_progress.interval_days == 14
    assert refreshed_progress.ease_factor == 2.6
    assert refreshed_progress.repetitions == 5
    assert refreshed_progress.is_suspended is True
    assert refreshed_progress.lapse_count == 1
    assert utc(refreshed_progress.next_review) == future_due

    # Scheduler state: buried_until and fsrs_json unchanged, version bumped
    assert utc(refreshed_scheduler.buried_until) == future_buried
    assert refreshed_scheduler.fsrs_json == fsrs_data
    assert refreshed_scheduler.version == 4


def test_stale_expected_version_atomic_rollback(client, auth_headers_a, db_session):
    deck_id = create_deck(client, auth_headers_a, "Rollback Deck")
    note1 = create_note(client, auth_headers_a, deck_id, fields={"Front": "Q1", "Back": "A1"})
    note2 = create_note(client, auth_headers_a, deck_id, fields={"Front": "Q2", "Back": "A2"})
    c1 = note1["cards"][0]["id"]
    c2 = note2["cards"][0]["id"]

    # c1 has expected_version=0 (correct), but c2 has expected_version=99 (stale)
    targets = [
        {"card_id": c1, "expected_version": 0},
        {"card_id": c2, "expected_version": 99},
    ]
    res = bulk_action(client, auth_headers_a, "add_tags", targets, tags=["rollback_tag"])
    assert res.status_code == 409

    db_session.expire_all()
    # Atomic rollback: neither note receives tag, and c1's version is not bumped
    n1_db = db_session.get(Note, note1["id"])
    n2_db = db_session.get(Note, note2["id"])
    assert json.loads(n1_db.tags_json) == []
    assert json.loads(n2_db.tags_json) == []

    s1 = db_session.get(SchedulerState, c1)
    assert (s1.version if s1 else 0) == 0


def test_foreign_source_atomic_rollback(client, auth_headers_a, auth_headers_b, db_session):
    d_a = create_deck(client, auth_headers_a, "Deck A")
    d_b = create_deck(client, auth_headers_b, "Deck B")
    note_a = create_note(client, auth_headers_a, d_a)
    note_b = create_note(client, auth_headers_b, d_b)
    ca = note_a["cards"][0]["id"]
    cb = note_b["cards"][0]["id"]

    # User A tries to act on both their own card and User B's card
    targets = [
        {"card_id": ca, "expected_version": 0},
        {"card_id": cb, "expected_version": 0},
    ]
    res = bulk_action(client, auth_headers_a, "add_tags", targets, tags=["hacked"])
    assert res.status_code == 404

    db_session.expire_all()
    na_db = db_session.get(Note, note_a["id"])
    assert json.loads(na_db.tags_json) == []
    sa = db_session.get(SchedulerState, ca)
    assert (sa.version if sa else 0) == 0


def test_legacy_card_note_metadata_created_on_mutation_and_rollback(client, auth_headers_a, db_session):
    deck_id = create_deck(client, auth_headers_a, "Legacy Deck")
    # Legacy card without Note or NoteCard link
    legacy_card = Card(deck_id=deck_id, front="Legacy Front", back="Legacy Back")
    db_session.add(legacy_card)
    db_session.commit()
    cid = legacy_card.id

    assert legacy_card.note_link is None

    # 1. Failure in batch: rollback restores state and does NOT leave orphan note metadata
    res = bulk_action(
        client,
        auth_headers_a,
        "add_tags",
        [
            {"card_id": cid, "expected_version": 0},
            {"card_id": 999999, "expected_version": 0},  # triggers 404
        ],
        tags=["will_fail"],
    )
    assert res.status_code == 404

    db_session.expire_all()
    card_reloaded = db_session.get(Card, cid)
    assert card_reloaded.note_link is None

    # 2. Successful mutation creates note metadata on demand
    res = bulk_action(
        client,
        auth_headers_a,
        "add_tags",
        [{"card_id": cid, "expected_version": 0}],
        tags=["legacy_tagged"],
    )
    assert res.status_code == 200, res.text
    assert res.json() == {"updated": 1, "updated_notes": 1}

    db_session.expire_all()
    card_reloaded = db_session.get(Card, cid)
    assert card_reloaded.note_link is not None
    created_note = card_reloaded.note_link.note
    assert json.loads(created_note.tags_json) == ["legacy_tagged"]
    assert db_session.get(SchedulerState, cid).version == 1


def test_template_tags_cached_front_back_rerender_per_deck(client, auth_headers_a, db_session):
    d1 = create_deck(client, auth_headers_a, "Deck Alpha")
    d2 = create_deck(client, auth_headers_a, "Deck Beta")
    note_resp = create_note(client, auth_headers_a, d1, kind="reversed")
    c1_id = note_resp["cards"][0]["id"]
    c2_id = note_resp["cards"][1]["id"]

    # Place sibling 2 in Deck Beta
    card2 = db_session.get(Card, c2_id)
    card2.deck_id = d2

    # Mutate note model templates to include {{Tags}} and {{Deck}}
    note = db_session.get(Note, note_resp["id"])
    model = note.note_type
    model.templates_json = json.dumps([
        {
            "name": "Card 1",
            "qfmt": "{{Front}}",
            "afmt": "{{FrontSide}}<hr id=answer>{{Back}}<div class=\"tags\">{{Tags}}</div> [{{Deck}}]",
        },
        {
            "name": "Card 2",
            "qfmt": "{{Back}}",
            "afmt": "{{FrontSide}}<hr id=answer>{{Front}}<div class=\"tags\">{{Tags}}</div> [{{Deck}}]",
        },
    ])
    # Ensure package_data has _web_rendered
    note.package_data = PackageNote(payload=json.dumps({"_web_rendered": True}))
    db_session.commit()

    # Perform add_tags
    res = bulk_action(
        client,
        auth_headers_a,
        "add_tags",
        [{"card_id": c1_id, "expected_version": 0}],
        tags=["tag1", "tag2"],
    )
    assert res.status_code == 200, res.text

    db_session.expire_all()
    c1 = db_session.get(Card, c1_id)
    c2 = db_session.get(Card, c2_id)

    # Check that {{Tags}} and {{Deck}} were rerendered into card.back per deck
    assert "<div class=\"tags\">tag1 tag2</div> [Deck Alpha]" in c1.back
    assert "<div class=\"tags\">tag1 tag2</div> [Deck Beta]" in c2.back


def test_reject_tag_changes_altering_generated_template_ordinals(client, auth_headers_a, db_session):
    d = create_deck(client, auth_headers_a, "Ordinal Deck")
    note_resp = create_note(client, auth_headers_a, d, kind="reversed")
    c1_id = note_resp["cards"][0]["id"]

    note = db_session.get(Note, note_resp["id"])
    model = note.note_type
    # Add a 3rd template that only renders when {{Tags}} is non-empty
    model.templates_json = json.dumps([
        {"name": "Card 1", "qfmt": "{{Front}}", "afmt": "{{FrontSide}}<hr id=answer>{{Back}}"},
        {"name": "Card 2", "qfmt": "{{Back}}", "afmt": "{{FrontSide}}<hr id=answer>{{Front}}"},
        {"name": "Card 3", "qfmt": "{{Tags}}", "afmt": "{{FrontSide}}<hr id=answer>{{Front}}"},
    ])
    note.package_data = PackageNote(payload=json.dumps({"_web_rendered": True}))
    db_session.commit()

    # Previously with empty tags, template 3 produced no card (ordinals: {0, 1}).
    # Adding tags would generate ordinal 2 (ordinals: {0, 1, 2}).
    # This must be rejected because tag change cannot add or remove generated cards.
    res = bulk_action(
        client,
        auth_headers_a,
        "add_tags",
        [{"card_id": c1_id, "expected_version": 0}],
        tags=["generates_card3"],
    )
    assert res.status_code == 400
    assert "Tag change would add or remove generated cards" in res.json()["detail"]

    db_session.expire_all()
    reloaded_note = db_session.get(Note, note_resp["id"])
    assert json.loads(reloaded_note.tags_json) == []


def test_bulk_edited_tags_apkg_interop(client, auth_headers_a, tmp_path):
    deck_id = create_deck(client, auth_headers_a, "APKG Interop Deck")
    fields = {"Front": "Câu hỏi", "Back": "Câu trả lời"}
    note_resp = client.post(
        "/api/notes",
        headers=auth_headers_a,
        json={
            "deck_id": deck_id,
            "kind": "reversed",
            "fields": fields,
            "tags": ["Parent::Child", "keep"],
        },
    ).json()
    assert len(note_resp["cards"]) == 2
    c1 = note_resp["cards"][0]["id"]

    # Add Vietnamese Unicode/comma tag via bulk action
    res = bulk_action(
        client,
        auth_headers_a,
        "add_tags",
        [{"card_id": c1, "expected_version": 0}],
        tags=["tiếng,việt"],
    )
    assert res.status_code == 200, res.text
    assert res.json() == {"updated": 2, "updated_notes": 1}

    # Remove parent tag (native Anki behavior removes Parent and descendant Parent::Child)
    res = bulk_action(
        client,
        auth_headers_a,
        "remove_tags",
        [{"card_id": c1, "expected_version": 1}],
        tags=["parent"],
    )
    assert res.status_code == 200, res.text
    assert res.json() == {"updated": 2, "updated_notes": 1}

    # Export modern APKG endpoint
    exported = client.get(f"/api/apkg/export/{deck_id}?modern=true", headers=auth_headers_a)
    assert exported.status_code == 200, exported.text[:500]
    package = tmp_path / "bulk_tags_export.apkg"
    package.write_bytes(exported.content)

    # Import into actual anki.Collection temporary using ImportAnkiPackageRequest
    collection = Collection(str(tmp_path / "actual-anki.anki2"))
    try:
        collection.import_anki_package(ImportAnkiPackageRequest(package_path=str(package)))
        assert collection.note_count() == 1
        assert collection.card_count() == 2
        nid = collection.find_notes("")[0]
        actual = collection.get_note(nid)
        assert actual.guid == note_resp["guid"]
        assert list(actual.fields) == list(fields.values())
        assert set(actual.tags) == {"keep", "tiếng,việt"}
    finally:
        collection.close()
