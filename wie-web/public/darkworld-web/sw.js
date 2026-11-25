// Offline copy of this page's program files. The game data the player put in (data.js) lives in its own
// cache, 'dwweb-data', which is never cleared here; other pages of this site keep their caches too.
const VERSION = 'dwweb-app-18';
const FILES = ['./', './index.html', './dw.js', './input.js', './cheat.js', './data.js', './core.js', './plus.js', './core.wasm', './manifest.json', './icon-192.png', './icon-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('dwweb-app-') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// program files: the network first (an update is used right away), the cache when offline
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(fetch(e.request, { cache: 'no-store' }).then((r) => {
    if (r.ok && FILES.some((f) => new URL(f, self.registration.scope).pathname === url.pathname)) {
      const copy = r.clone();
      caches.open(VERSION).then((c) => c.put(url.pathname, copy));
    }
    return r;
  }).catch(() => caches.open(VERSION).then((c) => c.match(url.pathname))));
});
