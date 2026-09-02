import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { getSharedDeck, downloadSharedDeck, rateSharedDeck } from '../api/shared';
import { useAuth } from '../context/AuthContext';

const SharedDeckDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const [deck, setDeck] = useState<any>(null);
  const [message, setMessage] = useState('');
  const [userRating, setUserRating] = useState(0);
  const { user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => { if (id) getSharedDeck(+id).then(r => setDeck(r.data)); }, [id]);

  const handleDownload = async () => {
    if (!user) { navigate('/login'); return; }
    try {
      const res = await downloadSharedDeck(+id!);
      setMessage(res.data.message);
    } catch { setMessage('Failed to download'); }
  };

  const handleRate = async (rating: number) => {
    if (!user) { navigate('/login'); return; }
    setUserRating(rating);
    try { await rateSharedDeck(+id!, rating); getSharedDeck(+id!).then(r => setDeck(r.data)); }
    catch { /* */ }
  };

  if (!deck) return <div className="loading-screen"><div className="spinner" /></div>;

  return (
    <div className="page-container">
      <div className="breadcrumb">
        <Link to="/shared">Shared Decks</Link> <span>/</span> <span>{deck.title}</span>
      </div>
      <div className="shared-detail glass-card">
        <div className="shared-detail-header">
          <h1>{deck.title}</h1>
          <span className="badge">{deck.category}</span>
        </div>
        <p className="shared-meta">Shared by <strong>{deck.username}</strong> • {deck.notes_count} notes • {deck.download_count} downloads</p>
        
        <div className="shared-detail-body">
          <div className="shared-description">{deck.description || 'No description provided.'}</div>
          <div className="shared-detail-stats">
            <div className="stat-card glass-card"><span className="stat-value">{deck.notes_count}</span><span className="stat-label">Notes</span></div>
            <div className="stat-card glass-card"><span className="stat-value">{deck.rating.toFixed(1)}</span><span className="stat-label">Rating</span></div>
            <div className="stat-card glass-card"><span className="stat-value">{deck.download_count}</span><span className="stat-label">Downloads</span></div>
          </div>
        </div>

        <div className="shared-rating-section">
          <h3>Rate this deck</h3>
          <div className="rating-input">
            {[1,2,3,4,5].map(r => (
              <button key={r} className={`star-btn ${r <= userRating ? 'active' : ''}`} onClick={() => handleRate(r)}>★</button>
            ))}
          </div>
        </div>

        {message && <div className="alert alert-success">{message}</div>}
        <button className="btn btn-primary btn-lg btn-full" onClick={handleDownload}>
          ⬇ Download to My Collection
        </button>
      </div>
    </div>
  );
};

export default SharedDeckDetailPage;
