import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import subprocess
import pytest
from models import Card, Deck, StudyProgress, ReviewLog, ReviewRecord
from collection_snapshot import capture, fingerprint
from scheduling import next_study_day
from sm2 import DeckSchedulingConfig


def make(client, headers, name='Source', front='Question', back='Answer'):
    deck = client.post('/api/decks', headers=headers, json={'name': name}).json()['id']
    note = client.post('/api/notes', headers=headers, json={'deck_id': deck, 'kind': 'basic', 'fields': {'Front': front, 'Back': back}}).json()
    return deck, note['cards'][0]['id']


@pytest.mark.parametrize('advanced', [False, True])
def test_text_match_scope_and_all_fields(client, auth_headers_a, db_session, advanced):
    first, cid = make(client, auth_headers_a)
    second = client.post('/api/decks', headers=auth_headers_a, json={'name': 'Destination'}).json()['id']
    body = {'text': 'Question\tChanged', 'duplicate_policy': 'update', 'match_scope': 'collection'}
    if advanced: body['kind'] = 'basic'
    result = client.post(f'/api/decks/{second}/import', headers=auth_headers_a, json=body)
    assert result.status_code == 200, result.text
    assert result.json()['updated'] == 1
    db_session.expire_all(); assert db_session.get(Card, cid).deck_id == first
    body.update(match_fields='all', duplicate_policy='skip')
    assert client.post(f'/api/decks/{second}/import', headers=auth_headers_a, json=body).json()['skipped'] == 1
    body['text'] = 'Question\tDifferent'
    assert client.post(f'/api/decks/{second}/import', headers=auth_headers_a, json=body).json()['added'] == 1


def test_advanced_search_dates_regex_due_and_ownership(client, auth_headers_a, auth_headers_b, db_session):
    deck, cid = make(client, auth_headers_a, front='abc123')
    _, foreign = make(client, auth_headers_b, front='abc123')
    now = datetime.now(timezone.utc)
    db_session.add(StudyProgress(card_id=cid, user_id=db_session.get(Card,cid).deck.user_id, card_state='review', next_review=next_study_day(now, DeckSchedulingConfig(), 3), interval_days=3))
    db_session.add(ReviewLog(card_id=cid, user_id=db_session.get(Card,cid).deck.user_id, rating=1, was_new=False, review_date=now))
    db_session.commit()
    for query in ['added:1', 'rated:1:1', 're:abc[0-9]+', 'Front:re:^abc', 'prop:due=3', 'prop:due<=3']:
        result = client.get('/api/cards/browse', headers=auth_headers_a, params={'search': query})
        assert result.status_code == 200, result.text
        assert {row['id'] for row in result.json()} == {cid}
    assert client.get('/api/cards/browse', headers=auth_headers_a, params={'search': 'prop:due<3'}).json() == []
    assert client.get('/api/cards/browse', headers=auth_headers_a, params={'search': 're:['}).status_code == 422


def test_regex_timeout_is_an_error_without_collection_changes(client, auth_headers_a, db_session, user_a, monkeypatch):
    make(client, auth_headers_a)
    before = fingerprint(capture(db_session, user_a.id))
    def timeout(*args, **kwargs): raise subprocess.TimeoutExpired('regex', 3)
    monkeypatch.setattr('search_advanced.subprocess.run', timeout)
    result = client.get('/api/cards/browse', headers=auth_headers_a, params={'search': 're:(a+)+$'})
    assert result.status_code == 422
    assert fingerprint(capture(db_session, user_a.id)) == before


def test_easy_days_and_load_balancing_prefer_available_day(client, auth_headers_a, db_session):
    from load_balancing import choose_interval
    from review_fuzz import fuzz_bounds
    deck, cid = make(client, auth_headers_a)
    card = db_session.get(Card, cid); now = datetime(2026,10,26,12,tzinfo=timezone.utc)
    cfg = DeckSchedulingConfig(easy_days={'Mon':0,'Tue':0,'Wed':0,'Thu':0,'Fri':100,'Sat':0,'Sun':0})
    interval = choose_interval(db_session, card, None, cfg, now, 5)
    low, high = fuzz_bounds(5)
    assert low <= interval <= high
    assert next_study_day(now,cfg,interval).weekday() == 4
    cfg = DeckSchedulingConfig(load_balancing=True)
    for i in range(10):
        other = Card(deck_id=deck,front=str(i),back='a'); db_session.add(other); db_session.flush()
        db_session.add(StudyProgress(card_id=other.id,user_id=card.deck.user_id,card_state='review',next_review=next_study_day(now,cfg,5)))
    db_session.commit()
    assert choose_interval(db_session,card,None,cfg,now,5) != 5


