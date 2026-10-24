"""Restore filtered membership only while its saved session is unchanged."""
from datetime import datetime
from fastapi import HTTPException
from models import FilteredSession, FilteredItem


def restore(db, user_id, card, before):
    data=before.get('filtered')
    if not data:return None
    from routers.filtered_router import claim
    session=db.query(FilteredSession).filter_by(id=data['session_id'],user_id=user_id).first()
    expected=data.get('undo_session_version',data['session_version'])
    if not session or session.version!=expected:
        raise HTTPException(409,'Custom study session changed; this review cannot safely be undone')
    item=db.get(FilteredItem,card.id)
    if item and item.session_id!=session.id:
        raise HTTPException(409,'Card moved to another custom study session')
    claim(db,session,expected)
    if item is None:
        item=FilteredItem(card_id=card.id,session_id=session.id,position=data['position']);db.add(item)
    item.position=data['position']
    item.available_at=datetime.fromisoformat(data['available_at']) if data['available_at'] else None
    return session.id,data['session_version']-1,session.version
