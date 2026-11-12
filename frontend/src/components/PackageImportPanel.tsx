import { useEffect, useState } from 'react';
import { cancelPackageImport, confirmPackageImport, getPackageImport } from '../api/decks';
import type { PackageImportJob } from '../api/decks';
import type { MessageKey } from '../i18n/en';
import { usePrefs } from '../context/usePrefs';
const labels: Record<string, MessageKey> = {
  queued: 'pkg.queued', validating: 'pkg.validating', extracting: 'pkg.extracting',
  decompressing: 'pkg.decompressing', checking_media: 'pkg.checking_media', checking_templates: 'pkg.checking_templates',
  importing_notes: 'pkg.importing_notes', backing_up_media: 'pkg.backing_up_media', copying_media: 'pkg.copying_media',
  committing: 'pkg.committing', awaiting_confirmation: 'pkg.awaiting_confirmation', completed: 'pkg.completed',
  failed: 'pkg.failed', interrupted: 'pkg.interrupted', cancelled: 'pkg.cancelled', expired: 'pkg.expired',
};
const terminal = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'expired']);
export default function PackageImportPanel({ id, onBusy, onComplete, onClose }: {
  id: string; onBusy: (busy: boolean) => void; onComplete: () => void; onClose: () => void;
}) {
  const { t } = usePrefs();
  const [job, setJob] = useState<PackageImportJob | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await getPackageImport(id);
        if (disposed) return;
        const next = response.data;
        setJob(next); setError(''); onBusy(!terminal.has(next.status));
        if (next.status === 'completed') onComplete();
        if (!terminal.has(next.status)) timer = setTimeout(poll, 750);
      } catch (e: unknown) {
        if (!disposed) {
          const status = (e as { response?: { status?: number } }).response?.status;
          setError(status === 404 ? t('pkg.notFound') : t('pkg.statusFailed'));
        }
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [id, onBusy, onComplete, retry, t]);
  const action = async (confirm: boolean) => {
    setPending(true);
    try {
      const response = await (confirm ? confirmPackageImport(id) : cancelPackageImport(id));
      setJob(response.data); setError(''); setRetry(n => n + 1);
    } catch (e: unknown) {
      setError((e as { response?: { data?: { detail?: string } } }).response?.data?.detail || t('common.requestFailed'));
    } finally { setPending(false); }
  };
  const result = job?.result;
  const finished = !!job && terminal.has(job.status);
  return <section className="glass-card package-import-progress" aria-label={t('pkg.aria')}>
    <h2 aria-live="polite">{t(labels[job?.status || 'queued'] || 'pkg.processing')}</h2>
    {job && !finished && job.status !== 'awaiting_confirmation' && <>
      <p role="status">{job.total > 0 ? `${job.completed} / ${job.total}` : t('pkg.preparing')}</p>
      {job.total > 0 ? <progress max={job.total} value={job.completed} aria-label={t('pkg.progress')} /> : <progress aria-label={t('pkg.progress')} />}
    </>}
    {job?.detail && <p role="status">{job.detail}</p>}
    {result && <>
      <p>{t('pkg.summary', { notes: result.notes_in_package, cards: result.cards_in_package, media: result.media_imported, size: (result.media_bytes / 1024 ** 2).toFixed(1) })}</p>
      <p>{job?.status === 'awaiting_confirmation' ? t('pkg.planned') + ' ' : ''}{t('pkg.result', { added: result.cards_imported, updated: result.cards_updated, skipped: result.cards_skipped })}</p>
      {job?.status === 'awaiting_confirmation' && <p>{t('pkg.unchanged')}</p>}
      {result.warnings.length > 0 && <ul>{result.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
    </>}
    {error && <p role="alert">{error} <button onClick={() => setRetry(n => n + 1)}>{t('pkg.retry')}</button></p>}
    <div className="modal-actions">
      {job?.status === 'awaiting_confirmation' && <button className="btn btn-primary" disabled={pending} onClick={() => void action(true)}>{t('pkg.import')}</button>}
      {!finished && job?.status !== 'committing' && <button className="btn btn-ghost" disabled={pending || job?.cancel_requested} onClick={() => void action(false)}>{job?.cancel_requested ? t('pkg.cancelling') : t('pkg.cancel')}</button>}
      {(finished || error) && <button className="btn btn-ghost" onClick={onClose}>{t('common.dismiss')}</button>}
    </div>
  </section>;
}
