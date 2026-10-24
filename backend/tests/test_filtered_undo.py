from datetime import datetime, timedelta, timezone
import json
from models import Card, StudyProgress, ReviewLog, FilteredItem, FilteredSession


def setup_session(client,headers,db_session,reschedule=True):
    did=client.post('/api/decks',headers=headers,json={'name':'Home'}).json()['id']
    ids=[]
    for label in ['first','second']:
        note=client.post('/api/notes',headers=headers,json={'deck_id':did,'fields':{'Front':label,'Back':'answer'}}).json()
        cid=note['cards'][0]['id'];ids.append(cid)
        db_session.add(StudyProgress(card_id=cid,user_id=db_session.get(Card,cid).deck.user_id,
            card_state='review',interval_days=10,repetitions=5,next_review=datetime.now(timezone.utc)-timedelta(days=1)))
    db_session.commit()
    response=client.post('/api/filtered',headers=headers,json={'name':'Session','search':'deck:Home','reschedule':reschedule})
    assert response.status_code==201,response.text
    return did,ids,response.json()


def answer(client,headers,sid,rating):
    view=client.get(f'/api/filtered/{sid}/next',headers=headers).json()
    assert view.get('card'),view
    return client.post(f'/api/filtered/{sid}/answer',headers=headers,json={
        'card_id':view['card']['card_id'],'expected_version':view['card']['version'],
        'expected_session_version':view['session']['version'],'rating':rating})


def test_filtered_review_multiundo_restores_membership(client,auth_headers_a,db_session):
    did,ids,session=setup_session(client,auth_headers_a,db_session)
    for _ in ids:
        result=answer(client,auth_headers_a,session['id'],3)
        assert result.status_code==200,result.text
    assert db_session.query(FilteredItem).count()==0
    for cid in reversed(ids):
        undo=client.post('/api/study/undo/latest',headers=auth_headers_a)
        assert undo.status_code==200,undo.text
        assert undo.json()['card_id']==cid
        assert db_session.get(FilteredItem,cid).session_id==session['id']
        progress=db_session.query(StudyProgress).filter_by(card_id=cid).one()
        assert progress.interval_days==10 and progress.repetitions==5
        assert db_session.get(Card,cid).deck_id==did
    assert db_session.query(ReviewLog).count()==0


def test_preview_four_ratings_and_delays_preserve_progress(client,auth_headers_a,db_session):
    _,ids,session=setup_session(client,auth_headers_a,db_session,False)
    before=[(p.card_id,p.interval_days,p.next_review,p.repetitions) for p in db_session.query(StudyProgress).order_by(StudyProgress.card_id)]
    response=answer(client,auth_headers_a,session['id'],2)
    assert response.status_code==200,response.text
    item=db_session.get(FilteredItem,ids[0])
    assert item.available_at is not None
    response=answer(client,auth_headers_a,session['id'],4)
    assert response.status_code==200,response.text
    assert db_session.get(FilteredItem,ids[1]) is None
    assert db_session.query(ReviewLog).count()==0
    assert [(p.card_id,p.interval_days,p.next_review,p.repetitions) for p in db_session.query(StudyProgress).order_by(StudyProgress.card_id)]==before


def test_rebuild_blocks_old_filtered_undo(client,auth_headers_a,db_session):
    _,_,session=setup_session(client,auth_headers_a,db_session)
    result=answer(client,auth_headers_a,session['id'],3)
    assert result.status_code==200,result.text
    session=result.json()['session']
    rebuilt=client.post(f"/api/filtered/{session['id']}/rebuild",headers=auth_headers_a,json={'expected_version':session['version']})
    assert rebuilt.status_code==200,rebuilt.text
    assert client.post('/api/study/undo/latest',headers=auth_headers_a).status_code==409
    assert db_session.query(ReviewLog).count()==1


def test_preview_undo_restores_membership_without_review_log(client,auth_headers_a,db_session):
    _,ids,session=setup_session(client,auth_headers_a,db_session,False)
    result=answer(client,auth_headers_a,session['id'],4)
    assert result.status_code==200,result.text
    assert db_session.get(FilteredItem,ids[0]) is None
    undone=client.post(f"/api/filtered/{session['id']}/undo",headers=auth_headers_a)
    assert undone.status_code==200,undone.text
    assert db_session.get(FilteredItem,ids[0]) is not None
    assert db_session.query(ReviewLog).count()==0
    assert db_session.query(StudyProgress).filter_by(card_id=ids[0]).one().interval_days==10


def test_early_sm2_preview_matches_applied_home_schedule(client,auth_headers_a,db_session):
    from scheduling import next_study_day
    from study_queue import config_for
    _,ids,session=setup_session(client,auth_headers_a,db_session)
    card=db_session.get(Card,ids[0]);progress=db_session.query(StudyProgress).filter_by(card_id=card.id).one()
    now=datetime.now(timezone.utc)
    progress.next_review=next_study_day(now,config_for(card.deck),9)
    progress.interval_days=10;progress.ease_factor=2.5
    db_session.commit()
    view=client.get(f"/api/filtered/{session['id']}/next",headers=auth_headers_a).json()
    assert view['card']['intervals']['good']['days']==10
    result=answer(client,auth_headers_a,session['id'],3)
    assert result.status_code==200,result.text
    db_session.refresh(progress)
    assert progress.interval_days==10 and progress.ease_factor==2.5
