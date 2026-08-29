const ALLOWED_ORIGIN = 'https://countmy.app';

function cors(resp) {
  resp.headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  resp.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  resp.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return resp;
}

async function handleStatus(request, env) {
  const url = new URL(request.url);
  const shop = (url.searchParams.get('shop') || '').trim().toLowerCase();
  if (!shop) return cors(new Response(JSON.stringify({ error: 'missing shop id' }), { status: 400 }));
  const val = await env.COUNTMY_STATUS.get(shop);
  return cors(new Response(JSON.stringify({ shop, paid: val === '1' }), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

// Usage tracking, added 27 Aug for the owner dashboard. The shop id itself
// NEVER touches D1 - only a SHA-256 hash of it. This is deliberate, not
// decorative: the shop id is free text a merchant typed in and could easily
// be their real business or personal name, and the whole product promise is
// "your records stay on your phone." A hash still lets every query below
// count and trend distinct businesses correctly (same shop id always hashes
// to the same value) without ever storing anything that identifies a real
// person or business in this database.
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function handlePing(request, env) {
  if (!env.COUNTMY_DB) return cors(new Response(JSON.stringify({ error: 'not configured' }), { status: 503 }));
  let body;
  try { body = await request.json(); } catch (e) {
    return cors(new Response(JSON.stringify({ error: 'invalid request' }), { status: 400 }));
  }
  const shop = String((body && body.shop) || '').trim().toLowerCase().slice(0, 200);
  const eventType = String((body && body.event) || '');
  if (!shop) return cors(new Response(JSON.stringify({ error: 'missing shop id' }), { status: 400 }));
  if (eventType !== 'open' && eventType !== 'save') {
    return cors(new Response(JSON.stringify({ error: 'invalid event' }), { status: 400 }));
  }
  const shopHash = (await sha256Hex(shop)).slice(0, 32);
  await env.COUNTMY_DB.prepare('INSERT INTO events (shop_hash, event_type, ts) VALUES (?, ?, ?)')
    .bind(shopHash, eventType, Date.now()).run();
  return cors(new Response(null, { status: 204 }));
}

// Owner-only single-shop lookup, added 28 Aug: the aggregate /admin/stats
// feed below can say "3 shops were active this week" but can never say
// WHICH 3, on purpose - shop_hash is a one-way hash so nobody, owner
// included, can reverse it back to a name. That's correct for real
// merchants, but it means a specific test user (a parent, a pilot shop)
// is genuinely invisible unless you already know their exact Shop ID and
// ask for it by name. This endpoint does exactly that and nothing more:
// given a shop id you already know (not a search, not a list), hash it
// the same way handlePing does, and return that one shop's own activity.
// Same ADMIN_KEY gate as the stats feed - never callable from the app.
async function handleShopActivity(request, env) {
  if (!env.COUNTMY_DB) return cors(new Response(JSON.stringify({ error: 'not configured' }), { status: 503 }));
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return cors(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
  }
  const shop = (url.searchParams.get('shop') || '').trim().toLowerCase();
  if (!shop) return cors(new Response(JSON.stringify({ error: 'missing shop id' }), { status: 400 }));
  const shopHash = (await sha256Hex(shop)).slice(0, 32);
  const row = await env.COUNTMY_DB.prepare(
    "SELECT MIN(ts) as firstSeen, MAX(ts) as lastSeen, SUM(CASE WHEN event_type='open' THEN 1 ELSE 0 END) as opens, SUM(CASE WHEN event_type='save' THEN 1 ELSE 0 END) as saves FROM events WHERE shop_hash = ?"
  ).bind(shopHash).first();
  const seen = !!(row && row.firstSeen);
  return cors(new Response(JSON.stringify({
    shop,
    seen,
    firstSeen: seen ? row.firstSeen : null,
    lastSeen: seen ? row.lastSeen : null,
    opens: seen ? (row.opens || 0) : 0,
    saves: seen ? (row.saves || 0) : 0
  }), { headers: { 'Content-Type': 'application/json' } }));
}

// Owner-only dashboard feed, gated by a secret query key (env.ADMIN_KEY, a
// Worker secret set in the Cloudflare dashboard - never committed to the repo,
// never in client-side code). Periods are rolling windows (last 24h / 7d /
// 30d / 365d / all-time), not calendar day/week/month/year - deliberately,
// since shop owners span timezones and a "day" boundary tied to one
// timezone would silently misattribute activity for everyone else. "signups"
// = distinct shop hashes whose EARLIEST logged event falls inside the
// window; "active" = distinct shop hashes with ANY event inside it;
// "entries" = saved ledger entries (event_type 'save') inside it. All three
// are computed with real COUNT(DISTINCT ...)/MIN(ts) queries, not summed
// from the daily series below (summing daily distinct counts would
// double-count a shop that returns on multiple days within the window).
async function handleAdminStats(request, env) {
  if (!env.COUNTMY_DB) return cors(new Response(JSON.stringify({ error: 'not configured' }), { status: 503 }));
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return cors(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
  }
  const DAY = 86400000;
  const now = Date.now();
  const periods = [
    ['day', now - DAY],
    ['week', now - 7 * DAY],
    ['month', now - 30 * DAY],
    ['year', now - 365 * DAY],
    ['all', 0]
  ];
  const stmts = [];
  for (const [, since] of periods) {
    stmts.push(env.COUNTMY_DB.prepare(
      'SELECT COUNT(*) as n FROM (SELECT shop_hash, MIN(ts) as first_ts FROM events GROUP BY shop_hash) WHERE first_ts >= ?'
    ).bind(since));
    stmts.push(env.COUNTMY_DB.prepare(
      'SELECT COUNT(DISTINCT shop_hash) as n FROM events WHERE ts >= ?'
    ).bind(since));
    stmts.push(env.COUNTMY_DB.prepare(
      "SELECT COUNT(*) as n FROM events WHERE event_type = 'save' AND ts >= ?"
    ).bind(since));
  }
  // Daily trend series, last 120 days - enough for the day/week/month views;
  // the dashboard sums these client-side for week/month bars, and for the
  // year view only (where a day-by-day trend line would be unreadable
  // anyway) falls back to the exact 'year' period totals above instead of
  // trying to stretch 120 days of daily data across 365.
  const dailySince = now - 120 * DAY;
  stmts.push(env.COUNTMY_DB.prepare(
    'SELECT CAST(first_ts / ? AS INTEGER) as bucket, COUNT(*) as n FROM (SELECT shop_hash, MIN(ts) as first_ts FROM events GROUP BY shop_hash) WHERE first_ts >= ? GROUP BY bucket'
  ).bind(DAY, dailySince));
  stmts.push(env.COUNTMY_DB.prepare(
    'SELECT CAST(ts / ? AS INTEGER) as bucket, COUNT(DISTINCT shop_hash) as n FROM events WHERE ts >= ? GROUP BY bucket'
  ).bind(DAY, dailySince));
  stmts.push(env.COUNTMY_DB.prepare(
    "SELECT CAST(ts / ? AS INTEGER) as bucket, COUNT(*) as n FROM events WHERE event_type = 'save' AND ts >= ? GROUP BY bucket"
  ).bind(DAY, dailySince));

  const results = await env.COUNTMY_DB.batch(stmts);

  const out = { generatedAt: now, periods: {}, daily: { signups: {}, active: {}, entries: {} } };
  let i = 0;
  for (const [name] of periods) {
    out.periods[name] = {
      signups: ((results[i++].results || [])[0] || {}).n || 0,
      active: ((results[i++].results || [])[0] || {}).n || 0,
      entries: ((results[i++].results || [])[0] || {}).n || 0
    };
  }
  const bucketToDate = (b) => new Date(b * DAY).toISOString().slice(0, 10);
  for (const row of (results[i++].results || [])) out.daily.signups[bucketToDate(row.bucket)] = row.n;
  for (const row of (results[i++].results || [])) out.daily.active[bucketToDate(row.bucket)] = row.n;
  for (const row of (results[i++].results || [])) out.daily.entries[bucketToDate(row.bucket)] = row.n;

  return cors(new Response(JSON.stringify(out), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

// Runs on Cloudflare Workers AI (env.AI), NOT a paid third-party API. Verified live
// against Cloudflare's own docs, twice, independently (27 Aug): whisper-large-v3-turbo
// is on the genuinely-free tier (10,000 Neurons/day, no card on file, no gated-model
// list it's on today) on this same Cloudflare account - zero new signup, zero ongoing
// cost. The one real caveat, also verified: that 10k/day quota is shared across the
// WHOLE account, not just this Worker, and a few 2025-2026 community reports describe
// the quota misreporting as exhausted (error 4006) even at low real usage. That's why
// a quota/AI failure here returns a clear, honest error instead of pretending - the
// frontend already tells the owner to type instead rather than get stuck.
async function handleTranscribe(request, env) {
  if (!env.AI) {
    return cors(new Response(JSON.stringify({ error: 'transcription not configured yet' }), { status: 503 }));
  }
  const incomingForm = await request.formData();
  const audio = incomingForm.get('audio');
  if (!audio) return cors(new Response(JSON.stringify({ error: 'no audio received' }), { status: 400 }));

  const audioBytes = new Uint8Array(await audio.arrayBuffer());
  if (audioBytes.length === 0) {
    return cors(new Response(JSON.stringify({ error: 'no audio received' }), { status: 400 }));
  }

  // whisper-large-v3-turbo's input schema wants 'audio' as an array of raw byte
  // values OR base64 - live-tested 27 Aug: passing a plain JS array (Array.from a
  // Uint8Array) was REJECTED by Cloudflare's own schema validator ("'string' not in
  // 'array','binary'"). Base64-encoding first is what a verified working example
  // (github.com/fumieval/cf-transcriber) actually uses in production - do the same,
  // chunked to avoid a stack-size crash from spreading a large byte array at once.
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < audioBytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, audioBytes.subarray(i, i + CHUNK));
  }
  const base64Audio = btoa(binary);

  // language was hardcoded to 'en' - honest limit found 28 Aug checking what
  // this model actually supports: Whisper large-v3 has no Twi/Akan in its
  // trained language set at all, so real Twi speech was never going to work
  // regardless of this setting. But forcing 'en' also actively hurt the
  // common real case - a Ghanaian shop owner speaking English with Twi
  // words mixed in, or Ghanaian Pidgin - by telling the model to decode
  // everything as pure English even where that's wrong. Dropping the forced
  // language lets Whisper auto-detect per utterance, which is strictly
  // better for English and Pidgin (both close enough to be recognized) and
  // does nothing worse for Twi (still unsupported either way).
  let result;
  try {
    result = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
      audio: base64Audio
    });
  } catch (err) {
    // Covers the daily-quota-exhausted case (real, documented risk on the free tier)
    // as well as any other Workers AI failure - same honest-error path either way.
    return cors(new Response(JSON.stringify({ error: 'transcription unavailable right now - try again shortly, or type instead', detail: String(err).slice(0, 200) }), { status: 502 }));
  }
  let text = (result && (result.text || (result.transcription_info && result.transcription_info.text))) || '';

  // Real Ghanaian-language ASR, wired 30 Aug via GhanaNLP's Khaya API
  // (developer.khaya.ai). Whisper large-v3 has zero Twi/Akan/Ga in its
  // training data (verified against Cloudflare's own docs and OpenAI's
  // published language list), so it reliably returns empty text for real
  // local-language speech - not an error, just silence. This only runs in
  // exactly that case, so English/Pidgin (which Whisper already handles)
  // never touches Khaya's quota at all.
  //
  // Endpoint, language codes, and raw-bytes request shape all verified
  // directly against Khaya's real API docs (developer.khaya.ai/api-details)
  // and confirmed live: GET /languages returned the real code list (twi,
  // gaa, fat, ewe, pcm for Pidgin, etc - not guessed), and a genuine
  // browser-recorded webm/opus blob (built the same way this app actually
  // records) was POSTed to the real endpoint and came back 200 with a
  // correct transcript - despite webm not being in Khaya's documented
  // format list (wav/mp3/flac/ogg), their backend evidently sniffs the
  // real format rather than trusting the declared one.
  //
  // Twi only, deliberately: the free Developer tier this account is on
  // caps at 100 calls total per MONTH (not per day) - trying several
  // languages per failed recording would burn that in a handful of real
  // uses. Twi is by far the most widely spoken Ghanaian language, so it's
  // the single best bet with a one-shot budget. If real usage shows people
  // need Ga/Fante/Ewe specifically, that needs either a paid Khaya tier or
  // a way to ask which language once, not silently multiply API calls.
  if (!text.trim() && env.KHAYA_API_KEY) {
    try {
      const khayaRes = await fetch('https://translation-api.ghananlp.org/asr/v3/transcribe?language=twi', {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': env.KHAYA_API_KEY,
          'Content-Type': audio.type || 'audio/webm'
        },
        body: audioBytes
      });
      if (khayaRes.ok) {
        const khayaData = await khayaRes.json();
        text = (khayaData && khayaData.text) || '';
      }
      // A non-OK response (e.g. quota exhausted, invalid audio) falls
      // through to the same empty-transcript handling the frontend
      // already has for Whisper - never a broken/different error path
      // just because the fallback was the one that failed.
    } catch (err) {
      // Same reasoning: a network failure reaching Khaya should never
      // break the existing English/Pidgin experience.
    }
  }

  return cors(new Response(JSON.stringify({ text }), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

// Stage 2 of the voice pipeline, added 27 Aug after real-device testing showed the
// old approach - regex-clean the raw transcript, fill ONE sheet - breaks the moment
// a merchant speaks naturally (multiple sales in one breath, "cds" instead of
// "cedis", numbers the transcript never captured). This does NOT fix transcription
// accuracy (Whisper still mishears what it mishears) - it fixes what happens AFTER:
// a free Workers AI text model reads the raw transcript and proposes one or more
// structured transactions, each field marked confident or not-confident. The
// frontend then confirms only the fields marked not-confident, instead of asking
// the merchant to re-verify a whole clean-looking-but-possibly-wrong entry. This is
// still "never silently create a financial record" - it just moves the confirmation
// burden to exactly the fields that need it, not the whole line.
// Evidence-span architecture, added 27 Aug after a live test proved the model can
// fabricate whole transactions: given one ambiguous sentence about a single
// amount, it invented five entirely fictional items (pencils, a phone, water, a
// cake, a book) that were never spoken. A type-only sanitizer cannot catch that -
// "GHS 5000" is a perfectly valid number, just one nobody said. So every field
// the model returns must now also carry the exact transcript substring it claims
// to be based on, and the sanitizer independently verifies that substring
// actually occurs in the real transcript before trusting the field. No evidence
// found in the transcript = field dropped, exactly like a missing field, and an
// event with zero verified fields is discarded outright before it ever reaches
// the merchant. The model can still get a NUMBER wrong (misreading "one fifty" as
// 50 is a transcription/parsing error, not a fabrication) - evidence-checking
// targets fabrication specifically, not every possible error; the review UI is
// still what catches a wrong-but-grounded number.
const EXTRACT_SYSTEM_PROMPT = `You read a rough, possibly messy speech-to-text transcript from a Ghanaian shop owner describing what happened in their shop today, in English (sometimes mixed with Twi words or mistranscribed words like "cds" for "cedis"). Extract every distinct business event as a JSON array. Each event is one of these types:
- "sale": the owner sold something. Fields: type, item, qty, and EITHER price (per-unit price in cedis, only if a per-unit price was actually spoken) OR total (the total amount actually spoken, if only a total was said - e.g. "2 bags for 300" has qty 2 and total 300, NOT price 150 - never do the division yourself).
- "expense": the owner spent money on something. Fields: type, item, price (total amount in cedis).
- "debt_in": a customer owes the owner money. Fields: type, customer (the person's name), price (amount owed in cedis), note (optional, what for).
- "debt_out": the owner owes a supplier money. Fields: type, supplier (the person/business name), price (amount owed in cedis), note (optional).
CRITICAL RULE: every field except "type" must be an object of the form {"value": ..., "evidence": "..."}, where "evidence" is the EXACT short substring copied word-for-word from the transcript that this value is based on (e.g. evidence "three" for qty 3, evidence "300" for total 300, evidence "Kwame" for customer). NEVER invent evidence text for a number you calculated yourself (like a divided-out per-unit price) - only use evidence for words that were ACTUALLY spoken. If you cannot point to actual words in the transcript supporting a field, DO NOT include that field at all - do not guess, do not use general knowledge about typical prices. qty, price, and total "value" must be plain numbers. Ignore transcription noise words that don't fit any product (like a stray "cds" or "think" with no context) - do not turn noise into a fabricated item.
Respond with ONLY a raw JSON array, no prose, no markdown fences, no extra fields beyond what's listed above. If nothing extractable, respond with [].
Example: [{"type":"sale","item":{"value":"rice","evidence":"rice"},"qty":{"value":5,"evidence":"five"},"price":{"value":10,"evidence":"ten cedis"}}, {"type":"sale","item":{"value":"bags","evidence":"bags"},"qty":{"value":2,"evidence":"two"},"total":{"value":300,"evidence":"300"}}]`;

// Deterministic, model-independent safety layer - takes whatever the LLM
// returned (which may be malformed, missing fields, contain the literal string
// "high" stuffed into a price field, or - the case this exists to catch -
// invent an entire transaction with no basis in what was actually said) and
// produces only well-typed, EVIDENCE-VERIFIED, bounded output. This function
// calls no AI and touches no network - same input always gives the same output,
// which is what makes it unit-testable on its own, independent of whatever the
// model happens to say on a given day. Never trust model-reported confidence;
// confidence here is a fact about the value's own type AND whether its claimed
// evidence is real, nothing the model merely asserts about itself.
function normalizeForMatch(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// A field's evidence must be a real, boundedly-short substring of the actual
// transcript - not empty (an unsupported guess), and not suspiciously long
// (a model handing back the whole transcript as "evidence" for everything would
// trivially pass a naive substring check otherwise).
function evidenceVerified(evidence, transcriptNorm) {
  if (typeof evidence !== 'string') return false;
  const norm = normalizeForMatch(evidence);
  if (!norm || norm.length > 40) return false;
  return transcriptNorm.includes(norm);
}

function fieldValue(raw, transcriptNorm) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if (!evidenceVerified(raw.evidence, transcriptNorm)) return undefined;
  return raw.value;
}

function sanitizeEvents(rawEvents, transcript) {
  if (!Array.isArray(rawEvents)) return [];
  const transcriptNorm = normalizeForMatch(transcript || '');
  const toNumOrUndefined = (v) => {
    const n = Number(v);
    return (typeof v !== 'object' && v !== '' && v !== null && !isNaN(n)) ? n : undefined;
  };
  return rawEvents
    .filter(e => e && typeof e === 'object' && ['sale', 'expense', 'debt_in', 'debt_out'].includes(e.type))
    .map(e => {
      const clean = { type: e.type };
      const item = fieldValue(e.item, transcriptNorm);
      const customer = fieldValue(e.customer, transcriptNorm);
      const supplier = fieldValue(e.supplier, transcriptNorm);
      const note = fieldValue(e.note, transcriptNorm);
      const qty = toNumOrUndefined(fieldValue(e.qty, transcriptNorm));
      let price = toNumOrUndefined(fieldValue(e.price, transcriptNorm));
      // "total" exists ONLY for sale events, and ONLY as a spoken amount divided
      // by an ALSO-verified qty - deterministically, in our own code, never by
      // trusting the model's own division. This is what fixes "2 bags for 300":
      // the model can ground "300" in real evidence (it was actually said), but
      // it can never ground "150" in evidence (nobody said "one fifty"), so
      // asking the model to hand back a pre-computed per-unit price forced it to
      // fabricate evidence text for a number that was never spoken. Computing it
      // here instead means the model only ever has to point at real words.
      if (price === undefined && e.type === 'sale' && qty !== undefined && qty > 0) {
        const total = toNumOrUndefined(fieldValue(e.total, transcriptNorm));
        if (total !== undefined && total > 0) price = total / qty;
      }
      if (typeof item === 'string' && item.trim()) clean.item = item.trim().slice(0, 60);
      if (typeof customer === 'string' && customer.trim()) clean.customer = customer.trim().slice(0, 60);
      if (typeof supplier === 'string' && supplier.trim()) clean.supplier = supplier.trim().slice(0, 60);
      if (typeof note === 'string' && note.trim()) clean.note = note.trim().slice(0, 100);
      if (qty !== undefined && qty > 0) clean.qty = qty;
      if (price !== undefined && price > 0) clean.price = price;
      return clean;
    })
    // An event with NO verified identity (item/customer/supplier ALL failed
    // evidence-checking, or were never provided) is dropped outright, even if it
    // came with a verified-looking price - a real digit like "5000" genuinely
    // spoken elsewhere in the transcript can still get attached to a completely
    // fabricated item ("pencils") that has no basis at all. This is exactly what
    // killed the live-observed fabrication (5 fictional items from one ambiguous
    // sentence about a single amount) without discarding the legitimate partial
    // case - "Kwame took shirts" with no price still survives with item verified,
    // surfacing correctly as "needs a number" rather than vanishing.
    .filter(clean => clean.item || clean.customer || clean.supplier);
}

async function handleExtract(request, env) {
  if (!env.AI) {
    return cors(new Response(JSON.stringify({ error: 'extraction not configured yet' }), { status: 503 }));
  }
  let body;
  try { body = await request.json(); } catch (e) {
    return cors(new Response(JSON.stringify({ error: 'invalid request' }), { status: 400 }));
  }
  const text = (body && body.text || '').trim();
  if (!text) return cors(new Response(JSON.stringify({ error: 'no text received' }), { status: 400 }));

  let result;
  try {
    result = await env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
        { role: 'user', content: text }
      ],
      max_tokens: 700
    });
  } catch (err) {
    return cors(new Response(JSON.stringify({ error: 'extraction unavailable right now - try again, or fill in manually', detail: String(err).slice(0, 200) }), { status: 502 }));
  }

  // llama-3.2-3b-instruct's response comes back through Workers AI's OpenAI-
  // compatible endpoint with .response ALREADY parsed into the array (verified
  // live, 27 Aug, via a debug dump of the raw result) - NOT a text string needing
  // regex extraction. Still handle the string case defensively (a different model,
  // or a future Workers AI change, could return raw text instead) so a parse
  // failure here can never crash the request, only fall back to "nothing
  // extracted" - the merchant can still fill fields in manually either way.
  let events = [];
  const respField = result && result.response;
  if (Array.isArray(respField)) {
    events = respField;
  } else if (typeof respField === 'string') {
    try {
      const jsonMatch = respField.match(/\[[\s\S]*\]/);
      events = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch (e) {
      events = [];
    }
  }
  if (!Array.isArray(events)) events = [];

  events = sanitizeEvents(events, text);
  return cors(new Response(JSON.stringify({ events }), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }
    const url = new URL(request.url);
    try {
      // await, not a bare return - live-tested 27 Aug: returning a handler's promise
      // directly (`return handleExtract(...)`) hands it back to the caller BEFORE
      // this try/catch has a chance to see a rejection, so a throw inside the
      // handler (outside ITS own internal try/catch) becomes an unhandled
      // rejection and a hard Cloudflare error 1101, completely bypassing this
      // catch block. Awaiting closes that hole for every route, not just the one
      // that happened to hit it first.
      if (url.pathname === '/status' && request.method === 'GET') return await handleStatus(request, env);
      if (url.pathname === '/transcribe' && request.method === 'POST') return await handleTranscribe(request, env);
      if (url.pathname === '/extract' && request.method === 'POST') return await handleExtract(request, env);
      if (url.pathname === '/ping' && request.method === 'POST') return await handlePing(request, env);
      if (url.pathname === '/admin/stats' && request.method === 'GET') return await handleAdminStats(request, env);
      if (url.pathname === '/admin/shop' && request.method === 'GET') return await handleShopActivity(request, env);
      return cors(new Response('Not found', { status: 404 }));
    } catch (err) {
      return cors(new Response(JSON.stringify({ error: 'server error', detail: String(err) }), { status: 500 }));
    }
  }
};
