import { useEffect, useRef, useState } from 'react';
import client from '../api/client';
type Result = { parameters: number[]; training_samples: number; history_entries: number; scope: string; holdout_samples: number; evaluation?: { baseline: { log_loss: number; brier_score: number } | null; optimized: { log_loss: number; brier_score: number } | null } };
export default function FsrsOptimizer({ deckId, onUse }: { deckId: number; onUse: (parameters: number[]) => void }) {
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
      if (mounted.current) setError((e as { response?: { data?: { detail?: string } } }).response?.data?.detail || 'Optimization failed. Your settings were not changed.');
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return <div className="fsrs-optimizer" style={{ marginBlock: 16 }}>
    <button type="button" disabled={busy} onClick={() => void train()}>{busy ? 'Optimizing…' : 'Optimize FSRS parameters'}</button>
    <p className="options-description">Uses this deck and its subdecks. Requires 400 interday outcomes with complete learning history, including imported Anki logs with a known starting point. Incomplete or manual histories are excluded. May take up to two minutes.</p>
    {error && <p role="alert">{error}</p>}
    {result && <div><p>Trained on {result.training_samples} outcomes. Use these weights, then Save to apply them to future reviews.</p>
      {result.evaluation?.baseline && result.evaluation.optimized && <p>Held-out outcomes: {result.holdout_samples}. Log loss: {result.evaluation.baseline.log_loss.toFixed(4)} → {result.evaluation.optimized.log_loss.toFixed(4)}. Brier score: {result.evaluation.baseline.brier_score.toFixed(4)} → {result.evaluation.optimized.brier_score.toFixed(4)}. Lower is better; improvement is not guaranteed.</p>}
      <details><summary>View parameters</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(result.parameters)}</pre></details>
      <button type="button" onClick={() => { onUse(result.parameters); setResult(undefined); }}>Use optimized parameters</button>
    </div>}
  </div>;
}
