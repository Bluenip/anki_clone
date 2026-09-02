import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { listCards, createCard, updateCard, deleteCard } from '../api/cards';

interface Card { id: number; deck_id: number; front: string; back: string; created_at: string; updated_at: string; }

const CardEditorPage = () => {
  const { deckId } = useParams<{ deckId: string }>();
  const [cards, setCards] = useState<Card[]>([]);
  const [search, setSearch] = useState('');
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [editId, setEditId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchCards = async () => {
    try { const res = await listCards(+deckId!, search); setCards(res.data); }
    catch { /* */ } finally { setLoading(false); }
  };

  useEffect(() => { fetchCards(); }, [deckId, search]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!front.trim() || !back.trim()) return;
    try {
      if (editId) { await updateCard(editId, { front, back }); }
      else { await createCard(+deckId!, front, back); }
      setFront(''); setBack(''); setEditId(null); fetchCards();
    } catch { /* */ }
  };

  const handleEdit = (card: Card) => { setEditId(card.id); setFront(card.front); setBack(card.back); };
  const handleCancel = () => { setEditId(null); setFront(''); setBack(''); };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this card?')) return;
    try { await deleteCard(id); fetchCards(); } catch { /* */ }
  };

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;

  return (
    <div className="page-container">
      <div className="breadcrumb">
        <Link to="/decks">Decks</Link> <span>/</span>
        <Link to={`/decks/${deckId}`}>Deck</Link> <span>/</span> <span>Cards</span>
      </div>

      <div className="card-editor-layout">
        <div className="card-form glass-card">
          <h2>{editId ? 'Edit Card' : 'Add New Card'}</h2>
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>Front</label>
              <textarea value={front} onChange={e => setFront(e.target.value)} placeholder="Question or term" rows={4} required />
            </div>
            <div className="form-group">
              <label>Back</label>
              <textarea value={back} onChange={e => setBack(e.target.value)} placeholder="Answer or definition" rows={4} required />
            </div>
            <div className="modal-actions">
              {editId && <button type="button" className="btn btn-ghost" onClick={handleCancel}>Cancel</button>}
              <button type="submit" className="btn btn-primary">{editId ? 'Update' : 'Add Card'}</button>
            </div>
          </form>
        </div>

        <div className="card-list-section">
          <div className="card-list-header">
            <h2>Cards ({cards.length})</h2>
            <input type="text" className="search-input" placeholder="Search cards..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          {cards.length === 0 ? (
            <div className="empty-state glass-card"><p>No cards yet. Add your first card!</p></div>
          ) : (
            <div className="cards-grid">
              {cards.map(card => (
                <div key={card.id} className="card-item glass-card">
                  <div className="card-item-front"><strong>Q:</strong> <span dangerouslySetInnerHTML={{ __html: card.front }} /></div>
                  <div className="card-item-back"><strong>A:</strong> <span dangerouslySetInnerHTML={{ __html: card.back }} /></div>
                  <div className="card-item-actions">
                    <button className="btn btn-sm btn-ghost" onClick={() => handleEdit(card)}>Edit</button>
                    <button className="btn btn-sm btn-danger" onClick={() => handleDelete(card.id)}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default CardEditorPage;
