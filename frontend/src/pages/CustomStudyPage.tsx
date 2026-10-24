import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import CardFace, { type CardFaceRef } from '../components/CardFace';
import {
  getFilteredSessions,
  createFilteredSession,
  editFilteredSession,
  rebuildFilteredSession,
  emptyFilteredSession,
  deleteFilteredSession,
  getFilteredNextCard,
  answerFilteredCard,
  undoFilteredSession,
  type Session,
  type SessionOrder,
  type StudyCard,
  type CreateSessionPayload,
} from '../api/filtered';

const formatSeconds = (sec: number | undefined): string => {
  if (sec === undefined || sec === 0) return 'Exit';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
};

const isInputElement = (target: unknown): boolean => {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  const tag = (el.tagName || '').toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    Boolean(el.isContentEditable)
  );
};

function errorMessage(error: unknown, fallback: string): string {
  const e = error as { response?: { data?: { detail?: unknown } }; message?: string };
  const detail = e?.response?.data?.detail;
  return typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : e?.message || fallback;
}

export const CustomStudyPage = () => {
  const { sessionId: paramSessionId, id: paramId } = useParams<{ sessionId?: string; id?: string }>();
  const [searchParams] = useSearchParams();
  const urlSessionId = paramSessionId || paramId || searchParams.get('session');

  // Sessions list state
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loadingSessions, setLoadingSessions] = useState<boolean>(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  // Selected session and study state
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [card, setCard] = useState<StudyCard | null>(null);
  const [nextAvailableAt, setNextAvailableAt] = useState<string | null>(null);
  const [showAnswer, setShowAnswer] = useState<boolean>(false);
  const [loadingCard, setLoadingCard] = useState<boolean>(false);
  const [cardError, setCardError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [is409Conflict, setIs409Conflict] = useState<boolean>(false);
  const [isPending, setIsPending] = useState<boolean>(false);
  const [actionLoadingId, setActionLoadingId] = useState<number | null>(null);

  // Create session modal state
  const [editingSession, setEditingSession] = useState<Session | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState<boolean>(false);
  const [showSyntaxHelp, setShowSyntaxHelp] = useState<boolean>(false);
  const [createForm, setCreateForm] = useState<CreateSessionPayload>({
    name: '',
    search: searchParams.get('search') ?? 'is:due',
    limit: 100,
    order: 'oldest',
    reschedule: false,
    preview_again_seconds: 60,
    preview_hard_seconds: 600,
    preview_good_seconds: 0,
  });
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState<boolean>(false);

  // Concurrency & in-flight guards
  const cardFaceRef = useRef<CardFaceRef>(null);
  const isMountedRef = useRef<boolean>(true);
  const userDeselectedRef = useRef<boolean>(false);
  const activeSessionIdRef = useRef<number | null>(null);
  const selectionEpochRef = useRef(0);
  const createPendingRef = useRef(false);
  const fetchGenRef = useRef<number>(0);
  const fetchSessionsSeqRef = useRef<number>(0);
  const isSubmittingRef = useRef<boolean>(false);
  const cardStartTimeRef = useRef<number>(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Synchronous session selection & card clear
  const handleSelectSession = useCallback((session: Session) => {
    selectionEpochRef.current += 1;
    fetchGenRef.current += 1;
    userDeselectedRef.current = false;
    activeSessionIdRef.current = session.id;
    setCard(null);
    setShowAnswer(false);
    setCardError(null);
    setReviewError(null);
    setIs409Conflict(false);
    setNextAvailableAt(null);
    setSelectedSession(session);
  }, []);

  const handleBackToSessions = useCallback(() => {
    selectionEpochRef.current += 1;
    userDeselectedRef.current = true;
    activeSessionIdRef.current = null;
    ++fetchGenRef.current;
    setCard(null);
    setShowAnswer(false);
    setCardError(null);
    setReviewError(null);
    setIs409Conflict(false);
    setNextAvailableAt(null);
    setSelectedSession(null);
  }, []);

  // Load all sessions with seq guard
  const fetchSessions = useCallback(
    async (selectIdAfter?: number) => {
      const seq = ++fetchSessionsSeqRef.current;
      setLoadingSessions(true);
      setSessionsError(null);
      try {
        const res = await getFilteredSessions();
        if (!isMountedRef.current || seq !== fetchSessionsSeqRef.current) return;
        setSessions(res.data);
        if (selectIdAfter) {
          const found = res.data.find((s) => s.id === selectIdAfter);
          if (found) {
            handleSelectSession(found);
          }
        }
      } catch (err: unknown) {
        if (!isMountedRef.current || seq !== fetchSessionsSeqRef.current) return;
        const anyErr = err as { response?: { data?: { detail?: string } }; message?: string };
        setSessionsError(anyErr?.response?.data?.detail || anyErr?.message || 'Failed to load sessions');
      } finally {
        if (isMountedRef.current && seq === fetchSessionsSeqRef.current) {
          setLoadingSessions(false);
        }
      }
    },
    [handleSelectSession]
  );

  // Initial load
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void fetchSessions();
    });
    return () => {
      active = false;
    };
  }, [fetchSessions]);

  // Handle URL param selection
  useEffect(() => {
    if (urlSessionId && !userDeselectedRef.current && sessions.length > 0 && !selectedSession) {
      const targetId = parseInt(urlSessionId, 10);
      const found = sessions.find((s) => s.id === targetId);
      if (found) {
        queueMicrotask(() => {
          handleSelectSession(found);
        });
      }
    }
  }, [urlSessionId, sessions, selectedSession, handleSelectSession]);

  // Fetch next card with stale request guard
  const fetchNextCard = useCallback(async (sessionId: number) => {
    if (!isMountedRef.current || activeSessionIdRef.current !== sessionId) return;
    const gen = ++fetchGenRef.current;
    setLoadingCard(true);
    setCardError(null);
    setReviewError(null);
    setIs409Conflict(false);
    setShowAnswer(false);

    try {
      const res = await getFilteredNextCard(sessionId);
      if (!isMountedRef.current || gen !== fetchGenRef.current || activeSessionIdRef.current !== sessionId) {
        return;
      }
      setSelectedSession(res.data.session);
      setSessions((prev) =>
        prev.map((s) => (s.id === res.data.session.id ? res.data.session : s))
      );
      setCard(res.data.card);
      setNextAvailableAt(res.data.next_available_at);
      cardStartTimeRef.current = Date.now();
    } catch (err: unknown) {
      if (!isMountedRef.current || gen !== fetchGenRef.current || activeSessionIdRef.current !== sessionId) {
        return;
      }
      const anyErr = err as { response?: { status?: number; data?: { detail?: string } }; message?: string };
      if (anyErr?.response?.status === 409) {
        setIs409Conflict(true);
        setCardError(anyErr.response.data?.detail || 'Session version changed. Please reload.');
      } else {
        setCardError(anyErr?.response?.data?.detail || anyErr?.message || 'Failed to load next card');
      }
    } finally {
      if (isMountedRef.current && gen === fetchGenRef.current && activeSessionIdRef.current === sessionId) {
        setLoadingCard(false);
      }
    }
  }, []);

  // When selected session changes, fetch next card
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (selectedSession?.id) {
        void fetchNextCard(selectedSession.id);
      }
    });
    return () => {
      active = false;
    };
  }, [selectedSession?.id, fetchNextCard]);

  useEffect(() => {
    if (!selectedSession || card || !nextAvailableAt || loadingCard || isPending) return;
    const delay = Date.parse(nextAvailableAt) - Date.now();
    if (!Number.isFinite(delay)) return;
    const timer = setTimeout(() => void fetchNextCard(selectedSession.id), Math.max(250, Math.min(60000, delay)));
    return () => clearTimeout(timer);
  }, [selectedSession, card, nextAvailableAt, loadingCard, isPending, fetchNextCard]);

  // Card HTML computed according to rendered flag
  const cardHtml = useMemo(() => {
    if (!card) return '';
    if (!showAnswer) {
      return card.front || '';
    }
    if (card.rendered) {
      return card.back || '';
    }
    return `${card.front || ''}<hr id="answer">${card.back || ''}`;
  }, [card, showAnswer]);

  const handleRevealAnswer = useCallback(() => {
    if (!showAnswer && card) {
      setShowAnswer(true);
    }
  }, [showAnswer, card]);

  // Answer card handler with activeSessionId/isMounted guards and duration cap
  const handleAnswer = useCallback(
    async (rating: number) => {
      if (
        !isMountedRef.current ||
        isSubmittingRef.current ||
        isPending ||
        loadingCard ||
        !card ||
        !selectedSession
      ) {
        return;
      }
      const sid = selectedSession.id;
      const epoch = selectionEpochRef.current;
      isSubmittingRef.current = true;
      setIsPending(true);
      setReviewError(null);
      setIs409Conflict(false);

      const duration_ms = Math.min(3600000, Math.max(0, Date.now() - cardStartTimeRef.current));

      try {
        const res = await answerFilteredCard(sid, {
          expected_session_version: selectedSession.version,
          card_id: card.card_id,
          expected_version: card.version ?? 0,
          rating,
          duration_ms,
        });

        if (!isMountedRef.current || activeSessionIdRef.current !== sid || selectionEpochRef.current !== epoch) {
          return;
        }

        setSelectedSession(res.data.session);
        setSessions((prev) =>
          prev.map((s) => (s.id === res.data.session.id ? res.data.session : s))
        );

        await fetchNextCard(sid);
      } catch (err: unknown) {
        if (!isMountedRef.current || activeSessionIdRef.current !== sid || selectionEpochRef.current !== epoch) {
          return;
        }

        const anyErr = err as { response?: { status?: number; data?: { detail?: string } }; message?: string };
        const status = anyErr?.response?.status;
        const detail = anyErr?.response?.data?.detail;

        if (status === 409) {
          setIs409Conflict(true);
          setReviewError(
            `409 Conflict: ${
              detail ||
              'This session or card was modified elsewhere. Please reload to sync before continuing.'
            }`
          );
        } else {
          setReviewError(detail || anyErr?.message || 'Failed to submit review');
        }
      } finally {
        isSubmittingRef.current = false;
        if (isMountedRef.current) {
          setIsPending(false);
        }
      }
    },
    [card, selectedSession, isPending, loadingCard, fetchNextCard]
  );

  // Undo review handler with guards
  const handleUndo = useCallback(async () => {
    if (!selectedSession || isSubmittingRef.current) return;
    const sid = selectedSession.id;
    const epoch = selectionEpochRef.current;
    setIsPending(true);
    isSubmittingRef.current = true;
    setReviewError(null);
    try {
      const res = await undoFilteredSession(sid);
      if (!isMountedRef.current || activeSessionIdRef.current !== sid || selectionEpochRef.current !== epoch) return;
      setSelectedSession(res.data.session);
      setSessions((prev) =>
        prev.map((s) => (s.id === res.data.session.id ? res.data.session : s))
      );
      await fetchNextCard(sid);
    } catch (err: unknown) {
      if (!isMountedRef.current || activeSessionIdRef.current !== sid || selectionEpochRef.current !== epoch) return;
      const anyErr = err as { response?: { status?: number; data?: { detail?: string } }; message?: string };
      setReviewError(anyErr?.response?.data?.detail || anyErr?.message || 'Failed to undo review');
    } finally {
      isSubmittingRef.current = false;
      if (isMountedRef.current) {
        setIsPending(false);
      }
    }
  }, [selectedSession, fetchNextCard]);

  // Attach before paint so a quick Space press uses the displayed card.
  useLayoutEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isCreateModalOpen || e.repeat || isInputElement(e.target)) {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        void handleUndo();
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.toLowerCase() === 'r' && card) {
        e.preventDefault();
        void cardFaceRef.current?.playAudio({ skipFront: showAnswer && Boolean(card.settings?.skip_question_when_replaying_answer) });
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
          void handleAnswer(1);
        } else if (e.key === '2') {
          e.preventDefault();
          void handleAnswer(2);
        } else if (e.key === '3') {
          e.preventDefault();
          void handleAnswer(3);
        } else if (e.key === '4') {
          e.preventDefault();
          void handleAnswer(4);
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
  }, [showAnswer, card, handleRevealAnswer, handleAnswer, handleUndo, isCreateModalOpen]);

  // Session actions with stale-closure guards
  const handleRebuild = async (session: Session) => {
    const sid = session.id;
    const epoch = selectionEpochRef.current;
    setActionLoadingId(sid);
    setIsPending(true);
    setCardError(null);
    setReviewError(null);
    try {
      const res = await rebuildFilteredSession(sid, session.version);
      if (!isMountedRef.current) return;
      setSessions((prev) => prev.map((s) => (s.id === sid ? res.data : s)));
      if (activeSessionIdRef.current === sid && selectionEpochRef.current === epoch) {
        setSelectedSession(res.data);
        await fetchNextCard(sid);
      }
    } catch (err: unknown) {
      if (!isMountedRef.current || activeSessionIdRef.current !== sid || selectionEpochRef.current !== epoch) return;
      const anyErr = err as { response?: { status?: number; data?: { detail?: string } }; message?: string };
      if (anyErr?.response?.status === 409) {
        setIs409Conflict(true);
        setCardError('409 Conflict: Session changed. Please reload.');
      } else {
        setCardError(anyErr?.response?.data?.detail || anyErr?.message || 'Failed to rebuild session');
      }
    } finally {
      if (isMountedRef.current) {
        setActionLoadingId(null);
        setIsPending(false);
      }
    }
  };

  const handleEmpty = async (session: Session) => {
    const sid = session.id;
    const epoch = selectionEpochRef.current;
    setActionLoadingId(sid);
    setIsPending(true);
    setCardError(null);
    setReviewError(null);
    try {
      const res = await emptyFilteredSession(sid, session.version);
      if (!isMountedRef.current) return;
      setSessions((prev) => prev.map((s) => (s.id === sid ? res.data : s)));
      if (activeSessionIdRef.current === sid && selectionEpochRef.current === epoch) {
        setSelectedSession(res.data);
        await fetchNextCard(sid);
      }
    } catch (err: unknown) {
      if (!isMountedRef.current || activeSessionIdRef.current !== sid || selectionEpochRef.current !== epoch) return;
      const anyErr = err as { response?: { status?: number; data?: { detail?: string } }; message?: string };
      if (anyErr?.response?.status === 409) {
        setIs409Conflict(true);
        setCardError('409 Conflict: Session changed. Please reload.');
      } else {
        setCardError(anyErr?.response?.data?.detail || anyErr?.message || 'Failed to empty session');
      }
    } finally {
      if (isMountedRef.current) {
        setActionLoadingId(null);
        setIsPending(false);
      }
    }
  };

  const handleDelete = async (session: Session) => {
    const sid = session.id;
    const epoch = selectionEpochRef.current;
    if (!window.confirm(`Delete custom study session "${session.name}"?`)) {
      return;
    }
    setActionLoadingId(sid);
    setIsPending(true);
    try {
      await deleteFilteredSession(sid, session.version);
      if (!isMountedRef.current) return;
      setSessions((prev) => prev.filter((s) => s.id !== sid));
      if (activeSessionIdRef.current === sid && selectionEpochRef.current === epoch) {
        handleBackToSessions();
      }
    } catch (err: unknown) {
      if (!isMountedRef.current) return;
      const anyErr = err as { response?: { status?: number; data?: { detail?: string } }; message?: string };
      if (anyErr?.response?.status === 409) {
        setIs409Conflict(true);
        setSessionsError('409 Conflict: Session was modified. Please refresh.');
      } else {
        setSessionsError(anyErr?.response?.data?.detail || anyErr?.message || 'Failed to delete session');
      }
    } finally {
      if (isMountedRef.current) {
        setActionLoadingId(null);
        setIsPending(false);
      }
    }
  };

  const handleReloadCurrentSession = async () => {
    setIs409Conflict(false);
    setCardError(null);
    setReviewError(null);
    if (selectedSession?.id) {
      await fetchNextCard(selectedSession.id);
      await fetchSessions();
    } else {
      await fetchSessions();
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (createPendingRef.current) return;
    if (!createForm.name.trim()) {
      setCreateError('Name is required');
      return;
    }
    createPendingRef.current = true;
    setCreating(true);
    setCreateError(null);

    try {
      const payload = {
        name: createForm.name.trim(),
        search: createForm.search,
        limit: Number(createForm.limit),
        order: createForm.order || 'oldest',
        reschedule: Boolean(createForm.reschedule),
        preview_again_seconds: Number(createForm.preview_again_seconds ?? 60),
        preview_hard_seconds: Number(createForm.preview_hard_seconds ?? 600),
        preview_good_seconds: Number(createForm.preview_good_seconds ?? 0),
      };
      const res = editingSession ? await editFilteredSession(editingSession.id, editingSession.version, payload) : await createFilteredSession(payload);

      if (!isMountedRef.current) return;
      setSessions((prev) => [...prev.filter(s => s.id !== res.data.id), res.data]);
      handleSelectSession(res.data);
      setIsCreateModalOpen(false);
      setEditingSession(null);
      setCreateForm({
        name: '',
        search: 'is:due',
        limit: 100,
        order: 'oldest',
        reschedule: false,
        preview_again_seconds: 60,
        preview_hard_seconds: 600,
        preview_good_seconds: 0,
      });
    } catch (err: unknown) {
      if (isMountedRef.current) setCreateError(errorMessage(err, 'Failed to create session'));
    } finally {
      createPendingRef.current = false;
      if (isMountedRef.current) setCreating(false);
    }
  };

  const formatTime = (isoString: string) => {
    try {
      return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return isoString;
    }
  };

  return (
    <div className="page-container custom-study-container" style={{ padding: '2rem 1rem', maxWidth: '900px', margin: '0 auto' }}>
      {/* Top Header */}
      <div
        className="custom-study-header"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1.5rem',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {selectedSession && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={handleBackToSessions}
              aria-label="Back to sessions list"
            >
              ← All Sessions
            </button>
          )}
          <h1 style={{ fontSize: '1.75rem', fontWeight: 700, margin: 0 }}>
            {selectedSession ? selectedSession.name : 'Custom Study'}
          </h1>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          {!selectedSession ? (
            <button
              className="btn btn-primary"
              onClick={() => {
                setCreateError(null);
                setEditingSession(null); setIsCreateModalOpen(true);
              }}
            >
              + New Custom Study Session
            </button>
          ) : (
            <>
              <button
                className="btn btn-ghost btn-sm"
                disabled={isPending || actionLoadingId === selectedSession.id || loadingCard}
                onClick={handleUndo}
                title="Undo last review in this session (Ctrl+Z)"
              >
                ⤺ Undo
              </button>
              <button
                className="btn btn-ghost btn-sm"
                disabled={isPending || actionLoadingId === selectedSession.id || loadingCard}
                onClick={() => handleRebuild(selectedSession)}
                title="Rebuild session with fresh cards matching search criteria"
              >
                🔄 Rebuild
              </button>
              <button
                className="btn btn-ghost btn-sm"
                disabled={isPending || actionLoadingId === selectedSession.id || loadingCard}
                onClick={() => handleEmpty(selectedSession)}
                title="Empty all remaining cards from this session"
              >
                🗑️ Empty
              </button>
            </>
          )}
        </div>
      </div>

      {sessionsError && (
        <div className="alert alert-error" role="alert" style={{ marginBottom: '1rem' }}>
          {sessionsError}
        </div>
      )}

      {/* VIEW A: STUDY VIEW */}
      {selectedSession && (
        <div className="study-view-container" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          {/* Mode Warning Banner */}
          <div
            className="mode-warning-banner"
            data-testid="mode-warning"
            style={{
              width: '100%',
              padding: '0.875rem 1.25rem',
              borderRadius: 'var(--radius-md, 8px)',
              marginBottom: '1.25rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '1rem',
              background: selectedSession.reschedule
                ? 'rgba(34, 197, 94, 0.12)'
                : 'rgba(245, 158, 11, 0.12)',
              border: `1px solid ${
                selectedSession.reschedule
                  ? 'rgba(34, 197, 94, 0.3)'
                  : 'rgba(245, 158, 11, 0.3)'
              }`,
              color: selectedSession.reschedule ? '#86efac' : '#fde047',
            }}
          >
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: '0.2rem' }}>
                {selectedSession.reschedule ? 'Reschedule Mode (Active)' : 'Preview Mode (Active)'}
              </div>
              <div style={{ fontSize: '0.85rem', opacity: 0.9 }}>
                {selectedSession.reschedule
                  ? "Reviews modify scheduling and intervals in the card's original home deck. Uses 4 ratings."
                  : 'Reviews will NOT affect original card schedules. Custom delays repeat in session; Good/Easy can exit.'}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', whiteSpace: 'nowrap' }}>
              <span
                className="badge"
                style={{
                  background: 'rgba(255,255,255,0.1)',
                  padding: '0.35rem 0.75rem',
                  borderRadius: '20px',
                  fontWeight: 600,
                  fontSize: '0.8rem',
                }}
              >
                {selectedSession.remaining} remaining
              </span>
            </div>
          </div>

          <button type="button" className="btn btn-ghost" disabled={isPending || loadingCard || actionLoadingId === selectedSession.id} onClick={() => {
            setEditingSession(selectedSession);
            const { name, search, limit, order, reschedule, preview_again_seconds, preview_hard_seconds, preview_good_seconds } = selectedSession;
            setCreateForm({ name, search, limit, order, reschedule, preview_again_seconds, preview_hard_seconds, preview_good_seconds });
            setCreateError(null); setIsCreateModalOpen(true);
          }}>Edit session settings</button>
          {/* 409 Conflict Guidance or Review Error Banner */}
          {reviewError && (
            <div
              className="alert alert-error"
              role="alert"
              style={{
                width: '100%',
                marginBottom: '1rem',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '0.75rem',
              }}
            >
              <div>
                <span>{reviewError}</span>
                {is409Conflict && (
                  <div style={{ fontSize: '0.85rem', marginTop: '0.25rem', opacity: 0.9 }}>
                    Guidance: A version mismatch occurred. Please reload the session to get the latest cards.
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {is409Conflict && (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={handleReloadCurrentSession}
                    disabled={isPending}
                  >
                    Reload Session
                  </button>
                )}
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setReviewError(null)}
                  aria-label="Dismiss error"
                >
                  ✕
                </button>
              </div>
            </div>
          )}

          {cardError && (
            <div
              className="alert alert-error"
              role="alert"
              style={{
                width: '100%',
                marginBottom: '1rem',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span>{cardError}</span>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => fetchNextCard(selectedSession.id)}
                disabled={isPending}
              >
                Retry
              </button>
            </div>
          )}

          {loadingCard && !card && (
            <div className="loading-screen" style={{ minHeight: '200px' }}>
              <div className="spinner" />
            </div>
          )}

          {/* State 1: Card Available */}
          {!loadingCard && card && (
            <div className="study-card-wrapper" style={{ width: '100%' }}>
              <div className={`study-card glass-card ${showAnswer ? 'flipped' : ''}`}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '0.75rem',
                  }}
                >
                  <span className="card-label" style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
                    {showAnswer ? 'Answer' : 'Question'}
                  </span>
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                    {card.deck_name}
                  </span>
                </div>

                <CardFace
            key={String(card.card_id) + ":" + String(card.version)}
                  ref={cardFaceRef}
                  html={cardHtml}
                  cardCss={card.card_css}
                  title={card.deck_name}
                  frontHtml={card.front}
                  backHtml={card.back}
                  showAnswer={showAnswer}
            onRevealAnswer={handleRevealAnswer}
                />
              </div>

              <div className="study-actions" style={{ width: '100%', marginTop: '1.5rem' }}>
                {!showAnswer ? (
                  <button
                    className="btn btn-primary btn-lg btn-show-answer"
                    style={{ width: '100%' }}
                    onClick={handleRevealAnswer}
                    disabled={isPending || loadingCard}
                  >
                    Show Answer (Space)
                  </button>
                ) : (
                  /* 4 Rating Buttons (Active in both Preview and Reschedule) */
                  <div
                    className="rating-buttons"
                    data-testid={selectedSession.reschedule ? 'reschedule-rating-buttons' : 'preview-rating-buttons'}
                    style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem', width: '100%' }}
                  >
                    <button
                      className="btn btn-rating btn-again"
                      disabled={isPending || loadingCard}
                      onClick={() => handleAnswer(1)}
                    >
                      <span className="rating-label">Again (1)</span>
                      <span className="rating-interval">
                        {selectedSession.reschedule
                          ? card.intervals?.again?.display || '< 1m'
                          : formatSeconds(selectedSession.preview_again_seconds ?? 60)}
                      </span>
                    </button>
                    <button
                      className="btn btn-rating btn-hard"
                      disabled={isPending || loadingCard}
                      onClick={() => handleAnswer(2)}
                    >
                      <span className="rating-label">Hard (2)</span>
                      <span className="rating-interval">
                        {selectedSession.reschedule
                          ? card.intervals?.hard?.display || '1d'
                          : formatSeconds(selectedSession.preview_hard_seconds ?? 600)}
                      </span>
                    </button>
                    <button
                      className="btn btn-rating btn-good"
                      disabled={isPending || loadingCard}
                      onClick={() => handleAnswer(3)}
                    >
                      <span className="rating-label">Good (3)</span>
                      <span className="rating-interval">
                        {selectedSession.reschedule
                          ? card.intervals?.good?.display || '3d'
                          : formatSeconds(selectedSession.preview_good_seconds ?? 0)}
                      </span>
                    </button>
                    <button
                      className="btn btn-rating btn-easy"
                      disabled={isPending || loadingCard}
                      onClick={() => handleAnswer(4)}
                    >
                      <span className="rating-label">Easy (4)</span>
                      <span className="rating-interval">
                        {selectedSession.reschedule
                          ? card.intervals?.easy?.display || '4d'
                          : 'Exit'}
                      </span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* State 2: Waiting For Next Available Card */}
          {!loadingCard && !card && nextAvailableAt && (
            <div className="study-done glass-card" style={{ width: '100%', textAlign: 'center', padding: '2.5rem' }}>
              <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>⏳</div>
              <h2 style={{ fontSize: '1.4rem', marginBottom: '0.5rem' }}>Cards are waiting</h2>
              <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
                No cards are ready right now. The next card repeats at{' '}
                <strong style={{ color: 'var(--accent-cyan)' }}>{formatTime(nextAvailableAt)}</strong>.
              </p>
              <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
                <button
                  className="btn btn-primary"
                  onClick={() => fetchNextCard(selectedSession.id)}
                  disabled={isPending}
                >
                  Check Now
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => handleRebuild(selectedSession)}
                  disabled={isPending}
                >
                  Rebuild Session
                </button>
              </div>
            </div>
          )}

          {/* State 3: Session Complete */}
          {!loadingCard && !card && !nextAvailableAt && (
            <div className="study-done glass-card" style={{ width: '100%', textAlign: 'center', padding: '2.5rem' }}>
              <div style={{ fontSize: '3.5rem', marginBottom: '1rem' }}>🎉</div>
              <h2 style={{ fontSize: '1.4rem', marginBottom: '0.5rem' }}>{selectedSession.remaining > 0 ? 'No cards available' : 'Custom Study Complete!'}</h2>
              <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
                {selectedSession.remaining > 0 ? 'Remaining cards are suspended or buried. You can empty the session to return them to regular study.' : 'You have finished all cards in this filtered session.'}
              </p>
              <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
                <button
                  className="btn btn-primary"
                  onClick={() => handleRebuild(selectedSession)}
                  disabled={isPending}
                >
                  Rebuild Session
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => handleEmpty(selectedSession)}
                  disabled={isPending}
                >
                  Empty Session
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={handleBackToSessions}
                  disabled={isPending}
                >
                  Back to Sessions
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* VIEW B: SESSIONS LIST VIEW */}
      {!selectedSession && (
        <div className="sessions-list-view">
          {loadingSessions && (
            <div className="loading-screen" style={{ minHeight: '200px' }}>
              <div className="spinner" />
            </div>
          )}

          {!loadingSessions && sessions.length === 0 && (
            <div className="glass-card empty-state" style={{ textAlign: 'center', padding: '3rem 2rem' }}>
              <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📚</div>
              <h2 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>No Custom Study Sessions</h2>
              <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
                Create a filtered session to study specific tags, due cards, or review ahead without altering your deck structure.
              </p>
              <button
                className="btn btn-primary"
                onClick={() => { setEditingSession(null); setIsCreateModalOpen(true); }}
              >
                Create Filtered Session
              </button>
            </div>
          )}

          {!loadingSessions && sessions.length > 0 && (
            <div className="sessions-grid" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {sessions.map((session) => (
                <div
                  key={session.id}
                  className="session-card glass-card"
                  style={{
                    padding: '1.25rem 1.5rem',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: '1rem',
                  }}
                >
                  <div style={{ flex: 1, minWidth: '240px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.35rem' }}>
                      <h3 style={{ fontSize: '1.15rem', fontWeight: 600, margin: 0 }}>
                        {session.name}
                      </h3>
                      <span
                        className="badge"
                        style={{
                          background: session.reschedule
                            ? 'rgba(34, 197, 94, 0.15)'
                            : 'rgba(245, 158, 11, 0.15)',
                          color: session.reschedule ? '#86efac' : '#fde047',
                          padding: '0.2rem 0.6rem',
                          borderRadius: '12px',
                          fontSize: '0.75rem',
                          fontWeight: 600,
                        }}
                      >
                        {session.reschedule ? 'Reschedule' : 'Preview'}
                      </span>
                      <span
                        className="badge"
                        style={{
                          background: 'rgba(0, 212, 255, 0.15)',
                          color: 'var(--accent-cyan)',
                          padding: '0.2rem 0.6rem',
                          borderRadius: '12px',
                          fontSize: '0.75rem',
                          fontWeight: 600,
                        }}
                      >
                        {session.remaining} remaining
                      </span>
                    </div>

                    <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                      <span>Search: <code style={{ color: 'var(--accent-cyan)' }}>{session.search}</code></span>
                      <span style={{ margin: '0 0.5rem' }}>•</span>
                      <span>Limit: {session.limit}</span>
                      <span style={{ margin: '0 0.5rem' }}>•</span>
                      <span>Order: {session.order}</span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => handleSelectSession(session)}
                      disabled={actionLoadingId === session.id}
                    >
                      Study
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={isPending || actionLoadingId === session.id}
                      onClick={() => handleRebuild(session)}
                      title="Rebuild session"
                    >
                      Rebuild
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={isPending || actionLoadingId === session.id}
                      onClick={() => handleEmpty(session)}
                      title="Empty session"
                    >
                      Empty
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={isPending || actionLoadingId === session.id}
                      onClick={() => handleDelete(session)}
                      title="Delete session"
                      style={{ color: 'var(--danger)' }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* CREATE SESSION MODAL */}
      {isCreateModalOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal glass-card" style={{ maxWidth: '580px', maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 style={{ fontSize: '1.35rem', fontWeight: 700, marginBottom: '1.25rem' }}>
              {editingSession ? 'Edit Custom Study Session' : 'Create Custom Study Session'}
            </h2>

            {createError && (
              <div className="alert alert-error" role="alert" style={{ marginBottom: '1rem' }}>
                {createError}
              </div>
            )}

            <form onSubmit={handleCreateSubmit}>
              <fieldset disabled={creating} style={{border: 0, padding: 0, minWidth: 0}}>
              <div className="form-group" style={{ marginBottom: '1rem' }}>
                <label htmlFor="custom-study-name" style={{ display: 'block', marginBottom: '0.35rem', fontWeight: 500 }}>
                  Session Name *
                </label>
                <input
                  id="custom-study-name"
                  type="text"
                  required
                  placeholder="e.g. Cramming Biology"
                  value={createForm.name}
                  onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                />
              </div>

              <div className="form-group" style={{ marginBottom: '1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
                  <label htmlFor="custom-study-search" style={{ fontWeight: 500, margin: 0 }}>
                    Search Query
                  </label>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: '0.8rem', padding: '0.2rem 0.5rem' }}
                    onClick={() => setShowSyntaxHelp((prev) => !prev)}
                  >
                    {showSyntaxHelp ? 'Hide Syntax Guide' : 'Supported Syntax Guide'}
                  </button>
                </div>

                <input
                  id="custom-study-search"
                  type="text"
                  placeholder="e.g. is:due or tag:exam"
                  value={createForm.search}
                  onChange={(e) => setCreateForm({ ...createForm, search: e.target.value })}
                />

                {showSyntaxHelp && (
                  <div
                    style={{
                      background: 'rgba(0,0,0,0.3)',
                      padding: '0.75rem 1rem',
                      borderRadius: 'var(--radius-sm, 6px)',
                      marginTop: '0.5rem',
                      fontSize: '0.8rem',
                      lineHeight: 1.6,
                      border: '1px solid var(--glass-border)',
                    }}
                  >
                    <div style={{ fontWeight: 600, color: 'var(--accent-cyan)', marginBottom: '0.3rem' }}>
                      Supported Search Syntax:
                    </div>
                    <div><code>is:due</code> — Cards currently due for review (default)</div>
                    <div><code>is:new</code>, <code>is:learn</code>, <code>is:review</code>, <code>is:suspended</code>, <code>is:buried</code></div>
                    <div><code>deck:"Deck Name"</code> — Filter by deck</div>
                    <div><code>tag:tagname</code> or <code>tag:none</code> — Tag filter</div>
                    <div><code>note:"Note Type"</code> — Note model</div>
                    <div><code>cid:1,2,3</code> or <code>nid:1,2,3</code> — Card or note IDs</div>
                    <div><code>prop:ivl&gt;10</code>, <code>prop:reps=0</code>, <code>prop:lapses&gt;=1</code> — Intervals, reps, lapses</div>
                    <div>Operators: <code>AND</code>, <code>OR</code>, <code>-negation</code>, <code>(groups)</code>, <code>"quoted terms"</code></div>
                  </div>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label htmlFor="custom-study-limit" style={{ display: 'block', marginBottom: '0.35rem', fontWeight: 500 }}>
                    Card Limit (1–1000)
                  </label>
                  <input
                    id="custom-study-limit"
                    type="number"
                    min="1"
                    max="1000"
                    value={createForm.limit}
                    onChange={(e) =>
                      setCreateForm({ ...createForm, limit: Math.max(1, Math.min(1000, parseInt(e.target.value, 10) || 1)) })
                    }
                  />
                </div>

                <div className="form-group" style={{ margin: 0 }}>
                  <label htmlFor="custom-study-order" style={{ display: 'block', marginBottom: '0.35rem', fontWeight: 500 }}>
                    Order
                  </label>
                  <select
                    id="custom-study-order"
                    value={createForm.order}
                    onChange={(e) =>
                      setCreateForm({ ...createForm, order: e.target.value as SessionOrder })
                    }
                  >
                    <option value="oldest">Oldest first</option>
                    <option value="newest">Newest first</option>
                    <option value="random">Random</option>
                    <option value="due">Due date</option>
                    <option value="lapses">Most lapses</option>
                  </select>
                </div>
              </div>

              {/* Mode Selection */}
              <div className="form-group" style={{ marginBottom: '1.25rem' }}>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>
                  Study Mode & Schedule Impact *
                </label>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.75rem',
                      padding: '0.75rem 1rem',
                      borderRadius: 'var(--radius-sm, 6px)',
                      background: !createForm.reschedule ? 'rgba(245, 158, 11, 0.1)' : 'rgba(255,255,255,0.03)',
                      border: `1px solid ${!createForm.reschedule ? 'rgba(245, 158, 11, 0.4)' : 'var(--glass-border)'}`,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="radio"
                      name="study-mode"
                      value="preview"
                      checked={!createForm.reschedule}
                      onChange={() => setCreateForm({ ...createForm, reschedule: false })}
                      style={{ marginTop: '0.2rem' }}
                    />
                    <div>
                      <div style={{ fontWeight: 600, color: !createForm.reschedule ? '#fde047' : 'var(--text-primary)' }}>
                        Preview Mode (No Schedule Impact)
                      </div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
                        Does <strong>NOT</strong> change card due dates or intervals in home decks.
                        Uses custom repeat delays; Good/Easy can exit without home-deck rescheduling.
                      </div>
                    </div>
                  </label>

                  {/* Configurable 3 Delays (Preview mode) */}
                  {!createForm.reschedule && (
                    <div
                      data-testid="preview-delays-panel"
                      style={{
                        padding: '0.75rem 1rem',
                        background: 'rgba(0,0,0,0.25)',
                        borderRadius: 'var(--radius-sm, 6px)',
                        border: '1px dashed rgba(245, 158, 11, 0.3)',
                        display: 'grid',
                        gridTemplateColumns: 'repeat(3, 1fr)',
                        gap: '0.75rem',
                      }}
                    >
                      <div className="form-group" style={{ margin: 0 }}>
                        <label htmlFor="preview-again-sec" style={{ fontSize: '0.75rem', fontWeight: 500, display: 'block', marginBottom: '0.25rem' }}>
                          Again Delay (s)
                        </label>
                        <input
                          id="preview-again-sec"
                          type="number"
                          min="0"
                          max="86400"
                          value={createForm.preview_again_seconds ?? 60}
                          onChange={(e) =>
                            setCreateForm({
                              ...createForm,
                              preview_again_seconds: Math.max(0, Math.min(86400, parseInt(e.target.value, 10) || 0)),
                            })
                          }
                          style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                        />
                      </div>
                      <div className="form-group" style={{ margin: 0 }}>
                        <label htmlFor="preview-hard-sec" style={{ fontSize: '0.75rem', fontWeight: 500, display: 'block', marginBottom: '0.25rem' }}>
                          Hard Delay (s)
                        </label>
                        <input
                          id="preview-hard-sec"
                          type="number"
                          min="0"
                          max="86400"
                          value={createForm.preview_hard_seconds ?? 600}
                          onChange={(e) =>
                            setCreateForm({
                              ...createForm,
                              preview_hard_seconds: Math.max(0, Math.min(86400, parseInt(e.target.value, 10) || 0)),
                            })
                          }
                          style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                        />
                      </div>
                      <div className="form-group" style={{ margin: 0 }}>
                        <label htmlFor="preview-good-sec" style={{ fontSize: '0.75rem', fontWeight: 500, display: 'block', marginBottom: '0.25rem' }}>
                          Good Delay (0=Exit)
                        </label>
                        <input
                          id="preview-good-sec"
                          type="number"
                          min="0"
                          max="86400"
                          value={createForm.preview_good_seconds ?? 0}
                          onChange={(e) =>
                            setCreateForm({
                              ...createForm,
                              preview_good_seconds: Math.max(0, Math.min(86400, parseInt(e.target.value, 10) || 0)),
                            })
                          }
                          style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                        />
                      </div>
                    </div>
                  )}

                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.75rem',
                      padding: '0.75rem 1rem',
                      borderRadius: 'var(--radius-sm, 6px)',
                      background: createForm.reschedule ? 'rgba(34, 197, 94, 0.1)' : 'rgba(255,255,255,0.03)',
                      border: `1px solid ${createForm.reschedule ? 'rgba(34, 197, 94, 0.4)' : 'var(--glass-border)'}`,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="radio"
                      name="study-mode"
                      value="reschedule"
                      checked={Boolean(createForm.reschedule)}
                      onChange={() => setCreateForm({ ...createForm, reschedule: true })}
                      style={{ marginTop: '0.2rem' }}
                    />
                    <div>
                      <div style={{ fontWeight: 600, color: createForm.reschedule ? '#86efac' : 'var(--text-primary)' }}>
                        Reschedule Mode (Alters Home Deck Schedules)
                      </div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
                        <strong>WILL</strong> modify card intervals and due dates in home decks.
                        Uses standard 4 ratings (Again, Hard, Good, Easy) based on deck scheduling options.
                      </div>
                    </div>
                  </label>
                </div>
              </div>

              <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setIsCreateModalOpen(false)}
                  disabled={creating}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={creating}
                >
                  {creating ? 'Saving...' : editingSession ? 'Save & Rebuild Session' : 'Create & Build Session'}
                </button>
              </div>
              </fieldset>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default CustomStudyPage;
