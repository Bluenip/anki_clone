from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from sqlalchemy.orm import Session
import tempfile
import os

from database import get_db
from models import User, Deck
from auth import get_current_user
from apkg_handler import import_apkg, export_apkg

router = APIRouter(prefix="/api/apkg", tags=["APKG Import/Export"])

@router.post("/import")
async def import_apkg_file(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    if not file.filename.endswith(".apkg"):
        raise HTTPException(status_code=400, detail="Only .apkg files are supported")
        
    fd, temp_path = tempfile.mkstemp(suffix=".apkg")
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(await file.read())
            
        result = import_apkg(temp_path, user.id, db)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)

@router.get("/export/{deck_id}")
async def export_apkg_file(
    deck_id: int,
    include_scheduling: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileResponse:
    # Validate deck ownership
    deck = db.query(Deck).filter(Deck.id == deck_id, Deck.user_id == user.id).first()
    if not deck:
        raise HTTPException(status_code=404, detail="Deck not found")
        
    try:
        zip_path = export_apkg(deck_id, user.id, include_scheduling, db)
        return FileResponse(
            zip_path,
            media_type="application/octet-stream",
            filename=f"{deck.name}.apkg",
            background=BackgroundTask(os.remove, zip_path),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

