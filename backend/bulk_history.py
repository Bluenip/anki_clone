import json
import uuid
from sqlalchemy import update
from fastapi import HTTPException
from models import User, CollectionOperation
from collection_snapshot import capture, fingerprint, restore


def begin(db, uid):
    # Acquire the SQLite writer lock before reading state and selected versions.
    db.execute(update(User).where(User.id == uid).values(id=User.id))
    db.expire_all()
    return capture(db, uid)


def record(db, uid, action, before):
    after = fingerprint(capture(db, uid))
    operation = CollectionOperation(id=str(uuid.uuid4()), user_id=uid, action=action, before_json=json.dumps(before), after_hash=after)
    db.add(operation)
    # Keep ten bounded collection snapshots; review undo uses its own log.
    older = db.query(CollectionOperation).filter_by(user_id=uid).order_by(CollectionOperation.created_at.desc(), CollectionOperation.id.desc()).all()
    for row in older[9:]: db.delete(row)
    return operation.id


def undo(db, uid):
    current = begin(db, uid)
    operation = db.query(CollectionOperation).filter_by(user_id=uid, undone=False).order_by(CollectionOperation.created_at.desc(), CollectionOperation.id.desc()).first()
    if operation is None: raise HTTPException(409, 'No bulk operation to undo')
    if fingerprint(current) != operation.after_hash:
        raise HTTPException(409, 'Collection changed after this operation; undo would overwrite newer work')
    restore(db, uid, json.loads(operation.before_json))
    operation.undone = True
    db.flush()
    # Restoring increments versions. Update the previous boundary so chained
    # undo works, while any subsequent mutation still invalidates the boundary.
    prior = db.query(CollectionOperation).filter_by(user_id=uid, undone=False).filter(CollectionOperation.id != operation.id).order_by(CollectionOperation.created_at.desc(), CollectionOperation.id.desc()).first()
    if prior: prior.after_hash = fingerprint(capture(db, uid))
    db.commit()
    return {'undone': operation.action}
