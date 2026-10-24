"""Independent tests for GET /api/stats contract, subtree ownership, timezones, and retention metrics."""
import json
from datetime import datetime, timedelta, timezone

from models import (
    Card,
    Deck,
    Note,
    NoteCard,
    NoteType,
    ReviewLog,
    ReviewRecord,
    SchedulerState,
    StudyProgress,
)


def _make_deck(client, headers, name, settings=None):
    resp = client.post("/api/decks", headers=headers, json={"name": name})
    assert resp.status_code == 201, resp.text
    deck_id = resp.json()["id"]
    if settings:
        update_resp = client.put(
            f"/api/decks/{deck_id}",
            headers=headers,
            json={"settings": json.dumps(settings)},
        )
        assert update_resp.status_code == 200, update_resp.text
    return deck_id


def test_empty_collection_and_provenance(client, auth_headers_a):
    """Empty collection returns 0 counts and null for insufficient recall/duration."""
    resp = client.get("/api/stats", headers=auth_headers_a)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["days"] == 30
    assert data["deck_id"] is None
    assert data["counts"]["total"] == 0
    assert data["counts"]["notes"] == 0
    assert data["counts"]["new"] == 0
    assert data["counts"]["learning"] == 0
    assert data["counts"]["young"] == 0
    assert data["counts"]["mature"] == 0
    assert data["counts"]["suspended"] == 0
    assert data["counts"]["buried"] == 0
    assert len(data["history"]) == 30
    assert len(data["forecast"]) == 30
    assert data["summary"]["reviews"] == 0
    assert data["summary"]["seconds"] == 0.0
    assert data["summary"]["seconds_per_review"] is None
    assert data["summary"]["active_days"] == 0
    assert data["summary"]["review_attempts"] == 0
    assert data["summary"]["remembered"] == 0
    assert data["summary"]["review_recall_percent"] is None
    assert "configured timezone" in data["day_basis"]
    assert "excludes suspended/buried" in data["forecast_basis"]
    assert "excludes learning" in data["recall_basis"]


def test_ownership_and_user_isolation(client, auth_headers_a, auth_headers_b, db_session, user_a, user_b):
    """User A cannot access User B's deck stats or see User B's cards/logs in collection stats."""
    deck_a = _make_deck(client, auth_headers_a, "Deck A")
    deck_b = _make_deck(client, auth_headers_b, "Deck B")

    # Add card and review to User A
    card_a = Card(deck_id=deck_a, front="A Front", back="A Back")
    db_session.add(card_a)
    db_session.flush()

    log_a = ReviewLog(
        user_id=user_a.id,
        card_id=card_a.id,
        rating=3,
        review_date=datetime.now(timezone.utc),
    )
    db_session.add(log_a)
    db_session.flush()
    db_session.add(
        ReviewRecord(
            review_log_id=log_a.id,
            payload=json.dumps({"duration_ms": 2000, "kind": "review"}),
        )
    )

    # Add card and review to User B
    card_b = Card(deck_id=deck_b, front="B Front", back="B Back")
    db_session.add(card_b)
    db_session.flush()

    log_b = ReviewLog(
        user_id=user_b.id,
        card_id=card_b.id,
        rating=1,
        review_date=datetime.now(timezone.utc),
    )
    db_session.add(log_b)
    db_session.flush()
    db_session.add(
        ReviewRecord(
            review_log_id=log_b.id,
            payload=json.dumps({"duration_ms": 3000, "kind": "review"}),
        )
    )
    db_session.commit()

    # User A collection stats must only have card_a and log_a
    stats_a = client.get("/api/stats", headers=auth_headers_a).json()
    assert stats_a["counts"]["total"] == 1
    assert stats_a["summary"]["reviews"] == 1
    assert stats_a["summary"]["review_recall_percent"] == 100.0

    # User A querying User B's deck returns 404
    resp_404 = client.get(f"/api/stats?deck_id={deck_b}", headers=auth_headers_a)
    assert resp_404.status_code == 404
    assert resp_404.json()["detail"] == "Deck not found"

    # User B collection stats must only have card_b and log_b
    stats_b = client.get("/api/stats", headers=auth_headers_b).json()
    assert stats_b["counts"]["total"] == 1
    assert stats_b["summary"]["reviews"] == 1
    assert stats_b["summary"]["review_recall_percent"] == 0.0


