import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { getDeck, deleteDeck } from '../api/decks';
import { getStudyStats } from '../api/study';
import { shareDeck } from '../api/shared';

const DeckDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const [deck, setDeck] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);
  const [showShare, setShowShare] = useState(false);
  const [shareTitle, setShareTitle] = useState('');
  const [shareCategory, setShareCategory] = useState('Other');
  const [shareDesc, setShareDesc] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    if (!id) return;
    getDeck(+id).then(r => { setDeck(r.data); setShareTitle(r.data.name); });
    getStudyStats(+id).then(r => setStats(r.data)).catch(() => {});
  }, [id]);

  const handleDelete = async () => {
    if (!confirm(`Delete "${deck.name}"?`)) return;
    await deleteDeck(+id!);
    navigate('/decks');
  };

  const handleShare = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await shareDeck(+id!, { title: shareTitle, description: shareDesc, category: shareCategory });
      setShowShare(false);
      getDeck(+id!).then(r => setDeck(r.data));
    } catch { /* */ }
  };

  if (!deck) return <div className="loading-screen"><div className="spinner" /></div>;

  const categories = ['Arabic','Chinese','English','French','German','Hebrew','Japanese','Korean','Russian','Spanish','Anatomy','Biology','Chemistry','Geography','History','Law','Math','Music','Pathology','Physics','Other'];

  return (
    <div className="page-container">
      <div className="breadcrumb">
        <Link to="/decks">Decks</Link> <span>/</span> <span>{deck.name}</span>
      </div>
      <div className="deck-detail glass-card">
        <div className="deck-detail-header">
          <div>
            <h1>{deck.name}</h1>
            {deck.description && <p className="deck-desc">{deck.description}</p>}
          </div>
          <div className="deck-detail-actions">
            <Link to={`/study/${id}`} className="btn btn-primary btn-lg">▶ Study Now</Link>
            <Link to={`/decks/${id}/cards`} className="btn btn-ghost">Browse Cards</Link>
            {!deck.is_shared && <button className="btn btn-ghost" onClick={() => setShowShare(true)}>Share</button>}
            <button className="btn btn-danger" onClick={handleDelete}>Delete</button>
          </div>
        </div>

        {stats && (
          <div className="stats-grid">
            <div className="stat-card glass-card"><span className="stat-value stat-new">{stats.new_cards}</span><span className="stat-label">New</span></div>
            <div className="stat-card glass-card"><span className="stat-value stat-due">{stats.due_cards}</span><span className="stat-label">Due</span></div>
            <div className="stat-card glass-card"><span className="stat-value">{stats.learned_cards}</span><span className="stat-label">Learned</span></div>
            <div className="stat-card glass-card"><span className="stat-value">{stats.total_cards}</span><span className="stat-label">Total</span></div>
          </div>
        )}
      </div>

      {showShare && (
        <div className="modal-overlay" onClick={() => setShowShare(false)}>
          <div className="modal glass-card" onClick={e => e.stopPropagation()}>
            <h2>Share Deck</h2>
            <form onSubmit={handleShare}>
              <div className="form-group"><label>Title</label><input value={shareTitle} onChange={e => setShareTitle(e.target.value)} required /></div>
              <div className="form-group"><label>Category</label>
                <select value={shareCategory} onChange={e => setShareCategory(e.target.value)}>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="form-group"><label>Description</label><textarea value={shareDesc} onChange={e => setShareDesc(e.target.value)} rows={3} /></div>
              <div className="modal-actions"><button type="button" className="btn btn-ghost" onClick={() => setShowShare(false)}>Cancel</button><button type="submit" className="btn btn-primary">Share</button></div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default DeckDetailPage;
