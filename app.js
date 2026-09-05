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
  if (window.KYM_IS_OWNER_DEVICE) return;
  if (!navigator.onLine) return;
  const shop = getShopId() || getDeviceId();
  fetch(`${API_BASE}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shop, entry, deleted: !!deleted })
  }).then(res => {
    // Only on a real server confirmation - claiming "backed up" because a
    // request was merely sent would be the same broken promise the apps
    // that lost people's records made.
    if (res && res.ok) { markBackedUp(); renderBackupStatus(); }
  }).catch(() => {});
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

function fmt(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-GH', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' cedis';
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
          { value: 'running', label: 'Shop cost' },
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
    if (ctype.indexOf('json') === -1) throw new Error('No connection \u2014 please try again, or type it.');
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
const FILLER = /\b(a|an|the|for|of|on|to|me|i|owe|owes|he|she|they|it|at|each|cedis|cedi|ghs|cds|cd|sold|spent|bought|paid|is|was|and)\b/gi;

function parseHeardText(type, raw) {
  const text = wordsToNumber(raw);
  const numbers = (text.match(/\d+(\.\d+)?/g) || []).map(Number);
  const cleaned = text
    .replace(/\d+(\.\d+)?/g, ' ')
    .replace(DISFLUENCY, ' ')
    .replace(FILLER, ' ')
    .replace(/[.,!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const v = {};
  if (type === 'sale') {
    if (numbers.length >= 2) { v.qty = numbers[0]; v.price = numbers[1]; }
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
async function transcribeAndExtract(blob) {
  const ext = blob.type.indexOf('mp4') !== -1 ? 'mp4' : (blob.type.indexOf('ogg') !== -1 ? 'ogg' : 'webm');
  const form = new FormData();
  form.append('audio', blob, `voice.${ext}`);
  let res, data;
  try {
    ({ res, data } = await postToApi('/transcribe-and-extract', form));
  } catch (err) {
    throw new Error(plainApiError(err, null, null, 'Could not hear that \u2014 try again'));
  }
  if (!res.ok && !data.text) throw new Error(plainApiError(null, res, data, 'Could not hear that \u2014 try again'));
  return { text: data.text || '', events: Array.isArray(data.events) ? data.events : [] };
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

const TYPE_LABEL = { sale: 'Sale', expense: 'Expense', debt_in: 'Customer owes me', debt_out: 'I owe supplier' };

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
    ? (pendingVoiceSource === 'photo' ? 'Read from your photo - check it' : 'AI heard this - check it')
    : "Didn't catch this - tap to enter";
  return `<div class="field ${cls}">
      <input type="${type}" ${extraAttrs || ''} data-idx="${idx}" data-key="${key}" value="${has ? String(value).replace(/"/g, '&quot;') : ''}" placeholder="${has ? '' : 'tap to enter'}" data-clarity-mask="True">
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
function speakVoiceReview(events) {
  if (!('speechSynthesis' in window)) return;
  const saved = [], incomplete = [];
  events.forEach(ev => {
    const entry = eventToEntry(ev);
    if (!entry.item) return;
    (voiceEventComplete(ev) && !looksGarbled(ev.item) ? saved : incomplete).push(entry);
  });
  const lines = [];
  saved.forEach(entry => lines.push(`Saved: ${entry.item}, ${fmt(entry.amount)}.`));
  incomplete.forEach(entry => lines.push(`I heard ${entry.item} but not the price - tap it in below.`));
  if (!lines.length) return;
  const closer = saved.length
    ? 'If any of this is wrong, tap Undo under it.'
    : '';
  const utter = speakClearly(new SpeechSynthesisUtterance(`${lines.join(' ')} ${closer}`.trim()));
  utter.rate = 0.8;
  speechSynthesis.cancel();
  speechSynthesis.speak(utter);
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
async function autoSaveReadyEvents(events) {
  const saved = [];
  for (const ev of events) {
    if (ev._savedId || !voiceEventComplete(ev) || looksGarbled(ev.item)) continue;
    const entry = eventToEntry(ev);
    const ts = Date.now();
    const id = crypto.randomUUID();
    const record = { id, type: entry.type, item: entry.item, note: entry.note, qty: entry.qty, price: entry.price, kind: entry.kind || '', paid: 0, amount: entry.amount, source: pendingVoiceSource, day: todayKey(ts), ts };
    await addEntry(record);
    track('save_entry', { type: entry.type, input_method: pendingVoiceSource });
    ping('save');
    ev._savedId = id;
    saved.push(record);
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
    title.textContent = pendingVoiceSource === 'photo'
      ? 'From your photo - check each one, then Save'
      : 'What I heard - check each one, then Save';
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
    if (!voiceEventComplete(ev)) { alert('Fill in the missing number(s) first.'); return; }
    const entry = eventToEntry(ev);
    const ts = Date.now();
    const id = crypto.randomUUID();
    const record = { id, type: entry.type, item: entry.item, note: entry.note, qty: entry.qty, price: entry.price, kind: entry.kind || '', paid: 0, amount: entry.amount, source: pendingVoiceSource, day: todayKey(ts), ts };
    await addEntry(record);
    track('save_entry', { type: entry.type, input_method: pendingVoiceSource });
    ping('save');
    ev._savedId = id;
    renderVoiceReview();
    await render();
    await afterEntrySaved(record);
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
function startMicLevelMeter(stream) {
  const meter = document.getElementById('micLevelMeter');
  if (!meter || typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    micLevelCtx = new Ctx();
    const source = micLevelCtx.createMediaStreamSource(stream);
    const analyser = micLevelCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const bars = meter.querySelectorAll('span');
    const tick = () => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((s, v) => s + v, 0) / data.length;
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
  if (micLevelCtx) { micLevelCtx.close().catch(() => {}); micLevelCtx = null; }
  const meter = document.getElementById('micLevelMeter');
  if (meter) meter.querySelectorAll('span').forEach(bar => bar.style.height = '6px');
}

async function toggleMic(btn, statusId) {
  if (!micSupported()) {
    setMicStatus('Voice isn\u2019t available on this phone/browser \u2014 please type instead.', 'err', statusId);
    return;
  }
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
    mediaRecorder = supportedMime ? new MediaRecorder(stream, { mimeType: supportedMime }) : new MediaRecorder(stream);
    const actualMime = mediaRecorder.mimeType || supportedMime || 'audio/webm';
    const recordingStartedAt = Date.now();
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      stopMicLevelMeter();
      btn.classList.remove('recording');
      pendingVoiceSource = 'voice';
      setMicStatus('Listening to what you said\u2026', null, statusId);
      // If nothing was actually captured (mic muted at the OS level, a
      // permission edge case, or the recording stopped instantly) the old
      // code sent an empty file to be transcribed and got back nothing,
      // with no way to tell that apart from "transcription heard silence."
      // This catches it before a network call and says exactly what
      // happened instead.
      if (!recordedChunks.length || recordedChunks.reduce((s, c) => s + c.size, 0) === 0) {
        track('mic_error', { reason: 'empty_recording' });
        setMicStatus('No sound was recorded \u2014 check your phone isn\u2019t muted, then try again.', 'err', statusId);
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
      try {
        const blob = new Blob(recordedChunks, { type: actualMime });
        setMicStatus('Working out what happened\u2026', null, statusId);
        const { text: heard, events } = await transcribeAndExtract(blob);
        if (!heard.trim()) {
          track('mic_error', { reason: 'no_transcript', duration_ms: recordedMs });
          // Real advice, 30 Aug: researched (not guessed) - "please" is the
          // single most documented politeness marker in Ghanaian English,
          // used far more generously in requests than American/British
          // English. Added to every instruction that asks the owner to do
          // something, not to plain statements of fact.
          const msg = recordedMs < 1200
            ? 'Too quick \u2014 tap, speak, then tap again to stop.'
            : 'Didn\u2019t catch that \u2014 hold the phone closer and speak clearly.';
          setMicStatus(msg, 'err', statusId);
          return;
        }
        track('voice_extracted', { event_count: events.length });
        if (events.length >= 1) {
          pendingVoiceEvents = events;
          await autoSaveReadyEvents(pendingVoiceEvents);
          renderVoiceReview();
          closeSheet();
          setMicStatus(`Heard: \u201c${heard}\u201d \u2014 saved, check it below.`, 'heard', statusId);
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
          setMicStatus(`Heard: \u201c${heard}\u201d \u2014 saved, check it below.`, 'heard', statusId);
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
            : /\bowe(s)?\b/i.test(heard) ? 'debt_in'
            : /\b(spent|bought|paid for)\b/i.test(heard) ? 'expense'
            : 'sale';
          const parsed = parseHeardText(guessedType, heard);
          if (parsed.price) {
            pendingVoiceEvents = [{ type: guessedType, item: parsed.item, price: parsed.price, qty: parsed.qty, note: '' }];
            await autoSaveReadyEvents(pendingVoiceEvents);
            renderVoiceReview();
            setMicStatus(`Heard: \u201c${heard}\u201d \u2014 saved, check it below.`, 'heard', statusId);
            document.getElementById('voiceReview').scrollIntoView({ behavior: 'smooth', block: 'start' });
            speakVoiceReview(pendingVoiceEvents);
            await render();
          } else {
            setMicStatus(`Heard: \u201c${heard}\u201d \u2014 but couldn\u2019t work out what happened. Try again, saying an amount in cedis.`, 'err', statusId);
          }
        }
      } catch (err) {
        track('mic_error', { reason: 'transcribe_failed' });
        setMicStatus(err.message || 'Could not hear that \u2014 try again.', 'err', statusId);
      }
    };
    mediaRecorder.start();
    btn.classList.add('recording');
    track('mic_start');
    setMicStatus('Listening\u2026 tap again when you\u2019re done speaking.', null, statusId);
  } catch (err) {
    // Real Clarity finding, 28 Aug: a real user hit this and got stuck - the
    // old message ("check phone permission") assumes someone can read it AND
    // already knows what a browser permission is and how to change one,
    // neither of which holds for this audience. Split by the real cause and
    // say it out loud too, since a text-only fix instruction is useless to
    // someone who can't read it in the first place.
    const msg = err.name === 'NotAllowedError'
      ? 'This phone said no to the microphone. Please go to your phone\u2019s Settings, find CountMy or your browser, and turn the microphone on. Or just type instead.'
      : err.name === 'NotFoundError'
      ? 'This phone/browser has no microphone available. Please type instead.'
      : 'Couldn\u2019t reach the microphone \u2014 please type instead.';
    setMicStatus(msg, 'err', statusId);
    if ('speechSynthesis' in window) {
      const utter = speakClearly(new SpeechSynthesisUtterance(msg));
      utter.rate = 0.8;
      speechSynthesis.cancel();
      speechSynthesis.speak(utter);
    }
    track('mic_error', { reason: err.name || 'getusermedia_failed' });
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
function track(event, params) {
  if (window.gtag) window.gtag('event', event, params || {});
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

function ping(eventType) {
  if (window.KYM_IS_OWNER_DEVICE) return; // see the ?owner=1 flag set in index.html
  const shop = getShopId() || getDeviceId();
  if (!navigator.onLine) return;
  fetch(`${API_BASE}/ping`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shop, event: eventType })
  }).catch(() => {});
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
      track('edit_entry', { type: activeType });
      closeSheet();
      await render();
      return;
    }
    const ts = Date.now();
    // Client-generated id, not IndexedDB autoIncrement \u2014 this is the idempotency key.
    // Defense in depth beyond the button-disable above: if this same save ever got
    // dispatched twice (a future sync retry, a bug), the store rejects the duplicate
    // key instead of silently creating a second transaction. Kept simple deliberately \u2014
    // no backend to reconcile against yet, so this only protects the local device today,
    // but the id shape is what a future sync layer would need anyway.
    const id = crypto.randomUUID();
    const record = {
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
    track('save_entry', { type: activeType, input_method: sheetVoiceFilled ? 'voice' : 'manual' });
    ping('save');
    closeSheet();
    await render();
    await afterEntrySaved(record);
  } catch (err) {
    if (err && err.name === 'ConstraintError') {
      // Same id already saved \u2014 treat as already-done, not a failure.
      closeSheet();
      await render();
    } else {
      throw err;
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
  document.getElementById('planPill').textContent = paid ? 'Paid \u00b7 everything you have recorded' : 'See your full history (optional, 99 cedis/year)';
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
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const shop = getShopId();
  return shop ? `${part}, ${shop}` : part;
}

async function render() {
  const entries = await getAllEntries();
  const today = todayKey(Date.now());
  const todayEntries = entries.filter(e => e.day === today);
  renderAdmin();
  document.getElementById('todayGreeting').textContent = greeting();

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
  const yesterdaySales = entries.filter(e => e.type === 'sale' && e.day === yesterdayKey).reduce((s, e) => s + e.amount, 0);

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
  const owedMe = entries.filter(e => e.type === 'debt_in').reduce((s, e) => s + Math.max(0, e.amount - (e.paid || 0)), 0);
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
  const cashMomoEl = document.getElementById('tCashMomo');
  cashMomoEl.textContent = sales > 0 ? `Cash ${fmt(cashSales)} - MoMo ${fmt(momoSales)}` : '';
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
    histEl.innerHTML = '<div class="empty">Nothing recorded yet. Add your first sale above.</div>';
    return;
  }
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const visible = isPaid() ? entries : entries.filter(e => e.ts >= cutoff);
  const hiddenCount = entries.length - visible.length;
  histEl.innerHTML = visible.slice(0, 30).map(e => {
    const cfg = FIELD_CONFIG[e.type];
    const sign = cfg.amountSign > 0 ? '+' : '\u2212';
    const cls = cfg.amountSign > 0 ? 'pos' : 'neg';
    const when = new Date(e.ts).toLocaleString('en-GH', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
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
      ? `<small class="debt-aging">Owed for ${daysOwed} day${daysOwed === 1 ? '' : 's'}</small>` : '';
    const remind = e.type === 'debt_in' && !isSettled
      ? `<a class="remind-btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(`Hello ${e.item}, your balance is ${fmt(remaining)}${e.note ? ' for ' + e.note : ''}. Please send by MoMo when you can. Thank you.`)}">Remind on WhatsApp</a>`
      : '';
    // "Small small" (bit by bit) is real, sourced, everyday Ghanaian
    // English used across all ages for gradual/partial payment - unlike
    // slang terms this app deliberately avoids elsewhere, this one is
    // genuinely universal register, not youth-coded, and it's an exact
    // match for what this specific control does.
    const paymentRow = cfg.isDebt && !isSettled ? `
      <div class="debt-pay-row">
        <button type="button" class="debt-full-btn" data-id="${e.id}">Paid in full</button>
        <button type="button" class="debt-partial-toggle" data-id="${e.id}">Paid small small</button>
      </div>
      <div class="debt-pay-input-row" data-id="${e.id}" hidden>
        <input type="number" inputmode="decimal" class="debt-pay-input" data-id="${e.id}" placeholder="Amount paid" data-clarity-mask="True">
        <button type="button" class="debt-pay-btn" data-id="${e.id}">Save</button>
      </div>` : '';
    const settledTag = cfg.isDebt && isSettled ? '<span class="debt-settled-tag">\u2713 Paid in full</span>' : '';
    return `<div class="hist-item${cfg.isDebt ? ' is-debt' : ''}" data-edit-id="${e.id}">
      <div class="desc" data-clarity-mask="True">${cfg.desc(e)}${settledTag}<small>${when}</small>${agingLine}${remind}${paymentRow}</div>
      <div class="amt ${cls}" data-clarity-mask="True">${sign}${fmt(displayAmount)}</div>
    </div>`;
  }).join('') + (hiddenCount > 0 ? `<div class="empty">${hiddenCount} older entr${hiddenCount === 1 ? 'y' : 'ies'} \u2014 go Paid to see your full history</div>` : '');
}

// Real gap, closed 28 Aug: recording a repayment against a debt was simply
// impossible before this - "Customers owe me" only ever went up. Delegated
// on #history once (not per-render, since innerHTML is fully replaced on
// every render()) rather than rebinding listeners on every redraw.
document.getElementById('history').addEventListener('click', async (e) => {
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
    await updateEntry(entry.id, { paid: entry.amount });
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
    await updateEntry(entry.id, { paid: newPaid });
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
  if (!('speechSynthesis' in window)) return;
  const t = window._kymToday || { sales: 0, expenses: 0, stockBought: 0, owedMe: 0, balance: 0, cashInHand: 0, salesDiff: 0 };
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
  const stockLine = t.stockBought > 0 ? `Stock bought: ${fmt(t.stockBought)}. ` : '';
  const homeLine = t.takenHome > 0 ? `Money you took home: ${fmt(t.takenHome)}. ` : '';
  const cashLine = (t.stockBought > 0 || t.takenHome > 0) ? `Cash you have now: ${fmt(t.cashInHand)}. ` : '';
  const vsLine = t.salesDiff > 0 ? `Up ${fmt(t.salesDiff)} from yesterday. `
    : t.salesDiff < 0 ? `Down ${fmt(-t.salesDiff)} from yesterday. `
    : `Same as yesterday. `;
  const text = `Today. Sales: ${fmt(t.sales)}. Expenses: ${fmt(t.expenses)}. ${stockLine}${homeLine}`
    + `Customers owe you: ${fmt(t.owedMe)}. Money left over: ${fmt(t.balance)}. ${cashLine}${vsLine}`;
  const utter = speakClearly(new SpeechSynthesisUtterance(text));
  utter.rate = 0.8;
  const btn = document.getElementById('hearBtn');
  utter.onstart = () => btn.classList.add('speaking');
  utter.onend = () => btn.classList.remove('speaking');
  speechSynthesis.cancel();
  speechSynthesis.speak(utter);
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
const SHARE_FOOTER = '\n\nI keep my shop money with CountMy. It is free: https://countmy.app';

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
  const name = entry.item || 'Your customer';
  document.getElementById('debtReminderText').textContent = `${name} owes you ${fmt(owed)}.`;
  const link = document.getElementById('debtReminderSend');
  const msg = `Hello ${name}, your balance is ${fmt(owed)}${entry.note ? ' for ' + entry.note : ''}. Please send by MoMo when you can. Thank you.`;
  link.href = 'https://wa.me/?text=' + encodeURIComponent(msg);
  link.textContent = `Remind ${name} on WhatsApp`;
  box.hidden = false;
  speakShort(`${name} owes you ${fmt(owed)}. Do you want to remind ${name} now?`);
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
    msg = `That is ${total}. CountMy knows your shop now - come back tomorrow and it will tell you if you did better.`;
  } else if (left === 1) {
    msg = `That is ${total}. One more and CountMy can tell you if today beat yesterday.`;
  } else {
    msg = `That is ${total}. ${left} more and CountMy can tell you if today beat yesterday.`;
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
function speakShort(text) {
  if (!('speechSynthesis' in window)) return;
  try {
    const utter = speakClearly(new SpeechSynthesisUtterance(text));
    utter.rate = 0.85;
    speechSynthesis.cancel();
    speechSynthesis.speak(utter);
  } catch (e) { /* speech is a bonus, never a requirement */ }
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
  if (!entries.length) { alert('Nothing to back up yet.'); return; }
  const typeLabel = { sale: 'Sale', expense: 'Expense', debt_in: 'Owed to me', debt_out: 'I owe' };
  const ordered = entries.slice().reverse(); // oldest first, reads like a diary
  const MAX_LINES = 200; // keeps the WhatsApp message and its URL a sane length
  const shown = ordered.length > MAX_LINES ? ordered.slice(-MAX_LINES) : ordered;
  const lines = shown.map(e => {
    const cfg = FIELD_CONFIG[e.type];
    const when = new Date(e.ts).toLocaleDateString('en-GH', { day: 'numeric', month: 'short' });
    return `${when} - ${typeLabel[e.type]}: ${cfg.desc(e)} - ${fmt(e.amount)}`;
  });
  const shopName = getShopId() || 'My shop';
  const truncNote = shown.length < ordered.length ? ` (most recent ${MAX_LINES})` : '';
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
    .filter(e => e.type === 'sale' && e.ts >= yearAgo)
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const yearLine = `Total sales in the last 12 months: ${fmt(yearSales)}\n`;
  const text = `${shopName} records${truncNote}:\n\n${yearLine}\n${lines.join('\n')}${SHARE_FOOTER}`;
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
    if (!todayEntries.length) { alert('Nothing recorded today yet.'); return; }
    const typeLabel = { sale: 'Sale', expense: 'Expense', debt_in: 'Owed to me', debt_out: 'I owe' };
    const lines = todayEntries.map(e => {
      const cfg = FIELD_CONFIG[e.type];
      return `${typeLabel[e.type]}: ${cfg.desc(e)} - ${fmt(e.amount)}`;
    });
    const shopName = getShopId() || 'My shop';
    const text = `${shopName} - today's summary:\n\n${lines.join('\n')}${SHARE_FOOTER}`;
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
      const isNew = (Date.now() - firstSeenAt()) < FIRST_WEEK_MS && entries.length < FIRST_ENTRIES_TARGET;
      const nudge = document.getElementById('eveningNudge');
      if (isNew && nudge) {
        localStorage.setItem('kym_eod_prompted', today);
        nudge.hidden = false;
        track('evening_nudge');
        speakShort('What did you sell today? Tap the orange button and say it.');
      }
      return;
    }
    localStorage.setItem('kym_eod_prompted', today);
    const banner = document.getElementById('eodBanner');
    if (banner) banner.hidden = false;
  });
}

function updateOfflineBadge() {
  document.getElementById('offlineBadge').classList.toggle('show', !navigator.onLine);
}

// [data-type] only - the photo button (#snapBtn) shares .act-btn for its
// size and look but opens the camera, not a typed sheet.
document.querySelectorAll('.act-btn[data-type]').forEach(btn => {
  btn.addEventListener('click', () => openSheet(btn.dataset.type));
});
document.getElementById('cancelBtn').addEventListener('click', () => {
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
if (!('speechSynthesis' in window)) document.getElementById('hearBtn').style.display = 'none';
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
document.getElementById('homeMicBtn').addEventListener('click', () => {
  track('open_sheet', { type: 'home_mic' });
  toggleMic(document.getElementById('homeMicBtn'), 'homeMicStatus');
});
if (!micSupported()) {
  document.getElementById('homeMicBtn').style.display = 'none';
  document.querySelector('.or-row').style.display = 'none';
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
    if (cls === 'err' && 'speechSynthesis' in window) {
      const utter = speakClearly(new SpeechSynthesisUtterance(msg));
      utter.rate = 0.8;
      speechSynthesis.cancel();
      speechSynthesis.speak(utter);
    }
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
      say(`${seen}couldn\u2019t find any amounts in that photo. Please take it again in good light, close up, or type it with the buttons above.`, 'err');
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
  if (!('speechSynthesis' in window)) {
    demoBtn.style.display = 'none';
  } else {
    demoBtn.addEventListener('click', () => {
      track('demo_play');
      demoBtn.disabled = true;
      const micBtn = document.getElementById('homeMicBtn');
      micBtn.classList.add('demo-pulse');
      const utter = new SpeechSynthesisUtterance(
        'Watch this button. Tap it, then say what happened. Like this. I sold two shirts for ten cedis. Now you try.'
      );
      speakClearly(utter);
      const stop = () => { micBtn.classList.remove('demo-pulse'); demoBtn.disabled = false; };
      utter.onend = stop;
      utter.onerror = stop;
      speechSynthesis.cancel();
      speechSynthesis.speak(utter);
    });
  }
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
    if ('speechSynthesis' in window) {
      const utter = speakClearly(new SpeechSynthesisUtterance(`${label}: ${value}.`));
      utter.rate = 0.8;
      speechSynthesis.cancel();
      speechSynthesis.speak(utter);
    }
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
