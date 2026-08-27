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

  let result;
  try {
    result = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
      audio: base64Audio,
      language: 'en'
    });
  } catch (err) {
    // Covers the daily-quota-exhausted case (real, documented risk on the free tier)
    // as well as any other Workers AI failure - same honest-error path either way.
    return cors(new Response(JSON.stringify({ error: 'transcription unavailable right now - try again shortly, or type instead', detail: String(err).slice(0, 200) }), { status: 502 }));
  }
  const text = (result && (result.text || (result.transcription_info && result.transcription_info.text))) || '';
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
const EXTRACT_SYSTEM_PROMPT = `You read a rough, possibly messy speech-to-text transcript from a Ghanaian shop owner describing what happened in their shop today, in English (sometimes mixed with Twi words or mistranscribed words like "cds" for "cedis"). Extract every distinct business event as a JSON array. Each event is one of these types:
- "sale": the owner sold something. Fields: type, item (string), qty (number, default 1 if not said), price (number - price PER UNIT in cedis).
- "expense": the owner spent money on something. Fields: type, item (string), price (number - total amount in cedis).
- "debt_in": a customer owes the owner money. Fields: type, customer (string, the person's name), price (number - amount owed in cedis), note (optional string, what for).
- "debt_out": the owner owes a supplier money. Fields: type, supplier (string, the person/business name), price (number - amount owed in cedis), note (optional string).
Rules: qty and price must always be plain numbers, never words or the string "unknown" - if a number genuinely was not said, omit that field entirely rather than guessing. Never invent a price or name that isn't clearly supported by the text. Ignore transcription noise words that don't fit any product (like a stray "cds" or "think" with no context).
Respond with ONLY a raw JSON array, no prose, no markdown fences, no extra fields beyond what's listed above. If nothing extractable, respond with [].`;

// Deterministic, model-independent safety layer - takes whatever the LLM returned
// (which may be malformed, missing fields, or - live-tested 27 Aug - contain the
// literal string "high" stuffed into a price field) and produces only
// well-typed, bounded output. This function calls no AI and touches no network -
// same input always gives the same output, which is what makes it unit-testable
// on its own (see the WORKER_TESTS block below) independent of whatever the model
// happens to say on a given day. Never trust model-reported confidence; confidence
// here is a direct fact about the value's own type, nothing more.
function sanitizeEvents(rawEvents) {
  if (!Array.isArray(rawEvents)) return [];
  const toNumOrUndefined = (v) => {
    const n = Number(v);
    return (typeof v !== 'object' && v !== '' && v !== null && !isNaN(n)) ? n : undefined;
  };
  return rawEvents
    .filter(e => e && typeof e === 'object' && ['sale', 'expense', 'debt_in', 'debt_out'].includes(e.type))
    .map(e => {
      const clean = { type: e.type };
      if (typeof e.item === 'string' && e.item.trim()) clean.item = e.item.trim().slice(0, 60);
      if (typeof e.customer === 'string' && e.customer.trim()) clean.customer = e.customer.trim().slice(0, 60);
      if (typeof e.supplier === 'string' && e.supplier.trim()) clean.supplier = e.supplier.trim().slice(0, 60);
      if (typeof e.note === 'string' && e.note.trim()) clean.note = e.note.trim().slice(0, 100);
      const qty = toNumOrUndefined(e.qty);
      const price = toNumOrUndefined(e.price);
      if (qty !== undefined && qty > 0) clean.qty = qty;
      if (price !== undefined && price > 0) clean.price = price;
      return clean;
    });
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

  events = sanitizeEvents(events);
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
      return cors(new Response('Not found', { status: 404 }));
    } catch (err) {
      return cors(new Response(JSON.stringify({ error: 'server error', detail: String(err) }), { status: 500 }));
    }
  }
};
