// Bump CACHE on every deploy — this is what forces a stale phone to pick up new code.
const CACHE = 'kym-v3';
const ASSETS = ['./', './index.html', './app.js', './manifest.json', './icon.svg'];

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
self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request).then(res => {
      const resClone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, resClone));
      return res;
    }).catch(() => caches.match(e.request).then(cached => cached || caches.match('./index.html')))
  );
});
