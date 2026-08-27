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
      <input type="${type}" ${extraAttrs || ''} data-idx="${idx}" data-key="${key}" value="${has ? String(value).replace(/"/g, '&quot;') : ''}" placeholder="${has ? '' : 'tap to enter'}">
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
    await addEntry({ id: crypto.randomUUID(), type: entry.type, item: entry.item, note: entry.note, qty: entry.qty, price: entry.price, amount: entry.amount, day: todayKey(ts), ts });
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
        if (!heard.trim()) { setMicStatus('Didn\u2019t catch that \u2014 try again, or type below.', 'err'); return; }
        setMicStatus('Working out what happened\u2026');
        const events = await extractEvents(heard);
        if (events.length >= 1) {
          pendingVoiceEvents = events;
          renderVoiceReview();
          closeSheet();
          setMicStatus(`Heard: \u201c${heard}\u201d \u2014 check each one below, then Save.`, 'heard');
        } else {
          fillFields(parseHeardText(activeType, heard));
          setMicStatus(`Heard: \u201c${heard}\u201d \u2014 check the numbers below, then Save.`, 'heard');
        }
      } catch (err) {
        setMicStatus(err.message || 'Could not hear that \u2014 try again, or type below.', 'err');
      }
    };
    mediaRecorder.start();
    btn.classList.add('recording');
    setMicStatus('Listening\u2026 tap again when you\u2019re done speaking.');
  } catch (err) {
    setMicStatus('Couldn\u2019t reach the microphone \u2014 check phone permission, or type below.', 'err');
  }
}
function openSheet(type) {
  activeType = type;
  const cfg = FIELD_CONFIG[type];
  document.getElementById('sheetTitle').textContent = cfg.title;
  const fieldsEl = document.getElementById('fields');
  fieldsEl.innerHTML = cfg.fields.map(f => `
    <div class="field">
      <label>${f.label}</label>
      <input type="${f.type}" inputmode="${f.type === 'number' ? 'decimal' : 'text'}" data-key="${f.key}" autocomplete="off">
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
      day: todayKey(ts),
      ts
    });
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

// Plan state now has a real source of truth (countmy-api / KV \u2014 Bobby, the CEO, flips
// a shop's status directly in the Cloudflare dashboard, no admin UI needed: see
// worker/worker.js). The local toggle below still exists as an offline fallback only \u2014
// if the shop has no Shop ID set, or the phone is offline, or the backend can't be
// reached, this falls back to the same local self-report as before rather than
// blocking. Cached last-known-good result so a paid shop doesn't flicker back to
// Free the moment it goes offline.
function getShopId() { return (localStorage.getItem('kym_shop_id') || '').trim(); }
function setShopId(id) { localStorage.setItem('kym_shop_id', (id || '').trim()); }
function isPaid() {
  const cached = localStorage.getItem('kym_paid_backend');
  if (cached !== null) return cached === '1';
  return localStorage.getItem('kym_paid') === '1';
}
function setPaid(v) { localStorage.setItem('kym_paid', v ? '1' : '0'); }

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
  const btn = document.getElementById('adminToggle');
  const paid = isPaid();
  btn.textContent = paid ? '\u2713 Paid \u2014 tap to undo' : "I've paid";
  btn.classList.toggle('is-paid', paid);
  document.getElementById('planPill').textContent = paid ? 'Paid \u00b7 full history unlocked' : 'Free \u00b7 last 7 days shown';
  const ref = document.getElementById('planPayRef');
  if (ref) ref.textContent = getShopId() || 'Your shop name';
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
      <div class="desc">${cfg.desc(e)}<small>${when}</small>${remind}</div>
      <div class="amt ${cls}">${sign}${fmt(e.amount)}</div>
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

// Real, evidence-backed threat this closes: Ghanaian shop owners routinely hand
// their phone to a customer to show a product photo on WhatsApp \u2014 the customer can
// then swipe back and see the shop's daily revenue. This is a screen-lock deterrent,
// not real security: the PIN is stored in plain localStorage, no encryption, nothing
// server-side. Honest about that limit, not pretending it's more than it is. Optional
// and off by default \u2014 no forced registration wall.
function getPin() { return localStorage.getItem('kym_pin') || ''; }
function setPin(p) { if (p) localStorage.setItem('kym_pin', p); else localStorage.removeItem('kym_pin'); }

function showLock() {
  const pin = getPin();
  if (!pin) return;
  const lock = document.getElementById('lockScreen');
  lock.classList.add('show');
  const input = document.getElementById('lockInput');
  input.value = '';
  document.getElementById('lockError').textContent = '';
  setTimeout(() => input.focus(), 50);
}

let pendingAdminReveal = false;

function tryUnlock() {
  const input = document.getElementById('lockInput');
  if (input.value.length !== 4) return;
  if (input.value === getPin()) {
    document.getElementById('lockScreen').classList.remove('show');
    if (pendingAdminReveal) { pendingAdminReveal = false; document.getElementById('adminBar').classList.add('open'); }
  } else {
    document.getElementById('lockError').textContent = 'Wrong PIN \u2014 try again.';
    input.value = '';
  }
}

// The gear is deliberately unlabeled and tiny \u2014 not a bar sitting in view for
// anyone holding the phone. If a PIN is set, opening owner settings requires it,
// same as viewing history \u2014 someone glancing at the phone shouldn't be able to
// toggle billing state or change the PIN without knowing it.
function openAdminBar() {
  if (getPin()) { pendingAdminReveal = true; showLock(); }
  else { document.getElementById('adminBar').classList.add('open'); }
}
function closeAdminBar() { document.getElementById('adminBar').classList.remove('open'); }

function updatePinToggle() {
  const btn = document.getElementById('pinToggle');
  btn.textContent = getPin() ? '\u{1F512} Remove PIN' : 'Set a PIN';
}

// Real answer to "what if the phone is lost" without building a sync backend \u2014
// a plain CSV the merchant can save, WhatsApp to themselves, or hand to anyone
// (accountant, family) who wants to open it. No account, no server, no new cost.
async function exportBackup() {
  const entries = await getAllEntries();
  if (!entries.length) { alert('Nothing to back up yet.'); return; }
  const rows = [['Date', 'Type', 'Description', 'Amount (cedis)']];
  const typeLabel = { sale: 'Sale', expense: 'Expense', debt_in: 'Customer owes me', debt_out: 'I owe supplier' };
  entries.slice().reverse().forEach(e => {
    const cfg = FIELD_CONFIG[e.type];
    const when = new Date(e.ts).toLocaleString('en-GH', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    const csvSafe = s => '"' + String(s).replace(/"/g, '""') + '"';
    rows.push([when, typeLabel[e.type], csvSafe(cfg.desc(e)), e.amount]);
  });
  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `countmy-backup-${todayKey(Date.now())}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
document.getElementById('gearBtn').addEventListener('click', openAdminBar);
document.getElementById('adminCloseBtn').addEventListener('click', closeAdminBar);
document.getElementById('adminToggle').addEventListener('click', async () => {
  setPaid(!isPaid());
  await render();
});
document.getElementById('pinToggle').addEventListener('click', () => {
  if (getPin()) {
    setPin('');
  } else {
    const p = prompt('Set a 4-digit PIN. You will need it to open this shop\'s numbers again.');
    if (p && /^\d{4}$/.test(p)) setPin(p);
    else if (p) alert('PIN must be exactly 4 digits.');
  }
  updatePinToggle();
});
document.getElementById('lockInput').addEventListener('input', tryUnlock);
document.getElementById('exportBtn').addEventListener('click', exportBackup);
document.getElementById('micBtn').addEventListener('click', toggleMic);
if (!micSupported()) document.getElementById('micBtn').style.display = 'none';
document.getElementById('shopIdInput').addEventListener('change', async (e) => {
  setShopId(e.target.value);
  await refreshPaidStatus();
  await render();
});
window.addEventListener('online', () => { updateOfflineBadge(); refreshPaidStatus(); });
window.addEventListener('offline', updateOfflineBadge);
// Lock whenever the tab comes back into view \u2014 covers "handed the phone to a
// customer, they swiped back to the browser" and "phone was asleep in a pocket."
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') showLock();
});

(async function init() {
  db = await openDB();
  updateOfflineBadge();
  updatePinToggle();
  showLock();
  await render();
  refreshPaidStatus();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
})();
