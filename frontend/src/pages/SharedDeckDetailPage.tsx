import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { getSharedDeck, downloadSharedDeck, rateSharedDeck } from '../api/shared';
import type { SharedDeck } from '../api/shared';
import { useAuth } from '../context/useAuth';
import { usePrefs } from '../context/usePrefs';

const SharedDeckDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const [deck, setDeck] = useState<SharedDeck | null>(null);
  const [message, setMessage] = useState('');
  const [userRating, setUserRating] = useState(0);
  const { user } = useAuth();
  const navigate = useNavigate();
  const { t } = usePrefs();

  useEffect(() => { if (id) getSharedDeck(+id).then(r => setDeck(r.data)); }, [id]);

  const handleDownload = async () => {
    if (!user) { navigate('/login'); return; }
    try {
      const res = await downloadSharedDeck(+id!);
      setMessage(res.data.message);
    } catch { setMessage(t('shared.downloadFailed')); }
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
        <Link to="/shared">{t('shared.title')}</Link> <span>/</span> <span>{deck.title}</span>
      </div>
      <div className="shared-detail glass-card">
        <div className="shared-detail-header">
          <h1>{deck.title}</h1>
          <span className="badge">{deck.category}</span>
        </div>
        <p className="shared-meta">{t('shared.by')} <strong>{deck.username}</strong> • {t('shared.notesCount', { count: deck.notes_count })} • {t('shared.downloadsCount', { count: deck.download_count })}</p>
        
        <div className="shared-detail-body">
          <div className="shared-description">{deck.description || t('shared.noDescription')}</div>
          <div className="shared-detail-stats">
            <div className="stat-card glass-card"><span className="stat-value">{deck.notes_count}</span><span className="stat-label">{t('shared.notes')}</span></div>
            <div className="stat-card glass-card"><span className="stat-value">{deck.rating.toFixed(1)}</span><span className="stat-label">{t('shared.rating')}</span></div>
            <div className="stat-card glass-card"><span className="stat-value">{deck.download_count}</span><span className="stat-label">{t('shared.downloads')}</span></div>
          </div>
        </div>

        <div className="shared-rating-section">
          <h3>{t('shared.rate')}</h3>
          <div className="rating-input">
            {[1,2,3,4,5].map(r => (
              <button key={r} className={`star-btn ${r <= userRating ? 'active' : ''}`} onClick={() => handleRate(r)}>★</button>
            ))}
          </div>
        </div>

        {message && <div className="alert alert-success">{message}</div>}
        <button className="btn btn-primary btn-lg btn-full" onClick={handleDownload}>
          ⬇ {t('shared.download')}
        </button>
      </div>
    </div>
  );
};

export default SharedDeckDetailPage;
