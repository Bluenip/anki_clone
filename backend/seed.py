from database import SessionLocal
from models import User, Deck, Card, SharedDeck
from auth import get_password_hash

def _account(db, email, username, password):
    user = db.query(User).filter(User.email == email).first()
    if user is None:
        user = User(email=email, username=username, password_hash=get_password_hash(password))
        db.add(user)
        db.commit()
        db.refresh(user)
        print("Created user:", user.email)
    return user


def seed():
    """Development data only. Credentials come from the environment and are never stored in the repository:

    SEED_EMAIL / SEED_PASSWORD   optional personal account
    SEED_ADMIN_PASSWORD          owner of the sample shared deck (random when unset)
    """
    import os
    import secrets
    db = SessionLocal()

    # 1. Optional personal account
    if os.getenv("SEED_EMAIL") and os.getenv("SEED_PASSWORD"):
        _account(db, os.environ["SEED_EMAIL"], os.getenv("SEED_USERNAME", "Dev User"), os.environ["SEED_PASSWORD"])

    # 2. Owner of the sample shared deck; without SEED_ADMIN_PASSWORD nobody can sign in to it
    admin = _account(db, "admin@ankiclone.com", "AnkiClone Admin",
                     os.getenv("SEED_ADMIN_PASSWORD") or secrets.token_urlsafe(32))

    # 3. Add a sample shared deck so the 'Shared Decks' page isn't empty
    shared = db.query(SharedDeck).first()
    if not shared:
        deck = Deck(
            user_id=admin.id,
            name="English 101: Basic Greetings",
            description="Essential english greetings for beginners.",
            is_shared=True
        )
        db.add(deck)
        db.commit()
        db.refresh(deck)

        cards = [
            Card(deck_id=deck.id, front="Hello", back="Xin chào"),
            Card(deck_id=deck.id, front="Good morning", back="Chào buổi sáng"),
            Card(deck_id=deck.id, front="Thank you", back="Cảm ơn"),
            Card(deck_id=deck.id, front="Goodbye", back="Tạm biệt")
        ]
        db.add_all(cards)
        db.commit()

        shared_deck = SharedDeck(
            deck_id=deck.id,
            user_id=admin.id,
            title="English 101: Basic Greetings",
            description="Essential english greetings for beginners. Includes 4 basic cards.",
            category="English",
            notes_count=4,
            rating=5.0,
            rating_count=1
        )
        db.add(shared_deck)
        db.commit()
        print("Created sample shared deck!")
    
    db.close()
    print("Seed complete!")

if __name__ == "__main__":
    seed()
