import pytest
from models import User
from auth import verify_password, resolve_jwt_secret


def test_register_success(client, db_session):
    resp = client.post(
        "/api/auth/register",
        json={"email": "newuser@example.com", "username": "Newbie", "password": "securepassword123"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "access_token" in data
    assert data["user"]["email"] == "newuser@example.com"
    assert data["user"]["username"] == "Newbie"

    # Verify password hash in DB
    user = db_session.query(User).filter(User.email == "newuser@example.com").first()
    assert user is not None
    assert user.password_hash != "securepassword123"
    assert verify_password("securepassword123", user.password_hash)


def test_login_success(client, user_a):
    resp = client.post(
        "/api/auth/login",
        json={"email": user_a.email, "password": "password123"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "access_token" in data
    assert data["token_type"] == "bearer"
    assert data["user"]["email"] == user_a.email


def test_login_invalid_password(client, user_a):
    resp = client.post(
        "/api/auth/login",
        json={"email": user_a.email, "password": "wrongpassword"},
    )
    assert resp.status_code == 401


def test_forgot_password_uniform_response(client, db_session, user_a):
    original_hash = user_a.password_hash

    # Request with existing email
    resp1 = client.post(
        "/api/auth/forgot-password",
        json={"email": user_a.email},
    )
    assert resp1.status_code == 200
    msg1 = resp1.json()["message"]

    # Request with non-existent email
    resp2 = client.post(
        "/api/auth/forgot-password",
        json={"email": "nonexistent@example.com"},
    )
    assert resp2.status_code == 200
    msg2 = resp2.json()["message"]

    # Uniform safe message - no account enumeration
    assert msg1 == msg2
    assert "If an account with that email exists" in msg1

    # Password hash in DB must NOT be modified
    db_session.refresh(user_a)
    assert user_a.password_hash == original_hash

    # User can still log in with existing password
    login_resp = client.post(
        "/api/auth/login",
        json={"email": user_a.email, "password": "password123"},
    )
    assert login_resp.status_code == 200


def test_jwt_secret_fail_fast_in_production(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")

    # Missing / empty secret
    monkeypatch.delenv("JWT_SECRET_KEY", raising=False)
    with pytest.raises(RuntimeError, match="JWT_SECRET_KEY environment variable must be set"):
        resolve_jwt_secret()

    # Default secret
    monkeypatch.setenv("JWT_SECRET_KEY", "anki-clone-dev-key-NOT-for-production")
    with pytest.raises(RuntimeError, match="JWT_SECRET_KEY environment variable must be set"):
        resolve_jwt_secret()

    # Short secret
    monkeypatch.setenv("JWT_SECRET_KEY", "short-secret")
    with pytest.raises(RuntimeError, match="at least 32 characters"):
        resolve_jwt_secret()

    # Valid secret
    monkeypatch.setenv("JWT_SECRET_KEY", "this-is-a-proper-production-jwt-secret-key-32chars")
    secret = resolve_jwt_secret()
    assert secret == "this-is-a-proper-production-jwt-secret-key-32chars"


def test_token_signed_with_rotated_old_key_rejected(client, user_a):
    from jose import jwt
    # Sign token with previous / rotated key
    old_key = "rotated-old-key-must-be-at-least-32-chars-long"
    old_token = jwt.encode({"sub": str(user_a.id)}, old_key, algorithm="HS256")

    resp = client.get(
        "/api/decks",
        headers={"Authorization": f"Bearer {old_token}"},
    )
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Could not validate credentials"


def test_password_oversized_utf8_rejected(client):
    # 73 ASCII characters (> 72 bytes)
    resp1 = client.post(
        "/api/auth/register",
        json={"email": "longpass@example.com", "username": "LongPass", "password": "A" * 73},
    )
    assert resp1.status_code == 422

    # Multibyte UTF-8 password: 20 4-byte emojis = 80 bytes (character length 20 <= 128, but bytes > 72)
    emoji_pass = "🔒" * 20
    assert len(emoji_pass) == 20
    assert len(emoji_pass.encode("utf-8")) == 80
    resp2 = client.post(
        "/api/auth/register",
        json={"email": "emojipass@example.com", "username": "EmojiPass", "password": emoji_pass},
    )
    assert resp2.status_code == 422
