import zipfile
import sqlite3
import json
import hashlib
import tempfile
import os
import re
import time
import random
import string
import shutil
from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from models import Deck, Card, StudyProgress, ReviewLog

def generate_guid() -> str:
    """Generate 10-char base91 GUID for Anki notes."""
    base91 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~"
    return ''.join(random.choice(base91) for _ in range(10))

def compute_csum(field_text: str) -> int:
    """SHA1 checksum, first 8 hex chars -> int."""
    s = hashlib.sha1(field_text.encode("utf-8")).hexdigest()
    return int(s[:8], 16)

def strip_html(html_str: str) -> str:
    """Strip HTML tags using regex."""
    return re.sub(r'<[^>]+>', '', html_str)

def map_card_state_to_anki(card_state: str, is_suspended: bool) -> tuple:
    """Convert app state -> Anki type/queue."""
    if is_suspended:
        queue = -1
    else:
        if card_state == "new":
            queue = 0
        elif card_state == "learning":
            queue = 1
        elif card_state == "review":
            queue = 2
        elif card_state == "relearning":
            queue = 1
        else:
            queue = 0
            
    if card_state == "new":
        atype = 0
    elif card_state == "learning":
        atype = 1
    elif card_state == "review":
        atype = 2
    elif card_state == "relearning":
        atype = 3
    else:
        atype = 0
        
    return atype, queue

def map_anki_state_to_app(atype: int, queue: int) -> tuple:
    """Convert Anki type/queue -> app state."""
    is_suspended = queue == -1
    
    if queue == -1: # if suspended, look at type
        pass
        
    if atype == 0:
        card_state = "new"
    elif atype == 1:
        card_state = "learning"
    elif atype == 2:
        card_state = "review"
    elif atype == 3:
        card_state = "relearning"
    else:
        card_state = "new"
        
    return card_state, is_suspended

def parse_anki_due(due: int, queue: int, col_crt: int, atype: int = -1) -> datetime:
    """Convert Anki due -> datetime.
    
    For review cards (atype=2), due is always a day offset from col_crt,
    regardless of queue (even if suspended with queue=-1).
    """
    if queue in (2, 3) or atype == 2:  # review or day-learn (or suspended review)
        # due is day offset from col_crt
        return datetime.fromtimestamp(col_crt) + timedelta(days=due)
    else:  # new or learning (learning due is epoch seconds)
        if due < 4000000000:  # heuristic for timestamp vs note id
            return datetime.fromtimestamp(max(due, 0))
        return datetime.now()

def convert_ease_factor(factor_permille: int) -> float:
    """2500 -> 2.50"""
    return factor_permille / 1000.0

