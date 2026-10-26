import { useEffect, useRef, useState } from 'react';
import { scheduleOffline, nextLocalDay } from '../utils/offlineScheduler';
import client from '../api/client';
import { useAuth } from '../context/useAuth';
import OfflineNoteEditor from '../components/OfflineNoteEditor';
import CardFace from '../components/CardFace';
import OfflineCardFace from '../components/OfflineCardFace';
import { changeLocal, downloadDeck, localAccount, synchronize, requestBackgroundSync, enableBackgroundSync } from '../utils/offline';
import type { LocalAccount } from '../utils/offline';

export default function OfflinePage() {
  const { user } = useAuth();
  const [account, setAccount] = useState<LocalAccount>({ decks: [], answers: [] });
  const [available, setAvailable] = useState<{ id: number; name: string }[]>([]);
  const [deckId, setDeckId] = useState(0), [studyId, setStudyId] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [autoSync, setAutoSync] = useState(true);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const lock = useRef(false), started = useRef(0);
  const uid = user?.id;
  useEffect(() => {
    if (!uid) return;
    let active = true; started.current = Date.now();
    localAccount(uid).then(data => { if (active) setAccount(data); }).catch(() => { if (active) setError('Browser storage is unavailable.'); });
    client.get('/api/decks').then(res => { if (active) setAvailable(res.data); }).catch(() => {});
    return () => { active = false; };
  }, [uid]);
  const perform = async (work: () => Promise<void>) => {
    if (lock.current || !uid) return;
    lock.current = true; setBusy(true); setError(''); setMessage('');
    try { await work(); setAccount(await localAccount(uid)); }
    catch (e) { const detail = (e as { response?: { data?: { detail?: unknown } } }).response?.data?.detail; setError(typeof detail === 'string' ? detail : e instanceof Error ? e.message : 'Operation failed. Saved answers are kept.'); }
    finally { try { setAccount(await localAccount(uid)); } catch { /* Keep displayed data if storage is unavailable. */ } lock.current = false; setBusy(false); }
  };
  useEffect(() => {
    if (!uid || !autoSync) return;
    let active = true;
    const reconnect = async () => {
      if (lock.current) return;
      lock.current = true; setBusy(true);
      try { await synchronize(uid); const current = await localAccount(uid); if (active) { setAccount(current); setRevealed(false); started.current = Date.now(); setMessage('Reconnected and synced. Check any conflicts below.'); } }
      catch { if (active) { try { setAccount(await localAccount(uid)); } catch { /* Storage may be unavailable. */ } setError('Automatic sync failed. Answers and edits remain saved; use Sync now to retry.'); } }
      finally { lock.current = false; if (active) setBusy(false); }
    };
    const workerMessage = (event: MessageEvent) => { if (event.data?.type === 'offline-sync-complete') void localAccount(uid).then(data => { if (active) { setAccount(data); setRevealed(false); } }); };
    navigator.serviceWorker?.addEventListener('message', workerMessage);
    window.addEventListener('online', reconnect);
    return () => { active = false; window.removeEventListener('online', reconnect); navigator.serviceWorker?.removeEventListener('message', workerMessage); };
  }, [uid, autoSync]);
  const deck = account.decks.find(d => d.deck.id === studyId);
  const editedNotes = new Set((account.edits || []).map(e => e.note_id));
  const conflicts = new Set(account.answers.filter(a => a.conflict).map(a => a.card_id));
  const card = deck?.cards.filter(c => c.eligible && !account.needs_refresh && !editedNotes.has(c.note_id ?? -1) && !conflicts.has(c.card_id) && !c.offline_state?.is_suspended && (!c.local_buried_until || Date.parse(c.local_buried_until) <= clock) && (!c.local_due || Date.parse(c.local_due) <= clock)).sort((a, b) => Date.parse(a.local_due || '1970-01-01') - Date.parse(b.local_due || '1970-01-01'))[0];
  const nextDue = deck?.cards.filter(c => c.eligible && !account.needs_refresh && !editedNotes.has(c.note_id ?? -1) && !conflicts.has(c.card_id) && !c.offline_state?.is_suspended && c.local_due && Date.parse(c.local_due) > clock).map(c => Date.parse(c.local_due!)).sort((a, b) => a - b)[0];
  const rate = (rating: number) => {
    if (!card || !uid || !revealed) return;
    void perform(async () => {
      await changeLocal(uid, current => {
        if (current.needs_refresh || current.edits?.some(e => e.note_id === card.note_id)) throw new Error('This note changed locally. Sync before continuing.');
        const latest = current.decks.flatMap(d => d.cards).filter(c => c.card_id === card.card_id);
        if (latest.some(c => (c.version ?? 0) > (card.version ?? 0))) throw new Error('This card was answered in another tab. Refresh the page.');
        const now = new Date(), updated = scheduleOffline(card, rating, now);
        const cfg = card.offline_config || {}, buriedUntil = nextLocalDay(now, String(cfg.timezone || 'UTC'), Number(cfg.day_starts_at || 0), 1).toISOString();
        return { ...current, decks: current.decks.map(d => ({ ...d, cards: d.cards.map(c => {
          if (c.card_id === card.card_id) return { ...updated, study_deck_id: c.study_deck_id };
          const bury = c.card_state === 'review' ? cfg.bury_review_siblings : c.card_state === 'new' || c.is_new ? cfg.bury_new_siblings : cfg.bury_interday_learning_siblings;
          return card.note_id && c.note_id === card.note_id && bury ? { ...c, local_buried_until: buriedUntil } : c;
        }) })), answers: [...current.answers, { request_id: crypto.randomUUID(), card_id: card.card_id, expected_version: card.version ?? 0, settings_hash: card.settings_hash, rating, duration_ms: Math.min(3600000, Date.now() - started.current), reviewed_at: new Date().toISOString(), question: card.front }] };
      });
      await requestBackgroundSync();
      setRevealed(false); started.current = Date.now(); setMessage('Answer saved on this device.');
    });
  };
  return <div className="page-container" style={{ maxWidth: 900 }}><h1>Offline study &amp; sync</h1>
    <p>Download while connected, then study and repeat learning steps without a network. Local schedules are provisional; sync applies answers in order using the server scheduler and refreshes the next batch. Decks download in batches, up to 100,000 cards, subject to available browser storage.</p>
    <p>Keep this browser’s data until answers are synced. Logging out removes downloaded cards, media and pending answers and edits. Voices and external media may need a connection.</p>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <label>Deck to download <select value={deckId} onChange={e => setDeckId(Number(e.target.value))}><option value={0}>Choose a deck</option>{available.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
    <button disabled={busy || !deckId} onClick={() => void perform(async () => { await downloadDeck(uid!, deckId); setMessage('Deck and local media downloaded.'); })}>Download deck</button>
    <button disabled={busy} onClick={() => void perform(async () => { await synchronize(uid!); setRevealed(false); started.current = Date.now(); setMessage('Sync finished. Resolve any conflicts below.'); })}>Sync now</button>
    <label><input type="checkbox" checked={autoSync} onChange={e => setAutoSync(e.target.checked)} />Sync when this page reconnects</label>
    <label><input type="checkbox" checked={!!account.background} disabled={busy} onChange={e => { const checked = e.target.checked; void perform(() => enableBackgroundSync(uid!, checked)); }} />Allow background sync on supported browsers</label>
    <p>Background sync needs browser support and a valid login. Use Sync now if the browser cannot run it; reopen and sync to refresh cards after background changes.</p>
    {account.needs_refresh && <p role="status">Changes were applied or discarded. Sync now before studying to refresh this download.</p>}
    <p>{account.answers.length} pending answers · {account.edits?.length || 0} pending edits · {account.decks.length} downloaded decks</p>
    <label>Downloaded deck <select disabled={busy} value={studyId} onChange={e => { setStudyId(Number(e.target.value)); setRevealed(false); started.current = Date.now(); }}><option value={0}>Choose a deck</option>{account.decks.map(d => <option key={d.deck.id} value={d.deck.id}>{d.deck.name}</option>)}</select></label>
    {deck && <p>Downloaded {new Date(deck.saved_at).toLocaleString()}</p>}
    {card ? <section key={card.card_id} className="glass-card" style={{ padding: 20 }}>
      <OfflineCardFace key={card.card_id + ":" + (card.version ?? 0)} card={card} uid={uid!} revealed={revealed} onReveal={() => setRevealed(true)} />
      {!revealed ? <button disabled={busy} onClick={() => setRevealed(true)}>Show answer</button> : ['Again', 'Hard', 'Good', 'Easy'].map((label, i) => <button key={label} disabled={busy} onClick={() => rate(i + 1)}>{label}</button>)}
    </section> : deck && <p>No cards are ready in this download. {nextDue ? `Next local review: ${new Date(nextDue).toLocaleString()}.` : ''} Sync when connected to refresh availability and daily limits.</p>}
    {uid && <OfflineNoteEditor uid={uid} account={account} busy={busy} perform={perform} />}
    {account.answers.filter(a => a.conflict).map(answer => <section className="glass-card" key={answer.request_id} style={{ padding: 20, marginBlock: 16 }}>
      <h2>Sync conflict — card {answer.card_id}</h2><p>{answer.conflict}</p><p>Local answer: {['Again', 'Hard', 'Good', 'Easy'][answer.rating - 1]}, {new Date(answer.reviewed_at).toLocaleString()}. This answer has not been applied.</p>
      <CardFace html={answer.question} title="Conflicting local card" />
      <button disabled={busy} onClick={() => { if (!window.confirm('Discard all pending local answers for this card and keep the server version?')) return; void perform(async () => { await changeLocal(uid!, current => ({ ...current, needs_refresh: true, answers: current.answers.filter(a => a.card_id !== answer.card_id) })); setRevealed(false); started.current = Date.now(); }); }}>Keep server version and discard local answers</button>
    </section>)}
  </div>;
}
