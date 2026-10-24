"""Saved filtered sessions with atomic membership and home-deck scheduling."""
import json
import uuid
from datetime import datetime, timedelta, timezone
from functools import cache
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, ConfigDict
from sqlalchemy import func, update
from sqlalchemy.orm import Session
from database import get_db
from auth import get_current_user
from models import User, Deck, Card, StudyProgress, SchedulerState, FilteredSession, FilteredItem, StudyOperation
from scheduling import utc

router = APIRouter(prefix='/api/filtered', tags=['Custom Study'])


class Build(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=255)
    search: str = Field(default='is:due', max_length=2048)
    limit: int = Field(default=100, ge=1, le=1000, strict=True)
    order: Literal['oldest','newest','random','due','lapses'] = 'oldest'
    reschedule: bool = False
    preview_again_seconds: int = Field(default=60, ge=0, le=86400, strict=True)
    preview_hard_seconds: int = Field(default=600, ge=0, le=86400, strict=True)
    preview_good_seconds: int = Field(default=0, ge=0, le=86400, strict=True)


class Guard(BaseModel):
    expected_version: int = Field(ge=0, strict=True)


class Answer(BaseModel):
    model_config = ConfigDict(extra='forbid')
    expected_session_version: int = Field(ge=0, strict=True)
    card_id: int = Field(gt=0, strict=True)
    expected_version: int = Field(ge=0, strict=True)
    rating: int = Field(ge=1, le=4, strict=True)
    duration_ms: int = Field(default=0, ge=0, le=3600000)


def owned(db, sid, uid):
    session = db.query(FilteredSession).filter_by(id=sid,user_id=uid).first()
    if not session: raise HTTPException(404,'Custom study session not found')
    return session


def claim(db, session, expected):
    result=db.execute(update(FilteredSession).where(FilteredSession.id==session.id,FilteredSession.version==expected)
                      .values(version=expected+1).execution_options(synchronize_session=False))
    if result.rowcount != 1: raise HTTPException(409,'This session changed; reload before continuing')
    db.refresh(session)


def response(db, session):
    return {key:getattr(session,key) for key in ('id','name','search','limit','order','reschedule','version','preview_again_seconds','preview_hard_seconds','preview_good_seconds')} | {
        'remaining':db.query(FilteredItem).filter_by(session_id=session.id).count()}


def clear(db, session):
    from review_service import state_for, claim_version
    for item in db.query(FilteredItem).filter_by(session_id=session.id).all():
        state=state_for(db,item.card);claim_version(db,state,state.version)
        db.delete(item)
    db.flush()


def rebuild(db, session, uid, now):
    from browser_search import compile_search
    from search_fields import field_lookup
    from search_due import due_predicate
    from review_service import state_for, claim_version
    clear(db,session)
    @cache
    def due(): return due_predicate(db,uid,now)
    query=(db.query(Card).join(Deck).outerjoin(StudyProgress,(StudyProgress.card_id==Card.id)&(StudyProgress.user_id==uid))
           .outerjoin(SchedulerState,SchedulerState.card_id==Card.id)
           .filter(Deck.user_id==uid,~Card.filtered_item.has(),func.coalesce(StudyProgress.is_suspended,False).is_(False),
                   ~func.coalesce(SchedulerState.buried_until>now,False)))
    query=query.filter(compile_search(session.search,now,due=due,fields=field_lookup(db,uid)))
    order={'oldest':Card.id.asc(),'newest':Card.id.desc(),'random':func.random(),
           'due':StudyProgress.next_review.asc(),'lapses':func.coalesce(StudyProgress.lapse_count,0).desc()}[session.order]
    cards=query.order_by(order,Card.id).limit(session.limit).all()
    for position,card in enumerate(cards):
        state=state_for(db,card);claim_version(db,state,state.version)
        db.add(FilteredItem(session_id=session.id,card_id=card.id,position=position))
    db.flush()


