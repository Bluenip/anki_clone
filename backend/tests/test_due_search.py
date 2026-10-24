from datetime import datetime, timedelta, timezone
import json
from anki.collection import Collection
from models import Deck, StudyProgress, SchedulerState
from scheduling import next_study_day
from study_queue import config_for


def test_due_matches_native_learning_ahead_and_day_queues(client, auth_headers_a, db_session, tmp_path):
    did = client.post('/api/decks', headers=auth_headers_a, json={'name': 'Due'}).json()['id']
    deck = db_session.get(Deck, did)
    deck.settings = json.dumps({'timezone':'Asia/Ho_Chi_Minh','day_starts_at':4,'learning_ahead_seconds':1200})
    db_session.commit()
    now = datetime.now(timezone.utc)
    end = next_study_day(now, config_for(deck))
    native = Collection(str(tmp_path/'due-native.anki2'))
    mapping = {}
    try:
        today = native.sched.today
        fixtures = [
            ('review', 2, 2, today, now-timedelta(days=1), False, False),
            ('review', 2, 2, today+1, end, False, False),
            ('learning', 1, 1, int(now.timestamp())-60, now-timedelta(seconds=60), False, False),
            ('learning', 1, 1, int(now.timestamp())+600, now+timedelta(seconds=600), False, False),
            ('learning', 1, 1, int(now.timestamp())+1800, now+timedelta(seconds=1800), False, False),
            ('learning', 1, 3, today, now-timedelta(hours=1), False, False),
            ('review', 2, -1, today, now-timedelta(days=1), True, False),
            ('review', 2, -2, today, now-timedelta(days=1), False, True),
            ('new', 0, 0, 1, now-timedelta(days=1), False, False),
        ]
        for index,(state,typ,queue,due,web_due,suspended,buried) in enumerate(fixtures):
            note = client.post('/api/notes', headers=auth_headers_a, json={'deck_id':did,'fields':{'Front':str(index),'Back':'a'}}).json()
            cid = note['cards'][0]['id']
            db_session.add(StudyProgress(card_id=cid,user_id=deck.user_id,card_state=state,next_review=web_due,
                last_reviewed=now-timedelta(days=2) if queue==3 else now,is_suspended=suspended))
            if buried: db_session.add(SchedulerState(card_id=cid,buried_until=end,version=0))
            n = native.new_note(native.models.by_name('Basic')); n.fields=[str(index),'a']; native.add_note(n,1)
            c = native.get_card(native.find_cards(f'nid:{n.id}')[0]);c.type=typ;c.queue=queue;c.due=due;native.update_card(c)
            mapping[c.id]=cid
        db_session.commit()
        expected={mapping[cid] for cid in native.find_cards('is:due')}
        for query in ['is:due', 'is:due OR is:due', 'deck:Due is:due']:
            response=client.get('/api/cards/browse',headers=auth_headers_a,params={'search':query})
            assert response.status_code==200,response.text
            assert {row['id'] for row in response.json()}==expected
        inverse=client.get('/api/cards/browse',headers=auth_headers_a,params={'search':'-is:due'}).json()
        assert {row['id'] for row in inverse}==set(mapping.values())-expected
    finally:
        native.close()


def test_due_ignores_daily_limits_and_respects_ownership(client,auth_headers_a,auth_headers_b,db_session):
    now=datetime.now(timezone.utc)
    own=[]
    for headers,name,hours in [(auth_headers_a,'Today',-1),(auth_headers_a,'Future',48),(auth_headers_b,'Foreign',-1)]:
        did=client.post('/api/decks',headers=headers,json={'name':name}).json()['id']
        deck=db_session.get(Deck,did)
        deck.settings=json.dumps({'maximum_reviews_per_day':0,'new_cards_per_day':0})
        note=client.post('/api/notes',headers=headers,json={'deck_id':did,'fields':{'Front':name,'Back':'a'}}).json()
        cid=note['cards'][0]['id']
        db_session.add(StudyProgress(card_id=cid,user_id=deck.user_id,card_state='review',next_review=now+timedelta(hours=hours)))
        db_session.commit()
        if name=='Today': own.append(cid)
    response=client.get('/api/cards/browse',headers=auth_headers_a,params={'search':'is:due'})
    assert response.status_code==200,response.text
    assert [row['id'] for row in response.json()]==own
