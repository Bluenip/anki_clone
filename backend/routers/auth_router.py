import os

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response, status
from sqlalchemy.orm import Session

from database import get_db
from models import User
from schemas import UserRegister, UserLogin, UserResponse, TokenResponse, EmailUpdate, PasswordUpdate, ForgotPasswordRequest, ResetPasswordRequest
from auth import (verify_password, get_password_hash, create_session_token, get_current_user, create_reset_token,
                  verify_reset_token, set_media_cookie, clear_media_cookie)
import rate_limit
from mailer import send_reset_email

router = APIRouter(prefix="/api/auth", tags=["Authentication"])


@router.post("/register", response_model=TokenResponse)
def register(data: UserRegister, request: Request, response: Response, db: Session = Depends(get_db)):
    rate_limit.check('register', rate_limit.client_ip(request), 10, 3600)
    # Check if email already exists
    existing = db.query(User).filter(User.email == data.email).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered",
        )

    from account_lifecycle import allocate_user_id
    user = User(
        id=allocate_user_id(db),
        email=data.email,
        username=data.username,
        password_hash=get_password_hash(data.password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    token = create_session_token(user)
    set_media_cookie(response, request, user)
    return TokenResponse(
        access_token=token,
        user=UserResponse.model_validate(user),
    )


@router.post("/login", response_model=TokenResponse)
def login(data: UserLogin, request: Request, response: Response, db: Session = Depends(get_db)):
    # Per address and per account, so neither one client nor many can keep guessing a password.
    rate_limit.check('login-ip', rate_limit.client_ip(request), 20, 300)
    rate_limit.check('login-account', data.email.strip().lower(), 10, 900)
    user = db.query(User).filter(User.email == data.email).first()
    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    token = create_session_token(user)
    set_media_cookie(response, request, user)
    return TokenResponse(
        access_token=token,
        user=UserResponse.model_validate(user),
    )


@router.get("/me", response_model=UserResponse)
def get_me(request: Request, response: Response, current_user: User = Depends(get_current_user)):
    set_media_cookie(response, request, current_user)  # refreshed on every app load
    return current_user


@router.post("/logout")
def logout(response: Response):
    clear_media_cookie(response)
    return {"detail": "Signed out"}


@router.post("/forgot-password")
def forgot_password(data: ForgotPasswordRequest, request: Request, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    rate_limit.check('forgot-ip', rate_limit.client_ip(request), 10, 3600)
    rate_limit.check('forgot-account', data.email.strip().lower(), 3, 3600)
    user = db.query(User).filter(User.email == data.email).first()
    if user:
        base_url = os.environ.get("APP_BASE_URL", "http://localhost:3456").rstrip("/")
        link = f"{base_url}/reset-password?token={create_reset_token(user)}"
        # Sent after the response so timing does not reveal whether the account exists.
        background_tasks.add_task(send_reset_email, user.email, link)
    return {
        "message": (
            "If an account with that email exists, a password reset link has been sent. "
            "Check your inbox (and spam folder)."
        )
    }


@router.post("/reset-password")
def reset_password(data: ResetPasswordRequest, db: Session = Depends(get_db)):
    user = verify_reset_token(data.token, db)
    if user is None:
        raise HTTPException(status_code=400, detail="Reset link is invalid or has expired")
    user.password_hash = get_password_hash(data.new_password)
    db.commit()
    return {"detail": "Password has been reset"}


@router.put("/me/email", response_model=UserResponse)
def update_email(
    data: EmailUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if not verify_password(data.password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Incorrect password")
    
    # Check if email already exists for another user
    existing = db.query(User).filter(User.email == data.new_email, User.id != current_user.id).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
        
    current_user.email = data.new_email
    db.commit()
    db.refresh(current_user)
    return current_user


@router.put("/me/password")
def update_password(
    data: PasswordUpdate,
    request: Request,
    response: Response,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if not verify_password(data.current_password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Incorrect current password")
        
    current_user.password_hash = get_password_hash(data.new_password)
    db.commit()
    # Every other session is now signed out; this one continues with a fresh token.
    set_media_cookie(response, request, current_user)
    return {"detail": "Password updated successfully", "access_token": create_session_token(current_user)}


@router.delete("/me")
def delete_account(
    response: Response,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    from account_lifecycle import purge_account_files
    try:
        user_id = current_user.id
        db.delete(current_user)
        # Surface database errors before removing files. Do not report success
        # when filesystem cleanup failed; keep the account available for retry.
        db.flush()
        purge_account_files(user_id)
        db.commit()
    except Exception:
        db.rollback()
        raise
    from account_lifecycle import mark_deleted
    import tts_service
    mark_deleted(user_id)  # background audio threads must not recreate the media folder
    tts_service.cancel_jobs(user_id)
    clear_media_cookie(response)
    return {"detail": "Account deleted successfully"}
