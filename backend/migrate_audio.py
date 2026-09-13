"""
Migration script: Add audio tags to existing imported cards.

This script re-reads the original .apkg file and maps audio [sound:] tags
from all note fields back to the corresponding cards in the database.

Usage:
    python3 migrate_audio.py <apkg_file_path> <deck_id> <user_id>
    
Example:
    python3 migrate_audio.py /path/to/Korean_Grammar.apkg 2 1
"""

import sys
import os
import zipfile
import sqlite3
import json
import re
import tempfile

# Add parent dir to path for imports
sys.path.insert(0, os.path.dirname(__file__))

from database import SessionLocal
from models import Card

def migrate_audio(apkg_path: str, deck_id: int, user_id: int):
    db = SessionLocal()
    
    try:
        with tempfile.TemporaryDirectory() as temp_dir:
            # Extract .apkg
            with zipfile.ZipFile(apkg_path, 'r') as z:
                z.extractall(temp_dir)
            
            col_file = os.path.join(temp_dir, "collection.anki2")
            if not os.path.exists(col_file):
                col_file = os.path.join(temp_dir, "collection.anki21")
            
            conn = sqlite3.connect(col_file)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            
            # Build mapping: note_id -> all fields
            cursor.execute("SELECT id, flds FROM notes")
            notes = {}
            for r in cursor.fetchall():
                flds = r['flds'].split('\x1f')
                notes[r['id']] = flds
            
            # Build mapping: card front text -> audio files from all fields
            cursor.execute("SELECT nid FROM cards ORDER BY id")
            front_to_audio = {}
            for r in cursor.fetchall():
                flds = notes.get(r['nid'], [])
                if not flds:
                    continue
                    
                front_text = flds[0].strip() if len(flds) > 0 else ""
                
                # Collect all [sound:] tags from ALL fields
                all_sounds = []
                for field in flds:
                    sounds = re.findall(r'\[sound:([^\]]+)\]', field)
                    all_sounds.extend(sounds)
                
                if all_sounds and front_text:
                    front_to_audio[front_text] = all_sounds
            
            conn.close()
        
        # Now update cards in our database
        cards = db.query(Card).filter(Card.deck_id == deck_id).all()
        updated = 0
        
        for card in cards:
            # Strip HTML to match against original front text
            front_clean = re.sub(r'<[^>]+>', '', card.front).strip()
            
            audio_files = front_to_audio.get(front_clean)
            if not audio_files:
                continue
            
            # Check if card already has audio
            if '<audio' in card.back:
                continue
            
            # Append audio tags to back
            audio_html = ""
            for sound_file in audio_files:
                audio_html += f'\n<audio src="/api/media/{user_id}/{sound_file}" controls class="anki-audio"></audio>'
            
            card.back = card.back + audio_html
            updated += 1
        
        db.commit()
        print(f"✅ Updated {updated} cards with audio tags (out of {len(cards)} total)")
        print(f"   Deck ID: {deck_id}, User ID: {user_id}")
        
    except Exception as e:
        db.rollback()
        print(f"❌ Error: {e}")
        raise
    finally:
        db.close()

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: python3 migrate_audio.py <apkg_file_path> <deck_id> <user_id>")
        sys.exit(1)
    
    apkg_path = sys.argv[1]
    deck_id = int(sys.argv[2])
    user_id = int(sys.argv[3])
    
    if not os.path.exists(apkg_path):
        print(f"❌ File not found: {apkg_path}")
        sys.exit(1)
    
    migrate_audio(apkg_path, deck_id, user_id)