def import_apkg(file_path: str, user_id: int, db: Session) -> dict:
    media_dir = os.path.join(os.path.dirname(__file__), "media", str(user_id))
    os.makedirs(media_dir, exist_ok=True)
    
    with tempfile.TemporaryDirectory() as temp_dir:
        with zipfile.ZipFile(file_path, 'r') as zip_ref:
            zip_ref.extractall(temp_dir)
            
        # Determine sqlite file name
        col_file = os.path.join(temp_dir, "collection.anki2")
        if not os.path.exists(col_file):
            col_file = os.path.join(temp_dir, "collection.anki21")
            
        conn = sqlite3.connect(col_file)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        cursor.execute("SELECT * FROM col LIMIT 1")
        col = cursor.fetchone()
        col_crt = col['crt']
        
        decks_json = json.loads(col['decks'])
        models_json = json.loads(col['models'])
        
        # We will create one big deck for simplicity, or find the main deck
        deck_name = "Imported Deck"
        for d in decks_json.values():
            if d.get("name") and d.get("name") != "Default":
                deck_name = d["name"]
                break
                
        deck = Deck(user_id=user_id, name=deck_name, description="Imported from Anki")
        db.add(deck)
        db.flush()
        
        # Read media
        media_file = os.path.join(temp_dir, "media")
        media_mapping = {}
        if os.path.exists(media_file):
            with open(media_file, "r") as f:
                media_mapping = json.load(f)
                
        media_imported = 0
        for num_key, filename in media_mapping.items():
            src_path = os.path.join(temp_dir, num_key)
            if os.path.exists(src_path):
                dst_path = os.path.join(media_dir, filename)
                shutil.copy2(src_path, dst_path)
                media_imported += 1
                
        # Read notes to get fields
        cursor.execute("SELECT id, flds FROM notes")
        notes = {}
        for r in cursor.fetchall():
            flds = r['flds'].split('\x1f')
            notes[r['id']] = flds
            
        # Read cards
        cursor.execute("SELECT * FROM cards")
        cards_imported = 0
        for r in cursor.fetchall():
            nid = r['nid']
            flds = notes.get(nid)
            if not flds: continue
            
            front = flds[0] if len(flds) > 0 else ""
            back = flds[1] if len(flds) > 1 else ""
            
            # Collect [sound:] and <img> tags from ALL extra fields
            # (Anki often puts audio/images in separate fields, e.g. Field 3 = Audio, Field 4 = Image)
            extra_sounds = []
            extra_images = []
            for field in flds[2:]:  # Check all fields beyond front/back
                sounds = re.findall(r'\[sound:([^\]]+)\]', field)
                extra_sounds.extend(sounds)
                images = re.findall(r'<img[^>]+src=["\']([^"\']+)["\'][^>]*>', field)
                extra_images.extend(images)
            
            # Update HTML references — only rewrite local media refs, not external URLs
            def replace_media(match):
                src = match.group(1)
                if src.startswith('http://') or src.startswith('https://'):
                    return match.group(0)  # Keep external URLs unchanged
                return f'<img src="/api/media/{user_id}/{src}">'
            front = re.sub(r'<img[^>]+src=["\']([^"\']+)["\'][^>]*>', replace_media, front)
            back = re.sub(r'<img[^>]+src=["\']([^"\']+)["\'][^>]*>', replace_media, back)
            
            # Convert Anki [sound:filename.mp3] tags to HTML audio elements
            def replace_sound(match):
                filename = match.group(1)
                return f'<audio src="/api/media/{user_id}/{filename}" controls autoplay class="anki-audio"></audio>'
            front = re.sub(r'\[sound:([^\]]+)\]', replace_sound, front)
            back = re.sub(r'\[sound:([^\]]+)\]', replace_sound, back)
            
            # Append extra images (from other fields) to back of card
            for img_file in extra_images:
                if not img_file.startswith('http://') and not img_file.startswith('https://'):
                    back += f'\n<img src="/api/media/{user_id}/{img_file}">'
                else:
                    back += f'\n<img src="{img_file}">'
            
            # Append extra sound tags (from other fields) to back of card
            for sound_file in extra_sounds:
                back += f'\n<audio src="/api/media/{user_id}/{sound_file}" controls autoplay class="anki-audio"></audio>'
            
            card = Card(deck_id=deck.id, front=front, back=back)
            db.add(card)
            db.flush()
            
            # Map study progress
            atype, queue = r['type'], r['queue']
            card_state, is_suspended = map_anki_state_to_app(atype, queue)
            
            # Only create StudyProgress for cards that have actually been studied.
            # New cards (never reviewed) should NOT have a StudyProgress record,
            # because study_router identifies new cards as those WITHOUT StudyProgress.
            if card_state != "new" or r['reps'] > 0 or is_suspended:
                due_dt = parse_anki_due(r['due'], queue, col_crt, atype=atype)
                ease_factor = convert_ease_factor(r['factor'])
                interval = r['ivl'] if r['ivl'] > 0 else 0
                
                sp = StudyProgress(
                    user_id=user_id,
                    card_id=card.id,
                    ease_factor=ease_factor,
                    interval_days=interval,
                    repetitions=r['reps'],
                    lapse_count=r['lapses'],
                    card_state=card_state,
                    is_suspended=is_suspended,
                    next_review=due_dt,
                    last_reviewed=datetime.now()  # Approximate
                )
                db.add(sp)
            cards_imported += 1
            
        db.commit()
        conn.close()
        
    return {
        "deck_id": deck.id,
        "deck_name": deck.name,
        "cards_imported": cards_imported,
        "media_imported": media_imported
    }