def test_subtree_aggregation(client, auth_headers_a, db_session, user_a):
    """Querying a parent deck aggregates all descendant subdecks, excluding unrelated decks."""
    # Deck hierarchy:
    # Languages (parent)
    # Languages::Spanish (child)
    # Languages::Spanish::Vocab (grandchild)
    # Math (unrelated)
    parent_id = _make_deck(client, auth_headers_a, "Languages")
    child_id = _make_deck(client, auth_headers_a, "Languages::Spanish")
    grandchild_id = _make_deck(client, auth_headers_a, "Languages::Spanish::Vocab")
    math_id = _make_deck(client, auth_headers_a, "Math")

    card_p = Card(deck_id=parent_id, front="Lang Intro", back="Intro")
    card_c = Card(deck_id=child_id, front="Hola", back="Hello")
    card_g = Card(deck_id=grandchild_id, front="Perro", back="Dog")
    card_m = Card(deck_id=math_id, front="2+2", back="4")
    db_session.add_all([card_p, card_c, card_g, card_m])
    db_session.commit()

    # Subtree of Languages should include Languages, Languages::Spanish, and Languages::Spanish::Vocab (3 cards)
    stats_parent = client.get(f"/api/stats?deck_id={parent_id}", headers=auth_headers_a).json()
    assert stats_parent["counts"]["total"] == 3
    assert stats_parent["deck_id"] == parent_id

    # Subtree of Spanish should include Languages::Spanish and Languages::Spanish::Vocab (2 cards)
    stats_child = client.get(f"/api/stats?deck_id={child_id}", headers=auth_headers_a).json()
    assert stats_child["counts"]["total"] == 2

    # Math only includes Math (1 card)
    stats_math = client.get(f"/api/stats?deck_id={math_id}", headers=auth_headers_a).json()
    assert stats_math["counts"]["total"] == 1


def test_counts_states_notes_and_overlapping_suspended_buried(client, auth_headers_a, db_session, user_a):
    """Verify distinct notes vs card count, state categorization, and overlapping suspended/buried status."""
    deck_id = _make_deck(client, auth_headers_a, "StateDeck")

    # 1 note with 2 cards (e.g. basic and reversed)
    nt = NoteType(user_id=user_a.id, name="ReversedType", fields_json='["Front","Back"]', templates_json="[]")
    db_session.add(nt)
    db_session.flush()

    note = Note(user_id=user_a.id, note_type_id=nt.id, guid="note-guid-1", fields_json='{"Front":"Q","Back":"A"}')
    db_session.add(note)
    db_session.flush()

    # Card 1: New card on note
    c1 = Card(deck_id=deck_id, front="Q", back="A")
    db_session.add(c1)
    db_session.flush()
    db_session.add(NoteCard(card_id=c1.id, note_id=note.id, template_ord=0))

    # Card 2: Learning card on same note
    c2 = Card(deck_id=deck_id, front="A", back="Q")
    db_session.add(c2)
    db_session.flush()
    db_session.add(NoteCard(card_id=c2.id, note_id=note.id, template_ord=1))
    db_session.add(
        StudyProgress(
            user_id=user_a.id,
            card_id=c2.id,
            card_state="learning",
            interval_days=0,
        )
    )

    # Card 3: Young review card (interval = 5 days < 21)
    c3 = Card(deck_id=deck_id, front="Young Q", back="Young A")
    db_session.add(c3)
    db_session.flush()
    db_session.add(
        StudyProgress(
            user_id=user_a.id,
            card_id=c3.id,
            card_state="review",
            interval_days=5,
        )
    )

    # Card 4: Mature review card (interval = 35 days >= 21), ALSO suspended!
    c4 = Card(deck_id=deck_id, front="Mature Q", back="Mature A")
    db_session.add(c4)
    db_session.flush()
    db_session.add(
        StudyProgress(
            user_id=user_a.id,
            card_id=c4.id,
            card_state="review",
            interval_days=35,
            is_suspended=True,
        )
    )

    # Card 5: Legacy card, young (interval = 14 days), ALSO buried until future!
    c5 = Card(deck_id=deck_id, front="Buried Q", back="Buried A")
    db_session.add(c5)
    db_session.flush()
    db_session.add(
        StudyProgress(
            user_id=user_a.id,
            card_id=c5.id,
            card_state="review",
            interval_days=14,
        )
    )
    db_session.add(
        SchedulerState(
            card_id=c5.id,
            buried_until=datetime.now(timezone.utc) + timedelta(hours=5),
        )
    )

    db_session.commit()

    stats = client.get("/api/stats", headers=auth_headers_a).json()
    counts = stats["counts"]

    # Total 5 cards, 4 notes (note 1 has 2 cards, c3, c4, c5 are legacy distinct notes)
    assert counts["total"] == 5
    assert counts["notes"] == 4
    assert counts["new"] == 1
    assert counts["learning"] == 1
    assert counts["young"] == 2       # c3 (5 days) + c5 (14 days)
    assert counts["mature"] == 1      # c4 (35 days)
    # Suspended and buried are overlapping!
    assert counts["suspended"] == 1   # c4 is mature AND suspended
    assert counts["buried"] == 1      # c5 is young AND buried

    # Interval histogram buckets
    buckets = {b["label"]: b["count"] for b in stats["intervals"]}
    assert buckets["1 day"] == 0
    assert buckets["2–6 days"] == 1    # c3 (5 days)
    assert buckets["7–20 days"] == 1   # c5 (14 days)
    assert buckets["21–89 days"] == 1  # c4 (35 days)
    assert buckets["90+ days"] == 0


