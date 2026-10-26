"""Exercise the public import/export path with a deck larger than UI pagination."""
from models import Card, Deck


def test_5000_note_package_roundtrip(client,auth_headers_a,auth_headers_b,db_session):
    deck=client.post('/api/decks',headers=auth_headers_a,json={'name':'Large roundtrip'}).json()['id']
    source='\n'.join(f'Question {i}\tAnswer {i}' for i in range(5000))
    imported=client.post(f'/api/decks/{deck}/import',headers=auth_headers_a,json={'text':source,'kind':'basic'})
    assert imported.status_code==200,imported.text
    assert imported.json()['added']==5000
    package=client.get(f'/api/apkg/export/{deck}',headers=auth_headers_a)
    assert package.status_code==200,package.text[:100]
    restored=client.post('/api/apkg/import',headers=auth_headers_b,files={'file':('large.apkg',package.content)})
    assert restored.status_code==200,restored.text
    assert restored.json()['cards_imported']==5000
    target=restored.json()['deck_id']
    cards=db_session.query(Card).filter_by(deck_id=target).order_by(Card.id).all()
    assert len(cards)==5000
    assert 'Question 0' in cards[0].front and 'Answer 4999' in cards[-1].back
