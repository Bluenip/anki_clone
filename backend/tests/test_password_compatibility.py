"""Compatibility with hashes produced by Passlib 1.7.4 and bcrypt 4.0.1."""

import pytest

from auth import get_password_hash, verify_password

# Synthetic legacy hashes generated using the original dependency versions.
# Keep fixtures in the repository so CI does not depend on local temporary files.
LEGACY_FIXTURES = [('password123', '$2b$12$XgiU.SLMezBtT0EITbFGuu3NHUt1r44DHiJGK5v/98LBA3YHLwP1i'), ('mật-khẩu-đã-tồn-tại', '$2b$12$0I8urZRJjQkrDwA6MnXJW.TCVe1.H0/wUOFfUuc9q/gqG/R6pb/AO'), ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '$2b$12$c82zQ6grb7Tn/Z8I1KChCeuGrQMkWOQ0cAoZa6lZiEdQtEpDhriSa'), ('🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒', '$2b$12$LF0uA.Nb8nuiIPM6ysVusO3TKgafkDQo9KFAXExpcubLJTeIg5NHu')]


@pytest.mark.parametrize("password,legacy_hash", LEGACY_FIXTURES)
@pytest.mark.parametrize("prefix", ["$2a$", "$2b$", "$2y$"])
def test_legacy_hashes_verify(password, legacy_hash, prefix):
    assert verify_password(password, prefix + legacy_hash[4:])


@pytest.mark.parametrize("password,legacy_hash", LEGACY_FIXTURES)
def test_wrong_password_rejected(password, legacy_hash):
    assert not verify_password("incorrect-password", legacy_hash)


@pytest.mark.parametrize("password", ["a" * 72, "🔒" * 18, "mật-khẩu-mới"])
def test_hash_round_trip_at_byte_boundary(password):
    hashed = get_password_hash(password)
    assert hashed.startswith("$2b$12$")
    assert verify_password(password, hashed)
    assert not verify_password("incorrect-password", hashed)


@pytest.mark.parametrize("password", ["a" * 73, "🔒" * 19, "abc\x00def"])
def test_invalid_password_rejected_without_truncation(password):
    with pytest.raises(ValueError):
        get_password_hash(password)
    assert not verify_password(password, LEGACY_FIXTURES[2][1])


@pytest.mark.parametrize("hashed", ["", "not-a-hash", "$2b$12$invalid", "$argon2id$invalid", "🔒"])
def test_malformed_or_unsupported_hash_returns_false(hashed):
    assert not verify_password("password123", hashed)


@pytest.mark.parametrize("prefix", ["$2a$", "$2b$", "$2y$"])
def test_existing_user_can_log_in_with_legacy_hash(client, db_session, user_a, prefix):
    user_a.password_hash = prefix + LEGACY_FIXTURES[0][1][4:]
    db_session.commit()
    response = client.post("/api/auth/login", json={
        "email": user_a.email, "password": LEGACY_FIXTURES[0][0],
    })
    assert response.status_code == 200
    assert response.json()["user"]["id"] == user_a.id
    assert response.json()["access_token"]
