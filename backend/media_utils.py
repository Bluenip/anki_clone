"""
Utility functions for managing media files on disk.
Handles cleanup when cards, decks, or accounts are deleted.
"""

import os
import re
import shutil
import json
import html as html_entities
from urllib.parse import unquote
from typing import List, Set


# Base directory for media files
MEDIA_BASE = os.getenv("MEDIA_DIR", os.path.join(os.path.dirname(__file__), "media"))



def extract_media_filenames(html: str) -> List[str]:
    """Extract all media filenames referenced in card HTML content.
    
    Finds filenames from:
    - <img src="/api/media/{user_id}/filename.png">
    - <audio src="/api/media/{user_id}/filename.mp3">
    """
    filenames = []
    # Match img and audio src attributes pointing to /api/media/
    matches = re.findall(r'/api/media/\d+/([^"\'<>\s)]+)', html)
    filenames.extend(unquote(name) for name in matches)
    filenames.extend(re.findall(r'\[sound:([^\]]+)\]', html))
    for name in re.findall(r'(?:src|href)\s*=\s*["\']([^"\']+)["\']|url\(\s*["\']?([^"\')]+)', html, re.I):
        value = html_entities.unescape(next((v for v in name if v), '').strip())
        if value and not re.match(r'^(?:[a-z][a-z0-9+.-]*:|/|#)', value, re.I):
            filenames.append(unquote(value))
    return filenames


def get_media_dir(user_id: int) -> str:
    """Get the media directory path for a user."""
    return os.path.join(MEDIA_BASE, str(user_id))


def get_all_referenced_media(user_id: int, db) -> Set[str]:
    """Get ALL media filenames still referenced by any card of this user."""
    from models import Card, Deck, Note, NoteType
    
    all_cards = (
        db.query(Card)
        .join(Deck, Deck.id == Card.deck_id)
        .filter(Deck.user_id == user_id)
        .yield_per(500)
    )
    
    referenced = set()
    for card in all_cards:
        referenced.update(extract_media_filenames(card.front or ""))
        referenced.update(extract_media_filenames(card.back or ""))
    # Fields not displayed on a particular card and template CSS still own
    # their media. Rendered projections alone are insufficient for cleanup.
    for note in db.query(Note).filter_by(user_id=user_id):
        for value in json.loads(note.fields_json):
            referenced.update(extract_media_filenames(value))
    for model in db.query(NoteType).filter_by(user_id=user_id):
        referenced.update(extract_media_filenames(model.css or ''))
        for template in json.loads(model.templates_json):
            referenced.update(extract_media_filenames(template.get('qfmt', '')))
            referenced.update(extract_media_filenames(template.get('afmt', '')))
    
    return referenced


def cleanup_media_files(user_id: int, filenames: List[str]):
    """Delete specific media files for a user."""
    media_dir = get_media_dir(user_id)
    if not os.path.exists(media_dir):
        return 0
    
    deleted = 0
    for filename in filenames:
        file_path = os.path.realpath(os.path.join(media_dir, filename))
        if os.path.dirname(file_path) != os.path.realpath(media_dir):
            continue
        if os.path.exists(file_path):
            try:
                os.remove(file_path)
                deleted += 1
            except OSError:
                pass  # File in use or permission error
    
    # If directory is empty after cleanup, remove it
    try:
        if os.path.exists(media_dir) and not os.listdir(media_dir):
            os.rmdir(media_dir)
    except OSError:
        pass
    
    return deleted


def cleanup_orphaned_media(user_id: int, db):
    """Delete ALL media files that are not referenced by any card.
    
    This is the safest approach: scan the media directory, check each file
    against all cards in the database, and delete any file not referenced.
    Handles cases where files were copied to media/ but never linked in HTML
    (e.g., extra media in .apkg packages).
    """
    media_dir = get_media_dir(user_id)
    if not os.path.exists(media_dir):
        return 0
    
    # Get all files on disk
    files_on_disk = set()
    for f in os.listdir(media_dir):
        if f == '.gitkeep':
            continue
        if os.path.isfile(os.path.join(media_dir, f)):
            files_on_disk.add(f)
    
    if not files_on_disk:
        return 0
    
    # Get all referenced files
    referenced = get_all_referenced_media(user_id, db)
    
    # Delete orphaned files
    orphaned = files_on_disk - referenced
    deleted = 0
    for filename in orphaned:
        file_path = os.path.join(media_dir, filename)
        try:
            os.remove(file_path)
            deleted += 1
        except OSError:
            pass
    
    # Remove directory if empty
    try:
        if os.path.exists(media_dir) and not os.listdir(media_dir):
            os.rmdir(media_dir)
    except OSError:
        pass
    
    return deleted


def cleanup_user_media(user_id: int):
    """Delete ALL media files for a user (used when deleting account)."""
    media_dir = get_media_dir(user_id)
    if os.path.exists(media_dir):
        shutil.rmtree(media_dir, ignore_errors=True)


def get_card_media_filenames(front: str, back: str) -> List[str]:
    """Get all media filenames referenced by a single card."""
    filenames = set()
    filenames.update(extract_media_filenames(front or ""))
    filenames.update(extract_media_filenames(back or ""))
    return list(filenames)


def get_orphaned_media(user_id: int, deleting_filenames: List[str], 
                        still_referenced: List[str]) -> List[str]:
    """Find media files that will be orphaned after deletion.
    
    Returns filenames from deleting_filenames that are NOT in still_referenced.
    """
    referenced_set = set(still_referenced)
    return [f for f in deleting_filenames if f not in referenced_set]
