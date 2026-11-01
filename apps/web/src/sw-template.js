// Generated at build time by vite.config.ts (offlineShell). Caches the app shell
// and bundled runtime assets only; never intercepts relays, gateways or artifact
// downloads (all cross-origin), and never caches model bytes (those live in OPFS).
const VERSION = '__VERSION__';
const ASSETS = __ASSETS__;
const CACHE = `wexare-shell-${VERSION}`;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('wexare-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('./', { cacheName: CACHE })));
    return;
  }
  e.respondWith(caches.match(e.request, { cacheName: CACHE }).then((r) => r || fetch(e.request)));
});
