from datetime import datetime, timezone, timedelta
from types import SimpleNamespace
from anki.collection import Collection
from early_review import intervals
from sm2 import DeckSchedulingConfig
from scheduling import next_study_day


def test_early_intervals_match_native(tmp_path):
    native=Collection(str(tmp_path/'early.anki2'))
    config=DeckSchedulingConfig(timezone='Asia/Ho_Chi_Minh',day_starts_at=4)
    now=datetime.now(timezone.utc)
    try:
        # Disable FSRS explicitly: this comparison covers Anki's early SM-2 branch.
        native.set_config('fsrs',False)
        for scheduled,remaining in [(10,9),(10,5),(10,1),(30,20),(1,1)]:
            n=native.new_note(native.models.by_name('Basic'));n.fields=[f'{scheduled}/{remaining}','a'];native.add_note(n,1)
            c=native.get_card(native.find_cards(f'nid:{n.id}')[0]);c.type=2;c.queue=2;c.ivl=scheduled;c.factor=2500;c.due=native.sched.today+remaining;native.update_card(c)
            fdid=native.decks.new_filtered(f'Early {scheduled}-{remaining}')
            fd=native.decks.get(fdid);fd['terms']=[[f'cid:{c.id}',100,0]];native.decks.update(fd)
            native.sched.rebuild_filtered_deck(fdid)
            states=native._backend.get_scheduling_states(c.id)
            expected={rating:getattr(states,label).normal.review.scheduled_days for rating,label in [(2,'hard'),(3,'good'),(4,'easy')]}
            progress=SimpleNamespace(card_state='review',next_review=next_study_day(now,config,remaining),interval_days=scheduled,ease_factor=2.5)
            assert intervals(progress,config,now)==expected,(scheduled,remaining,states)
    finally:native.close()
