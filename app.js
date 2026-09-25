// Real feedback, 28 Aug, from a real outside tester: "the audio isn't too
// clear." Two real, controllable factors this addresses: (1) speechSynthesis
// with no explicit voice/volume set falls back to whatever the browser
// picks first, which is sometimes a low-quality or network-dependent voice;
// (2) a voice requiring a live network round-trip to synthesize (localService
// === false) can sound choppy or degraded on the slow/expensive connections
// this app is built for. Preferring a local, on-device English voice is a
// real, bounded improvement - it is not a fix for whatever the underlying
// platform TTS engine itself sounds like, which this app has no control over.
// Real feedback, 29 Aug: "the voice... perhaps to be in English Ghanaian
// way and not western world English." No browser/OS ships an actual
// Ghanaian English voice today - that's a real, checkable limit, not
// something to fake. The honest, bounded improvement available: Ghanaian
// English follows British spelling/pronunciation convention (a British
// colonial-era legacy, still how English is taught in Ghanaian schools),
// not American - so a British or other Commonwealth-English voice reads
// as meaningfully closer and more familiar than the US-English voice most
// browsers default to. Checked in this order, falling through only when
// the previous tier has nothing installed on this device: an actual
// Ghanaian voice (checked in case one ever ships - free to ask for),
// other African-English locales some Android TTS engines do carry, then
// British English, then any English at all.
const VOICE_LANG_PRIORITY = ['en-gh', 'en-ng', 'en-za', 'en-ke', 'en-gb'];
function pickBestVoice() {
  if (!('speechSynthesis' in window)) return null;
  const voices = speechSynthesis.getVoices();
  const enVoices = voices.filter(v => v.lang && v.lang.toLowerCase().startsWith('en'));
  for (const lang of VOICE_LANG_PRIORITY) {
    const match = enVoices.find(v => v.lang.toLowerCase() === lang);
    if (match) return match;
  }
  const localEn = enVoices.find(v => v.localService);
  return localEn || enVoices[0] || voices[0] || null;
}

function speakClearly(utter) {
  utter.voice = pickBestVoice();
  utter.volume = 1;
  return utter;
}

// ---------------------------------------------------------------------------
// Language (17 Sep): English for Ghana, Spanish for Venezuela. Chosen once
// from ?lang=, then remembered; otherwise the phone's own language decides.
// t(en, es) is the whole translation layer - every user-facing sentence
// passes through it, so the code reads as English with Spanish beside it.
// ---------------------------------------------------------------------------
function detectLang() {
  try {
    const q = new URLSearchParams(location.search).get('lang');
    if (q === 'es' || q === 'en') { localStorage.setItem('kym_lang', q); return q; }
    const saved = localStorage.getItem('kym_lang');
    if (saved === 'es' || saved === 'en') return saved;
    // Phone language decides only when nothing else has. A phone set to
    // Spanish inside Africa (a Ghana ad click on an oddly configured phone)
    // still gets English; Spanish from the phone needs an Americas or
    // Europe clock. ?lang= and the saved choice above always win.
    let tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e2) { /* optional */ }
    if (/^Africa\//.test(tz)) return 'en';
    return /^es\b/i.test(navigator.language || '') ? 'es' : 'en';
  } catch (e) { return 'en'; }
}
const LANG = detectLang();
const ES = LANG === 'es';
document.documentElement.lang = ES ? 'es' : 'en';
const t = (en, es) => (ES ? es : en);
// Real bug, 22 Sep: the footer was static HTML, so every visitor - Spanish
// included - saw "Cedi exchange rates today", which means nothing to
// someone in Venezuela or Colombia. Rewritten once at load for ES.
if (ES) {
  const fr = document.getElementById('footerRates'); if (fr) { fr.href = 'rates/es/index.html'; fr.textContent = 'Tasas de cambio hoy'; }
  const fg = document.getElementById('footerGuides'); if (fg) { fg.href = 'guides/cuaderno-de-ventas-diarias.html'; fg.textContent = 'Guías para tu negocio'; }
  const fs = document.getElementById('footerSafety'); if (fs) { fs.href = 'seguridad.html'; fs.textContent = '¿Es seguro CountMy?'; }
  const fw = document.getElementById('footerWa'); if (fw) { fw.href = fw.href.replace('Hello%2C%20I%20have%20a%20question%20about%20CountMy', 'Hola%2C%20tengo%20una%20pregunta%20sobre%20CountMy'); fw.textContent = 'Escríbenos por WhatsApp'; }
  const rl = document.querySelector('#recoverSheet a.export-btn');
  if (rl) rl.href = rl.href.replace('Hello%2C%20I%20lost%20my%20phone%20and%20I%20need%20my%20CountMy%20records%20back.%20My%20shop%20name%20is%3A%20', 'Hola%2C%20perd%C3%AD%20mi%20tel%C3%A9fono%20y%20necesito%20recuperar%20mis%20cuentas%20de%20CountMy.%20El%20nombre%20de%20mi%20negocio%20es%3A%20');
}
// Country (17 Sep): Venezuela and Colombia share Spanish but not money or
// words. ?c=CO / ?c=VE wins, then what the server saw on the first ping
// (X-Country), then the phone's clock zone, then its locale. Ghana for
// English. tc(ve, co) picks Colombian wording when it differs.
function detectCountry() {
  try {
    const q = new URLSearchParams(location.search).get('c');
    if (q && /^[A-Za-z]{2}$/.test(q)) { localStorage.setItem('kym_country', q.toUpperCase()); return q.toUpperCase(); }
    const saved = localStorage.getItem('kym_country');
    if (saved && /^[A-Z]{2}$/.test(saved)) return saved;
    const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone || '');
    if (/Bogota/.test(tz)) return 'CO';
    if (/Caracas/.test(tz)) return 'VE';
    const nl = navigator.language || '';
    if (/-CO$/i.test(nl)) return 'CO';
    if (/-VE$/i.test(nl)) return 'VE';
  } catch (e) { /* fall through */ }
  return ES ? 'VE' : 'GH';
}
const COUNTRY = detectCountry();
const CO = ES && COUNTRY === 'CO';
const tc = (ve, co) => (CO ? co : ve);
// Default currency for typed entries: Colombia pesos, Venezuela dollars.
const HOME_CUR = CO ? 'COP' : 'USD';
// The Book home screen (v169, 24 Sep). The one switch back: set
// BOOK_DEFAULT to false and the old home returns for everyone. ?book=0
// shows the old home on one phone, for comparing. See "The Book" below.
var BOOK_DEFAULT = true;
var BK_IAB_TALK = false; // set by the in-app browser block (Book + Facebook Android)
// Home-screen test (25 Sep). The owner: "don't waste time - results, no
// guessing". Two designs, decided by what real visitors do, not by opinion:
// 'book' (the exercise-book page, v169+) and 'today' (Today numbers + one
// big Tell CountMy - ChatGPT's first choice, and the home of v103-v168).
// Only brand-new phones are split, 50/50, and each keeps its design;
// anyone who has opened CountMy before stays on the Book they know.
// ?book=1 / ?book=0 force a design on one phone without being saved.
// Measured per design through the version tag (v175book / v175today) on
// every ping - /admin/source-daily splits by it.
// 25 Sep: the head of index.html now decides the design before first paint
// (a slow phone used to show the Today tiles for seconds, then jump to the
// Book). Same rules, one place; this copy only runs if that script did not.
var HOME_VARIANT = (window.KYM_HOME === 'book' || window.KYM_HOME === 'today') ? window.KYM_HOME : (function () {
  try {
    const q = new URLSearchParams(location.search).get('book');
    if (q === '0') return 'today';
    if (q === '1') return 'book';
    // Home test ended 25 Sep (owner's call): inside Facebook's browser the
    // Today arm was a typing box, not the design it claimed to be, so the
    // test could not answer its question. Everyone is on the Book.
    localStorage.setItem('kym_home', 'book');
    return 'book';
  } catch (e) { return 'book'; }
})();
var BOOK_ON = BOOK_DEFAULT && HOME_VARIANT === 'book';
// Set here, not in init: the in-Facebook ping fires before init runs and was
// reaching the server with an empty version, so it could not be split by design.
window.KYM_VERSION = ((document.querySelector('meta[name="countmy-version"]') || {}).content || 'unknown') + (BOOK_ON ? 'book' : 'today');
// Real bug, found 24 Sep: afterEntrySaved() called escapeHtml, which never
// existed, so the "send it to your own WhatsApp" prompt after a first save
// threw inside its try and silently never showed.
function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
// Venezuela keeps two currencies: dollars are the reference, bolívares the
// day-to-day cash. An entry carries cur 'USD' | 'VES' (voice sets it from the
// words spoken; typed entries are dollars). Ghana entries have no cur.
function fmt(n, cur) {
  const v = Number(n) || 0;
  if (!ES) return v.toLocaleString('en-GH', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' cedis';
  cur = cur || HOME_CUR;
  if (cur === 'COP') return '$' + Math.round(v).toLocaleString('es-CO', { maximumFractionDigits: 0 });
  const s = v.toLocaleString('es-VE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return cur === 'VES' ? 'Bs. ' + s : '$' + s;
}
// Spoken amounts: plain digits (a voice reads "1.500" as a decimal), whole
// numbers, and the currency word; Colombian pesos in "20 mil" form.
function fmtSay(n, cur) {
  const v = Number(n) || 0;
  if (!ES) return fmt(v);
  cur = cur || HOME_CUR;
  if (cur === 'COP') {
    const w = Math.round(v);
    if (w >= 1000000) { const m = Math.floor(w / 1000000), r = w % 1000000; const mw = m === 1 ? 'mill\u00f3n' : 'millones'; return r ? `${m} ${mw} ${fmtSay(r, 'COP')}` : `${m} ${mw} de pesos`; }
    if (w >= 1000) { const k = Math.floor(w / 1000), r = w % 1000; return `${k} mil${r ? ' ' + r : ''} pesos`; }
    return `${w} pesos`;
  }
  const whole = Math.round(v * 100) / 100;
  const digits = Number.isInteger(whole) ? String(whole) : String(Math.floor(whole)) + ' con ' + Math.round((whole % 1) * 100);
  return digits + (cur === 'VES' ? ' bol\u00edvares' : ' d\u00f3lares');
}

// ---------------------------------------------------------------------------
// Spoken replies (17 Sep). the owner's verdict on the phone's built-in voice was
// blunt and right. say() fetches a short clip from the Worker (/say - a real
// voice, Spanish included), keeps it in the Cache API so fixed phrases cost
// once, and plays it through one AudioContext unlocked by any tap (the only
// way iOS lets audio play a second after the tap). If the server is capped,
// offline, or slow to fail, the phone's own voice speaks the same words -
// the words never go missing, only the quality changes.
// ---------------------------------------------------------------------------
// Real bug, 18 Sep, from a Samsung tablet in Ghana on Android 11: the
// page recorded and the server heard, then the phone said "Something went
// wrong" - its Chrome had no crypto.randomUUID (added in Chrome 92). Every
// id now falls back to random bytes, and older phones keep working.
function newId() {
  try { if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID(); } catch (e) { /* fall through */ }
  const b = new Uint8Array(16);
  try { crypto.getRandomValues(b); } catch (e) { for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256); }
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}
let ttsCtx = null, ttsCurrent = null, ttsFailedAt = 0;
const ttsMem = new Map();
function ttsUnlock() {
  try {
    if (!ttsCtx) ttsCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (ttsCtx.state === 'suspended') ttsCtx.resume();
  } catch (e) { ttsCtx = null; }
}
document.addEventListener('pointerup', ttsUnlock, { passive: true });
document.addEventListener('touchend', ttsUnlock, { passive: true });
function ttsKey(text) { return '/say?l=' + LANG + '&c=' + COUNTRY + '&t=' + encodeURIComponent(String(text).trim().slice(0, 220)); }
async function ttsFetch(key) {
  let cache = null;
  try { cache = await caches.open('kym-tts-v1'); const hit = await cache.match(key); if (hit) return hit; } catch (e) { cache = null; }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  try {
    const res = await fetch(API_BASE + key, { signal: ac.signal });
    const isAudio = /^audio\//.test(res.headers.get('content-type') || '');
    if (res.ok && isAudio && cache) { try { await cache.put(key, res.clone()); } catch (e) { /* cache is a bonus */ } }
    if (res.ok && !isAudio) throw new Error('not audio');
    return res;
  } finally { clearTimeout(timer); }
}
function ttsForget(key) { try { caches.open('kym-tts-v1').then(c => c.delete(key)); } catch (e) { /* ok */ } }
function ttsDecode(ab) {
  // Promise form works on every engine; old iOS only has the callback form.
  return new Promise((resolve, reject) => { try { const p = ttsCtx.decodeAudioData(ab, resolve, reject); if (p && p.then) p.then(resolve, reject); } catch (e) { reject(e); } });
}
// Long replies are said sentence by sentence (a clip is capped at 220 chars).
function splitForSpeech(text) {
  const parts = String(text).match(/[^.!?]+[.!?]*\s*/g) || [String(text)];
  const out = []; let cur = '';
  for (const p of parts) { if ((cur + p).length > 200 && cur) { out.push(cur.trim()); cur = p; } else cur += p; }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}
function ttsPrefetch(text) { try { ttsFetch(ttsKey(text)).catch(() => {}); } catch (e) { /* optional */ } }
function phoneSpeak(text, onend) {
  if (!('speechSynthesis' in window)) { if (onend) onend(); return; }
  try {
    const u = speakClearly(new SpeechSynthesisUtterance(text));
    u.rate = 0.85;
    u.lang = ES ? 'es-VE' : 'en-GB';
    if (ES) { const v = speechSynthesis.getVoices().find(x => /^es/i.test(x.lang || '')); if (v) u.voice = v; }
    let done = false; const fin = () => { if (!done) { done = true; if (onend) onend(); } };
    u.onend = fin; u.onerror = fin;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    setTimeout(fin, 15000);
  } catch (e) { if (onend) onend(); }
}
let ttsToken = 0;
function stopSpeaking() {
  ttsToken++;
  try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch (e) { /* ok */ }
  if (ttsCurrent) { try { ttsCurrent.stop(); } catch (e) { /* ok */ } ttsCurrent = null; }
}
async function playClip(text) {
  const key = ttsKey(text);
  const tok = ttsToken; // stopSpeaking() bumps this: a clip that arrives late must stay silent
  let buf = ttsMem.get(key);
  if (!buf) {
    const res = await ttsFetch(key);
    if (tok !== ttsToken) return;
    if (!res || !res.ok) throw new Error('tts ' + (res && res.status));
    try { buf = await ttsDecode(await res.arrayBuffer()); } catch (e) { ttsForget(key); throw e; }
    if (!buf) throw new Error('no buffer');
    if (text.length <= 40) ttsMem.set(key, buf); // only short fixed phrases stay in memory
  }
  if (tok !== ttsToken) return;
  if (ttsCtx.state !== 'running') { await Promise.race([ttsCtx.resume(), new Promise(r => setTimeout(r, 1500))]); }
  if (tok !== ttsToken) return;
  if (ttsCtx.state !== 'running') throw new Error('phone');
  const src = ttsCtx.createBufferSource();
  src.buffer = buf; src.connect(ttsCtx.destination);
  ttsCurrent = src;
  await new Promise(resolve => {
    let done = false; const fin = () => { if (!done) { done = true; if (ttsCurrent === src) ttsCurrent = null; resolve(); } };
    src.onended = fin;
    setTimeout(fin, (buf.duration || 5) * 1000 + 600);
    src.start();
  });
}
function say(text, opts) {
  text = String(text || '').trim();
  const onstart = opts && opts.onstart, onend = opts && opts.onend;
  if (!text) return Promise.resolve();
  const fallback = () => new Promise(resolve => { if (onstart) onstart(); phoneSpeak(text, () => { if (onend) onend(); resolve(); }); });
  return (async () => {
    stopSpeaking();
    const myToken = ttsToken;
    try {
      if (!ttsCtx) ttsUnlock();
      if (!ttsCtx || (Date.now() - ttsFailedAt) < 60000) throw new Error('phone');
      const pieces = splitForSpeech(text);
      if (onstart) onstart();
      for (const piece of pieces) {
        if (myToken !== ttsToken) break; // something newer is speaking
        await playClip(piece);
      }
      if (onend) onend();
    } catch (err) {
      if (!/phone/.test(String(err))) ttsFailedAt = Date.now();
      if (myToken !== ttsToken) { if (onend) onend(); return; }
      return fallback();
    }
  })();
}
// Fixed phrases, fetched once so the first tap never waits on the network.
setTimeout(() => { ttsPrefetch(t('Speak now.', 'Habla ahora.')); ttsPrefetch(t('Saved.', 'Guardado.')); }, 2500);

const DB_NAME = 'merchantos';
const STORE = 'entries';
let db;

// 25 Sep QA: when a cheap phone's storage never answers, the app used to
// wait forever - no Write it, not even the "open" ping. Six seconds, then an
// error the caller can show.
function openDB() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
    const timer = setTimeout(() => reject(new Error('idb open timeout')), 6000);
    req.onsuccess = () => {
      clearTimeout(timer);
      const d = req.result;
      // the browser (Facebook's iPhone webview, 18 Sep) can close the
      // connection under us; forget it so the next call reopens
      d.onclose = () => { if (db === d) db = null; };
      d.onversionchange = () => { try { d.close(); } catch (e) { /* fine */ } if (db === d) db = null; };
      resolve(d);
    };
    req.onupgradeneeded = () => {
      const d = req.result;
      const store = d.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      store.createIndex('day', 'day');
      store.createIndex('type', 'type');
    };
    req.onerror = () => { clearTimeout(timer); reject(req.error); };
  });
}
// Every transaction goes through here: a connection that has been closed
// ("The database connection is closing") is reopened once and retried.
async function dbTx(mode) {
  if (!db) db = await openDB();
  try { return db.transaction(STORE, mode); }
  catch (e) {
    if (e && (e.name === 'InvalidStateError' || /clos/i.test(String(e.message || '')))) { db = await openDB(); return db.transaction(STORE, mode); }
    throw e;
  }
}

function todayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Real request, 30 Aug: if a phone is lost, broken, or an entry gets deleted
// by mistake (a real elderly first-time user, not a hypothetical one), there
// was no way to get it back - records lived ONLY in this device's IndexedDB.
// the owner's explicit call: automatic, no toggle, no extra button - "less
// confusion or buttons or worries for users" - over an opt-in backup setting.
// Same privacy shape as ping(): the shop id is hashed server-side before it
// touches storage (see worker.js handleSync), this is best-effort/fire-and-
// forget, and it never blocks or fails the real local save if it's offline
// or the request fails.
// No data, slow data (25 Sep): a save made offline, or whose backup request
// failed, used to be skipped for good - never backed up, so it could not
// follow her to another browser or survive a lost phone. Such ids now wait
// in a small queue and are sent when the phone is back online, when the app
// opens, and when she comes back to it.
function unsyncedQueue() { try { return JSON.parse(localStorage.getItem('kym_unsynced') || '[]'); } catch (e) { return []; } }
function setUnsynced(list) { try { if (list.length) localStorage.setItem('kym_unsynced', JSON.stringify(list.slice(-2000))); else localStorage.removeItem('kym_unsynced'); } catch (e) { /* storage full or blocked */ } }
function markUnsynced(id, deleted) { if (!id) return; const q = unsyncedQueue().filter(x => x.id !== id); q.push({ id, del: deleted ? 1 : 0 }); setUnsynced(q); }
function markSynced(id) { const q = unsyncedQueue(); if (q.some(x => x.id === id)) setUnsynced(q.filter(x => x.id !== id)); }
let flushing = false;
async function flushUnsynced() {
  if (flushing || window.KYM_IS_OWNER_DEVICE || !navigator.onLine) return;
  const q = unsyncedQueue(); if (!q.length) return;
  flushing = true;
  try {
    const byId = new Map((await getAllEntries()).map(e => [e.id, e]));
    for (const x of q) {
      if (x.del) syncEntryToServer({ id: x.id }, true);
      else if (byId.has(x.id)) syncEntryToServer(byId.get(x.id), false);
      else markSynced(x.id); // gone from the phone: nothing left to send
    }
  } catch (e) { /* next time */ }
  flushing = false;
}
window.addEventListener('online', () => { flushUnsynced(); });
function syncEntryToServer(entry, deleted) {
  try {
    if (window.KYM_IS_OWNER_DEVICE) return;
    if (!navigator.onLine) { markUnsynced(entry && entry.id, deleted); return; }
    const shop = getShopId() || getDeviceId();
    fetch(`${API_BASE}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shop, entry, deleted: !!deleted, test: isTestDevice() }),
      // Same keepalive gap as ping() (see 23 Sep note there) - without it, a
      // real save right before someone closes or backgrounds the page can
      // fail to reach the server, so "backed up" never gets set even though
      // the entry itself is safely saved locally.
      keepalive: true
    }).then(res => {
      // Only on a real server confirmation - claiming "backed up" because a
      // request was merely sent would be the same broken promise the apps
      // that lost people's records made.
      if (res && res.ok) { markSynced(entry.id); markBackedUp(); renderBackupStatus(); }
      else markUnsynced(entry && entry.id, deleted);
    }).catch(() => { markUnsynced(entry && entry.id, deleted); });
  } catch (err) {
    // Local storage already committed. A backup setup failure must not hold it open.
  }
}

// Real request, 30 Aug: "I need to see the ledger entries saved and I need
// to see the not saved" - a real, sourced funnel gap both ChatGPT and
// Gemini independently flagged as the actual question worth answering
// (32 users, 7 saves - what happened to everyone else who tried and didn't
// finish?). Mirrors an attempt that was shown to the owner but deliberately
// rejected (voice Discard) or a typed entry abandoned mid-fill (Cancel with
// something already entered) - never something that was merely glanced at
// and closed with nothing typed, which isn't a real attempt. Uses the same
// /sync endpoint and one-way shop hash as a real save, just tagged
// status:'not_saved' so it never gets counted as a real ledger entry.
function syncNotSaved(entryLike) {
  if (window.KYM_IS_OWNER_DEVICE) return;
  if (!navigator.onLine) return;
  if (!entryLike || (!entryLike.item && !entryLike.price)) return;
  const shop = getShopId() || getDeviceId();
  fetch(`${API_BASE}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      shop,
      entry: { id: newId(), ...entryLike, status: 'not_saved' },
      deleted: false,
      test: isTestDevice()
    }),
    keepalive: true // same gap as ping() and syncEntryToServer - see the 23 Sep note above
  }).catch(() => {});
}

function addEntry(entry) {
  return new Promise(async (resolve, reject) => {
    let tx;
    try { tx = await dbTx('readwrite'); } catch (e) { reject(e); return; }
    const req = tx.objectStore(STORE).add(entry);
    let reqError = null;
    req.onerror = (e) => { reqError = req.error; e.preventDefault(); tx.abort(); };
    tx.oncomplete = () => { syncEntryToServer(entry, false); resolve(); };
    tx.onerror = () => reject(reqError || tx.error || new Error('addEntry failed'));
    tx.onabort = () => reject(reqError || tx.error || new Error('addEntry aborted'));
  });
}

