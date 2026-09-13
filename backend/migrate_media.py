"""
Migration script: Add audio AND image tags to existing imported cards.

This script re-reads the original .apkg file and maps media (audio + images)
from all note fields back to the corresponding cards in the database.

Usage:
    python3 migrate_media.py <apkg_file_path> <deck_id> <user_id>
    
Example:
    python3 migrate_media.py /path/to/HSK.apkg 3 1
"""

import sys
import os
import zipfile
import sqlite3
import json
import re
import tempfile
import shutil

# Add parent dir to path for imports
sys.path.insert(0, os.path.dirname(__file__))

from database import SessionLocal
from models import Card

def migrate_media(apkg_path: str, deck_id: int, user_id: int):
    db = SessionLocal()
    media_dir = os.path.join(os.path.dirname(__file__), "media", str(user_id))
    os.makedirs(media_dir, exist_ok=True)
    
    try:
        with tempfile.TemporaryDirectory() as temp_dir:
            # Extract .apkg
            with zipfile.ZipFile(apkg_path, 'r') as z:
                z.extractall(temp_dir)
            
            col_file = os.path.join(temp_dir, "collection.anki2")
            if not os.path.exists(col_file):
                col_file = os.path.join(temp_dir, "collection.anki21")
            
            # Copy missing media files to media directory
            media_file = os.path.join(temp_dir, "media")
            media_mapping = {}
            if os.path.exists(media_file):
                with open(media_file, "r") as f:
                    media_mapping = json.load(f)
            
            media_copied = 0
            for num_key, filename in media_mapping.items():
                src_path = os.path.join(temp_dir, num_key)
                dst_path = os.path.join(media_dir, filename)
                if os.path.exists(src_path) and not os.path.exists(dst_path):
                    shutil.copy2(src_path, dst_path)
                    media_copied += 1
            
            print(f"📁 Copied {media_copied} new media files to {media_dir}")
            
            conn = sqlite3.connect(col_file)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            
            # Build mapping: note_id -> all fields
            cursor.execute("SELECT id, flds FROM notes")
            notes = {}
            for r in cursor.fetchall():
                flds = r['flds'].split('\x1f')
                notes[r['id']] = flds
            
            # Build mapping: front text -> (audio files, image files) from all fields
            cursor.execute("SELECT nid FROM cards ORDER BY id")
            front_to_media = {}
            for r in cursor.fetchall():
                flds = notes.get(r['nid'], [])
                if not flds:
                    continue
                    
                front_text = re.sub(r'<[^>]+>', '', flds[0]).strip() if flds else ""
                
                # Collect all media from ALL fields
                all_sounds = []
                all_images = []
                for field in flds:
                    sounds = re.findall(r'\[sound:([^\]]+)\]', field)
                    all_sounds.extend(sounds)
                    imgs = re.findall(r'<img[^>]+src=["\']([^"\']+)["\'][^>]*>', field)
                    all_images.extend(imgs)
                
                if (all_sounds or all_images) and front_text:
                    front_to_media[front_text] = {
                        'sounds': all_sounds,
                        'images': [img for img in all_images 
                                   if not img.startswith('http://') and not img.startswith('https://')]
                    }
            
            conn.close()
        
        # Now update cards in our database
        cards = db.query(Card).filter(Card.deck_id == deck_id).all()
        updated_audio = 0
        updated_images = 0
        
        for card in cards:
            front_clean = re.sub(r'<[^>]+>', '', card.front).strip()
            media = front_to_media.get(front_clean)
            if not media:
                continue
            
            changed = False
            
            # Add missing audio
            if media['sounds'] and '<audio' not in card.back:
                for sound_file in media['sounds']:
                    card.back += f'\n<audio src="/api/media/{user_id}/{sound_file}" controls class="anki-audio"></audio>'
                updated_audio += 1
                changed = True
            
            # Add missing images
            if media['images'] and '<img' not in card.back:
                for img_file in media['images']:
                    card.back += f'\n<img src="/api/media/{user_id}/{img_file}">'
                updated_images += 1
                changed = True
        
        db.commit()
        print(f"✅ Updated {updated_audio} cards with audio, {updated_images} cards with images")
        print(f"   (out of {len(cards)} total cards in deck {deck_id})")
        
    except Exception as e:
        db.rollback()
        print(f"❌ Error: {e}")
        raise
    finally:
        db.close()

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: python3 migrate_media.py <apkg_file_path> <deck_id> <user_id>")
        sys.exit(1)
    
    apkg_path = sys.argv[1]
    deck_id = int(sys.argv[2])
    user_id = int(sys.argv[3])
    
    if not os.path.exists(apkg_path):
        print(f"❌ File not found: {apkg_path}")
        sys.exit(1)
    
    migrate_media(apkg_path, deck_id, user_id)

