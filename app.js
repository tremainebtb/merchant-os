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
    tx.objectStore(STORE).add(entry);
    tx.oncomplete = () => resolve();
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
  try {
    await addEntry({
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
window.addEventListener('online', updateOfflineBadge);
window.addEventListener('offline', updateOfflineBadge);

(async function init() {
  db = await openDB();
  updateOfflineBadge();
  await render();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
})();