function deleteEntry(id) {
  return new Promise(async (resolve, reject) => {
    let tx;
    try { tx = await dbTx('readwrite'); } catch (e) { reject(e); return; }
    tx.objectStore(STORE).delete(id);
    // Delete-only payload, deliberately just the id: the entry's real content
    // was already mirrored server-side when it was first created (or last
    // edited), so a deletion only ever needs to flip the server's flag, never
    // resend content the client no longer has once this transaction commits.
    tx.oncomplete = () => { syncEntryToServer({ id }, true); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

function updateEntry(id, patch) {
  return new Promise(async (resolve, reject) => {
    let tx;
    try { tx = await dbTx('readwrite'); } catch (e) { reject(e); return; }
    const store = tx.objectStore(STORE);
    const req = store.get(id);
    let merged = null;
    req.onsuccess = () => {
      const rec = req.result;
      if (rec) { merged = Object.assign(rec, patch); store.put(merged); }
    };
    tx.oncomplete = () => { if (merged) syncEntryToServer(merged, false); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

function getAllEntries() {
  return new Promise(async (resolve, reject) => {
    let tx;
    try { tx = await dbTx('readonly'); } catch (e) { reject(e); return; }
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.ts - a.ts));
    req.onerror = () => reject(req.error);
  });
}

// Titles and field labels below are plain English on purpose - the ES
// block right after this object (search TYPE_LABEL) already overwrites
// cfg.title and every field/option label for Spanish, keyed off the same
// entry type. Only compute/confirm/desc live here, and those are NOT
// touched by that block, so they get their own t()/tc() calls below.
const FIELD_CONFIG = {
  sale: {
    title: 'Add sale',
    // Real advice, repeated independently by both AI reviews and visibly
    // core to AxisTrade's own design (Cash/MoMo/Credit shown as colored
    // dots on every sale) - Ghanaian traders think in cash vs MoMo as a
    // basic fact about a sale, not an accounting afterthought. Credit
    // sales already have their own flow ("Customer owes me"), so this
    // choice only covers the two ways an already-paid sale actually came
    // in. Missing/old entries default to "cash" - the exact same math as
    // before, nothing silently changes.
    fields: [
      { key: 'item', label: 'What did you sell?', type: 'text' },
      { key: 'qty', label: 'How many?', type: 'number' },
      { key: 'price', label: 'Price each (cedis)', type: 'number' },
      {
        key: 'method', label: 'How were you paid?', type: 'choice', default: 'cash',
        options: [
          { value: 'cash', label: 'Cash' },
          { value: 'momo', label: 'MoMo' }
        ]
      }
    ],
    compute: v => (Number(v.qty) || 0) * (Number(v.price) || 0),
    confirm: v => {
      const total = (Number(v.qty) || 0) * (Number(v.price) || 0);
      if (!v.item || !v.qty || !v.price) return '';
      return t(`${v.qty} \u00d7 ${v.item} at ${fmt(v.price)} = ${fmt(total)}`, `${v.qty} \u00d7 ${v.item} a ${fmt(v.price)} = ${fmt(total)}`);
    },
    desc: v => `${v.qty} \u00d7 ${v.item}`,
    amountSign: 1
  },
  expense: {
    title: 'Add expense',
    // Real problem, flagged independently by two separate strategy reviews,
    // 28 Aug: with only one "Expense" bucket, buying 2,000 cedis of stock to
    // resell later looked identical to losing 2,000 cedis - "Sales minus
    // expenses" would show a huge loss on restock day even though nothing
    // was actually lost. This new choice splits the two without adding real
    // complexity: two big tap targets, not a dropdown or an accounting term
    // to learn. Missing/old entries (voice-created, or saved before this
    // existed) default to "running" - the exact same math as before, so no
    // historical entry silently changes meaning.
    fields: [
      { key: 'item', label: 'What did you spend on?', type: 'text' },
      { key: 'price', label: 'Amount (cedis)', type: 'number' },
      // Third choice added 4 Sep. Mixing household money with shop money is
      // repeatedly documented as a real problem for Ghanaian traders, and
      // "chop money" taken from the till is neither a shop cost nor a loss -
      // it is the owner's own money leaving. Counted in neither Expenses nor
      // Money left over (it is not a cost of trading, so it must not make a
      // good day look bad), but it IS taken off Cash you have now, because
      // that cash genuinely is not in the till any more.
      {
        key: 'kind', label: 'What kind of spend?', type: 'choice', default: 'running',
        options: [
          { value: 'running', label: 'Business cost' },
          { value: 'stock', label: 'Stock to sell' },
          { value: 'home', label: 'Took home' }
        ]
      }
    ],
    compute: v => Number(v.price) || 0,
    confirm: v => {
      if (!v.item || !v.price) return '';
      return `${v.item} \u2014 ${fmt(v.price)}`;
    },
    desc: v => v.item + (v.kind === 'stock' ? t(' (stock)', ' (mercanc\u00eda)') : v.kind === 'home' ? t(' (took home)', ' (para la casa)') : ''),
    amountSign: -1
  },
  debt_in: {
    title: 'Customer owes me',
    fields: [
      { key: 'item', label: 'Customer name', type: 'text' },
      { key: 'price', label: 'Amount they owe (cedis)', type: 'number' },
      { key: 'note', label: 'What for (optional)', type: 'text' }
    ],
    compute: v => Number(v.price) || 0,
    confirm: v => {
      if (!v.item || !v.price) return '';
      return t(`${v.item} owes you ${fmt(v.price)}`, `${v.item} te debe ${fmt(v.price)}`);
    },
    // Real feedback, 28 Aug (a 55-year-old first-time user, low literacy/
    // numeracy): the Recent list used to show just the name ("Ama") with
    // direction implied only by a +/- sign and a color - "customer who owed
    // me and supplier getting messy" is exactly what that produces for
    // someone who can't reliably read a red/green + or -. Say the direction
    // in words every time, not just via sign/color.
    desc: v => t(`${v.item} owes you`, `${v.item} te debe`) + (v.note ? ' \u2014 ' + v.note : ''),
    amountSign: 1,
    isDebt: true
  },
  debt_out: {
    title: 'I owe supplier',
    fields: [
      { key: 'item', label: 'Supplier name', type: 'text' },
      { key: 'price', label: 'Amount you owe (cedis)', type: 'number' },
      { key: 'note', label: 'What for (optional)', type: 'text' }
    ],
    compute: v => Number(v.price) || 0,
    confirm: v => {
      if (!v.item || !v.price) return '';
      return t(`You owe ${v.item} ${fmt(v.price)}`, `Le debes a ${v.item} ${fmt(v.price)}`);
    },
    desc: v => t(`You owe ${v.item}`, `Le debes a ${v.item}`) + (v.note ? ' \u2014 ' + v.note : ''),
    amountSign: -1,
    isDebt: true
  },
  // 22 Sep, from a real session: a shop owner tried to record a customer's
  // repayment through "Customer owes me" (typed "00"/"00", never finished),
  // even though the payment-matching logic already existed and already
  // worked - for voice only (applyVoicePayment). The gap was never the
  // logic, it was that a typed/tapped user had no tile that led to it; the
  // only place it lived was tapping an existing debt's own row in history,
  // which nobody reaches for when something NEW just happened. This wires
  // the same tested logic to the same "add new thing" tiles everyone
  // already uses. No new entry of type 'payment' is ever persisted -
  // saveEntry() special-cases this type and calls applyVoicePayment
  // instead, exactly like the voice path does.
  payment: {
    title: 'Someone paid you',
    fields: [
      { key: 'item', label: 'Who paid you?', type: 'text' },
      { key: 'price', label: 'How much (cedis)', type: 'number' }
    ],
    compute: v => Number(v.price) || 0,
    confirm: v => {
      if (!v.item || !v.price) return '';
      return t(`${v.item} paid you ${fmt(v.price)}`, `${v.item} te pag\u00f3 ${fmt(v.price)}`);
    }
  }
};

let activeType = null;

const API_BASE = 'https://countmy-api.boatengbobby.workers.dev';

// Voice v1 (Web Speech API) was removed 27 Aug after real-device testing \u2014 broken on
// iOS Safari and unreliable on Android Chrome on weak mobile data (it ran fully
// on-device via the browser, no server, so a bad phone or a bad signal broke it with
// no fallback). Voice v2 (below) fixes the actual cause, not just the symptom: record
// raw audio with MediaRecorder (broadly supported on both platforms) and send it to a
// real hosted transcription service (OpenAI Whisper, via the countmy-api Worker) \u2014
// same job, a server doing the hard part instead of the phone. This is the product's
// core differentiator for shop owners who don't reliably read or type English \u2014
// voice is the primary path, typing is the fallback, not the other way round.
let mediaRecorder = null;
let recordedChunks = [];

function micSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

// 17 Sep, from Clarity + five real users saying "it can't hear me": every ad
// click lands inside Facebook's or Instagram's own in-app browser, which
// refuses the microphone with no prompt at all. The app used to answer
// "go to your phone's Settings" - impossible in there. Now: say what it is,
// offer Chrome (Android intent link keeps the same page and ad tracking),
// and put the typed choices right there.
function inAppBrowser() {
  const ua = navigator.userAgent || '';
  // Test hook: ?iabtest=android renders the in-app screen in a normal browser (used with ?owner=1 so nothing is counted).
  try { if (/[?&]iabtest=/.test(location.search)) return true; } catch (e) { /* optional */ }
  if (/FBAN|FBAV|FB_IAB|Instagram|Messenger\/|Line\/|MicroMessenger|WhatsApp|Telegram|Snapchat|TikTok|GSA\//i.test(ua)) return true;
  // Any other app's built-in browser (WhatsApp, Gmail, Telegram open links
  // inside themselves): Android WebView says "; wv)"; an iPhone WKWebView
  // has no "Safari/" token and is not Chrome or Firefox for iOS.
  if (/Android/i.test(ua) && /;\s*wv\)/.test(ua)) return true;
  // 25 Sep: CountMy added to an iPhone Home Screen also has no Safari token
  // and was treated as Facebook's browser (Open-in-Safari card, no reminders -
  // the only place iPhone reminders can work). Installed = not in-app.
  if (isStandalone()) return false;
  if (/iPhone|iPad|iPod/i.test(ua) && !/Safari\//i.test(ua) && !/CriOS|FxiOS|EdgiOS/i.test(ua)) return true;
  return false;
}
// Records follow the person (25 Sep). Her book lives in the browser that
// wrote it, so Facebook's browser, Chrome and WhatsApp's browser each had a
// separate, empty one: the Talk button (opens Chrome) and the "tomorrow,
// press this" WhatsApp link both landed on a blank book. Every save is
// already backed up under this phone's random id; links that leave carry it
// (k) plus the home design (h), and the other browser restores the same book.
// Never added when a typed Shop ID is in use (that can be guessed).
function withBookKey(url) {
  try {
    if (!url || url === '#' || getShopId()) return url;
    const add = 'k=' + encodeURIComponent(getDeviceId()) + '&h=' + HOME_VARIANT;
    const m = /^instagram:\/\/.*[?&]url=([^&]+)/.exec(url);
    if (m) { const inner = decodeURIComponent(m[1]); return url.replace(m[1], encodeURIComponent(inner + (inner.indexOf('?') >= 0 ? '&' : '?') + add)); }
    const i = url.indexOf('#Intent');
    const head = i < 0 ? url : url.slice(0, i), tail = i < 0 ? '' : url.slice(i);
    return head + (head.indexOf('?') >= 0 ? '&' : '?') + add + tail;
  } catch (e) { return url; }
}
function isAndroid() { try { if (/[?&]iabtest=android/.test(location.search)) return true; } catch (e) { /* optional */ } return /Android/i.test(navigator.userAgent || ''); }
function chromeIntentUrl() {
  const bare = location.href.replace(/^https?:\/\//, '');
  return 'intent://' + bare + '#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(location.href) + ';end';
}
function showOpenInChrome(reason) {
  let box = document.getElementById('iabBanner');
  if (!box) {
    box = document.createElement('div');
    box.id = 'iabBanner';
    box.className = 'iab-banner';
    // In the Book the mic sits inside the button row, so the notice goes
    // under the row instead of into it.
    const btn = document.getElementById(BOOK_ON ? 'homeMicStatus' : 'homeMicBtn');
    if (btn && btn.parentNode) btn.parentNode.insertBefore(box, btn); else return;
  }
  const lead = reason === 'failed'
    ? t('Facebook\u2019s browser cannot use the microphone.', 'El navegador de Facebook no puede usar el micr\u00f3fono.')
    : t('You are inside Facebook\u2019s browser \u2014 the microphone may not work here.', 'Est\u00e1s dentro del navegador de Facebook: puede que el micr\u00f3fono no funcione aqu\u00ed.');
  box.innerHTML = isAndroid()
    ? `<p>${lead}</p><a class="iab-open" href="${withBookKey(chromeIntentUrl())}">${t('Open in Chrome', 'Abrir en Chrome')}</a><p class="iab-sub">${t('Same page, and your voice will work.', 'Es la misma p\u00e1gina, y ah\u00ed s\u00ed funciona la voz.')}</p><label class="iab-note"><input type="file" accept="audio/*" capture id="iabNoteInput">\uD83C\uDF99 ${t('Or record a voice note here', 'O graba una nota de voz aqu\u00ed')}</label>`
    : `<p>${lead}</p><a class="iab-open" href="${withBookKey(window.KYM_SAFARI_URL || ('x-safari-https://' + location.host + location.pathname + '?from=iab'))}">${t('Open in Safari', 'Abrir en Safari')}</a><p class="iab-sub">${t('Same page, and your voice will work. If nothing opens: tap <b>\u22ef</b> at the top, then <b>Open in Safari</b>.', 'Es la misma p\u00e1gina, y ah\u00ed s\u00ed funciona la voz. Si no se abre: toca <b>\u22ef</b> arriba y luego <b>Abrir en Safari</b>.')}</p>`;
  box.hidden = false;
  const noteIn = document.getElementById('iabNoteInput');
  if (noteIn && !noteIn.dataset.wired) {
    noteIn.dataset.wired = '1';
    noteIn.addEventListener('change', async () => {
      const f = noteIn.files && noteIn.files[0]; if (!f) return;
      ping('iab_note'); track('iab_note', { bytes: f.size, type: f.type });
      pendingVoiceSource = 'voice';
      setMicStatus(t('Listening to your voice note\u2026', 'Escuchando tu nota de voz\u2026'), null, 'homeMicStatus');
      await processVoiceBlob(f, 'homeMicStatus', 5000, f.size);
      noteIn.value = '';
    });
  }
}
function showTypedChoices() {
  // In the Book the tap buttons are already on screen: point at them.
  if (BOOK_ON) { bookNudgeTiles(); return; }
  try {
    const box = document.getElementById('typeChoices'); const tt = document.getElementById('typeToggle');
    if (box) box.hidden = false; if (tt) tt.hidden = true;
  } catch (e) { /* never block */ }
}
// Every voice failure ends here: said out loud (the audience does not read),
// written under the button, counted on the owner dashboard by class only
// (never the words), and the typed choices opened so the page still works.
// Owner phones (the owner's and his family's, marked with ?owner=1): each step
// of a voice attempt is written to the server log so a test can be read
// without being there. Other phones never send this.
function ownerLog(step, info) {
  try {
    if (!window.KYM_IS_OWNER_DEVICE) return;
    fetch(`${API_BASE}/owner-log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ step, info: String(info || '').slice(0, 300), ver: window.KYM_VERSION || '' }), keepalive: true }).catch(() => {});
  } catch (e) { /* never block */ }
}
function micFail(msg, pingName, statusId) {
  ownerLog('fail', (pingName || '') + ' | ' + msg);
  if (!pingName || pingName === 'mic_server') ownerLog('lastError', window.__lastVoiceError || '');
  setMicStatus(msg, 'err', statusId);
  speakShort(msg);
  if (pingName) ping(pingName);
  showTypedChoices();
}

function setMicStatus(text, cls, statusId) {
  const el = document.getElementById(statusId || 'homeMicStatus');
  el.textContent = text;
  // Toggle only the state classes - overwriting className used to wipe the
  // 'snap-status' class off #snapStatus and leave a blank line under the grid.
  el.classList.remove('heard', 'err');
  if (cls) el.classList.add(cls);
}

// Review finding, 2 Sep: a fetch with no timeout can sit in "Reading your
// photo..." for minutes on the everyday MTN state of signal bars but no
// data (the browser's own socket timeout is minutes long). 45s is well past
// any real round trip on a working connection. And a response that is not
// JSON (a captive portal page, a proxy error page) is a failed request, not
// an empty result - it must not be read as "the model found nothing".
const API_TIMEOUT_MS = 45000;
async function postToApi(path, form) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, { method: 'POST', body: form, signal: ac.signal });
    const ctype = res.headers.get('content-type') || '';
    if (ctype.indexOf('json') === -1) {
      const e = new Error(res.status >= 500 ? 'Voice is resting right now \u2014 please type it, just below.' : 'No connection \u2014 please try again, or type it.');
      e.status = res.status;
      throw e;
    }
    const data = await res.json().catch(() => ({}));
    return { res, data };
  } finally {
    clearTimeout(timer);
  }
}

// Server/transport error text is spoken aloud to the user, so it has to be a
// plain sentence, never a status word like "too many requests".
function plainApiError(err, res, data, fallback) {
  if (err && err.name === 'AbortError') return 'Taking too long \u2014 please check your connection and try again.';
  if (res && res.status === 429) return 'Too many tries right now \u2014 please wait a minute and try again.';
  if (res && res.status >= 500) return 'Voice is resting right now \u2014 please type it, just below.';
  if (res && res.status === 413) return 'That photo is too big \u2014 please take it again.';
  if (err && /connection/i.test(err.message || '')) return err.message;
  return fallback;
}

// Deliberately simple, not NLP: pulls every number out of what was heard, and treats
// whatever text is left (after stripping filler words) as the item/name. Good enough
// for "five bags of rice at ten cedis each" or "Ama owes me fifty cedis for soap" \u2014
// exactly the short, spoken-number sentences a shop owner actually says. Never
// auto-saves \u2014 this only fills the same fields typing would, so the owner still sees
// and confirms the number before it's written, same as every other entry path.
const NUMBER_WORDS = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
  eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,twenty:20,thirty:30,forty:40,fifty:50,
  sixty:60,seventy:70,eighty:80,ninety:90,hundred:100 };

// Real bug, found 28 Aug from real outside-family feedback ("you need to
// mention the figures then type again"): this used to (a) not tolerate
// "and" between number words at all, so "one hundred and fifty" split into
// two separate matches instead of one, and (b) summed every word word's
// face value additively even for "hundred" - "one hundred" came out as 101
// (1+100), not 100, and "one hundred and fifty" lost the 50 entirely once
// split. Cedi amounts routinely use exactly this "X hundred and Y" shape,
// so this silently corrupted a very common real spoken price.
// "and" is only matched as an optional connector between two real number
// words, never standing alone - so "rice and beans" is never touched.
const NUMBER_WORD_LIST = Object.keys(NUMBER_WORDS).join('|');
const NUMBER_WORD_RE = new RegExp(
  '\\b(?:' + NUMBER_WORD_LIST + ')(?:[\\s-]+(?:and[\\s-]+)?(?:' + NUMBER_WORD_LIST + '))*\\b', 'gi'
);

// What Google's and Apple's recognisers make of Ghanaian money words and
// dishes (18 Sep, the owner's phone: "bowls" and "cedis" both came out wrong).
// Same map as the server's repairTranscript, so the phone path and the
// server path hear the same thing.
// The phone's own Twi (18 Sep): numerals and the few debt words, the same
// table the server uses, for the moments the server cannot answer.
const TWI_NUM = { baako: 1, koro: 1, mmienu: 2, mienu: 2, abien: 2, mmiensa: 3, miensa: 3, abiesa: 3, enan: 4, anan: 4, nan: 4, anum: 5, enum: 5, num: 5, nsia: 6, asia: 6, nson: 7, ason: 7, nwotwe: 8, awotwe: 8, nkron: 9, akron: 9, du: 10, edu: 10, dubaako: 11, dummienu: 12, dumienu: 12, dumiensa: 13, dunan: 14, dunum: 15, dunsia: 16, dunson: 17, dunwotwe: 18, dunkron: 19, aduonu: 20, aduasa: 30, aduanan: 40, aduonum: 50, aduosia: 60, aduoson: 70, aduowotwe: 80, aduokron: 90, oha: 100, ha: 100, ahanu: 200, ahaanu: 200, ahasa: 300, ahanan: 400, ahanum: 500, ahasia: 600, ahason: 700, ahawotwe: 800, ahakron: 900, apem: 1000, aduenum: 50, adunsia: 60, adunson: 70, adunwotwe: 80, adunkron: 90, opepem: 1000000 };
function twiToEnglish(text) {
  let t = String(text || '');
  const fold = w => w.toLowerCase().replace(/\u0254/g, 'o').replace(/\u025b/g, 'e');
  // Kept in step with twiPrep in the worker - see the comment there.
  t = t.replace(/\bmpem\s+([a-z\u0254\u025b]+)\b/gi, (m, word) => {
    const v = TWI_NUM[fold(word)];
    return (v && v < 1000) ? String(v * 1000) : m;
  });
  const isNum = w => Object.prototype.hasOwnProperty.call(TWI_NUM, fold(w));
  const words = t.split(/(\s+|[.,;!?]+)/), isSep = w => /^(\s+|[.,;!?]+)$/.test(w), out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w || isSep(w) || !isNum(w)) { out.push(w); continue; }
    let sum = TWI_NUM[fold(w)], last = sum, j = i + 1;
    while (j < words.length) {
      let k = j; while (k < words.length && (isSep(words[k]) || fold(words[k]) === 'ne')) k++;
      if (k >= words.length || !isNum(words[k])) break;
      const v = TWI_NUM[fold(words[k])]; if (v >= last) break;
      sum += v; last = v; j = k + 1;
    }
    out.push(String(sum)); i = j - 1;
  }
  t = out.join('');
  t = t.replace(/\b(\w+)\s+(a?tuaa?|tua)\s+(ne\s+)?(ka|sika)\b/gi, '$1 paid');
  t = t.replace(/\bme\s+de\s+([A-Za-z]+)\s+ka\b/gi, 'I owe $1').replace(/\b([A-Za-z]+)\s+de\s+me\s+ka\b/gi, '$1 owes me');
  t = t.replace(/\bobi\b/gi, 'customer');
  t = t.replace(/\b(hwan|hena)\s+na\s+[o\u0254]?de\s+me\s+ka\b/gi, 'who owes me');
  t = t.replace(/\b(obetua|\u0254b\u025btua)\s+(okyena|\u0254ky\u025bna)\b/gi, 'will pay tomorrow').replace(/\b(obetua|\u0254b\u025btua)\b/gi, 'will pay').replace(/\b(okyena|\u0254ky\u025bna)\b/gi, 'tomorrow');
  t = t.replace(/\bme\s+t[o\u0254]n\b/gi, 'I sold').replace(/\bme\s+t[o\u0254]\b/gi, 'I bought').replace(/\b(don|done)\s+pay\b/gi, 'paid');
  // Kept in step with twiPrep in the worker - see the comment there (19 Sep).
  t = t.replace(/\b(mm?iako|maku|makuo)\s+(mm?iako|maku|makuo)\b/gi, 'each');
  t = t.replace(/\b(mbaire|bayire)\b/gi, 'bayere');
  t = t.replace(/\banwummer[e\u025b]\b/gi, 'evening').replace(/\bawiaber[e\u025b]\b/gi, 'afternoon').replace(/\ban[o\u0254]pa\b/gi, 'morning');
  t = t.replace(/\b[e\u025b]nnora\b/gi, 'yesterday');
  t = t.replace(/\b([e\u025b]nn[e\u025b]|nn[e\u025b])\b/gi, 'today');
  t = t.replace(/\bkwasiada\b/gi, 'sunday').replace(/\b[e\u025b]?dwoada\b/gi, 'monday').replace(/\b[e\u025b]?benada\b/gi, 'tuesday')
    .replace(/\bwukuada\b/gi, 'wednesday').replace(/\byaw[ou]ada\b/gi, 'thursday').replace(/\b[e\u025b]?fiada\b/gi, 'friday')
    .replace(/\bmemene?da\b/gi, 'saturday');
  t = t.replace(/\bdap[e\u025b]n\s+a\s+[e\u025b]reba(\s+yi)?\b/gi, 'next week');
  return t;
}
function repairHeard(text) {
  let t = String(text || '');
  if (ES) {
    t = t.replace(/\b(bonos|volos|bolo)\b/gi, 'bolos').replace(/\bver(bes|ves)\b/gi, 'verdes').replace(/\b(bi-?es|b\.s\.|bes)\b/gi, 'bs');
    return t;
  }
  t = t.replace(/\b(studies|sities|sadis|sedis|sidis|cedes|ceedis|seedies|seedis|cds|cd|cidis|cities|city's|series|cedi's|cedis)\b/gi, 'cedis');
  t = t.replace(/\b(\d+)\s*(c|gh|ghc|gh\u20b5|\u20b5)\b/gi, '$1 cedis').replace(/\bGH\s?[C\u20b5]\s?(\d+)/gi, '$1 cedis').replace(/\$\s?(\d+)\b/g, '$1 cedis');
  t = t.replace(/\b(balls|bowels|bows|boles|bolts)\s+(of\s+)?(waakye|wache|rice|fufu|banku|kenkey|soup|beans|gari|tz|koko|porridge)\b/gi, 'bowls $2$3');
  t = t.replace(/\b(wache|watchy|walkie|wakye|waky|wacky|watch key|wahkyi)\b/gi, 'waakye');
  t = t.replace(/\b(fu fu|foo foo)\b/gi, 'fufu').replace(/\b(ban ku|bonku)\b/gi, 'banku').replace(/\b(ken key|kinky|kenkay)\b/gi, 'kenkey');
  t = t.replace(/\b(job|shop|chap|chob) money\b/gi, 'chop money').replace(/\b(tro tro|trotro|trot row|troto|tractual|toronto|tortoro|trotter|throw throw|tro-tro)\s+(fair|fare|fear)\b/gi, 'trotro fare');
  t = t.replace(/\b(uma|umo|momu|mumu|mo mo)\b/gi, 'momo').replace(/\b(air time|hair time|our time)\b/gi, 'airtime');
  t = t.replace(/\b(t shirts?|tee shirts?|teeshirts?)\b/gi, m => /s$/i.test(m) ? 't-shirts' : 't-shirt');
  t = t.replace(/\by'?all\b/gi, 'Yaw').replace(/\bhigo\s+pay\b/gi, 'he go pay');
  return twiToEnglish(t);
}
function wordsToNumber(text) {
  return text.replace(NUMBER_WORD_RE, (phrase) => {
    const words = phrase.toLowerCase().split(/[\s-]+/).filter(w => w !== 'and');
    let current = 0;
    for (const w of words) {
      const val = NUMBER_WORDS[w];
      if (val === undefined) continue;
      if (val === 100) current = (current || 1) * 100;
      else current += val;
    }
    return String(current);
  });
}

// Two separate noise sources, handled in order: (1) real spoken disfluencies -
// "um", "ehm", "I think", "like" - people actually say these; (2) STT artifacts -
// free Workers AI Whisper sometimes mishears "cedis" as "cds" or similar short
// garbled tokens, which are meaningless leftovers, not real words. Strip both
// before showing the owner anything, since neither belongs in an item name.
const DISFLUENCY = /\b(um+|uh+|erm+|ehm+|hmm+|like|actually|basically|so|yeah|yep|okay|ok|please|thanks|thank you|hello|hi|today|i think|i mean|you know|kind of|sort of)\b/gi;
const FILLER = /\b(a|an|the|for|of|on|to|me|i|owe|owes|owing|dey|de|go|pay|will|later|tomorrow|today|he|she|they|it|at|each|cedis|cedi|ghs|cds|cd|sold|sell|spent|bought|buy|paid|is|was|and|momo|cash|from|come|take|took|still)\b/gi;

// Spanish filler for the typed fields. (?<![\w\u00c0-\u00ff]) instead of \b: JS
// word boundaries are ASCII-only, so "\ba\b" used to eat the "a" in "mercancía".
// 25 Sep: no lookbehind - iOS before 16.4 cannot parse one and the whole
// script died on those iPhones. The leading character is captured instead;
// it is replaced by a space like the word itself, so the result is the same.
const FILLER_ES = /(^|[^\w\u00c0-\u00ff])(d[o\u00f3]lares?|bol[i\u00edv]vares?|bolos?|bs|pesos?|lucas?|luca|verdes?|plata|de a|cada una|cada uno|vend[i\u00ed]|compr[e\u00e9]|gast[e\u00e9]|pagu[e\u00e9]|me debe|me qued[o\u00f3] debiendo|le fi[e\u00e9] a|le debo a|fiao|fiado|de|del|la|el|los|las|un|una|unos|unas|y|con|por|para|en|a|me|le|se|es|hoy)(?![\w\u00c0-\u00ff])/gi;
// Spanish money shorthand for the typed fields: "20 mil" / "20 lucas" = 20000,
// "un palo" = 1000000, "medio palo" = 500000 (Colombia).
function scaleSpanishMoney(text) {
  let t = String(text || '');
  t = t.replace(/\b(\d+(?:[.,]\d+)?)\s*(mil|lucas?|barras)\b/gi, (m, n) => String(Math.round(parseFloat(n.replace(',', '.')) * 1000)));
  t = t.replace(/\bmedio\s+(palo|mill\u00f3n|millon)\b/gi, '500000').replace(/\b(un|1)\s+(palo|mill\u00f3n|millon)\b/gi, '1000000').replace(/\b(\d+)\s+(palos?|millon(?:es)?|mill\u00f3n)\b/gi, (m, n) => String(Number(n) * 1000000));
  return t;
}
function parseHeardText(type, raw) {
  const text = ES ? scaleSpanishMoney(wordsToNumber(raw)) : wordsToNumber(raw);
  const numbers = (text.match(/\d+(\.\d+)?/g) || []).map(Number);
  const cleaned = text
    .replace(/\d+(\.\d+)?/g, ' ')
    .replace(ES ? /$^/g : DISFLUENCY, ' ')
    .replace(ES ? FILLER_ES : FILLER, ' ')
    .replace(/[.,!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const v = {};
  if (type === 'sale') {
    if (numbers.length >= 2) {
      v.qty = numbers[0]; v.price = numbers[1];
      // "3 bowls of waakye for 60 cedis" / "tres refrescos por 6" is the total
      // for all of them; "at 120 each" / "a 2 cada uno" is the price of one.
      const eachSaid = ES ? /\b(cada|c\/u|la unidad|por unidad)\b/i.test(text) : /\b(each|every one|apiece|per\s+\w+)\b/i.test(text);
      const totalSaid = ES ? new RegExp('\\b(por|en|total)\\s+' + numbers[1] + '\\b', 'i').test(text) : new RegExp('\\b(for|total|all for|altogether)\\s+' + numbers[1] + '\\b', 'i').test(text);
      if (totalSaid && !eachSaid && v.qty > 0 && numbers[1] % v.qty === 0) v.price = numbers[1] / v.qty;
    }
    else if (numbers.length === 1) { v.price = numbers[0]; v.qty = 1; }
    v.item = cleaned;
  } else {
    if (numbers.length >= 1) v.price = numbers[0];
    v.item = cleaned;
  }
  return v;
}

function fillFields(values) {
  Object.keys(values).forEach(key => {
    const inp = document.querySelector(`#fields input[data-key="${key}"]`);
    if (inp && values[key] !== undefined && values[key] !== '') inp.value = values[key];
  });
  updateConfirm();
}

// Real latency fix, 30 Aug, from real user feedback ("seems delayed...
// it's deffo delayed"): transcribeBlob() then extractEvents() used to be
// two separate round trips - wait for text back, then send it again and
// wait for events back. One extra full network round trip on top of an
// already-slow connection is exactly the wrong cost to add for the exact
// users this app is built for. This hits one combined endpoint
// (worker.js handleTranscribeAndExtract) that does both AI steps back-to-
// back on Cloudflare's edge and returns both results together.
async function transcribeAndExtract(blob, heardText) {
  // 18 Sep: the phone's own recogniser (Google's on Android Chrome, Apple's
  // on iPhone) is free and unlimited. When it produced words, only the
  // cheap text step runs on the server; Whisper is kept for phones without
  // it and for takes it could not make out.
  if (heardText) {
    let res, data;
    try {
      ({ res, data } = await postJson('/extract', { text: heardText, lang: LANG, country: COUNTRY }));
    } catch (err) {
      // Server unreachable: the phone heard the words, so the phone makes
      // the record itself (parseHeardText) rather than failing the person.
      track('extract_unavailable', { http: err.status || 0, why: err.name || 'network' });
      const lp = ES ? null : localPaymentEvent(heardText);
      return { text: heardText, events: lp ? [lp] : [], via: 'browser', degraded: true };
    }
    if (res.ok) return { text: heardText, events: shapeEvents(data.events), via: 'browser', sl: data.sl || '' };
    // The text step failed (daily quota, hiccup). With a clip, try the audio
    // path; without one, the phone's own parser takes over below.
    track('extract_unavailable', { http: res.status });
    if (!blob || !blob.size) { const lp = ES ? null : localPaymentEvent(heardText); return { text: heardText, events: lp ? [lp] : [], via: 'browser', degraded: true }; }
  }
  const ext = blob.type.indexOf('mp4') !== -1 || blob.type.indexOf('m4a') !== -1 ? 'mp4' : (blob.type.indexOf('ogg') !== -1 ? 'ogg' : (blob.type.indexOf('webm') !== -1 || !blob.type ? 'webm' : String(blob.type.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8)));
  const form = new FormData();
  form.append('audio', blob, `voice.${ext}`);
  form.append('lang', LANG);
  form.append('country', COUNTRY);
  form.append('ver', window.KYM_VERSION || '');
  if (window.KYM_IS_OWNER_DEVICE) form.append('dbg', 'owner'); // the owner's own phones: transcript goes to the server log so mishearings can be read and fixed
  let res, data;
  try {
    try {
      ({ res, data } = await postToApi('/transcribe-and-extract', form));
    } catch (first) {
      // One quiet retry on a server hiccup (a rare Cloudflare 1101 HTML page
      // was seen on 17 Sep); the person never hears about a failure that
      // heals in 2 s.
      if (!(first.status >= 500)) throw first;
      track('mic_retry', { http: first.status });
      ({ res, data } = await postToApi('/transcribe-and-extract', form));
    }
    if (res && res.status >= 500) { track('mic_retry', { http: res.status }); ({ res, data } = await postToApi('/transcribe-and-extract', form)); }
  } catch (err) {
    // 17 Sep: a fetch that never reached the server is a data/connection
    // problem, not "could not hear" - say so, and count it separately.
    const e = new Error(err.name === 'AbortError' ? plainApiError(err, null, null, '') : err.status ? (err.message || plainApiError(null, { status: err.status }, null, '')) : 'Could not send your voice \u2014 please check your data connection and try again, or type it below.');
    e.cls = err.name === 'AbortError' ? 'mic_timeout' : (err.status ? 'mic_server' : 'mic_network');
    e.http = err.status || 0;
    e.quota = !!(data && /daily free allocation|quota/i.test(String(data.detail || data.error || '')));
    throw e;
  }
  if (!res.ok && !data.text) {
    const e = new Error(plainApiError(null, res, data, 'The server could not read that recording \u2014 please try again, or type it below.'));
    e.cls = 'mic_server'; e.http = res.status;
    e.quota = /daily free allocation|quota/i.test(String((data && (data.detail || data.error)) || ''));
    throw e;
  }
  return { text: data.text || '', events: shapeEvents(data.events), via: 'whisper', sl: data.sl || '' };
}
// Real bug, 18 Sep (found by the red-team pass): a debt comes back from the
// server as {customer} or {supplier}, but every check on the phone looked
// for {item}, so a spoken "Esi dey owe me 40" was never auto-saved and the
// voice said "I heard an amount but not what it was for". The person's name
// is the item of a debt; the original field is kept for payments.
// The phone's own reading of "Ama paid me 20" / "Kofi don pay 50" / "Ama
// pay me back 30" when the server cannot help: a payment, never a sale.
function localPaymentEvent(text) {
  const t = wordsToNumber(String(text || ''));
  const m = /^\s*([a-zà-ÿ][a-zà-ÿ' -]{1,30}?)\s+(?:has\s+|don\s+|dey\s+)?(?:paid|pay|payed)\s+(?:me\s+)?(?:back\s+)?(?:small\s+)?(\d+(?:\.\d+)?)/i.exec(t)
    || /^\s*(?:received|collected|got)\s+(\d+(?:\.\d+)?)\s+from\s+([a-zà-ÿ][a-zà-ÿ' -]{1,30}?)\s*$/i.exec(t);
  if (!m) return null;
  const name = /^\d/.test(m[1]) ? m[2] : m[1], amount = Number(/^\d/.test(m[1]) ? m[1] : m[2]);
  if (!name || !(amount > 0) || /\b(for|of)\b/i.test(name) || /\b(for|of)\s+[a-z]/i.test(t.slice(m.index + m[0].length))) return null;
  return { type: 'payment', customer: name.trim(), price: amount };
}
function shapeEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.map(ev => {
    if (!ev || typeof ev !== 'object') return ev;
    if (!ev.item && (ev.customer || ev.supplier)) ev.item = String(ev.customer || ev.supplier).trim();
    // "kelewele 30" is one sale of 30: a sale with a price and no count is one
    if (ev.type === 'sale' && ev.price && (ev.qty === undefined || ev.qty === null || ev.qty === '')) ev.qty = 1;
    return ev;
  });
}
async function postJson(path, obj) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj), signal: ac.signal });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  } finally { clearTimeout(timer); }
}

// Photo entry, 2 Sep - the picture-shaped twin of transcribeAndExtract():
// one multipart upload to worker.js handleExtractFromImage, which reads the
// receipt or notebook page with a vision model and hands back the same
// { text, events } shape, so everything downstream (eventToEntry, the review
// cards) is shared, not duplicated.
async function extractFromImage(blob) {
  const form = new FormData();
  form.append('image', blob, 'photo.jpg');
  const fallback = 'Could not read that photo \u2014 please try again, or type it.';
  let res, data;
  try {
    ({ res, data } = await postToApi('/extract-from-image', form));
  } catch (err) {
    throw new Error(plainApiError(err, null, null, fallback));
  }
  if (!res.ok) throw new Error(plainApiError(null, res, data, fallback));
  return { text: data.text || '', events: Array.isArray(data.events) ? data.events : [] };
}

// Shrinks a camera photo ON the phone before it is uploaded. A modern phone
// camera produces a 3-5MB, 4000px image; sending that over the mobile data
// this audience pays for per megabyte, to read a few lines of handwriting, is
// the wrong trade. 1400px on the long edge is the smallest size at which
// receipt print and handwritten cedi amounts are still cleanly legible -
// deliberately NOT smaller, and JPEG quality deliberately not lower than 0.8:
// heavy compression is exactly what turns a "5" into a "6" for the model.
// Also strips EXIF (no GPS or device details leave the phone) and hands the
// Worker a plain JPEG whatever the phone's native format was (HEIC on
// iPhone, WebP on some Androids). Any decode failure throws so handleSnap can
// say so in words - a photo the phone cannot open must never look like the
// app silently doing nothing.
const PHOTO_MAX_EDGE = 1400;
async function shrinkPhoto(file) {
  // Decoded through <img> on purpose, not createImageBitmap: on iOS 15-16
  // createImageBitmap silently ignores the EXIF rotation (the
  // imageOrientation option only landed in Safari 17) and does not throw, so
  // a receipt shot in portrait would reach the model on its side. <img> has
  // honoured EXIF everywhere modern since Chrome 81 / Safari 13.1. One code
  // path, correct orientation.
  const source = await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('cannot decode image')); };
    img.src = url;
  });
  const srcW = source.width || source.naturalWidth;
  const srcH = source.height || source.naturalHeight;
  if (!srcW || !srcH) throw new Error('empty image');
  const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  // White under the photo: a transparent PNG (e.g. a screenshot of a note)
  // would otherwise come out black where it was transparent once it's JPEG.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  if (source.close) source.close();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  if (!blob) throw new Error('could not encode image');
  return blob;
}

const TYPE_LABEL = ES
  ? { sale: 'Venta', expense: 'Gasto', debt_in: 'Cliente me debe', debt_out: 'Le debo al proveedor' }
  : { sale: 'Sale', expense: 'Expense', debt_in: 'Customer owes me', debt_out: 'I owe supplier' };
if (ES) {
  // Spanish labels for the typed sheet. Same keys, same maths; only words.
  const L = {
    sale: { title: 'Agregar venta', item: '\u00bfQu\u00e9 vendiste?', qty: '\u00bfCu\u00e1ntos?', price: 'Precio de cada uno ($)', method: '\u00bfC\u00f3mo te pagaron?', cash: 'Efectivo', momo: tc('Pago M\u00f3vil', 'Nequi / transferencia') },
    expense: { title: 'Agregar gasto', item: '\u00bfEn qu\u00e9 gastaste?', price: '\u00bfCu\u00e1nto? ($)', kind: '\u00bfQu\u00e9 tipo de gasto?', business: 'Gasto del negocio', stock: 'Mercanc\u00eda para vender', home: 'Para la casa' },
    debt_in: { title: 'Cliente me debe', item: 'Nombre del cliente', price: '\u00bfCu\u00e1nto te debe? ($)', note: 'Por qu\u00e9 (opcional)' },
    debt_out: { title: tc('Le debo al proveedor', 'Debo al proveedor'), item: 'Nombre del proveedor', price: '\u00bfCu\u00e1nto le debes? ($)', note: 'Por qu\u00e9 (opcional)' },
    payment: { title: 'Alguien te pag\u00f3', item: '\u00bfQui\u00e9n te pag\u00f3?', price: '\u00bfCu\u00e1nto pag\u00f3? ($)' }
  };
  for (const ty of Object.keys(L)) {
    const cfg = FIELD_CONFIG[ty]; if (!cfg) continue;
    cfg.title = L[ty].title;
    (cfg.fields || []).forEach(f => {
      if (L[ty][f.key]) f.label = L[ty][f.key];
      (f.options || []).forEach(o => { if (L[ty][o.value]) o.label = L[ty][o.value]; });
    });
  }
}

// Turns one extracted event into the same shape addEntry() expects, computing
// the amount ourselves from the (already type-checked, by the Worker) qty/price -
// never trusting a pre-computed "total" from the model, since that's one more
// number it could get wrong independent of the two the owner can actually verify.
// Voice is the main way entries get in here, so a category only reachable by
// typing would barely exist for the people this is built for. The Worker's
// extraction does not return a spend kind (adding one would mean loosening
// the evidence-verification that stops the model inventing transactions), so
// this tags the one case that is genuinely unambiguous in Ghanaian English:
// money taken out for the house. "Chop money" is the everyday term for exactly
// that. Narrow on purpose - "bought food" is NOT in this list, because food
// bought to resell and food taken home are different things and guessing
// between them would put a number in the wrong place.
const TOOK_HOME_PHRASES = ['chop money', 'took home', 'take home', 'taken home', 'for the house', 'my pocket', 'for myself', 'housekeeping', 'para la casa', 'para mi casa', 'para la comida de la casa', 'para mis gastos', 'para mí', 'me llevé', 'saqué para'];
const STOCK_PHRASES = ['stock', 'restock', 'goods to sell', 'for sale', 'mercanc\u00eda', 'para vender', 'surtido'];
function spendKindFromText(text) {
  const t = String(text || '').toLowerCase();
  if (TOOK_HOME_PHRASES.some(p => t.indexOf(p) !== -1)) return 'home';
  // The worker tags goods bought to sell with note 'stock' (w86); a spoken
  // 'stock' or 'mercanc\u00eda' does the same. Stock never counts as a day's cost.
  return STOCK_PHRASES.some(p => new RegExp('(^|[^a-z])' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z]|$)').test(t)) ? 'stock' : '';
}

function eventToEntry(ev) {
  const type = ev.type;
  const item = ev.item || ev.customer || ev.supplier || '';
  const qty = type === 'sale' ? (ev.qty || 1) : '';
  const price = ev.price || '';
  const amount = type === 'sale' ? (Number(qty) || 0) * (Number(price) || 0) : (Number(price) || 0);
  const entry = { type, item, note: ev.note || '', qty, price, amount };
  if (ES) entry.cur = ev.currency === 'VES' ? 'VES' : (ev.currency === 'COP' ? 'COP' : HOME_CUR);
  if (type === 'expense') {
    const kind = spendKindFromText(item + ' ' + (ev.note || ''));
    if (kind) entry.kind = kind;
  }
  return entry;
}

function voiceEventComplete(ev) {
  if (!ev.item) return false;
  if (!ev.price || Number(ev.price) <= 0) return false;
  if (ev.type === 'sale' && (!ev.qty || Number(ev.qty) <= 0)) return false;
  return true;
}

// Real bug, found 29 Aug from a live screenshot: a garbled transcript ("5 x
// Hello, today t-shirts cds jeans cds soap cds shoe think cds. Thank you.")
// got auto-saved as a real 1,000 cedis sale. The extraction was technically
// "correct" - the item text really was a substring of what was heard - but a
// long, run-on, multi-item-sounding string is itself the tell that the
// transcript was garbage, not a real item name. This does NOT block the
// entry (that would bring back the "stuck, can't save" problem); it only
// takes away the free pass to auto-save, so a merchant still has to look at
// it once before it counts as money - the same bar a genuinely incomplete
// entry already has to clear.
function looksGarbled(item) {
  if (!item) return false;
  if (item.length > 40) return true;
  if (item.trim().split(/\s+/).length > 6) return true;
  return false;
}

let pendingVoiceEvents = [];
// Where the cards currently in the review came from - 'voice' (the mic) or
// 'photo' (a snapped receipt/notebook page). Stored on each saved entry as
// its source, the pilot's own success metric ("voice vs typing vs tap" -
// and now vs photo). Also decides the review's heading and what is spoken.
let pendingVoiceSource = 'voice';

// Provenance signal Gemini/ChatGPT both asked for, after the live finding that the
// extraction model can invent a plausible-looking number for one that was never
// spoken: a field the model actually returned a value for is marked "AI heard
// this - check it", visually distinct from a field the model left out, marked
// "Didn't catch this - tap to enter" in amber. Both still require the owner's own
// eyes and a tap before Save works - the label only tells them WHERE to look
// first, it never changes what's allowed to save silently.
function fieldMarkup(value, idx, key, type, extraAttrs) {
  const has = value !== undefined && value !== '' && value !== null;
  const cls = has ? 'ai-detected' : 'needs-input';
  const caption = has
    ? (pendingVoiceSource === 'photo' ? t('Read from your photo - check it', 'Esto le\u00ed en tu foto. Rev\u00edsalo.') : t('I heard this - check it', 'Esto fue lo que escuch\u00e9. Rev\u00edsalo.'))
    : t("Didn't catch this - tap to enter", 'Esto no lo entend\u00ed: toca para escribirlo');
  return `<div class="field ${cls}">
      <input type="${type}" ${extraAttrs || ''} data-idx="${idx}" data-key="${key}" value="${has ? String(value).replace(/"/g, '&quot;') : ''}" placeholder="${has ? '' : t('tap to enter', 'toca para escribir')}" data-clarity-mask="True">
      <div class="field-caption">${caption}</div>
    </div>`;
}

// Real feedback: a silent card appearing after you finish speaking, asking
// for a SEPARATE "Save" tap, doesn't read as an obvious next step to someone
// who can't read the card - it reads as nothing happening, or as confusion
// about what's being asked of them. The review step itself can't be removed
// safely (the AI extracting these events has, live, invented entire
// transactions that were never spoken - see extractEvents() - so it must
// stay human-verified before it saves). What this does instead: say out
// loud what was heard and the one thing to do next, the same way speakToday
// already does for the daily summary, so the confirmation is heard, not
// only read.
// Real feedback, 28 Aug: after speaking, asking for a SEPARATE "Save" tap
// is backwards for someone who can't read the card - it reads as a second,
// unexplained chore, not an obvious next step. Fixed by flipping the
// default: anything the AI heard clearly (an item AND a number) is saved
// the instant it's heard - no tap needed - and what's spoken back says so
// plainly. A big, simple "Undo" stays on every card in case it's wrong,
// so the safety net is still there, it's just after the fact instead of
// before. Only a genuinely incomplete entry (heard an item, never caught
// a number) still asks for a tap - because there is nothing yet TO save.
// Independent v61 review (5 Sep) reproduced three cases where the phone
// told her the wrong thing: "saved" when nothing was saved, and "not the
// price" when what was actually missing was the quantity or the item. For
// someone who cannot read the card, the spoken line IS the feedback, so it
// has to name the real gap. One function decides what is missing; status
// and speech both use it.
function voiceMissing(ev) {
  if (!ev.item || looksGarbled(ev.item)) return 'item';
  if (!ev.price || Number(ev.price) <= 0) return 'price';
  if (ev.type === 'sale' && (!ev.qty || Number(ev.qty) <= 0)) return 'qty';
  return null;
}
function voiceOutcomeStatus(heard, events) {
  const saved = events.filter(ev => ev._savedId).length;
  const pending = events.length - saved;
  const tail = saved && pending ? t(`saved ${saved}, please check the rest below.`, `guard\u00e9 ${saved}, revisa el resto abajo.`)
    : saved ? t('saved, check it below.', 'guardado, rev\u00edsalo abajo.')
    : t('not saved yet - please finish it below.', 'no se guard\u00f3 todav\u00eda. Term\u00ednalo abajo.');
  return t(`Heard: \u201c${heard}\u201d \u2014 ${tail}`, `Escuch\u00e9: \u201c${heard}\u201d \u2014 ${tail}`);
}

function speakVoiceReview(events) {
  const lines = [];
  events.forEach(ev => {
    const entry = eventToEntry(ev);
    const missing = voiceMissing(ev);
    // "Saved" is only ever spoken for an entry that really has a saved id.
    // A complete entry with no id means the save itself failed - say so,
    // never announce a save that did not happen.
    if (ev._savedId) {
      if (entry.type === 'debt_in') lines.push(t(`Saved. ${entry.item} owes you ${fmtSay(entry.amount, entry.cur)}.`, `Guardado. ${entry.item} te debe ${fmtSay(entry.amount, entry.cur)}.`));
      else if (entry.type === 'debt_out') lines.push(t(`Saved. You owe ${entry.item} ${fmtSay(entry.amount, entry.cur)}.`, `Guardado. Le debes ${fmtSay(entry.amount, entry.cur)} a ${entry.item}.`));
      else if (entry.type === 'expense') lines.push(t(`Saved: ${fmtSay(entry.amount, entry.cur)} spent on ${entry.item}.`, `Guardado: ${fmtSay(entry.amount, entry.cur)} en ${entry.item}.`));
      else lines.push(t(`Saved: ${entry.item}, ${fmtSay(entry.amount, entry.cur)}.`, `Guardado: ${entry.item}, ${fmtSay(entry.amount, entry.cur)}.`));
      return;
    }
    if (!missing) { lines.push(t(`I heard ${entry.item}, ${fmtSay(entry.amount, entry.cur)}, but could not save it - please tap Save below.`, `Escuch\u00e9 ${entry.item}, ${fmtSay(entry.amount, entry.cur)}, pero no pude guardarlo. Toca Guardar abajo.`)); return; }
    if (missing === 'item') lines.push(t('I heard an amount but not what it was for - please type that in below.', 'Escuch\u00e9 un monto pero no de qu\u00e9 era. Escr\u00edbelo abajo, por favor.'));
    else if (missing === 'qty') lines.push(t(`I heard ${entry.item} but not how many - please type it in below.`, `Escuch\u00e9 ${entry.item} pero no cu\u00e1ntos. Escr\u00edbelo abajo, por favor.`));
    else lines.push(t(`I heard ${entry.item} but not the price - please tap it in below.`, `Escuch\u00e9 ${entry.item} pero no el precio. Escr\u00edbelo abajo, por favor.`));
  });
  const saved = events.filter(ev => ev._savedId);
  const prefix = voiceSpeechPrefix; voiceSpeechPrefix = '';
  if (!lines.length) { if (prefix) say(prefix); return; }
  let closer = saved.length
    ? t('If any of this is wrong, tap Undo under it.', 'Si algo est\u00e1 mal, toca Deshacer debajo.')
    : '';
  // The "aha" hypothesis (16 Sep): the moment that matters is not recording,
  // it is asking and being answered. Spoken once, after the very first saved
  // voice entry on this phone, then never again. Whether anyone then asks is
  // counted (ping 'ask'), so the hypothesis is measured, not assumed.
  try {
    if (saved.length && nudgeCohort() === 1 && !localStorage.getItem('kym_ask_nudged')) {
      closer += t(' You can also ask me: how much did I sell today? Or: who owes me?', ' Tambi\u00e9n puedes preguntarme: \u00bfcu\u00e1nto vend\u00ed hoy? O: \u00bfqui\u00e9n me debe?');
      localStorage.setItem('kym_ask_nudged', '1');
    }
  } catch (e) { /* optional */ }
  say(`${prefix} ${lines.join(' ')} ${closer}`.trim());
}

// Spoken version of the photo review. Unlike speakVoiceReview above this
// never says "Saved" - nothing from a photo is saved until the owner taps
// Save on the card (see handleSnap for why), so the one thing to say is
// how many entries were found and what to do next.
function speakPhotoReview(events) {
  if (!('speechSynthesis' in window)) return;
  const n = events.length;
  const text = n === 1
    ? 'I read one entry from your photo. Please check it, then tap Save.'
    : `I read ${n} entries from your photo. Please check each one, then tap Save.`;
  const utter = speakClearly(new SpeechSynthesisUtterance(text));
  utter.rate = 0.8;
  speechSynthesis.cancel();
  speechSynthesis.speak(utter);
}

// Real bug, found 29 Aug from real user feedback: the auto-save behavior
// this file already describes in comments above ("anything the AI heard
// clearly is saved the instant it's heard - no tap needed") was never
// actually wired up anywhere - the only place that ever set _savedId was
// the manual "Save" button click handler below. Every complete voice entry
// still silently required a manual tap this whole time. This is the actual
// trigger: called once right after events are produced, before the first
// render, so a complete entry shows already in its saved state.
// Real bug, 17 Sep: "Kofi paid me 200" used to be saved as a NEW debt, so
// the home screen's "Owed to you" went up when a customer paid. The worker
// now sends {type:'payment', customer, price}; this applies it to that
// person's open debts (oldest first) and says what is still owed. With no
// open debt for that name the money is still real, so it is kept as money
// in, and the spoken line says exactly that.
function nameKey(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/^(do\u00f1a|dona|don|mr|mrs|madam|auntie|aunty|uncle|maame|sister|brother|bra|se\u00f1or|senor|se\u00f1ora|senora)\s+/, '').trim();
}
function sameName(a, b) {
  const x = nameKey(a), y = nameKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // "Ama" matches "Ama Serwaa" (a whole word of it), never "Amadu"
  const wx = x.split(/\s+/), wy = y.split(/\s+/);
  return wx[0].length >= 3 && wx[0] === wy[0];
}
// 22 Sep: generalized to accept the input method explicitly instead of
// always assuming voice (defaults to pendingVoiceSource so the existing
// voice call sites need no changes) - the manual "Someone paid you" tile
// below calls this same tested matching logic with 'manual'.
async function applyVoicePayment(p, source) {
  source = source || pendingVoiceSource;
  const amount = Number(p.price) || 0;
  const name = String(p.customer || '').trim();
  const placeholder = !name || /^(customer|cliente|somebody|someone|alguien|supplier|proveedor)$/i.test(name);
  const cur = ES ? (p.currency === 'VES' ? 'VES' : (p.currency === 'COP' ? 'COP' : HOME_CUR)) : undefined;
  const open = e => Math.max(0, (Number(e.amount) || 0) - (Number(e.paid) || 0));
  const entries = await getAllEntries();
  const matches = placeholder ? [] : entries.filter(e => e.type === 'debt_in' && open(e) > 0 && sameName(e.item, name)).sort((x, y) => x.ts - y.ts);
  const distinct = [...new Set(matches.map(m => nameKey(m.item)))];
  if (distinct.length > 1) {
    // two different people share the first name: never guess with money
    const names = [...new Set(matches.map(m => m.item))];
    return t(`${name} paid ${fmtSay(amount, cur)}. Which ${name}: ${names.join(' or ')}? Please tap that person below and use Paid small small.`, `${name} pag\u00f3 ${fmtSay(amount, cur)}. \u00bfCu\u00e1l ${name}: ${names.join(' o ')}? Toca a esa persona abajo y usa Abon\u00f3 una parte.`);
  }
  const spoken = matches.length ? matches[0].item : name;
  if (amount <= 0) return t(`I heard ${spoken || 'a payment'} but not the amount - please tap the debt below and enter it.`, `Escuch\u00e9 ${spoken || 'un pago'} pero no el monto. Toca la deuda abajo y an\u00f3talo.`);
  if (!matches.length) {
    const ts = Date.now();
    const item = placeholder ? t('payment received', 'pago recibido') : t(`payment from ${name}`, `pago de ${name}`);
    const record = { id: newId(), type: 'sale', item, note: '', qty: 1, price: amount, kind: '', paid: 0, amount, source, day: todayKey(ts), ts };
    if (cur) record.cur = cur;
    try { await addEntry(record); track('save_entry', { type: 'payment_as_sale', input_method: source }); ping('save'); } catch (err) { track('save_error', { where: 'voice_payment', reason: (err && err.name) || 'unknown' }); }
    return placeholder
      ? t(`Saved ${fmtSay(amount, cur)} as money in.`, `Guard\u00e9 ${fmtSay(amount, cur)} como dinero que entr\u00f3.`)
      : t(`${name} paid ${fmtSay(amount, cur)}. I had no debt for ${name}, so I saved it as money in.`, `${name} pag\u00f3 ${fmtSay(amount, cur)}. No ten\u00eda ninguna deuda de ${name}, as\u00ed que lo guard\u00e9 como dinero que entr\u00f3.`);
  }
  let left = amount;
  for (const m of matches) {
    if (left <= 0) break;
    const pay = Math.min(open(m), left);
    const payments = Array.isArray(m.payments) ? m.payments.slice() : [];
    payments.push({ amount: pay, ts: Date.now(), source });
    await updateEntry(m.id, { paid: (Number(m.paid) || 0) + pay, payments });
    left -= pay;
  }
  const stillOwed = matches.reduce((s, m) => s + open(m), 0) - (amount - left);
  track('debt_paid', { full: stillOwed <= 0, voice: source === 'voice' });
  ping('save');
  if (left > 0) {
    // paid more than was owed: the extra is money in, said out loud
    const ts = Date.now();
    const record = { id: newId(), type: 'sale', item: t(`extra from ${spoken}`, `extra de ${spoken}`), note: '', qty: 1, price: left, kind: '', paid: 0, amount: left, source, day: todayKey(ts), ts };
    if (cur) record.cur = cur;
    try { await addEntry(record); } catch (err) { /* the debt itself is already settled */ }
    return t(`${spoken} paid ${fmtSay(amount, cur)}. That clears the debt, with ${fmtSay(left, cur)} extra saved as money in.`, `${spoken} pag\u00f3 ${fmtSay(amount, cur)}. Con eso queda saldado, y ${fmtSay(left, cur)} de m\u00e1s lo guard\u00e9 como dinero que entr\u00f3.`);
  }
  if (stillOwed <= 0) return t(`${spoken} paid ${fmtSay(amount, cur)}. ${spoken} owes nothing now.`, `${spoken} pag\u00f3 ${fmtSay(amount, cur)}. Ya no debe nada.`);
  return t(`${spoken} paid ${fmtSay(amount, cur)}. ${spoken} still owes ${fmtSay(stillOwed, cur)}.`, `${spoken} pag\u00f3 ${fmtSay(amount, cur)}. Todav\u00eda debe ${fmtSay(stillOwed, cur)}.`);
}
let voiceSpeechPrefix = '';
let seeOpen = false;
let hasAnyRecord = false;
async function autoSaveReadyEvents(events) {
  const saved = [];
  for (const ev of events) {
    if (ev._savedId || !voiceEventComplete(ev) || looksGarbled(ev.item)) continue;
    const entry = eventToEntry(ev);
    const ts = Date.now();
    const id = newId();
    const record = { id, type: entry.type, item: entry.item, note: entry.note, qty: entry.qty, price: entry.price, kind: entry.kind || '', paid: 0, amount: entry.amount, source: pendingVoiceSource, day: todayKey(ts), ts };
    // Independent v63 review (5 Sep): a rejected save used to throw straight
    // out of this loop into the recording handler's catch, which reported it
    // as a transcription failure - text only, no speech, no review, and any
    // entries saved earlier in the same batch never shown. Each save now
    // succeeds or fails on its own; a failed one keeps its Save button so
    // a second tap retries only that entry.
    try {
      await addEntry(record);
    } catch (err) {
      ev._saveError = true;
      track('save_error', { where: 'voice_auto', reason: (err && err.name) || 'unknown' });
      continue;
    }
    ev._saveError = false;
    ev._savedId = id;
    saved.push(record);
    track('save_entry', { type: entry.type, input_method: pendingVoiceSource });
    ping('save');
  }
  // One prompt for the whole batch, never one per entry. A debt wins if the
  // batch contained one, since chasing the money beats counting entries.
  if (saved.length) await afterEntrySaved(saved.find(r => r.type === 'debt_in') || null);
}

function renderVoiceReview() {
  const list = document.getElementById('voiceReviewList');
  const wrap = document.getElementById('voiceReview');
  if (!pendingVoiceEvents.length) { wrap.classList.remove('open'); return; }
  wrap.classList.add('open');
  const title = document.getElementById('voiceReviewTitle');
  if (title) {
    // Say what actually happened. Complete entries are already saved the
    // moment they are heard (see autoSaveReadyEvents), so telling her to
    // "check, then Save" described a step that no longer exists - flagged
    // by the independent v60 review, 5 Sep.
    const anySaved = pendingVoiceEvents.some(ev => ev._savedId);
    const anyPending = pendingVoiceEvents.some(ev => !ev._savedId);
    const from = pendingVoiceSource === 'photo' ? 'From your photo' : 'What I heard';
    title.textContent = anySaved && !anyPending ? `${from} - saved. Tap Undo if one is wrong`
      : anySaved ? `${from} - saved. Please check the ones marked`
      : `${from} - please check, then tap Save`;
  }
  list.innerHTML = pendingVoiceEvents.map((ev, i) => {
    const nameLabel = ev.type === 'debt_in' ? 'Customer name' : ev.type === 'debt_out' ? 'Supplier name' : 'What';
    const priceLabel = ev.type === 'sale' ? 'Price each (cedis)' : 'Amount (cedis)';
    const ready = voiceEventComplete(ev) && !looksGarbled(ev.item);
    const statusCls = ev._savedId ? 'saved' : (ready ? 'ready' : 'pending');
    const statusText = ev._savedId ? '\u2713 Saved' : (ready ? 'Ready' : 'Please check this before saving');
    const btns = ev._savedId
      ? `<div class="voice-card-btns"><button class="btn btn-cancel voice-undo" data-idx="${i}">Undo save</button></div>`
      : `<div class="voice-card-btns">
          <button class="btn btn-cancel voice-discard" data-idx="${i}">Discard</button>
          <button class="btn btn-save voice-save" data-idx="${i}">Save</button>
        </div>`;
    return `
      <div class="voice-card">
        <div class="voice-card-type">
          <span>${TYPE_LABEL[ev.type] || ev.type}</span>
          <span class="voice-card-status ${statusCls}">${statusText}</span>
        </div>
        <label class="field-label">${nameLabel}</label>
        ${fieldMarkup(ev.item, i, 'item', 'text')}
        ${ev.type === 'sale' ? `<label class="field-label">How many?</label>${fieldMarkup(ev.qty, i, 'qty', 'number', 'inputmode="decimal"')}` : ''}
        <label class="field-label">${priceLabel}</label>
        ${fieldMarkup(ev.price, i, 'price', 'number', 'inputmode="decimal"')}
        ${btns}
      </div>`;
  }).join('');
  // Fields stay editable even after a card auto-saves - a saved-but-wrong
  // number is exactly the case this exists for. Editing a saved card writes
  // straight through to the already-saved record instead of silently doing
  // nothing, so "tap to fix it" actually fixes it.
  list.querySelectorAll('input').forEach(inp => inp.addEventListener('input', async (e) => {
    const { idx, key } = e.target.dataset;
    const ev = pendingVoiceEvents[idx];
    ev[key] = e.target.value;
    if (ev._savedId) {
      const entry = eventToEntry(ev);
      await updateEntry(ev._savedId, { item: entry.item, qty: entry.qty, price: entry.price, amount: entry.amount });
      await render();
    }
  }));
  list.querySelectorAll('.voice-discard').forEach(btn => btn.addEventListener('click', (e) => {
    const idx = Number(e.target.dataset.idx);
    const ev = pendingVoiceEvents[idx];
    if (ev && !ev._savedId) syncNotSaved(eventToEntry(ev));
    pendingVoiceEvents.splice(idx, 1);
    renderVoiceReview();
  }));
  list.querySelectorAll('.voice-undo').forEach(btn => btn.addEventListener('click', async (e) => {
    const idx = Number(e.target.dataset.idx);
    const ev = pendingVoiceEvents[idx];
    await deleteEntry(ev._savedId);
    track('undo_voice_save', { type: ev.type });
    pendingVoiceEvents.splice(idx, 1);
    renderVoiceReview();
    await render();
  }));
  list.querySelectorAll('.voice-save').forEach(btn => btn.addEventListener('click', async (e) => {
    const idx = Number(e.target.dataset.idx);
    const ev = pendingVoiceEvents[idx];
    if (!ev || ev._saving || ev._savedId) return;
    if (!voiceEventComplete(ev)) { alert('Please fill in the missing number first.'); return; }
    ev._saving = true;
    btn.disabled = true;
    try {
      const entry = eventToEntry(ev);
      const ts = Date.now();
      const id = newId();
      const record = { id, type: entry.type, item: entry.item, note: entry.note, qty: entry.qty, price: entry.price, kind: entry.kind || '', paid: 0, amount: entry.amount, source: pendingVoiceSource, day: todayKey(ts), ts };
      try {
        await addEntry(record);
      } catch (err) {
        track('save_error', { where: 'voice_manual', reason: (err && err.name) || 'unknown' });
        alert('Sorry, the phone could not save that. Please tap Save again.');
        return;
      }
      ev._savedId = id;
      try {
        track('save_entry', { type: entry.type, input_method: pendingVoiceSource });
        ping('save');
        renderVoiceReview();
        await render();
        await afterEntrySaved(record);
      } catch (err) {
        track('refresh_error', { where: 'voice_manual', reason: (err && err.name) || 'unknown' });
        alert('Saved. The screen could not update. Please refresh the page.');
      }
    } finally {
      ev._saving = false;
      btn.disabled = false;
    }
  }));
}

document.getElementById('voiceReviewCloseBtn').addEventListener('click', () => {
  pendingVoiceEvents = [];
  renderVoiceReview();
});

// The one and only voice entry point (the home screen's "Tap and speak"
// button - a second, in-sheet mic was removed after real feedback that two
// microphones on screen read as confusing, not as extra flexibility).
// extractEvents() classifies sale vs expense vs debt on its own from what
// was actually said, so this never needed activeType to work; activeType is
// only used below as a fallback for the rare case a sheet happens to be
// open (e.g. a merchant typing) and extraction finds nothing at all.
// Live proof-of-capture bars under the mic button, added after real
// testing feedback: without ANY visible reaction while speaking, a
// silent failure (bad permission, muted input, wrong device selected at
// the OS level) looks identical to the app just working normally - the
// only signal was a status line appearing after the fact, which requires
// reading. Five bars driven by actual mic input level via Web Audio's
// AnalyserNode - if you speak and they don't move, the problem is
// provably before this app (OS mic permission/mute), not in it.
let micLevelCtx = null;
let micLevelRaf = null;
// Loudness bookkeeping for the recorder (17 Sep): peak level of the take,
// when speech first crossed the threshold, and the last loud moment - used
// to stop automatically after the person goes quiet, and to refuse to
// upload a take that never had any voice in it.
const MIC_LOUD = 22;
let micPeak = 0, micSpeechAt = 0, micLastLoudAt = 0, micMeterLive = false;
// Real bug, 18 Sep (the owner: "nothing records on any device"): this meter
// made its own AudioContext AFTER the microphone permission step, which is
// outside the tap - iPhones and many Android phones leave such a context
// suspended, so the meter read zero forever. The meter also decides when
// to stop and whether the take was silent, so every take ran to the 12 s
// limit and was then refused as "I could not hear you". Now the meter uses
// the one context every tap already unlocks (ttsCtx), and only counts as
// live while that context is actually running; a dead meter never refuses
// a take and never blocks the stop.
let micLevelSource = null, micLevelOwnCtx = false;
// The phone's own speech recogniser (18 Sep). Free, no daily cap, and on
// Android it is the same Google ear the person already uses in WhatsApp.
// It cannot share the microphone with the recorder (Chrome hands the mic to
// whichever started last), so it listens ALONE; if it comes back with
// nothing, the app says "Say it again" and records for the server. A phone
// that fails twice in a row is remembered and goes straight to the server
// for a week.
let bstt = null;
function browserSttSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition) && !inAppBrowser();
}
function phoneSttPreferred() {
  if (!browserSttSupported()) return false;
  try {
    const until = Number(localStorage.getItem('kym_stt_server_until') || 0); if (until > Date.now()) return false;
    // Only after the server said "quota gone" today (18 Sep: Whisper with the
    // Ghanaian word list hears waakye, kenkey, trotro; Google's ear does not).
    const phoneUntil = Number(localStorage.getItem('kym_stt_phone_until') || 0);
    return phoneUntil > Date.now();
  } catch (e) { return false; }
}
function usePhoneEarUntilMidnight() {
  try {
    const d = new Date(); d.setUTCHours(24, 0, 0, 0);
    localStorage.setItem('kym_stt_phone_until', String(d.getTime()));
  } catch (e) { /* optional */ }
}
function noteBrowserSttFailure() {
  try {
    const n = Number(localStorage.getItem('kym_stt_fails') || 0) + 1;
    localStorage.setItem('kym_stt_fails', String(n));
    if (n >= 2) { localStorage.setItem('kym_stt_server_until', String(Date.now() + 7 * 86400000)); localStorage.setItem('kym_stt_fails', '0'); track('stt_prefer_server'); }
  } catch (e) { /* optional */ }
}
async function recognizeWithPhone(btn, statusId, opts) {
  micArming = true; pendingHeard = null;
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const r = new Rec();
  r.lang = ES ? (CO ? 'es-CO' : 'es-VE') : 'en-GH';
  r.continuous = false; r.interimResults = true; r.maxAlternatives = 1;
  let text = '', errCode = '', heardAt = 0;
  const meter = document.getElementById('micLevelMeter');
  const bars = meter ? meter.querySelectorAll('span') : [];
  const pulse = () => bars.forEach((bar, i) => { bar.style.height = (8 + Math.round(Math.random() * 12) + (i % 3) * 2) + 'px'; });
  const done = new Promise(res => {
    r.onend = () => res();
    r.onerror = (e) => { errCode = (e && e.error) || 'error'; res(); };
  });
  r.onresult = (e) => {
    let final = '', interim = '';
    for (let i = 0; i < e.results.length; i++) { const s = e.results[i][0].transcript; if (e.results[i].isFinal) final += s + ' '; else interim += s + ' '; }
    text = (final || interim).trim(); heardAt = Date.now(); pulse();
  };
  const lbl = btn.querySelector('.home-mic-label');
  if (lbl) { if (!lbl.dataset.idle) lbl.dataset.idle = lbl.textContent; lbl.textContent = t('Speak now\u2026', 'Habla ahora\u2026'); }
  btn.classList.add('recording');
  setMicStatus(t('Speak now. It stops by itself when you finish.', 'Habla ahora. Cuando termines, se apaga solo.'), null, statusId);
  await Promise.race([((opts && opts.again) || askMode ? say(opts && opts.again ? t('Say it again.', 'Dilo otra vez.') : t('Ask me.', 'Preg\u00fantame.')) : sayVoice('talk', t('Speak now.', 'Habla ahora.'))), new Promise(res => setTimeout(res, 1800))]);
  askMode = false;
  stopSpeaking();
  try { if (navigator.vibrate) navigator.vibrate(40); } catch (e) { /* optional */ }
  try { r.start(); bstt = r; } catch (e) { errCode = 'start'; }
  ownerLog('phone-ear', `lang=${r.lang} started=${!errCode}`);
  micArming = false;
  track('mic_start', { via: 'browser' });
  const cap = setTimeout(() => { try { r.stop(); } catch (e) { /* already stopped */ } }, 12000);
  // interim words keep the bars moving; a pause after words ends the take
  const tick = setInterval(() => { if (heardAt && Date.now() - heardAt > 1800) { try { r.stop(); } catch (e) { /* fine */ } } }, 200);
  if (!errCode) await done;
  clearTimeout(cap); clearInterval(tick);
  bstt = null;
  btn.classList.remove('recording');
  if (lbl && lbl.dataset.idle) lbl.textContent = lbl.dataset.idle;
  bars.forEach(bar => bar.style.height = '6px');
  text = repairHeard(text.trim());
  if (text.length >= 2) {
    try { localStorage.setItem('kym_stt_fails', '0'); } catch (e) { /* optional */ }
    pendingVoiceSource = 'voice';
    setMicStatus(t('Listening to what you said\u2026', 'Escuchando lo que dijiste\u2026'), null, statusId);
    await processVoiceBlob(null, statusId, 0, 0, text);
    return;
  }
  if (sttCancelled) { sttCancelled = false; setMicStatus('', null, statusId); return; } // the person tapped to stop: not a failure, no second take
  track('stt_browser_empty', { code: errCode || 'no_words' });
  if (errCode === 'not-allowed') {
    micFail(t('This phone said no to the microphone. Please go to your phone\u2019s Settings, find your browser, and turn the microphone on. Or type it below.', `El celular no dio permiso al micr\u00f3fono. Ve a ${tc('Configuraci\u00f3n', 'Ajustes')}, busca tu navegador y prende el micr\u00f3fono. O escr\u00edbelo abajo.`), 'mic_denied', statusId);
    return;
  }
  if (errCode === 'service-not-allowed' || errCode === 'language-not-supported' || errCode === 'audio-capture') {
    // the phone's recogniser is off (Siri & Dictation off, or no such language): the recorder still works
    try { localStorage.setItem('kym_stt_server_until', String(Date.now() + 7 * 86400000)); } catch (e) { /* optional */ }
  } else noteBrowserSttFailure();
  // second ear, same tap: record the words for the server
  await toggleMic(btn, statusId, { recorder: true, again: true });
}
function startMicLevelMeter(stream) {
  micPeak = 0; micSpeechAt = 0; micLastLoudAt = 0; micMeterLive = false;
  const meter = document.getElementById('micLevelMeter');
  if (!meter || typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (ttsCtx && ttsCtx.state !== 'closed') { micLevelCtx = ttsCtx; micLevelOwnCtx = false; }
    else { micLevelCtx = new Ctx(); micLevelOwnCtx = true; }
    if (micLevelCtx.state === 'suspended') { try { micLevelCtx.resume(); } catch (e) { /* optional */ } }
    const source = micLevelCtx.createMediaStreamSource(stream);
    micLevelSource = source;
    const analyser = micLevelCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const bars = meter.querySelectorAll('span');
    const tick = () => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((s, v) => s + v, 0) / data.length;
      micMeterLive = micLevelCtx.state === 'running';
      if (avg > micPeak) micPeak = avg;
      if (avg >= MIC_LOUD) { micLastLoudAt = Date.now(); if (!micSpeechAt) micSpeechAt = micLastLoudAt; }
      bars.forEach((bar, i) => {
        const jitter = 0.7 + (i % 3) * 0.15;
        const h = Math.max(6, Math.min(22, avg * jitter * 0.7));
        bar.style.height = h + 'px';
      });
      micLevelRaf = requestAnimationFrame(tick);
    };
    tick();
  } catch (err) {
    micLevelCtx = null; // meter is purely cosmetic - never block recording if this fails
  }
}
function stopMicLevelMeter() {
  if (micLevelRaf) cancelAnimationFrame(micLevelRaf);
  micLevelRaf = null;
  try { if (micLevelSource) micLevelSource.disconnect(); } catch (e) { /* already gone */ }
  micLevelSource = null;
  if (micLevelCtx) { if (micLevelOwnCtx) micLevelCtx.close().catch(() => {}); micLevelCtx = null; }
  const meter = document.getElementById('micLevelMeter');
  if (meter) meter.querySelectorAll('span').forEach(bar => bar.style.height = '6px');
}

