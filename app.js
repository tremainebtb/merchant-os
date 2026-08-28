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

function addEntry(entry) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).add(entry);
    let reqError = null;
    req.onerror = (e) => { reqError = req.error; e.preventDefault(); tx.abort(); };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(reqError || tx.error || new Error('addEntry failed'));
    tx.onabort = () => reject(reqError || tx.error || new Error('addEntry aborted'));
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
    fields: [
      { key: 'item', label: 'What did you sell?', type: 'text' },
      { key: 'qty', label: 'How many?', type: 'number' },
      { key: 'price', label: 'Price each (cedis)', type: 'number' }
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
    fields: [
      { key: 'item', label: 'What did you spend on?', type: 'text' },
      { key: 'price', label: 'Amount (cedis)', type: 'number' }
    ],
    compute: v => Number(v.price) || 0,
    confirm: v => {
      if (!v.item || !v.price) return '';
      return `${v.item} \u2014 ${fmt(v.price)}`;
    },
    desc: v => v.item,
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
    desc: v => v.item + (v.note ? ' \u2014 ' + v.note : ''),
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
    desc: v => v.item + (v.note ? ' \u2014 ' + v.note : ''),
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

function setMicStatus(text, cls) {
  const el = document.getElementById('micStatus');
  el.textContent = text;
  el.className = 'mic-status' + (cls ? ' ' + cls : '');
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

const NUMBER_WORD_RE = new RegExp('\\b(?:' + Object.keys(NUMBER_WORDS).join('|') + ')(?:[\\s-]+(?:' + Object.keys(NUMBER_WORDS).join('|') + '))*\\b', 'gi');

function wordsToNumber(text) {
  return text.replace(NUMBER_WORD_RE, (phrase) => {
    const total = phrase.toLowerCase().split(/[\s-]+/).reduce((sum, w) => sum + (NUMBER_WORDS[w] || 0), 0);
    return String(total);
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

async function transcribeBlob(blob) {
  const form = new FormData();
  form.append('audio', blob, 'voice.webm');
  const res = await fetch(`${API_BASE}/transcribe`, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not hear that \u2014 try again');
  return data.text || '';
}

// Stage 2 of voice, added 27 Aug: a real merchant speaking naturally describes
// several things in one breath ("I sold three shoes... Kwame took two shirts...
// I spent 50 on transport"). The old approach forced them into one item per
// recording. This calls a free Workers AI text model (see worker.js) to split
// one messy transcript into several structured events. It is NOT trustworthy on
// its own - live-tested 27 Aug: it can invent a plausible-looking price for an
// amount that was never actually said. That is exactly why every extracted field
// is shown to the owner, editable, before anything saves - see showVoiceReview().
// Network failure or an empty result falls back to the old single-field-fill path
// (parseHeardText below) rather than leaving the owner stuck.
async function extractEvents(text) {
  const res = await fetch(`${API_BASE}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.events) ? data.events : [];
}

const TYPE_LABEL = { sale: 'Sale', expense: 'Expense', debt_in: 'Customer owes me', debt_out: 'I owe supplier' };

// Turns one extracted event into the same shape addEntry() expects, computing
// the amount ourselves from the (already type-checked, by the Worker) qty/price -
// never trusting a pre-computed "total" from the model, since that's one more
// number it could get wrong independent of the two the owner can actually verify.
function eventToEntry(ev) {
  const type = ev.type;
  const item = ev.item || ev.customer || ev.supplier || '';
  const qty = type === 'sale' ? (ev.qty || 1) : '';
  const price = ev.price || '';
  const amount = type === 'sale' ? (Number(qty) || 0) * (Number(price) || 0) : (Number(price) || 0);
  return { type, item, note: ev.note || '', qty, price, amount };
}

function voiceEventComplete(ev) {
  if (!ev.item) return false;
  if (!ev.price || Number(ev.price) <= 0) return false;
  if (ev.type === 'sale' && (!ev.qty || Number(ev.qty) <= 0)) return false;
  return true;
}

let pendingVoiceEvents = [];

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
  const caption = has ? 'AI heard this - check it' : "Didn't catch this - tap to enter";
  return `<div class="field ${cls}">
      <input type="${type}" ${extraAttrs || ''} data-idx="${idx}" data-key="${key}" value="${has ? String(value).replace(/"/g, '&quot;') : ''}" placeholder="${has ? '' : 'tap to enter'}" data-clarity-mask="True">
      <div class="field-caption">${caption}</div>
    </div>`;
}

function renderVoiceReview() {
  const list = document.getElementById('voiceReviewList');
  const wrap = document.getElementById('voiceReview');
  if (!pendingVoiceEvents.length) { wrap.classList.remove('open'); return; }
  wrap.classList.add('open');
  list.innerHTML = pendingVoiceEvents.map((ev, i) => {
    const nameLabel = ev.type === 'debt_in' ? 'Customer name' : ev.type === 'debt_out' ? 'Supplier name' : 'What';
    const priceLabel = ev.type === 'sale' ? 'Price each (cedis)' : 'Amount (cedis)';
    const ready = voiceEventComplete(ev);
    return `
      <div class="voice-card">
        <div class="voice-card-type">
          <span>${TYPE_LABEL[ev.type] || ev.type}</span>
          <span class="voice-card-status ${ready ? 'ready' : 'pending'}">${ready ? 'Ready' : 'Needs a number'}</span>
        </div>
        <label class="field-label">${nameLabel}</label>
        ${fieldMarkup(ev.item, i, 'item', 'text')}
        ${ev.type === 'sale' ? `<label class="field-label">How many?</label>${fieldMarkup(ev.qty, i, 'qty', 'number', 'inputmode="decimal"')}` : ''}
        <label class="field-label">${priceLabel}</label>
        ${fieldMarkup(ev.price, i, 'price', 'number', 'inputmode="decimal"')}
        <div class="voice-card-btns">
          <button class="btn btn-cancel voice-discard" data-idx="${i}">Discard</button>
          <button class="btn btn-save voice-save" data-idx="${i}">Save</button>
        </div>
      </div>`;
  }).join('');
  list.querySelectorAll('input').forEach(inp => inp.addEventListener('input', (e) => {
    const { idx, key } = e.target.dataset;
    pendingVoiceEvents[idx][key] = e.target.value;
  }));
  list.querySelectorAll('.voice-discard').forEach(btn => btn.addEventListener('click', (e) => {
    pendingVoiceEvents.splice(Number(e.target.dataset.idx), 1);
    renderVoiceReview();
  }));
  list.querySelectorAll('.voice-save').forEach(btn => btn.addEventListener('click', async (e) => {
    const idx = Number(e.target.dataset.idx);
    const ev = pendingVoiceEvents[idx];
    if (!voiceEventComplete(ev)) { alert('Fill in the missing number(s) first.'); return; }
    const entry = eventToEntry(ev);
    const ts = Date.now();
    await addEntry({ id: crypto.randomUUID(), type: entry.type, item: entry.item, note: entry.note, qty: entry.qty, price: entry.price, amount: entry.amount, source: 'voice', day: todayKey(ts), ts });
    track('save_entry', { type: entry.type, source: 'voice' });
    ping('save');
    pendingVoiceEvents.splice(idx, 1);
    renderVoiceReview();
    await render();
  }));
}

document.getElementById('voiceReviewCloseBtn').addEventListener('click', () => {
  pendingVoiceEvents = [];
  renderVoiceReview();
});

async function toggleMic() {
  const btn = document.getElementById('micBtn');
  if (!micSupported()) {
    setMicStatus('Voice isn\u2019t available on this phone/browser \u2014 please type instead.', 'err');
    return;
  }
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      btn.classList.remove('recording');
      setMicStatus('Listening to what you said\u2026');
      try {
        const blob = new Blob(recordedChunks, { type: 'audio/webm' });
        const heard = await transcribeBlob(blob);
        if (!heard.trim()) { track('mic_error', { reason: 'no_transcript' }); setMicStatus('Didn\u2019t catch that \u2014 try again, or type below.', 'err'); return; }
        setMicStatus('Working out what happened\u2026');
        const events = await extractEvents(heard);
        track('voice_extracted', { event_count: events.length });
        if (events.length >= 1) {
          pendingVoiceEvents = events;
          renderVoiceReview();
          closeSheet();
          setMicStatus(`Heard: \u201c${heard}\u201d \u2014 check each one below, then Save.`, 'heard');
        } else {
          fillFields(parseHeardText(activeType, heard));
          sheetVoiceFilled = true;
          setMicStatus(`Heard: \u201c${heard}\u201d \u2014 check the numbers below, then Save.`, 'heard');
        }
      } catch (err) {
        track('mic_error', { reason: 'transcribe_failed' });
        setMicStatus(err.message || 'Could not hear that \u2014 try again, or type below.', 'err');
      }
    };
    mediaRecorder.start();
    btn.classList.add('recording');
    track('mic_start');
    setMicStatus('Listening\u2026 tap again when you\u2019re done speaking.');
  } catch (err) {
    setMicStatus('Couldn\u2019t reach the microphone \u2014 check phone permission, or type below.', 'err');
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

// Sent only when a Shop ID is set - this is how Bobby, as owner, counts
// distinct businesses and usage over time from server logs. Only a one-way
// hash of the shop id and an event type ever leaves this call - never an
// item, price, customer name, or the shop id itself in plain text (the
// Worker hashes it before it touches storage). Fire-and-forget: never
// blocks the UI, never retried, silently no-ops offline or on any failure -
// this is a directional usage signal, not a source of truth for the
// merchant's own ledger, which stays local per PRD.
function ping(eventType) {
  const shop = getShopId();
  if (!shop || !navigator.onLine) return;
  fetch(`${API_BASE}/ping`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shop, event: eventType })
  }).catch(() => {});
}

function openSheet(type) {
  track('open_sheet', { type });
  activeType = type;
  sheetVoiceFilled = false;
  const cfg = FIELD_CONFIG[type];
  document.getElementById('sheetTitle').textContent = cfg.title;
  const fieldsEl = document.getElementById('fields');
  fieldsEl.innerHTML = cfg.fields.map(f => `
    <div class="field">
      <label>${f.label}</label>
      <input type="${f.type}" inputmode="${f.type === 'number' ? 'decimal' : 'text'}" data-key="${f.key}" autocomplete="off" data-clarity-mask="True">
    </div>
  `).join('');
  fieldsEl.querySelectorAll('input').forEach(inp => inp.addEventListener('input', updateConfirm));
  document.getElementById('confirmLine').classList.remove('show');
  setMicStatus('Tap the mic and say ONE item and its price, then check the numbers before saving.');
  document.getElementById('sheet').classList.add('open');
  document.getElementById('sheet').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  fieldsEl.querySelector('input').focus();
}

function closeSheet() {
  document.getElementById('sheet').classList.remove('open');
  if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
  activeType = null;
}

function readValues() {
  const v = {};
  document.querySelectorAll('#fields input').forEach(inp => { v[inp.dataset.key] = inp.value; });
  return v;
}

function updateConfirm() {
  const cfg = FIELD_CONFIG[activeType];
  const v = readValues();
  const line = cfg.confirm(v);
  const el = document.getElementById('confirmLine');
  if (line) { el.textContent = line + ' \u2014 correct?'; el.classList.add('show'); }
  else { el.classList.remove('show'); }
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
  const ts = Date.now();
  // Client-generated id, not IndexedDB autoIncrement \u2014 this is the idempotency key.
  // Defense in depth beyond the button-disable above: if this same save ever got
  // dispatched twice (a future sync retry, a bug), the store rejects the duplicate
  // key instead of silently creating a second transaction. Kept simple deliberately \u2014
  // no backend to reconcile against yet, so this only protects the local device today,
  // but the id shape is what a future sync layer would need anyway.
  const id = crypto.randomUUID();
  try {
    await addEntry({
      id,
      type: activeType,
      item: v.item,
      note: v.note || '',
      qty: v.qty || '',
      price: v.price || '',
      amount: amount,
      source: sheetVoiceFilled ? 'voice' : 'manual',
      day: todayKey(ts),
      ts
    });
    track('save_entry', { type: activeType, source: sheetVoiceFilled ? 'voice' : 'manual' });
    ping('save');
    closeSheet();
    await render();
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
  document.getElementById('planPill').textContent = paid ? 'Paid \u00b7 everything you have recorded' : 'Free \u00b7 shows your last 7 days';
  const shopInput = document.getElementById('shopIdInput');
  if (shopInput && document.activeElement !== shopInput) shopInput.value = getShopId();
}

async function render() {
  const entries = await getAllEntries();
  const today = todayKey(Date.now());
  const todayEntries = entries.filter(e => e.day === today);
  renderAdmin();

  const sales = todayEntries.filter(e => e.type === 'sale').reduce((s, e) => s + e.amount, 0);
  const expenses = todayEntries.filter(e => e.type === 'expense').reduce((s, e) => s + e.amount, 0);
  const owedMe = entries.filter(e => e.type === 'debt_in').reduce((s, e) => s + e.amount, 0)
               - entries.filter(e => e.type === 'debt_in' && e.settled).reduce((s, e) => s + e.amount, 0);
  const balance = sales - expenses;

  document.getElementById('tSales').textContent = fmt(sales);
  document.getElementById('tExpenses').textContent = fmt(expenses);
  document.getElementById('tOwedMe').textContent = fmt(owedMe);
  const balanceEl = document.getElementById('tBalance');
  balanceEl.textContent = fmt(balance);
  balanceEl.classList.toggle('pos', balance >= 0);
  balanceEl.classList.toggle('neg', balance < 0);
  window._kymToday = { sales, expenses, owedMe, balance };

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
    const remind = e.type === 'debt_in'
      ? `<a class="remind-btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(`Hello ${e.item}, your balance is ${fmt(e.amount)}${e.note ? ' for ' + e.note : ''}. Please send by MoMo when you can. Thank you.`)}">Remind on WhatsApp</a>`
      : '';
    return `<div class="hist-item">
      <div class="desc" data-clarity-mask="True">${cfg.desc(e)}<small>${when}</small>${remind}</div>
      <div class="amt ${cls}" data-clarity-mask="True">${sign}${fmt(e.amount)}</div>
    </div>`;
  }).join('') + (hiddenCount > 0 ? `<div class="empty">${hiddenCount} older entr${hiddenCount === 1 ? 'y' : 'ies'} \u2014 go Paid to see your full history</div>` : '');
}

// Reads today's numbers aloud. Evidence for this over text-only: Viamo's Ghana voice
// campaign reached ~37,000 customers with weekly voice calls \u2014 those who engaged with
// 6+ of 10 calls saw mobile savings balances nearly double. Numbers, spoken, drive
// behaviour for people who don't reliably read English prose. English-only for now \u2014
// a Twi/Pidgin voice would need real translation + testing with real shop owners
// first, not an invented script.
function speakToday() {
  if (!('speechSynthesis' in window)) return;
  const t = window._kymToday || { sales: 0, expenses: 0, owedMe: 0, balance: 0 };
  // Matches the on-screen labels word for word \u2014 hearing something different from
  // what's on the screen is confusing, not helpful. Short, plain sentences, slow
  // pace \u2014 this is read aloud, not read silently.
  const text = `Today. Sales: ${fmt(t.sales)}. Expenses: ${fmt(t.expenses)}. `
    + `Customers owe you: ${fmt(t.owedMe)}. Sales minus expenses: ${fmt(t.balance)}.`;
  const utter = new SpeechSynthesisUtterance(text);
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

// Real answer to "what if the phone is lost" without building a sync backend or
// asking a Makola market trader to understand a file system. WhatsApp is the one
// app almost every Ghanaian shop owner already knows how to use, so this opens
// WhatsApp directly with a plain, readable list of records pre-filled - no OS
// share-sheet picker (AirDrop/Messages/Mail/etc, which tested as genuinely
// confusing for older, less tech-familiar users), no file, no "what is a CSV."
// She sends it to herself or a family member and that's the backup, done.
async function exportBackup() {
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
  const text = `${shopName} records${truncNote}:\n\n${lines.join('\n')}`;
  window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
}

function updateOfflineBadge() {
  document.getElementById('offlineBadge').classList.toggle('show', !navigator.onLine);
}

document.querySelectorAll('.act-btn').forEach(btn => {
  btn.addEventListener('click', () => openSheet(btn.dataset.type));
});
document.getElementById('cancelBtn').addEventListener('click', closeSheet);
document.getElementById('saveBtn').addEventListener('click', saveEntry);
document.getElementById('hearBtn').addEventListener('click', speakToday);
if (!('speechSynthesis' in window)) document.getElementById('hearBtn').style.display = 'none';
document.getElementById('planPill').addEventListener('click', () => document.getElementById('planSheet').classList.add('open'));
document.getElementById('planCloseBtn').addEventListener('click', () => document.getElementById('planSheet').classList.remove('open'));
document.getElementById('exportBtn').addEventListener('click', exportBackup);
document.getElementById('micBtn').addEventListener('click', toggleMic);
if (!micSupported()) document.getElementById('micBtn').style.display = 'none';
document.getElementById('shopIdInput').addEventListener('change', async (e) => {
  setShopId(e.target.value);
  ping('open');
  await refreshPaidStatus();
  await render();
});
window.addEventListener('online', () => { updateOfflineBadge(); refreshPaidStatus(); });
window.addEventListener('offline', updateOfflineBadge);
// Re-render whenever the tab comes back into view - the real bug this fixes:
// a shop owner who locks their phone at night with the app already open and
// reopens it the next morning (without a full app close) was seeing yesterday's
// "Today" totals frozen on screen, because render() only ever ran at load and
// after a save. Today's date, and everything derived from it, is now always
// recomputed the moment the app is looked at again.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') render();
});

(async function init() {
  db = await openDB();
  updateOfflineBadge();
  await render();
  refreshPaidStatus();
  ping('open');
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
})();
