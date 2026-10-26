import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import client from '../api/client';
export default function CustomStudyPresets({ onChoose }: { onChoose: (name: string, search: string, reschedule: boolean) => void }) {
  const [decks, setDecks] = useState<{ id: number; name: string }[]>([]);
  const [deckId, setDeckId] = useState(0), [days, setDays] = useState(7), [extra, setExtra] = useState(20);
  const [preset, setPreset] = useState('forgotten'), [tag, setTag] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const lock = useRef(false);
  useEffect(() => { let active = true; client.get('/api/decks').then(r => { if (active) setDecks(r.data); }).catch(() => {}); return () => { active = false; }; }, []);
  const increase = async (kind: 'new' | 'review') => {
    if (!deckId || lock.current) return;
    lock.current = true; setBusy(true); setMessage('');
    try { await client.post(`/api/decks/${deckId}/options/extra-today`, { kind, count: extra }); setMessage(`Added ${extra} to today’s ${kind} limit. Ancestor limits still apply when enabled.`); }
    catch { setMessage('Could not change today’s limit. Try again while connected.'); }
    finally { lock.current = false; setBusy(false); }
  };
  const choose = () => {
    const deck = decks.find(d => d.id === deckId); if (!deck) return;
    const filter = preset === 'forgotten' ? `rated:${days}:1` : preset === 'ahead' ? `is:review prop:due<=${days} -is:due` : preset === 'recent' ? `added:${days}` : preset === 'new' ? 'is:new' : preset === 'due' ? 'is:due' : `tag:${JSON.stringify(tag)}`;
    onChoose(`${deck.name} — ${preset}`, `deck:${JSON.stringify(deck.name)} ${filter}`, preset === 'ahead' || preset === 'due');
  };
  return <details className="glass-card" style={{ padding: 16, marginBlock: 16 }}><summary>Custom Study shortcuts</summary>
    <label>Home deck<select value={deckId} disabled={busy} onChange={e => setDeckId(Number(e.target.value))}><option value={0}>Choose deck</option>{decks.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
    <label>Extra cards today<input type="number" min={1} max={10000} value={extra} onChange={e => setExtra(Math.max(1, Math.min(10000, Number(e.target.value))))} /></label>
    <button disabled={busy || !deckId} onClick={() => void increase('new')}>Increase today’s new card limit</button>
    <button disabled={busy || !deckId} onClick={() => void increase('review')}>Increase today’s review limit</button>
    {message && <p role="status">{message} {deckId > 0 && <Link to={`/study/${deckId}`}>Study deck</Link>}</p>}
    <label>Study selection<select value={preset} onChange={e => setPreset(e.target.value)}><option value="forgotten">Forgotten cards</option><option value="ahead">Review ahead</option><option value="recent">Preview recently added</option><option value="new">New cards</option><option value="due">Due cards</option><option value="tag">Cards with a tag</option></select></label>
    {['forgotten', 'ahead', 'recent'].includes(preset) && <label>Number of days<input type="number" min={1} max={36500} value={days} onChange={e => setDays(Math.max(1, Math.min(36500, Number(e.target.value))))} /></label>}
    {preset === 'tag' && <label>Tag<input value={tag} onChange={e => setTag(e.target.value)} /></label>}
    <button disabled={!deckId || preset === 'tag' && !tag.trim()} onClick={choose}>Configure this session</button>
  </details>;
}
