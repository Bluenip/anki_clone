import json
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from auth import get_current_user
from database import get_db
from models import User, Deck, OptionPreset, DeckOptionsBinding
from schemas import DeckUpdate, DeckSettings
from deck_options import base_settings, effective_settings, day_key

router=APIRouter(prefix='/api',tags=['Deck options'])


class SettingsBody(BaseModel):
    settings: str
    expected_version: int | None = Field(default=None,ge=0)

    @field_validator('settings')
    @classmethod
    def validate_settings(cls,value):
        return DeckUpdate(settings=value).settings


class PresetBody(SettingsBody):
    name: str = Field(min_length=1,max_length=100)

    @field_validator('name')
    @classmethod
    def name_required(cls,value):
        if not value.strip():raise ValueError('Preset name cannot be empty')
        return value.strip()


class BindingBody(BaseModel):
    preset_id: int | None = Field(default=None,ge=1)


class LimitsBody(BaseModel):
    scope: Literal['preset','deck','today']
    new_cards_per_day: int | None = Field(default=None,ge=0,le=999999,strict=True)
    maximum_reviews_per_day: int | None = Field(default=None,ge=0,le=999999,strict=True)
    expected_version: int | None = Field(default=None,ge=0)


def owned_deck(db,user_id,deck_id):
    deck=db.query(Deck).filter_by(id=deck_id,user_id=user_id).first()
    if not deck:raise HTTPException(status_code=404,detail='Deck not found')
    return deck


def owned_preset(db,user_id,preset_id):
    preset=db.query(OptionPreset).filter_by(id=preset_id,user_id=user_id).first()
    if not preset:raise HTTPException(status_code=404,detail='Preset not found')
    return preset


def preset_response(db,preset):
    used=[did for (did,) in db.query(DeckOptionsBinding.deck_id).join(Deck).filter(
        DeckOptionsBinding.preset_id==preset.id,Deck.user_id==preset.user_id)]
    return {'id':preset.id,'name':preset.name,'settings':preset.settings_json,'version':preset.version,'used_by':used}


def response(db,deck):
    binding=deck.options_binding
    preset=binding.preset if binding else None
    settings=base_settings(deck)
    return {'preset_id':preset.id if preset else None,'preset_name':preset.name if preset else None,
            'preset_version':preset.version if preset else None,'preset_settings':json.dumps(settings),
            'settings':json.dumps(effective_settings(deck)),
            'overrides':json.loads(binding.overrides_json) if binding else {},
            'today':json.loads(binding.today_json) if binding and json.loads(binding.today_json).get('day')==day_key(settings) else {},
            'presets':[preset_response(db,p) for p in db.query(OptionPreset).filter_by(user_id=deck.user_id).order_by(OptionPreset.name)]}


def change_preset(db,preset,settings,expected,name=None):
    if expected is None:raise HTTPException(status_code=409,detail='Reload preset before saving; its current version is required')
    values={'settings_json':settings,'version':expected+1}
    if name is not None:values['name']=name
    changed=db.execute(update(OptionPreset).where(OptionPreset.id==preset.id,OptionPreset.version==expected).values(**values).execution_options(synchronize_session=False))
    if changed.rowcount!=1:
        db.rollback()
        raise HTTPException(status_code=409,detail='Preset changed in another tab; reload before saving')
    db.refresh(preset)


@router.get('/options/presets')
def list_presets(db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return [preset_response(db,p) for p in db.query(OptionPreset).filter_by(user_id=user.id).order_by(OptionPreset.name)]


@router.post('/options/presets',status_code=201)
def create_preset(data:PresetBody,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    preset=OptionPreset(user_id=user.id,name=data.name,settings_json=data.settings)
    db.add(preset)
    try:db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409,detail='A preset with this name already exists') from None
    return preset_response(db,preset)


@router.put('/options/presets/{preset_id}')
def edit_preset(preset_id:int,data:PresetBody,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    preset=owned_preset(db,user.id,preset_id)
    try:
        change_preset(db,preset,data.settings,data.expected_version,data.name)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409,detail='A preset with this name already exists') from None
    return preset_response(db,preset)


@router.delete('/options/presets/{preset_id}',status_code=204)
def delete_preset(preset_id:int,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    preset=owned_preset(db,user.id,preset_id)
    if db.query(DeckOptionsBinding).filter_by(preset_id=preset_id).first():
        raise HTTPException(status_code=409,detail='Detach decks from this preset before deleting it')
    db.delete(preset);db.commit()


@router.get('/decks/{deck_id}/options')
def get_options(deck_id:int,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return response(db,owned_deck(db,user.id,deck_id))


@router.put('/decks/{deck_id}/options/preset')
def bind_preset(deck_id:int,data:BindingBody,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    deck=owned_deck(db,user.id,deck_id)
    preset=owned_preset(db,user.id,data.preset_id) if data.preset_id else None
    if not deck.options_binding:deck.options_binding=DeckOptionsBinding(overrides_json='{}',today_json='{}')
    if preset is None:
        deck.settings=json.dumps(base_settings(deck))
    deck.options_binding.preset=preset
    db.commit()
    return response(db,deck)


@router.put('/decks/{deck_id}/options')
def save_options(deck_id:int,data:SettingsBody,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    deck=owned_deck(db,user.id,deck_id)
    if deck.options_binding and deck.options_binding.preset:
        change_preset(db,deck.options_binding.preset,data.settings,data.expected_version)
    else:deck.settings=data.settings
    db.commit()
    return response(db,deck)


@router.put('/decks/{deck_id}/options/limits')
def save_limits(deck_id:int,data:LimitsBody,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    deck=owned_deck(db,user.id,deck_id)
    values={key:value for key,value in data.model_dump().items() if key in ('new_cards_per_day','maximum_reviews_per_day') and value is not None}
    if data.scope=='preset':
        settings=base_settings(deck)
        for key in ('new_cards_per_day','maximum_reviews_per_day'):
            if key in values:settings[key]=values[key]
            else:settings.pop(key,None)
        DeckSettings.model_validate(settings)
        if deck.options_binding and deck.options_binding.preset:
            change_preset(db,deck.options_binding.preset,json.dumps(settings),data.expected_version)
        else:deck.settings=json.dumps(settings)
    else:
        if not deck.options_binding:deck.options_binding=DeckOptionsBinding(overrides_json='{}',today_json='{}')
        if data.scope=='deck':deck.options_binding.overrides_json=json.dumps(values)
        else:deck.options_binding.today_json=json.dumps({'day':day_key(base_settings(deck)),'limits':values})
    db.commit()
    return response(db,deck)


class ExtraToday(BaseModel):
    kind: Literal['new', 'review']
    count: int = Field(ge=1, le=10000, strict=True)


@router.post('/decks/{deck_id}/options/extra-today')
def extra_today(deck_id: int, data: ExtraToday, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    try:
        db.execute(update(User).where(User.id == user.id).values(id=User.id)); db.expire_all()
        deck = owned_deck(db, user.id, deck_id)
        settings = effective_settings(deck)
        limits = {key: settings.get(key, default) for key, default in [('new_cards_per_day', 20), ('maximum_reviews_per_day', 200)]}
        key = 'new_cards_per_day' if data.kind == 'new' else 'maximum_reviews_per_day'
        limits[key] = min(999999, limits[key] + data.count)
        if not deck.options_binding: deck.options_binding = DeckOptionsBinding(overrides_json='{}', today_json='{}')
        deck.options_binding.today_json = json.dumps({'day': day_key(settings), 'limits': limits})
        db.commit()
        return response(db, deck)
    except BaseException:
        db.rollback(); raise
