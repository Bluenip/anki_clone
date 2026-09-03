from pydantic import BaseModel, EmailStr
from typing import Optional
from datetime import datetime


# ─── Auth ───────────────────────────────────────────────

class UserRegister(BaseModel):
    email: str
    username: str
    password: str


class UserLogin(BaseModel):
    email: str
    password: str


class UserResponse(BaseModel):
    id: int
    email: str
    username: str
    created_at: datetime

    class Config:
        from_attributes = True


class EmailUpdate(BaseModel):
    new_email: str
    password: str


class PasswordUpdate(BaseModel):
    current_password: str
    new_password: str


class ForgotPasswordRequest(BaseModel):
    email: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse


# ─── Decks ──────────────────────────────────────────────

class DeckSettings(BaseModel):
    new_cards_per_day: int = 20
    maximum_reviews_per_day: int = 200
    learning_steps: str = "1m 10m"
    graduating_interval: int = 1
    easy_interval: int = 4
    insertion_order: str = "Sequential (oldest cards first)"
    relearning_steps: str = "10m"
    minimum_interval: int = 1
    leech_threshold: int = 8
    leech_action: str = "Tag Only"
    new_card_gather_order: str = "Deck"
    new_card_sort_order: str = "Card type, then order gathered"
    new_review_order: str = "Mix with reviews"
    interday_learning_review_order: str = "Mix with reviews"
    review_sort_order: str = "Due date, then random"
    maximum_interval: int = 36500
    starting_ease: float = 2.50
    easy_bonus: float = 1.30
    interval_modifier: float = 1.00
    hard_interval: float = 1.20
    new_interval: float = 0.00
    wait_for_audio: bool = True
    question_action: str = "Show Answer"
    answer_action: str = "Bury Card"

class DeckCreate(BaseModel):
    name: str
    description: Optional[str] = ""

class DeckUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    settings: Optional[str] = None

class ImportRequest(BaseModel):
    text: str
    separator: str = "\t"

class DeckResponse(BaseModel):
    id: int
    name: str
    description: str
    settings: str
    is_shared: bool
    created_at: datetime
    updated_at: datetime
    total_cards: int = 0
    new_cards: int = 0
    learn_cards: int = 0
    due_cards: int = 0

    class Config:
        from_attributes = True


# ─── Cards ──────────────────────────────────────────────

class CardCreate(BaseModel):
    front: str
    back: str


class CardUpdate(BaseModel):
    front: Optional[str] = None
    back: Optional[str] = None


class CardResponse(BaseModel):
    id: int
    deck_id: int
    front: str
    back: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class BrowseCardResponse(CardResponse):
    deck_name: str
    next_review: Optional[datetime] = None
    interval_days: Optional[int] = None


# ─── Study ──────────────────────────────────────────────

class TodayStatsResponse(BaseModel):
    cards_studied: int = 0
    seconds_studied: int = 0

class ReviewRequest(BaseModel):
    rating: int  # 1=Again, 2=Hard, 3=Good, 4=Easy


class StudyCardResponse(BaseModel):
    card_id: int
    front: str
    back: str
    deck_name: str
    is_new: bool = False
    card_state: str = "new"
    learning_step: int = 0
    intervals: Optional[dict] = None

    class Config:
        from_attributes = True


class StudyStatsResponse(BaseModel):
    total_cards: int
    new_cards: int
    learn_cards: int = 0
    due_cards: int
    learned_cards: int
    avg_ease: float
    streak_days: int = 0


class ReviewResponse(BaseModel):
    next_review: datetime
    interval_days: int
    ease_factor: float
    message: str
    card_state: str = "review"
    is_leech: bool = False
    lapse_count: int = 0


# ─── Shared Decks ───────────────────────────────────────

class ShareDeckRequest(BaseModel):
    title: str
    description: Optional[str] = ""
    category: str = "Other"
    has_audio: bool = False
    has_images: bool = False


class SharedDeckResponse(BaseModel):
    id: int
    title: str
    description: str
    category: str
    download_count: int
    rating: float
    rating_count: int
    notes_count: int
    has_audio: bool
    has_images: bool
    shared_at: datetime
    username: str = ""

    class Config:
        from_attributes = True


class SharedDeckDetailResponse(SharedDeckResponse):
    deck_id: int
    user_id: int


class RateDeckRequest(BaseModel):
    rating: float  # 1.0 - 5.0
