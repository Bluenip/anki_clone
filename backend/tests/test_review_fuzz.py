import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import pytest
from fsrs import Card as MemoryCard, State
from models import Card, SchedulerState, StudyProgress
from review_fuzz import fuzz_bounds, fuzzed_interval, review_seed
from scheduling import fsrs_preview, utc
from sm2 import DeckSchedulingConfig
from test_review_events import setup_note


@pytest.mark.parametrize('interval,minimum,maximum,expected', [
    (1,1,1000,(1,1)), (2.49,1,1000,(2,2)), (2.5,1,1000,(2,4)),
    (7,1,1000,(5,9)), (17,1,1000,(14,20)), (37,1,1000,(33,41)),
    (2,3,1000,(3,4)), (2,3,3,(3,3)), (100,97,103,(97,103)),
    (100,1,99,(92,99)), (1,3,2,(2,2)),
])
def test_published_anki_bounds(interval, minimum, maximum, expected):
    assert fuzz_bounds(interval, minimum, maximum) == expected


def test_previous_interval_floor_and_maximum():
    assert fuzzed_interval(4.591988,36500,0,4) == 5
    assert fuzzed_interval(2.7269483,36500,0,4) == 4
    assert fuzzed_interval(2.7269483,36500,0,5) < 5
    assert fuzzed_interval(10,3,(1<<64)-1,99) == 3


def test_spreading_is_stable_and_varies_across_cards():
    days = set()
    for cid in range(1,100):
        card = SimpleNamespace(id=cid, deck=SimpleNamespace(user_id=1))
        seed = review_seed(card, None)
        assert seed == review_seed(card, SimpleNamespace(repetitions=0))
        value = fuzzed_interval(17,36500,seed)
        assert 14 <= value <= 20
        days.add(value)
    assert len(days) == 7


@pytest.mark.parametrize('rating',[1,2,3,4])
def test_fsrs_preview_apply_retry_and_undo_keep_same_fuzz(client, db_session, auth_headers_a, rating):
    from review_service import review, undo
    from schemas import ReviewRequest
    _, (cid,) = setup_note(client,auth_headers_a,{'fsrs':True,'fsrs_fuzz':True,'maximum_interval':60})
    card = db_session.get(Card,cid)
    now = datetime(2026,10,22,8,tzinfo=timezone.utc)
    memory = MemoryCard(card_id=cid,state=State.Review,stability=17,difficulty=5,due=now,last_review=now-timedelta(days=17))
    card.scheduling = SchedulerState(fsrs_json=json.dumps({'engine':'py-fsrs-6.3.2','card':memory.to_dict()}),version=0)
    progress = StudyProgress(user_id=card.deck.user_id,card_id=cid,card_state='review',interval_days=17,
                             repetitions=4,last_reviewed=now-timedelta(days=17),next_review=now)
    db_session.add(progress);db_session.commit()
    config = DeckSchedulingConfig(fsrs=True,fsrs_fuzz=True,maximum_interval=60)
    preview = fsrs_preview(db_session,card,progress,config,now)
    assert preview == fsrs_preview(db_session,card,progress,config,now)
    label = ['again','hard','good','easy'][rating-1]
    request = ReviewRequest(rating=rating,request_id='fuzz-event',expected_version=0)
    result = review(db_session,card,card.deck.user_id,request,now=now)
    assert int((utc(progress.next_review)-now).total_seconds()) == preview[label]['seconds']
    if result['card_state']=='review':
        assert result['interval_days'] == preview[label]['days']
        assert 1 <= result['interval_days'] <= 60
    assert review(db_session,card,card.deck.user_id,request,now=now) == result
    undo(db_session,card.deck.user_id)
    db_session.refresh(progress)
    assert fsrs_preview(db_session,card,progress,config,now) == preview


def test_setting_does_not_reschedule_existing_cards(client,db_session,auth_headers_a):
    did,(cid,) = setup_note(client,auth_headers_a,{'fsrs':True})
    due=datetime(2027,1,1)
    progress=StudyProgress(user_id=db_session.get(Card,cid).deck.user_id,card_id=cid,card_state='review',next_review=due,interval_days=20)
    db_session.add(progress);db_session.commit()
    response=client.put(f'/api/decks/{did}',headers=auth_headers_a,json={'settings':json.dumps({'fsrs':True,'fsrs_fuzz':True})})
    assert response.status_code==200,response.text
    db_session.refresh(progress)
    assert progress.next_review==due
    bad=client.put(f'/api/decks/{did}',headers=auth_headers_a,json={'settings':'{"fsrs_fuzz":"false"}'})
    assert bad.status_code==422


