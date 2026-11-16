import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelDeckTts, getDeckTtsJob, getDeckTtsSummary, getTtsStatus, startDeckTts } from '../api/tts';
import type { TtsJob } from '../api/tts';
import { usePrefs } from '../context/usePrefs';

const ACTIVE = new Set(['queued', 'running', 'waiting', 'stopping']);

/** "Generate pronunciation audio" for every word in a deck; hidden when the server has no TTS key. */
export default function DeckAudioPanel({ deckId }: { deckId: number }) {
  const { t } = usePrefs();
  const [enabled, setEnabled] = useState(false);
  const [gemini, setGemini] = useState(false);
  const [piperWords, setPiperWords] = useState(0);
  const [job, setJob] = useState<TtsJob>({ state: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await getDeckTtsJob(deckId);
      setJob(res.data);
      if (ACTIVE.has(res.data.state)) timer.current = setTimeout(poll, 2000);
      else getDeckTtsSummary(deckId).then(r => setPiperWords(r.data.piper_words)).catch(() => undefined);
    } catch {
      timer.current = setTimeout(poll, 5000);
    }
  }, [deckId]);

  useEffect(() => {
    let cancelled = false;
    getTtsStatus()
      .then(res => {
        if (cancelled || !res.data.enabled) return;
        setEnabled(true);
        setGemini(res.data.gemini ?? true);
        void poll();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [poll]);

  if (!enabled) return null;

  const start = async (mode: 'fill' | 'upgrade' = 'fill') => {
    setError(null);
    try {
      const res = await startDeckTts(deckId, mode);
      setJob(res.data);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(poll, 1000);
    } catch (err: any) {
      setError(err?.response?.data?.detail || t('tts.failed'));
    }
  };

  const running = ACTIVE.has(job.state);
  const done = (job.done || 0) + (job.failed || 0);
  const resumeAt = job.resume_at ? new Date(job.resume_at * 1000).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '';
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
            onClick={() => { setJob(j => ({ ...j, state: 'stopping' })); void cancelDeckTts(deckId).then(r => setJob(r.data)); }}>
            {job.state === 'stopping' ? t('tts.stopping') : t('tts.stop')}
          </button>
        ) : (
          <div className="deck-audio-buttons">
            {gemini && piperWords > 0 && (
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
          <span>{job.mode === 'upgrade'
            ? t('tts.upgradeProgress', { done, total: job.total || 0 })
            : t('tts.progress', { done, total: job.total || 0, added: job.added || 0 })}
            {(job.piper || 0) > 0 && <> · {t('tts.piperCount', { count: job.piper || 0 })}</>}</span>
          {job.state === 'waiting' && <span className="deck-audio-waiting">⏳ {t('tts.waiting', { time: resumeAt })}</span>}
        </div>
      )}
      {!running && job.state !== 'idle' && (
        <p className={job.state === 'failed' ? 'deck-audio-error' : 'deck-audio-summary'} role="status">
          {job.state === 'failed'
            ? t('tts.stoppedError', { error: job.error || '' })
            : job.state === 'stopped'
              ? t('tts.stoppedByUser', { done: job.done || 0, total: job.total || 0 })
            : job.mode === 'upgrade'
              ? t('tts.upgradeSummary', { added: job.added || 0, failed: job.failed || 0 })
              : <>{t('tts.summary', { added: job.added || 0, skipped: job.skipped || 0, failed: job.failed || 0 })}
                  {(job.piper || 0) > 0 && <> {t('tts.piperCount', { count: job.piper || 0 })}</>}</>}
        </p>
      )}
      {error && <p className="deck-audio-error" role="alert">{error}</p>}
    </div>
  );
}
