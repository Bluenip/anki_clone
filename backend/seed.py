from database import SessionLocal
from models import User, Deck, Card, SharedDeck
from auth import get_password_hash

def seed():
    db = SessionLocal()
    
    # 1. Create the user's account
    user = db.query(User).filter(User.email == "thaituan23062007@gmail.com").first()
    if not user:
        user = User(
            email="thaituan23062007@gmail.com",
            username="Thai Tuan",
            password_hash=get_password_hash("qH6PknXGZvzviaa")
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        print("Created user:", user.email)
    else:
        print("User already exists:", user.email)
    
    # 2. Create a dummy admin for shared decks
    admin = db.query(User).filter(User.email == "admin@ankiclone.com").first()
    if not admin:
        admin = User(
            email="admin@ankiclone.com",
            username="AnkiClone Admin",
            password_hash=get_password_hash("admin123")
        )
        db.add(admin)
        db.commit()
        db.refresh(admin)

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
