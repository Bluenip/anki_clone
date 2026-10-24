"""Map supported web options onto the pinned Anki preset schema."""
import copy
from functools import lru_cache
import tempfile
from pathlib import Path
from sm2 import parse_steps

ORDERS = {
    'newMix': ('new_review_order', ['Mix with reviews','Show after reviews','Show before reviews']),
    'interdayLearningMix': ('interday_learning_review_order', ['Mix with reviews','Show after reviews','Show before reviews']),
    'newGatherPriority': ('new_card_gather_order', ['Deck','Ascending position','Descending position','Random notes','Random cards','Deck, then random notes']),
    'newSortOrder': ('new_card_sort_order', ['Card type, then order gathered','Order gathered','Card type, then random','Random note, then card type','Random']),
    'reviewOrder': ('review_sort_order', {0:'Due date, then random',1:'Due date, then deck',2:'Deck, then due date',3:'Ascending intervals',4:'Descending intervals',5:'Ascending ease',6:'Descending ease',8:'Random',12:'Relative overdueness'}),
    'answerAction': ('answer_action', ['Bury Card','Again','Good','Hard']),
}


@lru_cache(maxsize=1)
def default_config():
    from anki.collection import Collection
    with tempfile.TemporaryDirectory(prefix='anki_defaults_') as directory:
        collection = Collection(str(Path(directory)/'collection.anki2'))
        try:
            return collection.decks.all_config()[0]
        finally:
            collection.close()


def export_config(settings, config_id, name, original=None):
    config = copy.deepcopy(original or default_config())
    config.update(id=config_id, name=name, usn=-1)
    mapping = {
        'new_cards_per_day': ('new', 'perDay'), 'maximum_reviews_per_day': ('rev', 'perDay'),
        'starting_ease': ('new', 'initialFactor'), 'easy_bonus': ('rev', 'ease4'),
        'interval_modifier': ('rev', 'ivlFct'), 'maximum_interval': ('rev', 'maxIvl'),
        'hard_interval': ('rev', 'hardFactor'), 'minimum_interval': ('lapse', 'minInt'),
        'new_interval': ('lapse', 'mult'), 'leech_threshold': ('lapse', 'leechFails'),
        'bury_new_siblings': ('new', 'bury'), 'bury_review_siblings': ('rev', 'bury'),
    }
    for key, (section, field) in mapping.items():
        if key in settings:
            config[section][field] = int(settings[key]*1000) if key=='starting_ease' else settings[key]
    for key, section in [('learning_steps', 'new'), ('relearning_steps', 'lapse')]:
        if key in settings: config[section]['delays'] = [s/60 for s in parse_steps(settings[key])]
    config['new']['ints'][:2] = [settings.get('graduating_interval', config['new']['ints'][0]), settings.get('easy_interval', config['new']['ints'][1])]
    if 'insertion_order' in settings:config['new']['order'] = 0 if settings['insertion_order']=='Random' else 1
    if 'leech_action' in settings:config['lapse']['leechAction'] = 0 if settings['leech_action']=='Suspend Card' else 1
    for web, native in [('maximum_answer_seconds','maxTaken'), ('show_on_screen_timer','timer'),
                        ('stop_on_screen_timer_on_answer','stopTimerOnAnswer'), ('seconds_to_show_question_for','secondsToShowQuestion'),
                        ('seconds_to_show_answer_for','secondsToShowAnswer'), ('wait_for_audio','waitForAudio'),
                        ('bury_interday_learning_siblings','buryInterdayLearning'), ('fsrs_desired_retention','desiredRetention')]:
        if web in settings:config[native]=settings[web]
    if 'dont_play_audio_automatically' in settings:config['autoplay']=not settings['dont_play_audio_automatically']
    if 'skip_question_when_replaying_answer' in settings:config['replayq']=not settings['skip_question_when_replaying_answer']
    if settings.get('fsrs_parameters'):config['fsrsParams6']=settings['fsrs_parameters']
    for native,(web,values) in ORDERS.items():
        pairs = values.items() if isinstance(values,dict) else enumerate(values)
        for index,value in pairs:
            if settings.get(web)==value:config[native]=index
    return config


def import_config(config):
    if not config:return {}
    new, rev, lapse = config.get('new',{}), config.get('rev',{}), config.get('lapse',{})
    settings = {}
    for source, mapping in [(new, {'perDay':'new_cards_per_day','bury':'bury_new_siblings'}),
                            (rev, {'perDay':'maximum_reviews_per_day','bury':'bury_review_siblings','ease4':'easy_bonus','ivlFct':'interval_modifier','maxIvl':'maximum_interval','hardFactor':'hard_interval'}),
                            (lapse, {'minInt':'minimum_interval','mult':'new_interval','leechFails':'leech_threshold'})]:
        settings.update({target:source[key] for key,target in mapping.items() if key in source})
    for key, source in [('learning_steps',new), ('relearning_steps',lapse)]:
        if 'delays' in source:settings[key]=' '.join(f'{max(1,round(v*60))}s' for v in source['delays'])
    if 'initialFactor' in new:settings['starting_ease']=max(1.3,new['initialFactor']/1000)
    if len(new.get('ints',[]))>=2:settings.update(graduating_interval=new['ints'][0],easy_interval=new['ints'][1])
    if 'order' in new:settings['insertion_order']='Random' if new['order']==0 else 'Sequential (oldest cards first)'
    if 'leechAction' in lapse:settings['leech_action']='Suspend Card' if lapse['leechAction']==0 else 'Tag Only'
    for source,target in [('maxTaken','maximum_answer_seconds'),('timer','show_on_screen_timer'),('stopTimerOnAnswer','stop_on_screen_timer_on_answer'),('secondsToShowQuestion','seconds_to_show_question_for'),('secondsToShowAnswer','seconds_to_show_answer_for'),('waitForAudio','wait_for_audio'),('buryInterdayLearning','bury_interday_learning_siblings'),('desiredRetention','fsrs_desired_retention')]:
        if source in config:settings[target]=bool(config[source]) if source=='timer' else config[source]
    if 'autoplay' in config:settings['dont_play_audio_automatically']=not config['autoplay']
    if 'replayq' in config:settings['skip_question_when_replaying_answer']=not config['replayq']
    if len(config.get('fsrsParams6',[]))==21:settings['fsrs_parameters']=config['fsrsParams6']
    for native,(web,values) in ORDERS.items():
        pairs = dict(values.items() if isinstance(values,dict) else enumerate(values))
        if config.get(native) in pairs:settings[web]=pairs[config[native]]
    return settings