def test_imported_history_and_holdout_metrics(client, auth_headers_a, db_session):
    from fsrs_optimizer import training_items
    from fsrs_evaluation import metrics
    deck, cid = make(client,auth_headers_a)
    card = db_session.get(Card,cid); start=datetime(2026,1,1,tzinfo=timezone.utc)
    for day,rating,kind,last in [(0,1,0,0),(0,3,0,-60),(1,3,1,1),(5,1,1,4)]:
        log=ReviewLog(user_id=card.deck.user_id,card_id=cid,rating=rating,was_new=kind==0,review_date=start+timedelta(days=day))
        log.record=ReviewRecord(payload=json.dumps({'kind':'imported','anki':{'type':kind,'lastIvl':last}}));db_session.add(log)
    db_session.commit()
    items, count=training_items(db_session,card.deck.user_id,[card.deck],start+timedelta(days=6))
    assert count==4 and len(items)==2 and len(items[-1])==4
    result=metrics(items,None)
    assert result['samples']==2 and result['observed_recall']==.5
    assert 0 < result['log_loss'] < 10 and 0 <= result['brier_score'] <= 1


def test_multiple_filters_and_today_limits(client,auth_headers_a):
    deck,cid=make(client,auth_headers_a)
    body={'name':'Multiple','search':'is:new','limit':1,'filters':[{'search':'is:new','limit':1,'order':'oldest'}]}
    result=client.post('/api/filtered',headers=auth_headers_a,json=body)
    assert result.status_code in (200,201),result.text
    assert result.json()['remaining']==1
    increased=client.post(f'/api/decks/{deck}/options/extra-today',headers=auth_headers_a,json={'kind':'new','count':7})
    assert increased.status_code==200,increased.text
    assert json.loads(increased.json()['settings'])['new_cards_per_day']==27
    second=client.post(f'/api/decks/{deck}/options/extra-today',headers=auth_headers_a,json={'kind':'review','count':5})
    settings=json.loads(second.json()['settings'])
    assert settings['maximum_reviews_per_day']==205 and settings['new_cards_per_day']==27


def test_native_latex_extraction_and_cached_media(tmp_path,monkeypatch):
    import latex_rendering as latex
    monkeypatch.setattr('media_utils.get_media_dir',lambda uid:str(tmp_path))
    calls=[]
    def compile(body,header,footer):
        calls.append(body);return b'\x89PNG\r\n\x1a\ncompiled'
    monkeypatch.setattr(latex,'compile_png',compile)
    source=r'[latex]\begin{tabular}{cc}A&B\\C&D\end{tabular}[/latex]'
    rendered=latex.render(source,1)
    assert '<img' in rendered and 'latex-' in rendered
    assert len(calls)==1 and list(tmp_path.glob('latex-*.png'))
    assert latex.render(source,1)==rendered and len(calls)==1


def test_real_latex_engine_when_installed():
    from latex_rendering import available,compile_png,HEADER,FOOTER
    if not available():pytest.skip('Server TeX toolchain is not installed in this host environment')
    image=compile_png(r'\begin{tabular}{cc}A&B\\C&D\end{tabular}',HEADER,FOOTER)
    assert image.startswith(b'\x89PNG')


