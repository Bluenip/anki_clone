"""Atomic review events, optimistic concurrency, sibling burying and undo."""
from datetime import datetime, timezone
import json
import uuid
from fastapi import HTTPException
from sqlalchemy import update
from sqlalchemy.dialects.sqlite import insert
from models import StudyProgress, SchedulerState, StudyOperation, ReviewLog, ReviewRecord, Card, Deck
from scheduling import apply_fsrs, utc, next_study_day, study_day
from study_queue import config_for, interday


def serialize_progress(progress):
    if progress is None:
        return None
    return {column.name: (value.isoformat() if isinstance(value,datetime) else value)
            for column in StudyProgress.__table__.columns for value in [getattr(progress,column.name)]}


def serialize_state(state):
    return {'fsrs_json':state.fsrs_json, 'buried_until':state.buried_until.isoformat() if state.buried_until else None, 'version':state.version}


def state_for(db, card):
    db.execute(insert(SchedulerState).values(card_id=card.id, version=0).on_conflict_do_nothing(index_elements=['card_id']))
    state = db.query(SchedulerState).filter_by(card_id=card.id).one()
    card.scheduling = state
    return state


def claim_version(db, state, expected):
    version = state.version
    if expected is not None and version != expected:
        raise HTTPException(status_code=409, detail='This card changed in another tab; reload before reviewing')
    result = db.execute(update(SchedulerState).where(SchedulerState.card_id==state.card_id, SchedulerState.version==version)
                        .values(version=version+1).execution_options(synchronize_session=False))
    if result.rowcount != 1:
        raise HTTPException(status_code=409, detail='Concurrent review detected; reload before reviewing')
    db.refresh(state)


