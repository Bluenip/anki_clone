"""Queue ordering/limits are separate from interval calculation."""
from datetime import datetime, timedelta, timezone
import hashlib
import json
from sqlalchemy.orm import joinedload
from models import Card, Deck, NoteCard, ReviewLog, StudyProgress
from scheduling import study_day, next_study_day, utc
from sm2 import parse_settings_to_config


def config_for(deck, now=None):
    try:
        from deck_options import effective_settings
        settings = effective_settings(deck, now)
    except (ValueError, TypeError):
        settings = {}
    return parse_settings_to_config(settings if isinstance(settings, dict) else {})


def interday(progress, config, now):
    if not progress or progress.card_state not in ('learning','relearning'):
        return False
    if progress.last_reviewed:
        return utc(progress.next_review) >= next_study_day(utc(progress.last_reviewed),config)
    if progress.card.package_data:
        return json.loads(progress.card.package_data.payload).get('queue') == 3
    return False


def snapshot(db, selected, user_id, now):
    owned = db.query(Deck).filter_by(user_id=user_id).all()
    scope = [d for d in owned if d.id == selected.id or d.name.startswith(selected.name+'::')]
    ids = [d.id for d in scope]
    configs = {d.id:config_for(d,now) for d in owned}
    config = configs[selected.id]
    cards = (db.query(Card).filter(Card.deck_id.in_(ids), ~Card.filtered_item.has())
             .options(joinedload(Card.scheduling), joinedload(Card.deck), joinedload(Card.note_link).joinedload(NoteCard.note)).all())
    progress = {p.card_id:p for p in db.query(StudyProgress).filter(StudyProgress.user_id == user_id, StudyProgress.card_id.in_([c.id for c in cards]))}
    # Include ancestor history if Limits start from top is enabled.
    quota_scope = [d for d in owned if d in scope or (config.limits_start_from_top and selected.name.startswith(d.name+'::'))]
    starts = {d.id:study_day(now,configs[d.id]) for d in quota_scope}
    earliest = min(starts.values())
    logs = (db.query(ReviewLog,Card.deck_id).join(Card).join(Deck).filter(ReviewLog.user_id==user_id,Deck.user_id==user_id,ReviewLog.review_date>=earliest)
            .options(joinedload(ReviewLog.record)).all())
    used = {}
    for quota in quota_scope:
        children = {d.id for d in owned if d.id==quota.id or d.name.startswith(quota.name+'::')}
        new, review = set(), set()
        for log, did in logs:
            if did not in children or utc(log.review_date) < starts[quota.id]:
                continue
            if log.was_new:
                new.add(log.card_id)
            else:
                data = json.loads(log.record.payload) if log.record else {}
                if data.get('kind') in ('review','interday','imported') or not data:
                    review.add(log.card_id)
        used[quota.id]=(len(new),len(review))
    by_name={d.name:d for d in owned}
    def quota_ids(card):
        applicable = {selected.id,card.deck_id}
        if config.limits_start_from_top:
            parts=card.deck.name.split('::')
            applicable.update(by_name['::'.join(parts[:i])].id for i in range(1,len(parts)) if '::'.join(parts[:i]) in by_name)
        return applicable
    def remaining(card):
        applicable = quota_ids(card)
        new_limit=review_limit=999999
        for did in applicable:
            cfg=configs[did]
            new_used,review_used=used.get(did,(0,0))
            nr=max(0,cfg.new_cards_per_day-new_used)
            rr=max(0,cfg.maximum_reviews_per_day-review_used-(0 if cfg.new_cards_ignore_review_limit else new_used))
            new_limit=min(new_limit,nr if cfg.new_cards_ignore_review_limit else min(nr,rr))
            review_limit=min(review_limit,rr)
        return new_limit,review_limit
    learning, reviews, news, waiting=[],[],[],[]
    for card in cards:
        p=progress.get(card.id)
        if (p and p.is_suspended) or (card.scheduling and card.scheduling.buried_until and utc(card.scheduling.buried_until)>now):
            continue
        new_remaining,review_remaining=remaining(card)
        if p is None or p.card_state=='new':
            if new_remaining>0:news.append(card)
        elif p.card_state in ('learning','relearning'):
            if utc(p.next_review)<=now:
                if interday(p,configs[card.deck_id],now):
                    if review_remaining>0:reviews.append(card)
                else:learning.append(card)
            else:waiting.append(card)
        elif p.card_state=='review' and utc(p.next_review)<=now and review_remaining>0:
            reviews.append(card)
    day=study_day(now,config).isoformat()
    def random_key(card):
        return hashlib.sha256(f'{user_id}:{day}:{card.id}'.encode()).hexdigest()
    def note_key(card):
        nid=card.note_link.note_id if card.note_link else card.id
        return hashlib.sha256(f'{user_id}:{day}:note:{nid}'.encode()).hexdigest()
    def ordinal(card):return card.note_link.template_ord if card.note_link else 0
    gather=config.new_card_gather_order
    if gather in ('Random cards','Random'):news.sort(key=random_key)
    elif gather=='Random notes':news.sort(key=lambda c:(note_key(c),ordinal(c)))
    elif gather=='Deck, then random notes':news.sort(key=lambda c:(c.deck.name,note_key(c),ordinal(c)))
    elif gather=='Descending position':news.sort(key=lambda c:-c.id)
    elif gather=='Ascending position':news.sort(key=lambda c:c.id)
    else:news.sort(key=lambda c:(c.deck.name,c.created_at,c.id))
    if config.insertion_order=='Random' and gather=='Deck':news.sort(key=note_key)
    if config.new_card_sort_order=='Random':news.sort(key=random_key)
    elif config.new_card_sort_order=='Card type, then order gathered':news.sort(key=ordinal)
    elif config.new_card_sort_order=='Card type, then random':news.sort(key=lambda c:(ordinal(c),random_key(c)))
    elif config.new_card_sort_order=='Random note, then card type':news.sort(key=lambda c:(note_key(c),ordinal(c)))
    order=config.review_sort_order
    if order=='Random':reviews.sort(key=random_key)
    elif order in ('Ascending intervals','Descending intervals'):reviews.sort(key=lambda c:progress[c.id].interval_days,reverse=order.startswith('Descending'))
    elif order in ('Ascending ease','Descending ease'):reviews.sort(key=lambda c:progress[c.id].ease_factor,reverse=order.startswith('Descending'))
    elif order=='Deck, then due date':reviews.sort(key=lambda c:(c.deck.name,progress[c.id].next_review,random_key(c)))
    elif order=='Due date, then deck':reviews.sort(key=lambda c:(progress[c.id].next_review,c.deck.name,c.id))
    elif order=='Relative overdueness':reviews.sort(key=lambda c:(now-utc(progress[c.id].next_review)).total_seconds()/max(1,progress[c.id].interval_days),reverse=True)
    else:reviews.sort(key=lambda c:(progress[c.id].next_review,random_key(c)))
    learning.sort(key=lambda c:progress[c.id].next_review)
    waiting.sort(key=lambda c:progress[c.id].next_review)
    inter=[c for c in reviews if progress[c.id].card_state in ('learning','relearning')]
    regular=[c for c in reviews if c not in inter]
    if config.interday_learning_review_order=='Show before reviews':reviews=inter+regular
    elif config.interday_learning_review_order=='Show after reviews':reviews=regular+inter
    # Count and select only cards that fit every applicable deck quota. A
    # parent's larger allowance must not inflate a child's smaller allowance.
    def limited(items, is_new):
        def capacity(did):
            cfg = configs[did]
            new_used, review_used = used.get(did, (0, 0))
            review_left = cfg.maximum_reviews_per_day - review_used
            if not cfg.new_cards_ignore_review_limit:
                review_left -= new_used
            if not is_new:
                return max(0, review_left)
            new_left = cfg.new_cards_per_day - new_used
            return max(0, new_left if cfg.new_cards_ignore_review_limit else min(new_left, review_left))
        allocated = {}
        result = []
        for item in items:
            quotas = quota_ids(item)
            if any(allocated.get(did, 0) >= capacity(did) for did in quotas):
                continue
            result.append(item)
            for did in quotas:allocated[did]=allocated.get(did,0)+1
        return result
    news=limited(news, True)
    reviews=limited(reviews, False)
    candidates=learning[:1]
    if not candidates:
        if news and (not reviews or config.new_review_order=='Show before reviews'):
            candidates=news[:1]
        elif reviews and (not news or config.new_review_order=='Show after reviews'):
            candidates=reviews[:1]
        elif news and reviews:
            count=sum(used.get(selected.id,(0,0)))
            choose_new=int(hashlib.sha256(f'{day}:{selected.id}:{count}'.encode()).hexdigest(),16)%(len(news)+len(reviews))<len(news)
            candidates=(news if choose_new else reviews)[:1]
        elif waiting and config.learning_ahead_seconds and utc(progress[waiting[0].id].next_review)<=now+timedelta(seconds=config.learning_ahead_seconds):
            candidates=waiting[:1]
    nr,rr=used.get(selected.id,(0,0))
    max_new=max(0,config.new_cards_per_day-nr)
    max_review=max(0,config.maximum_reviews_per_day-rr-(0 if config.new_cards_ignore_review_limit else nr))
    if not config.new_cards_ignore_review_limit:max_new=min(max_new,max_review)
    interday_count=sum(progress[c.id].card_state in ('learning','relearning') for c in reviews)
    return {'card':candidates[0] if candidates else None,'progress':progress,'config':config,'cards':cards,
            'eligible_ids': {c.id for c in learning+news+reviews+candidates},
            'new_cards':min(len(news),max_new),'due_cards':len(reviews)-interday_count,
            'learn_cards':len(learning)+len(waiting)+interday_count,
            'next_learning_at':progress[waiting[0].id].next_review if waiting else None}
