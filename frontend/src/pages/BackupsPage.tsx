import { useEffect, useState } from 'react';
import client from '../api/client';

type Status = { revision: string; cards: number; notes: number; backups: { id: string; size: number; created_at: string }[] };
type Preview = { token: string; expected_revision: string; incoming: Record<string, number>; message: string };
const errorText = (e: unknown) => { const detail = (e as { response?: { data?: { detail?: unknown } } }).response?.data?.detail; return typeof detail === 'string' ? detail : 'Operation failed. Your draft has been kept.'; };
export default function BackupsPage() {
  const [status, setStatus] = useState<Status>();
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const reload = async () => { const { data } = await client.get<Status>('/api/backups'); setStatus(data); };
  useEffect(() => { let active = true; client.get<Status>('/api/backups').then(r => { if (active) setStatus(r.data); }).catch(e => { if (active) setError(errorText(e)); }); return () => { active = false; }; }, []);
  const perform = async (work: () => Promise<unknown>) => { if (busy) return; setBusy(true); setError(''); setMessage(''); try { await work(); await reload(); } catch(e) { setError(errorText(e)); } finally { setBusy(false); } };
  return <div className="page-container" style={{ maxWidth: 900 }}><h1>Backups &amp; restore</h1>
    <p>Backups include source notes, schedules, settings and media. Restoring replaces this account’s collection; a safety backup is created before replacement.</p>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <p>{status?.notes ?? '…'} notes · {status?.cards ?? '…'} cards</p>
    <button disabled={busy} onClick={() => void perform(async () => { await client.post('/api/backups'); setMessage('Backup saved.'); })}>Create full backup</button>
    <button disabled={busy} onClick={() => void perform(reload)}>Refresh</button>
    <section className="glass-card form-group" style={{ padding: 20, marginBlock: 20 }}><h2>Restore an Anki collection</h2>
      <label>Collection package<input type="file" accept=".colpkg" disabled={busy} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; setPreview(undefined); if (!file) return; void perform(async () => { const form = new FormData(); form.append('file', file); const { data } = await client.post<Preview>('/api/backups/preview', form, { headers: { 'Content-Type': undefined } }); setPreview(data); }); }} /></label>
      {preview && <div><p>Incoming: {Object.entries(preview.incoming).map(([k,v]) => `${v} ${k}`).join(', ')}.</p><p>{preview.message}</p>
        <button disabled={busy} onClick={() => { if (!window.confirm(`Replace ${status?.cards || 0} current cards with this collection? A backup will be saved first.`)) return; void perform(async () => { await client.post('/api/backups/apply', { token: preview.token, expected_revision: preview.expected_revision }); setPreview(undefined); setMessage('Collection restored. Reload other open study tabs.'); }); }}>Back up and replace collection</button>
      </div>}
    </section>
    <h2>Saved backups</h2>{status?.backups.map(backup => <div className="glass-card" key={backup.id} style={{ padding: 16, marginBlock: 12 }}>
      <p>{new Date(backup.created_at).toLocaleString()} · {(backup.size / 1024 / 1024).toFixed(2)} MB</p>
      <button disabled={busy} onClick={() => void perform(async () => { const res = await client.get(`/api/backups/${backup.id}/download`, { responseType: 'blob' }); const url = URL.createObjectURL(res.data); const a = document.createElement('a'); a.href = url; a.download = `anki-clone-backup-${backup.id}.zip`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); })}>Download backup</button>
      <button disabled={busy} onClick={() => { if (!window.confirm('Replace the current collection with this backup? A new safety backup is saved first.')) return; void perform(async () => { await client.post(`/api/backups/${backup.id}/restore`, { expected_revision: status.revision }); setMessage('Backup restored. Reload other open study tabs.'); }); }}>Restore this backup</button>
    </div>)}
  </div>;
}
