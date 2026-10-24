import os
import warnings
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
import bcrypt
from sqlalchemy.orm import Session

from database import get_db
from models import User

# Configuration — đọc SECRET_KEY từ biến môi trường
_DEFAULT_DEV_KEY = "anki-clone-dev-key-NOT-for-production"


def resolve_jwt_secret(env: Optional[str] = None, secret_key: Optional[str] = None) -> str:
    """Resolve and validate JWT secret key based on environment."""
    env_mode = (env if env is not None else os.environ.get("APP_ENV", os.environ.get("ENV", "development"))).lower()
    raw_key = (secret_key if secret_key is not None else os.environ.get("JWT_SECRET_KEY", "")).strip()

    if env_mode == "production":
        if not raw_key or raw_key == _DEFAULT_DEV_KEY or len(raw_key) < 32:
            raise RuntimeError(
                "JWT_SECRET_KEY environment variable must be set to a strong random key "
                "(at least 32 characters) in production. APP_ENV=production detected."
            )
        return raw_key

    if not raw_key:
        warnings.warn(
            "JWT_SECRET_KEY not set — using insecure dev key. "
            "Set JWT_SECRET_KEY env var before deploying.",
            stacklevel=2,
        )
        return _DEFAULT_DEV_KEY

    return raw_key


SECRET_KEY = resolve_jwt_secret()


ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_HOURS = 24 * 7  # 7 days

security = HTTPBearer()


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a bcrypt hash.

    Rejects passwords beyond the API's 72-byte limit and NUL characters.
    Returns ``False`` for malformed hashes or any verification failure.
    """
    try:
        # Encode password to UTF-8 bytes as bcrypt expects
        pwd_bytes = plain_password.encode("utf-8")
    except UnicodeEncodeError:
        return False
    # bcrypt limits passwords to 72 bytes and disallows NUL
    if len(pwd_bytes) > 72 or b"\x00" in pwd_bytes:
        return False
    try:
        # bcrypt expects hash as bytes
        return bcrypt.checkpw(pwd_bytes, hashed_password.encode("utf-8"))
    except (ValueError, TypeError, AttributeError):
        # Includes malformed hash format
        return False


def get_password_hash(password: str) -> str:
    """Hash a password using bcrypt with a cost of 12.

    Enforces the API's 72-byte limit and preserves Passlib's NUL restriction.
    Raises ``ValueError`` if the password is invalid.
    """
    pwd_bytes = password.encode("utf-8")
    if len(pwd_bytes) > 72 or b"\x00" in pwd_bytes:
        raise ValueError("Password exceeds bcrypt 72-byte limit or contains NUL byte")
    # Keep the existing bcrypt work factor and hash format.
    return bcrypt.hashpw(pwd_bytes, bcrypt.gensalt(rounds=12)).decode("utf-8")


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS)
    )
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db),
) -> User:
    token = credentials.credentials
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id_str = payload.get("sub")
        if user_id_str is None:
            raise credentials_exception
        user_id = int(user_id_str)
    except JWTError:
        raise credentials_exception

    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise credentials_exception
    return user
