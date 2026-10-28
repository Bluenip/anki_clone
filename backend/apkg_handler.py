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
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from sqlalchemy.orm import Session
from models import Deck, Card, StudyProgress, ReviewLog
from media_utils import get_media_dir, MEDIA_BASE



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
        return datetime.fromtimestamp(col_crt, timezone.utc) + timedelta(days=due)
    else:  # new or learning (learning due is epoch seconds)
        if due < 4000000000:  # heuristic for timestamp vs note id
            return datetime.fromtimestamp(max(due, 0), timezone.utc)
        return datetime.now(timezone.utc)

def convert_ease_factor(factor_permille: int) -> float:
    """2500 -> 2.50"""
    return factor_permille / 1000.0

from import_config import (
    MAX_UNCOMPRESSED_BYTES as MAX_UNCOMPRESSED_SIZE, MAX_ZIP_ENTRIES,
    MAX_CARDS as MAX_CARDS_IMPORT, MAX_MEDIA_FILES,
    MAX_SINGLE_MEDIA_BYTES as MAX_SINGLE_MEDIA_SIZE, MAX_MEDIA_BYTES as MAX_TOTAL_MEDIA_SIZE,
    MAX_NOTES, check_space,
)

# SVG requires explicit static sanitization; never accept raw active SVG.
ALLOWED_MEDIA_EXTENSIONS = {
    '.png', '.jpg', '.jpeg', '.gif', '.webp',
    '.mp3', '.ogg', '.wav', '.m4a', '.aac', '.flac', '.mp4', '.webm', '.woff', '.woff2', '.ttf', '.otf'
}


