// App and worker share the same account store. Network calls never hold IDB locks.
function offlineDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('anki-offline-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('accounts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function withOfflineAccount(uid, change) {
  const db = await offlineDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('accounts', change ? 'readwrite' : 'readonly');
      const store = tx.objectStore('accounts'), request = store.get(uid);
      let value;
      request.onsuccess = () => { value = request.result; if (change && value) { value = change(value); store.put(value, uid); } };
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
async function backgroundSync() {
  const db = await offlineDB();
  const keys = await new Promise((resolve, reject) => { const request = db.transaction('accounts').objectStore('accounts').getAllKeys(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  db.close();
  for (const uid of keys) {
    const initial = await withOfflineAccount(uid), token = initial?.background?.token;
    if (!token) continue;
    for (const kind of ['answers', 'edits']) {
      const saved = await withOfflineAccount(uid);
      for (const item of saved?.[kind] || []) {
        if (item.conflict) continue;
        const current = await withOfflineAccount(uid);
        if (current?.background?.token !== token) break;
        if (!(current[kind] || []).some(value => value.request_id === item.request_id)) continue;
        if (kind === 'edits') {
          const siblings = new Set(current.decks.flatMap(d => d.cards).filter(c => c.note_id === item.note_id).map(c => c.card_id));
          if (current.answers.some(a => siblings.has(a.card_id))) continue;
        }
        const { question: _q, conflict: _c, remote: _r, conflicting_fields: _f, ...payload } = item;
        const response = await fetch(kind === 'answers' ? '/api/sync/review' : '/api/sync/note', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
        const data = await response.json();
        if (!response.ok && ![400, 401, 404, 409, 422].includes(response.status)) throw Error('Background sync temporarily unavailable');
        await withOfflineAccount(uid, account => {
          if (account.background?.token !== token) return account;
          if (response.status === 401) return { ...account, background: undefined };
          if (response.ok) return { ...account, needs_refresh: true, [kind]: (account[kind] || []).filter(value => value.request_id !== item.request_id) };
          const detail = data.detail, info = detail && typeof detail === 'object' && 'remote' in detail ? detail : undefined;
          return { ...account, [kind]: (account[kind] || []).map(value => value.request_id === item.request_id ? { ...value, conflict: info?.message || (typeof detail === 'string' ? detail : 'Sync conflict'), ...(info ? { remote: info.remote, conflicting_fields: info.fields } : {}) } : value) };
        });
        if (response.status === 401) break;
      }
    }
  }
  for (const client of await self.clients.matchAll({ type: 'window' })) client.postMessage({ type: 'offline-sync-complete' });
}
self.addEventListener('sync', event => { if (event.tag === 'anki-offline') event.waitUntil(backgroundSync()); });
