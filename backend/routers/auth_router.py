from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from database import get_db
from models import User
from schemas import UserRegister, UserLogin, UserResponse, TokenResponse, EmailUpdate, PasswordUpdate, ForgotPasswordRequest
from auth import verify_password, get_password_hash, create_access_token, get_current_user

router = APIRouter(prefix="/api/auth", tags=["Authentication"])


@router.post("/register", response_model=TokenResponse)
def register(data: UserRegister, db: Session = Depends(get_db)):
    # Check if email already exists
    existing = db.query(User).filter(User.email == data.email).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered",
        )

    user = User(
        email=data.email,
        username=data.username,
        password_hash=get_password_hash(data.password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    token = create_access_token(data={"sub": str(user.id)})
    return TokenResponse(
        access_token=token,
        user=UserResponse.model_validate(user),
    )


@router.post("/login", response_model=TokenResponse)
def login(data: UserLogin, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == data.email).first()
    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    token = create_access_token(data={"sub": str(user.id)})
    return TokenResponse(
        access_token=token,
        user=UserResponse.model_validate(user),
    )


@router.get("/me", response_model=UserResponse)
def get_me(current_user: User = Depends(get_current_user)):
    return current_user


@router.post("/forgot-password")
def forgot_password(data: ForgotPasswordRequest, db: Session = Depends(get_db)):
    # SECURITY: Luồng reset mật khẩu qua API bị vô hiệu hóa vì chưa có dịch vụ email.
    # Khi có email service: gửi link chứa token ngẫu nhiên một lần; không đổi mật khẩu ở đây.
    # Luồng cũ (đổi ngay & trả mật khẩu mới trong response) đã bị xóa vì rủi ro bảo mật P0.
    _ = data  # không truy vấn DB để tránh timing attack
    _ = db
    return {
        "message": (
            "If an account with that email exists, password reset instructions "
            "would be sent. Please contact support to reset your password."
        )
    }


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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if not verify_password(data.current_password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Incorrect current password")
        
    current_user.password_hash = get_password_hash(data.new_password)
    db.commit()
    return {"detail": "Password updated successfully"}


@router.delete("/me")
def delete_account(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    from media_utils import cleanup_user_media
    # Delete all media files for this user
    cleanup_user_media(current_user.id)
    
    db.delete(current_user)
    db.commit()
    return {"detail": "Account deleted successfully"}
