import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import { listDecks } from '../api/decks';
import { createCard } from '../api/cards';

interface Deck {
  id: number;
  name: string;
}

const AddPage = () => {
  const [decks, setDecks] = useState<Deck[]>([]);
  const [selectedDeckId, setSelectedDeckId] = useState<number | ''>('');
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchDecks = async () => {
      try {
        const res = await listDecks();
        setDecks(res.data);
        if (res.data.length > 0) {
          setSelectedDeckId(res.data[0].id);
        }
      } catch (err) {
        console.error('Failed to load decks', err);
      } finally {
        setLoading(false);
      }
    };
    fetchDecks();
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedDeckId || !front.trim() || !back.trim()) return;

    try {
      await createCard(Number(selectedDeckId), front, back);
      setFront('');
      setBack('');
      setSuccessMsg('Card added successfully!');
      setTimeout(() => setSuccessMsg(''), 3000);
    } catch (err) {
      console.error('Failed to add card', err);
    }
  };

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;

  return (
    <div className="page-container" style={{ maxWidth: '600px', marginTop: '2rem' }}>
      <div className="glass-card" style={{ padding: '2rem' }}>
        <h2 style={{ marginBottom: '1.5rem', textAlign: 'center' }}>Add Note</h2>
        
        {successMsg && <div className="alert alert-success">{successMsg}</div>}
        
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Deck</label>
            <select 
              value={selectedDeckId} 
              onChange={(e) => setSelectedDeckId(Number(e.target.value))}
              required
            >
              <option value="" disabled>Select a deck...</option>
              {decks.map(deck => (
                <option key={deck.id} value={deck.id}>{deck.name}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>Front</label>
            <textarea 
              value={front} 
              onChange={e => setFront(e.target.value)} 
              rows={4} 
              required 
            />
          </div>

          <div className="form-group">
            <label>Back</label>
            <textarea 
              value={back} 
              onChange={e => setBack(e.target.value)} 
              rows={4} 
              required 
            />
          </div>

          <button type="submit" className="btn btn-primary btn-full" disabled={!selectedDeckId || decks.length === 0}>
            Add Card
          </button>
          {decks.length === 0 && (
            <p style={{ textAlign: 'center', marginTop: '1rem', color: 'var(--danger)' }}>
              Please create a deck first.
            </p>
          )}
        </form>
      </div>
    </div>
  );
};

export default AddPage;
