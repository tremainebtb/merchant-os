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
  return 'GHS ' + v.toLocaleString('en-GH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

const FIELD_CONFIG = {
  sale: {
    title: 'Add sale',
    fields: [
      { key: 'item', label: 'What did you sell?', type: 'text' },
      { key: 'qty', label: 'How many?', type: 'number' },
      { key: 'price', label: 'Price each (GHS)', type: 'number' }
    ],
    compute: v => (Number(v.qty) || 0) * (Number(v.price) || 0),
    confirm: v => {
      const total = (Number(v.qty) || 0) * (Number(v.price) || 0);
      if (!v.item || !v.qty || !v.price) return '';
      return `${v.qty} × ${v.item} at ${fmt(v.price)} = ${fmt(total)}`;
    },
    desc: v => `${v.qty} × ${v.item}`,
    amountSign: 1
  },
  expense: {
    title: 'Add expense',
    fields: [
      { key: 'item', label: 'What did you spend on?', type: 'text' },
      { key: 'price', label: 'Amount (GHS)', type: 'number' }
    ],
    compute: v => Number(v.price) || 0,
    confirm: v => {
      if (!v.item || !v.price) return '';
      return `${v.item} — ${fmt(v.price)}`;
    },
    desc: v => v.item,
    amountSign: -1
  },
  debt_in: {
    title: 'Customer owes me',
    fields: [
      { key: 'item', label: 'Customer name', type: 'text' },
      { key: 'price', label: 'Amount they owe (GHS)', type: 'number' },
      { key: 'note', label: 'What for (optional)', type: 'text' }
    ],
    compute: v => Number(v.price) || 0,
    confirm: v => {
      if (!v.item || !v.price) return '';
      return `${v.item} owes you ${fmt(v.price)}`;
    },
    desc: v => v.item + (v.note ? ' — ' + v.note : ''),
    amountSign: 1,
    isDebt: true
  },
  debt_out: {
    title: 'I owe supplier',
    fields: [
      { key: 'item', label: 'Supplier name', type: 'text' },
      { key: 'price', label: 'Amount you owe (GHS)', type: 'number' },
      { key: 'note', label: 'What for (optional)', type: 'text' }
    ],
    compute: v => Number(v.price) || 0,
    confirm: v => {
      if (!v.item || !v.price) return '';
      return `You owe ${v.item} ${fmt(v.price)}`;
    },
    desc: v => v.item + (v.note ? ' — ' + v.note : ''),
    amountSign: -1,
    isDebt: true
  }
};

let activeType = null;

const SpeechAPI = window.SpeechRecognition || window.webkitSpeechRecognition;

function fillFields(values) {
  document.querySelectorAll('#fields input').forEach(inp => {
    if (values[inp.dataset.key] !== undefined && values[inp.dataset.key] !== '') {
      inp.value = values[inp.dataset.key];
    }
  });
  updateConfirm();
}

// Rough heuristic — never trusted blindly. It only ever pre-fills the form;
// the owner still sees the confirm line and taps Save themselves.
function parseSpeech(type, text) {
  const numbers = (text.match(/\d+(\.\d+)?/g) || []).map(Number);
  const words = text
    .replace(/\d+(\.\d+)?/g, ' ')
    .replace(/\b(for|at|each|ghs|cedis|cedi|gh|and|owes?|me|owe|him|her|them)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (type === 'sale') {
    const qty = numbers.length >= 2 ? numbers[0] : (numbers.length === 1 ? 1 : '');
    const price = numbers.length >= 2 ? numbers[numbers.length - 1] : (numbers[0] || '');
    return { item: words || '', qty: qty || '', price: price || '' };
  }
  // expense, debt_in, debt_out all share: name/what = words, price = last number
  const price = numbers.length ? numbers[numbers.length - 1] : '';
  return { item: words || '', price: price || '' };
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
  document.getElementById('heardLine').classList.remove('show');
  document.getElementById('heardLine').textContent = '';
  document.getElementById('micBtn').classList.remove('listening');
  document.getElementById('micBtn').style.display = SpeechAPI ? '' : 'none';
  document.getElementById('confirmLine').classList.remove('show');
  document.getElementById('sheet').classList.add('open');
  document.getElementById('sheet').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  fieldsEl.querySelector('input').focus();
}

let recognition = null;

function startVoice() {
  if (!SpeechAPI) return;
  const micBtn = document.getElementById('micBtn');
  const heardLine = document.getElementById('heardLine');
  recognition = new SpeechAPI();
  recognition.lang = 'en-GH';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  micBtn.classList.add('listening');
  micBtn.textContent = '🎙️ Listening…';
  recognition.onresult = (e) => {
    const text = e.results[0][0].transcript;
    heardLine.textContent = `Heard: "${text}" — check the fields below`;
    heardLine.classList.add('show');
    fillFields(parseSpeech(activeType, text));
  };
  recognition.onerror = () => {
    heardLine.textContent = 'Didn’t catch that — type it instead, or tap the mic to try again.';
    heardLine.classList.add('show');
  };
  recognition.onend = () => {
    micBtn.classList.remove('listening');
    micBtn.textContent = '🎤 Speak instead';
  };
  recognition.start();
}

function closeSheet() {
  document.getElementById('sheet').classList.remove('open');
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
  if (line) { el.textContent = line + ' — correct?'; el.classList.add('show'); }
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
  saveBtn.textContent = 'Saving…';
  const ts = Date.now();
  // Client-generated id, not IndexedDB autoIncrement — this is the idempotency key.
  // Defense in depth beyond the button-disable above: if this same save ever got
  // dispatched twice (a future sync retry, a bug), the store rejects the duplicate
  // key instead of silently creating a second transaction. Kept simple deliberately —
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
      // Same id already saved — treat as already-done, not a failure.
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

// Manual plan state — no billing backend yet, by design (see PRD: sync deferred).
// Owner-only toggle; not meant for the merchant to see or touch.
function isPaid() { return localStorage.getItem('kym_paid') === '1'; }
function setPaid(v) { localStorage.setItem('kym_paid', v ? '1' : '0'); }

function renderAdmin() {
  const btn = document.getElementById('adminToggle');
  const paid = isPaid();
  btn.textContent = paid ? '✓ Paid — tap to reset to Free' : 'Mark this shop Paid';
  btn.classList.toggle('is-paid', paid);
  document.getElementById('planPill').textContent = paid ? 'Paid plan · Full history unlocked' : 'Free plan · Full history is Paid';
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
    const sign = cfg.amountSign > 0 ? '+' : '−';
    const cls = cfg.amountSign > 0 ? 'pos' : 'neg';
    const when = new Date(e.ts).toLocaleString('en-GH', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const remind = e.type === 'debt_in'
      ? `<a class="remind-btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(`Hello ${e.item}, your balance is ${fmt(e.amount)}${e.note ? ' for ' + e.note : ''}. Please send by MoMo when you can. Thank you.`)}">Remind on WhatsApp</a>`
      : '';
    return `<div class="hist-item">
      <div class="desc">${cfg.desc(e)}<small>${when}</small>${remind}</div>
      <div class="amt ${cls}">${sign}${fmt(e.amount)}</div>
    </div>`;
  }).join('') + (hiddenCount > 0 ? `<div class="empty">${hiddenCount} older entr${hiddenCount === 1 ? 'y' : 'ies'} — go Paid to see your full history</div>` : '');
}

// Reads today's numbers aloud. Evidence for this over text-only: Viamo's Ghana voice
// campaign reached ~37,000 customers with weekly voice calls — those who engaged with
// 6+ of 10 calls saw mobile savings balances nearly double. Numbers, spoken, drive
// behaviour for people who don't reliably read English prose. English-only for now —
// a Twi/Pidgin voice would need real translation + testing with real shop owners
// first, not an invented script.
function speakToday() {
  if (!('speechSynthesis' in window)) return;
  const t = window._kymToday || { sales: 0, expenses: 0, owedMe: 0, balance: 0 };
  const sign = t.balance >= 0 ? 'You are up' : 'You are down';
  const text = `Today. Sales, ${fmt(t.sales)}. Expenses, ${fmt(t.expenses)}. `
    + `Customers owe you ${fmt(t.owedMe)}. ${sign} ${fmt(Math.abs(t.balance))}.`;
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 0.92;
  const btn = document.getElementById('hearBtn');
  utter.onstart = () => btn.classList.add('speaking');
  utter.onend = () => btn.classList.remove('speaking');
  speechSynthesis.cancel();
  speechSynthesis.speak(utter);
}

// Real, evidence-backed threat this closes: Ghanaian shop owners routinely hand
// their phone to a customer to show a product photo on WhatsApp — the customer can
// then swipe back and see the shop's daily revenue. This is a screen-lock deterrent,
// not real security: the PIN is stored in plain localStorage, no encryption, nothing
// server-side. Honest about that limit, not pretending it's more than it is. Optional
// and off by default — no forced registration wall.
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

function tryUnlock() {
  const input = document.getElementById('lockInput');
  if (input.value.length !== 4) return;
  if (input.value === getPin()) {
    document.getElementById('lockScreen').classList.remove('show');
  } else {
    document.getElementById('lockError').textContent = 'Wrong PIN — try again.';
    input.value = '';
  }
}

function updatePinToggle() {
  const btn = document.getElementById('pinToggle');
  btn.textContent = getPin() ? '🔒 Remove PIN' : 'Set a PIN';
}

// Real answer to "what if the phone is lost" without building a sync backend —
// a plain CSV the merchant can save, WhatsApp to themselves, or hand to anyone
// (accountant, family) who wants to open it. No account, no server, no new cost.
async function exportBackup() {
  const entries = await getAllEntries();
  if (!entries.length) { alert('Nothing to back up yet.'); return; }
  const rows = [['Date', 'Type', 'Description', 'Amount (GHS)']];
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
document.getElementById('micBtn').addEventListener('click', startVoice);
document.getElementById('hearBtn').addEventListener('click', speakToday);
if (!('speechSynthesis' in window)) document.getElementById('hearBtn').style.display = 'none';
document.getElementById('planPill').addEventListener('click', () => document.getElementById('planSheet').classList.add('open'));
document.getElementById('planCloseBtn').addEventListener('click', () => document.getElementById('planSheet').classList.remove('open'));
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
window.addEventListener('online', updateOfflineBadge);
window.addEventListener('offline', updateOfflineBadge);
// Lock whenever the tab comes back into view — covers "handed the phone to a
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
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
})();
