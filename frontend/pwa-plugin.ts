import type { Plugin } from 'vite'
import { createHash } from 'node:crypto'

export function offlineShell(): Plugin {
  return {
    name: 'foodflow-offline-shell',
    generateBundle(_, bundle) {
      const assets = Object.keys(bundle).filter(name => !name.endsWith('.map'))
      const version = createHash('sha256').update(assets.join('\n')).digest('hex').slice(0, 16)
      this.emitFile({ type: 'asset', fileName: 'service-worker.js', source: `
const CACHE = 'foodflow-shell-${version}';
const ASSETS = ${JSON.stringify([...new Set(['/', '/index.html', '/icon.svg', '/manifest.webmanifest', ...assets.map(name => '/' + name)])])};
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('foodflow-shell-') && key !== CACHE).map(key => caches.delete(key))))));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || event.request.headers.has('Authorization')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.open(CACHE).then(cache => cache.match('/index.html'))));
  } else if (ASSETS.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(event.request)).then(cached => cached || fetch(event.request)));
  }
});` })
    },
  }
}
