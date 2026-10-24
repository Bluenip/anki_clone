import json
from datetime import datetime, timedelta, timezone
import pytest
from models import Card, Deck, Note, StudyProgress, SchedulerState

@pytest.fixture
def collection(client,auth_headers_a,auth_headers_b,db_session):
    ids=[]
    for headers,deck,front,tags in [
        (auth_headers_a,'French Words','dog cat',['animal::mammal']),
        (auth_headers_a,'French Words::Verbs','dog mouse',['animalistic']),
        (auth_headers_a,'Other','100% literal* a_b',[]),
        (auth_headers_b,'Foreign','dog cat',[])]:
        d=client.post('/api/decks',headers=headers,json={'name':deck}).json()['id']
        r=client.post('/api/notes',headers=headers,json={'deck_id':d,'kind':'basic','fields':{'Front':front,'Back':'answer'},'tags':tags})
        assert r.status_code==201,r.text
        ids.append(r.json()['cards'][0]['id'])
    owner=db_session.get(Card,ids[0]).deck.user_id
    db_session.add(StudyProgress(card_id=ids[0],user_id=owner,card_state='relearning',is_suspended=True))
    db_session.add(SchedulerState(card_id=ids[1],version=2,buried_until=datetime.now(timezone.utc)+timedelta(days=1)))
    db_session.commit()
    return ids

def search(client,headers,query):
    r=client.get('/api/cards/browse',headers=headers,params={'search':query})
    assert r.status_code==200,r.text
    return {row['id'] for row in r.json()}

@pytest.mark.parametrize('query,indices',[
    ('dog cat',[0]),('dog OR literal*',[0,1,2]),('dog (cat or mouse)',[0,1]),
    ('dog -cat',[1]),('-(cat OR mouse)',[2]),('"dog cat"',[0]),
    ('deck:"French Words"',[0,1]),('"deck:French Words" -deck:*::Verbs',[0]),
    ('tag:animal',[0]),('tag:ani*',[0,1]),('tag:none',[2]),('-tag:animal',[1,2]),
    ('is:new',[1,2]),('is:learn is:review',[0]),('is:suspended',[0]),
    ('is:buried',[1]),('-is:buried',[0,2]),('100%',[2]),
    (r'literal\*',[2]),(r'a\_b',[2]),('note:Basic',[0,1,2]),
    ('dog AND mouse OR 100%',[1,2])])
def test_search(client,auth_headers_a,collection,query,indices):
    assert search(client,auth_headers_a,query)=={collection[i] for i in indices}

def test_source_and_legacy(client,auth_headers_a,collection,db_session):
    a,b,c,_=collection
    card=db_session.get(Card,a);note=card.note_link.note
    fields=json.loads(note.fields_json);fields.append('secret source');note.fields_json=json.dumps(fields)
    legacy=Card(deck_id=card.deck_id,front='legacy source',back='fallback');db_session.add(legacy);db_session.commit()
    assert search(client,auth_headers_a,'"secret source"')=={a}
    assert search(client,auth_headers_a,'fallback')=={legacy.id}
    assert search(client,auth_headers_a,f'cid:{a},{b}')=={a,b}
    assert search(client,auth_headers_a,f'nid:{note.id}')=={a}
    assert search(client,auth_headers_a,'-note:Basic')=={legacy.id}
    assert db_session.query(Note).count()==4

@pytest.mark.parametrize('query',['dog OR','(dog','dog)','"dog','is:unknown','flag:8','tag:',
    'cid:0','nid:1,no','cid:99999999999999999999999','dog AND OR cat','()','a\\',
    '('*18+'dog'+')'*18,'a '*130,'a'*2049])
def test_invalid(client,auth_headers_a,query):
    assert client.get('/api/cards/browse',headers=auth_headers_a,params={'search':query}).status_code==422

def batch(client,headers,action,targets):
    return client.post('/api/cards/bulk-action',headers=headers,json={'action':action,
        'cards':[{'card_id':cid,'expected_version':v} for cid,v in targets]})

def test_atomic_and_stale(client,auth_headers_a,collection,db_session):
    a,b,c,_=collection
    before=db_session.get(Card,a).study_progress[0].next_review
    assert batch(client,auth_headers_a,'suspend',[(a,0),(b,2),(c,0)]).json()=={'updated':3}
    assert search(client,auth_headers_a,'is:suspended')=={a,b,c}
    assert batch(client,auth_headers_a,'unsuspend',[(a,1),(b,2)]).status_code==409
    db_session.expire_all()
    assert db_session.get(SchedulerState,a).version==1
    assert search(client,auth_headers_a,'is:suspended')=={a,b,c}
    assert db_session.get(Card,a).study_progress[0].next_review==before
    assert batch(client,auth_headers_a,'unsuspend',[(a,1),(b,3),(c,1)]).status_code==200
    assert client.post(f'/api/study/{c}/review',headers=auth_headers_a,json={'rating':3,'expected_version':1}).status_code==409