// One path for every clip, however it was captured: the page's own
// recorder, or (18 Sep) a voice note recorded by the phone's recorder app
// inside Facebook's browser, where the page cannot use the microphone.
let voiceBusy = false, sttSwitchedThisTake = false, sttCancelled = false;
async function processVoiceBlob(blob, statusId, recordedMs, bytes, heardText) {
  voiceBusy = true; voiceSpeechPrefix = '';
  try {
    await processVoiceBlobInner(blob, statusId, recordedMs, bytes, heardText);
  } finally { voiceBusy = false; }
}
async function processVoiceBlobInner(blob, statusId, recordedMs, bytes, heardText) {
  try {
        setMicStatus(t('Working out what happened\u2026', 'Anotando lo que dijiste\u2026'), null, statusId);
        let { text: heard, events: heardEvents, via, sl: serverLang } = await transcribeAndExtract(blob, heardText);
        let events = Array.isArray(heardEvents) ? heardEvents : [];
        if (!events.length && heard) heard = repairHeard(heard);
        ownerLog('result', `via=${via} heard=${JSON.stringify(heard).slice(0, 160)} events=${JSON.stringify(events).slice(0, 120)}`);
        // The phone heard words but the server found no record in them and
        // no number either (Twi, or a mangled take): one more try with the
        // audio itself, where Whisper knows the local words.
        if (via === 'browser' && !events.length && blob && blob.size && !/\d/.test(wordsToNumber(heard || ''))) {
          track('stt_browser_retry');
          try { const r2 = await transcribeAndExtract(blob); if (r2.text && r2.text.trim()) { heard = r2.text; events = r2.events; via = 'whisper'; serverLang = r2.sl || serverLang; } } catch (e) { /* keep the phone's words */ }
        }
        ping(via === 'browser' ? 'stt_browser' : 'stt_whisper');
        if (!heard.trim()) {
          track('mic_error', { reason: 'no_transcript', duration_ms: recordedMs });
          // Real advice, 30 Aug: researched (not guessed) - "please" is the
          // single most documented politeness marker in Ghanaian English,
          // used far more generously in requests than American/British
          // English. Added to every instruction that asks the owner to do
          // something, not to plain statements of fact.
          const msg = recordedMs < 1200
            ? t('Too quick \u2014 please tap, then say what happened.', 'Muy r\u00e1pido. Toca el bot\u00f3n y despu\u00e9s di qu\u00e9 pas\u00f3.')
            : t('I did not catch that \u2014 please hold the phone closer and say it again, or type it below.', 'No entend\u00ed. Acerca el celular y dilo otra vez, o escr\u00edbelo abajo.');
          micFail(msg, 'mic_silent', statusId);
          return;
        }
        if (looksLikeQuestion(heard) && await answerQuestion(heard)) return;
        const payments = events.filter(ev => ev && ev.type === 'payment');
        if (payments.length) {
          events = events.filter(ev => ev && ev.type !== 'payment');
          const said = [];
          for (const p of payments) { try { said.push(await applyVoicePayment(p)); } catch (err) { track('save_error', { where: 'voice_payment', reason: (err && err.name) || 'unknown' }); } }
          track('voice_payment', { count: payments.length });
          if (!events.length) {
            closeSheet();
            setMicStatus(t(`Heard: \u201c${heard}\u201d \u2014 ${said.join(' ')}`, `Escuch\u00e9: \u201c${heard}\u201d \u2014 ${said.join(' ')}`), 'heard', statusId);
            await render();
            say(said.join(' '));
            return;
          }
          voiceSpeechPrefix = said.join(' ');
        }
        // Which language was actually spoken (16 Sep). A guess from the
        // transcript's own words, counted as en/twi/pidgin - the words
        // themselves never leave the phone for this.
        // The server says when the words were Twi (its text is already English).
        const spokenLang = serverLang === 'twi' && !ES ? 'twi' : guessSpokenLang(heard);
        // Remembered so the Book's button questions can be heard in Twi.
        // Only the server's own signal (Khaya route or 3+ Twi words), never the
        // phone's word guess, which also matches English ("asked me to pay").
        if (serverLang === 'twi' && !ES) { try { localStorage.setItem('kym_twi', '1'); } catch (e) { /* optional */ } }
        track('voice_extracted', { event_count: events.length, lang: spokenLang });
        ping('voice_' + spokenLang);
        if (events.length >= 1) {
          pendingVoiceEvents = events;
          await autoSaveReadyEvents(pendingVoiceEvents);
          renderVoiceReview();
          closeSheet();
          setMicStatus(voiceOutcomeStatus(heard, pendingVoiceEvents), 'heard', statusId);
          document.getElementById('voiceReview').scrollIntoView({ behavior: 'smooth', block: 'start' });
          speakVoiceReview(pendingVoiceEvents);
          await render();
        } else if (activeType) {
          // Real bug, found 29 Aug from a real screenshot: a sheet left open
          // (e.g. "I owe supplier") plus an unrelated thing said into the mic
          // used to get silently crammed into that sheet's fields no matter
          // how little sense it made for that entry type, then just sat
          // there waiting for a manual Save tap someone could easily miss or
          // not understand. Routed through the exact same auto-save +
          // editable + Undo card as every other voice entry now, closing
          // the sheet instead of leaving a stale, wrongly-typed form open.
          const parsed = parseHeardText(activeType, heard);
          pendingVoiceEvents = [{ type: activeType, item: parsed.item, price: parsed.price, qty: parsed.qty, note: '' }];
          await autoSaveReadyEvents(pendingVoiceEvents);
          renderVoiceReview();
          closeSheet();
          setMicStatus(voiceOutcomeStatus(heard, pendingVoiceEvents), 'heard', statusId);
          document.getElementById('voiceReview').scrollIntoView({ behavior: 'smooth', block: 'start' });
          speakVoiceReview(pendingVoiceEvents);
          await render();
        } else {
          // Real bug, found 30 Aug from real UK-based Ghanaian tester feedback
          // ("when I say cedis it don't recognise"): the AI extraction step
          // can fail to find an event (a mis-heard currency word, a quota
          // hiccup, an odd phrasing) with NO fallback at all on the home mic
          // path - even though the exact same local number-parser one branch
          // up already solves this. It was only ever wired to the
          // activeType branch. Now tried here too before giving up, guessing
          // the entry type from the words actually heard.
          const guessedType = /\bowe(s)?\b/i.test(heard) && /\bi\s+owe\b/i.test(heard) ? 'debt_out'
            : /\bowe(s)?\b/i.test(heard) || /\b(dey owe|me debe|fiao|fiado|fi\u00e9|quedo debiendo|qued\u00f3 debiendo|go pay|will pay)\b/i.test(heard) ? 'debt_in'
            : /\b(spent|bought|paid for|pagu\u00e9|compr\u00e9|gast\u00e9|pague|compre|gaste)\b/i.test(heard) ? 'expense'
            : /\b(transport|trotro|tro tro|fare|fuel|petrol|diesel|rent|light bill|electricity|water bill|airtime|data|chop money|chop|food money|wages|salary|worker|kayayo|porter|loading|offloading|market toll|toll|tax|levy|ticket|repair|stock|goods|supplies|arriendo|alquiler|luz|agua|gasolina|transporte|pasaje|flete|sueldo|impuesto|mercanc\u00eda|mercancia|surtido)\b/i.test(heard) ? 'expense'
            : 'sale';
          const parsed = parseHeardText(guessedType, heard);
          if (parsed.price) {
            pendingVoiceEvents = [{ type: guessedType, item: parsed.item, price: parsed.price, qty: parsed.qty, note: '' }];
            await autoSaveReadyEvents(pendingVoiceEvents);
            renderVoiceReview();
            setMicStatus(voiceOutcomeStatus(heard, pendingVoiceEvents), 'heard', statusId);
            document.getElementById('voiceReview').scrollIntoView({ behavior: 'smooth', block: 'start' });
            speakVoiceReview(pendingVoiceEvents);
            await render();
          } else {
            // People say fragments ("Ama 120", "cinco camisas diez mil"), not
            // sentences (17 Sep). If a number was heard, keep the words, ask
            // one question out loud, and let one tap on the typed choices
            // finish it with the fields already filled in.
            if (/\d/.test(wordsToNumber(heard))) {
              pendingHeard = heard;
              track('clarify_ask');
              micFail(t(`I heard \u201c${heard}\u201d. Was that a sale, a cost, or someone who owes you? Please tap one below.`, `Escuch\u00e9 \u201c${heard}\u201d. \u00bfFue una venta, un gasto o alguien que te debe? Toca uno abajo.`), null, statusId);
            } else {
              micFail(t(`I heard \u201c${heard}\u201d but could not work out what happened. Please say it again with the amount in cedis, or type it below.`, `Escuch\u00e9 \u201c${heard}\u201d pero no entend\u00ed qu\u00e9 pas\u00f3. Dilo otra vez y di cu\u00e1nto fue, ${tc('en d\u00f3lares o en bol\u00edvares', 'en pesos')}, o escr\u00edbelo abajo.`), null, statusId);
            }
          }
        }
      } catch (err) {
        if (err.cls === 'mic_server' && err.quota && blob && blob.size && browserSttSupported() && !sttSwitchedThisTake) {
          // the server said its daily allowance is gone: the phone's own ear for the rest of the day, tried once now
          sttSwitchedThisTake = true;
          usePhoneEarUntilMidnight();
          track('stt_switch_phone', { http: err.http });
          const btn = document.getElementById('homeMicBtn');
          if (btn) { await recognizeWithPhone(btn, statusId, { again: true }); return; }
        }
        try { window.__lastVoiceError = String(err && (err.stack || err.message || err)).slice(0, 280); } catch (e) { /* optional */ }
        track('mic_error', { reason: err.cls || 'app_error', http: err.http || 0, ms: recordedMs, bytes });
        // F7: only our own error texts are spoken; anything else is an app fault, never read aloud
        micFail(err.cls ? (err.message || t('Could not hear that \u2014 please try again, or type it below.', 'No te escuch\u00e9 bien. Int\u00e9ntalo otra vez, o escr\u00edbelo abajo.')) : t('Something went wrong on the phone \u2014 please check the list below, or try again.', 'Algo fall\u00f3 en el celular. Revisa la lista abajo, o int\u00e9ntalo otra vez.'), err.cls || 'mic_server', statusId);
  }
}
let micArming = false;
let askMode = false;
async function toggleMic(btn, statusId, opts) {
  ownerLog('tap', `mic=${micSupported()} secure=${window.isSecureContext} iab=${inAppBrowser()} phoneEar=${phoneSttPreferred()} arming=${micArming} busy=${voiceBusy} rec=${mediaRecorder ? mediaRecorder.state : 'none'} opts=${JSON.stringify(opts || {})}`);
  if (micArming) { askMode = false; return; } // a second tap while "Speak now" is playing
  if (bstt) { sttCancelled = true; try { bstt.stop(); } catch (e) { /* fine */ } askMode = false; return; }
  if (voiceBusy) { askMode = false; speakShort(t('One moment.', 'Un momento.')); return; } // F4: a tap while the last take is still being worked out
  if (!(opts && opts.recorder)) { sttSwitchedThisTake = false; sttCancelled = false; }
  if (!(opts && opts.recorder) && phoneSttPreferred()) return recognizeWithPhone(btn, statusId, opts);
  if (!micSupported()) {
    if (inAppBrowser()) showOpenInChrome('failed');
    micFail(window.isSecureContext === false ? t('Please open https://countmy.app for voice to work.', 'Abre https://countmy.app para que funcione la voz.') : t('Voice isn\u2019t available on this phone/browser \u2014 please type instead.', 'La voz no est\u00e1 disponible en este tel\u00e9fono o navegador. Mejor escr\u00edbelo.'), 'mic_nomic', statusId);
    return;
  }
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    askMode = false;
    return;
  }
  micArming = true;
  pendingHeard = null;
  let stream = null;
  try {
    // Market noise (18 Sep): ask the phone for its own noise suppression,
    // echo cancellation and automatic gain; phones that lack them ignore it.
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true, channelCount: 1 } }); }
    catch (e) { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    if (inAppBrowser() && !window.KYM_IAB_MIC_OK) { window.KYM_IAB_MIC_OK = true; ping('iab_mic_ok'); }
    recordedChunks = [];
    startMicLevelMeter(stream);
    // Real bug, found by testing the live transcription endpoint directly
    // with real audio and confirming the server side works correctly: the
    // recorded blob was always hardcoded to 'audio/webm' regardless of what
    // the browser actually recorded. Chrome/Android really does produce
    // webm, but Safari/iOS never has - it records audio/mp4 - so every
    // recording from an iPhone was being mislabeled before it was ever sent
    // anywhere, independent of anything Whisper does. Ask the browser what
    // it actually supports and use that, both for the recorder itself and
    // for how the resulting blob is labeled.
    const mimeCandidates = ['audio/webm', 'audio/mp4', 'audio/ogg'];
    const supportedMime = mimeCandidates.find(m => window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(m));
    const recOpts = { audioBitsPerSecond: 64000 };
    if (supportedMime) recOpts.mimeType = supportedMime;
    try { mediaRecorder = new MediaRecorder(stream, recOpts); } catch (e) { mediaRecorder = supportedMime ? new MediaRecorder(stream, { mimeType: supportedMime }) : new MediaRecorder(stream); }
    const actualMime = mediaRecorder.mimeType || supportedMime || 'audio/webm';
    let recordingStartedAt = Date.now();
    mediaRecorder.onstart = () => {
      recordingStartedAt = Date.now();
      // The "Speak now" prompt moved the meter; only the person counts.
      micPeak = 0; micSpeechAt = 0; micLastLoudAt = 0;
      micArming = false;
    };
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    // Auto-stop (17 Sep): nobody reads "tap again when you're done", and a
    // recording that never ends is the exact "it can't hear me". Stop 1.8 s
    // after the person goes quiet (once they have spoken), or at 12 s flat.
    // Real bug, 18 Sep (the owner: "nothing records on any device"): this timer
    // used to be started HERE, before the "Speak now" prompt, so its first
    // tick saw a recorder that had not started yet and cancelled itself.
    // The recording then never ended on its own. It now starts right after
    // mediaRecorder.start() below.
    const MAX_MS = 12000, QUIET_MS = 1800;
    let autoStop = null;
    const armAutoStop = () => {
      autoStop = setInterval(() => {
        if (!mediaRecorder || mediaRecorder.state !== 'recording') { clearInterval(autoStop); return; }
        const t = Date.now();
        if (t - recordingStartedAt >= MAX_MS || (!micMeterLive && t - recordingStartedAt >= 7000) || (t - recordingStartedAt >= 3000 && micSpeechAt && micSpeechAt - recordingStartedAt >= 300 && t - micSpeechAt >= 700 && t - micLastLoudAt >= QUIET_MS)) {
          clearInterval(autoStop);
          try { mediaRecorder.stop(); } catch (e) { /* already stopped */ }
        }
      }, 150);
    };
    mediaRecorder.onstop = async () => {
      clearInterval(autoStop);
      const heardPeak = micPeak, meterWasLive = micMeterLive;
      stream.getTracks().forEach(t => t.stop());
      stopMicLevelMeter();
      const lbl = btn.querySelector('.home-mic-label'); if (lbl && lbl.dataset.idle) lbl.textContent = lbl.dataset.idle;
      btn.classList.remove('recording');
      pendingVoiceSource = 'voice';
      setMicStatus(t('Listening to what you said\u2026', 'Escuchando lo que dijiste\u2026'), null, statusId);
      // If nothing was actually captured (mic muted at the OS level, a
      // permission edge case, or the recording stopped instantly) the old
      // code sent an empty file to be transcribed and got back nothing,
      // with no way to tell that apart from "transcription heard silence."
      // This catches it before a network call and says exactly what
      // happened instead.
      if (!recordedChunks.length || recordedChunks.reduce((s, c) => s + c.size, 0) === 0) {
        track('mic_error', { reason: 'empty_recording' });
        if (inAppBrowser()) showOpenInChrome('failed');
        micFail(t('No sound was recorded \u2014 please check your phone isn\u2019t muted, then try again.', 'No se grab\u00f3 ning\u00fan sonido. Revisa que el celular no est\u00e9 en silencio e int\u00e9ntalo otra vez.'), 'mic_empty', statusId);
        return;
      }
      // The meter never moved: the phone gave us a stream with no voice in it
      // (in-app browsers and muted mics do exactly this). Say so now instead
      // of uploading silence and waiting up to a minute for nothing.
      if (meterWasLive && heardPeak < 2) {
        track('mic_error', { reason: 'silent_take' });
        if (inAppBrowser()) showOpenInChrome('failed');
        micFail(t('I could not hear you. Please hold the phone close to your mouth and try again, or type it below.', 'No te escuch\u00e9. Acerca el celular a la boca e int\u00e9ntalo otra vez, o escr\u00edbelo abajo.'), 'mic_silent', statusId);
        return;
      }
      // Real reported symptom, 28 Aug: recordings that DO have bytes (so the
      // guard above doesn't fire) but transcribe to empty text every time,
      // consistently, across three different devices - the exact fingerprint
      // of tapping stop before actually finishing a full word, since a
      // fraction-of-a-second clip has audio energy but no complete speech for
      // Whisper to find. Give a targeted hint instead of the generic
      // "didn't catch that", which reads as a mysterious black box.
      const recordedMs = Date.now() - recordingStartedAt;
      ownerLog('stopped', `ms=${recordedMs} bytes=${recordedChunks.reduce((s, c) => s + c.size, 0)} peak=${Math.round(heardPeak)} meterLive=${meterWasLive}`);
      await processVoiceBlob(new Blob(recordedChunks, { type: actualMime }), statusId, recordedMs, recordedChunks.reduce((s, c) => s + c.size, 0));
    };
    // Say "Speak now" BEFORE the recorder starts (it would otherwise record
    // itself), then listen. The clip is prefetched, so this is ~0.7 s.
    btn.classList.add('recording');
    const lbl = btn.querySelector('.home-mic-label');
    if (lbl) { if (!lbl.dataset.idle) lbl.dataset.idle = lbl.textContent; lbl.textContent = t('Speak now\u2026', 'Habla ahora\u2026'); }
    setMicStatus(t('Speak now. It stops by itself when you finish.', 'Habla ahora. Cuando termines, se apaga solo.'), null, statusId);
    await Promise.race([((opts && opts.again) || askMode ? say(opts && opts.again ? t('Say it again.', 'Dilo otra vez.') : t('Ask me.', 'Preg\u00fantame.')) : sayVoice('talk', t('Speak now.', 'Habla ahora.'))), new Promise(r => setTimeout(r, 1800))]);
    askMode = false;
    stopSpeaking(); // never let the prompt run into the recording
    try { if (navigator.vibrate) navigator.vibrate(40); } catch (e) { /* optional */ }
    mediaRecorder.start();
    recordingStartedAt = Date.now();
    ownerLog('recording', `mime=${actualMime} meter=${micMeterLive} ctx=${micLevelCtx ? micLevelCtx.state : 'none'}`);
    armAutoStop();
    micArming = false;
    track('mic_start');
  } catch (err) {
    // Real Clarity finding, 28 Aug: a real user hit this and got stuck - the
    // old message ("check phone permission") assumes someone can read it AND
    // already knows what a browser permission is and how to change one,
    // neither of which holds for this audience. Split by the real cause and
    // say it out loud too, since a text-only fix instruction is useless to
    // someone who can't read it in the first place.
    const iab = inAppBrowser();
    const msg = iab
      ? (isAndroid() ? t('Facebook\u2019s browser cannot use the microphone. Please tap Open in Chrome, or type it below.', 'El navegador de Facebook no puede usar el micr\u00f3fono. Toca Abrir en Chrome, o escr\u00edbelo abajo.') : t('Facebook\u2019s browser cannot use the microphone. Please open this page in Safari, or type it below.', 'El navegador de Facebook no puede usar el micr\u00f3fono. Abre esta p\u00e1gina en Safari, o escr\u00edbelo abajo.'))
      : err.name === 'NotAllowedError'
      ? t('This phone said no to the microphone. Please go to your phone\u2019s Settings, find your browser, and turn the microphone on. Or type it below.', `El celular no dio permiso al micr\u00f3fono. Ve a ${tc('Configuraci\u00f3n', 'Ajustes')}, busca tu navegador y prende el micr\u00f3fono. O escr\u00edbelo abajo.`)
      : err.name === 'NotFoundError'
      ? t('This phone has no microphone available. Please type it below.', 'Este celular no tiene micr\u00f3fono disponible. Escr\u00edbelo abajo.')
      : t('Could not reach the microphone \u2014 please type it below.', 'No pude usar el micr\u00f3fono. Escr\u00edbelo abajo.');
    micArming = false; askMode = false;
    try { if (stream) stream.getTracks().forEach(tr => tr.stop()); } catch (e) { /* fine */ }
    stopMicLevelMeter();
    btn.classList.remove('recording');
    const lbl = btn.querySelector('.home-mic-label'); if (lbl && lbl.dataset.idle) lbl.textContent = lbl.dataset.idle;
    if (iab) showOpenInChrome('failed');
    micFail(msg, err.name === 'NotAllowedError' ? 'mic_denied' : err.name === 'NotFoundError' ? 'mic_nomic' : 'mic_busy', statusId);
    track('mic_error', { reason: err.name || 'getusermedia_failed', iab: iab ? 1 : 0 });
  }
}
// Tracks how each entry was actually created (voice vs manual) - added 27 Aug
// per the pilot's own success metric: "how many transactions were voice vs
// typing vs tap." Purely observational, never shown to the merchant, never
// affects save behavior - it only tags the stored record so real usage can be
// read back later. Reset every time a fresh sheet opens; set the moment voice
// actually filled it, so a merchant who then edits the fields by hand still
// correctly counts as a voice-assisted entry (the fields being editable is the
// whole safety design, not a reason to lose the provenance signal).
let sheetVoiceFilled = false;

