import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import client from '../api/client';
import { usePrefs } from '../context/usePrefs';
import './CustomStudyPresets.css';
export default function CustomStudyPresets({ onChoose }: { onChoose: (name: string, search: string, reschedule: boolean) => void }) {
  const { t } = usePrefs();
  const [decks, setDecks] = useState<{ id: number; name: string }[]>([]);
  const [deckId, setDeckId] = useState(0), [days, setDays] = useState(7), [extra, setExtra] = useState(20);
  const [preset, setPreset] = useState('forgotten'), [tag, setTag] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const lock = useRef(false);
  useEffect(() => { let active = true; client.get('/api/decks').then(r => { if (active) setDecks(r.data); }).catch(() => {}); return () => { active = false; }; }, []);
  const increase = async (kind: 'new' | 'review') => {
    if (!deckId || lock.current) return;
    lock.current = true; setBusy(true); setMessage('');
    try { await client.post(`/api/decks/${deckId}/options/extra-today`, { kind, count: extra }); setMessage(t(kind === 'new' ? 'csp.addedNew' : 'csp.addedReview', { count: extra })); }
    catch { setMessage(t('csp.limitFailed')); }
    finally { lock.current = false; setBusy(false); }
  };
  const choose = () => {
    const deck = decks.find(d => d.id === deckId); if (!deck) return;
    const filter = preset === 'forgotten' ? `rated:${days}:1` : preset === 'ahead' ? `is:review prop:due<=${days} -is:due` : preset === 'recent' ? `added:${days}` : preset === 'new' ? 'is:new' : preset === 'due' ? 'is:due' : `tag:${JSON.stringify(tag)}`;
    onChoose(`${deck.name} — ${preset}`, `deck:${JSON.stringify(deck.name)} ${filter}`, preset === 'ahead' || preset === 'due');
  };
  return <details className="glass-card csp-panel"><summary>{t('csp.title')}</summary>
    <label className="csp-field csp-deck">{t('csp.homeDeck')}
      <select value={deckId} disabled={busy} onChange={e => setDeckId(Number(e.target.value))}><option value={0}>{t('csp.chooseDeck')}</option>{decks.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
    </label>
    <div className="csp-groups">
      <section className="csp-group">
        <h4>{t('csp.limitsHeading')}</h4>
        <label className="csp-field">{t('csp.extraToday')}
          <input type="number" min={1} max={10000} value={extra} onChange={e => setExtra(Math.max(1, Math.min(10000, Number(e.target.value))))} />
        </label>
        <div className="csp-actions">
          <button className="btn btn-ghost btn-sm" disabled={busy || !deckId} onClick={() => void increase('new')}>{t('csp.increaseNew')}</button>
          <button className="btn btn-ghost btn-sm" disabled={busy || !deckId} onClick={() => void increase('review')}>{t('csp.increaseReview')}</button>
        </div>
        {message && <p role="status" className="csp-message">{message} {deckId > 0 && <Link to={`/study/${deckId}`}>{t('csp.studyDeck')}</Link>}</p>}
      </section>
      <section className="csp-group">
        <h4>{t('csp.sessionHeading')}</h4>
        <label className="csp-field">{t('csp.selection')}
          <select value={preset} onChange={e => setPreset(e.target.value)}><option value="forgotten">{t('csp.forgotten')}</option><option value="ahead">{t('csp.ahead')}</option><option value="recent">{t('csp.recent')}</option><option value="new">{t('csp.new')}</option><option value="due">{t('csp.due')}</option><option value="tag">{t('csp.tag')}</option></select>
        </label>
        {['forgotten', 'ahead', 'recent'].includes(preset) && <label className="csp-field">{t('csp.days')}<input type="number" min={1} max={36500} value={days} onChange={e => setDays(Math.max(1, Math.min(36500, Number(e.target.value))))} /></label>}
        {preset === 'tag' && <label className="csp-field">{t('csp.tagLabel')}<input value={tag} onChange={e => setTag(e.target.value)} /></label>}
        <div className="csp-actions">
          <button className="btn btn-primary btn-sm" disabled={!deckId || preset === 'tag' && !tag.trim()} onClick={choose}>{t('csp.configure')}</button>
        </div>
      </section>
    </div>
  </details>;
}