def test_native_anki_fuzz_samples_stay_within_same_bounds(tmp_path):
    from anki.collection import Collection
    collection=Collection(str(tmp_path/'fuzz-reference.anki2'))
    try:
        for index in range(12):
            note=collection.new_note(collection.models.by_name('Basic'))
            note.fields=[f'Question {index}','Answer'];collection.add_note(note,1)
            cid=collection.find_cards(f'nid:{note.id}')[0]
            for interval in (1,2,3,7,17,37,100):
                actual=interval+collection._backend.fuzz_delta(card_id=cid,interval=interval)
                low,high=fuzz_bounds(interval)
                assert low<=actual<=high,(interval,actual,low,high)
    finally:
        collection.close()


@pytest.mark.parametrize('state',['learning','relearning'])
def test_enabling_fsrs_preserves_existing_step_without_history(client,db_session,auth_headers_a,state):
    from review_service import review
    from schemas import ReviewRequest
    from scheduling import fsrs_state
    did,(cid,)=setup_note(client,auth_headers_a,{'fsrs':True,'learning_steps':'1m 10m','relearning_steps':'1m 10m'})
    card=db_session.get(Card,cid)
    now=datetime(2026,10,22,8,tzinfo=timezone.utc)
    progress=StudyProgress(user_id=card.deck.user_id,card_id=cid,card_state=state,learning_step=1,
                           interval_days=7,repetitions=5,next_review=now,last_reviewed=now-timedelta(minutes=10))
    db_session.add(progress);db_session.commit()
    config=DeckSchedulingConfig(fsrs=True,learning_steps='1m 10m',relearning_steps='1m 10m')
    memory,initialization=fsrs_state(db_session,card,progress,config,now)
    assert memory.step==1
    assert memory.state==(State.Learning if state=='learning' else State.Relearning)
    assert initialization=='preserved_steps_without_history'
    assert card.scheduling is None
    result=review(db_session,card,card.deck.user_id,ReviewRequest(rating=3),now=now)
    assert result['card_state']=='review'
    assert result['initialization']=='preserved_steps_without_history'


@pytest.mark.parametrize('reviewing',[False,True])
def test_fsrs_memory_and_learning_delays_against_native_anki(tmp_path,reviewing):
    from anki.collection import Collection
    from anki.cards import FSRSMemoryState
    from fsrs import Rating
    from scheduling import fsrs_scheduler
    collection=Collection(str(tmp_path/'native-memory.anki2'))
    now=datetime.now(timezone.utc).replace(microsecond=0)
    try:
        collection.set_config('fsrs',True)
        note=collection.new_note(collection.models.by_name('Basic'));note.fields=['Q','A'];collection.add_note(note,1)
        native=collection.get_card(collection.find_cards('')[0])
        if reviewing:
            native.type=2;native.queue=2;native.ivl=17;native.reps=4;native.due=collection.sched.today
            native.memory_state=FSRSMemoryState(stability=17,difficulty=5)
            native.last_review_time=int((now-timedelta(days=17)).timestamp());collection.update_card(native)
            memory=MemoryCard(card_id=native.id,state=State.Review,stability=17,difficulty=5,due=now,last_review=now-timedelta(days=17))
        else:
            memory=MemoryCard(card_id=native.id,due=now)
        choices=collection._backend.get_scheduling_states(native.id)
        engine=fsrs_scheduler(DeckSchedulingConfig(fsrs=True))
        for rating,label in enumerate(('again','hard','good','easy'),1):
            actual,_=engine.review_card(memory,Rating(rating),review_datetime=now)
            normal=getattr(choices,label).normal
            kind=normal.WhichOneof('kind')
            expected=getattr(normal,kind)
            if kind=='relearning':expected=expected.learning
            assert actual.stability==pytest.approx(expected.memory_state.stability,rel=2e-6)
            assert actual.difficulty==pytest.approx(expected.memory_state.difficulty,rel=2e-6)
            if actual.state!=State.Review:
                assert int((actual.due-now).total_seconds())==expected.scheduled_secs
            else:
                raw=(actual.due-now).total_seconds()/86400
                low,high=fuzz_bounds(raw)
                assert low<=expected.scheduled_days<=high
    finally:
        collection.close()
