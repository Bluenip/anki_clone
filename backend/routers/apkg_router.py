import logging
import os
import sqlite3
import tempfile
import zipfile

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from starlette.background import BackgroundTask

from apkg_handler import export_apkg, import_apkg
from auth import get_current_user
from database import get_db
from models import Deck, User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/apkg", tags=["APKG Import/Export"])

# 50 MB max upload limit
MAX_APKG_UPLOAD_SIZE = 50 * 1024 * 1024
CHUNK_SIZE = 64 * 1024  # 64 KB


@router.post("/import")
async def import_apkg_file(
    file: UploadFile = File(...),
    include_scheduling: bool = False,
    collection_restore: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    is_collection = bool(file.filename and file.filename.lower().endswith('.colpkg'))
    if not file.filename or not file.filename.lower().endswith((".apkg", ".colpkg")):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only .apkg and .colpkg files are supported",
        )
    if is_collection:
        # A full collection package must not silently merge into an existing
        # collection. This version supports restoring into an empty account.
        if not collection_restore:
            raise HTTPException(status_code=400, detail='COLPKG requires explicit collection_restore=true and an empty collection')
        if db.query(Deck).filter_by(user_id=user.id).first():
            raise HTTPException(status_code=409, detail='Restore requires an empty collection; existing decks were not changed')
        include_scheduling = True

    fd, temp_path = tempfile.mkstemp(suffix=".apkg")
    total_bytes = 0

    try:
        with os.fdopen(fd, "wb") as f:
            while True:
                chunk = await file.read(CHUNK_SIZE)
                if not chunk:
                    break
                total_bytes += len(chunk)
                if total_bytes > MAX_APKG_UPLOAD_SIZE:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail="File too large. Maximum allowed size is 50MB.",
                    )
                f.write(chunk)

        result = import_apkg(temp_path, user.id, db, include_scheduling=include_scheduling, whole_collection=is_collection)
        result['collection_restore'] = is_collection
        return result
    except HTTPException:
        raise
    except (ValueError, zipfile.BadZipFile, sqlite3.DatabaseError, KeyError) as e:
        logger.warning("Failed to import APKG for user %s: %s", user.id, str(e))
        err_str = str(e)
        if any(indicator in err_str for indicator in ("/home", "/tmp", "/var", "/etc", "/usr", "\\", "..")):
            detail_msg = "Invalid or corrupted APKG file"
        elif err_str:
            detail_msg = f"Invalid or corrupted APKG file: {err_str}"
        else:
            detail_msg = "Invalid or corrupted APKG file"
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=detail_msg,
        )



    except Exception:
        logger.exception("Unexpected error importing APKG for user %s", user.id)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to process APKG file",
        )
    finally:
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass


@router.get("/export/{deck_id}")
async def export_apkg_file(
    deck_id: int,
    include_scheduling: bool = False,
    modern: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileResponse:
    # Validate deck ownership
    deck = db.query(Deck).filter(Deck.id == deck_id, Deck.user_id == user.id).first()
    if not deck:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Deck not found")

    try:
        zip_path = export_apkg(deck_id, user.id, include_scheduling, db)
        if modern:
            from package_codec import modernize_package
            fd, modern_path = tempfile.mkstemp(suffix='.apkg')
            os.close(fd)
            try:
                modernize_package(zip_path, modern_path, include_scheduling)
            except BaseException:
                os.remove(modern_path)
                raise
            finally:
                os.remove(zip_path)
            zip_path = modern_path
        # Sanitize download filename for safe header
        safe_name = "".join(c for c in deck.name if c.isalnum() or c in (" ", "-", "_")).strip() or "deck"
        return FileResponse(
            zip_path,
            media_type="application/octet-stream",
            filename=f"{safe_name}.apkg",
            background=BackgroundTask(os.remove, zip_path),
        )
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except Exception:
        logger.exception("Failed to export deck %s for user %s", deck_id, user.id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to export deck",
        )


@router.get('/export-collection')
def export_collection(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    from package_export import export_package
    from package_codec import modernize_package
    legacy_path = output = None
    try:
        legacy_path = export_package(None, user.id, True, db)
        fd, output = tempfile.mkstemp(suffix='.colpkg')
        os.close(fd)
        modernize_package(legacy_path, output, True, collection_package=True)
        return FileResponse(output, media_type='application/octet-stream', filename='collection.colpkg',
                            background=BackgroundTask(os.remove, output))
    except Exception as exc:
        if output and os.path.exists(output):
            os.remove(output)
        if isinstance(exc, ValueError):
            raise HTTPException(status_code=400, detail=str(exc)) from None
        logger.exception('Failed to export collection for user %s', user.id)
        raise HTTPException(status_code=500, detail='Failed to export collection') from None
    finally:
        if legacy_path and os.path.exists(legacy_path):
            os.remove(legacy_path)

