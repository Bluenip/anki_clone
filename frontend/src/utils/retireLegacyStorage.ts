// Upgrade cleanup only: no new worker, local study queue or background sync.
export async function retireLegacyStorage() {
  try { localStorage.removeItem('offline-user'); } catch { /* Storage may be restricted. */ }
  await Promise.allSettled([
    (async () => {
      if (!('serviceWorker' in navigator)) return;
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.filter(registration =>
        [registration.active, registration.waiting, registration.installing].some(worker => worker?.scriptURL === `${location.origin}/sw.js`)
      ).map(registration => registration.unregister()));
    })(),
    (async () => {
      if (!('caches' in window)) return;
      const keys = await caches.keys();
      await Promise.all(keys.filter(key => key.startsWith('anki-shell-') || key.startsWith('anki-media-')).map(key => caches.delete(key)));
    })(),
    new Promise<void>(resolve => {
      if (!('indexedDB' in window)) { resolve(); return; }
      const request = indexedDB.deleteDatabase('anki-offline-v1');
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    }),
  ]);
}
