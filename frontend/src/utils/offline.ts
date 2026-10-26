import client from '../api/client';
import type { LocalState } from './offlineScheduler';
import type { StudyCard } from '../api/types';
export type CachedCard = StudyCard & { settings_hash: string; eligible: boolean; study_deck_id: number; offline_state?: LocalState; offline_config?: Record<string, unknown>; local_due?: string; local_buried_until?: string };
export type OfflineNote = { id: number; guid: string; kind: string; schema_hash: string; fields: Record<string, string>; tags: string[] };
export type OfflineEdit = { request_id: string; note_id: number; guid: string; schema_hash: string; base_fields: Record<string, string>; base_tags: string[]; fields: Record<string, string>; tags: string[]; conflict?: string; remote?: OfflineNote; conflicting_fields?: string[] };
export type OfflineDeck = { notes?: OfflineNote[]; deck: { id: number; name: string }; cards: CachedCard[]; versions: Record<string, string>; saved_at: string; revision: string };
export type OfflineAnswer = { request_id: string; card_id: number; expected_version: number; settings_hash: string; rating: number; duration_ms: number; reviewed_at: string; question: string; conflict?: string };
const database = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('anki-offline-v1', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('accounts');
  request.onerror = () => reject(request.error);
  request.onsuccess = () => resolve(request.result);
});
export type LocalAccount = { decks: OfflineDeck[]; answers: OfflineAnswer[]; edits?: OfflineEdit[]; background?: { token: string }; needs_refresh?: boolean };
export async function localAccount(uid: number): Promise<LocalAccount> {
  const db = await database();
  try { return await new Promise((resolve, reject) => { const request = db.transaction('accounts').objectStore('accounts').get(uid); request.onsuccess = () => resolve(request.result || { decks: [], answers: [] }); request.onerror = () => reject(request.error); }); }
  finally { db.close(); }
}
// Read-modify-write stays in a single IndexedDB transaction, including across tabs.
export async function changeLocal(uid: number, change: (account: LocalAccount) => LocalAccount, allowSignedOut = false) {
  const sessionToken = localStorage.getItem('token');
  const db = await database();
  try { await new Promise<void>((resolve, reject) => { const transaction = db.transaction('accounts', 'readwrite'); const store = transaction.objectStore('accounts'); const request = store.get(uid); request.onsuccess = () => { try { if (!allowSignedOut && localStorage.getItem('token') !== sessionToken) throw new Error('Session changed; local write cancelled.'); store.put(change(request.result || { decks: [], answers: [] }), uid); } catch (error) { transaction.abort(); reject(error); } }; transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); }); }
  finally { db.close(); }
}
export async function clearOffline(uid: number) {
  await changeLocal(uid, () => ({ decks: [], answers: [] }), true);
  if ('caches' in window) await caches.delete(`anki-media-${uid}`);
}
export async function downloadDeck(uid: number, deckId: number) {
  const sessionToken = localStorage.getItem('token');
  const checkSession = () => { if (!sessionToken || localStorage.getItem('token') !== sessionToken) throw new Error('Session changed; download cancelled.'); };
  checkSession();
  if (import.meta.env.VITE_API_URL && new URL(import.meta.env.VITE_API_URL, location.origin).origin !== location.origin) throw new Error('Offline downloads require the app and API on the same origin.');
  const saved = await localAccount(uid), old = saved.decks.find(d => d.deck.id === deckId);
  type Pull = { deck: OfflineDeck['deck']; cards: CachedCard[]; notes: OfflineNote[]; deleted: string[]; versions: Record<string, string>; revision: string; next_cursor?: number | null; media: Record<string, { hash: string; size: number }> };
  const { data } = await client.post<Pull>('/api/sync/pull', { deck_id: deckId, known: old?.versions || {} });
  let cursor = data.next_cursor;
  while (cursor) {
    checkSession();
    const { data: page } = await client.post<Pull>('/api/sync/pull', { deck_id: deckId, known: old?.versions || {}, after_id: cursor });
    if (page.revision !== data.revision || (page.next_cursor && page.next_cursor <= cursor)) throw new Error('Deck changed during download; try again.');
    data.cards.push(...page.cards); data.notes.push(...page.notes);
    Object.assign(data.versions, page.versions); Object.assign(data.media, page.media);
    cursor = page.next_cursor;
  }
  data.notes = [...new Map(data.notes.map(note => [note.id, note])).values()];
  checkSession();
  if ('caches' in window) {
    const estimate = await navigator.storage?.estimate();
    const required = Object.values(data.media).reduce((n, file) => n + file.size, 0);
    if (estimate?.quota && estimate.usage && estimate.quota - estimate.usage < required) throw new Error('Not enough browser storage for this deck and its media.');
    const cache = await caches.open(`anki-media-${uid}`);
    for (const [filename, file] of Object.entries(data.media)) {
      const url = `/api/media/${uid}/${encodeURIComponent(filename)}`;
      const existing = await cache.match(url);
      if (existing?.headers.get('X-Content-Hash') === file.hash) continue;
      const response = await fetch(url, { cache: 'reload' });
      if (!response.ok) throw new Error(`Could not download media: ${filename}`);
      const bytes = await response.arrayBuffer();
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
      if (digest !== file.hash) throw new Error('Media changed during download; download again.');
      const headers = new Headers(response.headers); headers.set('X-Content-Hash', digest);
      checkSession();
      await cache.put(url, new Response(bytes, { headers }));
    }
  }
  checkSession();
  await changeLocal(uid, account => {
    if (account.answers.some(a => a.card_id.toString() in data.versions)) throw new Error('Resolve pending answers before refreshing this deck.');
    const cards = new Map((old?.cards || []).map(c => [c.card_id, c]));
    data.deleted.forEach(id => cards.delete(Number(id)));
    data.cards.forEach(card => cards.set(card.card_id, card));
    const deck = { notes: data.notes, deck: data.deck, cards: [...cards.values()], versions: data.versions, revision: data.revision, saved_at: new Date().toISOString() };
    return { ...account, decks: [...account.decks.filter(d => d.deck.id !== deckId), deck] };
  });
}
export async function synchronize(uid: number) {
  // A replay is idempotent on the server, so multiple tabs may safely retry.
  const sessionToken = localStorage.getItem('token');
  const checkSession = () => { if (!sessionToken || localStorage.getItem('token') !== sessionToken) throw new Error('Session changed; sync cancelled.'); };
  checkSession();
  const saved = await localAccount(uid);
  for (const answer of saved.answers) {
    checkSession();
    if (answer.conflict) continue;
    const { question: _question, conflict: _conflict, ...payload } = answer;
    try {
      await client.post('/api/sync/review', payload);
      checkSession();
      await changeLocal(uid, current => ({ ...current, needs_refresh: true, answers: current.answers.filter(a => a.request_id !== answer.request_id) }));
    } catch (e) {
      checkSession();
      const error = e as { response?: { status?: number; data?: { detail?: string } } };
      if (error.response && [404, 409, 422].includes(error.response.status || 0)) {
        await changeLocal(uid, current => ({ ...current, answers: current.answers.map(a => a.request_id === answer.request_id ? { ...a, conflict: typeof error.response?.data?.detail === 'string' ? error.response.data.detail : 'Review conflict' } : a) }));
      } else throw e;
    }
  }
  for (const edit of (await localAccount(uid)).edits || []) {
    checkSession();
    if (edit.conflict) continue;
    // Replay reviews before changing their question; unresolved reviews stay intact.
    const current = await localAccount(uid);
    const siblings = new Set(current.decks.flatMap(d => d.cards).filter(c => c.note_id === edit.note_id).map(c => c.card_id));
    if (current.answers.some(a => siblings.has(a.card_id))) continue;
    const { conflict: _conflict, remote: _remote, conflicting_fields: _fields, ...payload } = edit;
    try {
      await client.post('/api/sync/note', payload);
      checkSession();
      await changeLocal(uid, account => ({ ...account, needs_refresh: true, edits: (account.edits || []).filter(e => e.request_id !== edit.request_id) }));
    } catch (e) {
      checkSession();
      const error = e as { response?: { status?: number; data?: { detail?: string | { message: string; remote: OfflineNote; fields: string[] } } } };
      if (error.response && [400, 404, 409, 422].includes(error.response.status || 0)) {
        const detail = error.response.data?.detail;
        const info = typeof detail === 'object' && 'remote' in detail ? detail : undefined;
        await changeLocal(uid, account => ({ ...account, edits: (account.edits || []).map(item => item.request_id === edit.request_id ? { ...item, conflict: info?.message || (typeof detail === 'string' ? detail : 'Edit could not be applied'), remote: info?.remote, conflicting_fields: info?.fields } : item) }));
      } else throw e;
    }
  }
  for (const deck of (await localAccount(uid)).decks) {
    try { await downloadDeck(uid, deck.deck.id); }
    catch (error) {
      if ((error as { response?: { status: number } }).response?.status !== 404) throw error;
      await changeLocal(uid, current => ({ ...current, decks: current.decks.filter(d => d.deck.id !== deck.deck.id) }));
    }
  }
  await changeLocal(uid, account => ({ ...account, needs_refresh: false }));
}


export async function saveOfflineEdit(uid: number, note: OfflineNote, fields: Record<string, string>, tags: string[]) {
  await changeLocal(uid, account => {
    if (account.needs_refresh) throw new Error('Sync first to refresh changes applied in the background.');
    const existing = (account.edits || []).find(e => e.note_id === note.id);
    if (existing) throw new Error('This note already has a queued edit. Sync or resolve it before editing again.');
    return { ...account, edits: [...(account.edits || []), { request_id: crypto.randomUUID(), note_id: note.id, guid: note.guid, schema_hash: note.schema_hash, base_fields: note.fields, base_tags: note.tags, fields, tags }] };
  });
  await requestBackgroundSync();
}

export async function requestBackgroundSync() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration && 'sync' in registration) await (registration as ServiceWorkerRegistration & { sync: { register(tag: string): Promise<void> } }).sync.register('anki-offline');
  } catch { /* Foreground sync remains available. */ }
}

export async function enableBackgroundSync(uid: number, enabled: boolean) {
  const token = localStorage.getItem('token');
  if (enabled && !token) throw new Error('Sign in before enabling background sync.');
  await changeLocal(uid, account => ({ ...account, background: enabled ? { token: token! } : undefined }));
  if (enabled) await requestBackgroundSync();
}