def review(db, card, user_id, data, now=None, *, commit=True, filtered_session_id=None):
    from routers.study_router import _handle_learning, _handle_relearning, _handle_lapse, _handle_review
    now = now or datetime.now(timezone.utc)
    if data.request_id:
        previous = db.query(StudyOperation).filter_by(user_id=user_id,request_id=data.request_id).first()
        if previous:
            response=json.loads(previous.response_json)
            if previous.undone or previous.card_id!=card.id or response['rating']!=data.rating:
                raise HTTPException(status_code=409, detail='Request ID has already been used for a different or undone operation')
            return response
    config=config_for(card.deck)
    state=state_for(db,card)
    before_state=serialize_state(state)
    claim_version(db,state,data.expected_version)
    if card.filtered_item and card.filtered_item.session_id != filtered_session_id:
        raise HTTPException(status_code=409, detail='Card is in a custom study session; open that session or empty it first')
    if data.study_deck_id is not None:
        from study_queue import snapshot
        selected=db.query(Deck).filter_by(id=data.study_deck_id,user_id=user_id).first()
        if selected is None or not (card.deck_id==selected.id or card.deck.name.startswith(selected.name+'::')):
            raise HTTPException(status_code=404,detail='Card is not in this study deck')
        if card.id not in snapshot(db,selected,user_id,now)['eligible_ids']:
            raise HTTPException(status_code=409,detail='This card is no longer due or its daily limit was reached; reload the study queue')
    progress=db.query(StudyProgress).filter_by(card_id=card.id,user_id=user_id).first()
    before=serialize_progress(progress)
    was_new=progress is None or progress.card_state=='new'
    if (progress and progress.is_suspended) or (state.buried_until and utc(state.buried_until)>now):
        raise HTTPException(status_code=409, detail='This card is suspended or buried; reload the study queue')
    kind='new' if was_new else 'interday' if interday(progress,config,now) else progress.card_state
    if progress is None:
        progress=StudyProgress(user_id=user_id,card_id=card.id,card_state='new',learning_step=0,ease_factor=config.starting_ease,
                               interval_days=0,repetitions=0,lapse_count=0,is_suspended=False,is_leech=False)
        db.add(progress)
    interval_before=progress.interval_days
    if progress.card_state in ('learning','relearning') and progress.last_reviewed and progress.next_review:
        interval_before=-max(1,int((utc(progress.next_review)-utc(progress.last_reviewed)).total_seconds()))
    original_tags=json.loads(card.note_link.note.tags_json) if card.note_link else None
    from deck_options import effective_settings
    raw_settings=effective_settings(card.deck,now)
    duration=min(data.duration_ms,int(raw_settings.get('maximum_answer_seconds',60))*1000)
    initialization=None
    from early_review import intervals as early_intervals
    early = early_intervals(progress,config,now) if filtered_session_id is not None else None
    previous_ease = progress.ease_factor
    if config.fsrs:
        initialization=apply_fsrs(db,card,progress,data.rating,config,now,duration)
    else:
        # Switching back to SM-2 invalidates the old FSRS cache. Re-enabling
        # replays the full history rather than ignoring intervening SM-2 reviews.
        state.fsrs_json=None
        if progress.card_state in ('new','learning'):_handle_learning(progress,data.rating,config,now)
        elif progress.card_state=='relearning':_handle_relearning(progress,data.rating,config,now)
        elif data.rating==1:_handle_lapse(progress,config,now)
        else:_handle_review(progress,data.rating,config,now)
        if early and data.rating > 1:
            progress.interval_days = early[data.rating]
            progress.ease_factor = max(1.3, previous_ease + {2:-0.15,3:0,4:0.15}[data.rating])
        if progress.card_state=='review':
            progress.next_review=next_study_day(now,config,progress.interval_days)
    if progress.lapse_count>=config.leech_threshold:
        progress.is_leech=True
        if config.leech_action in ('Suspend Card','suspend'):progress.is_suspended=True
        if card.note_link:
            tags=json.loads(card.note_link.note.tags_json)
            if 'leech' not in tags:card.note_link.note.tags_json=json.dumps(tags+['leech'])
    progress.last_reviewed=now
    log=ReviewLog(user_id=user_id,card_id=card.id,rating=data.rating,was_new=was_new,review_date=now)
    interval_after=progress.interval_days if progress.card_state=='review' else -max(1,int((utc(progress.next_review)-now).total_seconds()))
    log.record=ReviewRecord(payload=json.dumps({'kind':kind,'duration_ms':duration,'interval_before':interval_before,
                         'interval_after':interval_after,'scheduler':'fsrs' if config.fsrs else 'sm2'}))
    db.add(log);db.flush()
    siblings={}
    if card.note_link:
        for link in card.note_link.note.card_links:
            sibling=link.card
            if sibling.id==card.id:continue
            sibling_progress=db.query(StudyProgress).filter_by(card_id=sibling.id,user_id=user_id).first()
            sibling_kind='new' if sibling_progress is None or sibling_progress.card_state=='new' else 'interday' if interday(sibling_progress,config,now) else sibling_progress.card_state
            should_bury=(sibling_kind=='new' and config.bury_new_siblings or sibling_kind=='review' and config.bury_review_siblings or sibling_kind=='interday' and config.bury_interday_learning_siblings)
            if should_bury:
                sibling_state=state_for(db,sibling)
                siblings[str(sibling.id)]=serialize_state(sibling_state)
                claim_version(db,sibling_state,sibling_state.version)
                sibling_state.buried_until=next_study_day(now,config)
    operation_id=str(uuid.uuid4())
    response={'next_review':progress.next_review.isoformat(), 'interval_days':progress.interval_days,'ease_factor':progress.ease_factor,
              'message':'Review saved', 'card_state':progress.card_state,'is_leech':progress.is_leech,'lapse_count':progress.lapse_count,
              'version':state.version,'operation_id':operation_id,'scheduler':'fsrs' if config.fsrs else 'sm2',
              'initialization':initialization,'rating':data.rating,'log_id':log.id,
              'note_tags_after':json.loads(card.note_link.note.tags_json) if card.note_link else None}
    db.add(StudyOperation(id=operation_id,user_id=user_id,card_id=card.id,request_id=data.request_id,
                         before_json=json.dumps({'progress':before,'state':before_state,'siblings':siblings,
                                                  'note_tags':original_tags}),
                         response_json=json.dumps(response)))
    if commit: db.commit()
    return response


