// Bump CACHE on every deploy - this is what forces a stale phone to pick up new code.
const CACHE = 'kym-v178';
const ASSETS = ['./', './index.html', './app.js?v=178', './safety.html', './seguridad.html', './privacidad.html', './manifest.json', './icon.svg', './favicon.ico'];

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
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  const url = new URL(e.request.url);
  // 25 Sep QA: every visit re-downloaded the 90 KB app (2.3 s on 3G) even with
  // a copy on the phone. app.js?v=N never changes for a given N, so the
  // phone's copy is used first.
  if (/\/app\.js$/.test(url.pathname) && url.searchParams.get('v')) {
    e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      if (res && res.ok) { const c = res.clone(); caches.open(CACHE).then(ca => ca.put(e.request, c)); }
      return res;
    })));
    return;
  }
  const network = fetch(e.request, { cache: 'no-store' }).then(res => {
    const resClone = res.clone();
    caches.open(CACHE).then(c => c.put(e.request, resClone));
    return res;
  });
  const fallback = () => caches.match(e.request).then(cached => cached || caches.match('./index.html'));
  if (e.request.mode === 'navigate') {
    // A page: the network if it answers within 3 s, else the phone's copy
    // (the network answer still refreshes the copy for next time).
    e.respondWith(new Promise(resolve => {
      let settled = false;
      const timer = setTimeout(() => { caches.match(e.request).then(cached => { if (cached && !settled) { settled = true; resolve(cached); } }); }, 3000);
      network.then(res => { clearTimeout(timer); if (!settled) { settled = true; resolve(res); } })
        .catch(() => { clearTimeout(timer); if (!settled) { settled = true; resolve(fallback()); } });
    }));
    return;
  }
  e.respondWith(network.catch(fallback));
});
