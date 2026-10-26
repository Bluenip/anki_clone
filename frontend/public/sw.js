// Retire installations of the former offline worker. Keep this URL available
// so browsers still running the old application can receive the removal.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  await self.clients.claim();
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith('anki-shell-') || key.startsWith('anki-media-')).map(key => caches.delete(key)));
  await self.registration.unregister();
})()));
