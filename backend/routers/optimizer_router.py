from datetime import datetime, timezone
import threading
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from auth import get_current_user
from database import get_db
from models import Deck, User
from fsrs_optimizer import training_items, optimize

router = APIRouter(prefix='/api/optimizer', tags=['FSRS'])
_training_slot = threading.BoundedSemaphore(1)


@router.post('/{deck_id}')
def train(deck_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    deck = db.query(Deck).filter_by(id=deck_id, user_id=user.id).first()
    if deck is None:
        raise HTTPException(404, 'Deck not found')
    decks = [d for d in db.query(Deck).filter_by(user_id=user.id) if d.id == deck.id or d.name.startswith(deck.name + '::')]
    if not _training_slot.acquire(blocking=False):
        raise HTTPException(429, 'Another optimization is running; try again shortly')
    try:
        items, logs = training_items(db, user.id, decks, datetime.now(timezone.utc))
        if len(items) < 400:
            raise HTTPException(422, f'Need 400 interday outcomes with complete learning history; found {len(items)}')
        split = max(1, int(len(items) * .8))
        params = optimize(items[:split])
        from fsrs_evaluation import evaluate
        from study_queue import config_for
        evaluation = evaluate(items[split:], params, config_for(deck).fsrs_parameters)
        return {'parameters': params, 'training_samples': split, 'total_samples': len(items), 'history_entries': logs,
                'scope': 'Selected deck and descendants; complete web and imported Anki histories',
                'evaluation': evaluation, 'training_split': split, 'holdout_samples': len(items) - split,
                'applied': False}
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    finally:
        _training_slot.release()
