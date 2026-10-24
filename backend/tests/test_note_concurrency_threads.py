from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from database import Base
from models import User, Deck, Note
from note_service import create_note, note_revision, lock_note_revision, update_note


def test_two_sqlite_connections_cannot_save_same_revision(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'concurrency.db'}", connect_args={'check_same_thread':False})
    Base.metadata.create_all(engine)
    try:
        with Session(engine) as db:
            user=User(email='race@example.com',username='race',password_hash='unused')
            db.add(user);db.flush()
            deck=Deck(user_id=user.id,name='Race');db.add(deck);db.flush()
            note=create_note(db,deck,'reversed',{'Front':'original','Back':'answer'},[])
            db.commit();nid=note.id;revision=note_revision(note)
        barrier=Barrier(2)
        def save(label):
            with Session(engine) as db:
                note=db.get(Note,nid)
                assert note_revision(note)==revision
                barrier.wait(timeout=5)
                try:
                    lock_note_revision(db,note,revision)
                    update_note(db,note,{'Front':label,'Back':'answer'},[label])
                    db.commit()
                    return 200,label
                except HTTPException as exc:
                    db.rollback()
                    return exc.status_code,label
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(save,['first','second']))
        assert sorted(code for code,_ in results)==[200,409]
        winner=next(label for code,label in results if code==200)
        with Session(engine) as db:
            note=db.get(Note,nid)
            assert winner in note.fields_json and winner in note.tags_json
            assert len(note.card_links)==2
            assert all(link.card.scheduling.version==1 for link in note.card_links)
    finally:
        engine.dispose()
