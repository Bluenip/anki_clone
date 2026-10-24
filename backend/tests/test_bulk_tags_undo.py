import json
from models import Card, StudyProgress, SchedulerState
from test_review_events import setup_note


def test_sibling_tag_edit_prevents_old_review_undo(client,auth_headers_a,db_session):
    _,(first,second)=setup_note(client,auth_headers_a,{'fsrs':True},'reversed')
    reviewed=client.post(f'/api/study/{first}/review',headers=auth_headers_a,
        json={'rating':4,'expected_version':0,'request_id':'before-tags'})
    assert reviewed.status_code==200,reviewed.text
    card=db_session.get(Card,first)
    progress=db_session.query(StudyProgress).filter_by(card_id=first).one()
    due=progress.next_review
    memory=card.scheduling.fsrs_json
    response=client.post('/api/cards/bulk-action',headers=auth_headers_a,json={
        'action':'add_tags','cards':[{'card_id':second,'expected_version':0}],'tags':['Later']})
    assert response.status_code==200,response.text
    assert response.json()=={'updated':2,'updated_notes':1}
    undone=client.post('/api/study/undo/latest',headers=auth_headers_a)
    assert undone.status_code==409,undone.text
    db_session.expire_all()
    assert json.loads(db_session.get(Card,first).note_link.note.tags_json)==['Later']
    assert db_session.get(SchedulerState,first).fsrs_json==memory
    assert db_session.query(StudyProgress).filter_by(card_id=first).one().next_review==due


def test_selected_siblings_are_claimed_once_and_remove_includes_children(client,auth_headers_a,db_session):
    _,ids=setup_note(client,auth_headers_a,kind='reversed')
    def action(name,tags,version):
        return client.post('/api/cards/bulk-action',headers=auth_headers_a,json={
            'action':name,'cards':[{'card_id':cid,'expected_version':version} for cid in ids],'tags':tags})
    response=action('add_tags',['Parent','parent','Parent::Child'],0)
    assert response.status_code==200,response.text
    assert response.json()=={'updated':2,'updated_notes':1}
    db_session.expire_all()
    assert [db_session.get(SchedulerState,cid).version for cid in ids]==[1,1]
    assert json.loads(db_session.get(Card,ids[0]).note_link.note.tags_json)==['Parent','Parent::Child']
    assert action('remove_tags',['PARENT'],1).status_code==200
    db_session.expire_all()
    assert json.loads(db_session.get(Card,ids[0]).note_link.note.tags_json)==[]

def test_tag_case_and_hierarchy_match_native_anki(client,auth_headers_a,db_session,tmp_path):
    from anki.collection import Collection
    _,(cid,)=setup_note(client,auth_headers_a)
    native=Collection(str(tmp_path/'tag-reference.anki2'))
    try:
        note=native.new_note(native.models.by_name('Basic'));note.fields=['question','answer'];native.add_note(note,1)
        for version,(action,tags) in enumerate([
            ('add_tags',['Parent','parent','Parent::Child','Other']),
            ('add_tags',['PARENT','other','Parent::Child::Deep']),
            ('remove_tags',['pArEnT']),
        ]):
            response=client.post('/api/cards/bulk-action',headers=auth_headers_a,json={
                'action':action,'cards':[{'card_id':cid,'expected_version':version}],'tags':tags})
            assert response.status_code==200,response.text
            if action=='add_tags': native.tags.bulk_add([note.id],' '.join(tags))
            else: native.tags.bulk_remove([note.id],' '.join(tags))
            db_session.expire_all()
            actual=json.loads(db_session.get(Card,cid).note_link.note.tags_json)
            assert sorted(actual)==sorted(native.get_note(note.id).tags)
    finally:
        native.close()

def test_render_failure_rolls_back_metadata_created_for_legacy_card(client,auth_headers_a,db_session):
    from models import Note
    did=client.post('/api/decks',headers=auth_headers_a,json={'name':'Late failure'}).json()['id']
    legacy=Card(deck_id=did,front='legacy',back='answer')
    db_session.add(legacy);db_session.commit();legacy_id=legacy.id
    note=client.post('/api/notes',headers=auth_headers_a,json={'deck_id':did,'kind':'basic',
        'fields':{'Front':'question','Back':'answer'}}).json()
    bad_id=note['cards'][0]['id']
    model=db_session.get(Card,bad_id).note_link.note.note_type
    model.templates_json=json.dumps([{'name':'Card 1','qfmt':'{{Tags}}','afmt':'{{Front}}'}])
    db_session.commit()
    original_notes=db_session.query(Note).count()
    result=client.post('/api/cards/bulk-action',headers=auth_headers_a,json={'action':'add_tags','tags':['tag'],
        'cards':[{'card_id':legacy_id,'expected_version':0},{'card_id':bad_id,'expected_version':0}]})
    assert result.status_code==400,result.text
    db_session.expire_all()
    assert db_session.query(Note).count()==original_notes
    assert db_session.get(Card,legacy_id).note_link is None
    assert db_session.get(SchedulerState,legacy_id) is None
    assert db_session.get(SchedulerState,bad_id) is None
