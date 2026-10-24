from models import Deck, Card, StudyProgress, ReviewLog


def test_cross_user_deck_access_blocked(client, auth_headers_a, auth_headers_b):
    # User A creates a deck
    create_resp = client.post(
        "/api/decks",
        headers=auth_headers_a,
        json={"name": "User A Deck", "description": "Private deck"},
    )
    assert create_resp.status_code == 201
    deck_id = create_resp.json()["id"]

    # User B attempts GET
    get_resp = client.get(f"/api/decks/{deck_id}", headers=auth_headers_b)
    assert get_resp.status_code == 404

    # User B attempts PUT
    put_resp = client.put(
        f"/api/decks/{deck_id}",
        headers=auth_headers_b,
        json={"name": "Hacked Deck Name"},
    )
    assert put_resp.status_code == 404

    # User B attempts DELETE
    del_resp = client.delete(f"/api/decks/{deck_id}", headers=auth_headers_b)
    assert del_resp.status_code == 404

    # User A can still retrieve deck intact
    owner_get = client.get(f"/api/decks/{deck_id}", headers=auth_headers_a)
    assert owner_get.status_code == 200
    assert owner_get.json()["name"] == "User A Deck"


def test_cross_user_card_access_blocked(client, auth_headers_a, auth_headers_b):
    # User A creates a deck and a card
    deck_resp = client.post(
        "/api/decks",
        headers=auth_headers_a,
        json={"name": "Deck A", "description": "Deck A desc"},
    )
    deck_id = deck_resp.json()["id"]

    card_resp = client.post(
        f"/api/decks/{deck_id}/cards",
        headers=auth_headers_a,
        json={"front": "Front A", "back": "Back A"},
    )
    assert card_resp.status_code == 201
    card_id = card_resp.json()["id"]

    # User B attempts to list cards in User A's deck
    list_resp = client.get(f"/api/decks/{deck_id}/cards", headers=auth_headers_b)
    assert list_resp.status_code == 404

    # User B attempts to create card in User A's deck
    create_card_resp = client.post(
        f"/api/decks/{deck_id}/cards",
        headers=auth_headers_b,
        json={"front": "Injected Front", "back": "Injected Back"},
    )
    assert create_card_resp.status_code == 404

    # User B attempts to update User A's card
    put_card_resp = client.put(
        f"/api/cards/{card_id}",
        headers=auth_headers_b,
        json={"front": "Malicious Front"},
    )
    assert put_card_resp.status_code == 404

    # User B attempts to delete User A's card
    del_card_resp = client.delete(f"/api/cards/{card_id}", headers=auth_headers_b)
    assert del_card_resp.status_code == 404


def test_cross_user_review_cannot_write_db(client, db_session, user_a, user_b, auth_headers_a, auth_headers_b):
    # User A creates a deck and a card
    deck_resp = client.post(
        "/api/decks",
        headers=auth_headers_a,
        json={"name": "Deck A For Review", "description": "Private"},
    )
    deck_id = deck_resp.json()["id"]

    card_resp = client.post(
        f"/api/decks/{deck_id}/cards",
        headers=auth_headers_a,
        json={"front": "Question A", "back": "Answer A"},
    )
    card_id = card_resp.json()["id"]

    # User B attempts to review User A's card
    review_resp = client.post(
        f"/api/study/{card_id}/review",
        headers=auth_headers_b,
        json={"rating": 3},
    )
    assert review_resp.status_code == 404
    assert review_resp.json()["detail"] == "Card not found"

    # Verify regression: DB must NOT contain any StudyProgress or ReviewLog for User B
    b_progress = db_session.query(StudyProgress).filter(StudyProgress.user_id == user_b.id).all()
    assert len(b_progress) == 0

    b_logs = db_session.query(ReviewLog).filter(ReviewLog.user_id == user_b.id).all()
    assert len(b_logs) == 0

    # User A reviews their own card successfully
    a_review_resp = client.post(
        f"/api/study/{card_id}/review",
        headers=auth_headers_a,
        json={"rating": 3},
    )
    assert a_review_resp.status_code == 200

    # User A has progress and review log
    a_progress = db_session.query(StudyProgress).filter(StudyProgress.user_id == user_a.id).first()
    assert a_progress is not None
    assert a_progress.card_id == card_id

    a_log = db_session.query(ReviewLog).filter(ReviewLog.user_id == user_a.id).first()
    assert a_log is not None
    assert a_log.card_id == card_id
    assert a_log.rating == 3
