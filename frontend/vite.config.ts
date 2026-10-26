import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), {
    name: 'offline-shell',
    generateBundle(_, bundle) {
      const assets = ['/', '/index.html', '/manifest.webmanifest', '/offline-icon.svg', ...Object.keys(bundle).map(name => '/' + name)];
      const version = createHash('sha256').update(JSON.stringify(bundle)).digest('hex').slice(0, 16);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: `
${readFileSync(new URL('./src/worker/backgroundSync.js', import.meta.url), 'utf8')}
const SHELL = 'anki-shell-${version}';
const ASSETS = ${JSON.stringify(assets)};
self.addEventListener('install', event => event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('anki-shell-') && key !== SHELL) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const media = url.pathname.match(/^\\/api\\/media\\/(\\d+)\\//);
  if (media) {
    event.respondWith((async () => {
      try { const response = await fetch(event.request); if (response.ok) return response; } catch {}
      const cached = await (await caches.open('anki-media-' + media[1])).match(event.request);
      return cached || new Response('Media unavailable offline', { status: 503 });
    })()); return;
  }
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(async () => (await (await caches.open(SHELL)).match('/index.html')) || Response.error())); return;
  }
  if (ASSETS.includes(url.pathname)) event.respondWith(caches.open(SHELL).then(async cache => (await cache.match(event.request)) || fetch(event.request)));
});` });
    },
  }],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
