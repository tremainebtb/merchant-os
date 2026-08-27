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

async function handleTranscribe(request, env) {
  if (!env.OPENAI_API_KEY) {
    return cors(new Response(JSON.stringify({ error: 'transcription not configured yet' }), { status: 503 }));
  }
  const incomingForm = await request.formData();
  const audio = incomingForm.get('audio');
  if (!audio) return cors(new Response(JSON.stringify({ error: 'no audio received' }), { status: 400 }));

  const upstream = new FormData();
  upstream.append('file', audio, 'voice.webm');
  upstream.append('model', 'whisper-1');
  upstream.append('language', 'en');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: upstream
  });

  if (!res.ok) {
    const errText = await res.text();
    return cors(new Response(JSON.stringify({ error: 'transcription failed', detail: errText.slice(0, 300) }), { status: 502 }));
  }
  const data = await res.json();
  return cors(new Response(JSON.stringify({ text: data.text || '' }), {
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
