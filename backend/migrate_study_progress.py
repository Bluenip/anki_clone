"""
Database migration: Add learning steps, card state, and leech tracking columns to study_progress.

Run this script once to migrate existing databases.
New databases will have these columns automatically via SQLAlchemy create_all.
"""
import sqlite3
import os
import sys

BASE_DIR = os.getenv("DATABASE_DIR", os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, "anki.db")

if not os.path.exists(DB_PATH):
    print(f"Database not found at {DB_PATH}. Skipping migration (will be created fresh).")
    sys.exit(0)

conn = sqlite3.connect(DB_PATH)
cursor = conn.cursor()

# Get existing columns
cursor.execute("PRAGMA table_info(study_progress)")
existing_columns = {row[1] for row in cursor.fetchall()}

migrations = [
    ("learning_step", "INTEGER DEFAULT 0"),
    ("card_state", "VARCHAR(20) DEFAULT 'new'"),
    ("lapse_count", "INTEGER DEFAULT 0"),
    ("is_leech", "BOOLEAN DEFAULT 0"),
    ("is_suspended", "BOOLEAN DEFAULT 0"),
]

applied = 0
for col_name, col_type in migrations:
    if col_name not in existing_columns:
        sql = f"ALTER TABLE study_progress ADD COLUMN {col_name} {col_type}"
        print(f"  Adding column: {col_name} ({col_type})")
        cursor.execute(sql)
        applied += 1
    else:
        print(f"  Column already exists: {col_name}")

if applied > 0:
    # Fix card_state for existing records based on their current data
    # Cards with interval_days > 0 and repetitions > 0 are in "review" state
    cursor.execute("""
        UPDATE study_progress 
        SET card_state = 'review' 
        WHERE interval_days > 0 AND repetitions > 0
    """)
    review_count = cursor.rowcount

    # Cards with interval_days == 0 but have been reviewed are in "learning" state
    cursor.execute("""
        UPDATE study_progress 
        SET card_state = 'learning' 
        WHERE interval_days = 0 AND repetitions > 0 AND last_reviewed IS NOT NULL
    """)
    learning_count = cursor.rowcount

    print(f"\n  Migrated {review_count} cards to 'review' state")
    print(f"  Migrated {learning_count} cards to 'learning' state")
    print(f"  Remaining cards stay as 'new' (default)")

conn.commit()
conn.close()

print(f"\nMigration complete! ({applied} columns added)")