def test_daily_calendar_offsets_and_timezone(client, auth_headers_a, db_session, user_a):
    """Review log offsets and forecast calculation respect deck study-day clock and rollover."""
    now = datetime.now(timezone.utc)
    # Deck in London timezone, rollover at 4am
    deck_id = _make_deck(
        client,
        auth_headers_a,
        "LondonDeck",
        settings={"timezone": "Europe/London", "day_starts_at": 4},
    )

    card = Card(deck_id=deck_id, front="Front", back="Back")
    db_session.add(card)
    db_session.flush()

    # Log today (now)
    log_today = ReviewLog(
        user_id=user_a.id,
        card_id=card.id,
        rating=3,
        review_date=now,
    )
    # Log yesterday
    log_yesterday = ReviewLog(
        user_id=user_a.id,
        card_id=card.id,
        rating=4,
        review_date=now - timedelta(days=1),
    )
    # Log 3 days ago
    log_3d_ago = ReviewLog(
        user_id=user_a.id,
        card_id=card.id,
        rating=1,
        review_date=now - timedelta(days=3),
    )
    db_session.add_all([log_today, log_yesterday, log_3d_ago])
    db_session.flush()

    db_session.add(ReviewRecord(review_log_id=log_today.id, payload=json.dumps({"duration_ms": 1500, "kind": "review"})))
    db_session.add(ReviewRecord(review_log_id=log_yesterday.id, payload=json.dumps({"duration_ms": 2500, "kind": "review"})))
    db_session.add(ReviewRecord(review_log_id=log_3d_ago.id, payload=json.dumps({"duration_ms": 3000, "kind": "review"})))
    db_session.commit()

    stats = client.get("/api/stats?days=7", headers=auth_headers_a).json()
    history = {row["day"]: row for row in stats["history"]}

    assert history[0]["reviews"] == 1
    assert history[0]["good"] == 1
    assert history[-1]["reviews"] == 1
    assert history[-1]["easy"] == 1
    assert history[-3]["reviews"] == 1
    assert history[-3]["again"] == 1
    assert stats["summary"]["active_days"] == 3
    assert stats["summary"]["reviews"] == 3


