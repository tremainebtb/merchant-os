// Bump CACHE on every deploy - this is what forces a stale phone to pick up new code.
const CACHE = 'kym-v179';
const ASSETS = ['./', './index.html', './app.js?v=179', './safety.html', './seguridad.html', './privacidad.html', './manifest.json', './icon.svg', './favicon.ico'];

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

// Evening reminder (25 Sep). The push carries nothing; the words come from
// this phone's own book, read here, so no amount ever travels to write them.
self.addEventListener('message', e => {
  if (e.data && e.data.kymPrefs) e.waitUntil(caches.open('kym-prefs').then(c => c.put('/__prefs', new Response(JSON.stringify(e.data.kymPrefs)))));
});
function todayEntries() {
  return new Promise(resolve => {
    try {
      const req = indexedDB.open('merchantos', 1);
      req.onerror = () => resolve([]);
      req.onupgradeneeded = () => { try { req.transaction.abort(); } catch (x) { /* never create it here */ } resolve([]); };
      req.onsuccess = () => {
        try {
          const all = req.result.transaction('entries', 'readonly').objectStore('entries').getAll();
          all.onsuccess = () => {
            const d = new Date();
            const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
            resolve((all.result || []).filter(e => e.day === key));
          };
          all.onerror = () => resolve([]);
        } catch (x) { resolve([]); }
      };
    } catch (x) { resolve([]); }
  });
}
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let es = false;
    try { const r = await caches.open('kym-prefs').then(c => c.match('/__prefs')); if (r) es = !!(await r.json()).es; } catch (x) { /* default English */ }
    const list = await todayEntries();
    const sum = t => list.filter(x => x.type === t).reduce((a, x) => a + (Number(x.amount) || 0), 0);
    const sold = Math.round(sum('sale') * 100) / 100, spent = Math.round(sum('expense') * 100) / 100;
    const n = v => v.toLocaleString('en-GH');
    let body;
    if (!list.length) body = es ? 'Hoy no has anotado nada. \u00bfQu\u00e9 vendiste?' : 'Nothing written today. What did you sell?';
    else if (es) body = 'Hoy: vendiste ' + n(sold) + ', gastaste ' + n(spent) + '. \u00bfAlgo m\u00e1s para anotar?';
    else body = 'Today: sold GH\u20b5' + n(sold) + ', spent GH\u20b5' + n(spent) + '. Anything else to write?';
    await self.registration.showNotification('CountMy', { body, icon: 'icon.svg', tag: 'kym-evening', renotify: true, data: { url: es ? './?lang=es&r=push' : './?r=push' } });
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './?r=push';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { c.navigate(url).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
