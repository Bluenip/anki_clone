import { useState } from 'react';
import client from '../api/client';
export default function MediaPage() {
  const [result, setResult] = useState<{ total: number; missing: string[]; unused: string[] }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const check = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try { setResult((await client.get('/api/media-tools/check')).data); }
    catch { setError('Could not check media. Try again.'); }
    finally { setBusy(false); }
  };
  return <div className="page-container"><h1>Check media</h1>
    <p>Find missing files and files not referenced by saved notes or templates. Recently attached files in an unsaved draft may appear unused.</p>
    <button className="btn btn-primary" disabled={busy} onClick={() => void check()}>{busy ? 'Checking…' : 'Check media'}</button>
    {error && <p role="alert">{error}</p>}
    {result && <><p>{result.total} files in your collection</p>{(['missing', 'unused'] as const).map(kind => <section key={kind}><h2>{kind === 'missing' ? 'Missing' : 'Unused'} ({result[kind].length})</h2><ul>{result[kind].map(name => <li key={name} style={{ overflowWrap: 'anywhere' }}>{name}</li>)}</ul></section>)}</>}
  </div>;
}
