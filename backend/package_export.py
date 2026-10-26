"""Metadata-preserving legacy APKG writer; no writes to the live collection."""
import copy
from datetime import datetime, timezone
import hashlib
import html
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
from urllib.parse import unquote
import zipfile
from models import Deck, Card, NoteType, Note, StudyProgress, ReviewLog
from notes import card_guid
from media_utils import get_media_dir


def export_package(deck_id, user_id, include_scheduling, db):
    from apkg_handler import map_card_state_to_anki, compute_csum, strip_html
    from deck_options import effective_settings, base_settings
    root = db.query(Deck).filter_by(id=deck_id, user_id=user_id).first() if deck_id is not None else None
    if deck_id is not None and root is None:
        raise ValueError('Deck not found')
    decks = [d for d in db.query(Deck).filter_by(user_id=user_id) if root is None or d.id == root.id or d.name.startswith(root.name+'::')]
    cards = db.query(Card).filter(Card.deck_id.in_([d.id for d in decks])).order_by(Card.id).all()
    if deck_id is None and db.query(Note.id).filter(Note.user_id==user_id, ~Note.card_links.any()).first():
        raise ValueError('Collection contains notes without cards; resolve them before exporting this supported collection package')
    populated = {card.deck_id for card in cards}
    engines = {bool(effective_settings(d).get('fsrs',False)) for d in decks if d.id in populated}
    if include_scheduling and len(engines)>1:
        raise ValueError('Anki uses one scheduler for a collection; export decks with matching scheduler settings together, or omit scheduling')
    if len(cards) > 100000:
        raise ValueError('Export too large; select a smaller deck')
    with tempfile.TemporaryDirectory(prefix='anki_export_') as temporary:
        col_path = Path(temporary)/'collection.anki2'
        conn = sqlite3.connect(col_path)
        cursor = conn.cursor()
        cursor.executescript('''
            CREATE TABLE col (
                id integer primary key, crt integer not null, mod integer not null,
                scm integer not null, ver integer not null, dty integer not null,
                usn integer not null, ls integer not null, conf text not null,
                models text not null, decks text not null, dconf text not null, tags text not null
            );
            CREATE TABLE notes (
                id integer primary key, guid text not null, mid integer not null,
                mod integer not null, usn integer not null, tags text not null,
                flds text not null, sfld text not null, csum integer not null,
                flags integer not null, data text not null
            );
            CREATE TABLE cards (
                id integer primary key, nid integer not null, did integer not null,
                ord integer not null, mod integer not null, usn integer not null,
                type integer not null, queue integer not null, due integer not null,
                ivl integer not null, factor integer not null, reps integer not null,
                lapses integer not null, left integer not null, odue integer not null,
                odid integer not null, flags integer not null, data text not null
            );
            CREATE TABLE revlog (
                id integer primary key, cid integer not null, usn integer not null,
                ease integer not null, ivl integer not null, lastIvl integer not null,
                factor integer not null, time integer not null, type integer not null
            );
            CREATE TABLE graves (
                usn integer not null, oid integer not null, type integer not null
            );
        ''')


        now = int(datetime.now(timezone.utc).timestamp())
        base = now * 1000
        deck_ids = {deck.id: base+index for index, deck in enumerate(decks)}
        model_map, note_map, exported_models = {}, {}, {}
        media = {}
        media_root = Path(get_media_dir(user_id)).resolve()
        def register(filename):
            filename = unquote(filename)
            if Path(filename).name != filename or '\\' in filename or filename.startswith('.'):
                raise ValueError('Unsafe media reference in export')
            path = (media_root/filename).resolve()
            if path.parent != media_root or not path.is_file():
                raise ValueError('Export references missing or unsafe media; run Check Media first')
            if filename not in media:
                media[filename] = (str(len(media)), path)
            return filename
        def portable(value):
            def local(match):
                if int(match[1]) != user_id:
                    raise ValueError('Media belongs to another user; copy it before export')
                return register(match[2])
            value = re.sub(r'/api/media/(\d+)/([^"\'<>\s)]+)', local, value)
            for filename in re.findall(r'\[sound:([^\]]+)\]', value):
                register(filename)
            for filename in re.findall(r'(?:src|href)=["\']([^"\']+)["\']', value, re.I):
                filename=html.unescape(filename)
                if not re.match(r'^(?:[a-z][a-z0-9+.-]*:|/|#)', filename, re.I):
                    register(filename)
            for filename in re.findall(r'url\(["\']?([^"\')]+)["\']?\)', value, re.I):
                if not re.match(r'^(?:[a-z][a-z0-9+.-]*:|/|#)', filename, re.I):
                    register(filename)
            # Anki's portable audio representation is [sound:filename].
            value = re.sub(r'<audio\b[^>]*src=["\']([^"\']+)["\'][^>]*>\s*</audio>', lambda m:'[sound:'+m[1]+']', value, flags=re.I)
            return value
        def register_model(model):
            model_key = model.id if model else 'legacy-basic'
            if model_key not in model_map:
                mid = base + len(model_map)
                model_map[model_key] = mid
                names = json.loads(model.fields_json) if model else ['Front','Back']
                templates = json.loads(model.templates_json) if model else [{'name':'Card 1','qfmt':'{{Front}}','afmt':'{{FrontSide}}<hr id=answer>{{Back}}'}]
                original = json.loads(model.package_data.payload) if model and model.package_data else {}
                data = copy.deepcopy(original)
                data.update(id=mid,name=model.name if model else 'Basic',mod=now,usn=-1,
                            css=portable(model.css or '') if model else '',
                            type=1 if any('{{cloze:' in t['qfmt'] for t in templates) else original.get('type',0),sortf=original.get('sortf',0))
                old_fields = {f['name']:f for f in original.get('flds',[])}
                data['flds'] = [dict(old_fields.get(name,{'sticky':False,'rtl':False,'font':'Arial','size':20,'media':[]}),name=name,ord=i) for i,name in enumerate(names)]
                data['tmpls'] = [dict(t,ord=i,qfmt=portable(t['qfmt']),afmt=portable(t['afmt'])) for i,t in enumerate(templates)]
                from image_occlusion import is_occlusion, FIELDS
                if is_occlusion(templates) and names == FIELDS:
                    data['originalStockKind'] = 6
                    for i, field in enumerate(data['flds']):
                        field.update(tag=i, preventDeletion=i < 4)
                data.setdefault('req',[[i,'all',[j for j,name in enumerate(names) if '{{'+name+'}}' in t['qfmt'] or '{{#'+name+'}}' in t['qfmt']]] for i,t in enumerate(templates)])
                data.setdefault('tags',[]);data.setdefault('vers',[]);data.setdefault('did',None)
                exported_models[str(mid)] = data
            return model_map[model_key]
        if deck_id is None:
            for model in db.query(NoteType).filter_by(user_id=user_id):
                register_model(model)
        for index, card in enumerate(cards):
            note = card.note_link.note if card.note_link else None
            guid = card_guid(card,user_id)
            model = note.note_type if note else None
            mid = register_model(model)
            if guid not in note_map:
                nid = base + len(note_map)
                note_map[guid] = nid
                values = json.loads(note.fields_json) if note else [card.front,card.back]
                values = [portable(v) for v in values]
                tags = ' '+' '.join(json.loads(note.tags_json))+' ' if note else ''
                modified = int(note.updated_at.replace(tzinfo=timezone.utc).timestamp()) if note and note.updated_at else now
                raw = json.loads(note.package_data.payload) if note and note.package_data else {}
                fields = '\x1f'.join(values)
                cursor.execute('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)',(nid,guid,mid,modified,-1,tags,fields,strip_html(values[0]),compute_csum(values[0]),raw.get('flags',0),raw.get('data','')))
            nid = note_map[guid]
            cid = base+index
            ordinal = card.note_link.template_ord if card.note_link else 0
            raw_card = json.loads(card.package_data.payload) if card.package_data else {}
            kind,queue,due,ivl,factor,reps,lapses,left = 0,0,index+1,0,2500,0,0,0
            progress = db.query(StudyProgress).filter_by(card_id=card.id,user_id=user_id).first() if include_scheduling else None
            card_data = raw_card.get('data', '')
            if progress:
                from study_queue import config_for, interday
                from scheduling import study_day, utc
                from zoneinfo import ZoneInfo
                cfg = config_for(card.deck)
                kind,queue = map_card_state_to_anki(progress.card_state,progress.is_suspended)
                if not progress.is_suspended and interday(progress,cfg,datetime.now(timezone.utc)):queue=3
                ivl,factor,reps,lapses = progress.interval_days,int(progress.ease_factor*1000),progress.repetitions,progress.lapse_count
                if progress.next_review:
                    zone = ZoneInfo(cfg.timezone)
                    day = study_day(datetime.fromtimestamp(now,timezone.utc),cfg).astimezone(zone).date()
                    due = (utc(progress.next_review).astimezone(zone).date()-day).days if kind==2 or queue==3 else index+1 if kind==0 else int(utc(progress.next_review).timestamp())
                if progress.card_state in ('learning','relearning'):
                    from sm2 import parse_steps
                    steps = parse_steps(cfg.relearning_steps if progress.card_state=='relearning' else cfg.learning_steps)
                    remaining = max(0, len(steps)-progress.learning_step)
                    left = remaining*1001
                if card.scheduling and card.scheduling.fsrs_json:
                    memory = json.loads(card.scheduling.fsrs_json)['card']
                    data = json.loads(card_data or '{}')
                    if memory.get('stability') is not None:
                        data.update(s=memory['stability'], d=memory['difficulty'])
                        data['dr']=effective_settings(card.deck).get('fsrs_desired_retention',.9)
                        if progress.last_reviewed:data['lrt']=int(progress.last_reviewed.replace(tzinfo=timezone.utc).timestamp())
                    card_data=json.dumps(data)
            if include_scheduling and card.scheduling and card.scheduling.buried_until:
                from scheduling import utc
                if utc(card.scheduling.buried_until)>datetime.now(timezone.utc) and queue!=-1:queue=-3
            cursor.execute('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(cid,nid,deck_ids[card.deck_id],ordinal,now,-1,kind,queue,due,ivl,factor,reps,lapses,left,0,0,raw_card.get('flags',0),card_data))
            if include_scheduling:
                for log in db.query(ReviewLog).filter_by(card_id=card.id,user_id=user_id).order_by(ReviewLog.id):
                    record = json.loads(log.record.payload) if log.record else {}
                    raw = record.get('anki',{})
                    rid = raw.get('id',int(log.review_date.replace(tzinfo=timezone.utc).timestamp()*1000))
                    while cursor.execute('SELECT 1 FROM revlog WHERE id=?',(rid,)).fetchone():rid+=1
                    cursor.execute('INSERT INTO revlog VALUES (?,?,?,?,?,?,?,?,?)',(rid,cid,-1,log.rating,raw.get('ivl',record.get('interval_after',0)),raw.get('lastIvl',record.get('interval_before',0)),raw.get('factor',factor),raw.get('time',record.get('duration_ms',0)),raw.get('type',0 if log.was_new else 1)))
        definitions = {}
        configs = {}
        config_ids = {}
        for deck in decks:
            did = deck_ids[deck.id]
            from package_settings import export_config
            raw_deck = json.loads(deck.package_data.payload) if deck.package_data else {}
            binding = deck.options_binding
            preset = binding.preset if binding else None
            key = ('preset',preset.id) if preset else ('deck',deck.id)
            if key not in config_ids:
                config_ids[key]=base+len(config_ids)
                conf_id=config_ids[key]
                configs[str(conf_id)] = export_config(base_settings(deck), conf_id, preset.name if preset else deck.name, raw_deck.get('config'))
            definition = dict(raw_deck.get('deck', {}), id=did,name=deck.name,desc=deck.description,mod=now,usn=-1,conf=config_ids[key],dyn=0,lrnToday=[0,0],revToday=[0,0],newToday=[0,0],timeToday=[0,0],collapsed=False,browserCollapsed=False,extendNew=0,extendRev=0)
            overrides=json.loads(binding.overrides_json) if binding else {}
            definition.update(newLimit=overrides.get('new_cards_per_day'),reviewLimit=overrides.get('maximum_reviews_per_day'),newLimitToday=None,reviewLimitToday=None)
            definitions[str(did)] = definition
        conf = {'fsrs': bool(include_scheduling and True in engines)}
        cursor.execute('INSERT INTO col VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',(1,now,now,base,11,0,-1,0,json.dumps(conf),json.dumps(exported_models),json.dumps(definitions),json.dumps(configs),'{}'))
        conn.commit();conn.close()
        fd, output = tempfile.mkstemp(suffix='.apkg',prefix='anki_export_');os.close(fd)
        try:
            with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED) as archive:
                archive.write(col_path,'collection.anki2')
                archive.writestr('media',json.dumps({key:name for name,(key,path) in media.items()},ensure_ascii=False))
                for name,(key,path) in media.items():archive.write(path,key)
            return output
        except BaseException:
            os.unlink(output)
            raise