def test_package_media_collision_renaming_and_duplicate_policies(client,auth_headers_a,auth_headers_b,db_session,user_a,user_b,tmp_path,monkeypatch):
    from media_utils import get_media_dir
    monkeypatch.setattr('media_utils.MEDIA_BASE',str(tmp_path/'media'))
    monkeypatch.setattr('apkg_handler.MEDIA_BASE',str(tmp_path/'media'))
    source_dir=Path(get_media_dir(user_a.id));source_dir.mkdir(parents=True)
    (source_dir/'same.png').write_bytes(b'original image bytes')
    deck,cid=make(client,auth_headers_a,front='<img src="same.png">')
    package=client.get(f'/api/apkg/export/{deck}',headers=auth_headers_a).content
    target_dir=Path(get_media_dir(user_b.id));target_dir.mkdir(parents=True)
    (target_dir/'same.png').write_bytes(b'existing unrelated bytes')
    result=client.post('/api/apkg/import?media_conflicts=rename',headers=auth_headers_b,files={'file':('collision.apkg',package)})
    assert result.status_code==200,result.text
    assert (target_dir/'same.png').read_bytes()==b'existing unrelated bytes'
    renamed=list(target_dir.glob('import-*.png'));assert len(renamed)==1 and renamed[0].read_bytes()==b'original image bytes'
    cards=db_session.query(Card).join(Deck).filter(Deck.user_id==user_b.id).all()
    assert len(cards)==1 and renamed[0].name in cards[0].front
    skipped=client.post('/api/apkg/import?media_conflicts=rename&duplicate_policy=skip',headers=auth_headers_b,files={'file':('collision.apkg',package)})
    assert skipped.status_code==200,skipped.text
    assert db_session.query(Card).join(Deck).filter(Deck.user_id==user_b.id).count()==1
    added=client.post('/api/apkg/import?media_conflicts=rename&duplicate_policy=add',headers=auth_headers_b,files={'file':('collision.apkg',package)})
    assert added.status_code==200,added.text
    assert db_session.query(Card).join(Deck).filter(Deck.user_id==user_b.id).count()==2


def test_latex_sandbox_cannot_read_host_file(tmp_path):
    from latex_rendering import available,compile_png,HEADER,FOOTER
    if not available(): pytest.skip('Server TeX toolchain unavailable')
    secret=tmp_path/'private.tex';secret.write_text('PRIVATE-MARKER-DO-NOT-READ')
    with pytest.raises(ValueError) as error:
        compile_png('\\input{'+str(secret)+'}',HEADER,FOOTER)
    assert 'PRIVATE-MARKER-DO-NOT-READ' not in str(error.value)


def test_latex_note_renders_exports_and_restores(client,auth_headers_a,auth_headers_b,tmp_path,monkeypatch):
    from latex_rendering import available
    if not available(): pytest.skip('Server TeX toolchain unavailable')
    monkeypatch.setattr('media_utils.MEDIA_BASE',str(tmp_path/'latex-media'))
    monkeypatch.setattr('apkg_handler.MEDIA_BASE',str(tmp_path/'latex-media'))
    source=r'[latex]\begin{tabular}{cc}One&Two\\Three&Four\end{tabular}[/latex]'
    deck,cid=make(client,auth_headers_a,front=source)
    card=client.get(f'/api/decks/{deck}/cards',headers=auth_headers_a).json()[0]
    assert 'latex-' in card['front'] and '<img' in card['front']
    package=client.get(f'/api/apkg/export/{deck}',headers=auth_headers_a)
    result=client.post('/api/apkg/import',headers=auth_headers_b,files={'file':('latex.apkg',package.content)})
    assert result.status_code==200,result.text
    restored=client.get(f"/api/decks/{result.json()['deck_id']}/cards",headers=auth_headers_b).json()[0]
    assert 'latex-' in restored['front']


def test_native_svg_latex_type_preserves_svg_filename(tmp_path,monkeypatch):
    from types import SimpleNamespace
    import latex_rendering as latex
    if not latex.available(): pytest.skip('Server TeX toolchain unavailable')
    monkeypatch.setattr('media_utils.get_media_dir',lambda uid:str(tmp_path))
    model=SimpleNamespace(package_data=SimpleNamespace(payload='{"latexsvg":true}'))
    result=latex.render(r'[latex]SVG text[/latex]',1,model)
    assert '.svg' in result
    image=next(tmp_path.glob('latex-*.svg')).read_text()
    assert 'data:image/png;base64,' in image
    assert latex.render(r'[latex]SVG text[/latex]',1,model)==result