def import_apkg(
    file_path: str,
    user_id: int,
    db: Session,
    max_uncompressed_size: int = MAX_UNCOMPRESSED_SIZE,
    max_zip_entries: int = MAX_ZIP_ENTRIES,
    max_cards: int = MAX_CARDS_IMPORT,
    max_media_files: int = MAX_MEDIA_FILES,
    max_single_media_size: int = MAX_SINGLE_MEDIA_SIZE,
    max_total_media_size: int = MAX_TOTAL_MEDIA_SIZE,
    include_scheduling: bool = False,
    whole_collection: bool = False,
    media_directory: str | None = None,
    media_conflicts: str = 'error',
    duplicate_policy: str = 'newer',
    preview: bool = False,
    progress=None,
    sanitize_svg: bool = False,
) -> dict:
    if media_conflicts not in ('error', 'rename') or duplicate_policy not in ('newer', 'skip', 'update', 'add'):
        raise ValueError('Invalid import conflict policy')
    def report(stage, completed=0, total=0):
        if progress:
            progress(stage, completed, total)
    warnings = []
    report('validating')
    media_dir = media_directory or get_media_dir(user_id)
    os.makedirs(media_dir, exist_ok=True)
    real_media_dir = os.path.realpath(media_dir)
    
    with tempfile.TemporaryDirectory() as temp_dir, ExitStack() as resources:
        real_temp_dir = os.path.realpath(temp_dir)
        archive_members = set()

        with zipfile.ZipFile(file_path, 'r') as zip_ref:
            entries = zip_ref.infolist()
            if len(entries) > max_zip_entries:
                raise ValueError(f"Too many files in archive (max {max_zip_entries})")

            total_uncompressed = sum(entry.file_size for entry in entries)
            if total_uncompressed > max_uncompressed_size:
                raise ValueError(f'Uncompressed archive size exceeds limit of {max_uncompressed_size} bytes')
            check_space(temp_dir, total_uncompressed)
            total_uncompressed = 0
            for entry_index, entry in enumerate(entries):
                report('extracting', entry_index, len(entries))
                if entry.filename in archive_members:
                    raise ValueError('Duplicate archive member')
                total_uncompressed += entry.file_size
                if total_uncompressed > max_uncompressed_size:
                    raise ValueError(f"Uncompressed archive size exceeds limit of {max_uncompressed_size} bytes")

                # Check path traversal / zip slip
                norm_fn = os.path.normpath(entry.filename)
                if norm_fn.startswith("..") or os.path.isabs(norm_fn):
                    raise ValueError(f"Path traversal detected in archive: {entry.filename}")

                target_path = os.path.realpath(os.path.join(real_temp_dir, entry.filename))
                if not (target_path == real_temp_dir or target_path.startswith(real_temp_dir + os.sep)):
                    raise ValueError(f"Path traversal detected in archive: {entry.filename}")

                # Check for symlink entries in zip metadata
                if (entry.external_attr >> 16) & 0o120000 == 0o120000:
                    raise ValueError(f"Symlinks not allowed in archive: {entry.filename}")

                archive_members.add(entry.filename)
                zip_ref.extract(entry, temp_dir)
            
        # Verify no extracted item is a symlink on the filesystem
        for root, dirs, files in os.walk(temp_dir):
            for name in files + dirs:
                full_p = os.path.join(root, name)
                if os.path.islink(full_p):
                    raise ValueError(f"Symlink detected in extracted archive: {name}")

        from package_codec import prepare_collection
        col_file, normalized_metadata = prepare_collection(temp_dir, max_uncompressed_size, max_media_files, progress=report)
        try:
            conn = sqlite3.connect(col_file)
            resources.callback(conn.close)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM col LIMIT 1")
            col = normalized_metadata or cursor.fetchone()
        except sqlite3.DatabaseError:
            raise ValueError("Corrupted APKG database: invalid SQLite file")

        if not col:
            conn.close()
            raise ValueError("Corrupted APKG database: col record missing")
        col_crt = col['crt']
        note_count = cursor.execute('SELECT COUNT(*) FROM notes').fetchone()[0]
        if note_count > MAX_NOTES:
            conn.close()
            raise ValueError(f'Note count exceeds maximum limit ({note_count} > {MAX_NOTES})')


        # Prevalidate card count before any DB or media writes
        cursor.execute("SELECT COUNT(*) as cnt FROM cards")
        total_card_count = cursor.fetchone()['cnt']
        if total_card_count > max_cards:
            conn.close()
            raise ValueError(f"Card count exceeds maximum limit ({total_card_count} > {max_cards})")
        
        # Read and prevalidate media safely
        media_file = os.path.join(temp_dir, "media")
        media_mapping = {}
        if os.path.exists(media_file):
            try:
                with open(media_file, "r", encoding="utf-8") as f:
                    media_mapping = json.load(f)
            except Exception:
                conn.close()
                raise ValueError("Corrupted media manifest in APKG archive")

        if not isinstance(media_mapping, dict):
            conn.close()
            raise ValueError("Invalid media manifest format")

        if len(media_mapping) > max_media_files:
            conn.close()
            raise ValueError(f"Media count exceeds limit ({len(media_mapping)} > {max_media_files})")

        valid_media_to_copy = []
        total_media_bytes = 0
        from media_utils import get_all_referenced_media
        owned_media = get_all_referenced_media(user_id, db)
        seen_dest_paths = set()
        media_remaps = {}
        for media_index, (num_key, filename) in enumerate(media_mapping.items()):
            report('checking_media', media_index, len(media_mapping))
            num_key_str = str(num_key).strip()
            # 1. Require strictly numeric archive-member keys (e.g. "0", "1", "2")
            if not num_key_str.isdigit() or "/" in num_key_str or "\\" in num_key_str or ".." in num_key_str:
                conn.close()
                raise ValueError(f"Invalid media manifest key '{num_key}': keys must be numeric archive members")

            # 2. Archive-member check
            if num_key_str not in archive_members:
                conn.close()
                raise ValueError(f"Media manifest key '{num_key}' not found in archive")

            # 3. Resolved containment and no symlinks
            raw_src = os.path.join(temp_dir, num_key_str)
            real_src = os.path.realpath(raw_src)
            if not (real_src == real_temp_dir or real_src.startswith(real_temp_dir + os.sep)):
                conn.close()
                raise ValueError(f"Path traversal detected in media key '{num_key}'")

            if os.path.islink(raw_src) or os.path.islink(real_src):
                conn.close()
                raise ValueError(f"Symlinks not allowed in media files: '{num_key}'")

            if not (os.path.exists(real_src) and os.path.isfile(real_src)):
                conn.close()
                raise ValueError(f"Media file '{num_key}' is missing or not a regular file")

            if not isinstance(filename, str):
                conn.close()
                raise ValueError("Invalid filename in media manifest")

            safe_filename = os.path.basename(filename).strip()
            if not safe_filename or safe_filename.startswith("."):
                conn.close()
                raise ValueError(f"Invalid or hidden media filename: '{filename}'")

            ext = os.path.splitext(safe_filename)[1].lower()
            if ext == ".svg" and not sanitize_svg:
                conn.close()
                raise ValueError("SVG media imports are rejected due to active content / script injection risks")
            if ext not in ALLOWED_MEDIA_EXTENSIONS and not (ext == ".svg" and sanitize_svg):
                conn.close()
                raise ValueError(f"Unsupported media format '{ext}' for '{safe_filename}'")

            if ext == '.svg':
                from static_svg import sanitize_svg as clean_svg
                if os.path.getsize(real_src) > min(max_single_media_size, 10 * 1024**2):
                    raise ValueError('SVG exceeds 10 MiB processing limit')
                with open(real_src, 'rb') as svg_file:
                    cleaned = clean_svg(svg_file.read())
                with open(real_src, 'wb') as svg_file:
                    svg_file.write(cleaned)
                warnings.append(f'SVG sanitized to static graphics: {safe_filename}')

            # Content verification: detect smuggled SVG active content
            with open(real_src, "rb") as mf:
                content_prefix = mf.read(1024)
                if ext != ".svg" and (b"<svg" in content_prefix.lower() or (b"<?xml" in content_prefix.lower() and b"<svg" in (content_prefix + mf.read(2048)).lower())):
                    conn.close()
                    raise ValueError("SVG content detected and rejected due to active content / script injection risks")

            file_size = os.path.getsize(real_src)
            if file_size > max_single_media_size:
                conn.close()
                raise ValueError(f"Media file '{safe_filename}' exceeds single file limit ({file_size} > {max_single_media_size} bytes)")

            if total_media_bytes + file_size > max_total_media_size:
                conn.close()
                raise ValueError(f"Total media size exceeds limit ({total_media_bytes + file_size} > {max_total_media_size} bytes)")
            total_media_bytes += file_size

            dst_path = os.path.realpath(os.path.join(real_media_dir, safe_filename))
            if not (dst_path == real_media_dir or dst_path.startswith(real_media_dir + os.sep)):
                conn.close()
                raise ValueError(f"Path traversal detected in media filename: '{safe_filename}'")

            if dst_path in seen_dest_paths:
                conn.close()
                raise ValueError(f"Duplicate destination media file in manifest: '{safe_filename}'")
            seen_dest_paths.add(dst_path)

            # A filename shared by an existing note must never silently change
            # its content when an unrelated package is imported.
            if os.path.isfile(dst_path) and (safe_filename in owned_media or media_conflicts == 'rename'):
                import filecmp
                if not filecmp.cmp(real_src, dst_path, shallow=False):
                    if media_conflicts == 'error':
                        conn.close()
                        raise ValueError('Media filename conflicts with existing note content; choose rename conflicts to preserve both files')
                    with open(real_src, 'rb') as incoming: digest = hashlib.file_digest(incoming, 'sha256').hexdigest()
                    replacement = 'import-' + digest + ext
                    destination = os.path.join(real_media_dir, replacement)
                    if os.path.exists(destination) and (os.path.islink(destination) or not filecmp.cmp(real_src, destination, shallow=False)):
                        raise ValueError('Renamed media destination is occupied by different content')
                    media_remaps[filename] = replacement
                    safe_filename, dst_path = replacement, destination

            valid_media_to_copy.append((real_src, dst_path, safe_filename))

        check_space(real_media_dir, total_media_bytes * 2)
        if media_remaps:
            from media_remap import package
            col = package(cursor, col, media_remaps)
        decks_json = json.loads(col['decks'])
        models_json = json.loads(col['models'])
        
        deck_name = "Imported Deck"
        for d in decks_json.values():
            if d.get("name") and d.get("name") != "Default":
                deck_name = d["name"]
                break

        if any('<script' in json.dumps(m).lower() for m in models_json.values()):
            warnings.append('Template scripts are preserved for export but disabled in web rendering')
        from media_utils import extract_media_filenames
        referenced = set()
        for row in cursor.execute('SELECT flds FROM notes'):
            referenced.update(extract_media_filenames(row[0]))
        for model in models_json.values():
            referenced.update(extract_media_filenames(model.get('css', '')))
            for template in model.get('tmpls', []):
                referenced.update(extract_media_filenames(template.get('qfmt', '') + template.get('afmt', '')))
        available = set(media_mapping.values()) | set(media_remaps.values())
        missing = sorted(name for name in referenced if name not in available and not os.path.isfile(os.path.join(real_media_dir, os.path.basename(name))))
        if missing:
            warnings.append(f'{len(missing)} referenced media files missing; first 20: ' + ', '.join(missing[:20]))

        # Transactional DB records & atomic media staging with rollback
        backup_dir = tempfile.mkdtemp(prefix="anki_media_backup_")
        resources.callback(shutil.rmtree, backup_dir, ignore_errors=True)
        check_space(backup_dir, total_media_bytes)
        backed_up_files = {}         # dst_p -> backup_p
        newly_created_files = set()  # dst_p
        in_flight_temp_files = set()  # temp_dst paths

        try:
            from package_notes import import_rows
            if whole_collection and db.query(Deck).filter_by(user_id=user_id).first():
                raise ValueError('Collection restore requires an empty collection')
            deck, cards_imported, cards_updated, cards_skipped = import_rows(cursor, col, user_id, db, include_scheduling, whole_collection, duplicate_policy, progress=report)

            result = {
                'deck_id': None if preview else deck.id, 'deck_name': deck.name,
                'cards_imported': cards_imported, 'cards_updated': cards_updated,
                'cards_skipped': cards_skipped, 'notes_in_package': note_count,
                'cards_in_package': total_card_count, 'media_imported': len(valid_media_to_copy),
                'media_bytes': total_media_bytes, 'warnings': warnings, 'preview': preview,
            }
            if preview:
                db.rollback()
                conn.close()
                return result
            report('copying_media', 0, len(valid_media_to_copy))
            # Now that all DB records are verified and staged, copy validated media
            os.makedirs(real_media_dir, exist_ok=True)

            # Step 1: Backup any pre-existing destination media files before modifying them
            for media_index, (_, dst_p, _) in enumerate(valid_media_to_copy):
                report('backing_up_media', media_index, len(valid_media_to_copy))
                if os.path.exists(dst_p) and dst_p not in backed_up_files:
                    backup_p = os.path.join(backup_dir, f"backup_{len(backed_up_files)}")
                    shutil.copy2(dst_p, backup_p)
                    backed_up_files[dst_p] = backup_p

            # Step 2: Copy media files safely with temporary file staging
            for media_index, (src_p, dst_p, _) in enumerate(valid_media_to_copy):
                report('copying_media', media_index, len(valid_media_to_copy))
                if dst_p not in backed_up_files:
                    newly_created_files.add(dst_p)
                temp_dst = dst_p + f".tmp_import_{os.getpid()}_{random.randint(100000, 999999)}"
                in_flight_temp_files.add(temp_dst)
                try:
                    shutil.copy2(src_p, temp_dst)
                    os.replace(temp_dst, dst_p)
                finally:
                    in_flight_temp_files.discard(temp_dst)
                    if os.path.exists(temp_dst):
                        try:
                            os.remove(temp_dst)
                        except OSError:
                            pass

            report("committing", 0, 1)
            db.commit()
            conn.close()
        except Exception:
            db.rollback()
            conn.close()

            # 1. Clean up in-flight temporary copy files from partial copy failures
            for tmp_p in list(in_flight_temp_files):
                if os.path.exists(tmp_p):
                    try:
                        os.remove(tmp_p)
                    except OSError:
                        pass

            # 2. Restore pre-existing media from backup copies
            for dst_p, backup_p in backed_up_files.items():
                if os.path.exists(backup_p):
                    try:
                        with open(backup_p, "rb") as sf, open(dst_p, "wb") as df:
                            shutil.copyfileobj(sf, df)
                    except Exception:
                        try:
                            shutil.copy2(backup_p, dst_p)
                        except OSError:
                            pass

            # 3. Clean up any newly created media files (not pre-existing)
            for dst_p in newly_created_files:
                if dst_p not in backed_up_files and os.path.exists(dst_p):
                    try:
                        os.remove(dst_p)
                    except OSError:
                        pass
            raise
        finally:
            if os.path.exists(backup_dir):
                shutil.rmtree(backup_dir, ignore_errors=True)

    return result


def export_apkg(deck_id: int, user_id: int, include_scheduling: bool, db: Session) -> str:
    from package_export import export_package
    return export_package(deck_id, user_id, include_scheduling, db)
