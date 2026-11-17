import './StatsPage.css';
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
  const { t, lang } = usePrefs();
  const locale = lang === 'vi' ? 'vi-VN' : 'en-US';
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

      {!loading && !error && stats && (() => {
        const reviewCards = stats.counts.young + stats.counts.mature;
        const forecastWeek = stats.forecast.filter(f => f.day < 7).reduce((sum, f) => sum + f.cards, 0);
        const forecastAll = stats.forecast.reduce((sum, f) => sum + f.cards, 0);
        const maxBucket = Math.max(1, ...stats.intervals.map(b => b.count));
        const dateOf = (offset: number) => {
          const d = new Date(); d.setDate(d.getDate() + offset);
          return d.toLocaleDateString(locale, { day: 'numeric', month: 'numeric' });
        };
        const bucketLabel = (b: { min: number; max: number | null }) =>
          b.max === null ? t('stats.bucketOpen', { min: b.min }) : b.min === b.max ? t('stats.bucketOne', { n: b.min }) : t('stats.bucketRange', { min: b.min, max: b.max });
        const states = [
          { key: 'new', label: t('stat.new'), value: stats.counts.new, color: 'var(--new-color)' },
          { key: 'learning', label: t('stats.learning'), value: stats.counts.learning, color: 'var(--hard-color)' },
          { key: 'young', label: t('stats.young'), value: stats.counts.young, color: 'var(--accent-cyan)' },
          { key: 'mature', label: t('stats.mature'), value: stats.counts.mature, color: 'var(--good-color)' },
        ];
        return (
        <>
          <div className="stats-grid">
            <div className="stat-card glass-card">
              <span className="stat-value">{stats.summary.reviews.toLocaleString(locale)}</span>
              <span className="stat-label">{t('stats.reviews', { days: stats.summary.active_days })}</span>
            </div>
            <div className="stat-card glass-card">
              <span className="stat-value">{formatDuration(stats.summary.seconds)}</span>
              <span className="stat-label">
                {t('stats.studyTime')}{stats.summary.seconds_per_review !== null ? ` · ${t('stats.perReview', { s: stats.summary.seconds_per_review })}` : ''}
              </span>
            </div>
            <div className="stat-card glass-card">
              <span className="stat-value">
                {stats.summary.review_recall_percent !== null ? `${stats.summary.review_recall_percent}%` : t('common.na')}
              </span>
              <span className="stat-label" title={t('stats.recallTitle')}>
                {stats.summary.review_attempts > 0
                  ? t('stats.recallOf', { remembered: stats.summary.remembered, total: stats.summary.review_attempts })
                  : t('stats.recallNone')}
              </span>
            </div>
            <div className="stat-card glass-card">
              <span className="stat-value">{stats.counts.total.toLocaleString(locale)}</span>
              <span className="stat-label">{stats.counts.notes !== stats.counts.total ? t('stats.cards', { notes: stats.counts.notes.toLocaleString(locale) }) : t('stats.cardsCol')}</span>
            </div>
          </div>

          <div className="glass-card stats-panel">
            <h2>{t('stats.countsByState')}</h2>
            {stats.counts.total > 0 && (
              <div className="stats-stack" aria-hidden="true">
                {states.filter(st => st.value > 0).map(st => (
                  <span key={st.key} style={{ flexGrow: st.value, background: st.color }} title={`${st.label}: ${st.value}`} />
                ))}
              </div>
            )}
            <div className="stats-states">
              {states.map(st => (
                <div key={st.key} className="stats-state">
                  <div style={{ color: st.color }}><span className="stats-dot" style={{ background: st.color }} />{st.label}</div>
                  <div className="stats-state-value">{st.value.toLocaleString(locale)}</div>
                </div>
              ))}
            </div>
            {(stats.counts.suspended > 0 || stats.counts.buried > 0) && (
              <p className="stats-note">{t('stats.flagsNote', { suspended: stats.counts.suspended, buried: stats.counts.buried })}</p>
            )}
          </div>

          <div className="stats-two">
            <div className="glass-card stats-panel">
              <h2>{t('stats.forecast')}</h2>
              <p className="stats-hint">{t('stats.forecastSummary', { today: stats.forecast[0]?.cards ?? 0, week: forecastWeek, days: stats.forecast.length, all: forecastAll })}</p>
              <div className="stats-columns" role="img" aria-label={t('stats.forecastAria')}>
                {stats.forecast.map(f => (
                  <div key={f.day} className="stats-column" title={`${f.day === 0 ? t('stats.todayOverdue') : dateOf(f.day)}: ${f.cards}`}>
                    <span style={{ height: `${f.cards ? Math.max(4, (f.cards / maxForecast) * 100) : 0}%` }} className={f.day === 0 ? 'is-today' : ''} />
                  </div>
                ))}
              </div>
              <div className="stats-axis" aria-hidden="true">
                <span>{t('stats.today')}</span>
                {stats.forecast.length > 14 && <span>{dateOf(Math.floor(stats.forecast.length / 2))}</span>}
                <span>{dateOf(stats.forecast.length - 1)}</span>
              </div>
              <table className="sr-only">
                <caption>{t('stats.forecastAria')}</caption>
                <tbody>{stats.forecast.filter(f => f.cards > 0).map(f => <tr key={f.day}><th scope="row">{f.day === 0 ? t('stats.todayOverdue') : dateOf(f.day)}</th><td>{f.cards}</td></tr>)}</tbody>
              </table>
            </div>

            <div className="glass-card stats-panel">
              <h2>{t('stats.intervals')}</h2>
              {reviewCards === 0 ? (
                <p className="stats-empty">{t('stats.intervalsEmpty')}</p>
              ) : (
                <>
                  <p className="stats-hint">{t('stats.intervalsHint')}</p>
                  <ul className="stats-bars" aria-label={t('stats.intervalsAria')}>
                    {stats.intervals.map(bucket => (
                      <li key={bucket.label}>
                        <span className="stats-bar-label">{bucketLabel(bucket)}</span>
                        <span className="stats-bar-track"><span style={{ width: `${(bucket.count / maxBucket) * 100}%` }} /></span>
                        <span className="stats-bar-value">{bucket.count} <small>{((bucket.count / reviewCards) * 100).toFixed(0)}%</small></span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>

          <div className="glass-card stats-panel">
            <h2>{t('stats.history')}</h2>
            <p className="stats-hint">{t('stats.historyHint', { days })}</p>
            {stats.summary.reviews === 0 ? (
              <p className="stats-empty">{t('stats.noLogs')}</p>
            ) : (
              <div style={{ maxHeight: '320px', overflow: 'auto' }}>
                <table className="browse-table" aria-label={t('stats.historyAria')} style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th scope="col">{t('stats.day')}</th>
                      <th scope="col" style={{ textAlign: 'right' }}>{t('stat.total')}</th>
                      <th scope="col" style={{ textAlign: 'right' }}>{t('stats.time')}</th>
                      <th scope="col" style={{ width: '40%' }}>{t('stats.answers')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.history.filter((h) => h.reviews > 0).map((h) => (
                      <tr key={h.day}>
                        <td>{h.day === 0 ? t('stats.today') : dateOf(-h.day)}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{h.reviews}</td>
                        <td style={{ textAlign: 'right' }}>{formatDuration(h.seconds)}</td>
                        <td>
                          <div className="stats-answers" style={{ width: `${Math.max(8, (h.reviews / maxHistory) * 100)}%` }}
                            title={`${t('rate.again')} ${h.again} · ${t('rate.hard')} ${h.hard} · ${t('rate.good')} ${h.good} · ${t('rate.easy')} ${h.easy}`}>
                            {([['again', h.again], ['hard', h.hard], ['good', h.good], ['easy', h.easy]] as const).filter(([, n]) => n > 0).map(([kind, n]) => (
                              <span key={kind} style={{ flexGrow: n, background: `var(--${kind}-color)` }} />
                            ))}
                          </div>
                          <span className="sr-only">{t('rate.again')} {h.again}, {t('rate.hard')} {h.hard}, {t('rate.good')} {h.good}, {t('rate.easy')} {h.easy}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="stats-legend" aria-hidden="true">
                  {(['again', 'hard', 'good', 'easy'] as const).map(kind => (
                    <span key={kind}><span className="stats-dot" style={{ background: `var(--${kind}-color)` }} />{t(`rate.${kind}`)}</span>
                  ))}
                </div>
              </div>
            )}
          </div>

          <details className="stats-notes">
            <summary>{t('stats.howCounted')}</summary>
            <ul>
              <li>{t('stats.noteDays')}</li>
              <li>{t('stats.noteForecast')}</li>
              <li>{t('stats.noteRecall')}</li>
            </ul>
          </details>
        </>
        );
      })()}
    </div>
  );
};

export default StatsPage;
