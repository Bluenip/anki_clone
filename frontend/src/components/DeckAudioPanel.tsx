import { useEffect, useRef, useState } from 'react';
import { cancelDeckTts, getDeckTtsJob, getDeckTtsSummary, getTtsStatus, startDeckTts } from '../api/tts';
import type { TtsJob } from '../api/tts';
import { usePrefs } from '../context/usePrefs';

const ACTIVE = new Set(['queued', 'running', 'stopping']);

/** "Generate pronunciation audio" (Kokoro) for every word in a deck; hidden when the server has no TTS service. */
export default function DeckAudioPanel({ deckId }: { deckId: number }) {
  const { t } = usePrefs();
  const [enabled, setEnabled] = useState(false);
  const [piperWords, setPiperWords] = useState(0);
  const [staleNotes, setStaleNotes] = useState(0);
  const [job, setJob] = useState<TtsJob>({ state: 'idle' });
  const [error, setError] = useState<string | null>(null);
  /** Schedules the next job status check; replaced on mount so it never outlives this panel. */
  const schedulePoll = useRef<(delay: number) => void>(() => undefined);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => {
      clearTimeout(timer);
      if (!cancelled) timer = setTimeout(() => void poll(), delay);
    };
    async function poll() {
      try {
        const res = await getDeckTtsJob(deckId);
        if (cancelled) return;
        setJob(res.data);
        if (ACTIVE.has(res.data.state)) schedule(2000);
        else getDeckTtsSummary(deckId).then(r => { if (!cancelled) { setPiperWords(r.data.piper_words); setStaleNotes(r.data.stale_notes ?? 0); } }).catch(() => undefined);
      } catch {
        schedule(5000);
      }
    }
    schedulePoll.current = schedule;
    getTtsStatus()
      .then(res => {
        if (cancelled || !res.data.enabled) return;
        setEnabled(true);
        void poll();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      schedulePoll.current = () => undefined;
    };
  }, [deckId]);

  if (!enabled) return null;

  const start = async (mode: 'fill' | 'upgrade' | 'fix' = 'fill') => {
    setError(null);
    try {
      const res = await startDeckTts(deckId, mode);
      setJob(res.data);
      schedulePoll.current(1000);
    } catch (err: any) {
      setError(err?.response?.data?.detail || t('tts.failed'));
    }
  };

  const running = ACTIVE.has(job.state);
  const done = (job.done || 0) + (job.failed || 0);
  const percent = job.total ? Math.round((done / job.total) * 100) : 0;

  return (
    <div className="deck-audio-panel glass-card" data-testid="deck-audio">
      <div className="deck-audio-head">
        <div>
          <strong>🔊 {t('tts.title')}</strong>
          <p>{t('tts.description')}</p>
        </div>
        {running ? (
          <button type="button" className="btn btn-ghost btn-sm" disabled={job.state === 'stopping'}
            onClick={() => {
              setError(null);
              setJob(j => ({ ...j, state: 'stopping' }));
              cancelDeckTts(deckId)
                .then(r => setJob(r.data))
                .catch((err: any) => {
                  setError(err?.response?.data?.detail || t('tts.failed'));
                  // The job may still be running: show its real state instead of a stuck "Stopping…".
                  schedulePoll.current(0);
                });
            }}>
            {job.state === 'stopping' ? t('tts.stopping') : t('tts.stop')}
          </button>
        ) : (
          <div className="deck-audio-buttons">
            {staleNotes > 0 && (
              <button type="button" className="btn btn-ghost btn-sm" title={t('tts.fixHint')} onClick={() => void start('fix')}>
                🔁 {t('tts.fix', { count: staleNotes })}
              </button>
            )}
            {piperWords > 0 && (
              <button type="button" className="btn btn-ghost btn-sm" title={t('tts.upgradeHint')} onClick={() => void start('upgrade')}>
                ✨ {t('tts.upgrade', { count: piperWords })}
              </button>
            )}
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void start()}>
              {job.state === 'idle' ? t('tts.start') : t('tts.restart')}
            </button>
          </div>
        )}
      </div>
      {running && (
        <div className="deck-audio-progress" role="status">
          <div className="deck-audio-bar"><span style={{ width: `${percent}%` }} /></div>
          <span>{job.mode === 'fix'
            ? t('tts.fixProgress', { done, total: job.total || 0 })
            : job.mode === 'upgrade'
            ? t('tts.upgradeProgress', { done, total: job.total || 0 })
            : t('tts.progress', { done, total: job.total || 0, added: job.added || 0 })}</span>
        </div>
      )}
      {!running && job.state !== 'idle' && (
        <p className={job.state === 'failed' ? 'deck-audio-error' : 'deck-audio-summary'} role="status">
          {job.state === 'failed'
            ? t('tts.stoppedError', { error: job.error || '' })
            : job.state === 'stopped'
              ? t('tts.stoppedByUser', { done: job.done || 0, total: job.total || 0 })
            : job.mode === 'fix'
              ? t('tts.fixSummary', { added: job.added || 0, failed: job.failed || 0 })
            : job.mode === 'upgrade'
              ? t('tts.upgradeSummary', { added: job.added || 0, failed: job.failed || 0 })
              : t('tts.summary', { added: job.added || 0, skipped: job.skipped || 0, failed: job.failed || 0 })}
        </p>
      )}
      {!running && job.state === 'done' && (job.failed || 0) > 0 && job.error && (
        <p className="deck-audio-error">{t('tts.failedReason', { error: job.error })}</p>
      )}
      {error && <p className="deck-audio-error" role="alert">{error}</p>}
    </div>
  );
}
