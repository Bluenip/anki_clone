import json
from datetime import datetime, timedelta, timezone
from models import Deck, StudyProgress
from study_queue import config_for


def make_deck(client,headers,name):
    return client.post('/api/decks',headers=headers,json={'name':name}).json()['id']


def make_preset(client,headers,settings=None):
    response=client.post('/api/options/presets',headers=headers,json={'name':'Shared','settings':json.dumps(settings or {'new_cards_per_day':5,'future_unknown':'keep'})})
    assert response.status_code==201,response.text
    return response.json()


def test_shared_settings_change_all_bound_decks_without_rescheduling(client,auth_headers_a,db_session):
    a=make_deck(client,auth_headers_a,'A');b=make_deck(client,auth_headers_a,'B')
    card=client.post(f'/api/decks/{a}/cards',headers=auth_headers_a,json={'front':'Q','back':'A'}).json()['id']
    client.post(f'/api/study/{card}/review',headers=auth_headers_a,json={'rating':4})
    progress=db_session.query(StudyProgress).one()
    before=(progress.next_review,progress.interval_days,progress.repetitions)
    preset=make_preset(client,auth_headers_a)
    for did in (a,b):
        bound=client.put(f'/api/decks/{did}/options/preset',headers=auth_headers_a,json={'preset_id':preset['id']})
        assert bound.status_code==200,bound.text
    body={'settings':json.dumps({'new_cards_per_day':9,'future_unknown':'keep','fsrs':True}),'expected_version':0}
    changed=client.put(f'/api/decks/{a}/options',headers=auth_headers_a,json=body)
    assert changed.status_code==200,changed.text
    assert changed.json()['preset_version']==1
    assert set(changed.json()['presets'][0]['used_by'])=={a,b}
    other=client.get(f'/api/decks/{b}/options',headers=auth_headers_a).json()
    assert json.loads(other['settings'])['new_cards_per_day']==9
    assert json.loads(other['settings'])['future_unknown']=='keep'
    db_session.refresh(progress)
    assert (progress.next_review,progress.interval_days,progress.repetitions)==before
    stale=client.put(f'/api/decks/{b}/options',headers=auth_headers_a,json={**body,'settings':'{"new_cards_per_day":1}'})
    assert stale.status_code==409
    assert config_for(db_session.get(Deck,b)).new_cards_per_day==9


def test_today_limit_expires_and_clear_restores_deck_then_preset(client,auth_headers_a,db_session):
    did=make_deck(client,auth_headers_a,'Limits')
    preset=make_preset(client,auth_headers_a,{'new_cards_per_day':5,'timezone':'America/New_York','day_starts_at':4})
    client.put(f'/api/decks/{did}/options/preset',headers=auth_headers_a,json={'preset_id':preset['id']})
    url=f'/api/decks/{did}/options/limits'
    for scope,value in [('deck',3),('today',0)]:
        result=client.put(url,headers=auth_headers_a,json={'scope':scope,'new_cards_per_day':value})
        assert result.status_code==200,result.text
    deck=db_session.get(Deck,did)
    assert config_for(deck).new_cards_per_day==0
    assert config_for(deck,datetime.now(timezone.utc)+timedelta(days=2)).new_cards_per_day==3
    client.put(url,headers=auth_headers_a,json={'scope':'today','new_cards_per_day':None})
    assert config_for(deck).new_cards_per_day==3
    client.put(url,headers=auth_headers_a,json={'scope':'deck','new_cards_per_day':None})
    assert config_for(deck).new_cards_per_day==5


def test_preset_ownership_detach_and_safe_delete(client,auth_headers_a,auth_headers_b,db_session):
    did=make_deck(client,auth_headers_a,'Own')
    other=make_deck(client,auth_headers_b,'Other')
    preset=make_preset(client,auth_headers_a)
    assert client.put(f'/api/decks/{other}/options/preset',headers=auth_headers_b,json={'preset_id':preset['id']}).status_code==404
    assert client.get(f'/api/decks/{did}/options',headers=auth_headers_b).status_code==404
    client.put(f'/api/decks/{did}/options/preset',headers=auth_headers_a,json={'preset_id':preset['id']})
    assert client.delete(f"/api/options/presets/{preset['id']}",headers=auth_headers_a).status_code==409
    assert client.put(f'/api/decks/{did}',headers=auth_headers_a,json={'settings':'{}'}).status_code==409
    detached=client.put(f'/api/decks/{did}/options/preset',headers=auth_headers_a,json={'preset_id':None})
    assert detached.status_code==200,detached.text
    assert detached.json()['preset_id'] is None
    assert config_for(db_session.get(Deck,did)).new_cards_per_day==5
    assert client.delete(f"/api/options/presets/{preset['id']}",headers=auth_headers_a).status_code==204


def test_limits_validate_and_zero_reaches_queue(client,auth_headers_a):
    did=make_deck(client,auth_headers_a,'Zero')
    client.post(f'/api/decks/{did}/cards',headers=auth_headers_a,json={'front':'Q','back':'A'})
    url=f'/api/decks/{did}/options/limits'
    for value in (-1,1.2,True):
        assert client.put(url,headers=auth_headers_a,json={'scope':'today','new_cards_per_day':value}).status_code==422
    assert client.put(url,headers=auth_headers_a,json={'scope':'today','new_cards_per_day':0}).status_code==200
    assert client.get(f'/api/study/{did}',headers=auth_headers_a).json() is None
    assert client.get(f'/api/decks/{did}',headers=auth_headers_a).json()['new_cards']==0


def test_collection_exchange_preserves_shared_preset_and_per_deck_limit(client,auth_headers_a,auth_headers_b):
    preset=make_preset(client,auth_headers_a)
    for name in ('Shared A','Shared B'):
        did=make_deck(client,auth_headers_a,name)
        client.post(f'/api/decks/{did}/cards',headers=auth_headers_a,json={'front':name,'back':'A'})
        client.put(f'/api/decks/{did}/options/preset',headers=auth_headers_a,json={'preset_id':preset['id']})
        if name=='Shared B':
            client.put(f'/api/decks/{did}/options/limits',headers=auth_headers_a,json={'scope':'deck','new_cards_per_day':2})
    exported=client.get('/api/apkg/export-collection',headers=auth_headers_a)
    assert exported.status_code==200,exported.text[:500]
    imported=client.post('/api/apkg/import?collection_restore=true',headers=auth_headers_b,files={'file':('presets.colpkg',exported.content)})
    assert imported.status_code==200,imported.text
    decks=client.get('/api/decks',headers=auth_headers_b).json()
    options={d['name']:client.get(f"/api/decks/{d['id']}/options",headers=auth_headers_b).json() for d in decks if d['name'].startswith('Shared ')}
    assert options['Shared A']['preset_id']==options['Shared B']['preset_id']
    assert json.loads(options['Shared A']['settings'])['new_cards_per_day']==5
    assert json.loads(options['Shared B']['settings'])['new_cards_per_day']==2