// GA4 events, added 27 Aug for the Silent Alpha - deliberately structural only:
// which button, which type, which input method. NEVER an item name, price,
// customer name, or amount - the whole point of the pilot's own analytics is to
// watch usage patterns, not to duplicate the financial ledger inside Google's
// servers. Safe no-op if GA4 was never configured (see index.html).
// Meta Pixel custom events: a fixed whitelist, no parameters, so nothing
// about the business can leak by accident. Owner devices have no fbq.
const PIXEL_EVENTS = { tap: 'MicTap', save: 'RecordSaved', ask: 'Ask', shop_created: 'ShopCreated', install: 'Installed' };
function pixel(kind) {
  try {
    if (!window.fbq || !PIXEL_EVENTS[kind]) return;
    window.fbq('trackCustom', PIXEL_EVENTS[kind]);
    // A saved record is the conversion Meta optimises ads for. The standard
    // 'Lead' event is selectable in Ads Manager immediately, the custom one
    // only after Meta has indexed it - so both fire, still with no parameters.
    // 25 Sep (red-team of the ads): 'Lead' fired on EVERY save, so one regular
    // user counted as many "leads" and taught Meta to find repeat recorders,
    // not new people. It now fires once per phone - the first saved record.
    if (kind === 'save') {
      let first = true;
      try { first = localStorage.getItem('kym_lead_sent') !== '1'; if (first) localStorage.setItem('kym_lead_sent', '1'); } catch (e) { /* storage blocked: count it */ }
      if (first) window.fbq('track', 'Lead');
    }
  } catch (e) { /* never interrupt */ }
}
function track(event, params) {
  try {
    if (window.gtag) window.gtag('event', event, params || {});
  } catch (err) {
    // Analytics must never interrupt recording or saving a money entry.
  }
}

// Real gap found 28 Aug: tracking only ever fired once someone typed a Shop
// ID in Settings - a real tester (a parent, a pilot shop owner) who never
// touched that field was completely invisible to the owner dashboard, with
// no error and no way to tell usage was happening at all. Fixed by always
// having SOME id to ping with: a random id generated once per device and
// kept in localStorage if no Shop ID is set. It carries no more information
// than "device #N came back" - same one-way hash on the Worker side, same
// no-item/no-price/no-name payload as before, nothing new about who someone
// is. Setting a real Shop ID (e.g. "mum") still upgrades that from an
// anonymous device to one the owner can look up by name via /admin/shop.
function getDeviceId() {
  let id = localStorage.getItem('kym_device_id');
  if (!id) {
    id = 'anon-' + newId();
    localStorage.setItem('kym_device_id', id);
  }
  return id;
}