def test_bury_ownership(client,auth_headers_a,collection,db_session):
    a,b,c,foreign=collection
    assert batch(client,auth_headers_a,'bury',[(a,0),(foreign,0)]).status_code==404
    assert db_session.get(SchedulerState,a) is None
    assert batch(client,auth_headers_a,'bury',[(a,0),(c,0)]).status_code==200
    assert search(client,auth_headers_a,'is:buried')=={a,b,c}
    assert batch(client,auth_headers_a,'unbury',[(a,1),(c,1)]).status_code==200
    assert search(client,auth_headers_a,'is:buried')=={b}
    assert batch(client,auth_headers_a,'bury',[(a,2),(a,2)]).status_code==422
    assert batch(client,auth_headers_a,'bury',[]).status_code==422

def test_expired_and_sql_literal(client,auth_headers_a,collection,db_session):
    _,b,c,_=collection
    state=db_session.get(SchedulerState,b);state.buried_until=datetime.now(timezone.utc)-timedelta(seconds=1);db_session.commit()
    assert search(client,auth_headers_a,'is:buried')==set()
    assert search(client,auth_headers_a,'%')=={c}

def test_native_anki_search_golden(client,auth_headers_a,collection,tmp_path):
    from anki.collection import Collection
    native=Collection(str(tmp_path/'browser-reference.anki2'))
    try:
        native_ids=[]
        for deck,front,tags in [('French Words','dog cat',['animal::mammal']),
                                ('French Words::Verbs','dog mouse',['animalistic']),
                                ('Other','100% literal* a_b',[])]:
            note=native.new_note(native.models.by_name('Basic'))
            note.fields=[front,'answer'];note.tags=tags
            native.add_note(note,native.decks.id(deck))
            native_ids.append(native.find_cards(f'nid:{note.id}')[0])
        for query in ['dog cat','dog OR literal*','dog (cat or mouse)','dog -cat','-(cat OR mouse)',
                      '"dog cat"','deck:"French Words"','"deck:French Words" -deck:*::Verbs',
                      'tag:animal','tag:ani*','tag:none','-tag:animal','100%',r'literal\*',r'a\_b',
                      'note:Basic','dog AND mouse OR 100%']:
            expected={collection[native_ids.index(cid)] for cid in native.find_cards(query)}
            assert search(client,auth_headers_a,query)==expected,query
    finally:
        native.close()


def test_batch_bounds_and_strict_versions(client,auth_headers_a):
    for targets in [ [{'card_id':1,'expected_version':0}]*501,
                     [{'card_id':1,'expected_version':'0'}],
                     [{'card_id':True,'expected_version':0}],
                     [{'card_id':1}], [{'card_id':2**64,'expected_version':0}], ]:
        assert client.post('/api/cards/bulk-action',headers=auth_headers_a,json={'action':'bury','cards':targets}).status_code==422

def test_browser_edit_uses_version_and_rolls_back_stale_text(client,auth_headers_a,db_session):
    deck=client.post('/api/decks',headers=auth_headers_a,json={'name':'Editing'}).json()['id']
    card=client.post(f'/api/decks/{deck}/cards',headers=auth_headers_a,json={'front':'original','back':'answer'}).json()['id']
    url=f'/api/cards/{card}'
    first=client.put(url,headers=auth_headers_a,json={'front':'newer edit','expected_version':0})
    assert first.status_code==200,first.text
    stale=client.put(url,headers=auth_headers_a,json={'front':'stale edit','expected_version':0})
    assert stale.status_code==409,stale.text
    db_session.expire_all()
    saved=db_session.get(Card,card)
    assert saved.front=='newer edit'
    assert json.loads(saved.note_link.note.fields_json)[0]=='newer edit'
    assert saved.scheduling.version==1
    assert batch(client,auth_headers_a,'suspend',[(card,0)]).status_code==409
    assert batch(client,auth_headers_a,'suspend',[(card,1)]).status_code==200

