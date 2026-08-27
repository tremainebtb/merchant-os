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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }
    const url = new URL(request.url);
    try {
      if (url.pathname === '/status' && request.method === 'GET') return handleStatus(request, env);
      if (url.pathname === '/transcribe' && request.method === 'POST') return handleTranscribe(request, env);
      return cors(new Response('Not found', { status: 404 }));
    } catch (err) {
      return cors(new Response(JSON.stringify({ error: 'server error', detail: String(err) }), { status: 500 }));
    }
  }
};
