import { useEffect, useState } from 'react';
import { cancelPackageImport, confirmPackageImport, getPackageImport } from '../api/decks';
import type { PackageImportJob } from '../api/decks';
const labels: Record<string, string> = {
  queued: 'Preparing package', validating: 'Checking package', extracting: 'Extracting files',
  decompressing: 'Decompressing package', checking_media: 'Checking media', checking_templates: 'Checking templates',
  importing_notes: 'Preparing notes', backing_up_media: 'Backing up media', copying_media: 'Copying media',
  committing: 'Saving collection', awaiting_confirmation: 'Ready to import', completed: 'Import completed',
  failed: 'Import failed', interrupted: 'Import interrupted', cancelled: 'Import cancelled', expired: 'Preview expired',
};
const terminal = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'expired']);
export default function PackageImportPanel({ id, onBusy, onComplete, onClose }: {
  id: string; onBusy: (busy: boolean) => void; onComplete: () => void; onClose: () => void;
}) {
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
          setError(status === 404 ? 'Import job not found for this account.' : 'Cannot check import status. Retry to reconnect.');
        }
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [id, onBusy, onComplete, retry]);
  const action = async (confirm: boolean) => {
    setPending(true);
    try {
      const response = await (confirm ? confirmPackageImport(id) : cancelPackageImport(id));
      setJob(response.data); setError(''); setRetry(n => n + 1);
    } catch (e: unknown) {
      setError((e as { response?: { data?: { detail?: string } } }).response?.data?.detail || 'Request failed. Please retry.');
    } finally { setPending(false); }
  };
  const result = job?.result;
  const finished = !!job && terminal.has(job.status);
  return <section className="glass-card package-import-progress" aria-label="Package import">
    <h2 aria-live="polite">{labels[job?.status || 'queued'] || 'Processing package'}</h2>
    {job && !finished && job.status !== 'awaiting_confirmation' && <>
      <p role="status">{job.total > 0 ? `${job.completed} / ${job.total}` : 'Preparing…'}</p>
      {job.total > 0 ? <progress max={job.total} value={job.completed} aria-label="Import stage progress" /> : <progress aria-label="Import stage progress" />}
    </>}
    {job?.detail && <p role="status">{job.detail}</p>}
    {result && <>
      <p>{result.notes_in_package} notes · {result.cards_in_package} cards · {result.media_imported} media files ({(result.media_bytes / 1024 ** 2).toFixed(1)} MiB)</p>
      <p>{job?.status === 'awaiting_confirmation' ? 'Planned: ' : ''}{result.cards_imported} cards added · {result.cards_updated} updated · {result.cards_skipped} skipped</p>
      {job?.status === 'awaiting_confirmation' && <p>Your collection has not been changed. Review the warnings before importing.</p>}
      {result.warnings.length > 0 && <ul>{result.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
    </>}
    {error && <p role="alert">{error} <button onClick={() => setRetry(n => n + 1)}>Retry status</button></p>}
    <div className="modal-actions">
      {job?.status === 'awaiting_confirmation' && <button className="btn btn-primary" disabled={pending} onClick={() => void action(true)}>Import package</button>}
      {!finished && job?.status !== 'committing' && <button className="btn btn-ghost" disabled={pending || job?.cancel_requested} onClick={() => void action(false)}>{job?.cancel_requested ? 'Cancelling…' : 'Cancel import'}</button>}
      {(finished || error) && <button className="btn btn-ghost" onClick={onClose}>Dismiss</button>}
    </div>
  </section>;
}
