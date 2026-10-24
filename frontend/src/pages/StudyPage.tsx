import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  getNextCard,
  reviewCard,
  getStudyStats,
  undoReview,
  cardAction,
} from '../api/study';
import type { ReviewExtra, StudyCard, StudyStats } from '../api/study';
import { playFlipSound, playRatingSound, playCompleteSound } from '../sounds';
import CardFace from '../components/CardFace';
import type { CardFaceRef } from '../components/CardFace';

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const StudyPageContent = () => {
  const { deckId } = useParams<{ deckId: string }>();
  const [card, setCard] = useState<StudyCard | null>(null);
  const [stats, setStats] = useState<StudyStats | null>(null);
  const [showAnswer, setShowAnswer] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [leechToast, setLeechToast] = useState<string | null>(null);
  const [reviewedCards, setReviewedCards] = useState<Set<number>>(new Set());
  const [animating, setAnimating] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(0);

  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const cardFaceRef = useRef<CardFaceRef>(null);
  const isSubmittingRef = useRef(false);
  const cardStartTimeRef = useRef<number>(0);
  const pendingReviewRef = useRef<{ cardId: number; rating: number; requestId: string } | null>(
    null
  );
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadGenerationRef = useRef(0);
  const reviewedCountRef = useRef(0);
  const answerElapsedRef = useRef<number | null>(null);
  const pendingAutoActionRef = useRef<(() => void) | null>(null);

  const clearTimers = useCallback(() => {
    if (autoTimerRef.current) {
      clearTimeout(autoTimerRef.current);
      autoTimerRef.current = null;
    }
    pendingAutoActionRef.current = null;
  }, []);

  const fetchCard = useCallback(async () => {
    if (!deckId || !mountedRef.current) return;
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setLoadError(null);
    clearTimers();
    try {
      const [cardRes, statsRes] = await Promise.all([
        getNextCard(+deckId),
        getStudyStats(+deckId),
      ]);
      if (generation !== loadGenerationRef.current) return;
      setStats(statsRes.data);
      if (!cardRes.data) {
        setCard(null);
        if (reviewedCountRef.current > 0 && !statsRes.data?.next_learning_at) {
          playCompleteSound();
        }
      } else {
        setCard(cardRes.data);
        cardStartTimeRef.current = Date.now();
        answerElapsedRef.current = null;
        setTimerSeconds(0);
      }
    } catch (err: any) {
      if (generation !== loadGenerationRef.current) return;
      setLoadError(
        err?.response?.data?.detail || 'Failed to load card. Please check your connection.'
      );
    } finally {
      if (generation === loadGenerationRef.current) {
        setLoading(false);
        setShowAnswer(false);
      }
    }
  }, [deckId, clearTimers]);

  const invalidateLoad = useCallback(() => { ++loadGenerationRef.current; }, []);
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => { if (!cancelled) fetchCard(); });
    return () => {
      cancelled = true;
      invalidateLoad();
      clearTimers();
    };
  }, [fetchCard, clearTimers, invalidateLoad]);

  // Content rendering based on rendered flag
  const cardHtml = useMemo(() => {
    if (!card) return '';
    if (!showAnswer) {
      return card.front || '';
    }
    if (card.rendered) {
      return card.back || '';
    }
    // Legacy rendered=false: compose front + <hr id="answer"> + back
    return `${card.front || ''}<hr id="answer">${card.back || ''}`;
  }, [card, showAnswer]);

  // Audio completion handler for deferred auto-action
  const handleAudioEnded = useCallback(() => {
    if (pendingAutoActionRef.current) {
      const action = pendingAutoActionRef.current;
      pendingAutoActionRef.current = null;
      action();
    }
  }, []);

  // Replay audio
  const handleReplayAudio = useCallback(() => {
    const settings = card?.settings || {};
    const skipFront = Boolean(showAnswer && settings.skip_question_when_replaying_answer);
    cardFaceRef.current?.playAudio({ skipFront });
  }, [card, showAnswer]);

  // Auto-play audio on question and answer unless disabled
  useEffect(() => {
    if (!card || loading || loadError) return;
    const settings = card.settings || {};
    if (settings.dont_play_audio_automatically) return;

    const timer = setTimeout(() => {
      const skipFront = Boolean(showAnswer && settings.skip_question_when_replaying_answer);
      cardFaceRef.current?.playAudio({ skipFront });
    }, 150);

    return () => clearTimeout(timer);
  }, [card, showAnswer, loading, loadError]);

  // On-screen timer
  useEffect(() => {
    if (!card || loading || loadError) return;
    const settings = card.settings || {};
    if (!settings.show_on_screen_timer) return;
    if (settings.stop_on_screen_timer_on_answer && showAnswer) return;

    const interval = setInterval(() => {
      setTimerSeconds(Math.min(Math.floor((Date.now() - cardStartTimeRef.current) / 1000), Number(settings.maximum_answer_seconds) || 60));
    }, 1000);

    return () => clearInterval(interval);
  }, [card, showAnswer, loading, loadError]);

  // Auto-hide leech toast
  useEffect(() => {
    if (leechToast) {
      const timer = setTimeout(() => setLeechToast(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [leechToast]);

  const handleRevealAnswer = useCallback(() => {
    if (isSubmittingRef.current || !card || loading) return;
    if (card.settings?.stop_on_screen_timer_on_answer) answerElapsedRef.current = Date.now() - cardStartTimeRef.current;
    playFlipSound();
    setShowAnswer(true);
  }, [card, loading]);

  const handleReview = useCallback(
    async (rating: number) => {
      if (isSubmittingRef.current || !card) return;
      isSubmittingRef.current = true;
      clearTimers();
      playRatingSound(rating);
      setAnimating(true);
      setReviewError(null);

      // Duration counts real card time capped by maximum_answer_seconds
      const elapsed = Math.max(0, answerElapsedRef.current ?? Date.now() - cardStartTimeRef.current);
      const maxSeconds = Number(card.settings?.maximum_answer_seconds) || 60;
      const duration_ms = maxSeconds > 0 ? Math.min(elapsed, maxSeconds * 1000) : elapsed;

      // Reuse request_id on retry for same card & rating, generate fresh otherwise
      let requestId: string;
      if (
        pendingReviewRef.current &&
        pendingReviewRef.current.cardId === card.card_id &&
        pendingReviewRef.current.rating === rating
      ) {
        requestId = pendingReviewRef.current.requestId;
      } else {
        requestId = generateUUID();
        pendingReviewRef.current = { cardId: card.card_id, rating, requestId };
      }

      const extra: ReviewExtra = {
        study_deck_id: Number(deckId),
        duration_ms,
        request_id: requestId,
        ...(card.version !== undefined ? { expected_version: card.version } : {}),
      };

      try {
        const res = await reviewCard(card.card_id, rating, extra);
        if (!mountedRef.current) return;
        pendingReviewRef.current = null;

        if (res.data?.is_leech) {
          setLeechToast(`⚠️ Leech detected! (${res.data.lapse_count} lapses)`);
        }

        reviewedCountRef.current += 1;
        setReviewedCards((prev) => {
          const next = new Set(prev);
          next.add(card.card_id);
          return next;
        });

        await fetchCard();
        setAnimating(false);
      } catch (err: any) {
        if (!mountedRef.current) return;
        setAnimating(false);
        setReviewError(err?.response?.data?.detail || 'Failed to submit review. Please try again.');
      } finally {
        isSubmittingRef.current = false;
      }
    },
    [card, deckId, clearTimers, fetchCard]
  );

  const handleCardAction = useCallback(
    async (action: 'bury' | 'suspend') => {
      if (isSubmittingRef.current || !card) return;
      isSubmittingRef.current = true;
      clearTimers();
      setAnimating(true);
      setReviewError(null);
      try {
        await cardAction(card.card_id, action, card.version);
        if (!mountedRef.current) return;
        await fetchCard();
        setAnimating(false);
      } catch (err: any) {
        if (!mountedRef.current) return;
        setAnimating(false);
        setReviewError(err?.response?.data?.detail || `Failed to ${action} card.`);
      } finally {
        isSubmittingRef.current = false;
      }
    },
    [card, clearTimers, fetchCard]
  );

  const handleUndo = useCallback(async () => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setAnimating(true);
    clearTimers();
    setReviewError(null);
    try {
      await undoReview();
      if (!mountedRef.current) return;
      pendingReviewRef.current = null;
      await fetchCard();
    } catch (err: any) {
      if (!mountedRef.current) return;
      setReviewError(err?.response?.data?.detail || 'Failed to undo review.');
    } finally {
      isSubmittingRef.current = false;
      setAnimating(false);
    }
  }, [clearTimers, fetchCard]);

  // Auto advance handling
  useEffect(() => {
    if (!card || loading || loadError || reviewError || animating) return;
    const settings = card.settings || {};
    clearTimers();

    const runAction = (actionFn: () => void) => {
      if (settings.wait_for_audio && cardFaceRef.current?.isPlaying()) {
        pendingAutoActionRef.current = actionFn;
      } else {
        actionFn();
      }
    };

    if (!showAnswer) {
      const qSeconds = Number(settings.seconds_to_show_question_for) || 0;
      if (qSeconds > 0) {
        autoTimerRef.current = setTimeout(() => {
          const qAction = String(settings.question_action || 'show_answer')
            .toLowerCase()
            .trim();
          if (qAction === 'show_answer' || qAction === 'show answer' || qAction === '') {
            runAction(handleRevealAnswer);
          } else if (qAction === 'bury' || qAction === 'bury_card' || qAction === 'bury card') {
            runAction(() => handleCardAction('bury'));
          } else {
            setReviewError(`Unsupported question action: ${settings.question_action}`);
          }
        }, qSeconds * 1000);
      }
    } else {
      const aSeconds = Number(settings.seconds_to_show_answer_for) || 0;
      if (aSeconds > 0) {
        autoTimerRef.current = setTimeout(() => {
          const aAction = String(settings.answer_action || '').toLowerCase().trim();
          const rating = ({ good: 3, hard: 2, easy: 4 } as Record<string, number>)[aAction];
          if (rating) {
            runAction(() => handleReview(rating));
          } else if (aAction === 'again' || aAction === 'answer_again' || aAction === 'answer again') {
            runAction(() => handleReview(1));
          } else if (aAction === 'bury' || aAction === 'bury_card' || aAction === 'bury card') {
            runAction(() => handleCardAction('bury'));
          } else if (
            aAction === 'suspend' ||
            aAction === 'suspend_card' ||
            aAction === 'suspend card'
          ) {
            runAction(() => handleCardAction('suspend'));
          } else {
            setReviewError(`Unsupported answer action: ${settings.answer_action}`);
          }
        }, aSeconds * 1000);
      }
    }

    return () => {
      clearTimers();
    };
  }, [card, showAnswer, loading, loadError, reviewError, animating, clearTimers, handleRevealAnswer, handleReview, handleCardAction]);

  // Bind before paint so a visible card always has current keyboard state.
  useLayoutEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isSubmittingRef.current || loading || loadError || e.repeat) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName ? target.tagName.toUpperCase() : '';
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target.isContentEditable
        ) {
          return;
        }
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        handleUndo();
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        handleReplayAudio();
        return;
      }

      if (!showAnswer) {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          handleRevealAnswer();
        }
      } else {
        if (e.key === '1') {
          e.preventDefault();
          handleReview(1);
        } else if (e.key === '2') {
          e.preventDefault();
          handleReview(2);
        } else if (e.key === '3') {
          e.preventDefault();
          handleReview(3);
        } else if (e.key === '4') {
          e.preventDefault();
          handleReview(4);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    const iframe = cardFaceRef.current?.getIframe();
    let inner: Document | null = null;
    const attach = () => {
      inner?.removeEventListener('keydown', handleKeyDown);
      inner = iframe?.contentDocument ?? null;
      inner?.addEventListener('keydown', handleKeyDown);
    };
    attach();
    iframe?.addEventListener('load', attach);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      inner?.removeEventListener('keydown', handleKeyDown);
      iframe?.removeEventListener('load', attach);
    };
  }, [showAnswer, loading, loadError, cardHtml, handleUndo, handleReplayAudio, handleRevealAnswer, handleReview]);

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
      </div>
    );
  }

  // Safe retryable load error
  if (loadError) {
    return (
      <div className="page-container">
        <div className="study-done glass-card">
          <span className="done-icon" role="img" aria-label="error">⚠️</span>
          <h2>Failed to Load Card</h2>
          <p className="error-message" style={{ color: 'var(--accent-red, #ff5555)', margin: '1rem 0' }}>
            {loadError}
          </p>
          <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
            <button className="btn btn-primary" onClick={fetchCard}>
              Retry
            </button>
            <Link to="/decks" className="btn btn-ghost">
              Back to Decks
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Waiting state when null card with next_learning_at
  if (!card && stats?.next_learning_at) {
    return (
      <div className="page-container">
        <div className="study-done glass-card">
          <span className="done-icon" role="img" aria-label="waiting">⏳</span>
          <h2>Waiting for Next Card</h2>
          <p>
            Cards are currently in learning. Next card is ready around{' '}
            <strong>{new Date(stats.next_learning_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong>.
          </p>
          <p className="done-stats">
            Cards reviewed this session: <strong>{reviewedCards.size}</strong>
          </p>
          {reviewError && <p role="alert">{reviewError}</p>}
          <button className="btn btn-ghost" disabled={animating} onClick={handleUndo}>Undo last review</button>
          <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', marginTop: '1.5rem' }}>
            <button className="btn btn-primary" onClick={fetchCard}>
              Check Again
            </button>
            <Link to="/decks" className="btn btn-ghost">
              Back to Decks
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Congratulations state
  if (!card) {
    return (
      <div className="page-container">
        <div className="study-done glass-card">
          <span className="done-icon" role="img" aria-label="party">🎉</span>
          <h1>Congratulations!</h1>
          <p>You've finished studying this deck for now.</p>
          <p className="done-stats">
            Cards reviewed: <strong>{reviewedCards.size}</strong>
          </p>
          {reviewError && <p role="alert">{reviewError}</p>}
          <button className="btn btn-ghost" disabled={animating} onClick={handleUndo}>Undo last review</button>
          <Link to="/decks" className="btn btn-primary btn-lg">
            Back to Decks
          </Link>
        </div>
      </div>
    );
  }

  const cardState = card.card_state || 'new';
  const isLearning = cardState === 'learning' || cardState === 'relearning';
  const settings = card.settings || {};

  return (
    <div className="page-container study-container">
      {/* Review Error Alert */}
      {reviewError && (
        <div
          className="alert alert-error"
          role="alert"
          style={{
            marginBottom: '1rem',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            width: '100%',
          }}
        >
          <span>{reviewError}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => { pendingReviewRef.current = null; setReviewError(null); fetchCard(); }}>Reload card</button>
          <button
            onClick={() => setReviewError(null)}
            className="btn btn-ghost btn-sm"
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}

      {/* Leech Toast Notification */}
      {leechToast && (
        <div className="leech-toast">
          <div className="leech-toast-content">{leechToast}</div>
        </div>
      )}

      <div className="study-header" style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Link to={`/decks/${deckId}`} className="btn btn-ghost btn-sm">
            ← Back
          </Link>
          <span className="study-deck-name">{card.deck_name}</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {Boolean(settings.show_on_screen_timer) && (
            <span
              className="study-timer"
              data-testid="study-timer"
              style={{
                fontFamily: 'monospace',
                fontWeight: 600,
                color: 'var(--text-secondary)',
              }}
            >
              ⏱️ {timerSeconds}s
            </span>
          )}

          <div className="study-counts">
            <span
              className="stat-new"
              style={{ color: 'var(--accent-cyan)', margin: '0 8px', fontWeight: 600 }}
            >
              {stats?.new_cards || 0}
            </span>
            <span
              className="stat-learn"
              style={{ color: 'var(--warning)', margin: '0 8px', fontWeight: 600 }}
            >
              {stats?.learn_cards || 0}
            </span>
            <span
              className="stat-due"
              style={{ color: 'var(--success)', margin: '0 8px', fontWeight: 600 }}
            >
              {stats?.due_cards || 0}
            </span>
          </div>

          <button
            onClick={handleUndo}
            className="btn btn-ghost btn-sm"
            title="Undo last review (Ctrl+Z)"
            aria-label="Undo review"
          >
            ⤺ Undo
          </button>
        </div>
      </div>

      <div
        className={`study-card-wrapper ${animating ? 'slide-out' : 'slide-in'}`}
        style={{ width: '100%', marginTop: '1rem' }}
      >
        <div className={`study-card glass-card ${showAnswer ? 'flipped' : ''}`}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '0.75rem',
            }}
          >
            <div className="card-label" style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
              {showAnswer ? 'Answer' : 'Question'}
            </div>
            <div className="card-badges" style={{ display: 'flex', gap: '0.5rem' }}>
              {card.is_new && <span className="badge badge-new">NEW</span>}
              {isLearning && (
                <span className="badge badge-learning">
                  {cardState === 'learning' ? 'LEARNING' : 'RELEARNING'}
                </span>
              )}
            </div>
          </div>

          <CardFace
            key={String(card.card_id) + ":" + String(card.version)}
            ref={cardFaceRef}
            html={cardHtml}
            frontHtml={card.front}
            backHtml={card.back}
            showAnswer={showAnswer}
            onRevealAnswer={handleRevealAnswer}
            cardCss={card.card_css}
            onAudioEnded={handleAudioEnded}
          />
        </div>
      </div>

      <div className="study-actions" style={{ width: '100%', marginTop: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <button
            onClick={handleReplayAudio}
            className="btn btn-ghost btn-sm"
            title="Replay Audio (R)"
            aria-label="Replay audio"
          >
            🔊 Replay (R)
          </button>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              disabled={animating}
              onClick={() => handleCardAction('bury')}
              className="btn btn-ghost btn-sm"
              title="Bury card until tomorrow"
            >
              Bury
            </button>
            {showAnswer && (
              <button
                disabled={animating}
              onClick={() => handleCardAction('suspend')}
                className="btn btn-ghost btn-sm"
                title="Suspend card indefinitely"
              >
                Suspend
              </button>
            )}
          </div>
        </div>

        {!showAnswer ? (
          <button
            className="btn btn-primary btn-lg btn-show-answer"
            style={{ width: '100%' }}
            onClick={handleRevealAnswer}
            disabled={animating}
          >
            Show Answer
          </button>
        ) : (
          <div className="rating-buttons" style={{ display: 'flex', gap: '0.5rem', width: '100%' }}>
            <button
              className="btn btn-rating btn-again"
              style={{ flex: 1 }}
              disabled={animating}
              onClick={() => handleReview(1)}
            >
              <span className="rating-label">Again (1)</span>
              <span className="rating-interval">{card.intervals?.again?.display || '< 1m'}</span>
            </button>
            <button
              className="btn btn-rating btn-hard"
              style={{ flex: 1 }}
              disabled={animating}
              onClick={() => handleReview(2)}
            >
              <span className="rating-label">Hard (2)</span>
              <span className="rating-interval">{card.intervals?.hard?.display || '1d'}</span>
            </button>
            <button
              className="btn btn-rating btn-good"
              style={{ flex: 1 }}
              disabled={animating}
              onClick={() => handleReview(3)}
            >
              <span className="rating-label">Good (3)</span>
              <span className="rating-interval">{card.intervals?.good?.display || '3d'}</span>
            </button>
            <button
              className="btn btn-rating btn-easy"
              style={{ flex: 1 }}
              disabled={animating}
              onClick={() => handleReview(4)}
            >
              <span className="rating-label">Easy (4)</span>
              <span className="rating-interval">{card.intervals?.easy?.display || '4d'}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default function StudyPage() {
  const { deckId } = useParams<{ deckId: string }>();
  return <StudyPageContent key={deckId} />;
}
