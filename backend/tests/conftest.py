import os
import sys

import tempfile
import shutil

# Ensure backend directory is in sys.path
backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

_ORIGINAL_ENV = {
    "APP_ENV": os.environ.get("APP_ENV"),
    "JWT_SECRET_KEY": os.environ.get("JWT_SECRET_KEY"),
    "DATABASE_DIR": os.environ.get("DATABASE_DIR"),
    "MEDIA_DIR": os.environ.get("MEDIA_DIR"),
}

# CRITICAL: Isolate database and media directories into a temporary folder
# BEFORE importing database, main, or any application module.
TEST_TEMP_DIR = tempfile.mkdtemp(prefix="anki_test_isolated_")
os.environ["APP_ENV"] = "test"
os.environ["JWT_SECRET_KEY"] = "super-secret-test-key-at-least-32-chars-long-123456"
os.environ["DATABASE_DIR"] = TEST_TEMP_DIR
os.environ["MEDIA_DIR"] = os.path.join(TEST_TEMP_DIR, "media")
os.makedirs(os.environ["MEDIA_DIR"], exist_ok=True)

import pytest
import hashlib
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from database import Base, get_db

from main import app
from auth import get_password_hash, create_access_token
from models import User


# In-memory SQLite for tests
TEST_DATABASE_URL = "sqlite:///:memory:"

engine = create_engine(
    TEST_DATABASE_URL,
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture(scope="session", autouse=True)
def setup_test_db():
    source_db = os.path.join(backend_dir, "anki.db")
    source_media = os.path.join(backend_dir, "media")

    def _fp_file(p):
        if not os.path.exists(p) or not os.path.isfile(p):
            return None
        with open(p, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()

    def _fp_dir(d):
        if not os.path.exists(d) or not os.path.isdir(d):
            return None
        items = []
        for root, _, files in os.walk(d):
            for fn in sorted(files):
                fp = os.path.join(root, fn)
                with open(fp, "rb") as f:
                    items.append((os.path.relpath(fp, d), hashlib.sha256(f.read()).hexdigest()))
        return items

    db_fp_before = _fp_file(source_db)
    media_fp_before = _fp_dir(source_media)

    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)
    shutil.rmtree(TEST_TEMP_DIR, ignore_errors=True)

    # Verify source DB and media were never modified or corrupted during test run
    if db_fp_before is not None:
        db_fp_after = _fp_file(source_db)
        assert db_fp_after == db_fp_before, "Existing source anki.db was modified during test run!"

    if media_fp_before is not None:
        media_fp_after = _fp_dir(source_media)
        assert media_fp_after == media_fp_before, "Existing source media directory was modified during test run!"

    # Restore original environment
    for k, v in _ORIGINAL_ENV.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v



@pytest.fixture
def db_session():
    connection = engine.connect()
    transaction = connection.begin()
    # Make SQLite's outer transaction real before SAVEPOINTs. Request-level
    # rollback must not delete users/fixtures committed by earlier requests.
    if not connection.connection.driver_connection.in_transaction:
        connection.exec_driver_sql("BEGIN")
    session = TestingSessionLocal(bind=connection, join_transaction_mode="create_savepoint")

    yield session

    session.close()
    if transaction.is_active:
        transaction.rollback()
    connection.close()


@pytest.fixture
def client(db_session):
    def override_get_db():
        try:
            yield db_session
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture
def user_a(db_session):
    user = User(
        email="user_a@example.com",
        username="User A",
        password_hash=get_password_hash("password123"),
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


@pytest.fixture
def user_b(db_session):
    user = User(
        email="user_b@example.com",
        username="User B",
        password_hash=get_password_hash("password456"),
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


@pytest.fixture
def auth_headers_a(user_a):
    token = create_access_token({"sub": str(user_a.id)})
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def auth_headers_b(user_b):
    token = create_access_token({"sub": str(user_b.id)})
    return {"Authorization": f"Bearer {token}"}
