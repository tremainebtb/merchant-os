// Bump CACHE on every deploy - this is what forces a stale phone to pick up new code.
const CACHE = 'kym-v22';
const ASSETS = ['./', './index.html', './app.js?v=22', './manifest.json', './icon.svg', './favicon.ico'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// Network-first for the app shell (so a merchant with signal always gets the latest
// version), falling back to cache only when offline. This is what makes offline work
// WITHOUT trapping people on old code once they have signal again.
//
// {cache:'no-store'} here is load-bearing - without it, this "network-first" fetch
// can still be silently satisfied by the BROWSER's own plain HTTP cache underneath,
// which defeats the whole point (found live, 27 Aug: two real deploys never reached
// an already-visited browser because of exactly this).
self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request, { cache: 'no-store' }).then(res => {
      const resClone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, resClone));
      return res;
    }).catch(() => caches.match(e.request).then(cached => cached || caches.match('./index.html')))
  );
});
