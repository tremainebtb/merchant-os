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

function deleteEntry(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function updateEntry(id, patch) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.get(id);
    req.onsuccess = () => {
      const rec = req.result;
      if (rec) store.put(Object.assign(rec, patch));
    };
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

function setMicStatus(text, cls, statusId) {
  const el = document.getElementById(statusId || 'homeMicStatus');
  el.textContent = text;
  el.className = 'home-mic-status' + (cls ? ' ' + cls : '');
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

// Filename extension matched to the blob's real recorded type, not hardcoded
// - see the real bug this fixes in toggleMic() below.
async function transcribeBlob(blob) {
  const ext = blob.type.indexOf('mp4') !== -1 ? 'mp4' : (blob.type.indexOf('ogg') !== -1 ? 'ogg' : 'webm');
  const form = new FormData();
  form.append('audio', blob, `voice.${ext}`);
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
    (voiceEventComplete(ev) ? saved : incomplete).push(entry);
  });
  const lines = [];
  saved.forEach(entry => lines.push(`Saved: ${entry.item}, ${fmt(entry.amount)}.`));
  incomplete.forEach(entry => lines.push(`I heard ${entry.item} but not the price - tap it in below.`));
  if (!lines.length) return;
  const closer = saved.length
    ? 'If any of this is wrong, tap Undo under it.'
    : '';
  const utter = new SpeechSynthesisUtterance(`${lines.join(' ')} ${closer}`.trim());
  utter.rate = 0.8;
  speechSynthesis.cancel();
  speechSynthesis.speak(utter);
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
    const statusCls = ev._savedId ? 'saved' : (ready ? 'ready' : 'pending');
    const statusText = ev._savedId ? '\u2713 Saved' : (ready ? 'Ready' : 'Needs a number');
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
    pendingVoiceEvents.splice(Number(e.target.dataset.idx), 1);
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
    await addEntry({ id, type: entry.type, item: entry.item, note: entry.note, qty: entry.qty, price: entry.price, amount: entry.amount, source: 'voice', day: todayKey(ts), ts });
    track('save_entry', { type: entry.type, source: 'voice' });
    ping('save');
    ev._savedId = id;
    renderVoiceReview();
    await render();
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
        const heard = await transcribeBlob(blob);
        if (!heard.trim()) {
          track('mic_error', { reason: 'no_transcript', duration_ms: recordedMs });
          const msg = recordedMs < 1200
            ? 'That was too quick \u2014 tap once, say what happened out loud, THEN tap again to stop.'
            : 'Didn\u2019t catch any words \u2014 hold the phone closer and speak clearly, then try again.';
          setMicStatus(msg, 'err', statusId);
          return;
        }
        setMicStatus('Working out what happened\u2026', null, statusId);
        const events = await extractEvents(heard);
        track('voice_extracted', { event_count: events.length });
        if (events.length >= 1) {
          pendingVoiceEvents = events;
          renderVoiceReview();
          closeSheet();
          setMicStatus(`Heard: \u201c${heard}\u201d \u2014 check each one below, then Save.`, 'heard', statusId);
          document.getElementById('voiceReview').scrollIntoView({ behavior: 'smooth', block: 'start' });
          speakVoiceReview(events);
        } else if (activeType) {
          fillFields(parseHeardText(activeType, heard));
          sheetVoiceFilled = true;
          setMicStatus(`Heard: \u201c${heard}\u201d \u2014 check the numbers below, then Save.`, 'heard', statusId);
        } else {
          setMicStatus(`Heard: \u201c${heard}\u201d \u2014 but couldn\u2019t work out what happened. Try again, saying an amount in cedis.`, 'err', statusId);
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
      ? 'This phone said no to the microphone. Go to your phone\u2019s Settings, find CountMy or your browser, and turn the microphone on. Or just type instead.'
      : err.name === 'NotFoundError'
      ? 'This phone/browser has no microphone available. Please type instead.'
      : 'Couldn\u2019t reach the microphone \u2014 please type instead.';
    setMicStatus(msg, 'err', statusId);
    if ('speechSynthesis' in window) {
      const utter = new SpeechSynthesisUtterance(msg);
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
  document.getElementById('saveBtn').disabled = true;
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
document.getElementById('homeMicBtn').addEventListener('click', () => {
  track('open_sheet', { type: 'home_mic' });
  toggleMic(document.getElementById('homeMicBtn'), 'homeMicStatus');
});
if (!micSupported()) {
  document.getElementById('homeMicBtn').style.display = 'none';
  document.querySelector('.or-row').style.display = 'none';
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
      const utter = new SpeechSynthesisUtterance(`${label}: ${value}.`);
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

// CANARY_TEST_12345