@router.get('')
def list_sessions(db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return [response(db,s) for s in db.query(FilteredSession).filter_by(user_id=user.id).order_by(FilteredSession.id)]


@router.post('',status_code=201)
def create(data:Build,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    if not data.name.strip(): raise HTTPException(422,'Name must not be blank')
    try:
        session=FilteredSession(user_id=user.id,**data.model_dump());db.add(session);db.flush()
        rebuild(db,session,user.id,datetime.now(timezone.utc));db.commit()
        return response(db,session)
    except ValueError as exc:
        db.rollback();raise HTTPException(422,str(exc)) from None
    except Exception:
        db.rollback();raise


@router.post('/{sid}/rebuild')
def rebuild_session(sid:int,data:Guard,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    session=owned(db,sid,user.id)
    try:
        claim(db,session,data.expected_version)
        rebuild(db,session,user.id,datetime.now(timezone.utc));db.commit()
        return response(db,session)
    except ValueError as exc:
        db.rollback();raise HTTPException(422,str(exc)) from None
    except Exception:
        db.rollback();raise


@router.post('/{sid}/empty')
def empty(sid:int,data:Guard,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    session=owned(db,sid,user.id)
    try:
        claim(db,session,data.expected_version);clear(db,session);db.commit()
        return response(db,session)
    except Exception:
        db.rollback();raise


@router.delete('/{sid}')
def delete(sid:int,expected_version:int,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    session=owned(db,sid,user.id)
    try:
        claim(db,session,expected_version);clear(db,session);db.delete(session);db.commit()
        return {'deleted':True}
    except Exception:
        db.rollback();raise


def eligible(item, now):
    card=item.card
    progress=next((p for p in card.study_progress if p.user_id==card.deck.user_id),None)
    return not (progress and progress.is_suspended or card.scheduling and card.scheduling.buried_until and utc(card.scheduling.buried_until)>now)


def card_payload(db,card,uid,now,reschedule):
    from note_rendering import css_for_web, media_for_web, render_cards
    from deck_options import effective_settings
    from study_queue import config_for
    from scheduling import fsrs_preview
    from sm2 import get_next_intervals
    progress=db.query(StudyProgress).filter_by(card_id=card.id,user_id=uid).first()
    cfg=config_for(card.deck,now)
    intervals=None
    if reschedule:
        intervals=fsrs_preview(db,card,progress,cfg,now) if cfg.fsrs else get_next_intervals(
            progress.repetitions if progress else 0,progress.ease_factor if progress else cfg.starting_ease,
            progress.interval_days if progress else 0,config=cfg,card_state=progress.card_state if progress else 'new',
            learning_step=progress.learning_step if progress else 0)
    if reschedule:
        from early_review import intervals as early_intervals
        from sm2 import get_interval_display
        early=early_intervals(progress,cfg,now)
        if early:
            for rating,label in [(2,'hard'),(3,'good'),(4,'easy')]:
                days=early[rating]
                intervals[label]={'days':days,'seconds':days*86400,'display':get_interval_display(days=days)}
    note=card.note_link.note if card.note_link else None
    rendered=bool(note and note.package_data and json.loads(note.package_data.payload).get('_web_rendered'))
    front,back=media_for_web(card.front,uid),media_for_web(card.back,uid)
    if rendered:
        faces=render_cards(note.note_type,json.loads(note.fields_json),uid,json.loads(note.tags_json),card.deck.name)
        if card.note_link.template_ord not in faces:raise HTTPException(409,'Card template changed; inspect its note')
        front,back=faces[card.note_link.template_ord]
    return {'card_id':card.id,'front':front,'back':back,'deck_name':card.deck.name,'version':card.scheduling.version if card.scheduling else 0,
            'card_state':progress.card_state if progress else 'new','is_new':not progress or progress.card_state=='new',
            'card_css':css_for_web(note.note_type.css,uid) if note else '', 'rendered':rendered,
            'settings':effective_settings(card.deck,now),'intervals':intervals,'note_id':note.id if note else None}


@router.get('/{sid}/next')
def next_card(sid:int,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    session=owned(db,sid,user.id);now=datetime.now(timezone.utc)
    items=db.query(FilteredItem).filter_by(session_id=sid).order_by(FilteredItem.position,FilteredItem.card_id).all()
    waiting=[]
    for item in items:
        if not eligible(item,now): continue
        if item.available_at and utc(item.available_at)>now:
            waiting.append(utc(item.available_at));continue
        return {'session':response(db,session),'card':card_payload(db,item.card,user.id,now,session.reschedule),'next_available_at':None}
    return {'session':response(db,session),'card':None,'next_available_at':min(waiting).isoformat() if waiting else None}


@router.post('/{sid}/answer')
def answer(sid:int,data:Answer,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    session=owned(db,sid,user.id);now=datetime.now(timezone.utc)
    try:
        claim(db,session,data.expected_session_version)
        item=db.query(FilteredItem).filter_by(session_id=sid,card_id=data.card_id).first()
        if not item or item.card.deck.user_id!=user.id:raise HTTPException(409,'Card is no longer in this session; reload')
        if not eligible(item,now) or item.available_at and utc(item.available_at)>now:
            raise HTTPException(409,'This card is not available yet; reload')
        if session.reschedule:
            from review_service import review
            from schemas import ReviewRequest
            before={'session_id':sid,'session_version':session.version,'position':item.position,
                    'available_at':item.available_at.isoformat() if item.available_at else None}
            result=review(db,item.card,user.id,ReviewRequest(rating=data.rating,expected_version=data.expected_version,
                          duration_ms=data.duration_ms),now,commit=False,filtered_session_id=sid)
            db.flush()
            operation=db.get(StudyOperation,result['operation_id'])
            payload=json.loads(operation.before_json);payload['filtered']=before;operation.before_json=json.dumps(payload)
            # Return graduated/review cards home; keep learning steps in session.
            progress=db.query(StudyProgress).filter_by(card_id=data.card_id,user_id=user.id).one()
            if progress.card_state=='review' or progress.is_suspended: db.delete(item)
            else:item.available_at=progress.next_review
        else:
            from review_service import state_for,claim_version
            from review_service import serialize_progress, serialize_state
            state=state_for(db,item.card)
            progress=db.query(StudyProgress).filter_by(card_id=item.card_id,user_id=user.id).first()
            tags=json.loads(item.card.note_link.note.tags_json) if item.card.note_link else None
            before={'progress':serialize_progress(progress),'state':serialize_state(state),'siblings':{},'note_tags':tags,
                    'filtered':{'session_id':sid,'session_version':session.version,'position':item.position,
                                'available_at':item.available_at.isoformat() if item.available_at else None}}
            claim_version(db,state,data.expected_version)
            db.add(StudyOperation(id=str(uuid.uuid4()),user_id=user.id,card_id=item.card_id,
                                  before_json=json.dumps(before),response_json=json.dumps({
                                      'version':state.version,'rating':data.rating,'note_tags_after':tags,'log_id':None,'preview':True})))
            delay={1:session.preview_again_seconds,2:session.preview_hard_seconds,3:session.preview_good_seconds,4:0}[data.rating]
            if delay==0:db.delete(item)
            else:item.available_at=now+timedelta(seconds=delay)
        db.commit()
        return {'session':response(db,session)}
    except ValueError as exc:
        db.rollback();raise HTTPException(400,str(exc)) from None
    except Exception:
        db.rollback();raise


@router.post('/{sid}/undo')
def undo_session(sid:int,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    session=owned(db,sid,user.id)
    latest=db.query(StudyOperation).filter_by(user_id=user.id,undone=False).order_by(StudyOperation.created_at.desc(),StudyOperation.id.desc()).first()
    if not latest or json.loads(latest.before_json).get('filtered',{}).get('session_id')!=sid:
        raise HTTPException(409,'The latest undoable answer is not from this session')
    from review_service import undo
    try:
        undo(db,user.id)
        return {'session':response(db,session)}
    except Exception:
        db.rollback();raise


class EditBuild(Build):
    expected_version: int = Field(ge=0, strict=True)


@router.put('/{sid}')
def edit_session(sid: int, data: EditBuild, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Change definition and rebuild atomically; never move home decks."""
    session = owned(db, sid, user.id)
    if not data.name.strip():
        raise HTTPException(422, 'Name must not be blank')
    try:
        claim(db, session, data.expected_version)
        for key, value in data.model_dump(exclude={'expected_version'}).items():
            setattr(session, key, value)
        rebuild(db, session, user.id, datetime.now(timezone.utc))
        db.commit()
        return response(db, session)
    except ValueError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from None
    except Exception:
        db.rollback()
        raise
