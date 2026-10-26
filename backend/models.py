from sqlalchemy import (
    Column, Integer, String, Text, Boolean, Float, DateTime, ForeignKey, UniqueConstraint
)
from sqlalchemy.orm import relationship
from datetime import datetime, timezone

from database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(255), unique=True, index=True, nullable=False)
    username = Column(String(100), nullable=False)
    password_hash = Column(String(255), nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    decks = relationship("Deck", back_populates="owner", cascade="all, delete-orphan")
    study_progress = relationship("StudyProgress", back_populates="user", cascade="all, delete-orphan")
    notes = relationship("Note", cascade="all, delete-orphan")
    note_types = relationship("NoteType", cascade="all, delete-orphan")
    collection_operations = relationship("CollectionOperation", cascade="all, delete-orphan")
    study_operations = relationship("StudyOperation", cascade="all, delete-orphan")
    filtered_sessions = relationship('FilteredSession', cascade='all, delete-orphan')
    option_presets = relationship("OptionPreset", cascade="all, delete-orphan")


class Deck(Base):
    __tablename__ = "decks"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String(255), nullable=False)
    description = Column(Text, default="")
    settings = Column(Text, default="{}")
    is_shared = Column(Boolean, default=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    owner = relationship("User", back_populates="decks")
    cards = relationship("Card", back_populates="deck", cascade="all, delete-orphan")
    shared_info = relationship("SharedDeck", back_populates="deck", uselist=False, cascade="all, delete-orphan")
    package_data = relationship("PackageDeck", uselist=False, cascade="all, delete-orphan")
    options_binding = relationship("DeckOptionsBinding", uselist=False, cascade="all, delete-orphan")


class Card(Base):
    __tablename__ = "cards"

    id = Column(Integer, primary_key=True, index=True)
    deck_id = Column(Integer, ForeignKey("decks.id"), nullable=False)
    front = Column(Text, nullable=False)
    back = Column(Text, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    deck = relationship("Deck", back_populates="cards")
    study_progress = relationship("StudyProgress", back_populates="card", cascade="all, delete-orphan")
    note_link = relationship("NoteCard", back_populates="card", uselist=False, cascade="all, delete-orphan")
    review_logs = relationship("ReviewLog", back_populates="card", cascade="all, delete-orphan")
    package_data = relationship("PackageCard", uselist=False, cascade="all, delete-orphan")
    filtered_item = relationship("FilteredItem", uselist=False, cascade="all, delete-orphan", back_populates="card")
    scheduling = relationship("SchedulerState", uselist=False, cascade="all, delete-orphan")


class NoteType(Base):
    """Additive schema: existing card/progress tables do not require ALTER TABLE."""
    __tablename__ = "note_types"
    __table_args__ = (UniqueConstraint("user_id", "name"),)
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String(255), nullable=False)
    fields_json = Column(Text, nullable=False)
    templates_json = Column(Text, nullable=False)
    css = Column(Text, default="", nullable=False)
    package_data = relationship("PackageModel", uselist=False, cascade="all, delete-orphan")


class Note(Base):
    __tablename__ = "notes"
    __table_args__ = (UniqueConstraint("user_id", "guid"),)
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    note_type_id = Column(Integer, ForeignKey("note_types.id"), nullable=False)
    guid = Column(String(100), nullable=False)
    fields_json = Column(Text, nullable=False)
    tags_json = Column(Text, default="[]", nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))
    note_type = relationship("NoteType")
    card_links = relationship("NoteCard", back_populates="note", cascade="all, delete-orphan")
    package_data = relationship("PackageNote", uselist=False, cascade="all, delete-orphan")


class NoteCard(Base):
    """A separate link avoids modifying existing live Card rows on deployment."""
    __tablename__ = "note_cards"
    __table_args__ = (UniqueConstraint("note_id", "template_ord"),)
    card_id = Column(Integer, ForeignKey("cards.id"), primary_key=True)
    note_id = Column(Integer, ForeignKey("notes.id"), nullable=False, index=True)
    template_ord = Column(Integer, nullable=False, default=0)
    card = relationship("Card", back_populates="note_link")
    note = relationship("Note", back_populates="card_links")


class StudyProgress(Base):
    __tablename__ = "study_progress"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    card_id = Column(Integer, ForeignKey("cards.id"), nullable=False)
    ease_factor = Column(Float, default=2.5)
    interval_days = Column(Integer, default=0)
    repetitions = Column(Integer, default=0)
    next_review = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    last_reviewed = Column(DateTime, nullable=True)

    # Learning steps tracking
    learning_step = Column(Integer, default=0)        # Current step index in learning/relearning
    card_state = Column(String(20), default="new")    # "new", "learning", "review", "relearning"

    # Lapse & leech tracking
    lapse_count = Column(Integer, default=0)           # Number of times card lapsed
    is_leech = Column(Boolean, default=False)          # Marked as leech
    is_suspended = Column(Boolean, default=False)      # Suspended (leech action)

    user = relationship("User", back_populates="study_progress")
    card = relationship("Card", back_populates="study_progress")