def undo(db,user_id):
    operation=db.query(StudyOperation).filter_by(user_id=user_id,undone=False).order_by(StudyOperation.created_at.desc(),StudyOperation.id.desc()).first()
    if operation is None:raise HTTPException(status_code=404,detail='No review to undo')
    response=json.loads(operation.response_json)
    card=db.query(Card).join(Deck).filter(Card.id==operation.card_id,Deck.user_id==user_id).first()
    if card is None:raise HTTPException(status_code=409,detail='Card no longer exists')
    state=state_for(db,card)
    before=json.loads(operation.before_json)
    expected = before.get('undo_versions', {}).get(str(card.id), response['version'])
    if state.version!=expected:raise HTTPException(status_code=409,detail='Card changed after this review; undo would overwrite newer work')
    if card.note_link and json.loads(card.note_link.note.tags_json)!=response.get('note_tags_after'):
        raise HTTPException(status_code=409,detail='Note tags changed after this review; undo would overwrite newer work')
    # Check siblings before making any changes.
    restored=[]
    for sid,value in before['siblings'].items():
        sibling=db.get(Card,int(sid))
        sibling_expected = before.get('undo_versions', {}).get(sid, value['version']+1)
        if sibling is None or sibling.deck.user_id!=user_id or not sibling.scheduling or sibling.scheduling.version!=sibling_expected:
            raise HTTPException(status_code=409,detail='A sibling changed; this review cannot safely be undone')
        restored.append((sibling.scheduling,value))
    from filtered_undo import restore
    filtered_change = restore(db,user_id,card,before)
    claim_version(db,state,expected)
    progress=db.query(StudyProgress).filter_by(card_id=card.id,user_id=user_id).first()
    if before['progress'] is None:
        if progress:db.delete(progress)
    else:
        for key,value in before['progress'].items():
            if key in ('next_review','last_reviewed') and value is not None:value=datetime.fromisoformat(value)
            setattr(progress,key,value)
    state.fsrs_json=before['state']['fsrs_json']
    state.buried_until=datetime.fromisoformat(before['state']['buried_until']) if before['state']['buried_until'] else None
    for sibling_state,value in restored:
        claim_version(db,sibling_state,sibling_state.version)
        sibling_state.buried_until=datetime.fromisoformat(value['buried_until']) if value['buried_until'] else None
    log=db.get(ReviewLog,response['log_id']) if response['log_id'] is not None else None
    if log and log.user_id==user_id:db.delete(log)
    if card.note_link and before['note_tags'] is not None:
        card.note_link.note.tags_json=json.dumps(before['note_tags'])
    operation.undone=True
    # Undo restores logical state but versions must remain monotonic to reject
    # stale browser requests. Retarget older undo guards only where the restored
    # version is exactly the state that older event originally produced.
    changes = {str(card.id): (before['state']['version'], state.version)}
    changes.update({str(s.card_id): (value['version'], s.version) for s, value in restored})
    for older in db.query(StudyOperation).filter_by(user_id=user_id, undone=False).all():
        if older.id == operation.id:
            continue
        old_before = json.loads(older.before_json)
        old_response = json.loads(older.response_json)
        filtered = old_before.get('filtered')
        if filtered_change and filtered and filtered['session_id'] == filtered_change[0]:
            if filtered.get('undo_session_version', filtered['session_version']) == filtered_change[1]:
                filtered['undo_session_version'] = filtered_change[2]
        guards = old_before.setdefault('undo_versions', {})
        for cid, (restored_version, current_version) in changes.items():
            produced = old_response['version'] if str(older.card_id) == cid else (
                old_before['siblings'][cid]['version']+1 if cid in old_before['siblings'] else None)
            if produced is not None and guards.get(cid, produced) == restored_version:
                guards[cid] = current_version
        older.before_json = json.dumps(old_before)
    db.commit()
    return {'card_id':card.id,'version':state.version,'message':'Review undone'}
