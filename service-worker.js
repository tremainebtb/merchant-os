// Bump CACHE on every deploy - this is what forces a stale phone to pick up new code.
const CACHE = 'kym-v55';
const ASSETS = ['./', './index.html', './app.js?v=55', './safety.html', './manifest.json', './icon.svg', './favicon.ico'];

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
  // Real bug, found in review 2 Sep: this handler used to intercept EVERY
  // request, including the cross-origin POSTs that carry voice audio and
  // photos to the API Worker. On a dead connection the catch below answered
  // those with the cached index.html - an HTML page with status 200 - so the
  // app read a network failure as a valid empty result and told the user
  // "couldn't find any amounts in that photo" instead of "no connection".
  // (It also tried to cache.put() a POST, which throws.) Only the app shell
  // is ours to cache: same-origin GETs, nothing else.
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-store' }).then(res => {
      const resClone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, resClone));
      return res;
    }).catch(() => caches.match(e.request).then(cached => cached || caches.match('./index.html')))
  );
});
