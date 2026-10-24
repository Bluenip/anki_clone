from pydantic import BaseModel, EmailStr, Field, ConfigDict, field_validator
from typing import Optional, Literal
from datetime import datetime


# ─── Auth ───────────────────────────────────────────────

class UserRegister(BaseModel):
    email: EmailStr
    username: str
    password: str

    @field_validator("username")
    @classmethod
    def validate_username(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 2:
            raise ValueError("Username must be at least 2 characters")
        if len(v) > 50:
            raise ValueError("Username must be at most 50 characters")
        return v

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        if len(v.encode("utf-8")) > 72:
            raise ValueError("Password must not exceed 72 bytes (bcrypt maximum limit)")
        if len(v) > 72:
            raise ValueError("Password must be at most 72 characters")
        return v


class UserLogin(BaseModel):
    email: EmailStr
    password: str

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        if len(v.encode("utf-8")) > 72:
            raise ValueError("Password must not exceed 72 bytes")
        return v


class UserResponse(BaseModel):
    id: int
    email: str
    username: str
    created_at: datetime

    class Config:
        from_attributes = True


class EmailUpdate(BaseModel):
    new_email: EmailStr
    password: str

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        if len(v.encode("utf-8")) > 72:
            raise ValueError("Password must not exceed 72 bytes")
        return v


class PasswordUpdate(BaseModel):
    current_password: str
    new_password: str

    @field_validator("current_password")
    @classmethod
    def validate_current_password(cls, v: str) -> str:
        if len(v.encode("utf-8")) > 72:
            raise ValueError("Current password must not exceed 72 bytes")
        return v

    @field_validator("new_password")
    @classmethod
    def validate_new_password(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("New password must be at least 8 characters")
        if len(v.encode("utf-8")) > 72:
            raise ValueError("New password must not exceed 72 bytes (bcrypt maximum limit)")
        if len(v) > 72:
            raise ValueError("New password must be at most 72 characters")
        return v



class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse


# ─── Decks ──────────────────────────────────────────────

class DeckSettings(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)
    fsrs: bool = False
    fsrs_fuzz: bool = False
    fsrs_desired_retention: float = Field(default=0.9, ge=0.7, le=0.99, allow_inf_nan=False)
    fsrs_parameters: Optional[list[float]] = Field(default=None, min_length=21, max_length=21)
    timezone: str = "UTC"
    day_starts_at: int = Field(default=0, ge=0, le=23)
    learning_ahead_seconds: int = Field(default=0, ge=0, le=3600)
    new_cards_ignore_review_limit: bool = False
    limits_start_from_top: bool = False
    bury_new_siblings: bool = False
    bury_review_siblings: bool = False
    bury_interday_learning_siblings: bool = False
    maximum_answer_seconds: int = Field(default=60, ge=1, le=3600)
    new_cards_per_day: int = Field(default=20, ge=0, le=999999)
    maximum_reviews_per_day: int = Field(default=200, ge=0, le=999999)
    learning_steps: str = "1m 10m"
    graduating_interval: int = Field(default=1, ge=1, le=36500)
    easy_interval: int = Field(default=4, ge=1, le=36500)
    insertion_order: str = "Sequential (oldest cards first)"
    relearning_steps: str = "10m"
    minimum_interval: int = Field(default=1, ge=1, le=36500)
    leech_threshold: int = Field(default=8, ge=1, le=999999)
    leech_action: str = "Tag Only"
    new_card_gather_order: str = "Deck"
    new_card_sort_order: str = "Card type, then order gathered"
    new_review_order: str = "Mix with reviews"
    interday_learning_review_order: str = "Mix with reviews"
    review_sort_order: str = "Due date, then random"
    maximum_interval: int = Field(default=36500, ge=1, le=36500)
    starting_ease: float = Field(default=2.50, ge=1.3, le=10, allow_inf_nan=False)
    easy_bonus: float = Field(default=1.30, ge=1, le=10, allow_inf_nan=False)
    interval_modifier: float = Field(default=1.00, ge=0.01, le=10, allow_inf_nan=False)
    hard_interval: float = Field(default=1.20, ge=1, le=10, allow_inf_nan=False)
    new_interval: float = Field(default=0.00, ge=0, le=1, allow_inf_nan=False)
    wait_for_audio: bool = True
    dont_play_audio_automatically: bool = False
    skip_question_when_replaying_answer: bool = False
    show_on_screen_timer: bool = False
    stop_on_screen_timer_on_answer: bool = False
    seconds_to_show_question_for: float = Field(default=0, ge=0, le=3600, allow_inf_nan=False)
    seconds_to_show_answer_for: float = Field(default=0, ge=0, le=3600, allow_inf_nan=False)
    question_action: str = "Show Answer"
    answer_action: str = "Bury Card"

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value):
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("Unknown IANA timezone") from None
        return value

    @field_validator("fsrs_parameters")
    @classmethod
    def valid_fsrs_parameters(cls, value):
        if value is not None:
            import math
            if not all(math.isfinite(x) for x in value):
                raise ValueError("FSRS parameters must be finite")
            from fsrs import Scheduler
            Scheduler(parameters=value)
        return value

    @field_validator("learning_steps", "relearning_steps")
    @classmethod
    def validate_steps(cls, value: str) -> str:
        import re
        for token in value.split():
            match = re.fullmatch(r"(\d+(?:\.\d+)?)([smhd]?)", token, flags=re.I)
            if not match or float(match[1]) <= 0:
                raise ValueError("Steps must be positive durations such as 1m 10m")
            seconds = float(match[1]) * {"s": 1, "m": 60, "h": 3600, "d": 86400, "": 60}[match[2].lower()]
            if seconds < 1 or seconds > 365 * 86400:
                raise ValueError("Each step must be between one second and one year")
        return value

class DeckCreate(BaseModel):
    name: str
    description: Optional[str] = ""

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Deck name cannot be empty")
        if any(not part.strip() for part in v.split('::')):
            raise ValueError("Deck hierarchy cannot contain an empty name")
        if len(v) > 100:
            raise ValueError("Deck name must be at most 100 characters")
        return v

    @field_validator("description")
    @classmethod
    def validate_description(cls, v: Optional[str]) -> str:
        if v is None:
            return ""
        if len(v) > 500:
            raise ValueError("Description must be at most 500 characters")
        return v

class DeckUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    settings: Optional[str] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            v = v.strip()
            if not v:
                raise ValueError("Deck name cannot be empty")
            if any(not part.strip() for part in v.split('::')):
                raise ValueError("Deck hierarchy cannot contain an empty name")
            if len(v) > 100:
                raise ValueError("Deck name must be at most 100 characters")
        return v

    @field_validator("description")
    @classmethod
    def validate_description(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and len(v) > 500:
            raise ValueError("Description must be at most 500 characters")
        return v

    @field_validator("settings")
    @classmethod
    def validate_settings(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            import json
            if len(v) > 10000:
                raise ValueError("Settings payload too large")
            try:
                parsed = json.loads(v)
            except (ValueError, TypeError):
                raise ValueError("Settings must be a JSON object") from None
            if not isinstance(parsed, dict):
                raise ValueError("Settings must be a JSON object")
            try:
                json.dumps(parsed, allow_nan=False)
            except ValueError:
                raise ValueError("Settings must contain finite JSON numbers") from None
            DeckSettings.model_validate(parsed)
        return v

class ImportRequest(BaseModel):
    text: str
    separator: str = "\t"
    kind: Optional[Literal["basic", "reversed", "optional_reversed", "cloze"]] = None
    note_type_id: Optional[int] = None
    use_file_decks: bool = False
    field_columns: Optional[dict[str, int]] = None
    tags_column: Optional[int] = None
    tags: list[str] = Field(default_factory=list)
    front_column: int = 0
    back_column: int = 1
    guid_column: Optional[int] = None
    has_header: bool = False
    allow_html: bool = True
    duplicate_policy: Literal["add", "skip", "update"] = "add"
    preview: bool = False

    @field_validator("text")
    @classmethod
    def validate_text(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Import text cannot be empty")
        if len(v) > 1_000_000:
            raise ValueError("Import text must not exceed 1 MB")
        return v

    @field_validator("separator")
    @classmethod
    def validate_separator(cls, v: str) -> str:
        if len(v) != 1 or v in '\r\n\0"':
            raise ValueError("Invalid separator")
        return v

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

    @field_validator("front")
    @classmethod
    def validate_front(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Card front cannot be empty")
        if len(v) > 50000:
            raise ValueError("Card front must be at most 50,000 characters")
        return v

    @field_validator("back")
    @classmethod
    def validate_back(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Card back cannot be empty")
        if len(v) > 50000:
            raise ValueError("Card back must be at most 50,000 characters")
        return v


class CardUpdate(BaseModel):
    expected_version: Optional[int] = Field(default=None, ge=0, strict=True)
    front: Optional[str] = None
    back: Optional[str] = None

    @field_validator("front")
    @classmethod
    def validate_front(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            v = v.strip()
            if not v:
                raise ValueError("Card front cannot be empty")
            if len(v) > 50000:
                raise ValueError("Card front must be at most 50,000 characters")
        return v

    @field_validator("back")
    @classmethod
    def validate_back(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            v = v.strip()
            if not v:
                raise ValueError("Card back cannot be empty")
            if len(v) > 50000:
                raise ValueError("Card back must be at most 50,000 characters")
        return v


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
    version: int = 0
    card_state: str = "new"
    is_suspended: bool = False
    is_buried: bool = False
    note_id: Optional[int] = None
    deck_name: str
    next_review: Optional[datetime] = None
    interval_days: Optional[int] = None


# ─── Study ──────────────────────────────────────────────

class TodayStatsResponse(BaseModel):
    cards_studied: int = 0
    seconds_studied: int = 0

class ReviewRequest(BaseModel):
    study_deck_id: Optional[int] = Field(default=None, ge=1)
    rating: int = Field(ge=1, le=4)
    duration_ms: int = Field(default=0, ge=0, le=3600000)
    request_id: Optional[str] = Field(default=None, min_length=1, max_length=100)
    expected_version: Optional[int] = Field(default=None, ge=0)


class StudyCardResponse(BaseModel):
    card_id: int
    front: str
    back: str
    deck_name: str
    is_new: bool = False
    card_state: str = "new"
    learning_step: int = 0
    intervals: Optional[dict] = None
    version: int = 0
    note_id: Optional[int] = None
    card_css: str = ""
    rendered: bool = False
    settings: dict = Field(default_factory=dict)

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
    next_learning_at: Optional[datetime] = None


class ReviewResponse(BaseModel):
    version: int = 0
    operation_id: Optional[str] = None
    scheduler: str = "sm2"
    initialization: Optional[str] = None
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

    @field_validator("title")
    @classmethod
    def validate_title(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Deck title cannot be empty")
        if len(v) > 100:
            raise ValueError("Deck title must be at most 100 characters")
        return v

    @field_validator("description")
    @classmethod
    def validate_description(cls, v: Optional[str]) -> str:
        if v is None:
            return ""
        if len(v) > 2000:
            raise ValueError("Description must be at most 2000 characters")
        return v


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
