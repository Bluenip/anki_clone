"""Read-only collection/deck statistics using each home deck's study-day clock."""
import json
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, joinedload
from database import get_db
from auth import get_current_user
from models import User, Deck, Card, StudyProgress, ReviewLog, NoteCard
from study_queue import config_for
from scheduling import utc, study_day

router=APIRouter(prefix='/api/stats',tags=['Statistics'])


@router.get('')
def statistics(deck_id:int|None=None,days:int=Query(default=30,ge=1,le=365),
               db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    now=datetime.now(timezone.utc)
    decks=db.query(Deck).filter_by(user_id=user.id).all()
    if deck_id is not None:
        selected=next((d for d in decks if d.id==deck_id),None)
        if not selected:raise HTTPException(404,'Deck not found')
        decks=[d for d in decks if d.id==selected.id or d.name.startswith(selected.name+'::')]
    configs={d.id:config_for(d,now) for d in decks}
    today={did:study_day(now,cfg).astimezone(ZoneInfo(cfg.timezone)).date() for did,cfg in configs.items()}
    def day_offset(value,did):
        cfg=configs[did]
        return (study_day(utc(value),cfg).astimezone(ZoneInfo(cfg.timezone)).date()-today[did]).days
    cards=(db.query(Card).filter(Card.deck_id.in_(configs)).options(joinedload(Card.scheduling),joinedload(Card.note_link)).all())
    progress={p.card_id:p for p in db.query(StudyProgress).join(Card).filter(StudyProgress.user_id==user.id,Card.deck_id.in_(configs))}
    counts={'new':0,'learning':0,'young':0,'mature':0,'suspended':0,'buried':0,'total':len(cards),'notes':0}
    notes=set()
    buckets=[{'label':'1 day','min':1,'max':1,'count':0},{'label':'2–6 days','min':2,'max':6,'count':0},
             {'label':'7–20 days','min':7,'max':20,'count':0},{'label':'21–89 days','min':21,'max':89,'count':0},
             {'label':'90+ days','min':90,'max':None,'count':0}]
    forecast=[{'day':i,'cards':0} for i in range(days)]
    for card in cards:
        notes.add(('note',card.note_link.note_id) if card.note_link else ('legacy',card.id))
        p=progress.get(card.id)
        suspended=bool(p and p.is_suspended)
        buried=bool(card.scheduling and card.scheduling.buried_until and utc(card.scheduling.buried_until)>now)
        counts['suspended']+=suspended;counts['buried']+=buried
        if p is None or p.card_state=='new':counts['new']+=1
        elif p.card_state in ('learning','relearning'):counts['learning']+=1
        else:
            counts['mature' if p.interval_days>=21 else 'young']+=1
            for bucket in buckets:
                if p.interval_days>=bucket['min'] and (bucket['max'] is None or p.interval_days<=bucket['max']):
                    bucket['count']+=1;break
        if p and p.card_state!='new' and p.next_review and not suspended and not buried:
            offset=max(0,day_offset(p.next_review,card.deck_id))
            if offset<days:forecast[offset]['cards']+=1
    counts['notes']=len(notes)
    history=[{'day':i,'reviews':0,'seconds':0,'again':0,'hard':0,'good':0,'easy':0} for i in range(-days+1,1)]
    by_day={row['day']:row for row in history}
    attempts=remembered=duration_ms=0
    # UTC coarse bound safely covers every local day/DST; exact per-deck check below.
    logs=(db.query(ReviewLog).join(Card).filter(ReviewLog.user_id==user.id,Card.deck_id.in_(configs),
          ReviewLog.review_date>=now-timedelta(days=days+2),ReviewLog.review_date<=now,ReviewLog.rating.in_([1,2,3,4]))
          .options(joinedload(ReviewLog.card),joinedload(ReviewLog.record)))
    for log in logs.yield_per(500):
        offset=day_offset(log.review_date,log.card.deck_id)
        if offset not in by_day:continue
        row=by_day[offset];row['reviews']+=1
        row[{1:'again',2:'hard',3:'good',4:'easy'}[log.rating]]+=1
        payload=json.loads(log.record.payload) if log.record else {}
        duration=payload.get('duration_ms',0)
        row['seconds']+=duration/1000;duration_ms+=duration
        if payload.get('kind')=='review':
            attempts+=1;remembered+=log.rating>1
    total=sum(row['reviews'] for row in history)
    for row in history:row['seconds']=round(row['seconds'],1)
    return {'days':days,'deck_id':deck_id,'counts':counts,'history':history,'forecast':forecast,'intervals':buckets,
            'summary':{'reviews':total,'seconds':round(duration_ms/1000,1),
                       'seconds_per_review':round(duration_ms/1000/total,1) if total else None,
                       'active_days':sum(row['reviews']>0 for row in history),
                       'review_attempts':attempts,'remembered':remembered,
                       'review_recall_percent':round(100*remembered/attempts,1) if attempts else None},
            'day_basis':'Each home deck uses its configured timezone and day cutoff; day 0 means today.',
            'forecast_basis':'Current scheduled cards; excludes suspended/buried, includes overdue in day 0. Future answers can change this forecast.',
            'recall_basis':'Again versus Hard/Good/Easy on recorded review-state answers only; excludes learning and unclassified imported logs.'}