// Nudge cohort (16 Sep): half of devices hear "you can also ask me" after
// their first save, half never do. Decided once from the device id, so the
// dashboard can compare "asked a question" with and without the prompt -
// response to instruction versus organic discovery.
function nudgeCohort() {
  try {
    let c = localStorage.getItem('kym_nudge');
    if (c !== '0' && c !== '1') {
      const id = getDeviceId();
      let h = 0; for (let k = 0; k < id.length; k++) h = (h * 31 + id.charCodeAt(k)) >>> 0;
      c = String(h % 2); localStorage.setItem('kym_nudge', c);
    }
    return Number(c);
  } catch (e) { return 1; }
}
function isStandalone() {
  try { return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true; } catch (e) { return false; }
}
function isTestDevice() { try { return localStorage.getItem('kym_test') === '1' ? 1 : 0; } catch (e) { return 0; } }
function ping(eventType) {
  pixel(eventType);
  try {
    if (window.KYM_IS_OWNER_DEVICE) return; // see the ?owner=1 flag set in index.html
    const shop = getShopId() || getDeviceId();
    fetch(`${API_BASE}/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shop, event: eventType, programme: localStorage.getItem('kym_programme') || '', device: getDeviceId(), source: localStorage.getItem('kym_source') || '', test: isTestDevice(), nudge: nudgeCohort(), ver: window.KYM_VERSION || '', lang: (navigator.language || '').slice(0, 12), mobile: /Mobi|Android/i.test(navigator.userAgent) ? 1 : 0, standalone: isStandalone() ? 1 : 0 }),
      // Real bug, 23 Sep: a visitor who backgrounds or closes the page within
      // the first second or two (exactly what Facebook's in-app browser did
      // to a real Ghanaian visitor today - Clarity's own summary: "hid the
      // page within a second of arrival") can have this fetch cancelled by
      // the browser mid-flight without keepalive, before it ever reaches the
      // Worker. That visit becomes invisible to every tracking system at
      // once - not undercounted, erased - which is exactly the kind of gap
      // that made a real "I had 3 users" report look like only 1-2 happened.
      keepalive: true
    }).catch(() => {});
  } catch (err) {
    // Usage reporting must never interrupt a locally committed save.
  }
}

// Real gap, found 30 Aug from a live screenshot: a garbled voice entry sat
// in Recent as a wrong 1,000 cedis "sale" with no way for the owner to fix
// or remove it themselves - the only fix was messaging me. editingEntry
// reuses the same typed-entry sheet used for adding, prefilled with the
// tapped entry's own values, so correcting a mistake looks exactly like
// making one - no separate edit UI to learn.
let editingEntry = null;

function openSheet(type, entry) {
  track('open_sheet', { type, editing: !!entry });
  activeType = type;
  editingEntry = entry || null;
  sheetVoiceFilled = false;
  const cfg = FIELD_CONFIG[type];
  document.getElementById('sheetTitle').textContent = entry ? t('Edit entry', 'Editar registro') : cfg.title;
  const fieldsEl = document.getElementById('fields');
  fieldsEl.innerHTML = cfg.fields.map(f => {
    const current = entry ? entry[f.key] : undefined;
    if (f.type === 'choice') {
      const val = (current !== undefined && current !== '') ? current : f.default;
      return `
        <div class="field">
          <label>${f.label}</label>
          <input type="hidden" data-key="${f.key}" value="${val || ''}">
          <div class="choice-row">
            ${f.options.map(o => `<button type="button" class="choice-btn${o.value === val ? ' active' : ''}" data-value="${o.value}">${o.label}</button>`).join('')}
          </div>
        </div>
      `;
    }
    return `
    <div class="field">
      <label for="field-${f.key}">${f.label}</label>
      <input id="field-${f.key}" type="${f.type}" inputmode="${f.type === 'number' ? 'decimal' : 'text'}" data-key="${f.key}" autocomplete="off" data-clarity-mask="True" value="${current !== undefined && current !== null ? String(current).replace(/"/g, '&quot;') : ''}">
    </div>
  `;
  }).join('') + (entry && cfg.isDebt ? `
    <div class="field">
      <label for="field-paid">${t('Paid so far (cedis)', 'Pagado hasta ahora ($)')}</label>
      <input id="field-paid" type="number" inputmode="decimal" data-key="paid" autocomplete="off" data-clarity-mask="True" value="${entry.paid || 0}">
    </div>` : '');
  document.getElementById('deleteEntryBtn').hidden = !entry;
  fieldsEl.querySelectorAll('input').forEach(inp => inp.addEventListener('input', updateConfirm));
  // Choice fields render as two big tap targets rather than a dropdown or
  // radio buttons - consistent with every other either/or decision in this
  // app, and doesn't require reading/understanding an unfamiliar UI control.
  fieldsEl.querySelectorAll('.choice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.parentElement;
      const hiddenInput = row.previousElementSibling;
      row.querySelectorAll('.choice-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      hiddenInput.value = btn.dataset.value;
      hiddenInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
  document.getElementById('confirmLine').classList.remove('show');
  document.getElementById('saveBtn').disabled = true;
  document.getElementById('saveBtn').textContent = entry ? t('Save changes', 'Guardar cambios') : t('Save', 'Guardar');
  document.getElementById('sheet').classList.add('open');
  document.getElementById('sheet').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  fieldsEl.querySelector('input').focus();
  if (entry) updateConfirm();
}

function closeSheet() {
  document.getElementById('sheet').classList.remove('open');
  if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
  activeType = null;
  editingEntry = null;
}

function readValues() {
  const v = {};
  document.querySelectorAll('#fields input').forEach(inp => { v[inp.dataset.key] = inp.value; });
  return v;
}

// The Save button was tappable at all times, even with required fields empty
// - tapping it then did nothing at all: no message, no shake, nothing, because
// saveEntry() just silently returned. Watched real session recordings where
// this produced exactly the "dead click" pattern Clarity flagged: several taps
// on Save, no visible result, session abandoned with zero entries saved. The
// button itself now shows whether it's ready, the same moment the preview
// line appears - nothing to read, nothing to figure out.
function updateConfirm() {
  const cfg = FIELD_CONFIG[activeType];
  const v = readValues();
  // Real bug, found 22 Sep in a live session: each confirm() only checked
  // that item/price were non-empty strings, not that they added up to real
  // money. Typing "00" passes that check - the line showed, Save looked
  // ready - but saveEntry()'s own guard (`if (!amount ...) return`) treats
  // a computed amount of zero as nothing to save and does nothing, silently.
  // Ready now means the same thing in both places: a real, positive amount.
  const ready = cfg.compute(v) > 0;
  const line = ready ? cfg.confirm(v) : '';
  const el = document.getElementById('confirmLine');
  if (line) { el.textContent = line + ' \u2014 correct?'; el.classList.add('show'); }
  else { el.classList.remove('show'); }
  document.getElementById('saveBtn').disabled = !line;
}

let saving = false;

// Guards against the real failure mode a rapid double-tap or a frozen-feeling
// screen causes: the same sale logged twice. Button is disabled the instant
// it's tapped, not after the write finishes.
async function saveEntry() {
  if (saving) return;
  const cfg = FIELD_CONFIG[activeType];
  const v = readValues();
  const amount = cfg.compute(v);
  if (!amount || !v.item) return;
  saving = true;
  const saveBtn = document.getElementById('saveBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = t('Saving\u2026', 'Guardando\u2026');
  try {
    // No entry of type 'payment' is ever persisted directly - it always
    // means applying money against an existing debt (or, with no match,
    // logging it as money in), the exact same tested logic the voice
    // path already used. See applyVoicePayment.
    if (activeType === 'payment' && !editingEntry) {
      const msg = await applyVoicePayment({ customer: v.item, price: v.price }, 'manual');
      closeSheet();
      await render();
      const status = document.getElementById('homeMicStatus');
      if (status) { status.textContent = msg; status.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      say(msg);
      return;
    }
    let record = null;
    let duplicate = false;
    let edited = false;
    try {
      if (editingEntry) {
        const patch = {
          item: v.item,
          note: v.note || '',
          qty: v.qty || '',
          price: v.price || '',
          kind: v.kind || '',
          method: v.method || '',
          amount: amount
        };
        if (cfg.isDebt) patch.paid = Number(v.paid) || 0;
        await updateEntry(editingEntry.id, patch);
        edited = true;
      } else {
        const ts = Date.now();
        const id = newId();
        record = {
          id,
          type: activeType,
          item: v.item,
          note: v.note || '',
          qty: v.qty || '',
          price: v.price || '',
          kind: v.kind || '',
          method: v.method || '',
          paid: 0,
          amount: amount,
          source: sheetVoiceFilled ? 'voice' : 'manual',
          day: todayKey(ts),
          ts
        };
        await addEntry(record);
      }
    } catch (err) {
      if (err && err.name === 'ConstraintError') {
        duplicate = true;
      } else {
        track('save_error', { where: 'typed', reason: (err && err.name) || 'unknown' });
        alert('Sorry, the phone could not save that. Please tap Save again.');
        return;
      }
    }
    // Storage is complete. A failed refresh must not ask for another save.
    try {
      if (edited) track('edit_entry', { type: activeType });
      else if (!duplicate) {
        track('save_entry', { type: activeType, input_method: sheetVoiceFilled ? 'voice' : 'manual' });
        ping('save');
      }
      closeSheet();
      await render();
      if (record && !duplicate) await afterEntrySaved(record);
    } catch (err) {
      track('refresh_error', { where: 'typed', reason: (err && err.name) || 'unknown' });
      alert('Saved. The screen could not update. Please refresh the page.');
    }
  } finally {
    saving = false;
    saveBtn.disabled = false;
    saveBtn.textContent = t('Save', 'Guardar');
  }
}

// Plan state's only source of truth is countmy-api / KV \u2014 the owner, the CEO, flips a
// shop's status directly in the Cloudflare dashboard after seeing a MoMo payment
// (see worker/worker.js). There is deliberately no local self-report toggle any
// more \u2014 one existed briefly as an offline fallback but shipped as a tappable
// "I've paid" button reachable by any user, which let anyone unlock paid access
// for free with one tap. isPaid() below only ever reflects what the server last
// confirmed, cached so a paid shop doesn't flicker back to Free the moment it
// goes offline \u2014 it is never something the UI can set directly.
function getShopId() { return (localStorage.getItem('kym_shop_id') || '').trim(); }
function setShopId(id) { localStorage.setItem('kym_shop_id', (id || '').trim()); }
function isPaid() { return localStorage.getItem('kym_paid_backend') === '1'; }

// CountMy Plus, 21 Sep 2026: the ONLY thing ever limited for a free shop is
// how many Ask CountMy questions she gets per day - never her own recorded
// sales, expenses or debts, which stay fully visible forever either way.
// This is deliberate: a 7-day history lockout existed until 5 Sep 2026 and
// was removed after two independent evidence reviews plus a 3,000-firm Accra
// survey found that watching her own records vanish reads as the app taking
// her money book away, for an audience already primed to fear that being in
// a system costs you (see the comment above the history render). Re-limiting
// history would repeat that exact, already-evidenced mistake. Asking a
// question is a new, optional feature, not her book - a safe place to put a
// real free/paid difference.
const ASK_FREE_DAILY_LIMIT = 5;
function askQuestionsLeftToday() {
  if (isPaid()) return Infinity;
  const day = todayKey(Date.now());
  if (localStorage.getItem('kym_ask_day') !== day) return ASK_FREE_DAILY_LIMIT;
  return Math.max(0, ASK_FREE_DAILY_LIMIT - (parseInt(localStorage.getItem('kym_ask_n'), 10) || 0));
}
function recordAskUsed() {
  if (isPaid()) return;
  const day = todayKey(Date.now());
  if (localStorage.getItem('kym_ask_day') !== day) {
    localStorage.setItem('kym_ask_day', day);
    localStorage.setItem('kym_ask_n', '1');
  } else {
    localStorage.setItem('kym_ask_n', String((parseInt(localStorage.getItem('kym_ask_n'), 10) || 0) + 1));
  }
}

// Plus by Paystack (25 Sep). The public key only (safe in the page); the
// secret key lives in the Worker (PAYSTACK_SECRET_KEY) and verifies every
// payment with Paystack before anything is unlocked. Empty = not switched on,
// the manual MoMo instructions stay.
const PAYSTACK_PK = '';
const PLUS_PRICE_PESEWAS = 9900;
function paidKey() { return getShopId() || getDeviceId(); }
function loadPaystack() {
  return new Promise((resolve, reject) => {
    if (window.PaystackPop) { resolve(); return; }
    const sc = document.createElement('script'); sc.src = 'https://js.paystack.co/v1/inline.js';
    sc.onload = () => resolve(); sc.onerror = () => reject(new Error('paystack script'));
    document.head.appendChild(sc);
  });
}
async function payPlus() {
  const msg = document.getElementById('payMsg');
  const say2 = x => { if (msg) msg.textContent = x; };
  if (!PAYSTACK_PK) return;
  if (!navigator.onLine) { say2(t('You need data to pay. Try again when you are online.', '')); return; }
  try {
    say2(t('Opening the secure payment...', ''));
    await loadPaystack();
    const key = paidKey();
    const handler = window.PaystackPop.setup({
      key: PAYSTACK_PK,
      email: 'plus-' + (await sha256Short(key)) + '@pay.countmy.app',
      amount: PLUS_PRICE_PESEWAS,
      currency: 'GHS',
      channels: ['mobile_money', 'card'],
      metadata: { k: key, plan: 'plus_year' },
      callback: function (res) {
        say2(t('Checking your payment...', ''));
        fetch(API_BASE + '/pay/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reference: res.reference, k: key }) })
          .then(r => r.json()).then(j => {
            if (j && j.paid) { try { localStorage.setItem('kym_paid_backend', '1'); } catch (e) { /* optional */ } track('plus_paid'); ping('plus_paid'); say2(t('Thank you! Ask CountMy is now unlimited.', '')); speakShort(t('Thank you.', '')); render(); }
            else say2(t('We could not confirm the payment yet. If money left your MoMo, it will be checked again automatically.', ''));
          }).catch(() => say2(t('We could not confirm the payment yet. It will be checked again when you are online.', '')));
      },
      onClose: function () { track('plus_pay_closed'); say2(''); }
    });
    track('plus_pay_open'); ping('plus_pay_open');
    handler.openIframe();
  } catch (e) { say2(t('The payment page could not open. Please try again.', '')); track('plus_pay_error', { reason: (e && e.message) || 'unknown' }); }
}
async function sha256Short(x) {
  try { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(x))); return Array.from(new Uint8Array(b)).slice(0, 8).map(v => v.toString(16).padStart(2, '0')).join(''); } catch (e) { return 'user'; }
}
(function wirePay() {
  const btn = document.getElementById('payPlusBtn'); if (!btn) return;
  if (!PAYSTACK_PK || ES) { btn.hidden = true; return; }
  btn.hidden = false;
  const manual = document.querySelector('.plan-pay-box'); if (manual) manual.hidden = true;
  btn.addEventListener('click', payPlus);
})();

async function refreshPaidStatus() {
  const shop = PAYSTACK_PK ? paidKey() : getShopId();
  if (!shop || !navigator.onLine) return;
  try {
    const res = await fetch(`${API_BASE}/status?shop=${encodeURIComponent(shop)}`);
    if (!res.ok) return;
    const data = await res.json();
    localStorage.setItem('kym_paid_backend', data.paid ? '1' : '0');
    await render();
  } catch (err) { /* offline or unreachable \u2014 keep last-known-good, don't block */ }
}

function renderAdmin() {
  const paid = isPaid();
  // Real advice, 28 Aug, from real testing (the owner's mum and aunties found
  // "everything" confusing) plus two independent AI reviews plus real stats
  // (zero paid conversions ever from a prominent, full-width payment pitch):
  // a payment button on the main screen contradicts "always free" no matter
  // how it's worded, for this exact audience. Demoted to a small, low-key
  // link instead of a full-width button pitching payment - still reachable,
  // no longer competing with the free promise for attention.
  // Real bug, 22 Sep: this line was overwriting the CountMy Plus pill text
  // (v156) with the pre-Plus copy on every render, English-only regardless
  // of language. Fixed - and for ES, the pill is hidden rather than
  // translated: the payment behind it (MoMo to a Ghanaian number, priced in
  // cedis) does not work in Venezuela or Colombia, so showing it would
  // promise something broken. Show it again once a VE/CO payment path
  // exists.
  const planPillEl = document.getElementById('planPill');
  if (ES) { planPillEl.hidden = true; }
  else { planPillEl.hidden = false; planPillEl.textContent = paid ? 'Thank you for supporting CountMy' : 'Unlimited Ask CountMy (optional, 99 cedis a year)'; }
  const shopInput = document.getElementById('shopIdInput');
  if (shopInput && document.activeElement !== shopInput) shopInput.value = getShopId();
}

// Real design reference, 28 Aug: AxisTrade (a Ghana competitor the owner
// specifically pointed to) greets by name and time of day instead of a
// plain "TODAY" label. Falls back to just the greeting, no name, when no
// Shop ID is set yet - which is most people, so this must read naturally
// either way, not like something is missing.
function greeting() {
  const hour = new Date().getHours();
  const part = hour < 12 ? t('Good morning', 'Buenos d\u00edas') : hour < 17 ? t('Good afternoon', 'Buenas tardes') : t('Good evening', 'Buenas noches');
  const shop = getShopId();
  return shop ? `${part}, ${shop}` : part;
}

async function render() {
  const entries = await getAllEntries();
  if (BOOK_ON) { try { bookRender(entries); } catch (e) { track('book_error', { where: 'render', reason: (e && e.name) || 'unknown' }); } }
  const today = todayKey(Date.now());
  const todayAll = entries.filter(e => e.day === today);
  // Venezuela: dollars are the day's totals; bolívar entries get their own line.
  const todayEntries = ES ? todayAll.filter(e => e.cur !== 'VES') : todayAll;
  const bsToday = ES ? todayAll.filter(e => e.cur === 'VES') : [];
  renderAdmin();
  document.getElementById('todayGreeting').textContent = greeting();
  const hg = document.getElementById('homeGreeting'); if (hg) hg.textContent = greeting();
  const tsd = document.getElementById('tsDate'); if (tsd) tsd.textContent = new Date().toLocaleDateString(ES ? 'es-VE' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  // First screen for a first-timer is the name, the button and one line (15
  // Sep). A card of zeros and an empty 'Recent' answered a question she had
  // not asked yet; both appear the moment there is something to show.
  const firstUse = entries.length === 0;
  hasAnyRecord = !firstUse;
  document.querySelector('.today').hidden = firstUse || !seeOpen;
  document.querySelector('.hist-label').hidden = firstUse || !seeOpen;
  document.getElementById('history').hidden = firstUse || !seeOpen;
  // Same rule, two more places (15 Sep): the camera is a second way to do
  // the thing she has not yet done once, and "backed up / lost your phone"
  // is about records that do not exist yet. Nine lines on first use became
  // five: the name, the question, the button, one line of how, one of type.
  document.getElementById('snapBtn').hidden = firstUse;
  document.querySelector('.safety-block').hidden = firstUse;
  // 16 Sep: two more things she has not earned yet. The shop page is for
  // someone who already keeps records here, and the optional-support line
  // was the only mention of money on a first screen that says "free".
  // The button also breathes gently until the first entry - one moving
  // thing on the screen, so the eye lands on the only thing to do.
  document.getElementById('shopPageBtn').hidden = firstUse;
  document.getElementById('planPill').hidden = firstUse;
  // In the Book the four buttons are equals, so the mic does not breathe.
  document.getElementById('homeMicBtn').classList.toggle('first-use', firstUse && !BOOK_ON);
  // 18 Sep red team: a brand name is not an instruction. First-timers get
  // "Press and talk"; the two buttons that can do nothing yet are hidden;
  // the language promise moves under the mic where the decision is made.
  const micLbl = document.querySelector('#homeMicBtn .home-mic-label');
  if (micLbl && !document.getElementById('homeMicBtn').classList.contains('recording')) {
    const want = BOOK_ON ? ((BK_IAB_TALK && firstUse) ? t('Talk', 'Habla') : t('Talk', 'Habla')) : firstUse ? t('Press and talk', 'Toca y habla') : t('Tell CountMy', 'Cu\u00e9ntale a CountMy');
    micLbl.textContent = want; micLbl.dataset.idle = want;
  }
  const secondRow = document.querySelector('.second-row'); if (secondRow) secondRow.hidden = firstUse;
  const langLine = document.querySelector('.mic-lang-line'); if (langLine) langLine.hidden = firstUse;
  // First screen (v143): one button, one spoken example, three words of trust.
  // The proof line and the who-made-it line read well to a literate reviewer
  // and mean nothing to the person this is for; both stay off the screen.
  const person = document.getElementById('personLine'); if (person) person.hidden = true;
  if (firstUse) { const st = document.getElementById('homeMicStatus'); if (st && !st.textContent) st.textContent = t('Talk Twi, Pidgin or English.', 'Habla en espa\u00f1ol, como t\u00fa hablas.'); }
  // 24 Sep, reversing part of v143: at least eight people who arrived from
  // Facebook group posts asked "what is it, what do I do with it". v143
  // assumed the first-timer is someone handed the phone by family; the
  // stranger from a link is now the main arrival. So a first-timer sees
  // one headline naming the thing, then the button, then the example
  // AND what CountMy writes back - the result shown, not described.
  // Returning users keep their greeting and daily question unchanged.
  document.getElementById('whatIs').hidden = !firstUse;
  // The head script reads this before anything draws, so the page does not
  // jump when this block appears or goes (25 Sep: taps landed on moved buttons).
  try { if (firstUse) localStorage.removeItem('kym_has_records'); else localStorage.setItem('kym_has_records', '1'); } catch (e) { /* optional */ }
  document.documentElement.classList.toggle('has-records', !firstUse);
  if (hg) hg.hidden = firstUse;
  const askLine = document.querySelector('.ask-line'); if (askLine) askLine.hidden = firstUse;
  const strip = document.getElementById('todayStrip'); if (strip) strip.hidden = firstUse;
  const exChat = document.getElementById('exampleChat');
  if (exChat) {
    exChat.hidden = !firstUse;
    const exRes = document.getElementById('exampleResult');
    if (exRes && firstUse) exRes.textContent = !ES ? '3 waakye, 60 cedis' : tc('3 refrescos, $6', '5 camisas, $50.000');
  }
  document.getElementById('trustLine').hidden = !firstUse;
  { const how = document.getElementById('howItWorks'); if (how) how.hidden = !(firstUse && BOOK_ON && !ES); }
  if (typeof renderInstallBanner === 'function') renderInstallBanner();

  // Real advice, 28 Aug, sought independently from two AI reviews after
  // real Clarity data showed 97% of visits are new and returning usage is
  // still flat: the single highest-leverage thing to build isn't a new
  // feature, it's turning the Today card into a daily ritual someone comes
  // back to check - "did I do better than yesterday?" is the natural next
  // question after "what happened today", and it's exactly what AxisTrade's
  // own design shows ("+ GH240.00 vs last Tue"). Uses plain cedis
  // difference, not a percentage - this audience shouldn't need to do
  // percentage math to understand their own sales.
  const yesterdayKey = todayKey(Date.now() - 24 * 60 * 60 * 1000);
  const yesterdaySales = entries.filter(e => e.type === 'sale' && e.day === yesterdayKey && e.cur !== 'VES').reduce((s, e) => s + e.amount, 0);

  const sales = todayEntries.filter(e => e.type === 'sale').reduce((s, e) => s + e.amount, 0);
  // Real gap, closed 28 Aug: sales never distinguished cash from MoMo,
  // even though that's a basic fact about the sale to a Ghanaian trader,
  // not an accounting afterthought - flagged independently by both AI
  // reviews and visibly core to AxisTrade's own design. Missing/old
  // entries (voice-created, or saved before this existed) count as cash -
  // the exact same total as before, nothing silently changes.
  const cashSales = todayEntries.filter(e => e.type === 'sale' && e.method !== 'momo').reduce((s, e) => s + e.amount, 0);
  const momoSales = todayEntries.filter(e => e.type === 'sale' && e.method === 'momo').reduce((s, e) => s + e.amount, 0);
  // Split 28 Aug: buying stock to resell isn't a loss, but it used to be
  // lumped into the same "expenses" total that gets subtracted from sales -
  // a restock day could show as a huge loss that never actually happened.
  // Anything not explicitly tagged "stock" (including every entry saved
  // before this existed, and every voice-created entry) counts as a running
  // cost - the exact same math as before, nothing silently changes.
  const expenses = todayEntries.filter(e => e.type === 'expense' && e.kind !== 'stock' && e.kind !== 'home').reduce((s, e) => s + e.amount, 0);
  const stockBought = todayEntries.filter(e => e.type === 'expense' && e.kind === 'stock').reduce((s, e) => s + e.amount, 0);
  // Money the owner took out of the till for herself or the house. Not a
  // shop cost (so it never drags down Money left over, the same reason
  // stock does not), but genuinely gone from the till, so it comes off
  // Cash you have now below.
  const takenHome = todayEntries.filter(e => e.type === 'expense' && e.kind === 'home').reduce((s, e) => s + e.amount, 0);
  // Real bug, found 28 Aug: this used to read e.settled, a field nothing in
  // the app ever wrote - "Customers owe me" could only ever go UP, forever,
  // even after a real customer actually paid back what they owed. Debt
  // entries now carry a `paid` amount (cumulative, updated via
  // recordDebtPayment below); remaining = amount - paid is the real source
  // of truth everywhere a debt's outstanding balance is shown.
  const owedMe = entries.filter(e => e.type === 'debt_in' && e.cur !== 'VES').reduce((s, e) => s + Math.max(0, e.amount - (e.paid || 0)), 0);
  const balance = sales - expenses;
  // Real gap, found 1 Sep from a real accounting critique: "Money left over"
  // never subtracted stock purchases, so buying 2,000 cedis of stock on a
  // 500-cedis sales day still showed a positive number - true for "how did
  // the business do" (buying stock isn't a loss) but false for "how much
  // cash do I actually have right now" (that cash is genuinely gone today).
  // This is the second, honest answer to the second question - never shown
  // unless it actually differs from Money left over (stockBought > 0).
  const cashInHand = balance - stockBought - takenHome;

  document.getElementById('tSales').textContent = fmt(sales);
  // Home strip (v103): the three numbers an owner actually thinks about.
  const nIn = todayEntries.filter(e => e.type === 'sale').length, nOut = todayEntries.filter(e => e.type === 'expense').length;
  const owedPeople = entries.filter(e => e.type === 'debt_in' && (Number(e.amount) || 0) - (Number(e.paid) || 0) > 0).length;
  const setT = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const paysToday = entries.filter(e => e.type === 'debt_in' && (!ES || e.cur !== 'VES')).flatMap(e => Array.isArray(e.payments) ? e.payments : []).filter(p => todayKey(p.ts) === today);
  const repaidToday = paysToday.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  // "\u20b5117" - the sign on every price tag in Ghana; long numbers shrink instead of wrapping
  const fmtTile = n => ES ? fmt(n) : '\u20b5' + Math.round(Number(n) || 0).toLocaleString('en-GH');
  const setTile = (id, v) => { const el = document.getElementById(id); if (!el) return; el.textContent = v; el.classList.toggle('long', v.length > 6 && v.length <= 8); el.classList.toggle('xlong', v.length > 8); };
  setTile('tsIn', fmtTile(sales + repaidToday)); setTile('tsOut', fmtTile(expenses)); setTile('tsOwe', fmtTile(owedMe));
  const nInAll = nIn + paysToday.length;
  setT('tsInSub', nInAll ? t(`${nInAll} record${nInAll === 1 ? '' : 's'}`, `${nInAll} registro${nInAll === 1 ? '' : 's'}`) : t('nothing yet today', 'nada todav\u00eda hoy'));
  setT('tsOutSub', nOut ? t(`${nOut} record${nOut === 1 ? '' : 's'}`, `${nOut} gasto${nOut === 1 ? '' : 's'}`) : '');
  setT('tsOweSub', owedPeople ? t(`${owedPeople} ${owedPeople === 1 ? 'person' : 'people'}`, `${owedPeople} persona${owedPeople === 1 ? '' : 's'}`) : t('nobody', 'nadie'));
  const cashMomoEl = document.getElementById('tCashMomo');
  cashMomoEl.textContent = sales > 0 ? t(`Cash ${fmt(cashSales)} - MoMo ${fmt(momoSales)}`, `Efectivo ${fmt(cashSales)} - ${tc('Pago M\u00f3vil', 'Nequi / transferencia')} ${fmt(momoSales)}`) : '';
  if (bsToday.length) {
    const bsSum = ty => bsToday.filter(e => e.type === ty).reduce((s, e) => s + (Number(e.amount) || 0), 0);
    cashMomoEl.textContent = (cashMomoEl.textContent ? cashMomoEl.textContent + ' \u00b7 ' : '') + `En bol\u00edvares hoy: ventas ${fmt(bsSum('sale'), 'VES')}, gastos ${fmt(bsSum('expense'), 'VES')}, fiao ${fmt(bsSum('debt_in'), 'VES')}`;
  }
  document.getElementById('tExpenses').textContent = fmt(expenses);
  document.getElementById('tStock').textContent = fmt(stockBought);
  document.getElementById('tOwedMe').textContent = fmt(owedMe);
  // Real feedback, 29 Aug: hide these two rows until they have a real value
  // once - a "0 cedis" row for a feature nobody has used yet is clutter,
  // not information. Once shown, stays shown for that device even if the
  // number goes back to 0 later (e.g. a debt gets fully paid off) - it
  // never disappears the moment after someone actually used it.
  if (stockBought > 0) document.getElementById('tStockRow').style.display = '';
  if (owedMe > 0) document.getElementById('tOwedRow').style.display = '';
  document.getElementById('tHome').textContent = fmt(takenHome);
  if (takenHome > 0) document.getElementById('tHomeRow').style.display = '';
  const cashInHandEl = document.getElementById('tCashInHand');
  cashInHandEl.textContent = fmt(cashInHand);
  cashInHandEl.classList.toggle('pos', cashInHand >= 0);
  cashInHandEl.classList.toggle('neg', cashInHand < 0);
  // Shown once either thing that moves cash without being a cost has
  // happened - otherwise it would just repeat Money left over.
  if (stockBought > 0 || takenHome > 0) document.getElementById('tCashRow').style.display = '';
  const balanceEl = document.getElementById('tBalance');
  balanceEl.textContent = fmt(balance);
  balanceEl.classList.toggle('pos', balance >= 0);
  balanceEl.classList.toggle('neg', balance < 0);

  const vsYesterdayEl = document.getElementById('tVsYesterday');
  const salesDiff = sales - yesterdaySales;
  if (salesDiff > 0) {
    vsYesterdayEl.textContent = t(`Up ${fmt(salesDiff)} from yesterday`, `${fmt(salesDiff)} más que ayer`);
    vsYesterdayEl.className = 'today-vs pos';
  } else if (salesDiff < 0) {
    vsYesterdayEl.textContent = t(`Down ${fmt(-salesDiff)} from yesterday`, `${fmt(-salesDiff)} menos que ayer`);
    vsYesterdayEl.className = 'today-vs neg';
  } else {
    vsYesterdayEl.textContent = t('Same as yesterday', 'Igual que ayer');
    vsYesterdayEl.className = 'today-vs';
  }

  window._kymToday = { sales, expenses, stockBought, takenHome, owedMe, balance, cashInHand, salesDiff };

  const histEl = document.getElementById('history');
  if (!entries.length) {
    histEl.innerHTML = `<div class="empty">${t('Nothing recorded yet. Tap the orange button to add your first sale.', 'Todav\u00eda no hay nada anotado. Toca el bot\u00f3n naranja y anota tu primera venta.')}</div>`;
    return;
  }
  // The 7-day lockout is gone (5 Sep). Two independent evidence reviews and
  // a 3,000-firm Accra survey point the same way: for this audience, watching
  // her own records vanish after a week reads as the app taking her money
  // book away, and confirms the fear that being in a system costs you. Her
  // records are hers, all of them, always. The paid tier is now optional
  // support for keeping CountMy free, not a wall in front of her history.
  // Independent v60 review (5 Sep) caught what I missed: the 30-row cap
  // meant a debt at position 31 still counted in "Customers owe me" but had
  // no visible way to mark it paid. Two rules now: every debt with money
  // still outstanding is always on screen however old it is, and the rest
  // shows the newest 30 with a plain button to show everything.
  const isOpenDebt = e => FIELD_CONFIG[e.type].isDebt && (e.amount - (e.paid || 0)) > 0;
  const visible = showAllHistory ? entries : entries.filter((e, i) => i < 30 || isOpenDebt(e));
  const hiddenCount = entries.length - visible.length;
  histEl.innerHTML = visible.map(e => {
    const cfg = FIELD_CONFIG[e.type];
    const sign = cfg.amountSign > 0 ? '+' : '\u2212';
    const cls = cfg.amountSign > 0 ? 'pos' : 'neg';
    const when = new Date(e.ts).toLocaleString(ES ? 'es-VE' : 'en-GH', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    // Real gap, closed 28 Aug: there was no way to ever record a real
    // repayment against a debt - "Kofi paid GH50 today, Kofi still owes
    // GH70" (a concrete example both AI reviews independently gave) was
    // simply impossible before this. `remaining` is the real outstanding
    // balance; a debt with nothing left owed shows a plain "Paid in full"
    // tag instead of payment controls or a remind link.
    const remaining = cfg.isDebt ? Math.max(0, e.amount - (e.paid || 0)) : null;
    const isSettled = cfg.isDebt && remaining <= 0;
    const displayAmount = cfg.isDebt ? remaining : e.amount;
    const daysOwed = cfg.isDebt ? Math.floor((Date.now() - e.ts) / (24 * 60 * 60 * 1000)) : 0;
    const agingLine = cfg.isDebt && !isSettled && daysOwed >= 1
      ? `<small class="debt-aging">${t(`Owed for ${daysOwed} day${daysOwed === 1 ? '' : 's'}`, `Debe hace ${daysOwed} d\u00eda${daysOwed === 1 ? '' : 's'}`)}</small>` : '';
    const remind = e.type === 'debt_in' && !isSettled
      ? `<a class="remind-btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(reminderMessage(e.item, remaining, e.note, e.cur))}">${t('Remind on WhatsApp', 'Cobrar por WhatsApp')}</a>`
      : '';
    // "Small small" (bit by bit) is real, sourced, everyday Ghanaian
    // English used across all ages for gradual/partial payment - unlike
    // slang terms this app deliberately avoids elsewhere, this one is
    // genuinely universal register, not youth-coded, and it's an exact
    // match for what this specific control does.
    const paymentRow = cfg.isDebt && !isSettled ? `
      <div class="debt-pay-row">
        <button type="button" class="debt-full-btn" data-id="${e.id}">${t('Paid in full', 'Pag\u00f3 todo')}</button>
        <button type="button" class="debt-partial-toggle" data-id="${e.id}">${t('Paid small small', 'Abon\u00f3 una parte')}</button>
      </div>
      <div class="debt-pay-input-row" data-id="${e.id}" hidden>
        <input type="number" inputmode="decimal" class="debt-pay-input" data-id="${e.id}" placeholder="${t('Amount paid', '\u00bfCu\u00e1nto pag\u00f3?')}" data-clarity-mask="True">
        <button type="button" class="debt-pay-btn" data-id="${e.id}">${t('Save', 'Guardar')}</button>
      </div>` : '';
    const settledTag = cfg.isDebt && isSettled ? `<span class="debt-settled-tag">\u2713 ${t('Paid in full', 'Pag\u00f3 todo')}</span>` : '';
    return `<div class="hist-item${cfg.isDebt ? ' is-debt' : ''}" data-edit-id="${e.id}">
      <div class="desc" data-clarity-mask="True">${escapeHtml(cfg.desc(e))}${settledTag}<small>${when}</small>${agingLine}${remind}${paymentRow}</div>
      <div class="amt ${cls}" data-clarity-mask="True">${sign}${fmt(displayAmount, e.cur)}</div>
    </div>`;
  }).join('') + (hiddenCount > 0 ? `<button type="button" class="show-all-btn" id="showAllBtn">${t(`Show all ${entries.length} records`, `Ver todo (${entries.length})`)}</button>` : '');
}

// Real gap, closed 28 Aug: recording a repayment against a debt was simply
// impossible before this - "Customers owe me" only ever went up. Delegated
// on #history once (not per-render, since innerHTML is fully replaced on
// every render()) rather than rebinding listeners on every redraw.
let showAllHistory = false;
document.getElementById('history').addEventListener('click', async (e) => {
  if (e.target.closest('#showAllBtn')) { showAllHistory = true; render(); return; }
  const fullBtn = e.target.closest('.debt-full-btn');
  const payBtn = e.target.closest('.debt-pay-btn');
  const toggleBtn = e.target.closest('.debt-partial-toggle');
  const remindLink = e.target.closest('.remind-btn');
  const payInput = e.target.closest('.debt-pay-input');
  // Real gap, found 30 Aug: once an entry landed here there was no way for
  // the owner to fix a mistake (wrong amount, a garbled voice entry, an
  // accidental "Paid in full") without messaging me - tapping anywhere on
  // the row that isn't one of its own controls now reopens it in the same
  // typed-entry sheet used to create it, prefilled, with a Delete option.
  if (!fullBtn && !payBtn && !toggleBtn && !remindLink && !payInput) {
    const item = e.target.closest('.hist-item');
    if (item) {
      const entries = await getAllEntries();
      const entry = entries.find(x => x.id === item.dataset.editId);
      if (entry) openSheet(entry.type, entry);
    }
    return;
  }
  if (toggleBtn) {
    const row = document.querySelector(`.debt-pay-input-row[data-id="${toggleBtn.dataset.id}"]`);
    if (row) row.hidden = false;
    return;
  }
  if (fullBtn) {
    // Real bug, caught in testing 28 Aug: this used to set paid to the
    // *remaining* balance shown on the button, not the entry's full
    // original amount - after any prior partial payment, "Paid in full"
    // silently under-settled the debt instead of zeroing it out. paid is
    // cumulative-total-ever-paid, so it must be set from the entry's real
    // amount, always looked up fresh, never from a value baked into the
    // button at render time.
    const entries = await getAllEntries();
    const entry = entries.find(x => x.id === fullBtn.dataset.id);
    if (!entry) return;
    const remainingNow = Math.max(0, (Number(entry.amount) || 0) - (Number(entry.paid) || 0));
    await updateEntry(entry.id, { paid: entry.amount, payments: (Array.isArray(entry.payments) ? entry.payments : []).concat([{ amount: remainingNow, ts: Date.now(), source: 'tap' }]) });
    track('debt_paid', { full: true });
    await render();
  } else if (payBtn) {
    const input = document.querySelector(`.debt-pay-input[data-id="${payBtn.dataset.id}"]`);
    const amount = Number(input.value);
    if (!amount || amount <= 0) return;
    const entries = await getAllEntries();
    const entry = entries.find(x => x.id === payBtn.dataset.id);
    if (!entry) return;
    const newPaid = (entry.paid || 0) + amount;
    await updateEntry(entry.id, { paid: newPaid, payments: (Array.isArray(entry.payments) ? entry.payments : []).concat([{ amount, ts: Date.now(), source: 'tap' }]) });
    track('debt_paid', { full: newPaid >= entry.amount });
    await render();
  }
});

// Reads today's numbers aloud. Evidence for this over text-only: Viamo's Ghana voice
// campaign reached ~37,000 customers with weekly voice calls \u2014 those who engaged with
// 6+ of 10 calls saw mobile savings balances nearly double. Numbers, spoken, drive
// behaviour for people who don't reliably read English prose. English-only for now \u2014
// a Twi/Pidgin voice would need real translation + testing with real shop owners
// first, not an invented script.
function speakToday() {
  const T = window._kymToday || { sales: 0, expenses: 0, stockBought: 0, owedMe: 0, balance: 0, cashInHand: 0, salesDiff: 0 };
  // Matches the on-screen labels word for word \u2014 hearing something different from
  // what's on the screen is confusing, not helpful. Short, plain sentences, slow
  // pace \u2014 this is read aloud, not read silently.
  // Real bug, found 1 Sep from real feedback ("the voice changes between 0
  // sales and any sales, sounds weirder"): this line used to say "You sold
  // X more/less than yesterday" / "Same sales as yesterday" - three
  // different sentence shapes, and none of them matched the on-screen text
  // ("Up X from yesterday" / "Down X from yesterday" / "Same as
  // yesterday"), which is exactly the inconsistency the comment above
  // already warned against. Now genuinely the same three short phrases as
  // what's on screen, every time.
  const stockLine = T.stockBought > 0 ? t(`Stock bought: ${fmtSay(T.stockBought)}. `, `Mercanc\u00eda comprada: ${fmtSay(T.stockBought)}. `) : '';
  const homeLine = T.takenHome > 0 ? t(`Money you took home: ${fmtSay(T.takenHome)}. `, `Plata para la casa: ${fmtSay(T.takenHome)}. `) : '';
  const cashLine = (T.stockBought > 0 || T.takenHome > 0) ? t(`Cash you have now: ${fmtSay(T.cashInHand)}. `, `${tc('Efectivo que tienes ahora', 'Plata en caja')}: ${fmtSay(T.cashInHand)}. `) : '';
  const vsLine = T.salesDiff > 0 ? t(`Up ${fmtSay(T.salesDiff)} from yesterday. `, `${fmtSay(T.salesDiff)} m\u00e1s que ayer. `)
    : T.salesDiff < 0 ? t(`Down ${fmtSay(-T.salesDiff)} from yesterday. `, `${fmtSay(-T.salesDiff)} menos que ayer. `)
    : t('Same as yesterday. ', 'Igual que ayer. ');
  const text = t(`Today. Sales: ${fmtSay(T.sales)}. Expenses: ${fmtSay(T.expenses)}. `, `Hoy. Ventas: ${fmtSay(T.sales)}. Gastos: ${fmtSay(T.expenses)}. `) + stockLine + homeLine
    + t(`Customers owe you: ${fmtSay(T.owedMe)}. Money left over: ${fmtSay(T.balance)}. `, `Clientes te deben: ${fmtSay(T.owedMe)}. Lo que te queda: ${fmtSay(T.balance)}. `) + cashLine + vsLine;
  const btn = document.getElementById('hearBtn');
  say(text, { onstart: () => btn.classList.add('speaking'), onend: () => btn.classList.remove('speaking') });
}

// PIN/lock removed entirely (28 Aug) - it contradicted the app's own trust promise
// ("no PIN ever asked") and real users found it confusing rather than reassuring,
// with no offsetting benefit strong enough to justify the friction. Nothing reads
// getPin()/kym_pin any more; the value is simply never set again.

// Every exported book already lands in someone else's WhatsApp - a daughter,
// a husband, the customer who owes. That message is the only place CountMy is
// ever seen by someone who does not have it, and the research is blunt that
// nobody in this market finds an app by searching for one: there is not a
// single trader post about keeping records in Twi or Pidgin anywhere online,
// and Google's own Ghana speech app failed on awareness alone. So the export
// carries one plain line back. Deliberately not a slogan and not a pitch -
// what it is, that it costs nothing, and the address.
// Every link that leaves the app carries a campaign tag (12 Sep). Until now a
// visit from a forwarded WhatsApp message and a visit from a Facebook post
// were indistinguishable in GA4 - all 'direct' - so nothing about which
// channel works could be learned. The tag names the door someone came in by.
// The one acquisition channel any comparable app ever published a number for:
// OkCredit found 3 in 10 people who received a payment reminder were shop
// owners themselves, and got two organic sign-ups per paid one from that loop
// alone (Lightspeed, 2019). Every reminder a trader sends to a customer now
// carries the door in. Kept to one plain line under the real message.
function reminderHook() {
  return t(' - Sent with CountMy, the free money notebook for anyone in business: countmy.app/?utm_source=whatsapp&utm_medium=reminder&utm_campaign=debt',
    ' - Enviado con CountMy, el cuaderno de cuentas gratis para cualquier negocio: countmy.app/?lang=es&utm_source=whatsapp&utm_medium=reminder&utm_campaign=debt');
}
// 25 Sep: the reminder said "send by MoMo" but never WHERE, so the customer
// had to ask - friction exactly where traders lose money (26.9% of informal
// firms sell on credit, World Bank 2022; "how do I get my money from
// debtors" is a recurring public ask). Her own number, kept only on her phone,
// goes into the message she sends. CountMy never touches the money.
function getMomo() { try { return localStorage.getItem('kym_momo') || ''; } catch (e) { return ''; } }
function prettyMomo(d) { return d.length === 10 ? d.slice(0, 3) + ' ' + d.slice(3, 6) + ' ' + d.slice(6) : d; }
function cleanMomo(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 12 && d.indexOf('233') === 0) d = '0' + d.slice(3);
  return /^0[235]\d{8}$/.test(d) ? d : '';
}
function momoLine() {
  const m = getMomo(); if (!m) return 'Please send by MoMo when you can.';
  let who = ''; try { who = localStorage.getItem('kym_momo_name') || ''; } catch (e) { /* optional */ }
  return 'Please send by MoMo to ' + prettyMomo(m) + (who ? ' (' + who + ')' : '') + ' when you can.';
}
function reminderMessage(name, amount, note, cur) {
  return t(`Hello ${name}, your balance is ${fmt(amount, cur)}${note ? ' for ' + note : ''}. ${momoLine()} Thank you.${reminderHook()}`,
    tc(`Hola ${name}, me debes ${fmt(amount, cur)}${note ? ' por ' + note : ''}. Cuando puedas me lo mandas por Pago M\u00f3vil, por favor. \u00a1Gracias!${reminderHook()}`,
       `Hola ${name}, buen d\u00eda. Me debe ${fmt(amount, cur)}${note ? ' de ' + note : ''}. Cuando pueda me lo manda por Nequi o en efectivo, por favor. \u00a1Gracias!${reminderHook()}`));
}

function shareFooter(campaign) {
  if (campaign === 'backup') return t('\n\nTomorrow, press this - your book opens with it: ' + withBookKey('https://countmy.app/?r=wa') + '\nFree. Made in Ghana.', '\n\nMa\u00f1ana toca aqu\u00ed y se abre tu cuaderno: ' + withBookKey('https://countmy.app/?lang=es&r=wa'));
  return t('\n\nI keep my business money with CountMy. It is free: https://countmy.app/?utm_source=whatsapp&utm_medium=share&utm_campaign=' + campaign,
    '\n\nLlevo las cuentas de mi negocio con CountMy. Es gratis: https://countmy.app/?lang=es&utm_source=whatsapp&utm_medium=share&utm_campaign=' + campaign);
}

// Backup state, shown to the user 4 Sep. The single most repeated reason
// traders abandon this category is losing their records: Kippa died with two
// years of people's books inside it ("I have been totally blind about my
// business since Kippa shut down"), and OZE's own reviews complain of records
// clearing on login. CountMy already backs every entry up invisibly - but a
// backup nobody can see does nothing for the fear that stops people trusting
// the app in the first place. Written only when the server actually confirms
// a save, never optimistically.
function markBackedUp() {
  try { localStorage.setItem('kym_last_backup', String(Date.now())); } catch (e) {}
}

function backupStatusText() {
  let ts = 0;
  try { ts = Number(localStorage.getItem('kym_last_backup')) || 0; } catch (e) { return { backedUp: false, text: '' }; }
  if (!ts) return { backedUp: false, text: t('Not backed up yet', 'A\u00fan sin respaldo') };
  const day = todayKey(ts);
  if (day === todayKey(Date.now())) return { backedUp: true, text: t('Backed up today', 'Respaldado hoy') };
  if (day === todayKey(Date.now() - 24 * 60 * 60 * 1000)) return { backedUp: true, text: t('Backed up yesterday', 'Respaldado ayer') };
  // Real bug, 22 Sept: this always formatted the date in English ('en-GH')
  // regardless of language, and the caller told "backed up" from "not"
  // by checking whether the returned string started with the English word
  // "Backed" - which would have silently broken the moment this text was
  // ever translated. Returns a structured {backedUp, text} instead so the
  // display logic never has to parse language-specific English out of it.
  const d = new Date(ts).toLocaleDateString(ES ? 'es-VE' : 'en-GH', { day: 'numeric', month: 'short' });
  return { backedUp: true, text: t('Backed up ' + d, 'Respaldado el ' + d) };
}

function renderBackupStatus() {
  const el = document.getElementById('backupStatus');
  if (!el) return;
  const { backedUp, text } = backupStatusText();
  el.textContent = (backedUp ? '\u2713 ' : '') + text;
  el.classList.toggle('ok', backedUp);
}

// Item 1 of the queue, and the single strongest thing the outside evidence
// supports. 27% of Ghanaian informal firms sell on credit, and the apps that
// actually retained this exact kind of user elsewhere (OkCredit and Khatabook
// in India, TallyKhata in Bangladesh) all did it by turning the debt record
// into an ACTION - reminding the customer - not by being a better book. Until
// now the reminder was buried in the Recent list, only findable by scrolling
// back to the entry. This puts it in front of her the moment the debt is
// written down, which is exactly when she is still thinking about that person.
// Only ever one prompt on screen. Two stacked banners is precisely the "too
// much going on" this app keeps being told about, and it is easy to hit for
// real: record a debt in the evening and the end-of-day send banner is
// already sitting there.
function clearOtherPrompts(keepId) {
  ['eodBanner', 'eveningNudge', 'debtReminder', 'milestone'].forEach(id => {
    if (id === keepId) return;
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
}

let debtReminderTimer = null;
function showDebtReminder(entry) {
  const box = document.getElementById('debtReminder');
  if (!box || !entry || entry.type !== 'debt_in') return;
  clearOtherPrompts('debtReminder');
  const owed = Math.max(0, (Number(entry.amount) || 0) - (Number(entry.paid) || 0));
  const name = entry.item || t('Your customer', 'Tu cliente');
  document.getElementById('debtReminderText').textContent = t(`${name} owes you ${fmt(owed, entry.cur)}.`, `${name} te debe ${fmt(owed, entry.cur)}.`);
  const link = document.getElementById('debtReminderSend');
  link.href = 'https://wa.me/?text=' + encodeURIComponent(reminderMessage(name, owed, entry.note, entry.cur));
  // First time only: her MoMo number, so the reminder says where to pay.
  let row = document.getElementById('debtMomoRow');
  if (!ES && !getMomo()) {
    if (!row) {
      row = document.createElement('div'); row.id = 'debtMomoRow'; row.className = 'debt-momo';
      row.innerHTML = '<label for="debtMomoInput">' + t('Your MoMo number, so they know where to pay you:', '') + '</label><div class="debt-momo-in"><input id="debtMomoInput" type="tel" inputmode="numeric" autocomplete="tel" placeholder="024 123 4567" maxlength="16"><button type="button" id="debtMomoSave">' + t('Save', '') + '</button></div>';
      box.insertBefore(row, box.querySelector('.act-banner-actions'));
      row.querySelector('#debtMomoSave').addEventListener('click', () => {
        const d = cleanMomo(row.querySelector('#debtMomoInput').value);
        if (!d) { row.querySelector('#debtMomoInput').focus(); speakShort(t('Please check the number.', '')); return; }
        try { localStorage.setItem('kym_momo', d); } catch (e) { /* optional */ }
        track('momo_saved'); ping('momo_saved');
        row.remove();
        link.href = 'https://wa.me/?text=' + encodeURIComponent(reminderMessage(name, owed, entry.note, entry.cur));
        clearTimeout(debtReminderTimer); debtReminderTimer = setTimeout(() => { box.hidden = true; }, 25000);
      });
    }
    clearTimeout(debtReminderTimer);
  } else if (row) row.remove();
  link.textContent = t(`Remind ${name} on WhatsApp`, `Cobrarle a ${name} por WhatsApp`);
  box.hidden = false;
  // Spoken read-back stays: for someone who cannot read the card, hearing
  // the name and amount is the only check that the phone heard "Ama, 120"
  // and not "am aos, 20" (both seen live, 4 Sep). It is also the existing
  // market practice made digital - Kumasi research documents credit being
  // stated aloud in front of a witness so both sides remember it. What is
  // NOT spoken any more (5 Sep) is the question about reminding her: said
  // aloud with the customer standing there, it announces that the trader is
  // being prompted to chase her, and it verifies nothing. The button asks.
  speakShort(t(`${name} owes you ${fmtSay(owed, entry.cur)}.`, `${name} te debe ${fmtSay(owed, entry.cur)}.`));
  clearTimeout(debtReminderTimer);
  // Never permanent - it is a prompt about one debt, not a part of the page
  // (longer when it is waiting for her MoMo number).
  debtReminderTimer = setTimeout(() => { box.hidden = true; }, document.getElementById('debtMomoRow') ? 90000 : 25000);
}

// Item 2. The one retention lever with a real published number behind it:
// Khatabook's 3-month retention sat at 20-25%, and DOUBLED for users who
// logged 5 or more entries in their first month. Everything here exists to
// get a brand new shop to five - counted out loud, because most of the people
// this is for do not read the screen.
const FIRST_ENTRIES_TARGET = 5;
function showEntryMilestone(total) {
  const box = document.getElementById('milestone');
  if (!box) return;
  const left = FIRST_ENTRIES_TARGET - total;
  let msg;
  if (total >= FIRST_ENTRIES_TARGET) {
    msg = t(`That is ${total}. CountMy knows your business now - come back tomorrow and it will tell you if you did better.`, `Ya van ${total}. CountMy ya conoce tu negocio: vuelve ma\u00f1ana y te dir\u00e1 si te fue mejor.`);
  } else if (left === 1) {
    msg = t(`That is ${total}. One more and CountMy can tell you if today was better than yesterday.`, `Ya van ${total}. Con una m\u00e1s, CountMy te dir\u00e1 si hoy fue mejor que ayer.`);
  } else {
    msg = t(`That is ${total}. ${left} more and CountMy can tell you if today was better than yesterday.`, `Ya van ${total}. Con ${left} m\u00e1s, CountMy te dir\u00e1 si hoy fue mejor que ayer.`);
  }
  clearOtherPrompts('milestone');
  box.textContent = msg;
  box.hidden = false;
  speakShort(msg);
  clearTimeout(box._timer);
  box._timer = setTimeout(() => { box.hidden = true; }, 12000);
}

// Short spoken confirmations reuse the same voice pick and slow rate as the
// Today card, so the app never suddenly sounds like a different thing.
// ASK (15 Sep). The one layer CountMy did not have: she can already tell it
// what happened, now she can ask it what she knows. Answered aloud from the
// phone's own records, no server, no reading. A question is only treated as
// one when it carries no amount - "how much did I sell today" is a question,
// "I sold rice for 30 cedis" is an entry - so an entry is never swallowed.
// Real bug, 22 Sep: this had no Spanish branch at all, so every ES voice
// session (Venezuela/Colombia) silently logged as 'en' in the spoken-
// language analytics - not wrong on screen, only invisible in the stats,
// which is why Spanish usage never showed up as Spanish usage there.
function guessSpokenLang(text) {
  if (ES) return 'es';
  const t = ' ' + String(text || '').toLowerCase().replace(/[\u0254\u0186]/g, 'o').replace(/[\u025b\u0190]/g, 'e') + ' ';
  const twi = /\b(me|wo|ne|na)\s+(ton|to|tua|de|nya|gye)\b|\bde\s+me\s+ka\b|\b(baako|mmienu|mmiensa|enan|anum|nsia|nson|nwotwe|nkron|edu|aduonu|aduasa|aduanan|aduonum|oha|apem|sidi|sika|ntoma|nkate)\b/;
  const pidgin = /\b(dey|wey|abeg|sef|chop|wetin|make\s+i|e\s+be|na\s+so|dem)\b/;
  if (twi.test(t)) return 'twi';
  if (pidgin.test(t)) return 'pidgin';
  return 'en';
}
function looksLikeQuestion(text) {
  const q = text.toLowerCase();
  if (ES) {
    if (/\d/.test(q) || /d[o\u00f3]lar|bol[i\u00ed]var|bolos|\bbs\b/.test(q)) return false;
    return /qui[e\u00e9]n|cu[a\u00e1]nt[oa]s?|qu[e\u00e9]\b|dime|mu[e\u00e9]strame/.test(q) && /deb[eo]n?|fiao|fiado|vend[i\u00ed]|ventas?|gast[e\u00e9]|gastos?|gan[e\u00e9]|ganancia|queda|plata|efectivo|hoy|semana|ayer|deuda/.test(q);
  }
  if (/\d/.test(q) || /\bcedis?\b|\bghs\b|\bcds?\b/.test(q)) return false;
  return /\b(who|how much|how many|what|did i|do i|have i|show me|tell me)\b/.test(q) && /\b(owe|owes|owing|sold|sell|sales|spend|spent|expenses?|make|made|profit|left|balance|cash|today|week|yesterday|debt|debts)\b/.test(q);
}
async function answerQuestion(text) {
  if (ES) return answerQuestionEs(text);
  const t = text.toLowerCase();
  const entries = await getAllEntries();
  const today = todayKey(Date.now());
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const isDebt = e => FIELD_CONFIG[e.type] && FIELD_CONFIG[e.type].isDebt;
  const open = e => Math.max(0, (Number(e.amount) || 0) - (Number(e.paid) || 0));
  const sum = list => list.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const inWeek = e => e.ts >= weekAgo;
  const isToday = e => e.day === today;
  let intent, answer;
  if (/\b(who|what|how much|anyone|anybody)\b.*\b(owe|owes|owing)\b.*\b(me|us)\b|\bdebts?\b|\bwho owes\b/.test(t) && !/\bi owe\b/.test(t)) {
    intent = 'who_owes_me';
    const list = entries.filter(e => e.type === 'debt_in' && open(e) > 0);
    answer = list.length
      ? list.slice(0, 6).map(e => `${e.item} owes you ${fmt(open(e))}`).join('. ') + `. Total ${fmt(list.reduce((s, e) => s + open(e), 0))}.`
      : 'Nobody owes you anything right now.';
  } else if (/\b(what|who|how much)\b.*\b(do i|i)\s+owe\b/.test(t)) {
    intent = 'what_i_owe';
    const list = entries.filter(e => e.type === 'debt_out' && open(e) > 0);
    answer = list.length
      ? list.slice(0, 6).map(e => `You owe ${e.item} ${fmt(open(e))}`).join('. ') + `. Total ${fmt(list.reduce((s, e) => s + open(e), 0))}.`
      : 'You do not owe anyone right now.';
  } else if (/\b(spend|spent|expenses?)\b/.test(t)) {
    const week = /\bweek\b/.test(t);
    intent = week ? 'spent_week' : 'spent_today';
    const list = entries.filter(e => e.type === 'expense' && (week ? inWeek(e) : isToday(e)));
    answer = `You spent ${fmt(sum(list))} ${week ? 'this week' : 'today'}${list.length ? ', on ' + list.length + (list.length === 1 ? ' thing' : ' things') : ''}.`;
  } else if (/\b(make|made|profit|left|balance)\b/.test(t)) {
    intent = 'profit_today';
    const s = sum(entries.filter(e => e.type === 'sale' && isToday(e)));
    const x = sum(entries.filter(e => e.type === 'expense' && isToday(e) && e.kind !== 'stock' && e.kind !== 'home'));
    answer = `Today you sold ${fmt(s)} and spent ${fmt(x)}. Money left over: ${fmt(s - x)}.`;
  } else if (/\b(sold|sell|sales)\b/.test(t)) {
    const week = /\bweek\b/.test(t);
    intent = week ? 'sold_week' : 'sold_today';
    const list = entries.filter(e => e.type === 'sale' && (week ? inWeek(e) : isToday(e)));
    answer = `You sold ${fmt(sum(list))} ${week ? 'this week' : 'today'}${list.length ? ', ' + list.length + (list.length === 1 ? ' sale' : ' sales') : ''}.`;
  } else {
    return false;
  }
  if (askQuestionsLeftToday() <= 0) {
    track('voice_ask', { intent: 'limit_reached' });
    const limitMsg = `That's today's ${ASK_FREE_DAILY_LIMIT} free questions. Ask again tomorrow, or support CountMy to ask any time.`;
    setMicStatus(limitMsg, 'heard');
    speakShort(limitMsg);
    return true;
  }
  recordAskUsed();
  track('voice_ask', { intent });
  ping('ask');
  setMicStatus(answer, 'heard');
  speakShort(answer);
  return true;
}

// Spanish twin of answerQuestion: same intents, same data, dollars only
// (bolívar debts are shown on the card, not summed with dollars).
async function answerQuestionEs(text) {
  const q = text.toLowerCase();
  const entries = (await getAllEntries()).filter(e => e.cur !== 'VES');
  const today = todayKey(Date.now());
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const open = e => Math.max(0, (Number(e.amount) || 0) - (Number(e.paid) || 0));
  const sum = list => list.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const inWeek = e => e.ts >= weekAgo;
  const isToday = e => e.day === today;
  const week = /semana/.test(q);
  let intent, answer;
  if (/le\s+debo|debo\s+(a|al|yo)|qu[e\u00e9]\s+debo|cu[a\u00e1]nto\s+debo/.test(q)) {
    intent = 'what_i_owe';
    const list = entries.filter(e => e.type === 'debt_out' && open(e) > 0);
    answer = list.length
      ? list.slice(0, 6).map(e => `Le debes ${fmtSay(open(e))} a ${e.item}`).join('. ') + `. Total ${fmtSay(list.reduce((s, e) => s + open(e), 0))}.`
      : 'No le debes nada a nadie ahora mismo.';
  } else if (/deb[eo]n?|fiao|fiado|deuda/.test(q)) {
    intent = 'who_owes_me';
    const list = entries.filter(e => e.type === 'debt_in' && open(e) > 0);
    answer = list.length
      ? list.slice(0, 6).map(e => `${e.item} te debe ${fmtSay(open(e))}`).join('. ') + `. Total ${fmtSay(list.reduce((s, e) => s + open(e), 0))}.`
      : 'Nadie te debe nada ahora mismo.';
  } else if (/gast/.test(q)) {
    intent = week ? 'spent_week' : 'spent_today';
    const list = entries.filter(e => e.type === 'expense' && (week ? inWeek(e) : isToday(e)));
    answer = `Gastaste ${fmtSay(sum(list))} ${week ? 'esta semana' : 'hoy'}${list.length ? ', en ' + list.length + (list.length === 1 ? ' cosa' : ' cosas') : ''}.`;
  } else if (/gan|ganancia|queda|plata|efectivo/.test(q)) {
    intent = 'profit_today';
    const s = sum(entries.filter(e => e.type === 'sale' && isToday(e)));
    const x = sum(entries.filter(e => e.type === 'expense' && isToday(e) && e.kind !== 'stock' && e.kind !== 'home'));
    answer = `Hoy vendiste ${fmtSay(s)} y gastaste ${fmtSay(x)}. Te quedan ${fmtSay(s - x)}.`;
  } else if (/vend|venta/.test(q)) {
    intent = week ? 'sold_week' : 'sold_today';
    const list = entries.filter(e => e.type === 'sale' && (week ? inWeek(e) : isToday(e)));
    answer = `Vendiste ${fmtSay(sum(list))} ${week ? 'esta semana' : 'hoy'}${list.length ? ', ' + list.length + (list.length === 1 ? ' venta' : ' ventas') : ''}.`;
  } else {
    return false;
  }
  if (askQuestionsLeftToday() <= 0) {
    track('voice_ask', { intent: 'limit_reached' });
    // 22 Sep: no "support CountMy to unlock" here on purpose - the paid path
    // (MoMo to a Ghanaian number, priced in cedis) does not work for
    // Venezuela or Colombia, so promising it would be a real, checkable lie
    // to this user. Fix when a VE/CO payment method actually exists.
    const limitMsg = `Ya usaste tus ${ASK_FREE_DAILY_LIMIT} preguntas gratis de hoy. Puedes preguntar otra vez mañana.`;
    setMicStatus(limitMsg, 'heard');
    speakShort(limitMsg);
    return true;
  }
  recordAskUsed();
  track('voice_ask', { intent });
  ping('ask');
  setMicStatus(answer, 'heard');
  speakShort(answer);
  return true;
}

function speakShort(text) {
  try { say(text); } catch (e) { /* speech is a bonus, never a requirement */ }
}

// One place every save path ends up, so the typed sheet, a voice card and a
// photo card all behave identically - a debt gets its reminder, an early
// entry gets counted toward five. Deliberately never both at once: two
// prompts stacked after one save is exactly the "too much going on" this
// app keeps being told about.
async function afterEntrySaved(entry) {
  try {
    if (entry && entry.type === 'debt_in') { showDebtReminder(entry); return; }
    const all = await getAllEntries();
    // 18 Sep: zero returning visitors in a week because there is no route
    // back. The first save offers a WhatsApp message to herself with the
    // link at the bottom: tomorrow she finds CountMy where she looks every day.
    // The way back (25 Sep journeys): savers test 2-4 records in their first
    // two minutes and the "send to WhatsApp" offer after record 1 was not
    // taken (GA4: offered, never sent). So: framed on the loss traders
    // actually fear (Kippa users lost their books), and offered again at
    // record 3, when a tester has become a user. Offers and sends are now
    // counted in our own backend.
    let waSent = false; try { waSent = localStorage.getItem('kym_wa_sent') === '1'; } catch (e) { /* optional */ }
    if ((all.length === 1 || (all.length === 3 && !waSent)) && !ES) {
      clearOtherPrompts('milestone');
      const lead = all.length === 1
        ? t('Saved. Do not lose your book: send it to your own WhatsApp. Tomorrow, one tap brings it back.', '')
        : t('3 records written. Keep them safe: send your book to your own WhatsApp.', '');
      const box = floatNotice(`${escapeHtml(lead)} <button type="button" class="remind-btn" id="firstWaBtn">${t('Send to my WhatsApp', '')}</button>${reminderButtonHtml()}`, 0);
      wireReminderButton(box);
      track('first_wa_offer', { n: all.length }); ping('wa_offer');
      box.querySelector('#firstWaBtn').addEventListener('click', () => { track('first_wa_send', { n: all.length }); ping('wa_send'); try { localStorage.setItem('kym_wa_sent', '1'); } catch (e) { /* optional */ } box.hidden = true; exportBackup(); });
      return;
    }
    if (all.length <= FIRST_ENTRIES_TARGET) showEntryMilestone(all.length);
  } catch (e) { /* never let a nicety break a save */ }
}

// Real answer to "what if the phone is lost" without building a sync backend or
// asking a Makola market trader to understand a file system. WhatsApp is the one
// app almost every Ghanaian shop owner already knows how to use, so this opens
// WhatsApp directly with a plain, readable list of records pre-filled - no OS
// share-sheet picker (AirDrop/Messages/Mail/etc, which tested as genuinely
// confusing for older, less tech-familiar users), no file, no "what is a CSV."
// She sends it to herself or a family member and that's the backup, done.
async function exportBackup() {
  // Real bug, found 2 Sep from a real iOS Safari report ("the send button
  // doesn't work" - no error, just silence). First attempt (open a blank
  // tab synchronously, fill it in once IndexedDB responds) still failed
  // for the same real user, in Private Browsing specifically - Private
  // mode on iOS Safari blocks window.open() outright as an anti-tracking
  // measure, even when called synchronously from a genuine tap, no error
  // either way. The robust fix: don't open a new tab at all. Navigate the
  // CURRENT tab to the wa.me link - plain top-level navigation isn't
  // subject to popup-blocking in any mode. On a phone this hands off to
  // the real WhatsApp app anyway (wa.me is built to do exactly that), so
  // the practical result is identical to opening a new tab.
  const entries = await getAllEntries();
  if (!entries.length) { alert(t('Nothing to back up yet.', 'Todav\u00eda no hay cuentas que respaldar.')); return; }
  const typeLabel = ES ? { sale: 'Venta', expense: 'Gasto', debt_in: 'Me deben', debt_out: 'Debo' } : { sale: 'Sale', expense: 'Expense', debt_in: 'Owed to me', debt_out: 'I owe' };
  const ordered = entries.slice().reverse(); // oldest first, reads like a diary
  const MAX_LINES = 200; // keeps the WhatsApp message and its URL a sane length
  const shown = ordered.length > MAX_LINES ? ordered.slice(-MAX_LINES) : ordered;
  const lines = shown.map(e => {
    const cfg = FIELD_CONFIG[e.type];
    const when = new Date(e.ts).toLocaleDateString(ES ? 'es-VE' : 'en-GH', { day: 'numeric', month: 'short' });
    return `${when} - ${typeLabel[e.type]}: ${cfg.desc(e)} - ${fmt(e.amount, e.cur)}`;
  });
  const shopName = getShopId() || t('My business', 'Mi negocio');
  const truncNote = shown.length < ordered.length ? t(` (most recent ${MAX_LINES})`, ` (\u00faltimos ${MAX_LINES})`) : '';
  // Real, dated reason this one line exists: since 1 July 2025 the GRA's
  // Modified Taxation Scheme asks an informal trader for a yearly sales
  // figure (a simplified annual return, and a turnover estimate at sign-up
  // on *880#), and registers people through their trade association. This
  // is the first time the state asks a market trader for a number a
  // notebook actually produces, so the notebook should hand it over
  // already added up instead of making her count a year of entries.
  // Counted over the last 365 days from every sale recorded, whatever the
  // 200-line display cap above shows.
  const yearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const yearSales = entries
    .filter(e => e.type === 'sale' && e.ts >= yearAgo && e.cur !== 'VES')
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const yearLine = t(`Total sales in the last 12 months: ${fmt(yearSales)}\n`, `Ventas totales en los \u00faltimos 12 meses: ${fmt(yearSales)}\n`);
  const text = t(`${shopName} records${truncNote}:\n\n${yearLine}\n${lines.join('\n')}${shareFooter('backup')}`, `Cuentas de ${shopName}${truncNote}:\n\n${yearLine}\n${lines.join('\n')}${shareFooter('backup')}`);
  location.href = 'https://wa.me/?text=' + encodeURIComponent(text);
}

// Real ask, 1 Sep: an automatic end-of-day WhatsApp send, with zero taps.
// Honest limit checked before building anything: there is no way for a
// website or PWA to silently send a WhatsApp message on its own - WhatsApp
// has no public API for a personal account, only the paid, business-
// verified WhatsApp Business Platform, which needs a registered business
// number and per-conversation cost, not something to bolt onto a free app
// overnight. A real background push notification (so this fires even with
// the app closed) needs its own backend - a stored per-shop subscription,
// VAPID keys, and a server-side cron - which is a genuine, separate build,
// not a same-day fix, and not worth shipping half-tested. What IS real and
// buildable today: the moment she actually opens the app in the evening
// with sales recorded and nothing sent yet, put the send one tap in front
// of her instead of waiting for her to remember the Export button exists.
function exportTodaySummary() {
  // Same fix as exportBackup above - navigate the current tab, don't open
  // a new one (Safari Private Browsing blocks window.open() outright).
  getAllEntries().then(entries => {
    const today = todayKey(Date.now());
    const todayEntries = entries.filter(e => e.day === today).slice().reverse();
    // Never fail silently - a tap must always visibly do something.
    if (!todayEntries.length) { alert(t('Nothing recorded today yet.', 'Todav\u00eda no hay nada registrado hoy.')); return; }
    const typeLabel = ES ? { sale: 'Venta', expense: 'Gasto', debt_in: 'Me deben', debt_out: 'Debo' } : { sale: 'Sale', expense: 'Expense', debt_in: 'Owed to me', debt_out: 'I owe' };
    const lines = todayEntries.map(e => {
      const cfg = FIELD_CONFIG[e.type];
      return `${typeLabel[e.type]}: ${cfg.desc(e)} - ${fmt(e.amount, e.cur)}`;
    });
    const shopName = getShopId() || t('My business', 'Mi negocio');
    const text = t(`${shopName} - today's summary:\n\n${lines.join('\n')}${shareFooter('eod')}`, `${shopName} - resumen de hoy:\n\n${lines.join('\n')}${shareFooter('eod')}`);
    location.href = 'https://wa.me/?text=' + encodeURIComponent(text);
  });
}