def test_move_preserves_note_and_schedule_and_checks_destination(client,auth_headers_a,collection,db_session):
    a,b,c,foreign=collection
    destination=db_session.get(Card,c).deck_id
    foreign_deck=db_session.get(Card,foreign).deck_id
    original=db_session.get(Card,a)
    note_id=original.note_link.note_id
    progress=original.study_progress[0]
    due=progress.next_review
    def move(target,versions):
        return client.post('/api/cards/bulk-action',headers=auth_headers_a,json={'action':'move','target_deck_id':target,
            'cards':[{'card_id':cid,'expected_version':v} for cid,v in versions]})
    assert move(foreign_deck,[(a,0)]).status_code==404
    assert move(destination,[(a,0),(b,0)]).status_code==409
    db_session.expire_all()
    assert db_session.get(Card,a).deck_id!=destination
    assert move(destination,[(a,0),(b,2)]).status_code==200
    db_session.expire_all()
    moved=db_session.get(Card,a)
    assert moved.deck_id==destination
    assert moved.note_link.note_id==note_id
    assert moved.study_progress[0].next_review==due
    assert moved.study_progress[0].is_suspended
    assert moved.scheduling.version==1
    assert db_session.get(Card,b).scheduling.buried_until is not None
    assert search(client,auth_headers_a,'deck:Other')=={a,b,c}
    assert batch(client,auth_headers_a,'move',[(a,1)]).status_code==422
    assert client.post('/api/cards/bulk-action',headers=auth_headers_a,json={'action':'bury','target_deck_id':destination,
        'cards':[{'card_id':a,'expected_version':1}]}).status_code==422

def test_pagination_is_ordered_and_never_leaks_foreign_cards(client,auth_headers_a,collection,db_session):
    a,b,c,foreign=collection
    same=datetime(2026,1,1)
    for cid in collection:
        db_session.get(Card,cid).created_at=same
    db_session.commit()
    def page(offset):
        r=client.get('/api/cards/browse',headers=auth_headers_a,params={'search':'','offset':offset,'limit':2})
        assert r.status_code==200,r.text
        return [row['id'] for row in r.json()]
    assert page(0)==[c,b]
    assert page(2)==[a]
    assert page(4)==[]
    for params in [{'offset':-1},{'limit':1001},{'limit':0},{'offset':2**64}]:
        assert client.get('/api/cards/browse',headers=auth_headers_a,params=params).status_code==422


def test_browser_can_page_beyond_first_thousand(client,auth_headers_a,db_session):
    did=client.post('/api/decks',headers=auth_headers_a,json={'name':'Large'}).json()['id']
    db_session.add_all([Card(deck_id=did,front=f'card {i}',back='answer',created_at=datetime(2026,1,1)) for i in range(1001)])
    db_session.commit()
    first=client.get('/api/cards/browse',headers=auth_headers_a).json()
    second=client.get('/api/cards/browse',headers=auth_headers_a,params={'offset':1000}).json()
    assert len(first)==1000 and len(second)==1
    assert not {r['id'] for r in first}&{r['id'] for r in second}
    assert db_session.query(Note).count()==0

def test_property_search_matches_native_and_handles_missing_progress(client,auth_headers_a,collection,db_session,tmp_path):
    from anki.collection import Collection
    a,b,c,_=collection
    p=db_session.get(Card,a).study_progress[0]
    p.interval_days=12;p.repetitions=5;p.lapse_count=2
    db_session.commit()
    native=Collection(str(tmp_path/'properties.anki2'))
    try:
        mapping={}
        for index,cid in enumerate((a,b,c)):
            note=native.new_note(native.models.by_name('Basic'));note.fields=[str(index),'answer'];native.add_note(note,1)
            card=native.get_card(native.find_cards(f'nid:{note.id}')[0]);mapping[card.id]=cid
            if index==0:
                card.ivl=12;card.reps=5;card.lapses=2;native.update_card(card)
        for query in ['prop:ivl>=10','prop:ivl<10','prop:reps=0','prop:reps!=5','prop:lapses>1',
                      'prop:lapses<=0','-prop:reps=5','prop:ivl>0 prop:reps<=5']:
            assert search(client,auth_headers_a,query)=={mapping[cid] for cid in native.find_cards(query)},query
    finally:
        native.close()
    for query in ['prop:ivl=1.5','prop:ivl>-1','prop:due=0','prop:ivl>999999999999999999999999','prop:ivl=1 OR 1=1']:
        response=client.get('/api/cards/browse',headers=auth_headers_a,params={'search':query})
        # Last expression treats 1=1 as literal text, never as executable SQL.
        if query.endswith('OR 1=1'):
            assert response.status_code==200 and response.json()==[]
        else:
            assert response.status_code==422,response.text
