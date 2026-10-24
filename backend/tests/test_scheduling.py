import json
from models import StudyProgress


def test_sm2_learning_steps_and_graduation(client, auth_headers_a, db_session, user_a):
    deck_resp = client.post(
        "/api/decks",
        headers=auth_headers_a,
        json={"name": "SM2 Deck"},
    )
    deck_id = deck_resp.json()["id"]

    card_resp = client.post(
        f"/api/decks/{deck_id}/cards",
        headers=auth_headers_a,
        json={"front": "Question", "back": "Answer"},
    )
    card_id = card_resp.json()["id"]

    # Step 1: First review - Again (rating 1)
    rev1 = client.post(
        f"/api/study/{card_id}/review",
        headers=auth_headers_a,
        json={"rating": 1},
    )
    assert rev1.status_code == 200
    data1 = rev1.json()
    assert data1["card_state"] == "learning"
    prog1 = db_session.query(StudyProgress).filter(StudyProgress.card_id == card_id).first()
    assert prog1.learning_step == 0

    # Step 2: Second review - Good (rating 3) -> advances learning step
    rev2 = client.post(
        f"/api/study/{card_id}/review",
        headers=auth_headers_a,
        json={"rating": 3},
    )
    assert rev2.status_code == 200
    db_session.refresh(prog1)
    assert prog1.learning_step == 1

    # Step 3: Third review - Good (rating 3) -> graduates to review state
    rev3 = client.post(
        f"/api/study/{card_id}/review",
        headers=auth_headers_a,
        json={"rating": 3},
    )
    assert rev3.status_code == 200
    data3 = rev3.json()
    assert data3["card_state"] == "review"
    assert data3["interval_days"] >= 1
    db_session.refresh(prog1)
    assert prog1.card_state == "review"


def test_leech_detection(client, auth_headers_a, db_session, user_a):
    # Configure deck with leech_threshold = 3
    deck_settings = json.dumps({
        "leech_threshold": 3,
        "leech_action": "tag_only",
    })
    deck_resp = client.post(
        "/api/decks",
        headers=auth_headers_a,
        json={"name": "Leech Test Deck"},
    )
    deck_id = deck_resp.json()["id"]
    client.put(
        f"/api/decks/{deck_id}",
        headers=auth_headers_a,
        json={"settings": deck_settings},
    )

    card_resp = client.post(
        f"/api/decks/{deck_id}/cards",
        headers=auth_headers_a,
        json={"front": "Hard Word", "back": "Meaning"},
    )
    card_id = card_resp.json()["id"]

    # Graduate card to review state first using Easy (rating 4)
    client.post(
        f"/api/study/{card_id}/review",
        headers=auth_headers_a,
        json={"rating": 4},
    )

    # Lapse 1 (Again on graduated review card)
    r1 = client.post(f"/api/study/{card_id}/review", headers=auth_headers_a, json={"rating": 1})
    assert r1.json()["is_leech"] is False

    # Lapse 2
    # Graduate again then lapse
    client.post(f"/api/study/{card_id}/review", headers=auth_headers_a, json={"rating": 4})
    r2 = client.post(f"/api/study/{card_id}/review", headers=auth_headers_a, json={"rating": 1})
    assert r2.json()["is_leech"] is False

    # Lapse 3 -> Reaches threshold 3!
    client.post(f"/api/study/{card_id}/review", headers=auth_headers_a, json={"rating": 4})
    r3 = client.post(f"/api/study/{card_id}/review", headers=auth_headers_a, json={"rating": 1})
    assert r3.json()["is_leech"] is True
    assert r3.json()["lapse_count"] >= 3


def test_daily_limits_enforced(client, auth_headers_a):
    # Create deck with limit: 2 new cards per day
    deck_settings = json.dumps({"new_cards_per_day": 2, "maximum_reviews_per_day": 5})
    deck_resp = client.post(
        "/api/decks",
        headers=auth_headers_a,
        json={"name": "Daily Limits Deck"},
    )
    deck_id = deck_resp.json()["id"]
    client.put(
        f"/api/decks/{deck_id}",
        headers=auth_headers_a,
        json={"settings": deck_settings},
    )

    # Add 4 cards
    card_ids = []
    for i in range(4):
        c = client.post(
            f"/api/decks/{deck_id}/cards",
            headers=auth_headers_a,
            json={"front": f"Front {i}", "back": f"Back {i}"},
        )
        card_ids.append(c.json()["id"])

    # Deck stats should show only 2 new cards available due to daily limit
    deck_info = client.get(f"/api/decks/{deck_id}", headers=auth_headers_a).json()
    assert deck_info["new_cards"] == 2

    # Study card 1 (graduate it)
    next_c1 = client.get(f"/api/study/{deck_id}", headers=auth_headers_a).json()
    assert next_c1 is not None
    client.post(f"/api/study/{next_c1['card_id']}/review", headers=auth_headers_a, json={"rating": 4})

    # Study card 2 (graduate it)
    next_c2 = client.get(f"/api/study/{deck_id}", headers=auth_headers_a).json()
    assert next_c2 is not None
    client.post(f"/api/study/{next_c2['card_id']}/review", headers=auth_headers_a, json={"rating": 4})

    # Now daily limit of 2 new cards reached -> no more new cards should be presented
    deck_after = client.get(f"/api/decks/{deck_id}", headers=auth_headers_a).json()
    assert deck_after["new_cards"] == 0

    next_c3 = client.get(f"/api/study/{deck_id}", headers=auth_headers_a).json()
    # No more cards to study today
    assert next_c3 is None