def export_apkg(deck_id: int, user_id: int, include_scheduling: bool, db: Session) -> str:
    deck = db.query(Deck).filter(Deck.id == deck_id, Deck.user_id == user_id).first()
    if not deck:
        raise ValueError("Deck not found")
        
    cards = db.query(Card).filter(Card.deck_id == deck_id).all()
    
    # Create temp directory and SQLite file
    temp_dir = tempfile.mkdtemp()
    col_path = os.path.join(temp_dir, "collection.anki2")
    conn = sqlite3.connect(col_path)
    cursor = conn.cursor()
    
    # Create schemas
    cursor.executescript('''
        CREATE TABLE col (
            id integer primary key, crt integer not null, mod integer not null,
            scm integer not null, ver integer not null, dty integer not null,
            usn integer not null, ls integer not null, conf text not null,
            models text not null, decks text not null, dconf text not null, tags text not null
        );
        CREATE TABLE notes (
            id integer primary key, guid text not null, mid integer not null,
            mod integer not null, usn integer not null, tags text not null,
            flds text not null, sfld text not null, csum integer not null,
            flags integer not null, data text not null
        );
        CREATE TABLE cards (
            id integer primary key, nid integer not null, did integer not null,
            ord integer not null, mod integer not null, usn integer not null,
            type integer not null, queue integer not null, due integer not null,
            ivl integer not null, factor integer not null, reps integer not null,
            lapses integer not null, left integer not null, odue integer not null,
            odid integer not null, flags integer not null, data text not null
        );
        CREATE TABLE revlog (
            id integer primary key, cid integer not null, usn integer not null,
            ease integer not null, ivl integer not null, lastIvl integer not null,
            factor integer not null, time integer not null, type integer not null
        );
        CREATE TABLE graves (
            usn integer not null, oid integer not null, type integer not null
        );
    ''')
    
    now_ts = int(time.time())
    now_ms = int(time.time() * 1000)
    
    # Create Basic model
    model_id = int(time.time() * 1000)
    models = {
        str(model_id): {
            "id": model_id, "name": "Basic", "type": 0, "mod": now_ts, "usn": -1,
            "sortf": 0, "did": None, "tmpls": [
                {
                    "name": "Card 1", "ord": 0, "qfmt": "{{Front}}",
                    "afmt": "{{FrontSide}}\\n\\n<hr id=answer>\\n\\n{{Back}}",
                    "bqfmt": "", "bafmt": "", "did": None, "bfont": "", "bsize": 0
                }
            ],
            "flds": [
                {"name": "Front", "ord": 0, "sticky": False, "rtl": False, "font": "Arial", "size": 20, "media": []},
                {"name": "Back", "ord": 1, "sticky": False, "rtl": False, "font": "Arial", "size": 20, "media": []}
            ],
            "css": ".card { font-family: arial; font-size: 20px; text-align: center; color: black; background-color: white; }",
            "req": [[0, "any", [0]]], "tags": [], "vers": []
        }
    }
    
    deck_id_anki = int(time.time() * 1000) + 1
    decks = {
        "1": {"id": 1, "mod": now_ts, "name": "Default", "usn": -1, "lrnToday": [0, 0], "revToday": [0, 0], "newToday": [0, 0], "timeToday": [0, 0], "collapsed": False, "browserCollapsed": False, "desc": "", "dyn": 0, "conf": 1, "extendNew": 0, "extendRev": 0},
        str(deck_id_anki): {"id": deck_id_anki, "mod": now_ts, "name": deck.name, "usn": -1, "lrnToday": [0, 0], "revToday": [0, 0], "newToday": [0, 0], "timeToday": [0, 0], "collapsed": False, "browserCollapsed": False, "desc": deck.description or "", "dyn": 0, "conf": 1, "extendNew": 0, "extendRev": 0}
    }
    
    cursor.execute("""
        INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (1, now_ts, now_ts, now_ms, 11, 0, -1, 0, "{}", json.dumps(models), json.dumps(decks), "{}", "{}"))
    
    media_mapping = {}
    media_counter = 0
    
    # Process cards
    base_id = int(time.time() * 1000)
    for idx, card in enumerate(cards):
        nid = base_id + idx * 2
        cid = base_id + idx * 2 + 1
        
        # Restore media paths (images)
        def replace_media_export(match):
            nonlocal media_counter
            filename = match.group(1)
            src_path = os.path.join(os.path.dirname(__file__), "media", str(user_id), filename)
            if os.path.exists(src_path):
                dst_path = os.path.join(temp_dir, str(media_counter))
                shutil.copy2(src_path, dst_path)
                media_mapping[str(media_counter)] = filename
                media_counter += 1
            return f'<img src="{filename}">'
            
        front = re.sub(r'<img[^>]+src=["\']\/api\/media\/\d+\/([^"\']+)["\'][^>]*>', replace_media_export, card.front)
        back = re.sub(r'<img[^>]+src=["\']\/api\/media\/\d+\/([^"\']+)["\'][^>]*>', replace_media_export, card.back)
        
        # Restore audio tags back to Anki [sound:filename] syntax
        def replace_audio_export(match):
            nonlocal media_counter
            filename = match.group(1)
            src_path = os.path.join(os.path.dirname(__file__), "media", str(user_id), filename)
            if os.path.exists(src_path):
                dst_path = os.path.join(temp_dir, str(media_counter))
                shutil.copy2(src_path, dst_path)
                media_mapping[str(media_counter)] = filename
                media_counter += 1
            return f'[sound:{filename}]'
            
        front = re.sub(r'<audio[^>]+src=["\']\/api\/media\/\d+\/([^"\']+)["\'][^>]*>(?:</audio>)?', replace_audio_export, front)
        back = re.sub(r'<audio[^>]+src=["\']\/api\/media\/\d+\/([^"\']+)["\'][^>]*>(?:</audio>)?', replace_audio_export, back)
        
        flds = f"{front}\x1f{back}"
        sfld = strip_html(front)
        csum = compute_csum(front)
        
        cursor.execute("""
            INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (nid, generate_guid(), model_id, now_ts, -1, "", flds, sfld, csum, 0, ""))
        
        atype, queue, due, ivl, factor, reps, lapses = 0, 0, nid, 0, 2500, 0, 0
        
        if include_scheduling:
            sp = db.query(StudyProgress).filter(StudyProgress.card_id == card.id, StudyProgress.user_id == user_id).first()
            if sp:
                atype, queue = map_card_state_to_anki(sp.card_state, sp.is_suspended)
                factor = int(sp.ease_factor * 1000)
                ivl = sp.interval_days
                reps = sp.repetitions
                lapses = sp.lapse_count
                
                if queue in (2, 3) and sp.next_review:
                    due = (sp.next_review.date() - datetime.fromtimestamp(now_ts).date()).days
                elif sp.next_review:
                    due = int(sp.next_review.timestamp())
                    
                # Export revlogs
                logs = db.query(ReviewLog).filter(ReviewLog.card_id == card.id).all()
                for log in logs:
                    revlog_id = int(log.review_date.timestamp() * 1000) + random.randint(0, 100)
                    log_type = 1 if not log.was_new else 0
                    cursor.execute("""
                        INSERT INTO revlog (id, cid, usn, ease, ivl, lastIvl, factor, time, type)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (revlog_id, cid, -1, log.rating, ivl, 0, factor, 60000, log_type))
                    
        cursor.execute("""
            INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (cid, nid, deck_id_anki, 0, now_ts, -1, atype, queue, due, ivl, factor, reps, lapses, 0, 0, 0, 0, ""))
        
    conn.commit()
    conn.close()
    
    with open(os.path.join(temp_dir, "media"), "w") as f:
        json.dump(media_mapping, f)
        
    zip_path = os.path.join(tempfile.gettempdir(), f"export_{int(time.time())}.apkg")
    with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        zf.write(col_path, "collection.anki2")
        zf.write(os.path.join(temp_dir, "media"), "media")
        for num_key in media_mapping.keys():
            zf.write(os.path.join(temp_dir, num_key), num_key)
            
    shutil.rmtree(temp_dir)
    return zip_path