class ReviewLog(Base):
    __tablename__ = "review_logs"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    card_id = Column(Integer, ForeignKey("cards.id"), nullable=False)
    rating = Column(Integer, nullable=False)
    was_new = Column(Boolean, default=False)
    review_date = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    user = relationship("User")
    card = relationship("Card", back_populates="review_logs")
    record = relationship("ReviewRecord", uselist=False, cascade="all, delete-orphan")


class OptionPreset(Base):
    __tablename__ = 'option_presets'
    __table_args__ = (UniqueConstraint('user_id','name'),)
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id'), nullable=False)
    name = Column(String(100), nullable=False)
    settings_json = Column(Text, nullable=False, default='{}')
    version = Column(Integer, nullable=False, default=0)


class DeckOptionsBinding(Base):
    __tablename__ = 'deck_options_bindings'
    deck_id = Column(Integer, ForeignKey('decks.id'), primary_key=True)
    preset_id = Column(Integer, ForeignKey('option_presets.id'), nullable=True)
    overrides_json = Column(Text, nullable=False, default='{}')
    today_json = Column(Text, nullable=False, default='{}')
    preset = relationship('OptionPreset')


class PackageDeck(Base):
    __tablename__ = 'package_decks'
    deck_id = Column(Integer, ForeignKey('decks.id'), primary_key=True)
    payload = Column(Text, nullable=False)


class PackageModel(Base):
    __tablename__ = 'package_models'
    note_type_id = Column(Integer, ForeignKey('note_types.id'), primary_key=True)
    payload = Column(Text, nullable=False)


class PackageNote(Base):
    __tablename__ = 'package_notes'
    note_id = Column(Integer, ForeignKey('notes.id'), primary_key=True)
    payload = Column(Text, nullable=False)


class PackageCard(Base):
    __tablename__ = 'package_cards'
    card_id = Column(Integer, ForeignKey('cards.id'), primary_key=True)
    payload = Column(Text, nullable=False)


class ReviewRecord(Base):
    __tablename__ = 'review_records'
    review_log_id = Column(Integer, ForeignKey('review_logs.id'), primary_key=True)
    payload = Column(Text, nullable=False)


class SchedulerState(Base):
    __tablename__ = 'scheduler_states'
    card_id = Column(Integer, ForeignKey('cards.id'), primary_key=True)
    fsrs_json = Column(Text, nullable=True)
    buried_until = Column(DateTime, nullable=True)
    version = Column(Integer, nullable=False, default=0)


class StudyOperation(Base):
    __tablename__ = 'study_operations'
    __table_args__ = (UniqueConstraint('user_id', 'request_id'),)
    id = Column(String(36), primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id'), nullable=False, index=True)
    card_id = Column(Integer, nullable=False)
    request_id = Column(String(100), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    before_json = Column(Text, nullable=False)
    response_json = Column(Text, nullable=False)
    undone = Column(Boolean, nullable=False, default=False)


class SharedDeck(Base):
    __tablename__ = "shared_decks"

    id = Column(Integer, primary_key=True, index=True)
    deck_id = Column(Integer, ForeignKey("decks.id"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    title = Column(String(255), nullable=False)
    description = Column(Text, default="")
    category = Column(String(100), default="Other")
    download_count = Column(Integer, default=0)
    rating = Column(Float, default=0.0)
    rating_count = Column(Integer, default=0)
    notes_count = Column(Integer, default=0)
    has_audio = Column(Boolean, default=False)
    has_images = Column(Boolean, default=False)
    shared_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    deck = relationship("Deck", back_populates="shared_info")
    owner = relationship("User", foreign_keys=[user_id])


class FilteredSession(Base):
    """Saved search and temporary membership; cards always retain their home deck."""
    __tablename__ = 'filtered_sessions'
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id'), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    search = Column(Text, nullable=False, default='')
    limit = Column(Integer, nullable=False, default=100)
    order = Column(String(32), nullable=False, default='oldest')
    reschedule = Column(Boolean, nullable=False, default=False)
    preview_again_seconds = Column(Integer, nullable=False, default=60)
    preview_hard_seconds = Column(Integer, nullable=False, default=600)
    preview_good_seconds = Column(Integer, nullable=False, default=0)
    version = Column(Integer, nullable=False, default=0)
    definition = relationship('FilteredDefinition', uselist=False, cascade='all, delete-orphan')
    items = relationship('FilteredItem', cascade='all, delete-orphan', back_populates='session')


class FilteredItem(Base):
    __tablename__ = 'filtered_items'
    card_id = Column(Integer, ForeignKey('cards.id'), primary_key=True)
    session_id = Column(Integer, ForeignKey('filtered_sessions.id'), nullable=False, index=True)
    position = Column(Integer, nullable=False)
    available_at = Column(DateTime, nullable=True)
    session = relationship('FilteredSession', back_populates='items')
    card = relationship('Card', back_populates='filtered_item')


class CollectionOperation(Base):
    __tablename__ = 'collection_operations'
    id = Column(String(36), primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id'), nullable=False, index=True)
    action = Column(String(64), nullable=False)
    before_json = Column(Text, nullable=False)
    after_hash = Column(String(64), nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    undone = Column(Boolean, nullable=False, default=False)


class FilteredDefinition(Base):
    __tablename__ = 'filtered_definitions'
    session_id = Column(Integer, ForeignKey('filtered_sessions.id'), primary_key=True)
    filters_json = Column(Text, nullable=False, default='[]')
