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
    return /^es\b/i.test(navigator.language || '') ? 'es' : 'en';
  } catch (e) { return 'en'; }
}
const LANG = detectLang();
const ES = LANG === 'es';
document.documentElement.lang = ES ? 'es' : 'en';
const t = (en, es) => (ES ? es : en);
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
// Spoken replies (17 Sep). Bobby's verdict on the phone's built-in voice was
// blunt and right. say() fetches a short clip from the Worker (/say - a real
// voice, Spanish included), keeps it in the Cache API so fixed phrases cost
// once, and plays it through one AudioContext unlocked by any tap (the only
// way iOS lets audio play a second after the tap). If the server is capped,
// offline, or slow to fail, the phone's own voice speaks the same words -
// the words never go missing, only the quality changes.
// ---------------------------------------------------------------------------
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

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      const store = d.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      store.createIndex('day', 'day');
      store.createIndex('type', 'type');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function todayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Real request, 30 Aug: if a phone is lost, broken, or an entry gets deleted
// by mistake (a real elderly first-time user, not a hypothetical one), there
// was no way to get it back - records lived ONLY in this device's IndexedDB.
// Bobby's explicit call: automatic, no toggle, no extra button - "less
// confusion or buttons or worries for users" - over an opt-in backup setting.
// Same privacy shape as ping(): the shop id is hashed server-side before it
// touches storage (see worker.js handleSync), this is best-effort/fire-and-
// forget, and it never blocks or fails the real local save if it's offline
// or the request fails.
function syncEntryToServer(entry, deleted) {
  try {
    if (window.KYM_IS_OWNER_DEVICE) return;
    if (!navigator.onLine) return;
    const shop = getShopId() || getDeviceId();
    fetch(`${API_BASE}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shop, entry, deleted: !!deleted, test: isTestDevice() })
    }).then(res => {
      // Only on a real server confirmation - claiming "backed up" because a
      // request was merely sent would be the same broken promise the apps
      // that lost people's records made.
      if (res && res.ok) { markBackedUp(); renderBackupStatus(); }
    }).catch(() => {});
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
      entry: { id: crypto.randomUUID(), ...entryLike, status: 'not_saved' },
      deleted: false
    })
  }).catch(() => {});
}

function addEntry(entry) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).add(entry);
    let reqError = null;
    req.onerror = (e) => { reqError = req.error; e.preventDefault(); tx.abort(); };
    tx.oncomplete = () => { syncEntryToServer(entry, false); resolve(); };
    tx.onerror = () => reject(reqError || tx.error || new Error('addEntry failed'));
    tx.onabort = () => reject(reqError || tx.error || new Error('addEntry aborted'));
  });
}

function deleteEntry(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
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
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
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
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.ts - a.ts));
    req.onerror = () => reject(req.error);
  });
}

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
      return `${v.qty} \u00d7 ${v.item} at ${fmt(v.price)} = ${fmt(total)}`;
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
    desc: v => v.item + (v.kind === 'stock' ? ' (stock)' : v.kind === 'home' ? ' (took home)' : ''),
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
      return `${v.item} owes you ${fmt(v.price)}`;
    },
    // Real feedback, 28 Aug (a 55-year-old first-time user, low literacy/
    // numeracy): the Recent list used to show just the name ("Ama") with
    // direction implied only by a +/- sign and a color - "customer who owed
    // me and supplier getting messy" is exactly what that produces for
    // someone who can't reliably read a red/green + or -. Say the direction
    // in words every time, not just via sign/color.
    desc: v => `${v.item} owes you` + (v.note ? ' \u2014 ' + v.note : ''),
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
      return `You owe ${v.item} ${fmt(v.price)}`;
    },
    desc: v => `You owe ${v.item}` + (v.note ? ' \u2014 ' + v.note : ''),
    amountSign: -1,
    isDebt: true
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
  return /FBAN|FBAV|FB_IAB|Instagram|Messenger\/|Line\/|MicroMessenger/i.test(navigator.userAgent || '');
}
function isAndroid() { return /Android/i.test(navigator.userAgent || ''); }
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
    const btn = document.getElementById('homeMicBtn');
    if (btn && btn.parentNode) btn.parentNode.insertBefore(box, btn); else return;
  }
  const lead = reason === 'failed'
    ? t('Facebook\u2019s browser cannot use the microphone.', 'El navegador de Facebook no puede usar el micr\u00f3fono.')
    : t('You are inside Facebook\u2019s browser \u2014 the microphone may not work here.', 'Est\u00e1s dentro del navegador de Facebook: puede que el micr\u00f3fono no funcione aqu\u00ed.');
  box.innerHTML = isAndroid()
    ? `<p>${lead}</p><a class="iab-open" href="${chromeIntentUrl()}">${t('Open in Chrome', 'Abrir en Chrome')}</a><p class="iab-sub">${t('Same page, and your voice will work.', 'Es la misma p\u00e1gina, y ah\u00ed s\u00ed funciona la voz.')}</p><label class="iab-note"><input type="file" accept="audio/*" capture id="iabNoteInput">\uD83C\uDF99 ${t('Or record a voice note here', 'O graba una nota de voz aqu\u00ed')}</label>`
    : `<p>${lead}</p><a class="iab-open" href="${window.KYM_SAFARI_URL || ('x-safari-https://' + location.host + location.pathname + '?from=iab')}">${t('Open in Safari', 'Abrir en Safari')}</a><p class="iab-sub">${t('Same page, and your voice will work. If nothing opens: tap <b>\u22ef</b> at the top, then <b>Open in Safari</b>.', 'Es la misma p\u00e1gina, y ah\u00ed s\u00ed funciona la voz. Si no se abre: toca <b>\u22ef</b> arriba y luego <b>Abrir en Safari</b>.')}</p>`;
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
  try {
    const box = document.getElementById('typeChoices'); const tt = document.getElementById('typeToggle');
    if (box) box.hidden = false; if (tt) tt.hidden = true;
  } catch (e) { /* never block */ }
}
// Every voice failure ends here: said out loud (the audience does not read),
// written under the button, counted on the owner dashboard by class only
// (never the words), and the typed choices opened so the page still works.
function micFail(msg, pingName, statusId) {
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
// dishes (18 Sep, Bobby's phone: "bowls" and "cedis" both came out wrong).
// Same map as the server's repairTranscript, so the phone path and the
// server path hear the same thing.
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
  return t;
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
const FILLER_ES = /(?<![\w\u00c0-\u00ff])(d[o\u00f3]lares?|bol[i\u00edv]vares?|bolos?|bs|pesos?|lucas?|luca|verdes?|plata|de a|cada una|cada uno|vend[i\u00ed]|compr[e\u00e9]|gast[e\u00e9]|pagu[e\u00e9]|me debe|me qued[o\u00f3] debiendo|le fi[e\u00e9] a|le debo a|fiao|fiado|de|del|la|el|los|las|un|una|unos|unas|y|con|por|para|en|a|me|le|se|es|hoy)(?![\w\u00c0-\u00ff])/gi;
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
    if (res.ok) return { text: heardText, events: shapeEvents(data.events), via: 'browser' };
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
  if (window.KYM_IS_OWNER_DEVICE) form.append('dbg', 'owner'); // Bobby's own phones: transcript goes to the server log so mishearings can be read and fixed
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
  return { text: data.text || '', events: shapeEvents(data.events), via: 'whisper' };
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
  if (!name || !(amount > 0) || /(for|of)/i.test(name)) return null;
  return { type: 'payment', customer: name.trim(), price: amount };
}
function shapeEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.map(ev => {
    if (!ev || typeof ev !== 'object') return ev;
    if (!ev.item && (ev.customer || ev.supplier)) ev.item = String(ev.customer || ev.supplier).trim();
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
    debt_out: { title: tc('Le debo al proveedor', 'Debo al proveedor'), item: 'Nombre del proveedor', price: '\u00bfCu\u00e1nto le debes? ($)', note: 'Por qu\u00e9 (opcional)' }
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
const TOOK_HOME_PHRASES = ['chop money', 'took home', 'take home', 'taken home', 'for the house', 'my pocket', 'for myself', 'housekeeping'];
function spendKindFromText(text) {
  const t = String(text || '').toLowerCase();
  return TOOK_HOME_PHRASES.some(p => t.indexOf(p) !== -1) ? 'home' : '';
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
async function applyVoicePayment(p) {
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
    const record = { id: crypto.randomUUID(), type: 'sale', item, note: '', qty: 1, price: amount, kind: '', paid: 0, amount, source: pendingVoiceSource, day: todayKey(ts), ts };
    if (cur) record.cur = cur;
    try { await addEntry(record); track('save_entry', { type: 'payment_as_sale', input_method: pendingVoiceSource }); ping('save'); } catch (err) { track('save_error', { where: 'voice_payment', reason: (err && err.name) || 'unknown' }); }
    return placeholder
      ? t(`Saved ${fmtSay(amount, cur)} as money in.`, `Guard\u00e9 ${fmtSay(amount, cur)} como dinero que entr\u00f3.`)
      : t(`${name} paid ${fmtSay(amount, cur)}. I had no debt for ${name}, so I saved it as money in.`, `${name} pag\u00f3 ${fmtSay(amount, cur)}. No ten\u00eda ninguna deuda de ${name}, as\u00ed que lo guard\u00e9 como dinero que entr\u00f3.`);
  }
  let left = amount;
  for (const m of matches) {
    if (left <= 0) break;
    const pay = Math.min(open(m), left);
    const payments = Array.isArray(m.payments) ? m.payments.slice() : [];
    payments.push({ amount: pay, ts: Date.now(), source: 'voice' });
    await updateEntry(m.id, { paid: (Number(m.paid) || 0) + pay, payments });
    left -= pay;
  }
  const stillOwed = matches.reduce((s, m) => s + open(m), 0) - (amount - left);
  track('debt_paid', { full: stillOwed <= 0, voice: true });
  ping('save');
  if (left > 0) {
    // paid more than was owed: the extra is money in, said out loud
    const ts = Date.now();
    const record = { id: crypto.randomUUID(), type: 'sale', item: t(`extra from ${spoken}`, `extra de ${spoken}`), note: '', qty: 1, price: left, kind: '', paid: 0, amount: left, source: pendingVoiceSource, day: todayKey(ts), ts };
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
    const id = crypto.randomUUID();
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
      const id = crypto.randomUUID();
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
// Real bug, 18 Sep (Bobby: "nothing records on any device"): this meter
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
  await Promise.race([say(opts && opts.again ? t('Say it again.', 'Dilo otra vez.') : askMode ? t('Ask me.', 'Preg\u00fantame.') : t('Speak now.', 'Habla ahora.')), new Promise(res => setTimeout(res, 1800))]);
  askMode = false;
  stopSpeaking();
  try { if (navigator.vibrate) navigator.vibrate(40); } catch (e) { /* optional */ }
  try { r.start(); bstt = r; } catch (e) { errCode = 'start'; }
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
        let { text: heard, events: heardEvents, via } = await transcribeAndExtract(blob, heardText);
        let events = Array.isArray(heardEvents) ? heardEvents : [];
        // The phone heard words but the server found no record in them and
        // no number either (Twi, or a mangled take): one more try with the
        // audio itself, where Whisper knows the local words.
        if (via === 'browser' && !events.length && blob && blob.size && !/\d/.test(wordsToNumber(heard || ''))) {
          track('stt_browser_retry');
          try { const r2 = await transcribeAndExtract(blob); if (r2.text && r2.text.trim()) { heard = r2.text; events = r2.events; via = 'whisper'; } } catch (e) { /* keep the phone's words */ }
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
        const spokenLang = guessSpokenLang(heard);
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
        track('mic_error', { reason: err.cls || 'app_error', http: err.http || 0, ms: recordedMs, bytes });
        // F7: only our own error texts are spoken; anything else is an app fault, never read aloud
        micFail(err.cls ? (err.message || t('Could not hear that \u2014 please try again, or type it below.', 'No te escuch\u00e9 bien. Int\u00e9ntalo otra vez, o escr\u00edbelo abajo.')) : t('Something went wrong on the phone \u2014 please check the list below, or try again.', 'Algo fall\u00f3 en el celular. Revisa la lista abajo, o int\u00e9ntalo otra vez.'), err.cls || 'mic_server', statusId);
  }
}
let micArming = false;
let askMode = false;
async function toggleMic(btn, statusId, opts) {
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
    // Real bug, 18 Sep (Bobby: "nothing records on any device"): this timer
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
      await processVoiceBlob(new Blob(recordedChunks, { type: actualMime }), statusId, recordedMs, recordedChunks.reduce((s, c) => s + c.size, 0));
    };
    // Say "Speak now" BEFORE the recorder starts (it would otherwise record
    // itself), then listen. The clip is prefetched, so this is ~0.7 s.
    btn.classList.add('recording');
    const lbl = btn.querySelector('.home-mic-label');
    if (lbl) { if (!lbl.dataset.idle) lbl.dataset.idle = lbl.textContent; lbl.textContent = t('Speak now\u2026', 'Habla ahora\u2026'); }
    setMicStatus(t('Speak now. It stops by itself when you finish.', 'Habla ahora. Cuando termines, se apaga solo.'), null, statusId);
    await Promise.race([say(opts && opts.again ? t('Say it again.', 'Dilo otra vez.') : askMode ? t('Ask me.', 'Preg\u00fantame.') : t('Speak now.', 'Habla ahora.')), new Promise(r => setTimeout(r, 1800))]);
    askMode = false;
    stopSpeaking(); // never let the prompt run into the recording
    try { if (navigator.vibrate) navigator.vibrate(40); } catch (e) { /* optional */ }
    mediaRecorder.start();
    recordingStartedAt = Date.now();
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
    if (kind === 'save') window.fbq('track', 'Lead');
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
    id = 'anon-' + crypto.randomUUID();
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
      body: JSON.stringify({ shop, event: eventType, programme: localStorage.getItem('kym_programme') || '', device: getDeviceId(), source: localStorage.getItem('kym_source') || '', test: isTestDevice(), nudge: nudgeCohort(), ver: window.KYM_VERSION || '', lang: (navigator.language || '').slice(0, 12), mobile: /Mobi|Android/i.test(navigator.userAgent) ? 1 : 0, standalone: isStandalone() ? 1 : 0 })
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
  document.getElementById('sheetTitle').textContent = entry ? 'Edit entry' : cfg.title;
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
      <label for="field-paid">Paid so far (cedis)</label>
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
  document.getElementById('saveBtn').textContent = entry ? 'Save changes' : 'Save';
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
  const line = cfg.confirm(v);
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
  saveBtn.textContent = 'Saving\u2026';
  try {
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
        const id = crypto.randomUUID();
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
    saveBtn.textContent = 'Save';
  }
}

// Plan state's only source of truth is countmy-api / KV \u2014 Bobby, the CEO, flips a
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

async function refreshPaidStatus() {
  const shop = getShopId();
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
  // Real advice, 28 Aug, from real testing (Bobby's mum and aunties found
  // "everything" confusing) plus two independent AI reviews plus real stats
  // (zero paid conversions ever from a prominent, full-width payment pitch):
  // a payment button on the main screen contradicts "always free" no matter
  // how it's worded, for this exact audience. Demoted to a small, low-key
  // link instead of a full-width button pitching payment - still reachable,
  // no longer competing with the free promise for attention.
  document.getElementById('planPill').textContent = paid ? 'Thank you for supporting CountMy' : 'Support CountMy (optional, 99 cedis a year)';
  const shopInput = document.getElementById('shopIdInput');
  if (shopInput && document.activeElement !== shopInput) shopInput.value = getShopId();
}

// Real design reference, 28 Aug: AxisTrade (a Ghana competitor Bobby
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
  document.getElementById('homeMicBtn').classList.toggle('first-use', firstUse);
  document.getElementById('whatIs').hidden = !firstUse;
  const strip = document.getElementById('todayStrip'); if (strip) strip.hidden = firstUse;
  document.getElementById('exampleChat').hidden = true;
  document.getElementById('trustLine').hidden = !firstUse;
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
    vsYesterdayEl.textContent = `Up ${fmt(salesDiff)} from yesterday`;
    vsYesterdayEl.className = 'today-vs pos';
  } else if (salesDiff < 0) {
    vsYesterdayEl.textContent = `Down ${fmt(-salesDiff)} from yesterday`;
    vsYesterdayEl.className = 'today-vs neg';
  } else {
    vsYesterdayEl.textContent = 'Same as yesterday';
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
      <div class="desc" data-clarity-mask="True">${cfg.desc(e)}${settledTag}<small>${when}</small>${agingLine}${remind}${paymentRow}</div>
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
function reminderMessage(name, amount, note, cur) {
  return t(`Hello ${name}, your balance is ${fmt(amount, cur)}${note ? ' for ' + note : ''}. Please send by MoMo when you can. Thank you.${reminderHook()}`,
    tc(`Hola ${name}, me debes ${fmt(amount, cur)}${note ? ' por ' + note : ''}. Cuando puedas me lo mandas por Pago M\u00f3vil, por favor. \u00a1Gracias!${reminderHook()}`,
       `Hola ${name}, buen d\u00eda. Me debe ${fmt(amount, cur)}${note ? ' de ' + note : ''}. Cuando pueda me lo manda por Nequi o en efectivo, por favor. \u00a1Gracias!${reminderHook()}`));
}

function shareFooter(campaign) {
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
  try { ts = Number(localStorage.getItem('kym_last_backup')) || 0; } catch (e) { return ''; }
  if (!ts) return 'Not backed up yet';
  const day = todayKey(ts);
  if (day === todayKey(Date.now())) return 'Backed up today';
  if (day === todayKey(Date.now() - 24 * 60 * 60 * 1000)) return 'Backed up yesterday';
  return 'Backed up ' + new Date(ts).toLocaleDateString('en-GH', { day: 'numeric', month: 'short' });
}

function renderBackupStatus() {
  const el = document.getElementById('backupStatus');
  if (!el) return;
  const text = backupStatusText();
  const backedUp = text.indexOf('Backed up') === 0;
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
  // Never permanent - it is a prompt about one debt, not a part of the page.
  debtReminderTimer = setTimeout(() => { box.hidden = true; }, 25000);
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
function guessSpokenLang(text) {
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
  if (!st || !st.url) { box.hidden = true; if (btn) btn.textContent = 'Get a free page for your business'; return; }
  if (btn) btn.textContent = 'My business page';
  document.getElementById('shopReadyText').textContent = `${st.name} has a page: ${st.url.replace('https://', '')}`;
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
  if (!payload.name) { setMicStatus('Please give your business a name.', 'err', 'shopStatus'); return; }
  if (!payload.whatsapp) { setMicStatus('Please enter your WhatsApp number.', 'err', 'shopStatus'); return; }
  btn.disabled = true; btn.textContent = 'Making\u2026';
  try {
    const res = await fetch(`${API_BASE}/shop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.slug) { setMicStatus(data.error || 'Could not make the page. Please try again.', 'err', 'shopStatus'); return; }
    localStorage.setItem(SHOP_LS, JSON.stringify({ ...payload, slug: data.slug, editKey: data.editKey, url: data.url }));
    if (!getShopId()) setShopId(payload.name); // her backup is filed under this name from now on
    track(st.slug ? 'business_updated' : 'business_created', { category: payload.category, items: payload.items.length });
    if (!st.slug) ping('shop_created');
    closeShopSheet();
    renderShopReady();
    document.getElementById('shopReady').scrollIntoView({ behavior: 'smooth', block: 'center' });
    speakShort('Your page is ready. Tap Share my page to send it on WhatsApp.');
  } catch (e) {
    setMicStatus('No connection. Please try again when you have signal.', 'err', 'shopStatus');
  } finally { btn.disabled = false; btn.textContent = 'Make my page'; }
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
  if (!entries.length) { speakShort(t('Nothing recorded yet. Tap Tell CountMy and say what happened.', 'Todav\u00eda no hay nada anotado. Toca Cu\u00e9ntale a CountMy y di qu\u00e9 pas\u00f3.')); return; }
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
// One tap between English and Spanish (18 Sep): a test link with ?lang=es
// left Bobby's own phone in Spanish with no way back but the address bar.
(function langSwitch() {
  const b = document.getElementById('langSwitch'); if (!b) return;
  b.textContent = ES ? 'English' : 'Español';
  b.addEventListener('click', () => {
    try { localStorage.setItem('kym_lang', ES ? 'en' : 'es'); } catch (e) { /* optional */ }
    track('lang_switch', { to: ES ? 'en' : 'es' });
    const u = new URL(location.href); u.searchParams.set('lang', ES ? 'en' : 'es'); location.href = u.toString();
  });
})();
document.getElementById('homeMicBtn').addEventListener('click', () => {
  track('open_sheet', { type: 'home_mic' });
  ping('tap'); // funnel step between 'opened' and 'recorded' (16 Sep)
  toggleMic(document.getElementById('homeMicBtn'), 'homeMicStatus');
});
if (ES) {
  // Static page text, Spanish. Leaf elements whose whole text matches an
  // English line are swapped; everything else is untouched.
  const S = {
    'Your free money notebook. You talk, it remembers.': 'Tu cuaderno de cuentas gratis. T\u00fa hablas, \u00e9l lleva la cuenta.',
    'What happened in your business today?': '\u00bfQu\u00e9 pas\u00f3 hoy en tu negocio?',
    'Tell CountMy': 'Cu\u00e9ntale a CountMy',
    'Say it in English, Twi or Pidgin. You can also ask: \u201cwho owes me?\u201d': 'Dilo en espa\u00f1ol. Tambi\u00e9n puedes preguntar: \u201c\u00bfqui\u00e9n me debe?\u201d',
    '\u201cAma owes me 120.\u201d': '\u201cMar\u00eda me debe 20.\u201d',
    'Saved: Ama, 120 cedis.': 'Guardado: Mar\u00eda, 20 d\u00f3lares.',
    '\u201cWho owes me?\u201d': '\u201c\u00bfQui\u00e9n me debe?\u201d',
    'Ama owes you 120 cedis.': 'Mar\u00eda te debe 20 d\u00f3lares.',
    'See how it works': 'Ver c\u00f3mo funciona',
    'Money in': 'Entr\u00f3', 'Money out': 'Sali\u00f3', 'Owed to you': 'Te deben',
    'Try saying:': 'Prueba diciendo:', 'Ask CountMy': 'Preg\u00fantale a CountMy', 'See my business': 'Ver mi negocio',
    '\u201cWho owes me?\u201d \u201cWhat did I sell?\u201d': '\u201c\u00bfQui\u00e9n me debe?\u201d \u201c\u00bfQu\u00e9 vend\u00ed?\u201d', 'Today and all your records': 'Hoy y todas tus cuentas',
    'English \u00b7 Twi \u00b7 Pidgin': 'Espa\u00f1ol',
    'Type it instead': 'Mejor escr\u00edbelo',
    '+ Sale': '+ Venta', '+ Expense': '+ Gasto', 'Customer owes me': 'Cliente me debe', 'I owe supplier': 'Le debo al proveedor',
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
    'Share my page': 'Compartir mi p\u00e1gina', 'Edit': 'Editar', 'Make my page': 'Crear mi p\u00e1gina'
  };
  try {
    document.querySelectorAll('body *').forEach(el => {
      if (el.children.length) return;
      const raw = el.textContent; const k = raw.trim();
      if (S[k] !== undefined) el.textContent = raw.replace(k, S[k]);
    });
    const tl = document.getElementById('trustLine');
    if (tl) tl.innerHTML = tc('Gratis. Sin registrarte. Nunca toca tu plata. No te pide clave, c\u00e9dula ni Pago M\u00f3vil. <a href="safety.html">\u00bfEs seguro?</a>',
      'Gratis. Sin registrarte. Nunca toca tu plata. No te pide c\u00e9dula, clave ni Nequi. Solo guarda tus cuentas. <a href="safety.html">\u00bfEs seguro?</a>');
    const mic = document.getElementById('homeMicBtn'); if (mic) mic.setAttribute('aria-label', 'Cu\u00e9ntale a CountMy qu\u00e9 pas\u00f3');
    document.querySelectorAll('[data-speak]').forEach(el => {
      const m = { 'Sales': 'Ventas', 'Expenses': 'Gastos', 'Stock bought': 'Mercanc\u00eda comprada', 'Money you took home': 'Plata para la casa', 'Customers owe you': tc('Clientes te deben', 'Fiao por cobrar'), 'Money left over': 'Lo que te queda', 'Cash you have now': tc('Efectivo que tienes ahora', 'Plata en caja') };
      const v = el.getAttribute('data-speak'); if (m[v]) el.setAttribute('data-speak', m[v]);
    });
    // MoMo support pill is Ghana-only.
    const pill = document.getElementById('planPill'); if (pill) pill.style.display = 'none';
    document.title = 'CountMy - Cuaderno de cuentas gratis por voz para tu negocio';
  } catch (e) { /* never block the app */ }
}
if (inAppBrowser()) {
  try {
    ping('iab'); track('iab_open');
    if (window.KYM_IAB_JUMPED === 'android') ping('iab_auto');
    if (window.KYM_IAB_JUMPED === 'ios') ping('iab_auto_ios');
    if (window.KYM_IAB_STAY) ping('iab_stay');
    if (isAndroid()) { showOpenInChrome('warn'); showTypedChoices(); }
  } catch (e) { /* never block */ }
}
try { if (new URLSearchParams(location.search).get('from') === 'iab' && !inAppBrowser()) { ping(isAndroid() ? 'iab_escaped' : 'iab_escaped_ios'); track('iab_escaped'); } } catch (e) { /* optional */ }
if (!micSupported()) {
  // No microphone API in this browser (older iOS, some in-app browsers).
  // Say so plainly and open the typed choices, so the page is still usable.
  document.getElementById('homeMicBtn').style.display = 'none';
  const orRow = document.querySelector('.or-row'); if (orRow) orRow.style.display = 'none';
  try {
    setMicStatus('This browser cannot use the microphone. You can type it instead, just below.', 'err', 'homeMicStatus');
    const box = document.getElementById('typeChoices'); const tt = document.getElementById('typeToggle');
    if (box) box.hidden = false; if (tt) tt.hidden = true;
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
      setMicStatus('From your photo \u2014 check each one below, then tap Save.', 'heard', 'homeMicStatus');
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
    this.textContent = 'Back online now - your records are safe.';
    setTimeout(updateOfflineBadge, 2500);
  } else {
    this.textContent = 'Still no connection - don\'t worry, everything you add is saved on your phone.';
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
  if (document.visibilityState === 'visible') render();
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

(async function init() {
  db = await openDB();
  window.KYM_VERSION = (document.querySelector('meta[name="countmy-version"]') || {}).content || 'unknown';
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
      localStorage.setItem('kym_source', (src || 'direct') + (camp ? '/' + camp : ''));
    }
  } catch (e) { /* optional */ }
  console.info('CountMy ' + window.KYM_VERSION);
  // Same three labels on every analytics surface (16 Sep), so GA4, Clarity
  // and the owner dashboard can all be cut the same way: build, source, cohort.
  try {
    const labels = { app_version: window.KYM_VERSION || '', source: localStorage.getItem('kym_source') || '', nudge_cohort: String(nudgeCohort()) };
    if (window.gtag) window.gtag('set', 'user_properties', labels);
    if (window.clarity) { window.clarity('set', 'version', labels.app_version); window.clarity('set', 'source', labels.source); window.clarity('set', 'cohort', labels.nudge_cohort); }
  } catch (e) { /* analytics must never interrupt the app */ }
  // Receiving side of the http -> https record bridge (see the head script
  // in index.html). Only ever accepts rows from our own http origin, only
  // when opened as ?bridge=1, and uses put so a row that already exists is
  // overwritten rather than duplicated.
  if (new URLSearchParams(location.search).get('bridge') === '1' && window.parent !== window) {
    window.addEventListener('message', function (e) {
      if (e.origin !== 'http://' + location.host) return;
      if (!e.data || e.data.type !== 'kym-bridge' || !Array.isArray(e.data.rows)) return;
      try {
        const tx = db.transaction(STORE, 'readwrite');
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
  await render();
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
