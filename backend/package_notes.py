"""Preserve Anki note/model/card identity inside validated legacy APKG imports."""
from datetime import datetime, timezone
import hashlib
import json
from models import Card, Deck, Note, NoteCard, NoteType, OptionPreset, DeckOptionsBinding, PackageDeck, PackageModel, PackageNote, PackageCard, ReviewLog, ReviewRecord, StudyProgress, SchedulerState
from note_service import BUILTINS, builtin_model
from note_rendering import render_cards


def import_rows(cursor, collection, user_id, db, include_scheduling=True, whole_collection=False, duplicate_policy='newer', progress=None):
    from apkg_handler import map_anki_state_to_app, parse_anki_due, convert_ease_factor
    deck_definitions = json.loads(collection['decks'])
    model_definitions = json.loads(collection['models'])
    source_configs = json.loads(collection['dconf']) if 'dconf' in collection.keys() else {}
    from import_config import MAX_NOTES
    def checkpoint(stage, index, total):
        if progress and index % 100 == 0:
            progress(stage, index, total)
    source_cards = [dict(row) for row in cursor.execute('SELECT * FROM cards')]
    source_notes = {row['id']: dict(row) for row in cursor.execute('SELECT * FROM notes')}
    if len(source_notes) > MAX_NOTES:
        raise ValueError('Note count exceeds maximum limit')
    used_decks = {str(row['did']) for row in source_cards}
    used_models = {str(source_notes[row['nid']]['mid']) for row in source_cards if row['nid'] in source_notes}
    active_models = set(used_models)
    if whole_collection:
        used_decks.update(deck_definitions)
        used_models.update(model_definitions)
    # Validate models and every rendered ordinal before creating records.
    models = {}
    for mid in used_models:
        raw = model_definitions.get(mid)
        if raw is None and not model_definitions:
            definition = BUILTINS['basic']
            raw = {'name': definition['name'], 'flds':[{'name':n,'ord':i} for i,n in enumerate(definition['fields'])],
                   'tmpls':definition['templates'], 'type':0, 'css':''}
        if not isinstance(raw, dict):
            raise ValueError('A referenced note type is missing')
        from image_occlusion import is_occlusion
        if mid in active_models and (raw.get('originalStockKind') == 6 or 'image-occlusion' in raw.get('css', '').lower()) and not is_occlusion(raw.get('tmpls', [])):
            raise ValueError('Unsupported Image Occlusion template; import was cancelled without changes')
        fields = [f['name'] for f in raw.get('flds', [])]
        templates = raw.get('tmpls', [])
        if not fields or len(fields) > 100 or len(set(fields)) != len(fields) or not templates or len(templates) > 100:
            raise ValueError('Invalid note type fields/templates')
        model = NoteType(name=str(raw['name'])[:255], fields_json=json.dumps(fields),
                         templates_json=json.dumps(templates), css=raw.get('css', ''))
        models[mid] = (model, raw)
    groups = {}
    for row in source_cards:
        if row['nid'] not in source_notes:
            raise ValueError('Card references a missing note')
        groups.setdefault(row['nid'], []).append(row)
    planned = []
    if whole_collection and len(groups)!=len(source_notes):
        raise ValueError('Collection contains notes without cards; this restore cannot preserve them yet')
    seen_guids = set()
    for index, (nid, rows) in enumerate(groups.items()):
        checkpoint('checking_templates', index, len(groups))
        raw = source_notes[nid]
        guid = raw['guid']
        if not isinstance(guid, str) or not 1 <= len(guid) <= 100 or guid in seen_guids:
            raise ValueError('Missing, invalid or repeated note GUID')
        seen_guids.add(guid)
        model, _ = models[str(raw['mid'])]
        values = raw['flds'].split('\x1f')
        if any(len(v) > 50000 for v in values) or sum(len(v) for v in values) > 500000:
            raise ValueError('Note fields exceed supported limits')
        tags = raw.get('tags', '').split()
        try:
            rendered = render_cards(model, values, user_id, tags)
        except ValueError as exc:
            raise ValueError(f'Note type {model.name!r}, source note {nid}: {exc}') from None
        ordinals = [row['ord'] for row in rows]
        if len(set(ordinals)) != len(ordinals) or any(ordinal not in rendered for ordinal in ordinals):
            raise ValueError('Package card ordinals do not match supported templates/clozes')
        existing = db.query(Note).filter_by(user_id=user_id, guid=guid).first()
        if existing and duplicate_policy == 'add':
            from notes import new_guid
            raw = dict(raw, guid=new_guid())
            existing = None
        if existing and duplicate_policy != 'skip' and (json.loads(existing.note_type.fields_json) != json.loads(model.fields_json) or
                         json.loads(existing.note_type.templates_json) != json.loads(model.templates_json) or existing.note_type.css != model.css):
            raise ValueError('A note GUID exists with a different model; resolve the conflict before importing')
        planned.append((raw, rows, values, tags, existing))
    deck_map = {}
    preset_map = {}
    for did in used_decks:
        definition = deck_definitions.get(did)
        if not definition or not definition.get('name'):
            raise ValueError('A referenced deck is missing')
        name = definition['name']
        if len(name) > 255:
            raise ValueError('Deck name exceeds supported limits')
        deck = db.query(Deck).filter_by(user_id=user_id, name=name).first()
        if deck is None:
            from package_settings import import_config
            conf_id=str(definition.get('conf'))
            source_config=source_configs.get(conf_id,{})
            settings = import_config(source_config)
            settings['fsrs'] = bool(collection['_fsrs']) if '_fsrs' in collection.keys() else bool(json.loads(collection['conf']).get('fsrs',False)) if 'conf' in collection.keys() else False
            deck = Deck(user_id=user_id, name=name, description=definition.get('desc', ''), settings=json.dumps(settings))
            deck.package_data = PackageDeck(payload=json.dumps({'deck':definition, 'config':source_configs.get(str(definition.get('conf')), {})}))
            if source_config:
                if conf_id not in preset_map:
                    serialized=json.dumps(settings,sort_keys=True)
                    preset_name=str(source_config.get('name') or 'Imported')[:100]
                    preset=db.query(OptionPreset).filter_by(user_id=user_id,name=preset_name).first()
                    if preset and json.loads(preset.settings_json)!=settings:
                        suffix=hashlib.sha256(serialized.encode()).hexdigest()[:8]
                        preset_name=preset_name[:80]+' [import '+suffix+']'
                        preset=db.query(OptionPreset).filter_by(user_id=user_id,name=preset_name).first()
                    if preset and json.loads(preset.settings_json)!=settings:
                        raise ValueError('Imported preset name conflicts with existing settings')
                    if not preset:
                        preset=OptionPreset(user_id=user_id,name=preset_name,settings_json=serialized)
                        db.add(preset);db.flush()
                    preset_map[conf_id]=preset
                overrides={}
                for native,web in [('newLimit','new_cards_per_day'),('reviewLimit','maximum_reviews_per_day')]:
                    value=definition.get(native)
                    if value is not None:
                        if type(value) is not int or not 0<=value<=999999:raise ValueError('Invalid deck limit override')
                        overrides[web]=value
                deck.options_binding=DeckOptionsBinding(preset=preset_map[conf_id],overrides_json=json.dumps(overrides),today_json='{}')
            db.add(deck); db.flush()
        deck_map[did] = deck
    # Assign source models by structural identity, without overwriting local types.
    for mid, (model, raw) in list(models.items()):
        existing = db.query(NoteType).filter_by(user_id=user_id, name=model.name).first()
        if existing and (existing.fields_json != model.fields_json or existing.templates_json != model.templates_json or existing.css != model.css):
            fingerprint = hashlib.sha256(json.dumps(raw, sort_keys=True).encode()).hexdigest()[:10]
            model.name = model.name[:230] + ' [import ' + fingerprint + ']'
            existing = db.query(NoteType).filter_by(user_id=user_id, name=model.name).first()
        if existing and (existing.fields_json != model.fields_json or existing.templates_json != model.templates_json or existing.css != model.css):
            raise ValueError('Imported note type name conflicts with an existing definition')
        if existing is None:
            model.user_id = user_id
            db.add(model); db.flush()
            model.package_data = PackageModel(payload=json.dumps(raw))
        else:
            model = existing
        models[mid] = (model, raw)
    added = updated = skipped = 0
    imported_card_ids = {}
    for index, (raw, rows, values, tags, note) in enumerate(planned):
        checkpoint('importing_notes', index, len(planned))
        if note is not None and duplicate_policy == 'skip':
            skipped += len(rows); continue
        rendered = render_cards(models[str(raw['mid'])][0], values, user_id, tags)
        source_mod = datetime.fromtimestamp(raw.get('mod', 0), timezone.utc).replace(tzinfo=None)
        if note is None:
            note = Note(user_id=user_id, guid=raw['guid'], note_type=models[str(raw['mid'])][0],
                        fields_json=json.dumps(values, ensure_ascii=False), tags_json=json.dumps(tags), updated_at=source_mod)
            note.package_data = PackageNote(payload=json.dumps(dict(raw, _web_rendered=True)))
            db.add(note); db.flush()
        else:
            local_mod = note.updated_at.replace(tzinfo=None) if note.updated_at else datetime.min
            if note.package_data and raw.get('mod', 0) == json.loads(note.package_data.payload).get('mod') and values == json.loads(note.fields_json) and tags == json.loads(note.tags_json):
                skipped += len(rows)
                continue
            if duplicate_policy == 'newer' and source_mod <= local_mod:
                skipped += len(rows)
                continue
            note.fields_json, note.tags_json, note.updated_at = json.dumps(values, ensure_ascii=False), json.dumps(tags), source_mod
            if not note.package_data:
                note.package_data = PackageNote(payload=json.dumps(dict(raw, _web_rendered=True)))
            else:
                note.package_data.payload = json.dumps(dict(raw, _web_rendered=True))
        links = {link.template_ord: link for link in note.card_links}
        for row in rows:
            ordinal = row['ord']
            front, back = rendered[ordinal]
            if ordinal in links:
                card = links[ordinal].card
                from review_service import state_for, claim_version
                state_version = state_for(db, card)
                claim_version(db, state_version, state_version.version)
                card.front, card.back = front, back
                updated += 1
                # Content updates preserve the local deck and study progress.
            else:
                card = Card(deck_id=deck_map[str(row['did'])].id, front=front, back=back)
                db.add(card); db.flush()
                note.card_links.append(NoteCard(card=card, template_ord=ordinal))
                card.package_data = PackageCard(payload=json.dumps(row))
                atype, queue = row['type'], row['queue']
                state, suspended = map_anki_state_to_app(atype, queue)
                if include_scheduling and (state != 'new' or row['reps'] > 0 or suspended):
                    from study_queue import config_for
                    from scheduling import next_study_day
                    from sm2 import parse_steps
                    config = config_for(card.deck)
                    now = datetime.now(timezone.utc)
                    source_today = collection['_today'] if '_today' in collection.keys() else max(0, (int(now.timestamp())-collection['crt'])//86400)
                    due = next_study_day(now, config, row['due']-source_today) if queue in (2,3) or atype==2 else parse_anki_due(row['due'],queue,collection['crt'],atype)
                    steps = parse_steps(config.relearning_steps if state=='relearning' else config.learning_steps)
                    step = max(0, min(len(steps)-1, len(steps)-row['left']%1000)) if state in ('learning','relearning') and steps else 0
                    raw_memory=json.loads(row.get('data') or '{}')
                    last_reviewed=datetime.fromtimestamp(raw_memory['lrt'],timezone.utc) if raw_memory.get('lrt') else None
                    db.add(StudyProgress(user_id=user_id, card_id=card.id, card_state=state, is_suspended=suspended,
                        ease_factor=convert_ease_factor(row['factor']), interval_days=max(0, row['ivl']),
                        repetitions=row['reps'], lapse_count=row['lapses'], next_review=due, learning_step=step,
                        last_reviewed=last_reviewed))
                    if raw_memory.get('s') is not None and raw_memory.get('d') is not None and last_reviewed:
                        import math
                        from fsrs import Card as MemoryCard, State
                        from scheduling import ENGINE
                        stability,difficulty=raw_memory['s'],raw_memory['d']
                        if not all(isinstance(v,(float,int)) and math.isfinite(v) for v in (stability,difficulty)) or stability<=0 or not 1<=difficulty<=10:
                            raise ValueError('Invalid FSRS memory state in package')
                        memory=MemoryCard(card_id=card.id,state={'new':State.Learning,'learning':State.Learning,'relearning':State.Relearning,'review':State.Review}[state],
                            step=step if state!='review' else None, stability=stability,difficulty=difficulty,due=due,last_review=last_reviewed)
                        card.scheduling=SchedulerState(fsrs_json=json.dumps({'engine':ENGINE,'card':memory.to_dict(),'initialization':'imported_memory'}),version=0)
                if include_scheduling and queue in (-2,-3):
                    from scheduling import next_study_day
                    from study_queue import config_for
                    if not card.scheduling:card.scheduling=SchedulerState(version=0)
                    card.scheduling.buried_until=next_study_day(datetime.now(timezone.utc),config_for(card.deck))
                added += 1
                imported_card_ids[row['id']] = card.id
    if include_scheduling and cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='revlog'").fetchone():
        for source in cursor.execute('SELECT * FROM revlog'):
            raw = dict(source)
            if raw['cid'] not in imported_card_ids:
                continue
            if raw['ease'] not in (0,1,2,3,4):
                raise ValueError('Unsupported rating in package history')
            log = ReviewLog(user_id=user_id, card_id=imported_card_ids[raw['cid']], rating=raw['ease'],
                            was_new=raw.get('type') == 0, review_date=datetime.fromtimestamp(raw['id']/1000,timezone.utc))
            log.record = ReviewRecord(payload=json.dumps({'anki':raw, 'kind':'imported', 'duration_ms':raw.get('time',0)}))
            db.add(log)
    db.flush()
    if include_scheduling:
        from sqlalchemy import func
        for card_id, date in db.query(ReviewLog.card_id,func.max(ReviewLog.review_date)).filter(
                ReviewLog.card_id.in_(list(imported_card_ids.values())),ReviewLog.user_id==user_id,
                ReviewLog.rating.in_([1,2,3,4])).group_by(ReviewLog.card_id):
            progress=db.query(StudyProgress).filter_by(card_id=card_id,user_id=user_id).first()
            if progress and progress.last_reviewed is None:progress.last_reviewed=date
        db.flush()
    selected = next(iter(deck_map.values()), None)
    if selected is None:
        raise ValueError('Package contains no supported cards')
    return selected, added, updated, skipped
