import { useEffect, useRef, useState } from 'react';
import client from '../api/client';
import { usePrefs } from '../context/usePrefs';
type Result = { parameters: number[]; training_samples: number; history_entries: number; scope: string; holdout_samples: number; evaluation?: { baseline: { log_loss: number; brier_score: number } | null; optimized: { log_loss: number; brier_score: number } | null } };
export default function FsrsOptimizer({ deckId, onUse }: { deckId: number; onUse: (parameters: number[]) => void }) {
  const { t } = usePrefs();
  const [result, setResult] = useState<Result>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const pending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const train = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setResult(undefined);
    try {
      const { data } = await client.post<Result>(`/api/optimizer/${deckId}`, {});
      if (mounted.current) setResult(data);
    } catch (e) {
      if (mounted.current) setError((e as { response?: { data?: { detail?: string } } }).response?.data?.detail || t('fsrs.failed'));
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return <div className="fsrs-optimizer" style={{ marginBlock: 16 }}>
    <button type="button" disabled={busy} onClick={() => void train()}>{busy ? t('fsrs.optimizing') : t('fsrs.optimize')}</button>
    <p className="options-description">{t('fsrs.description')}</p>
    {error && <p role="alert">{error}</p>}
    {result && <div><p>{t('fsrs.trained', { count: result.training_samples })}</p>
      {result.evaluation?.baseline && result.evaluation.optimized && <p>{t('fsrs.evaluation', { holdout: result.holdout_samples, logBefore: result.evaluation.baseline.log_loss.toFixed(4), logAfter: result.evaluation.optimized.log_loss.toFixed(4), brierBefore: result.evaluation.baseline.brier_score.toFixed(4), brierAfter: result.evaluation.optimized.brier_score.toFixed(4) })}</p>}
      <details><summary>{t('fsrs.viewParams')}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(result.parameters)}</pre></details>
      <button type="button" onClick={() => { onUse(result.parameters); setResult(undefined); }}>{t('fsrs.use')}</button>
    </div>}
  </div>;
}
