import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getNextCard, reviewCard, getStudyStats } from '../api/study';

const StudyPage = () => {
  const { deckId } = useParams<{ deckId: string }>();
  const [card, setCard] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);
  const [showAnswer, setShowAnswer] = useState(false);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const [reviewedCards, setReviewedCards] = useState<Set<number>>(new Set());
  const [animating, setAnimating] = useState(false);
  const [leechToast, setLeechToast] = useState<string | null>(null);

  const fetchCard = async () => {
    setLoading(true);
    try {
      const [cardRes, statsRes] = await Promise.all([
        getNextCard(+deckId!),
        getStudyStats(+deckId!)
      ]);
      setStats(statsRes.data);
      if (!cardRes.data) { setDone(true); } else { setCard(cardRes.data); setDone(false); }
    } catch { setDone(true); }
    finally { setLoading(false); setShowAnswer(false); }
  };

  useEffect(() => { fetchCard(); }, [deckId]);

  // Auto-hide leech toast
  useEffect(() => {
    if (leechToast) {
      const timer = setTimeout(() => setLeechToast(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [leechToast]);

  const handleReview = async (rating: number) => {
    if (!card) return;
    setAnimating(true);
    try {
      const res = await reviewCard(card.card_id, rating);
      
      // Check for leech
      if (res.data?.is_leech) {
        setLeechToast(`⚠️ Leech detected! (${res.data.lapse_count} lapses)`);
      }

      setReviewedCards(prev => {
        const next = new Set(prev);
        next.add(card.card_id);
        return next;
      });
      setTimeout(() => { setAnimating(false); fetchCard(); }, 300);
    } catch { setAnimating(false); }
  };

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;

  if (done) return (
    <div className="page-container">
      <div className="study-done glass-card">
        <span className="done-icon">🎉</span>
        <h1>Congratulations!</h1>
        <p>You've finished studying this deck for now.</p>
        <p className="done-stats">Cards reviewed: <strong>{reviewedCards.size}</strong></p>
        <Link to="/decks" className="btn btn-primary btn-lg">Back to Decks</Link>
      </div>
    </div>
  );

  const cardState = card?.card_state || 'new';
  const isLearning = cardState === 'learning' || cardState === 'relearning';

  return (
    <div className="page-container study-container">
      {/* Leech Toast Notification */}
      {leechToast && (
        <div className="leech-toast">
          <div className="leech-toast-content">
            {leechToast}
          </div>
        </div>
      )}

      <div className="study-header">
        <Link to={`/decks/${deckId}`} className="btn btn-ghost btn-sm">← Back</Link>
        <span className="study-deck-name">{card?.deck_name}</span>
        <div className="study-counts">
          <span className="stat-new" style={{ color: 'var(--accent-cyan)', margin: '0 8px', fontWeight: 600 }}>{stats?.new_cards || 0}</span>
          <span className="stat-learn" style={{ color: 'var(--warning)', margin: '0 8px', fontWeight: 600 }}>{stats?.learn_cards || 0}</span>
          <span className="stat-due" style={{ color: 'var(--success)', margin: '0 8px', fontWeight: 600 }}>{stats?.due_cards || 0}</span>
        </div>
      </div>

      <div className={`study-card-wrapper ${animating ? 'slide-out' : 'slide-in'}`}>
        <div className={`study-card glass-card ${showAnswer ? 'flipped' : ''}`}>
          <div className="card-face card-front">
            <div className="card-label">Question</div>
            <div className="card-content" dangerouslySetInnerHTML={{ __html: card?.front || '' }} />
            <div className="card-badges">
              {card?.is_new && <span className="badge badge-new">NEW</span>}
              {isLearning && <span className="badge badge-learning">
                {cardState === 'learning' ? 'LEARNING' : 'RELEARNING'}
              </span>}
            </div>
          </div>
          {showAnswer && (
            <div className="card-face card-back">
              <div className="card-divider" />
              <div className="card-label">Answer</div>
              <div className="card-content" dangerouslySetInnerHTML={{ __html: card?.back || '' }} />
            </div>
          )}
        </div>
      </div>

      <div className="study-actions">
        {!showAnswer ? (
          <button className="btn btn-primary btn-lg btn-show-answer" onClick={() => setShowAnswer(true)}>
            Show Answer
          </button>
        ) : (
          <div className="rating-buttons">
            <button className="btn btn-rating btn-again" onClick={() => handleReview(1)}>
              <span className="rating-label">Again</span>
              <span className="rating-interval">{card?.intervals?.again?.display || '< 1m'}</span>
            </button>
            <button className="btn btn-rating btn-hard" onClick={() => handleReview(2)}>
              <span className="rating-label">Hard</span>
              <span className="rating-interval">{card?.intervals?.hard?.display || '1d'}</span>
            </button>
            <button className="btn btn-rating btn-good" onClick={() => handleReview(3)}>
              <span className="rating-label">Good</span>
              <span className="rating-interval">{card?.intervals?.good?.display || '3d'}</span>
            </button>
            <button className="btn btn-rating btn-easy" onClick={() => handleReview(4)}>
              <span className="rating-label">Easy</span>
              <span className="rating-interval">{card?.intervals?.easy?.display || '4d'}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default StudyPage;
