import { useState, useEffect, useRef, useCallback } from 'react';
import { listDecks } from '../api/decks';
import type { Deck } from '../api/decks';
import { getStats } from '../api/stats';
import type { StatsResponse } from '../api/stats';

const RANGES = [
  { label: '7 Days', days: 7 },
  { label: '30 Days', days: 30 },
  { label: '90 Days', days: 90 },
  { label: '1 Year', days: 365 },
];

const formatDuration = (seconds: number): string => {
  if (!seconds || seconds <= 0) return '0s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const rounded = Math.round(seconds);
  const mins = Math.floor(rounded / 60);
  const secs = rounded % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  return `${(seconds / 3600).toFixed(1)}h`;
};

export const StatsPage = () => {
  const [days, setDays] = useState<number>(30);
  const [deckId, setDeckId] = useState<number | null>(null);
  const [decks, setDecks] = useState<Deck[]>([]);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const reqSeqRef = useRef<number>(0);
  const abortRef = useRef<AbortController | null>(null);

  const [deckError, setDeckError] = useState(false);
  const [deckRetry, setDeckRetry] = useState(0);
  useEffect(() => {
    let active = true;
    listDecks()
      .then((res) => { if (active) { setDecks(res.data || []); setDeckError(false); } })
      .catch(() => { if (active) setDeckError(true); });
    return () => { active = false; };
  }, [deckRetry]);

  const fetchStats = useCallback((queryDays: number, queryDeckId: number | null) => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++reqSeqRef.current;

    setLoading(true);
    setError(null);

    getStats(queryDays, queryDeckId, controller.signal)
      .then((res) => {
        if (!controller.signal.aborted && seq === reqSeqRef.current) {
          setStats(res.data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (controller.signal.aborted || seq !== reqSeqRef.current) return;
        setError(err.response?.data?.detail || err.message || 'Failed to load statistics');
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) fetchStats(days, deckId); });
    return () => {
      active = false;
      if (abortRef.current) abortRef.current.abort();
      reqSeqRef.current += 1;
    };
  }, [days, deckId, fetchStats]);

  const maxForecast = stats ? Math.max(1, ...stats.forecast.map((f) => f.cards)) : 1;
  const maxHistory = stats ? Math.max(1, ...stats.history.map((h) => h.reviews)) : 1;

  return (
    <div className="page-container" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1>Statistics</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Collection performance, forecasts, and review history</p>
        </div>
        <div className="header-actions" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label htmlFor="deck-selector" className="sr-only" style={{ display: 'none' }}>Select Deck</label>
            <select
              id="deck-selector"
              aria-label="Filter statistics by deck"
              value={deckId ?? ''}
              onChange={(e) => setDeckId(e.target.value === '' ? null : Number(e.target.value))}
              style={{ padding: '0.45rem 0.85rem', borderRadius: 'var(--radius-sm)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--glass-border)' }}
            >
              <option value="">All Decks (Collection)</option>
              {decks.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
          <div role="group" aria-label="Time range selector" style={{ display: 'flex', gap: '0.25rem' }}>
            {RANGES.map((r) => (
              <button
                key={r.days}
                type="button"
                className={`btn btn-sm ${days === r.days ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setDays(r.days)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {deckError && <div role="alert">Could not load the deck list. <button className="btn btn-sm" onClick={() => setDeckRetry(n => n + 1)}>Retry deck list</button></div>}
      {loading && (
        <div className="loading-screen" role="status" aria-label="Loading statistics...">
          <div className="spinner" />
        </div>
      )}

      {error && !loading && (
        <div className="alert alert-error" role="alert" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{error}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => fetchStats(days, deckId)}>Retry</button>
        </div>
      )}

      {!loading && !error && stats && (
        <>
          <div className="stats-grid">
            <div className="stat-card glass-card">
              <span className="stat-value">{stats.summary.reviews}</span>
              <span className="stat-label">Reviews ({stats.summary.active_days} active days)</span>
            </div>
            <div className="stat-card glass-card">
              <span className="stat-value">{formatDuration(stats.summary.seconds)}</span>
              <span className="stat-label">
                Study Time ({stats.summary.seconds_per_review !== null ? `${stats.summary.seconds_per_review}s / review` : 'N/A'})
              </span>
            </div>
            <div className="stat-card glass-card">
              <span className="stat-value">
                {stats.summary.review_recall_percent !== null ? `${stats.summary.review_recall_percent}%` : 'N/A'}
              </span>
              <span className="stat-label" title="Recorded review-state answers only; excludes learning steps">
                Review Recall ({stats.summary.remembered}/{stats.summary.review_attempts})*
              </span>
            </div>
            <div className="stat-card glass-card">
              <span className="stat-value">{stats.counts.total}</span>
              <span className="stat-label">Cards ({stats.counts.notes} notes)</span>
            </div>
          </div>

          <div className="glass-card" style={{ padding: '1.25rem' }}>
            <h2 style={{ fontSize: '1.2rem', marginBottom: '0.75rem' }}>Card Counts by State</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
              <div style={{ padding: '0.75rem', background: 'var(--surface)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ color: 'var(--new-color)', fontWeight: 600 }}>New</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>{stats.counts.new}</div>
              </div>
              <div style={{ padding: '0.75rem', background: 'var(--surface)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ color: 'var(--hard-color)', fontWeight: 600 }}>Learning</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>{stats.counts.learning}</div>
              </div>
              <div style={{ padding: '0.75rem', background: 'var(--surface)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ color: 'var(--accent-cyan)', fontWeight: 600 }}>Young (&lt;21d)</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>{stats.counts.young}</div>
              </div>
              <div style={{ padding: '0.75rem', background: 'var(--surface)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ color: 'var(--good-color)', fontWeight: 600 }}>Mature (≥21d)</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>{stats.counts.mature}</div>
              </div>
            </div>
            <p style={{ fontSize: '0.825rem', color: 'var(--text-secondary)', background: 'var(--surface)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', margin: 0 }}>
              <strong>Notice:</strong> Suspended (<strong>{stats.counts.suspended}</strong>) and Buried (<strong>{stats.counts.buried}</strong>) cards are overlapping flags, not mutually exclusive categories.
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: '1.25rem' }}>
            <div className="glass-card" style={{ padding: '1.25rem' }}>
              <h2 style={{ fontSize: '1.2rem', marginBottom: '0.25rem' }}>Review Intervals</h2>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>Distribution of intervals for review cards</p>
              <table className="browse-table" aria-label="Review card interval distribution" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th scope="col">Interval</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Cards</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.intervals.map((bucket) => {
                    const reviewCards = stats.counts.young + stats.counts.mature;
                    const share = reviewCards > 0 ? ((bucket.count / reviewCards) * 100).toFixed(1) : null;
                    return (
                      <tr key={bucket.label}>
                        <td>{bucket.label}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{bucket.count}</td>
                        <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{share !== null ? `${share}%` : 'N/A'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="glass-card" style={{ padding: '1.25rem' }}>
              <h2 style={{ fontSize: '1.2rem', marginBottom: '0.25rem' }}>Upcoming Due Forecast</h2>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>Estimate based on current schedule; not a fixed promise.</p>
              <div style={{ maxHeight: '240px', overflow: 'auto' }}>
                <table className="browse-table" aria-label="Due card forecast" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th scope="col">Timeline</th>
                      <th scope="col" style={{ textAlign: 'right' }}>Due</th>
                      <th scope="col" aria-hidden="true" style={{ width: '40%' }}>Bar</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.forecast.map((f) => (
                      <tr key={f.day}>
                        <td>{f.day === 0 ? 'Today / Overdue' : `+${f.day}d`}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{f.cards}</td>
                        <td aria-hidden="true">
                          <div style={{ background: 'var(--surface)', height: '8px', borderRadius: '4px', overflow: 'hidden' }}>
                            <div style={{ width: `${(f.cards / maxForecast) * 100}%`, height: '100%', background: 'var(--accent-cyan)' }} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="glass-card" style={{ padding: '1.25rem' }}>
            <h2 style={{ fontSize: '1.2rem', marginBottom: '0.25rem' }}>Daily Review History</h2>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
              Past {days} days activity based on deck study-day clock
            </p>
            {stats.summary.reviews === 0 ? (
              <div style={{ textAlign: 'center', padding: '1.5rem', color: 'var(--text-muted)' }}>
                No review logs recorded in this timeframe.
              </div>
            ) : (
              <div style={{ maxHeight: '280px', overflow: 'auto' }}>
                <table className="browse-table" aria-label="Review activity history" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th scope="col">Day</th>
                      <th scope="col" style={{ textAlign: 'right' }}>Total</th>
                      <th scope="col" style={{ textAlign: 'right' }}>Time</th>
                      <th scope="col" style={{ textAlign: 'right', color: 'var(--again-color)' }}>Again</th>
                      <th scope="col" style={{ textAlign: 'right', color: 'var(--hard-color)' }}>Hard</th>
                      <th scope="col" style={{ textAlign: 'right', color: 'var(--good-color)' }}>Good</th>
                      <th scope="col" style={{ textAlign: 'right', color: 'var(--easy-color)' }}>Easy</th>
                      <th scope="col" aria-hidden="true" style={{ width: '25%' }}>Volume</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.history.filter((h) => h.reviews > 0).map((h) => (
                      <tr key={h.day}>
                        <td>{h.day === 0 ? 'Today' : `${h.day}d`}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{h.reviews}</td>
                        <td style={{ textAlign: 'right' }}>{formatDuration(h.seconds)}</td>
                        <td style={{ textAlign: 'right' }}>{h.again}</td>
                        <td style={{ textAlign: 'right' }}>{h.hard}</td>
                        <td style={{ textAlign: 'right' }}>{h.good}</td>
                        <td style={{ textAlign: 'right' }}>{h.easy}</td>
                        <td aria-hidden="true">
                          <div style={{ background: 'var(--surface)', height: '8px', borderRadius: '4px', overflow: 'hidden' }}>
                            <div style={{ width: `${(h.reviews / maxHistory) * 100}%`, height: '100%', background: 'var(--accent-gradient-h)' }} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            <div><strong>Day clock:</strong> {stats.day_basis}</div>
            <div><strong>Forecast note:</strong> {stats.forecast_basis}</div>
            <div><strong>Recall note:</strong> {stats.recall_basis}</div>
          </div>
        </>
      )}
    </div>
  );
};

export default StatsPage;