def test_forecast_due_overdue_and_exclusions(client, auth_headers_a, db_session, user_a):
    """Forecast includes overdue in day 0 and excludes suspended/buried cards."""
    now = datetime.now(timezone.utc)
    deck_id = _make_deck(client, auth_headers_a, "ForecastDeck")

    # Card 1: Overdue review card (next_review was 2 days ago) -> day 0
    c1 = Card(deck_id=deck_id, front="Overdue", back="Card")
    db_session.add(c1)
    db_session.flush()
    db_session.add(
        StudyProgress(
            user_id=user_a.id,
            card_id=c1.id,
            card_state="review",
            interval_days=5,
            next_review=now - timedelta(days=2),
        )
    )

    # Card 2: Due tomorrow -> day 1
    c2 = Card(deck_id=deck_id, front="Due Tomorrow", back="Card")
    db_session.add(c2)
    db_session.flush()
    db_session.add(
        StudyProgress(
            user_id=user_a.id,
            card_id=c2.id,
            card_state="review",
            interval_days=10,
            next_review=now + timedelta(days=1),
        )
    )

    # Card 3: Due tomorrow but SUSPENDED -> excluded from forecast
    c3 = Card(deck_id=deck_id, front="Suspended", back="Card")
    db_session.add(c3)
    db_session.flush()
    db_session.add(
        StudyProgress(
            user_id=user_a.id,
            card_id=c3.id,
            card_state="review",
            interval_days=10,
            next_review=now + timedelta(days=1),
            is_suspended=True,
        )
    )

    # Card 4: Due tomorrow but BURIED -> excluded from forecast
    c4 = Card(deck_id=deck_id, front="Buried", back="Card")
    db_session.add(c4)
    db_session.flush()
    db_session.add(
        StudyProgress(
            user_id=user_a.id,
            card_id=c4.id,
            card_state="review",
            interval_days=10,
            next_review=now + timedelta(days=1),
        )
    )
    db_session.add(
        SchedulerState(
            card_id=c4.id,
            buried_until=now + timedelta(hours=6),
        )
    )

    # Card 5: New card -> excluded from forecast
    c5 = Card(deck_id=deck_id, front="New", back="Card")
    db_session.add(c5)
    db_session.flush()

    db_session.commit()

    stats = client.get("/api/stats?days=7", headers=auth_headers_a).json()
    forecast = {row["day"]: row["cards"] for row in stats["forecast"]}

    assert forecast[0] == 1  # Overdue card lands on day 0
    assert forecast[1] == 1  # Only c2 (not c3 suspended or c4 buried)
    assert forecast[2] == 0


def test_review_durations_and_retention_denominator(client, auth_headers_a, db_session, user_a):
    """Summary review recall percent includes only mature/review answers, strictly excluding learning."""
    now = datetime.now(timezone.utc)
    deck_id = _make_deck(client, auth_headers_a, "RetentionDeck")
    card = Card(deck_id=deck_id, front="Q", back="A")
    db_session.add(card)
    db_session.flush()

    # 1. Review state log: Again (rating 1) -> attempt=1, remembered=0, 4.0s
    l1 = ReviewLog(user_id=user_a.id, card_id=card.id, rating=1, review_date=now)
    db_session.add(l1)
    db_session.flush()
    db_session.add(ReviewRecord(review_log_id=l1.id, payload=json.dumps({"duration_ms": 4000, "kind": "review"})))

    # 2. Review state log: Good (rating 3) -> attempt=1, remembered=1, 6.0s
    l2 = ReviewLog(user_id=user_a.id, card_id=card.id, rating=3, review_date=now)
    db_session.add(l2)
    db_session.flush()
    db_session.add(ReviewRecord(review_log_id=l2.id, payload=json.dumps({"duration_ms": 6000, "kind": "review"})))

    # 3. Learning state log: Good (rating 3) -> should NOT count towards review_attempts or remembered!
    l3 = ReviewLog(user_id=user_a.id, card_id=card.id, rating=3, review_date=now)
    db_session.add(l3)
    db_session.flush()
    db_session.add(ReviewRecord(review_log_id=l3.id, payload=json.dumps({"duration_ms": 2000, "kind": "learn"})))

    # 4. Preview / unclassified log (no kind) -> should NOT count towards review_attempts or remembered
    l4 = ReviewLog(user_id=user_a.id, card_id=card.id, rating=4, review_date=now)
    db_session.add(l4)
    db_session.flush()
    db_session.add(ReviewRecord(review_log_id=l4.id, payload=json.dumps({"duration_ms": 1000})))

    db_session.commit()

    stats = client.get("/api/stats", headers=auth_headers_a).json()
    summary = stats["summary"]

    # All 4 logs count towards total reviews and duration
    assert summary["reviews"] == 4
    assert summary["seconds"] == 13.0
    assert summary["seconds_per_review"] == round(13.0 / 4, 1)

    # Denominator (review_attempts) and numerator (remembered) MUST ONLY consider kind == 'review'
    assert summary["review_attempts"] == 2
    assert summary["remembered"] == 1
    # 1 / 2 = 50.0%
    assert summary["review_recall_percent"] == 50.0


def test_query_param_validation(client, auth_headers_a):
    """Validation bounds for days parameter (1 <= days <= 365)."""
    assert client.get("/api/stats?days=7", headers=auth_headers_a).status_code == 200
    assert client.get("/api/stats?days=90", headers=auth_headers_a).status_code == 200
    assert client.get("/api/stats?days=365", headers=auth_headers_a).status_code == 200

    # Below minimum
    assert client.get("/api/stats?days=0", headers=auth_headers_a).status_code == 422
    # Above maximum
    assert client.get("/api/stats?days=400", headers=auth_headers_a).status_code == 422
