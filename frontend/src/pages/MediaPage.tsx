import { useState } from 'react';
import client from '../api/client';
import { usePrefs } from '../context/usePrefs';
export default function MediaPage() {
  const [result, setResult] = useState<{ total: number; missing: string[]; unused: string[] }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { t } = usePrefs();
  const check = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try { setResult((await client.get('/api/media-tools/check')).data); }
    catch { setError(t('media.checkFailed')); }
    finally { setBusy(false); }
  };
  return <div className="page-container"><h1>{t('media.title')}</h1>
    <p>{t('media.description')}</p>
    <button className="btn btn-primary" disabled={busy} onClick={() => void check()}>{busy ? t('media.checking') : t('media.title')}</button>
    {error && <p role="alert">{error}</p>}
    {result && <><p>{t('media.total', { count: result.total })}</p>{(['missing', 'unused'] as const).map(kind => <section key={kind}><h2>{kind === 'missing' ? t('media.missing') : t('media.unused')} ({result[kind].length})</h2><ul>{result[kind].map(name => <li key={name} style={{ overflowWrap: 'anywhere' }}>{name}</li>)}</ul></section>)}</>}
  </div>;
}
