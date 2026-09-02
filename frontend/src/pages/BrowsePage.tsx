import { useState, useEffect } from 'react';
import { browseCards, updateCard } from '../api/cards';

const BrowsePage = () => {
  const [cards, setCards] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedCard, setSelectedCard] = useState<any>(null);
  
  // Editor state
  const [editFront, setEditFront] = useState('');
  const [editBack, setEditBack] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchCards = async (query: string = '') => {
    setLoading(true);
    try {
      const res = await browseCards(query);
      setCards(res.data);
      // Automatically select first card if none selected
      if (res.data.length > 0 && !selectedCard) {
        handleSelectCard(res.data[0]);
      } else if (res.data.length === 0) {
        setSelectedCard(null);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCards();
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    fetchCards(search);
  };

  const handleSelectCard = (card: any) => {
    setSelectedCard(card);
    setEditFront(card.front);
    setEditBack(card.back);
  };

  const handleSave = async () => {
    if (!selectedCard) return;
    setSaving(true);
    try {
      await updateCard(selectedCard.id, { front: editFront, back: editBack });
      
      // Update local state
      setCards(cards.map(c => c.id === selectedCard.id ? { ...c, front: editFront, back: editBack } : c));
      setSelectedCard({ ...selectedCard, front: editFront, back: editBack });
      
      // Flash success (simple approach)
      const btn = document.getElementById('save-btn');
      if (btn) {
        const originalText = btn.innerText;
        btn.innerText = 'Saved!';
        btn.style.backgroundColor = 'var(--accent-green)';
        setTimeout(() => {
          btn.innerText = originalText;
          btn.style.backgroundColor = '';
        }, 1500);
      }
      
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="browse-container">
      {/* Left Pane: List */}
      <div className="browse-sidebar glass-card">
        <form onSubmit={handleSearch} className="browse-search">
          <input 
            type="text" 
            placeholder="Search cards/notes (type text, then press Enter)" 
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button type="submit" className="btn btn-primary">Search</button>
        </form>
        
        <div className="browse-table-container">
          <table className="browse-table">
            <thead>
              <tr>
                <th>Front</th>
                <th>Back</th>
                <th>Deck</th>
                <th>Due</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={4} style={{ textAlign: 'center', padding: '20px' }}>Loading...</td></tr>
              ) : cards.length === 0 ? (
                <tr><td colSpan={4} style={{ textAlign: 'center', padding: '20px' }}>No cards found</td></tr>
              ) : (
                cards.map(card => (
                  <tr 
                    key={card.id} 
                    className={selectedCard?.id === card.id ? 'selected' : ''}
                    onClick={() => handleSelectCard(card)}
                  >
                    <td>{card.front}</td>
                    <td>{card.back}</td>
                    <td>{card.deck_name}</td>
                    <td>{card.next_review ? new Date(card.next_review).toLocaleDateString() : 'New'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Right Pane: Editor */}
      <div className="browse-editor glass-card">
        {selectedCard ? (
          <div className="editor-content">
            <div className="editor-header">
              <h2>Edit Card</h2>
            </div>
            <div className="form-group">
              <label>Front</label>
              <textarea 
                value={editFront} 
                onChange={(e) => setEditFront(e.target.value)} 
                rows={5}
                className="editor-textarea"
              />
            </div>
            <div className="form-group">
              <label>Back</label>
              <textarea 
                value={editBack} 
                onChange={(e) => setEditBack(e.target.value)} 
                rows={5}
                className="editor-textarea"
              />
            </div>
            <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'flex-end' }}>
              <button 
                id="save-btn"
                className="btn btn-primary" 
                onClick={handleSave} 
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        ) : (
          <div className="editor-empty">
            <span style={{ fontSize: '3rem', opacity: 0.5 }}>🔍</span>
            <p>Select a card to view and edit</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default BrowsePage;
