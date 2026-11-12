import { useState, useEffect, useRef, useCallback } from 'react';
import { listDecks } from '../api/decks';
import type { Deck } from '../api/decks';
import { getStats } from '../api/stats';
import type { StatsResponse } from '../api/stats';
import { usePrefs } from '../context/usePrefs';
import { tNow } from '../context/prefs-context-base';

const RANGES = [
  { label: 'stats.range7', days: 7 },
  { label: 'stats.range30', days: 30 },
  { label: 'stats.range90', days: 90 },
  { label: 'stats.range365', days: 365 },
] as const;

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
  const { t } = usePrefs();
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
        setError(err.response?.data?.detail || err.message || tNow('stats.loadFailed'));
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
          <h1>{t('stats.title')}</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{t('stats.subtitle')}</p>
        </div>
        <div className="header-actions" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label htmlFor="deck-selector" className="sr-only" style={{ display: 'none' }}>{t('stats.selectDeck')}</label>
            <select
              id="deck-selector"
              aria-label={t('stats.filterByDeck')}
              value={deckId ?? ''}
              onChange={(e) => setDeckId(e.target.value === '' ? null : Number(e.target.value))}
              style={{ padding: '0.45rem 0.85rem', borderRadius: 'var(--radius-sm)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--glass-border)' }}
            >
              <option value="">{t('stats.allDecks')}</option>
              {decks.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
          <div role="group" aria-label={t('stats.timeRange')} style={{ display: 'flex', gap: '0.25rem' }}>
            {RANGES.map((r) => (
              <button
                key={r.days}
                type="button"
                className={`btn btn-sm ${days === r.days ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setDays(r.days)}
              >
                {t(r.label)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {deckError && <div role="alert">{t('stats.deckListFailed')} <button className="btn btn-sm" onClick={() => setDeckRetry(n => n + 1)}>{t('stats.retryDeckList')}</button></div>}
      {loading && (
        <div className="loading-screen" role="status" aria-label={t('stats.loading')}>
          <div className="spinner" />
        </div>
      )}

      {error && !loading && (
        <div className="alert alert-error" role="alert" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{error}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => fetchStats(days, deckId)}>{t('common.retry')}</button>
        </div>
      )}

      {!loading && !error && stats && (
        <>
          <div className="stats-grid">
            <div className="stat-card glass-card">
              <span className="stat-value">{stats.summary.reviews}</span>
              <span className="stat-label">{t('stats.reviews', { days: stats.summary.active_days })}</span>
            </div>
            <div className="stat-card glass-card">
              <span className="stat-value">{formatDuration(stats.summary.seconds)}</span>
              <span className="stat-label">
                {t('stats.studyTime')} ({stats.summary.seconds_per_review !== null ? t('stats.perReview', { s: stats.summary.seconds_per_review }) : t('common.na')})
              </span>
            </div>
            <div className="stat-card glass-card">
              <span className="stat-value">
                {stats.summary.review_recall_percent !== null ? `${stats.summary.review_recall_percent}%` : t('common.na')}
              </span>
              <span className="stat-label" title={t('stats.recallTitle')}>
                {t('stats.recall')} ({stats.summary.remembered}/{stats.summary.review_attempts})*
              </span>
            </div>
            <div className="stat-card glass-card">
              <span className="stat-value">{stats.counts.total}</span>
              <span className="stat-label">{t('stats.cards', { notes: stats.counts.notes })}</span>
            </div>
          </div>

          <div className="glass-card" style={{ padding: '1.25rem' }}>
            <h2 style={{ fontSize: '1.2rem', marginBottom: '0.75rem' }}>{t('stats.countsByState')}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
              <div style={{ padding: '0.75rem', background: 'var(--surface)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ color: 'var(--new-color)', fontWeight: 600 }}>{t('stat.new')}</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>{stats.counts.new}</div>
              </div>
              <div style={{ padding: '0.75rem', background: 'var(--surface)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ color: 'var(--hard-color)', fontWeight: 600 }}>{t('stats.learning')}</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>{stats.counts.learning}</div>
              </div>
              <div style={{ padding: '0.75rem', background: 'var(--surface)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ color: 'var(--accent-cyan)', fontWeight: 600 }}>{t('stats.young')}</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>{stats.counts.young}</div>
              </div>
              <div style={{ padding: '0.75rem', background: 'var(--surface)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ color: 'var(--good-color)', fontWeight: 600 }}>{t('stats.mature')}</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>{stats.counts.mature}</div>
              </div>
            </div>
            <p style={{ fontSize: '0.825rem', color: 'var(--text-secondary)', background: 'var(--surface)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', margin: 0 }}>
              <strong>{t('stats.notice')}</strong> {t('stats.suspended')} (<strong>{stats.counts.suspended}</strong>) {t('stats.and')} {t('stats.buried')} (<strong>{stats.counts.buried}</strong>) {t('stats.overlap')}
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: '1.25rem' }}>
            <div className="glass-card" style={{ padding: '1.25rem' }}>
              <h2 style={{ fontSize: '1.2rem', marginBottom: '0.25rem' }}>{t('stats.intervals')}</h2>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>{t('stats.intervalsHint')}</p>
              <table className="browse-table" aria-label={t('stats.intervalsAria')} style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th scope="col">{t('stats.interval')}</th>
                    <th scope="col" style={{ textAlign: 'right' }}>{t('stats.cardsCol')}</th>
                    <th scope="col" style={{ textAlign: 'right' }}>{t('stats.share')}</th>
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
                        <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{share !== null ? `${share}%` : t('common.na')}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="glass-card" style={{ padding: '1.25rem' }}>
              <h2 style={{ fontSize: '1.2rem', marginBottom: '0.25rem' }}>{t('stats.forecast')}</h2>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>{t('stats.forecastHint')}</p>
              <div style={{ maxHeight: '240px', overflow: 'auto' }}>
                <table className="browse-table" aria-label={t('stats.forecastAria')} style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th scope="col">{t('stats.timeline')}</th>
                      <th scope="col" style={{ textAlign: 'right' }}>{t('stat.due')}</th>
                      <th scope="col" aria-hidden="true" style={{ width: '40%' }}>Bar</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.forecast.map((f) => (
                      <tr key={f.day}>
                        <td>{f.day === 0 ? t('stats.todayOverdue') : `+${f.day}d`}</td>
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
            <h2 style={{ fontSize: '1.2rem', marginBottom: '0.25rem' }}>{t('stats.history')}</h2>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
              {t('stats.historyHint', { days })}
            </p>
            {stats.summary.reviews === 0 ? (
              <div style={{ textAlign: 'center', padding: '1.5rem', color: 'var(--text-muted)' }}>
                {t('stats.noLogs')}
              </div>
            ) : (
              <div style={{ maxHeight: '280px', overflow: 'auto' }}>
                <table className="browse-table" aria-label={t('stats.historyAria')} style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th scope="col">{t('stats.day')}</th>
                      <th scope="col" style={{ textAlign: 'right' }}>{t('stat.total')}</th>
                      <th scope="col" style={{ textAlign: 'right' }}>{t('stats.time')}</th>
                      <th scope="col" style={{ textAlign: 'right', color: 'var(--again-color)' }}>{t('rate.again')}</th>
                      <th scope="col" style={{ textAlign: 'right', color: 'var(--hard-color)' }}>{t('rate.hard')}</th>
                      <th scope="col" style={{ textAlign: 'right', color: 'var(--good-color)' }}>{t('rate.good')}</th>
                      <th scope="col" style={{ textAlign: 'right', color: 'var(--easy-color)' }}>{t('rate.easy')}</th>
                      <th scope="col" aria-hidden="true" style={{ width: '25%' }}>Volume</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.history.filter((h) => h.reviews > 0).map((h) => (
                      <tr key={h.day}>
                        <td>{h.day === 0 ? t('stats.today') : `${h.day}d`}</td>
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
            <div><strong>{t('stats.dayClock')}</strong> {stats.day_basis}</div>
            <div><strong>{t('stats.forecastNote')}</strong> {stats.forecast_basis}</div>
            <div><strong>{t('stats.recallNote')}</strong> {stats.recall_basis}</div>
          </div>
        </>
      )}
    </div>
  );
};

export default StatsPage;