// ---------------------------------------------------------------------------
// Business history + spreadsheet download (25 Sep). "Your records are
// yours": Kippa's app went dark in Jan 2024 and ~500k businesses lost their
// books (TechCabal). The history is a plain summary of a period she can
// send to herself or show a lender, a programme or a supplier; the
// spreadsheet is every record, readable without CountMy. Venezuela's
// bolivar lines stay out of the dollar totals, like everywhere else.
// ---------------------------------------------------------------------------
function businessHistory(entries, days) {
  const DAYMS = 86400000, now = Date.now(), since = now - days * DAYMS;
  const home = e => !ES || e.cur !== 'VES';
  const amt = e => Number(e.amount) || 0;
  const inRange = entries.filter(e => e.ts >= since && home(e));
  const sales = inRange.filter(e => e.type === 'sale');
  const exps = inRange.filter(e => e.type === 'expense');
  const running = exps.filter(e => e.kind !== 'stock' && e.kind !== 'home');
  const stock = exps.filter(e => e.kind === 'stock');
  const tookHome = exps.filter(e => e.kind === 'home');
  const sum = arr => arr.reduce((t2, e) => t2 + amt(e), 0);
  const repaid = entries.filter(e => e.type === 'debt_in' && home(e))
    .flatMap(e => (Array.isArray(e.payments) ? e.payments : []).filter(p => p && p.ts >= since))
    .reduce((t2, p) => t2 + (Number(p.amount) || 0), 0);
  const moneyIn = sum(sales) + repaid;
  const costs = sum(running);
  const daysRecorded = new Set(inRange.map(e => e.day)).size;
  const plain = new Set(['sale', 'venta', 'spent', 'gasto']);
  const top = (arr, n) => {
    const m = {};
    arr.forEach(e => { const k = String(e.item || '').trim(); if (!k || plain.has(k.toLowerCase())) return; const key = k.toLowerCase(); (m[key] = m[key] || { name: k, total: 0 }).total += amt(e); });
    return Object.values(m).sort((a, b) => b.total - a.total).slice(0, n);
  };
  const left = e => Math.max(0, amt(e) - (Number(e.paid) || 0));
  const owed = entries.filter(e => e.type === 'debt_in' && home(e) && left(e) > 0);
  const iOwe = entries.filter(e => e.type === 'debt_out' && home(e) && left(e) > 0);
  const d = ts => new Date(ts).toLocaleDateString(ES ? (CO ? 'es-CO' : 'es-VE') : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const shopName = getShopId() || t('My business', 'Mi negocio');
  const L = [];
  L.push(t(shopName + ' - business history', shopName + ' - historial del negocio'));
  L.push(d(since) + ' - ' + d(now));
  L.push('');
  L.push(t('Money in: ', 'Entr\u00f3: ') + fmt(moneyIn) + (repaid ? t(' (incl. ' + fmt(repaid) + ' paid back)', ' (incluye ' + fmt(repaid) + ' de pagos de deudas)') : ''));
  L.push(t('Business costs: ', 'Gastos del negocio: ') + fmt(costs));
  if (stock.length) L.push(t('Stock bought: ', 'Mercanc\u00eda comprada: ') + fmt(sum(stock)));
  if (tookHome.length) L.push(t('Took home: ', 'Para la casa: ') + fmt(sum(tookHome)));
  L.push(t('Left after costs: ', 'Queda despu\u00e9s de gastos: ') + fmt(moneyIn - costs));
  L.push(t('Days with records: ' + daysRecorded + ' of ' + days, 'D\u00edas con registros: ' + daysRecorded + ' de ' + days));
  const ts = top(sales, 3);
  if (ts.length) { L.push(''); L.push(t('Best sellers:', 'Lo que m\u00e1s vendi\u00f3:')); ts.forEach(x => L.push('- ' + x.name + ': ' + fmt(x.total))); }
  const tc2 = top(running.concat(stock), 3);
  if (tc2.length) { L.push(''); L.push(t('Biggest costs:', 'Los gastos m\u00e1s grandes:')); tc2.forEach(x => L.push('- ' + x.name + ': ' + fmt(x.total))); }
  L.push('');
  L.push(owed.length ? t('Owed to me: ' + fmt(owed.reduce((a, e) => a + left(e), 0)) + ' (' + owed.length + (owed.length === 1 ? ' person)' : ' people)'), 'Me deben: ' + fmt(owed.reduce((a, e) => a + left(e), 0)) + ' (' + owed.length + (owed.length === 1 ? ' persona)' : ' personas)')) : t('Nobody owes me.', 'Nadie me debe.'));
  if (iOwe.length) L.push(t('I owe: ', 'Debo: ') + fmt(iOwe.reduce((a, e) => a + left(e), 0)));
  return L.join('\n');
}
let historyDays = 30;
async function showHistory(days) {
  historyDays = days;
  const entries = await getAllEntries();
  document.getElementById('historyText').textContent = entries.length ? businessHistory(entries, days) : t('Nothing recorded yet.', 'Todav\u00eda no hay nada anotado.');
  document.querySelectorAll('.history-p').forEach(b => b.classList.toggle('on', Number(b.dataset.days) === days));
  track('history_view', { days });
}
function csvCell(v) { const x = String(v == null ? '' : v); return /[",\n\r]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; }
async function downloadRecordsCsv() {
  const entries = (await getAllEntries()).slice().sort((a, b) => a.ts - b.ts);
  if (!entries.length) { alert(t('Nothing to download yet.', 'Todav\u00eda no hay nada para descargar.')); return; }
  const head = ['date', 'time', 'type', 'item', 'note', 'qty', 'price', 'amount', 'currency', 'paid', 'still_owed', 'how_recorded'];
  const typeName = { sale: 'sale', expense: 'expense', debt_in: 'owed_to_me', debt_out: 'i_owe' };
  const rows = entries.map(e => {
    const dt = new Date(e.ts);
    const debt = e.type === 'debt_in' || e.type === 'debt_out';
    return [e.day || todayKey(e.ts), dt.toTimeString().slice(0, 5), typeName[e.type] || e.type, e.item || '', e.note || '', e.qty || '', e.price || '', Number(e.amount) || 0, e.cur || (ES ? HOME_CUR : 'GHS'), debt ? (Number(e.paid) || 0) : '', debt ? Math.max(0, (Number(e.amount) || 0) - (Number(e.paid) || 0)) : '', e.source || ''].map(csvCell).join(',');
  });
  const csv = '\ufeff' + head.join(',') + '\n' + rows.join('\n') + '\n';
  track('csv_download', { rows: entries.length });
  try {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'countmy-records-' + todayKey(Date.now()) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    if (inAppBrowser()) setMicStatus(t('If nothing downloaded, open CountMy in Chrome - Facebook blocks downloads. Or send it to your WhatsApp above.', 'Si no se descarg\u00f3, abre CountMy en Chrome: Facebook bloquea las descargas. O env\u00edalo a tu WhatsApp arriba.'), null, 'homeMicStatus');
  } catch (e) {
    alert(t('This browser cannot download files. Use "Send my records to my own WhatsApp" instead.', 'Este navegador no puede descargar archivos. Usa "Enviar mis cuentas a mi WhatsApp".'));
  }
}
(function wireHistory() {
  const btn = document.getElementById('historyBtn'); if (!btn) return;
  const box = document.getElementById('historyBox');
  if (ES) {
    btn.lastChild.textContent = ' Historial de mi negocio';
    const lbl = { 30: '30 d\u00edas', 90: '90 d\u00edas', 365: '12 meses' };
    document.querySelectorAll('.history-p').forEach(b => { b.textContent = lbl[b.dataset.days]; });
    document.getElementById('historySend').textContent = 'Enviarlo a mi WhatsApp';
    document.getElementById('csvBtn').textContent = 'Descargar todas mis cuentas (hoja de c\u00e1lculo)';
  }
  btn.addEventListener('click', () => { box.hidden = !box.hidden; if (!box.hidden) showHistory(historyDays); });
  document.querySelectorAll('.history-p').forEach(b => b.addEventListener('click', () => showHistory(Number(b.dataset.days))));
  document.getElementById('historySend').addEventListener('click', async () => {
    const entries = await getAllEntries();
    if (!entries.length) return;
    track('history_send', { days: historyDays });
    location.href = 'https://wa.me/?text=' + encodeURIComponent(businessHistory(entries, historyDays) + shareFooter('history'));
  });
  document.getElementById('csvBtn').addEventListener('click', downloadRecordsCsv);
})();

// How long a shop counts as "new" for the first-week nudges below. Seven
// days is the window the five-entry evidence is about, not a guess at how
// long someone stays interested.
const FIRST_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
function firstSeenAt() {
  try {
    const existing = Number(localStorage.getItem('kym_first_seen')) || 0;
    if (existing) return existing;
    const now = Date.now();
    localStorage.setItem('kym_first_seen', String(now));
    return now;
  } catch (e) { return Date.now(); }
}

function maybeShowEodPrompt() {
  const hour = new Date().getHours();
  if (hour < 18) return; // only from evening onward - a lunchtime interruption helps no one
  const today = todayKey(Date.now());
  if (localStorage.getItem('kym_eod_prompted') === today) return; // once per day, ever
  getAllEntries().then(entries => {
    const hasToday = entries.some(e => e.day === today);
    // The other half of the five-entry ritual. A brand new shop that has
    // opened the app in the evening and recorded nothing is the exact
    // moment the habit is won or lost, and the published number says a
    // user who reaches five entries in month one retains at twice the
    // rate. Only in the first week, only once a day, and it stops for
    // good once the habit exists (five entries recorded) - a shop that is
    // already using this must never be nagged.
    if (!hasToday) {
      // Found 16 Sep on a fresh device in the evening: this fired with ZERO
      // entries, so a stranger's first screen carried a second "say it now"
      // banner on top of everything else. A ritual nudge needs a first
      // record to be a ritual about - one entry or more, fewer than five.
      const isNew = (Date.now() - firstSeenAt()) < FIRST_WEEK_MS && entries.length >= 1 && entries.length < FIRST_ENTRIES_TARGET;
      const nudge = document.getElementById('eveningNudge');
      if (isNew && nudge) {
        localStorage.setItem('kym_eod_prompted', today);
        nudge.hidden = false;
        track('evening_nudge');
        speakShort(t('What did you sell today? Tap the orange button and say it.', '\u00bfQu\u00e9 vendiste hoy? Toca el bot\u00f3n naranja y dilo.'));
      }
      return;
    }
    localStorage.setItem('kym_eod_prompted', today);
    const banner = document.getElementById('eodBanner');
    if (banner) banner.hidden = false;
  });
}

async function updateOfflineBadge() {
  const badge = document.getElementById('offlineBadge');
  if (navigator.onLine) { badge.classList.remove('show'); return; }
  let reallyOff = true;
  try {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch('manifest.json?ping=' + Date.now(), { cache: 'no-store', signal: ctl.signal });
    clearTimeout(tm);
    if (r.ok) { reallyOff = false; track('online_flag_wrong'); }
  } catch (e) { /* genuinely offline */ }
  badge.classList.toggle('show', reallyOff);
}

// [data-type] only - the photo button (#snapBtn) shares .act-btn for its
// size and look but opens the camera, not a typed sheet.
let pendingHeard = null;
document.querySelectorAll('.act-btn[data-type]').forEach(btn => {
  btn.addEventListener('click', () => {
    openSheet(btn.dataset.type);
    if (pendingHeard) {
      // The words from the last recording, split into name/item and amount.
      try { fillFields(parseHeardText(btn.dataset.type, pendingHeard)); sheetVoiceFilled = true; pendingVoiceSource = 'voice'; track('clarify_pick', { type: btn.dataset.type }); } catch (e) { /* typed sheet still works */ }
      pendingHeard = null;
    }
  });
});
document.getElementById('cancelBtn').addEventListener('click', () => {
  pendingHeard = null;
  if (activeType && !editingEntry) {
    const v = readValues();
    if (v.item || v.price) syncNotSaved({ type: activeType, item: v.item, note: v.note, qty: v.qty, price: v.price, amount: FIELD_CONFIG[activeType].compute(v) });
  }
  closeSheet();
});
document.getElementById('saveBtn').addEventListener('click', saveEntry);
document.getElementById('deleteEntryBtn').addEventListener('click', async () => {
  if (!editingEntry) return;
  if (!confirm('Delete this entry? This cannot be undone.')) return;
  await deleteEntry(editingEntry.id);
  track('delete_entry', { type: editingEntry.type });
  closeSheet();
  await render();
});
document.getElementById('hearBtn').addEventListener('click', speakToday);
// Hear-it works everywhere now (server voice, phone voice as fallback).
// ---------------------------------------------------------------------------
// Shop page (16 Sep). See the Worker's handleShopUpsert for why this exists.
// Everything here is plain: a short form, one request, a share button that
// opens WhatsApp with her page link and what she sells. The page's edit key
// lives on this phone only.
// ---------------------------------------------------------------------------
const SHOP_LS = 'kym_shop_page';
function shopPageState() { try { return JSON.parse(localStorage.getItem(SHOP_LS) || 'null'); } catch (e) { return null; } }
function renderShopItemRows(items) {
  const box = document.getElementById('shopItems');
  const rows = (items && items.length ? items : [{ name: '', price: '' }]).slice(0, 5);
  box.innerHTML = rows.map(it => `<div class="shop-item"><input type="text" maxlength="60" placeholder="Dress" value="${escapeAttr(it.name || '')}"><input type="number" inputmode="decimal" min="0" placeholder="Price" value="${it.price == null ? '' : escapeAttr(it.price)}"></div>`).join('');
}
function escapeAttr(v) { return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function readShopItems() {
  return [...document.querySelectorAll('#shopItems .shop-item')].map(row => {
    const [n, p] = row.querySelectorAll('input');
    return { name: n.value.trim(), price: p.value === '' ? null : Number(p.value) };
  }).filter(it => it.name);
}
function openShopSheet(prefill) {
  const st = prefill || shopPageState() || {};
  document.getElementById('shopName').value = st.name || getShopId() || '';
  document.getElementById('shopCategory').value = st.category || 'other';
  document.getElementById('shopArea').value = st.area || '';
  document.getElementById('shopWhatsapp').value = st.whatsapp || '';
  document.getElementById('shopHours').value = st.hours || '';
  document.getElementById('shopIg').value = st.ig || '';
  document.getElementById('shopTiktok').value = st.tiktok || '';
  renderShopItemRows(st.items);
  setMicStatus('', null, 'shopStatus');
  const sheet = document.getElementById('shopSheet');
  sheet.hidden = false; sheet.classList.add('open');
  sheet.scrollIntoView({ behavior: 'smooth', block: 'start' });
  track('open_sheet', { type: 'shop_page' });
}
function closeShopSheet() { const sheet = document.getElementById('shopSheet'); sheet.classList.remove('open'); sheet.hidden = true; }
function renderShopReady() {
  const st = shopPageState();
  const box = document.getElementById('shopReady');
  const btn = document.getElementById('shopPageBtn');
  if (!st || !st.url) { box.hidden = true; if (btn) btn.textContent = t('Get a free page for your business', 'Página gratis para tu negocio'); return; }
  if (btn) btn.textContent = t('My business page', 'Mi página de negocio');
  document.getElementById('shopReadyText').textContent = t(`${st.name} has a page: ${st.url.replace('https://', '')}`, `${st.name} tiene una página: ${st.url.replace('https://', '')}`);
  const items = (st.items || []).map(i => i.name).filter(Boolean).slice(0, 4).join(', ');
  const msg = `${st.name}${st.area ? ' - ' + st.area : ''}\n${items ? items + '\n' : ''}See what I sell and WhatsApp me here:\n${st.url}?utm_source=whatsapp&utm_medium=share&utm_campaign=shop_page`;
  document.getElementById('shopShareBtn').href = 'https://wa.me/?text=' + encodeURIComponent(msg);
  box.hidden = false;
}
document.getElementById('shopPageBtn').addEventListener('click', () => {
  const st = shopPageState();
  if (st && st.url) { renderShopReady(); document.getElementById('shopReady').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  openShopSheet();
});
document.getElementById('shopEditBtn').addEventListener('click', () => openShopSheet());
document.getElementById('shopShareBtn').addEventListener('click', () => { track('share_business', { where: 'app' }); ping('share_shop'); });
document.getElementById('shopCancelBtn').addEventListener('click', closeShopSheet);
document.getElementById('shopAddItem').addEventListener('click', () => {
  const rows = readShopItems();
  if (rows.length >= 5) return;
  rows.push({ name: '', price: '' });
  renderShopItemRows(rows.concat(rows.length < 5 && !rows.some(r => !r.name) ? [] : []));
});
document.getElementById('shopSaveBtn').addEventListener('click', async () => {
  const btn = document.getElementById('shopSaveBtn');
  const st = shopPageState() || {};
  const payload = {
    slug: st.slug || '', editKey: st.editKey || '', test: isTestDevice(),
    name: document.getElementById('shopName').value.trim(),
    category: document.getElementById('shopCategory').value,
    area: document.getElementById('shopArea').value.trim(),
    whatsapp: document.getElementById('shopWhatsapp').value.trim(),
    hours: document.getElementById('shopHours').value.trim(),
    ig: document.getElementById('shopIg').value.trim(),
    tiktok: document.getElementById('shopTiktok').value.trim(),
    items: readShopItems(),
    programme: localStorage.getItem('kym_programme') || ''
  };
  if (!payload.name) { setMicStatus(t('Please give your business a name.', 'Por favor ponle un nombre a tu negocio.'), 'err', 'shopStatus'); return; }
  if (!payload.whatsapp) { setMicStatus(t('Please enter your WhatsApp number.', 'Por favor escribe tu n\u00famero de WhatsApp.'), 'err', 'shopStatus'); return; }
  btn.disabled = true; btn.textContent = t('Making\u2026', 'Creando\u2026');
  try {
    const res = await fetch(`${API_BASE}/shop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.slug) { setMicStatus(data.error || t('Could not make the page. Please try again.', 'No se pudo crear la p\u00e1gina. Intenta otra vez.'), 'err', 'shopStatus'); return; }
    localStorage.setItem(SHOP_LS, JSON.stringify({ ...payload, slug: data.slug, editKey: data.editKey, url: data.url }));
    if (!getShopId()) setShopId(payload.name); // her backup is filed under this name from now on
    track(st.slug ? 'business_updated' : 'business_created', { category: payload.category, items: payload.items.length });
    if (!st.slug) ping('shop_created');
    closeShopSheet();
    renderShopReady();
    document.getElementById('shopReady').scrollIntoView({ behavior: 'smooth', block: 'center' });
    speakShort(t('Your page is ready. Tap Share my page to send it on WhatsApp.', 'Tu p\u00e1gina est\u00e1 lista. Toca Compartir mi p\u00e1gina para enviarla por WhatsApp.'));
  } catch (e) {
    setMicStatus(t('No connection. Please try again when you have signal.', 'Sin conexi\u00f3n. Intenta otra vez cuando tengas se\u00f1al.'), 'err', 'shopStatus');
  } finally { btn.disabled = false; btn.textContent = t('Make my page', 'Crear mi p\u00e1gina'); }
});
renderShopReady();

// ---------------------------------------------------------------------------
// Install (16 Sep). Chromium fires beforeinstallprompt when the PWA is
// installable; we hold it and offer it once there is a record to come back
// to. Accepting is counted (ping 'install'); dismissing waits a week. The
// open ping carries standalone:1 when the app is launched from the icon, so
// "came back through the icon" is visible on the dashboard.
// ---------------------------------------------------------------------------
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; renderInstallBanner(); });
window.addEventListener('appinstalled', () => { ping('install'); track('pwa_installed'); deferredInstall = null; renderInstallBanner(); });
function renderInstallBanner() {
  const box = document.getElementById('installBanner');
  if (!box) return;
  let snoozed = 0;
  try { snoozed = Number(localStorage.getItem('kym_install_later') || 0); } catch (e) { /* optional */ }
  const hasRecord = hasAnyRecord;
  box.hidden = !(deferredInstall && hasRecord && !isStandalone() && Date.now() - snoozed > 7 * 86400000);
}
document.getElementById('installBtn').addEventListener('click', async () => {
  if (!deferredInstall) return;
  track('pwa_install_prompt');
  const p = deferredInstall; deferredInstall = null;
  try { p.prompt(); const r = await p.userChoice; track('pwa_install_choice', { outcome: r && r.outcome }); } catch (e) { /* user closed it */ }
  renderInstallBanner();
});
document.getElementById('installLater').addEventListener('click', () => {
  try { localStorage.setItem('kym_install_later', String(Date.now())); } catch (e) { /* optional */ }
  track('pwa_install_later');
  renderInstallBanner();
});

document.getElementById('planPill').addEventListener('click', () => document.getElementById('planSheet').classList.add('open'));
document.getElementById('planCloseBtn').addEventListener('click', () => document.getElementById('planSheet').classList.remove('open'));
document.getElementById('exportBtn').addEventListener('click', exportBackup);

const debtReminderDismiss = document.getElementById('debtReminderDismiss');
if (debtReminderDismiss) {
  debtReminderDismiss.addEventListener('click', () => {
    document.getElementById('debtReminder').hidden = true;
    clearTimeout(debtReminderTimer);
  });
}
const debtReminderSend = document.getElementById('debtReminderSend');
if (debtReminderSend) {
  debtReminderSend.addEventListener('click', () => {
    track('debt_reminder_sent');
    document.getElementById('debtReminder').hidden = true;
  });
}
// The nudge is a prompt to speak, so it hands straight over to the mic
// rather than making her find the button herself. The tap on the nudge is
// the same user gesture the mic needs, so nothing is blocked.
const eveningNudgeBtn = document.getElementById('eveningNudgeBtn');
if (eveningNudgeBtn) {
  eveningNudgeBtn.addEventListener('click', () => {
    document.getElementById('eveningNudge').hidden = true;
    track('evening_nudge_tap');
    const mic = document.getElementById('homeMicBtn');
    if (mic) { mic.scrollIntoView({ behavior: 'smooth', block: 'center' }); mic.click(); }
  });
}
const eveningNudgeDismiss = document.getElementById('eveningNudgeDismiss');
if (eveningNudgeDismiss) {
  eveningNudgeDismiss.addEventListener('click', () => { document.getElementById('eveningNudge').hidden = true; });
}
const recoverBtn = document.getElementById('recoverBtn');
if (recoverBtn) {
  recoverBtn.addEventListener('click', () => {
    const shop = getShopId();
    const nameEl = document.getElementById('recoverShopName');
    if (nameEl) nameEl.textContent = shop || 'not set yet';
    document.getElementById('recoverSheet').classList.add('open');
    track('open_recover');
  });
}
const recoverCloseBtn = document.getElementById('recoverCloseBtn');
if (recoverCloseBtn) {
  recoverCloseBtn.addEventListener('click', () => document.getElementById('recoverSheet').classList.remove('open'));
}
const eodBanner = document.getElementById('eodBanner');
if (eodBanner) {
  document.getElementById('eodSendBtn').addEventListener('click', () => {
    exportTodaySummary();
    eodBanner.hidden = true;
  });
  document.getElementById('eodDismissBtn').addEventListener('click', () => { eodBanner.hidden = true; });
}
document.getElementById('askBtn').addEventListener('click', () => {
  track('open_sheet', { type: 'ask' });
  askMode = true;
  toggleMic(document.getElementById('homeMicBtn'), 'homeMicStatus');
});
document.getElementById('seeBtn').addEventListener('click', async () => {
  track('see_business');
  const entries = await getAllEntries();
  if (!entries.length) {
    // 18 Sep, from two Facebook visitors' recordings: this tap looked dead
    // to a first-timer. Now it plays the walkthrough instead of only speaking.
    speakShort(t('Nothing recorded yet. Tap Tell CountMy and say what happened.', 'Todav\u00eda no hay nada anotado. Toca Cu\u00e9ntale a CountMy y di qu\u00e9 pas\u00f3.'));
    const demo = document.getElementById('demoBtn');
    if (demo) { demo.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => { try { demo.click(); } catch (e) { /* optional */ } }, 1800); }
    return;
  }
  seeOpen = true;
  await render();
  const card = document.querySelector('.today');
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
document.querySelectorAll('.ts-tile').forEach(tile => tile.addEventListener('click', () => document.getElementById('seeBtn').click()));
// The example under the button is one a person here would actually say.
(function setTryExample() {
  const el = document.getElementById('tryExample'); if (!el) return;
  const ex = !ES ? '\u201cI sold 3 bowls of waakye for 60 cedis.\u201d' : (CO ? '\u201cVend\u00ed cinco camisas de a diez mil.\u201d' : '\u201cVend\u00ed tres refrescos a dos d\u00f3lares.\u201d');
  el.textContent = ex;
})();
// 22 Sep: removed the manual EN<->ES toggle button - language is set by
// detectLang() (URL param, saved choice, or browser locale) only, never a
// tap in the UI, in either direction.
document.getElementById('homeMicBtn').addEventListener('click', () => {
  // Book inside Facebook's Android browser: Talk is handled by the in-app
  // block below. Checked here too because WebViews older than 89 run this
  // listener before that block's capture listener can stop it.
  if (BK_IAB_TALK) return;
  track('open_sheet', { type: 'home_mic' });
  ping('tap'); // funnel step between 'opened' and 'recorded' (16 Sep)
  toggleMic(document.getElementById('homeMicBtn'), 'homeMicStatus');
});
if (ES) {
  // Static page text, Spanish. Leaf elements whose whole text matches an
  // English line are swapped; everything else is untouched.
  const S = {
    'A free notebook for your business.': 'Un cuaderno gratis para tu negocio.',
    '→ CountMy writes:': '→ CountMy anota:',
    'Tap or talk. It writes down what you sell, what you spend, and who owes you.': 'Toca o habla. CountMy anota lo que vendes, lo que gastas y qui\u00e9n te debe.',
    'What happened in your business today?': '\u00bfQu\u00e9 pas\u00f3 hoy en tu negocio?',
    'Tell CountMy': 'Cu\u00e9ntale a CountMy',
    'Say it in English, Twi or Pidgin. You can also ask: \u201cwho owes me?\u201d': 'Dilo en espa\u00f1ol. Tambi\u00e9n puedes preguntar: \u201c\u00bfqui\u00e9n me debe?\u201d',
    '\u201cWho owes me?\u201d': '\u201c\u00bfQui\u00e9n me debe?\u201d',
    'See how it works': 'Ver c\u00f3mo funciona',
    'Money in': 'Entr\u00f3', 'Money out': 'Sali\u00f3', 'Owed to you': 'Te deben',
    'Try saying:': 'Prueba diciendo:', 'Ask CountMy': 'Preg\u00fantale a CountMy', 'See my business': 'Ver mi negocio',
    '\u201cWho owes me?\u201d \u201cWhat did I sell?\u201d': '\u201c\u00bfQui\u00e9n me debe?\u201d \u201c\u00bfQu\u00e9 vend\u00ed?\u201d', 'Today and all your records': 'Hoy y todas tus cuentas',
    'English \u00b7 Twi \u00b7 Pidgin': 'Espa\u00f1ol',
    'Type it instead': 'Mejor escr\u00edbelo',
    '+ Sale': '+ Venta', '+ Expense': '+ Gasto', 'Customer owes me': 'Cliente me debe', 'I owe supplier': 'Le debo al proveedor', 'Someone paid you': 'Alguien te pagó',
    'Snap your book or receipt': 'T\u00f3male foto al cuaderno o a la factura',
    'Get a free page for your business': 'P\u00e1gina gratis para tu negocio',
    'Cancel': 'Cancelar', 'Save': 'Guardar', 'Delete this entry': 'Borrar esto', 'Add': 'Agregar',
    'What I heard': 'Lo que escuch\u00e9',
    'Today': 'Hoy', '\ud83d\udd0a Hear it': '\ud83d\udd0a Esc\u00fachalo',
    'Sales': 'Ventas', 'Expenses': 'Gastos', 'Stock bought': 'Mercanc\u00eda comprada', 'Money I took home': 'Plata para la casa',
    'Customers owe me': tc('Clientes me deben', 'Fiao por cobrar'), 'Money left over': 'Lo que me queda', 'Cash I have now': tc('Efectivo que tengo ahora', 'Plata en caja'),
    'Recent': 'Lo \u00faltimo',
    'Send today\u2019s records to WhatsApp?': '\u00bfEnviar lo de hoy a WhatsApp?', "Send today's records to WhatsApp?": '\u00bfEnviar lo de hoy a WhatsApp?',
    'Send': 'Enviar', 'Not now': 'Ahora no', 'Remind on WhatsApp': 'Cobrar por WhatsApp',
    'What did you sell today?': '\u00bfQu\u00e9 vendiste hoy?', 'Say it now': 'Dilo ahora',
    'Put CountMy on your phone, so you can find it tomorrow.': 'Pon CountMy en tu celular para encontrarlo ma\u00f1ana.',
    'Put it on my phone': 'Ponerlo en mi celular',
    'Not backed up yet': 'Sin respaldo todav\u00eda', 'Send my records to my own WhatsApp': 'Enviar mis cuentas a mi WhatsApp',
    'Lost your phone? How to get your records back': '\u00bfPerdiste el celular? C\u00f3mo recuperar tus cuentas',
    'Is CountMy safe?': '\u00bfEs seguro CountMy?', 'Message us on WhatsApp': 'Escr\u00edbenos por WhatsApp',
    'No connection \u2014 still recording, saved on your phone. Please tap to check again.': 'Sin conexi\u00f3n: sigue anotando, se guarda en tu celular. Toca para revisar otra vez.',
    'Share my page': 'Compartir mi p\u00e1gina', 'Edit': 'Editar', 'Make my page': 'Crear mi p\u00e1gina',
    'Safe to tap \u2014 sends your records to your own WhatsApp, nothing changes on your phone.': 'Puedes tocar tranquilo \u2014 env\u00eda tus cuentas a tu propio WhatsApp, nada cambia en tu tel\u00e9fono.',
    '\u25b6 Hear it': '\u25b6 Esc\u00fachalo',
    'Close': 'Cerrar',
    'not set yet': 'a\u00fan sin definir',
    'Getting your records back': 'C\u00f3mo recuperar tus cuentas',
    'Your records are saved on this phone, and a safe copy is kept for you under your business name.': 'Tus cuentas se guardan en este tel\u00e9fono, y se guarda una copia de seguridad para ti bajo el nombre de tu negocio.',
    'Your business name is:': 'El nombre de tu negocio es:',
    'Write it down somewhere safe. It is how your copy is found again.': 'An\u00f3talo en un lugar seguro. As\u00ed se encuentra tu copia otra vez.',
    'If your phone is lost or broken, message us on WhatsApp with your business name and we will send your records back to you.': 'Si pierdes o se da\u00f1a tu tel\u00e9fono, escr\u00edbenos por WhatsApp con el nombre de tu negocio y te enviamos tus cuentas de vuelta.',
    'Message us to get my records': 'Escr\u00edbenos para recuperar mis cuentas',
    'Your business page': 'La p\u00e1gina de tu negocio',
    'Customers open it from WhatsApp, see what you sell, and message you. This page is public: your business name and WhatsApp number will be shown.': 'Tus clientes la abren desde WhatsApp, ven lo que vendes, y te escriben. Esta p\u00e1gina es p\u00fablica: se mostrar\u00e1 el nombre de tu negocio y tu n\u00famero de WhatsApp.',
    'Business name': 'Nombre del negocio',
    'What you sell': 'Qu\u00e9 vendes',
    'Fashion and clothes': 'Moda y ropa', 'Beauty and hair': 'Belleza y cabello', 'Food and drinks': 'Comida y bebidas',
    'Phones and electronics': 'Celulares y electr\u00f3nicos', 'Shoes and bags': 'Zapatos y bolsos',
    'Your WhatsApp number': 'Tu n\u00famero de WhatsApp',
    'When you are open (optional)': 'Cu\u00e1ndo est\u00e1s abierto (opcional)',
    'What you sell and the price (up to 5)': 'Qu\u00e9 vendes y el precio (hasta 5)',
    'The safest thing today: tap': 'Lo m\u00e1s seguro hoy: toca',
    'and send it to yourself. That copy is yours forever, even without this app.': 'y env\u00edatelo a ti mismo. Esa copia es tuya para siempre, incluso sin esta aplicaci\u00f3n.',
    'Where (town or market)': 'D\u00f3nde (ciudad o mercado)',
    'Provisions': 'Abarrotes', 'Fabrics': 'Telas', 'Drinks': 'Bebidas', 'Hardware': 'Ferreter\u00eda', 'Services': 'Servicios', 'Other': 'Otro',
    '+ Add another': '+ Agregar otro'
  };
  try {
    // Real bug, 22 Sept: the old sweep only replaced elements with ZERO
    // children, so any button holding an icon (<svg>) or a label sitting
    // next to a nested child (the langSwitch button inside the language
    // line) was skipped whole - "Send my records to my own WhatsApp",
    // "See how it works" and "English \u00b7 Twi \u00b7 Pidgin" all shipped
    // untranslated in v158 despite being in this table, because none of
    // them are leaf elements. A TreeWalker over actual TEXT NODES fixes
    // the whole class of bug at once: it replaces only the matching text,
    // wherever it sits, and leaves sibling icons/child elements alone.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const raw = node.nodeValue; const k = raw.trim();
      if (k && S[k] !== undefined) node.nodeValue = raw.replace(k, S[k]);
    }
    const tl = document.getElementById('trustLine');
    if (tl) tl.textContent = tc('Gratis. Sin clave ni Pago M\u00f3vil.', 'Gratis. Sin clave ni Nequi.');
    const mic = document.getElementById('homeMicBtn'); if (mic) mic.setAttribute('aria-label', 'Cu\u00e9ntale a CountMy qu\u00e9 pas\u00f3');
    document.querySelectorAll('[data-speak]').forEach(el => {
      const m = { 'Sales': 'Ventas', 'Expenses': 'Gastos', 'Stock bought': 'Mercanc\u00eda comprada', 'Money you took home': 'Plata para la casa', 'Customers owe you': tc('Clientes te deben', 'Fiao por cobrar'), 'Money left over': 'Lo que te queda', 'Cash you have now': tc('Efectivo que tienes ahora', 'Plata en caja') };
      const v = el.getAttribute('data-speak'); if (m[v]) el.setAttribute('data-speak', m[v]);
    });
    // MoMo support pill is Ghana-only.
    const pill = document.getElementById('planPill'); if (pill) pill.style.display = 'none';
    document.title = 'CountMy - Cuaderno de cuentas gratis por voz para tu negocio';
    // Placeholder text isn't a text node, so the walker above never touches
    // it - found 22 Sept alongside the rest of the audit (Ama's Fashion,
    // an English town example, an English hours example were all still
    // showing as grey placeholder text in the Spanish business-page form).
    const PH = { shopName: 'María Moda', shopArea: 'El Cementerio, Caracas', shopWhatsapp: '0414 123 4567', shopHours: 'Lun a sáb, 8am a 6pm' };
    Object.keys(PH).forEach(id => { const el = document.getElementById(id); if (el) el.placeholder = PH[id]; });
    // aria-label isn't a text node either - a Spanish screen-reader user
    // hit "Today" in English on the always-visible summary strip.
    const strip = document.getElementById('todayStrip'); if (strip) strip.setAttribute('aria-label', 'Hoy');
  } catch (e) { /* never block the app */ }
}
// ---------------------------------------------------------------------------
// The Book (v169, 24 Sep 2026). The home screen is an exercise-book page:
// today's lines, what came in, what went out, what is left, and four equal
// buttons - Sold, Spent, Owes me (tap + keypad) and Talk (the mic).
// Why, from the evidence gathered and fact-checked 24 Sep:
//  - the design that got 100% of low-literacy users through their tasks
//    was pictures + numbers WITH voice on every screen, not text and not
//    voice alone (Medhi et al., ToCHI 2011: text 0/20, voice 13/18);
//  - speech fails where most visitors arrive (Facebook's Android browser
//    gives web pages no mic) and on everyday Twi (~30% words wrong at best,
//    arXiv 2507.02407); the owner's mum lost 2 voice tries, typed 7 clean;
//  - numbers on a keypad work for these users, a ledger layout is what
//    they understand (Parikh 2003); no Twi voice notebook exists in Ghana,
//    so voice stays as the equal fourth button, not a hidden extra.
// Every line is a normal entry in the same IndexedDB store, synced by the
// same addEntry/updateEntry/deleteEntry, editable in the same edit sheet.
// Paying a debt adds to debt.payments exactly like "Paid small small".
// ---------------------------------------------------------------------------
const BK_CED = '\u20b5', BK_MINUS = '\u2212', BK_DAY = 86400000;
const BK_LOCALE = ES ? (CO ? 'es-CO' : 'es-VE') : 'en-GB';
const BK_LABEL = { in: t('Sold', 'Vend\u00ed'), out: t('Spent', 'Gast\u00e9'), owe: t('Owes me', tc('Fiao', 'Fiado')) };
// Stored as the item when she writes no words, so the edit sheet (which
// needs an item) still works; never shown on the page itself.
const BK_PLAIN_ITEM = { in: t('Sale', 'Venta'), out: t('Spent', 'Gasto') };
const BK_CATS = [
  ['\ud83d\udce6', t('Stock', 'Mercanc\u00eda'), 'stock'],
  ['\ud83d\ude8c', t('Transport', 'Transporte'), 'running'],
  ['\ud83c\udf72', t('Food', 'Comida'), 'running'],
  ['\ud83d\udcf1', t('Airtime', tc('Saldo', 'Recargas')), 'running'],
  ['\ud83c\udfe0', t('Took home', 'Para la casa'), 'home']
];
// Spoken Twi questions (24 Sep). The owner's family can no longer be asked
// to record, so: the sentences come from the 2+-source Twi lexicon (the
// "Woaton ahe?" frame is printed in Christaller's dictionary), spoken once by
// GhanaNLP's Khaya Twi voice and kept as static files (no per-use cost).
// Checked by playing each clip back into Khaya's own Twi recogniser (11-22%
// letters off - the same as it scores on human Twi speakers). Only the
// questions the lexicon rated high/medium-high; Spent stays English (the
// Twi "di" also means eat). Played only on phones that have spoken Twi to
// CountMy (kym_twi, set when a voice entry is recognised as Twi) - reading
// Twi is rarer than reading English (2021 census: 52.8% of literate
// Ghanaians read a Ghanaian language, 96% English), so there is no written
// Twi label; the help for a Twi speaker is heard, not read.
const TW_CLIPS = { in: 'audio/tw/in.mp3', owe: 'audio/tw/owe.mp3', pay: 'audio/tw/pay.mp3', out: 'audio/tw/out.mp3', talk: 'audio/tw/talk.mp3', saved: 'audio/tw/saved.mp3', twi_on: 'audio/tw/twi_on.mp3' };
const BOOK_CLIPS = TW_CLIPS;
// 25 Sep (owner's test on his iPhone): the only way to get the Twi voice was
// the Listen button on the very first screen, which disappears after the
// first record - so every prompt stayed English. Now the choice is always on
// screen (top right) and kept; the automatic switch (server heard Twi) only
// applies when she has not chosen.
function voiceLang() {
  try {
    const v = localStorage.getItem('kym_voice');
    if (v === 'tw' || v === 'en') return v;
    return localStorage.getItem('kym_twi') === '1' ? 'tw' : 'en';
  } catch (e) { return 'en'; }
}
function bkTwiSpeaker() { return !ES && voiceLang() === 'tw'; }
// Twi recordings (sourced wording, Khaya voice). A prompt with no Twi
// recording yet is spoken in English.
// out = "Woatɔ ahe?" (Christaller's printed frame, how much have you bought);
// talk = "Afei kasa." (afei = now: LearnAkanDictionary + Wiktionary; kasa =
// speak: Christaller + LearnAkanDictionary). Both read back by Khaya ASR at 0%
// error. "Saved" has no well-sourced Twi, so in Twi it is the chime only.
const TW_READY = new Set(['in', 'owe', 'pay', 'out', 'talk']);
function hasTwClip(k) { return bkTwiSpeaker() && TW_READY.has(k) && !!TW_CLIPS[k]; }
// Plays the Twi recording when the voice is Twi and one exists, else speaks
// the English line. Resolves when finished, like say().
function sayVoice(clipKey, text) {
  if (!hasTwClip(clipKey)) return say(text);
  return new Promise(resolve => {
    try {
      stopSpeaking();
      const a = new Audio(TW_CLIPS[clipKey]);
      a.onended = () => resolve();
      a.onerror = () => { say(text).then(resolve, resolve); };
      a.play().catch(() => { say(text).then(resolve, resolve); });
    } catch (e) { say(text).then(resolve, resolve); }
  });
}
const BK_ICON = {
  in: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><path d="M5 12h14"/></svg>',
  owe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>',
  iowe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="8" r="3.6"/><path d="M3 20a7 7 0 0 1 14 0"/><path d="M16 10h6"/></svg>'
};
BK_ICON.pay = BK_ICON.in;
let bkToday = todayKey(Date.now()), bkViewDay = bkToday;
let bkEntries = [];
let bkKind = 'in', bkTyped = '', bkDebt = null, bkPrefilled = false, bkBusy = false, bkCur, bkRow = null, bkUndo = null, bkNewId = null;
function bk$(id) { return document.getElementById(id); }
function bookResetDay() { bkToday = todayKey(Date.now()); bkViewDay = bkToday; }
function bkShiftDay(key, n) { const p = key.split('-'); return todayKey(new Date(+p[0], +p[1] - 1, +p[2], 12).getTime() + n * BK_DAY); }
function bkDateOf(key) { const p = key.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
function bkDayLabel(key) {
  if (key === bkToday) return t('Today', 'Hoy');
  if (key === bkShiftDay(bkToday, -1)) return t('Yesterday', 'Ayer');
  return bkDateOf(key).toLocaleDateString(BK_LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
}
// Venezuela's bolivar lines are shown but kept out of the dollar totals.
function bkHome(e) { return !ES || e.cur !== 'VES'; }
function bkMoney(n, cur) {
  if (ES) return fmt(n, cur);
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return BK_CED + v.toLocaleString('en-GH', { maximumFractionDigits: 2 });
}
function bkLeftOn(e) { return Math.max(0, Math.round(((Number(e.amount) || 0) - (Number(e.paid) || 0)) * 100) / 100); }
// The handwriting face has no cedi sign, so the symbol is set in Manrope.
function bkAmtEl(n, cur) {
  const s = bkMoney(n, cur), m = s.match(/^([^0-9]*)(.*)$/);
  const amt = document.createElement('span'); amt.className = 'bk-amt';
  const cs = document.createElement('span'); cs.className = 'bk-cs'; cs.textContent = m ? m[1].trim() : '';
  amt.appendChild(cs); amt.appendChild(document.createTextNode(m ? m[2] : s));
  return amt;
}

function bookRender(entries) {
  bkEntries = entries;
  const now = todayKey(Date.now());
  if (now !== bkToday) { if (bkViewDay === bkToday) bkViewDay = now; bkToday = now; }
  if (bkViewDay > bkToday) bkViewDay = bkToday;
  const rows = [];
  entries.forEach(e => {
    if (e.day === bkViewDay && FIELD_CONFIG[e.type] && e.type !== 'payment') rows.push({ e, ts: e.ts });
    // A payment is money in on the day it was paid, whichever day the debt
    // was written - the same rule as the Money in tile.
    if (e.type === 'debt_in' && Array.isArray(e.payments)) {
      e.payments.forEach((p, i) => { if (p && Number(p.amount) > 0 && todayKey(p.ts) === bkViewDay) rows.push({ e, pay: p, i, ts: p.ts }); });
    }
  });
  rows.sort((a, b) => a.ts - b.ts);
  let inSum = 0, outSum = 0, bsIn = 0, bsOut = 0;
  rows.forEach(r => {
    const home = bkHome(r.e);
    const n = r.pay ? (Number(r.pay.amount) || 0) : (Number(r.e.amount) || 0);
    if (r.pay || r.e.type === 'sale') { if (home) inSum += n; else bsIn += n; }
    else if (r.e.type === 'expense') { if (home) outSum += n; else bsOut += n; }
  });
  const owed = entries.filter(e => e.type === 'debt_in' && bkHome(e)).reduce((s, e) => s + bkLeftOn(e), 0);
  bk$('bkIn').textContent = bkMoney(inSum);
  bk$('bkOut').textContent = bkMoney(outSum);
  const leftNow = Math.round((inSum - outSum) * 100) / 100;
  bk$('bkLeft').textContent = (leftNow < 0 ? BK_MINUS : '') + bkMoney(Math.abs(leftNow));
  bk$('bkOwe').textContent = bkMoney(owed);
  // 25 Sep: a person icon with 0 and a row of + - = mean nothing to someone
  // who does not read symbols. They appear once there is something to show.
  bk$('bkOweBtn').hidden = !entries.some(e => e.type === 'debt_in' && bkHome(e));
  { const sums = document.querySelector('.bk-sums'); if (sums) sums.hidden = !rows.length; }
  const bs = bk$('bkBs');
  bs.hidden = !(bsIn || bsOut);
  if (!bs.hidden) bs.textContent = 'Bs: ' + [bsIn ? '+' + fmt(bsIn, 'VES').replace('Bs. ', '') : '', bsOut ? BK_MINUS + fmt(bsOut, 'VES').replace('Bs. ', '') : ''].filter(Boolean).join('  ');
  bk$('bkDate').textContent = bkDayLabel(bkViewDay);
  bk$('bkNext').disabled = bkViewDay === bkToday;
  const ol = bk$('bkLines');
  ol.textContent = '';
  rows.forEach(r => ol.appendChild(bkLineEl(r)));
  // The old typed buttons (I owe a supplier, photo of a receipt) stay one
  // small link away, once there is a book to add to.
  const more = document.getElementById('typeToggle');
  if (more && !more.dataset.bk) { more.dataset.bk = '1'; more.textContent = t('More: I owe a supplier', 'M\u00e1s: le debo al proveedor'); }
  if (more && document.getElementById('typeChoices').hidden) more.hidden = !entries.length;
  // An empty first page shows one faint example line: what a line looks like.
  bkDemo(!entries.length && bkViewDay === bkToday);
  if (!entries.length && bkViewDay === bkToday) {
    const ex = !ES ? { amount: 60, item: '3 waakye' } : CO ? { amount: 50000, item: '5 camisas' } : { amount: 6, item: '3 refrescos' };
    ol.appendChild(bkLineEl({ e: { id: 'ghost', type: 'sale', amount: ex.amount, item: ex.item }, ghost: true }));
    bkDemoSync();
  }
  if (bkNewId) {
    const fresh = ol.querySelector('[data-bk="' + bkNewId + '"]');
    if (fresh) { fresh.classList.add('new'); ol.scrollTop = ol.scrollHeight; }
    bkNewId = null;
  }
}

// 25 Sep: on the empty first page a finger taps the real Sold button and the
// example line writes itself into the book, on a 6-second loop - showing
// what to do without a word to read. Stops for good at her first touch,
// after 5 loops, or at once for people who asked their phone for less motion.
let bkDemoTimer = null;
function bkDemo(on) {
  const root = document.documentElement;
  let off = false;
  try { off = sessionStorage.getItem('kym_demo_off') === '1' || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { /* optional */ }
  if (!on || off) { root.classList.remove('demo-on'); clearTimeout(bkDemoTimer); return; }
  if (root.classList.contains('demo-on')) { bkDemoSync(); return; }
  root.classList.add('demo-on');
  bkDemoT0 = null;
  bkDemoSync();
  track('demo_shown');
  clearTimeout(bkDemoTimer);
  bkDemoTimer = setTimeout(() => root.classList.remove('demo-on'), 30000);
}
// The example line is rebuilt on every render, which restarted its animation
// and put the writing BEFORE the finger's tap (measured 25 Sep). All three
// parts share one start time, so the tap always comes first.
let bkDemoT0 = null;
function bkDemoSync() {
  requestAnimationFrame(() => {
    try {
      if (!document.getAnimations || !document.timeline) return;
      const mine = document.getAnimations().filter(a => /^bk(Hand|Press|Write)$/.test(a.animationName || ''));
      if (!mine.length) return;
      if (bkDemoT0 == null) bkDemoT0 = document.timeline.currentTime;
      mine.forEach(a => { a.startTime = bkDemoT0; });
    } catch (e) { /* animation sync is cosmetic */ }
  });
}
// "How it works" (25 Sep): seen = scrolled into view; the button opens the
// real Sold sheet, so the first try is one tap from where they were reading.
(function wireHow() {
  const how = document.getElementById('howItWorks'); if (!how) return;
  document.getElementById('howTry').addEventListener('click', () => { track('how_try'); ping('how_try'); try { bkOpen('in'); } catch (e) { document.getElementById('bkSold').click(); } });
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting) && !how.hidden) { track('how_seen'); ping('how_seen'); io.disconnect(); } }, { threshold: 0.4 });
    io.observe(how);
  }
})();
function bkDemoStop() {
  if (!document.documentElement.classList.contains('demo-on')) return;
  document.documentElement.classList.remove('demo-on');
  clearTimeout(bkDemoTimer);
  try { sessionStorage.setItem('kym_demo_off', '1'); } catch (e) { /* optional */ }
}
['pointerdown', 'touchstart', 'keydown'].forEach(ev => document.addEventListener(ev, bkDemoStop, { passive: true, capture: true }));

function bkLineEl(r) {
  const e = r.e;
  const li = document.createElement('li');
  const row = document.createElement('div');
  let kind = 'in', text = '', settled = false, owing = 0;
  if (r.pay) { text = t(`${e.item} paid`, `${e.item} pag\u00f3`); }
  else if (e.type === 'sale') { const q = Number(e.qty) || 0; text = e.item === BK_PLAIN_ITEM.in ? '' : (q > 1 ? `${q} ${e.item}` : String(e.item || '')); }
  else if (e.type === 'expense') { kind = 'out'; text = e.item === BK_PLAIN_ITEM.out ? '' : String(e.item || ''); }
  else if (e.type === 'debt_in') { kind = 'owe'; text = String(e.item || ''); owing = bkLeftOn(e); settled = owing <= 0; }
  else if (e.type === 'debt_out') { kind = 'iowe'; text = t(`I owe ${e.item}`, `Le debo a ${e.item}`); settled = bkLeftOn(e) <= 0; }
  row.className = 'bk-ln ' + kind + (settled ? ' settled' : '') + (r.ghost ? ' ghost' : '');
  row.dataset.bk = r.pay ? e.id + ':' + r.i : e.id;
  const mk = document.createElement('span'); mk.className = 'bk-mk';
  if (kind === 'owe' || kind === 'iowe') mk.innerHTML = BK_ICON[kind];
  else mk.textContent = kind === 'in' ? '+' : BK_MINUS;
  row.appendChild(mk);
  row.appendChild(bkAmtEl(r.pay ? r.pay.amount : e.amount, e.cur));
  const txt = document.createElement('span'); txt.className = 'bk-txt'; txt.textContent = text;
  row.appendChild(txt);
  if (r.ghost) {
    const tag = document.createElement('span'); tag.className = 'bk-tag'; tag.textContent = t('example', 'ejemplo');
    row.appendChild(tag);
  } else if (kind === 'owe') {
    if (settled) { const tag = document.createElement('span'); tag.className = 'bk-tag'; tag.textContent = t('paid', 'pag\u00f3'); row.appendChild(tag); }
    else {
      if (owing < (Number(e.amount) || 0)) { const lf = document.createElement('span'); lf.className = 'bk-left'; lf.textContent = t(`${bkMoney(owing, e.cur)} left`, `falta ${bkMoney(owing, e.cur)}`); row.appendChild(lf); }
      const pb = document.createElement('button'); pb.type = 'button'; pb.className = 'bk-pay'; pb.textContent = t('Paid', 'Pag\u00f3');
      pb.addEventListener('click', ev => { ev.stopPropagation(); bkOpen('pay', e); });
      row.appendChild(pb);
    }
  }
  if (!r.ghost) {
    row.setAttribute('role', 'button'); row.tabIndex = 0;
    row.addEventListener('click', () => bkOpenLine(r));
    row.addEventListener('keydown', ev => { if (ev.key === 'Enter') bkOpenLine(r); });
  }
  li.appendChild(row);
  return li;
}

// ---- the keypad sheet: Sold / Spent / Owes me / somebody paid -------------
function bkAmount() { const n = parseFloat(bkTyped); return isFinite(n) ? n : 0; }
function bkReady() { return bkAmount() > 0 && (bkKind !== 'owe' || bk$('bkWho').value.trim().length > 0); }
function bkGroup(s) {
  const dot = s.indexOf('.'), whole = dot === -1 ? s : s.slice(0, dot), rest = dot === -1 ? '' : s.slice(dot);
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ES ? '.' : ',') + (ES ? rest.replace('.', ',') : rest);
}
function bkRefresh() {
  bk$('bkAmt').textContent = bkTyped ? bkGroup(bkTyped) : '0';
  bk$('bkCurSym').textContent = !ES ? BK_CED : (bkCur === 'VES' ? 'Bs' : '$');
  bk$('bkWrite').classList.toggle('dim', !bkReady());
}
function bkPress(v) {
  // A pre-filled "what is left" is replaced by the first key, like a
  // calculator, so a part payment is just typing the part.
  if (bkPrefilled) { bkPrefilled = false; bkTyped = ''; if (v === 'del') { bkTick(8); bkRefresh(); return; } }
  const maxWhole = CO ? 9 : 7;
  if (v === 'del') bkTyped = bkTyped.slice(0, -1);
  else if (v === '.') { if (bkTyped.indexOf('.') === -1) bkTyped = (bkTyped || '0') + '.'; }
  else if (v === '000') { const w = bkTyped.replace(/^0+/, ''); if (w && w.indexOf('.') === -1 && w.length + 3 <= maxWhole) bkTyped = w + '000'; }
  else {
    const dot = bkTyped.indexOf('.');
    if (dot !== -1 && bkTyped.length - dot > 2) return;
    if (dot === -1 && bkTyped.replace(/^0+/, '').length >= maxWhole) return;
    bkTyped = (bkTyped === '0' ? '' : bkTyped) + v;
  }
  bkTick(8); bkRefresh();
}
function bkShake(el) { el.classList.remove('bk-shake'); void el.offsetWidth; el.classList.add('bk-shake'); bkTick(40); }
function bkSavedCur() { try { return localStorage.getItem('kym_bk_cur') === 'VES' ? 'VES' : 'USD'; } catch (e) { return 'USD'; } }
let bkTargetDay = null;
function bkOpen(kind, debt) {
  bookHideToast(); bkCloseSheets();
  bkTargetDay = bkViewDay;
  bkKind = kind; bkDebt = debt || null; bkTyped = ''; bkPrefilled = false;
  bkCur = !ES ? undefined : debt ? (debt.cur || HOME_CUR) : (CO ? 'COP' : bkSavedCur());
  if (kind === 'pay') { bkTyped = String(bkLeftOn(debt)); bkPrefilled = true; }
  const sh = bk$('bkEntry');
  sh.className = 'bk-sheet bk-k-' + kind;
  bk$('bkIco').innerHTML = BK_ICON[kind];
  bk$('bkTitle').textContent = kind === 'pay' ? t(`${debt.item} paid`, `${debt.item} pag\u00f3`) : BK_LABEL[kind];
  bk$('bkShDay').textContent = (kind === 'pay' || bkViewDay === bkToday) ? '' : bkDayLabel(bkViewDay);
  bk$('bkWhoBox').hidden = kind !== 'owe'; bk$('bkWho').value = '';
  bk$('bkNote').value = ''; bk$('bkNote').hidden = true;
  bk$('bkExtras').hidden = kind === 'pay'; bk$('bkWordsBtn').hidden = false;
  // Venezuela: dollars or bolivars, remembered; a debt keeps its own currency.
  const curs = bk$('bkCurs'); curs.textContent = '';
  curs.hidden = !(ES && !CO && kind !== 'pay');
  if (!curs.hidden) [['USD', '$'], ['VES', 'Bs']].forEach(([c, lbl]) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'bk-chip' + (bkCur === c ? ' on' : ''); b.textContent = lbl;
    b.addEventListener('click', () => { bkCur = c; try { localStorage.setItem('kym_bk_cur', c); } catch (e) { /* optional */ } curs.querySelectorAll('.bk-chip').forEach(x => x.classList.toggle('on', x === b)); bkRefresh(); });
    curs.appendChild(b);
  });
  const cats = bk$('bkCats'); cats.textContent = '';
  if (kind === 'out') BK_CATS.forEach(c => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'bk-chip'; b.textContent = c[0] + ' ' + c[1];
    b.dataset.item = c[1]; b.dataset.kind = c[2];
    b.addEventListener('click', () => { const on = !b.classList.contains('on'); cats.querySelectorAll('.bk-chip').forEach(x => x.classList.remove('on')); if (on) b.classList.add('on'); });
    cats.appendChild(b);
  });
  // Names she already wrote, newest first, one tap each.
  const names = {};
  bkEntries.forEach(e => { if (e.type === 'debt_in' && e.item && !names[nameKey(e.item)]) names[nameKey(e.item)] = { n: e.item, ts: e.ts }; });
  const wc = bk$('bkWhoChips'); wc.textContent = '';
  Object.values(names).sort((a, b) => b.ts - a.ts).slice(0, 6).forEach(x => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'bk-chip'; b.textContent = x.n;
    b.addEventListener('click', () => { bk$('bkWho').value = x.n; bk$('bkWho').blur(); bkRefresh(); });
    wc.appendChild(b);
  });
  bk$('bkScrim').hidden = false; sh.hidden = false; sh.scrollTop = 0;
  bkRefresh();
  ping('tap');
  track('book_open', { kind });
  bkPrompt(kind);
}
// The question, out loud, the first three times each button is used - the
// voice-on-every-screen half of the evidence. Then it stays quiet.
function bkPrompt(kind) {
  try {
    const twi = hasTwClip(kind);
    const k = 'kym_bk_said_' + (twi ? 'tw_' : '') + kind, n = parseInt(localStorage.getItem(k), 10) || 0;
    if (n >= 3) return;
    localStorage.setItem(k, String(n + 1));
    const q = {
      in: t('How much did you sell?', '\u00bfCu\u00e1nto vendiste?'),
      out: t('How much did you spend?', '\u00bfCu\u00e1nto gastaste?'),
      owe: t('Who owes you? How much?', tc('\u00bfQui\u00e9n te qued\u00f3 debiendo? \u00bfCu\u00e1nto?', '\u00bfA qui\u00e9n le fiaste? \u00bfCu\u00e1nto?')),
      pay: t('How much did they pay?', '\u00bfCu\u00e1nto pag\u00f3?')
    }[kind];
    if (twi) { stopSpeaking(); new Audio(BOOK_CLIPS[kind]).play().catch(() => speakShort(q)); return; }
    speakShort(q);
  } catch (e) { /* speech is a bonus */ }
}
function bkCloseSheets() {
  ['bkEntry', 'bkLineSheet', 'bkDebtSheet'].forEach(id => { bk$(id).hidden = true; });
  bk$('bkScrim').hidden = true;
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
async function bkWrite() {
  if (bkBusy) return;
  if (!(bkAmount() > 0)) { bkShake(bk$('bkDisp')); return; }
  const who = bk$('bkWho').value.trim();
  if (bkKind === 'owe' && !who) { bkShake(bk$('bkWhoBox')); bk$('bkWho').focus(); return; }
  bkBusy = true;
  const n = Math.round(bkAmount() * 100) / 100, ts = Date.now(), nowDay = todayKey(ts);
  let record = null, undo = null, msg = t('Written', 'Anotado');
  try {
    if (bkKind === 'pay') {
      // Always the fresh row: a second phone tab or a voice payment may have
      // changed it since the page was drawn.
      const debt = (await getAllEntries()).find(x => x.id === bkDebt.id);
      if (!debt) throw new Error('gone');
      const open = bkLeftOn(debt), pay = Math.min(n, open), extra = Math.round((n - pay) * 100) / 100;
      const before = { paid: Number(debt.paid) || 0, payments: Array.isArray(debt.payments) ? debt.payments.slice() : [] };
      if (pay > 0) await updateEntry(debt.id, { paid: before.paid + pay, payments: before.payments.concat([{ amount: pay, ts, source: 'book' }]) });
      let extraRec = null;
      if (extra > 0) {
        // Paid more than was owed: the extra is money in, like the voice path.
        extraRec = { id: newId(), type: 'sale', item: t(`extra from ${debt.item}`, `extra de ${debt.item}`), note: '', qty: 1, price: extra, kind: '', method: 'cash', paid: 0, amount: extra, source: 'book', day: nowDay, ts };
        if (debt.cur) extraRec.cur = debt.cur;
        // If the extra cannot be saved, put the debt back, so a second tap
        // on Write it starts clean instead of counting the money twice.
        try { await addEntry(extraRec); }
        catch (err) { if (pay > 0) { try { await updateEntry(debt.id, before); } catch (e2) { /* nothing more to do */ } } throw err; }
      }
      bkViewDay = nowDay;
      bkNewId = debt.id + ':' + before.payments.length;
      msg = t(`${debt.item} paid ${bkMoney(n, debt.cur)}`, `${debt.item} pag\u00f3 ${bkMoney(n, debt.cur)}`);
      undo = async () => { await updateEntry(debt.id, before); if (extraRec) await deleteEntry(extraRec.id); };
      track('debt_paid', { full: pay >= open, voice: false, via: 'book' });
      ping('save');
    } else {
      const day = bkTargetDay || bkViewDay;
      bkViewDay = day;
      const note = bk$('bkNote').value.trim().slice(0, 40);
      const cat = bkKind === 'out' ? bk$('bkCats').querySelector('.bk-chip.on') : null;
      const item = bkKind === 'owe' ? who.slice(0, 30) : (note || (cat ? cat.dataset.item : '') || BK_PLAIN_ITEM[bkKind]);
      record = { id: newId(), type: { in: 'sale', out: 'expense', owe: 'debt_in' }[bkKind], item, note: bkKind === 'owe' ? note : '', qty: bkKind === 'in' ? 1 : '', price: n, kind: cat ? cat.dataset.kind : '', method: bkKind === 'in' ? 'cash' : '', paid: 0, amount: n, source: 'book', day, ts };
      if (ES) record.cur = bkCur || HOME_CUR;
      await addEntry(record);
      const id = record.id;
      bkNewId = id;
      undo = async () => { await deleteEntry(id); };
      track('save_entry', { type: record.type, input_method: 'book' });
      ping('save');
    }
  } catch (err) {
    bkBusy = false;
    track('save_error', { where: 'book', reason: (err && err.name) || 'unknown' });
    bookToast(t('The phone could not save that. Tap Write it again.', 'El tel\u00e9fono no pudo guardarlo. Toca Anotar otra vez.'));
    return;
  }
  bkBusy = false;
  bkCloseSheets();
  try { await render(); } catch (e) { /* saved; the next render catches up */ }
  bkChime(); bkTick(25);
  if (!hasSpokenSaved()) { if (hasTwClip('saved')) sayVoice('saved', t('Saved.', 'Guardado.')); else if (!bkTwiSpeaker()) speakShort(t('Saved.', 'Guardado.')); }
  bookToast(msg, undo ? async () => { try { await undo(); } catch (e) { /* nothing more to undo */ } await render(); } : null);
  if (record) await afterEntrySaved(record);
}
// "Saved." out loud for the first three lines, then the chime is enough.
function hasSpokenSaved() {
  try { const n = parseInt(localStorage.getItem('kym_bk_said_saved'), 10) || 0; if (n >= 3) return true; localStorage.setItem('kym_bk_said_saved', String(n + 1)); return false; } catch (e) { return true; }
}

// ---- a line: paid / change / cross out, the way a real book does it --------
function bkOpenLine(r) {
  bookHideToast(); bkCloseSheets(); bkRow = r;
  const e = r.e;
  bk$('bkLineTitle').textContent = r.pay ? t(`${e.item} paid ${bkMoney(r.pay.amount, e.cur)}`, `${e.item} pag\u00f3 ${bkMoney(r.pay.amount, e.cur)}`)
    : ((e.type === 'debt_in' || e.type === 'debt_out') ? e.item + ' ' : '') + bkMoney(e.amount, e.cur);
  bk$('bkLinePaid').hidden = !(!r.pay && e.type === 'debt_in' && bkLeftOn(e) > 0);
  bk$('bkLineEdit').hidden = !!r.pay;
  // Crossing out a debt would take its payments (money in on other days)
  // with it. Once anything was paid on it, only Change is offered.
  bk$('bkLineCross').hidden = !r.pay && e.type === 'debt_in' && Array.isArray(e.payments) && e.payments.length > 0;
  bk$('bkScrim').hidden = false; bk$('bkLineSheet').hidden = false;
}
async function bkCrossOut() {
  const r = bkRow; if (!r) return;
  bkCloseSheets();
  try {
    if (r.pay) {
      // Crossing out a payment puts the debt back up by that amount.
      const debt = (await getAllEntries()).find(x => x.id === r.e.id);
      if (!debt) return;
      const before = { paid: Number(debt.paid) || 0, payments: Array.isArray(debt.payments) ? debt.payments.slice() : [] };
      const idx = before.payments.findIndex(p => p && p.ts === r.pay.ts && Number(p.amount) === Number(r.pay.amount));
      if (idx === -1) return;
      const payments = before.payments.slice(); payments.splice(idx, 1);
      await updateEntry(debt.id, { paid: Math.max(0, before.paid - (Number(r.pay.amount) || 0)), payments });
      track('book_cross', { what: 'payment' });
      await render();
      bookToast(t('Crossed out', 'Tachado'), async () => { await updateEntry(debt.id, before); await render(); });
    } else {
      const snap = Object.assign({}, r.e);
      await deleteEntry(snap.id);
      track('delete_entry', { type: snap.type, via: 'book' });
      await render();
      // Undo writes the very same line back (same id, so the server copy
      // simply comes back too).
      bookToast(t('Crossed out', 'Tachado'), async () => { await addEntry(snap); await render(); });
    }
  } catch (e) { bookToast(t('Could not change that. Try again.', 'No se pudo cambiar. Intenta otra vez.')); }
}

// ---- who owes me, every day -------------------------------------------------
function bkOpenDebts() {
  bookHideToast(); bkCloseSheets();
  const list = bk$('bkDebtList'); list.textContent = '';
  const debts = bkEntries.filter(e => e.type === 'debt_in' && bkLeftOn(e) > 0).sort((a, b) => a.ts - b.ts);
  if (!debts.length) { const p = document.createElement('p'); p.className = 'bk-empty'; p.textContent = t('Nobody owes you.', 'Nadie te debe.'); list.appendChild(p); }
  debts.forEach(e => {
    const row = document.createElement('div'); row.className = 'bk-debt';
    const nm = document.createElement('span'); nm.className = 'bk-nm'; nm.textContent = e.item;
    const am = document.createElement('span'); am.className = 'bk-am'; am.textContent = bkMoney(bkLeftOn(e), e.cur);
    const b = document.createElement('button'); b.type = 'button'; b.textContent = t('Paid', 'Pag\u00f3');
    b.addEventListener('click', () => bkOpen('pay', e));
    row.appendChild(nm); row.appendChild(am); row.appendChild(b); list.appendChild(row);
  });
  bk$('bkScrim').hidden = false; bk$('bkDebtSheet').hidden = false;
  track('book_debts', { n: debts.length });
}

// ---- toast with undo, a chime and a buzz so a non-reader knows it worked ---
let bkToastTimer = null;
function bookToast(msg, undoFn) {
  if (!BOOK_ON) return;
  bk$('bkToastMsg').textContent = msg;
  bk$('bkToastUndo').hidden = !undoFn;
  bkUndo = undoFn || null;
  bk$('bkToast').hidden = false;
  clearTimeout(bkToastTimer); bkToastTimer = setTimeout(bookHideToast, 8000);
}
function bookHideToast() { if (!BOOK_ON) return; bk$('bkToast').hidden = true; bkUndo = null; }
let bkActx = null;
function bkChime() {
  try {
    bkActx = bkActx || new (window.AudioContext || window.webkitAudioContext)();
    if (bkActx.state === 'suspended') bkActx.resume();
    [660, 990].forEach((f, i) => {
      const o = bkActx.createOscillator(), g = bkActx.createGain(), at = bkActx.currentTime + i * 0.09;
      o.type = 'sine'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.12, at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
      o.connect(g); g.connect(bkActx.destination); o.start(at); o.stop(at + 0.2);
    });
  } catch (e) { /* sound is a bonus */ }
}
function bkTick(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* optional */ } }
// When voice fails, or Talk cannot work here: point at the tap buttons.
function bookNudgeTiles() {
  if (!BOOK_ON) return;
  const bar = bk$('bkBar'); if (!bar) return;
  bar.scrollIntoView({ behavior: 'smooth', block: 'center' });
  ['bkSold', 'bkSpent', 'bkOwes'].forEach(id => { const b = bk$(id); b.classList.remove('bk-nudge'); void b.offsetWidth; b.classList.add('bk-nudge'); });
}

(function bookSetup() {
  if (!BOOK_ON) return;
  try {
    document.body.classList.add('book-on');
    bk$('book').hidden = false;
    // Talk has its own full-width row under the three tap buttons: the real mic,
    // with every listener it already has, moved there.
    const mic = document.getElementById('homeMicBtn');
    if (mic) { bk$('bkTalkRow').appendChild(mic); mic.classList.remove('first-use'); }
    bk$('bkSoldLbl').textContent = BK_LABEL.in;
    bk$('bkSpentLbl').textContent = BK_LABEL.out;
    bk$('bkOwesLbl').textContent = BK_LABEL.owe;
    bk$('bkWriteLbl').textContent = t('Write it', 'Anotar');
    bk$('bkWordsBtn').textContent = t('+ words', '+ palabras');
    bk$('bkWho').placeholder = t('Who?', '\u00bfQui\u00e9n?');
    bk$('bkNote').placeholder = t('What was it?', '\u00bfQu\u00e9 fue?');
    bk$('bkLinePaid').textContent = t('Paid', 'Pag\u00f3');
    bk$('bkLineEdit').textContent = t('Change', 'Cambiar');
    bk$('bkLineCross').textContent = t('Cross it out', 'Tacharlo');
    bk$('bkDebtTitle').textContent = t('Who owes me', tc('Qui\u00e9n me debe (fiao)', 'Qui\u00e9n me debe (fiado)'));
    bk$('bkToastUndo').textContent = t('Undo', 'Deshacer');
    bk$('bkClose').setAttribute('aria-label', t('Close', 'Cerrar'));
    bk$('bkLineClose').setAttribute('aria-label', t('Close', 'Cerrar'));
    bk$('bkDebtClose').setAttribute('aria-label', t('Close', 'Cerrar'));
    bk$('bkWho').setAttribute('aria-label', t('Who owes you', 'Qui\u00e9n te debe'));
    bk$('bkNote').setAttribute('aria-label', t('What was it', 'Qu\u00e9 fue'));
    bk$('bkOweBtn').setAttribute('aria-label', t('Who owes me', 'Qui\u00e9n me debe'));
    bk$('bkPrev').setAttribute('aria-label', t('Day before', 'D\u00eda anterior'));
    bk$('bkNext').setAttribute('aria-label', t('Next day', 'D\u00eda siguiente'));
    const keys = bk$('bkKeys');
    // Colombia counts in thousands of pesos: a 000 key instead of a point.
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', CO ? '000' : '.', '0', 'del'].forEach(v => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'bk-key';
      if (v === '.' && ES) b.textContent = ',';
      else if (v === 'del') b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11v12H9l-6-6z"/><path d="M13 10l4 4M17 10l-4 4"/></svg>';
      else b.textContent = v;
      b.setAttribute('aria-label', v === 'del' ? t('Delete', 'Borrar') : (v === '.' && ES) ? ',' : v);
      b.addEventListener('click', () => bkPress(v));
      keys.appendChild(b);
    });
    bk$('bkSold').addEventListener('click', () => bkOpen('in'));
    bk$('bkSpent').addEventListener('click', () => bkOpen('out'));
    bk$('bkOwes').addEventListener('click', () => bkOpen('owe'));
    bk$('bkWrite').addEventListener('click', bkWrite);
    bk$('bkWho').addEventListener('input', bkRefresh);
    bk$('bkWho').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); bk$('bkWho').blur(); } });
    bk$('bkNote').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); bk$('bkNote').blur(); } });
    bk$('bkWordsBtn').addEventListener('click', () => { bk$('bkNote').hidden = false; bk$('bkWordsBtn').hidden = true; bk$('bkNote').focus(); });
    bk$('bkClose').addEventListener('click', bkCloseSheets);
    bk$('bkLineClose').addEventListener('click', bkCloseSheets);
    bk$('bkDebtClose').addEventListener('click', bkCloseSheets);
    bk$('bkScrim').addEventListener('click', bkCloseSheets);
    bk$('bkLinePaid').addEventListener('click', () => { if (bkRow) bkOpen('pay', bkRow.e); });
    bk$('bkLineEdit').addEventListener('click', () => { const r = bkRow; bkCloseSheets(); if (r) openSheet(r.e.type, r.e); });
    bk$('bkLineCross').addEventListener('click', bkCrossOut);
    bk$('bkOweBtn').addEventListener('click', bkOpenDebts);
    bk$('bkToastUndo').addEventListener('click', () => { const u = bkUndo; bookHideToast(); if (u) u(); });
    bk$('bkPrev').addEventListener('click', () => { bookHideToast(); bkViewDay = bkShiftDay(bkViewDay, -1); bookRender(bkEntries); });
    bk$('bkNext').addEventListener('click', () => { bookHideToast(); if (bkViewDay < bkToday) { bkViewDay = bkShiftDay(bkViewDay, 1); bookRender(bkEntries); } });
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !bk$('bkScrim').hidden) bkCloseSheets(); });
    if (window.clarity && !window.KYM_IS_OWNER_DEVICE) window.clarity('set', 'home', 'book');
    if (window.gtag) window.gtag('set', 'user_properties', { home: 'book' });
  } catch (e) { track('book_error', { where: 'setup', reason: (e && e.name) || 'unknown' }); }
})();

// The Today design has no tap buttons on its first screen, so its line keeps
// the wording it was measured with (v168), not the Book's "Tap or talk".
if (!BOOK_ON) {
  const sub = document.querySelector('#whatIs .what-is-sub');
  if (sub) sub.textContent = t('You talk. It writes down what you sell, what you spend, and who owes you.', 'Tú hablas. CountMy anota lo que vendes, lo que gastas y quién te debe.');
}

if (inAppBrowser()) {
  try {
    ping('iab'); track('iab_open');
    if (window.KYM_IAB_STAY) ping('iab_stay');
    // The first thing on the screen inside Facebook's / WhatsApp's browser:
    // one big button that opens Chrome (or Safari). Tapped, not automatic -
    // see the note in index.html. Everything else stays usable below it.
    const top = document.createElement('div');
    top.className = 'iab-top'; top.id = 'iabTop';
    const android = isAndroid();
    const iosApp = window.KYM_IOS_APP || 'other';
    let bookHere = false;
    if (android && BOOK_ON) {
      // The Book (24 Sep): Sold, Spent and Owes me need no microphone, so
      // the page works right here in Facebook's browser - no card, no
      // typing box, no wall. Only Talk and Ask need Chrome. Once she has
      // lines in this browser's book, Talk does NOT jump to Chrome: Chrome
      // keeps a separate, empty book (the red team's reason the automatic
      // jump was pulled), so she is pointed at the tap buttons instead.
      bookHere = true;
      BK_IAB_TALK = true;
      const toChrome = (ev) => {
        ev.preventDefault(); ev.stopImmediatePropagation();
        if (hasAnyRecord) {
          bookToast(t('Talking needs Chrome. Here, tap Sold, Spent or Owes me.', tc('Para hablar hace falta Chrome. Aqu\u00ed, toca Vend\u00ed, Gast\u00e9 o Fiao.', 'Para hablar hace falta Chrome. Aqu\u00ed, toca Vend\u00ed, Gast\u00e9 o Fiado.')));
          bookNudgeTiles();
          track('iab_talk_blocked');
          return;
        }
        ping('iab_tap'); track('iab_tap', { via: 'book_talk' });
        location.href = withBookKey(window.KYM_CHROME_URL || chromeIntentUrl());
      };
      ['homeMicBtn', 'askBtn'].forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('click', toChrome, true); });
    } else if (android) {
      // No automatic jump to Chrome here, on purpose - tried on 18 Sep and a
      // real Facebook visitor got a blank page for nine minutes (see the
      // note in index.html). Re-tried 24 Sep and pulled before shipping by
      // red team for the same reason. The one-tap button below is the
      // fastest exit Facebook actually honours.
      // Facebook's Android browser has no microphone permission at all
      // (Meta developer thread, 2024-25): the tap is unavoidable, so it is
      // the whole first screen. Fallback link for phones without Chrome.
      // 19 Sep, from the week's numbers: 88 of 122 opens were inside this
      // browser and 3 of the 88 pressed the Chrome button. The wall is the
      // button. So the first screen here is a typing box that works where
      // the person already is; Chrome is the second offer, not the gate.
      top.innerHTML = `<p class="iab-what">${t('A free notebook for your business.', 'Un cuaderno gratis para tu negocio.')}</p>`
        + `<p>${t('Type what you sold or spent. It keeps the record.', 'Escribe lo que vendiste o gastaste. CountMy guarda la cuenta.')}</p>`
        + `<form class="iab-type" id="iabTypeForm" autocomplete="off"><input id="iabTypeIn" type="text" inputmode="text" enterkeyhint="done" placeholder="${t('Sold 3 bowls of waakye, 60 cedis', tc('Vend\u00ed 3 arepas a 2 d\u00f3lares', 'Vend\u00ed 5 camisas de a 10 mil'))}" aria-label="${t('What happened?', '\u00bfQu\u00e9 pas\u00f3?')}"><button type="submit" class="iab-save">${t('Save', 'Guardar')}</button></form>`
        + `<button type="button" class="iab-example" id="iabExample">${t('Try the example', 'Probar el ejemplo')}</button>`
        + `<p class="iab-sub">${t('Free. No sign-up. No loan.', 'Gratis. No te pide clave ni PIN.')}</p>`
        + `<p class="iab-or">${t('Want to talk instead?', '\u00bfPrefieres hablar?')}</p>`
        + `<a class="iab-open iab-open-small" id="iabTopBtn" href="${withBookKey(window.KYM_CHROME_URL || chromeIntentUrl())}"><svg class="chrome-ball" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="22" fill="#fff"/><path d="M24 2a22 22 0 0 1 19.05 11H24a11 11 0 0 0-9.53 5.5L7.2 6.3A21.94 21.94 0 0 1 24 2z" fill="#EA4335"/><path d="M43.05 13A22 22 0 0 1 24 46l7.4-12.83A11 11 0 0 0 33.5 13z" fill="#FBBC04"/><path d="M14.47 18.5A11 11 0 0 0 24 35l-7.4 12.82A22 22 0 0 1 7.2 6.3z" fill="#34A853"/><circle cx="24" cy="24" r="8.5" fill="#4285F4"/></svg><span>${t('Open in Chrome', 'Abrir en Chrome')}</span></a>`
        + `<a class="iab-alt" id="iabAltBtn" href="${withBookKey(window.KYM_ANYBROWSER_URL || '#')}">${t('No Chrome? Open in another browser', '\u00bfSin Chrome? Abrir en otro navegador')}</a>`;
      document.body.classList.add('iab-first');
      // every other tap on this screen also goes to Chrome - the mic cannot work here
      const go = (ev) => { ev.preventDefault(); ping('iab_tap'); track('iab_tap', { via: 'other' }); location.href = withBookKey(window.KYM_CHROME_URL || chromeIntentUrl()); };
      ['homeMicBtn', 'askBtn', 'seeBtn'].forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('click', go, true); });
      document.querySelectorAll('.ts-tile').forEach(el => el.addEventListener('click', go, true));
    } else if (iosApp === 'instagram') {
      top.innerHTML = `<p>${t('Tap once to open CountMy in Safari \u2014 your voice works best there.', 'Toca una vez para abrir CountMy en Safari: ah\u00ed la voz funciona mejor.')}</p>`
        + `<a class="iab-open" id="iabTopBtn" href="${withBookKey(window.KYM_IG_URL || '#')}">${t('Open in Safari', 'Abrir en Safari')}</a>`
        + `<p class="iab-sub">${t('If nothing opens: tap <b>\u22ef</b> at the top right, then <b>Open in external browser</b>. ' + (BOOK_ON ? 'Or just tap Talk above \u2014 voice works here too.' : 'Or just tap the orange button below \u2014 voice works here too.'), 'Si no se abre: toca <b>\u22ef</b> arriba a la derecha y luego <b>Abrir en el navegador</b>. ' + (BOOK_ON ? 'O toca Habla arriba: aqu\u00ed tambi\u00e9n funciona la voz.' : 'O toca el bot\u00f3n naranja abajo: aqu\u00ed tambi\u00e9n funciona la voz.'))}</p>`;
    } else {
      // Facebook / Messenger on iPhone: no way out but the menu; the mic
      // does work here, so the page stays fully usable and says so.
      top.innerHTML = `<p>${t('Voice works here. For the best experience, tap <b>\u22ef</b> at the top right, then <b>Open in Safari</b>.', 'La voz funciona aqu\u00ed. Para lo mejor, toca <b>\u22ef</b> arriba a la derecha y luego <b>Abrir en Safari</b>.')}</p>`;
    }
    // Android's card carries its own identity line (the page's is hidden
    // under iab-first); elsewhere the page's own "what is it" line must
    // still be the first thing read, so the notice goes after it.
    if (BOOK_ON) {
      // In the Book the notice sits under the buttons, never above the page.
      const st = document.getElementById('homeMicStatus');
      if (!bookHere && st && st.parentNode) st.parentNode.insertBefore(top, st);
    } else {
      const first = (!android && document.getElementById('whatIs')) || document.querySelector('.pitch') || document.getElementById('homeGreeting');
      if (first && first.parentNode) first.parentNode.insertBefore(top, first.nextSibling);
    }
    const tb = document.getElementById('iabTopBtn'); if (tb) tb.addEventListener('click', () => { ping(android ? 'iab_tap' : 'iab_tap_ios'); track('iab_tap'); });
    // Typed record inside the in-app browser: the same server step the mic
    // uses (evidence-checked, auto-saved), minus the microphone.
    const tf = document.getElementById('iabTypeForm'); const ti = document.getElementById('iabTypeIn'); const tx = document.getElementById('iabExample');
    if (tf && ti) {
      const submitTyped = async () => {
        const v = String(ti.value || '').trim();
        if (!v) { ti.focus(); return; }
        if (voiceBusy) return;
        ping('iab_typed'); track('iab_typed', { len: v.length });
        pendingVoiceSource = 'typed';
        const st = document.getElementById('homeMicStatus'); if (st) st.scrollIntoView({ block: 'center', behavior: 'smooth' });
        await processVoiceBlob(null, 'homeMicStatus', 3000, 0, v);
        ti.value = '';
      };
      tf.addEventListener('submit', (ev) => { ev.preventDefault(); submitTyped(); });
      // 25 Sep: this used to SAVE the waakye example into her real book (and count
      // as a save in the home test). Now it only fills the box for her to change.
      if (tx) tx.addEventListener('click', () => { ti.value = ti.placeholder; ping('iab_example'); track('iab_example'); try { ti.focus(); ti.select(); } catch (e) { /* optional */ } });
    }
    const ab = document.getElementById('iabAltBtn'); if (ab) ab.addEventListener('click', () => { ping('iab_tap'); track('iab_tap_any'); });
  } catch (e) { /* never block */ }
}
// 3. Arrival in Chrome from Facebook: say so, and point at the one button.
try {
  if (new URLSearchParams(location.search).get('from') === 'iab' && !inAppBrowser()) {
    const st = document.getElementById('homeMicStatus');
    if (st) { st.textContent = t('You are in Chrome now. Press the orange button and talk.', 'Ya est\u00e1s en Chrome. Toca el bot\u00f3n naranja y habla.'); st.classList.add('heard'); }
    const mic = document.getElementById('homeMicBtn'); if (mic) { mic.classList.add('demo-pulse'); setTimeout(() => mic.classList.remove('demo-pulse'), 4000); }
  }
} catch (e) { /* optional */ }
// "Hear it": the example spoken, the only demonstration a non-reader can take in
(function hearExample() {
  const b = document.getElementById('hearExample'); if (!b) return;
  b.addEventListener('click', () => {
    track('example_play');
    const ex = (document.getElementById('tryExample') || {}).textContent || '';
    say(ex.replace(/[\u201c\u201d"]/g, ''));
  });
})();
try { if (new URLSearchParams(location.search).get('from') === 'iab' && !inAppBrowser()) { ping(isAndroid() ? 'iab_escaped' : 'iab_escaped_ios'); track('iab_escaped'); } } catch (e) { /* optional */ }
if (!micSupported()) {
  // No microphone API in this browser (older iOS, some in-app browsers).
  // Say so plainly and open the typed choices, so the page is still usable.
  document.getElementById('homeMicBtn').style.display = 'none';
  const orRow = document.querySelector('.or-row'); if (orRow) orRow.style.display = 'none';
  try {
    if (BOOK_ON) setMicStatus(t('Tap Sold, Spent or Owes me to write it.', tc('Toca Vend\u00ed, Gast\u00e9 o Fiao para anotarlo.', 'Toca Vend\u00ed, Gast\u00e9 o Fiado para anotarlo.')), null, 'homeMicStatus');
    else setMicStatus(t('This browser cannot use the microphone. You can type it instead, just below.', 'Este navegador no puede usar el micrófono. Puedes escribirlo abajo.'), 'err', 'homeMicStatus');
    const box = document.getElementById('typeChoices'); const tt = document.getElementById('typeToggle');
    if (!BOOK_ON) { if (box) box.hidden = false; if (tt) tt.hidden = true; }
    track('mic_unsupported');
  } catch (e) { /* never block the rest of the script */ }
}

// Photo entry, 2 Sep. One tap opens the camera; the chosen photo is shrunk
// on the phone, sent to the Worker, and whatever it reads comes back as the
// same events voice produces - shown in the same review cards. Two things
// are deliberately different from the mic path: (1) nothing is auto-saved.
// Voice earns auto-save because the Worker evidence-checks every field
// against the actual transcript; a photo has no transcript, so a misread
// "50" for "500" or an invented line has no server-side catch - the owner's
// own eyes are the only check, so every card here needs a real Save tap.
// (2) Every failure says what happened, in words and out loud, right under
// the button that was tapped - a camera that opens and then nothing
// appears is the exact "button does nothing" report this app keeps getting.
let snapBusy = false;
async function handleSnap(file) {
  const btn = document.getElementById('snapBtn');
  const say = (msg, cls) => {
    setMicStatus(msg, cls, 'snapStatus');
    if (cls === 'err') speakShort(msg);
  };
  if (snapBusy) return;
  // Some Android builds fire 'change' with no file when the camera is
  // cancelled - that was a deliberate back-out, not an error to speak at.
  if (!file) return;
  if (!navigator.onLine) {
    track('photo_error', { reason: 'offline' });
    say('No connection \u2014 reading a photo needs internet. Please type it instead.', 'err');
    return;
  }
  snapBusy = true;
  btn.classList.add('busy');
  btn.disabled = true; // a second tap mid-read must not open the camera again
  try {
    say('Reading your photo\u2026');
    let blob;
    try {
      blob = await shrinkPhoto(file);
    } catch (err) {
      track('photo_error', { reason: 'decode_failed' });
      say('Couldn\u2019t open that photo. Please take a new one with the camera.', 'err');
      return;
    }
    const { text, events } = await extractFromImage(blob);
    track('photo_extract', { event_count: events.length, bytes: blob.size });
    if (events.length >= 1) {
      pendingVoiceSource = 'photo';
      pendingVoiceEvents = events;
      renderVoiceReview();
      closeSheet();
      setMicStatus('', null, 'snapStatus');
      setMicStatus(t('From your photo \u2014 check each one below, then tap Save.', 'De tu foto \u2014 revisa cada uno abajo, luego toca Guardar.'), 'heard', 'homeMicStatus');
      document.getElementById('voiceReview').scrollIntoView({ behavior: 'smooth', block: 'start' });
      speakPhotoReview(events);
    } else {
      const seen = text.trim() ? `I saw: \u201c${text.trim()}\u201d \u2014 but ` : '';
      say(`${seen}couldn\u2019t find any amounts in that photo. Please take it again in good light, close up, or tap Type it instead.`, 'err');
    }
  } catch (err) {
    track('photo_error', { reason: 'extract_failed' });
    say(err.message || 'Could not read that photo \u2014 please try again, or type it.', 'err');
  } finally {
    snapBusy = false;
    btn.classList.remove('busy');
    btn.disabled = false;
  }
}
const snapBtn = document.getElementById('snapBtn');
const snapInput = document.getElementById('snapInput');
if (snapBtn && snapInput) {
  snapBtn.addEventListener('click', () => {
    track('open_sheet', { type: 'snap' });
    // iOS only lets a page speak after a real tap has unlocked speech; the
    // error messages later come after an await, so unlock it here with an
    // empty utterance while we still have the gesture.
    if ('speechSynthesis' in window) { try { speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch (e) {} }
    snapInput.click();
  });
  snapInput.addEventListener('change', () => {
    const file = snapInput.files && snapInput.files[0];
    // Cleared right away so taking the exact same photo again still fires
    // 'change' - the second attempt after a bad read is the common case.
    snapInput.value = '';
    handleSnap(file);
  });
}

// Real feedback, 1 Sep: people needed the app explained in words before it
// made sense, and still read it as "for educated people." Explaining in
// text just adds more reading, which is the opposite of what a low-literacy
// user needs. So show, don't tell - speak one real example aloud and pulse
// the real mic button, so a first-time user watches/hears exactly what
// happens before trying it herself. Triggered only by a direct tap (not on
// page load) because iOS Safari refuses to play speechSynthesis without a
// user gesture unlocking it - real constraint, confirmed against Clarity's
// own session data showing MobileSafari as roughly half to three-quarters
// of real visits.
const demoBtn = document.getElementById('demoBtn');
if (demoBtn) {
  demoBtn.addEventListener('click', () => {
    track('demo_play');
    demoBtn.disabled = true;
    const micBtn = document.getElementById('homeMicBtn');
    micBtn.classList.add('demo-pulse');
    const stop = () => { micBtn.classList.remove('demo-pulse'); demoBtn.disabled = false; };
    say(t('Watch this button. Tap it, then say what happened. Like this. I sold two shirts, ten cedis each. Now you try.',
          tc('Mira este bot\u00f3n. T\u00f3calo y di qu\u00e9 pas\u00f3. As\u00ed: vend\u00ed dos camisas a diez d\u00f3lares cada una. Ahora te toca a ti.', 'Mira este bot\u00f3n. T\u00f3calo y di qu\u00e9 pas\u00f3. As\u00ed: vend\u00ed dos camisas de a diez mil. Ahora te toca a ti.')), { onend: stop }).catch(stop);
  });
}
document.getElementById('shopIdInput').addEventListener('change', async (e) => {
  setShopId(e.target.value);
  ping('open');
  await refreshPaidStatus();
  await render();
});
window.addEventListener('online', () => { updateOfflineBadge(); refreshPaidStatus(); });
window.addEventListener('offline', updateOfflineBadge);

// Real Clarity finding, 28 Aug: a real user repeatedly tapped this badge with
// zero response (it used to be pointer-events:none). Give the tap real
// meaning instead of removing it - re-check connectivity and say the result
// out loud in words, not just leave the same static line sitting there.
document.getElementById('offlineBadge').addEventListener('click', function () {
  if (navigator.onLine) {
    this.textContent = t('Back online now - your records are safe.', 'Ya tienes conexión - tus cuentas están a salvo.');
    setTimeout(updateOfflineBadge, 2500);
  } else {
    this.textContent = t('Still no connection - don\'t worry, everything you add is saved on your phone.', 'Todavía sin conexión - tranquilo, todo lo que anotas se guarda en tu teléfono.');
  }
});

// Real Clarity finding, 28 Aug: multiple real users tapped the Today numbers
// (Sales/Expenses/Customers owe me) expecting something to happen - dead
// clicks, zero response. In a money app, tapping a total to see what's
// behind it is the single most natural gesture there is. Rather than build a
// new filter UI (more surface area to learn, against the "less confusion"
// goal), reuse the exact pattern already proven for "Hear it": speak the
// number aloud (works for someone who can't read it) and jump straight to
// the real list of entries underneath, so the tap now does something real.
document.querySelectorAll('.today-row.tappable').forEach(row => {
  row.addEventListener('click', () => {
    const label = row.getAttribute('data-speak');
    const valueEl = row.querySelector('span[data-clarity-mask]');
    const value = valueEl ? valueEl.textContent : '';
    speakShort(`${label}: ${value}.`);
    const histEl = document.getElementById('history');
    histEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    histEl.classList.remove('history-flash');
    void histEl.offsetWidth; // restart the animation if it just played
    histEl.classList.add('history-flash');
  });
});
// Re-render whenever the tab comes back into view - the real bug this fixes:
// a shop owner who locks their phone at night with the app already open and
// reopens it the next morning (without a full app close) was seeing yesterday's
// "Today" totals frozen on screen, because render() only ever ran at load and
// after a save. Today's date, and everything derived from it, is now always
// recomputed the moment the app is looked at again.
document.addEventListener('visibilitychange', () => {
  // Never while a Book sheet is open: its header already says which day.
  if (document.visibilityState === 'visible') { if (BOOK_ON && bk$('bkScrim').hidden) bookResetDay(); render(); flushUnsynced(); }
});

// Real feedback, 30 Aug: the "Free. No signup." trust line under the mic is
// there for a first-time user who doesn't yet trust the app - a shop owner
// on their 20th visit doesn't need it repeated every single day. Counts
// visits (capped, never decrements) and hides the line after the first few -
// the line stays in the HTML either way, so nothing breaks if this count is
// ever reset or unavailable.
function bumpVisitCount() {
  try {
    const n = Math.min((Number(localStorage.getItem('kym_visits')) || 0) + 1, 999);
    localStorage.setItem('kym_visits', String(n));
    return n;
  } catch { return 1; }
}

// Listen (25 Sep): a spoken explanation, recorded once and shipped with the
// app, so it plays the same on every phone - no voice to install, no reading.
// Choosing Twi also turns on the Twi prompts on the Sold/Owes me/Paid sheets.
// Switched on once both clips are recorded and checked (Twi via Khaya ASR).
const LISTEN_READY = true;
let introAudio = null;
function playIntro(lang) {
  try {
    if (introAudio) { introAudio.pause(); introAudio = null; }
    stopSpeaking();
    try { localStorage.setItem('kym_voice', lang === 'tw' ? 'tw' : 'en'); } catch (e) { /* optional */ }
    markVoiceButtons();
    // The full explanation until she has a record; after that, a short
    // confirmation of the voice she picked.
    let src;
    if (!hasAnyRecord) src = lang === 'tw' ? 'audio/tw/intro.mp3' : 'audio/en/intro.mp3';
    else if (lang === 'tw' && TW_READY.has('twi_on')) src = TW_CLIPS.twi_on;
    if (src) { introAudio = new Audio(src); introAudio.play().catch(() => {}); }
    else if (lang === 'tw') { introAudio = new Audio('audio/tw/intro.mp3'); introAudio.play().catch(() => {}); }
    else speakShort('English.');
    ping(lang === 'tw' ? 'listen_tw' : 'listen_en'); track('listen', { lang, has_records: hasAnyRecord ? 1 : 0 });
  } catch (e) { /* optional */ }
}
function markVoiceButtons() {
  const box = document.getElementById('introListen'); if (!box) return;
  const v = voiceLang();
  box.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === v)));
}
(function wireListen() {
  const box = document.getElementById('introListen');
  if (!box || ES || !BOOK_ON || !LISTEN_READY) return;
  box.hidden = false;
  markVoiceButtons();
  box.querySelectorAll('button').forEach(b => b.addEventListener('click', () => playIntro(b.dataset.lang)));
})();

// A short message that floats over the bottom of the screen, so it is seen
// whatever the design and however far down the page it would have been.
function floatNotice(html, ms) {
  let el = document.getElementById('floatNote');
  if (!el) { el = document.createElement('div'); el.id = 'floatNote'; el.className = 'milestone float'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.innerHTML = html + '<button type="button" class="float-x" aria-label="' + t('Close', 'Cerrar') + '">\u00d7</button>';
  el.hidden = false;
  el.querySelector('.float-x').addEventListener('click', () => { el.hidden = true; });
  clearTimeout(el._t); if (ms) el._t = setTimeout(() => { el.hidden = true; }, ms);
  return el;
}
function pushSupported() {
  try { return !inAppBrowser() && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; } catch (e) { return false; }
}
function b64uToBytes(s) { const p = '='.repeat((4 - s.length % 4) % 4); const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); }
async function enableEveningReminder() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { track('push_denied'); return false; }
    const reg = await navigator.serviceWorker.ready;
    const key = ((await (await fetch(API_BASE + '/push/key')).json()) || {}).key;
    if (!key) return false;
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
    const res = await fetch(API_BASE + '/push/sub', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: getDeviceId(), endpoint: sub.endpoint, lang: ES ? 'es' : 'en', test: (isTestDevice() || window.KYM_IS_OWNER_DEVICE) ? 1 : 0 }) });
    if (!res.ok) return false;
    if (reg.active) reg.active.postMessage({ kymPrefs: { es: !!ES } });
    try { localStorage.setItem('kym_push', '1'); } catch (e) { /* optional */ }
    ping('push_on'); track('push_on');
    return true;
  } catch (e) { track('push_error', { reason: (e && (e.name || e.message)) || 'unknown' }); return false; }
}
function reminderButtonHtml() {
  let on = false; try { on = localStorage.getItem('kym_push') === '1'; } catch (e) { /* optional */ }
  if (on || !pushSupported()) return '';
  return ` <button type="button" class="remind-btn remind-alt" id="eveBtn">${t('Remind me every evening (6:30pm)', 'Recu\u00e9rdame cada noche (6:30pm)')}</button>`;
}
function wireReminderButton(box) {
  const b = box.querySelector('#eveBtn'); if (!b) return;
  b.addEventListener('click', async () => {
    b.disabled = true;
    const ok = await enableEveningReminder();
    b.textContent = ok ? t('Done. See you at 6:30pm.', 'Listo. Nos vemos a las 6:30pm.') : t('Your phone said no. That is fine.', 'Tu tel\u00e9fono dijo que no. No pasa nada.');
    if (ok) speakShort(t('Done. I will remind you at half past six in the evening.', 'Listo. Te recuerdo a las seis y media de la tarde.'));
  });
}

async function restoreFromKey() {
  const k = window.KYM_RESTORE_KEY;
  if (!k) return;
  // Take the key out of the address bar at once, so it is not bookmarked or
  // copied along with the page.
  try { const u = new URLSearchParams(location.search); u.delete('k'); u.delete('h'); const q = u.toString(); history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash); } catch (e) { /* optional */ }
  if (getShopId()) return;
  if (!window.KYM_ADOPTED && localStorage.getItem('kym_device_id') === k) return; // her own link, same browser
  if (!navigator.onLine) return;
  try {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 9000) : null;
    const res = await fetch(API_BASE + '/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ k }), signal: ctl ? ctl.signal : undefined });
    if (timer) clearTimeout(timer);
    if (!res.ok) return;
    const got = ((await res.json()) || {}).entries || [];
    if (!got.length) return;
    const have = new Set((await getAllEntries()).map(e => e.id));
    const add = got.filter(e => e && e.id && !have.has(e.id));
    if (!add.length) return;
    await new Promise((resolve, reject) => {
      dbTx('readwrite').then(tx => {
        const st = tx.objectStore(STORE);
        add.forEach(e => st.put(e));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('restore aborted'));
      }, reject);
    });
    ping('restore'); track('restore', { n: add.length });
    const msg = t('Your book is here: ' + add.length + (add.length === 1 ? ' record.' : ' records.'), 'Tu cuaderno est\u00e1 aqu\u00ed: ' + add.length + (add.length === 1 ? ' registro.' : ' registros.'));
    floatNotice(escapeHtml(msg), 7000);
    try { speakShort(msg); } catch (e) { /* optional */ }
  } catch (e) { track('restore_error', { reason: (e && e.name) || 'unknown' }); }
}

(async function init() {
  try { db = await openDB(); } catch (e) { track('idb_error', { where: 'open', reason: (e && (e.name || e.message)) || 'unknown' }); }
  await restoreFromKey();
  // The home design rides on the version tag so every ping, the backend and
  // Clarity can split results by it (see HOME_VARIANT).
  window.KYM_VERSION = ((document.querySelector('meta[name="countmy-version"]') || {}).content || 'unknown') + (BOOK_ON ? 'book' : 'today');
  try { if (window.clarity && !window.KYM_IS_OWNER_DEVICE) window.clarity('set', 'home', BOOK_ON ? 'book' : 'today'); } catch (e) { /* optional */ }
  // Programme code from the link she arrived on (a partner's card or QR carries
  // ?p=<code>). Stored once, first code wins, sent with every ping so the
  // partner can be shown adoption among its own traders. Never a name.
  try {
    const p = new URLSearchParams(location.search).get('p');
    if (p && !localStorage.getItem('kym_programme')) localStorage.setItem('kym_programme', p.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32));
  } catch (e) { /* storage blocked - attribution is optional */ }
  // Test devices (16 Sep): open the app once with ?test=1 and every row this
  // phone writes to the server is flagged is_test and kept out of the
  // dashboard's production numbers, instead of being "subtracted" by memory.
  try { if (new URLSearchParams(location.search).get('test') === '1') localStorage.setItem('kym_test', '1'); } catch (e) { /* optional */ }
  // Where did this phone come from? (16 Sep.) Decided once, on the very first
  // visit, from the link's utm_source, else a partner code, else the referrer
  // host, else "direct". Stored as source or source/campaign, never a URL.
  try {
    if (!localStorage.getItem('kym_source')) {
      const u = new URLSearchParams(location.search);
      const clean = s => String(s || '').toLowerCase().replace(/[^a-z0-9_.:-]/g, '').slice(0, 40);
      let src = clean(u.get('utm_source'));
      if (!src && u.get('r') === 'wa') src = 'whatsapp-self';
      const camp = clean(u.get('utm_campaign'));
      if (!src && u.get('p')) src = 'partner';
      if (!src && document.referrer) {
        const h = new URL(document.referrer).hostname.replace(/^www\./, '');
        if (h && h !== location.hostname) {
          src = /facebook|fb\.com|fb\.me|messenger/.test(h) ? 'facebook'
            : /instagram/.test(h) ? 'instagram'
            : /whatsapp/.test(h) ? 'whatsapp'
            : /tiktok/.test(h) ? 'tiktok'
            : /google|bing|duckduckgo|yahoo/.test(h) ? 'search'
            : /b\.countmy\.app|workers\.dev/.test(h) ? 'shoppage'
            : 'other:' + clean(h).slice(0, 24);
        }
      }
      // 25 Sep: the ad link carries Meta's placement (utm_content={{placement}},
      // e.g. Facebook_Mobile_Reels). Kept on the campaign so the dashboard can
      // tell which placements bring people who actually tap and save.
      const placement = clean(u.get('utm_content'));
      localStorage.setItem('kym_source', (src || 'direct') + (camp ? '/' + camp + (placement && src === 'facebook' ? '.' + placement : '') : ''));
    }
  } catch (e) { /* optional */ }
  console.info('CountMy ' + window.KYM_VERSION);
  // Same three labels on every analytics surface (16 Sep), so GA4, Clarity
  // and the owner dashboard can all be cut the same way: build, source, cohort.
  try {
    const labels = { app_version: window.KYM_VERSION || '', home: BOOK_ON ? 'book' : 'today', source: localStorage.getItem('kym_source') || '', nudge_cohort: String(nudgeCohort()) };
    if (window.gtag) window.gtag('set', 'user_properties', labels);
    if (window.clarity) { window.clarity('set', 'version', labels.app_version); window.clarity('set', 'source', labels.source); window.clarity('set', 'cohort', labels.nudge_cohort); }
  } catch (e) { /* analytics must never interrupt the app */ }
  // Receiving side of the http -> https record bridge (see the head script
  // in index.html). Only ever accepts rows from our own http origin, only
  // when opened as ?bridge=1, and uses put so a row that already exists is
  // overwritten rather than duplicated.
  if (new URLSearchParams(location.search).get('bridge') === '1' && window.parent !== window) {
    window.addEventListener('message', async function (e) {
      if (e.origin !== 'http://' + location.host) return;
      if (!e.data || e.data.type !== 'kym-bridge' || !Array.isArray(e.data.rows)) return;
      try {
        const tx = await dbTx('readwrite');
        const st = tx.objectStore(STORE);
        e.data.rows.forEach(r => { if (r && r.id) st.put(r); });
        tx.oncomplete = () => { track('bridge_import', { rows: e.data.rows.length }); e.source.postMessage('kym-bridge-done', e.origin); };
        tx.onerror = () => e.source.postMessage('kym-bridge-done', e.origin);
      } catch (err) { e.source.postMessage('kym-bridge-done', e.origin); }
    });
    window.parent.postMessage('kym-bridge-ready', 'http://' + location.host);
    return;
  }
  updateOfflineBadge();
  try { await render(); } catch (e) { track('render_error', { reason: (e && (e.name || e.message)) || 'unknown' }); }
  // Real feedback, 1 Sep ("there's too much going on... if you're a trader
  // you don't need to define everything, they already know what it means"):
  // the subtext under each of the 4 category buttons ("What you sold, how
  // many, price" etc.) is genuinely useful the very first time someone sees
  // an unfamiliar button, and genuinely just clutter on the 50th time. Same
  // fade-after-first-use mechanism as the mic trust line above, same
  // threshold - a brand new user still gets every bit of guidance, a
  // returning one stops being told what a button she already understands
  // does, every single day.
  if (bumpVisitCount() > 5) {
    const trustLine = document.querySelector('.mic-trust-line');
    if (trustLine) trustLine.hidden = true;
    document.querySelectorAll('.act-btn small').forEach(el => { el.hidden = true; });
    const demoBtnEl = document.getElementById('demoBtn');
    if (demoBtnEl) demoBtnEl.hidden = true;
  }
  firstSeenAt();
  renderBackupStatus();
  refreshPaidStatus();
  maybeShowEodPrompt();
  ping('open');
  flushUnsynced();
  if (new URLSearchParams(location.search).get('r') === 'push') { ping('push_open'); track('push_open'); }
  try {
    const asked = Number(localStorage.getItem('kym_push_asked') || 0);
    if (!ES && pushSupported() && localStorage.getItem('kym_push') !== '1' && hasAnyRecord && Date.now() - asked > 3 * 86400000 && (Number(localStorage.getItem('kym_visits')) || 0) >= 2) {
      localStorage.setItem('kym_push_asked', String(Date.now()));
      const box = floatNotice(escapeHtml(t('Want a reminder every evening to write your sales?', '')) + reminderButtonHtml(), 0);
      wireReminderButton(box);
    }
  } catch (e) { /* optional */ }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
})();

// CANARY_TEST_12345

// The four typed category buttons used to sit open on the home screen, five
// competing ways to record one sale. Voice and the camera handle every type on
// their own, so typing is the fallback for someone who would rather type - one
// tap away, not a decision she has to make before she can start.
var typeToggleBtn = document.getElementById('typeToggle');
if (typeToggleBtn) {
  typeToggleBtn.addEventListener('click', function () {
    var box = document.getElementById('typeChoices');
    if (!box) return;
    var opening = box.hidden;
    box.hidden = !opening;
    typeToggleBtn.hidden = opening;
  });
}
