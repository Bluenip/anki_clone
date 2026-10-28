"""Materialize parents omitted by older package imports."""
from models import Deck, DeckOptionsBinding


def repair_missing_parents(db, user_id=None):
    query = db.query(Deck)
    if user_id is not None:
        query = query.filter_by(user_id=user_id)
    decks = query.order_by(Deck.name).all()
    by_name = {(d.user_id, d.name): d for d in decks}
    created = []
    for child in decks:
        parts = child.name.split('::')
        for depth in range(1, len(parts)):
            name = '::'.join(parts[:depth])
            if (child.user_id, name) in by_name:
                continue
            parent = Deck(user_id=child.user_id, name=name, settings=child.settings or '{}')
            if child.options_binding and child.options_binding.preset:
                parent.options_binding = DeckOptionsBinding(preset=child.options_binding.preset,
                                                           overrides_json='{}', today_json='{}')
            db.add(parent)
            by_name[(child.user_id, name)] = parent
            created.append(parent)
    db.flush()
    return created
