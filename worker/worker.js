const ALLOWED_ORIGIN = 'https://countmy.app';

function cors(resp) {
  resp.headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  resp.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  resp.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return resp;
}

// Abuse limits, added 2 Sep. The real reason: every AI route below runs on
// Workers AI's free quota - 10,000 neurons/day shared across the WHOLE
// Cloudflare account - and the routes are unauthenticated (they have to be,
// the app has no accounts). Anyone with curl in a loop could burn the entire
// day's quota in minutes and voice entry would silently stop working for
// the real shop owners it exists for. /sync and /ping write to D1 and are
// just as open.
//
// Built on Cloudflare's Workers Rate Limiting binding (env.AI_LIMIT and
// env.WRITE_LIMIT, declared in worker/deploy.sh): atomic, per-edge, free
// plan, and costs nothing per request. The first version of this used KV
// counters - caught in review before deploy: the free tier allows 1,000 KV
// writes per DAY account-wide, and a counter that writes on every allowed
// request would have exhausted that by mid-afternoon on normal usage, after
// which every put fails, the limiter silently stops limiting, and worse,
// marking a shop as paid in KV that day could fail too. The binding has no
// such cost. Its one real constraint is that periods are 10 or 60 seconds
// only, so there is no per-day cap - the per-minute cap already bounds one
// IP to far less than the quota (60/min is 86k/day in theory, but a flood
// that steady is exactly what the cap makes pointless).
//
// Real caveat: Ghanaian mobile carriers (MTN, Telecel, AT) put many
// subscribers behind one shared public IP (carrier-grade NAT), so "one IP"
// here can be a whole neighbourhood of real shops on the same network. The
// per-minute numbers are therefore deliberately several times what any
// single human needs, so real users sharing a carrier IP don't collide.
// (Limits themselves are set in deploy.sh: AI 60/min, writes 120/min.)
const ADMIN_FAIL_LIMIT_PER_MINUTE = 20; // wrong ADMIN_KEY attempts only - slows brute force
const MINUTE = 60;

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

// Returns true when the request may proceed. Fails OPEN: a missing binding
// (older deploy metadata) or a thrown error lets the request through - the
// limiter must never be the thing that takes voice entry down for a real user.
// Also records WHY in limiterWhy (read by the fetch handler into an
// X-Limit response header), because a fail-open limiter is invisible from
// outside: live-tested 4 Sep, 120 rapid requests never got a 429 even with
// both bindings attached, and without this there was no way to tell
// "binding missing", "binding threw" and "binding said yes" apart.
let limiterWhy = 'unchecked';
async function allowedByLimiter(limiter, ip) {
  try {
    if (!limiter || typeof limiter.limit !== 'function') { limiterWhy = 'no-binding'; return true; }
    const { success } = await limiter.limit({ key: ip });
    limiterWhy = success === false ? 'blocked' : 'ok';
    return success !== false;
  } catch (err) {
    limiterWhy = 'error:' + String(err && err.message ? err.message : err).slice(0, 80);
    return true;
  }
}

// Copies a handler's response and stamps the limiter verdict on it. The
// header carries no user data - only ok / no-binding / blocked / error text.
function withLimitHeader(resp) {
  try {
    const out = new Response(resp.body, resp);
    out.headers.set('X-Limit', limiterWhy);
    return out;
  } catch (err) {
    return resp;
  }
}

// The admin wrong-key counter is the one place KV is still used for limiting:
// it only ever writes on a FAILED key (a handful of writes at most, never on
// real traffic), so the free-tier write budget is not a concern here. The
// 'rl:' prefix keeps these keys apart from shop ids, and handleStatus refuses
// to read them as a paid flag. Minute-window key: a new minute starts a
// fresh key and the old one expires on its own.
function adminFailKey(ip) {
  const nowSec = Math.floor(Date.now() / 1000);
  return 'rl:adminfail:' + (nowSec - (nowSec % MINUTE)) + ':' + ip;
}

async function adminFailLimited(env, ip) {
  try {
    const kv = env.COUNTMY_STATUS;
    if (!kv) return false;
    return (Number(await kv.get(adminFailKey(ip))) || 0) >= ADMIN_FAIL_LIMIT_PER_MINUTE;
  } catch (err) {
    return false;
  }
}

async function bumpAdminFail(env, ip) {
  try {
    const kv = env.COUNTMY_STATUS;
    if (!kv) return;
    const key = adminFailKey(ip);
    const current = Number(await kv.get(key)) || 0;
    await kv.put(key, String(current + 1), { expirationTtl: MINUTE * 2 });
  } catch (err) {
    // Fail open.
  }
}

// The error string is read aloud to phone users by the app, so it is a plain
// sentence, not a status word.
function tooManyRequests(retryAfter) {
  return cors(new Response(JSON.stringify({ error: 'Too many tries right now - please wait a minute and try again.', retryAfter }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) }
  }));
}

async function handleStatus(request, env) {
  const url = new URL(request.url);
  const shop = (url.searchParams.get('shop') || '').trim().toLowerCase();
  if (!shop) return cors(new Response(JSON.stringify({ error: 'missing shop id' }), { status: 400 }));
  // Limiter counters share this KV namespace; they must never read as paid.
  if (shop.startsWith('rl:')) {
    return cors(new Response(JSON.stringify({ shop, paid: false }), { headers: { 'Content-Type': 'application/json' } }));
  }
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

// Automatic entry backup, added 30 Aug: Bobby's explicit call - "it shouldn't
// be an option, it should be automatic, less confusion or buttons or worries
// for users" - after asking how to let him recover his mum's records if her
// phone is lost or she deletes something by mistake. This is a real change to
// this file's own stated privacy shape above (handlePing's comment: "no shop
// name, item, price, or customer name ever reaches this dashboard or the
// database") - that promise still holds for the events table and the
// aggregate dashboard, but this new entries table intentionally stores real
// entry content (item names, customer names typed into debts, amounts) so it
// can be recovered. What's preserved from the original design: the shop id
// itself is still never stored in plaintext, only its one-way hash, so
// nobody - Bobby included - can list or browse shops; entries are only ever
// retrievable by already knowing the exact shop id, the same shape as
// handleShopActivity below. Soft-delete only (a flag, never a real SQL
// DELETE) since "recover something that was deleted" is the entire point.
async function handleSync(request, env) {
  if (!env.COUNTMY_DB) return cors(new Response(JSON.stringify({ error: 'not configured' }), { status: 503 }));
  let body;
  try { body = await request.json(); } catch (e) {
    return cors(new Response(JSON.stringify({ error: 'invalid request' }), { status: 400 }));
  }
  const shop = String((body && body.shop) || '').trim().toLowerCase().slice(0, 200);
  const entry = body && body.entry;
  const deleted = !!(body && body.deleted);
  if (!shop || !entry || !entry.id) {
    return cors(new Response(JSON.stringify({ error: 'missing shop or entry' }), { status: 400 }));
  }
  const now = Date.now();
  const entryId = String(entry.id).slice(0, 200);

  // A delete-only payload (deleteEntry() on the client only ever has the id,
  // never the full record) just flips the flag on the row already written
  // when this entry was first created or last edited.
  if (deleted && Object.keys(entry).length === 1) {
    await env.COUNTMY_DB.prepare('UPDATE entries SET deleted = 1, updated_at = ? WHERE entry_id = ?')
      .bind(now, entryId).run();
    return cors(new Response(null, { status: 204 }));
  }

  const shopHash = (await sha256Hex(shop)).slice(0, 32);
  // status defaults to 'saved' - a real committed ledger entry. 'not_saved'
  // (see app.js syncNotSaved) marks an attempt the owner deliberately backed
  // out of (voice Discard, or Cancel with something already typed) - shown
  // separately in the admin dashboard so "how many people tried and gave up"
  // is a real, visible number instead of invisible churn.
  const status = entry.status === 'not_saved' ? 'not_saved' : 'saved';
  await env.COUNTMY_DB.prepare(
    `INSERT INTO entries (entry_id, shop_hash, status, type, item, note, qty, price, kind, method, paid, amount, source, day, ts, deleted, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entry_id) DO UPDATE SET
       shop_hash=excluded.shop_hash, status=excluded.status, type=excluded.type, item=excluded.item, note=excluded.note,
       qty=excluded.qty, price=excluded.price, kind=excluded.kind, method=excluded.method,
       paid=excluded.paid, amount=excluded.amount, source=excluded.source, day=excluded.day,
       ts=excluded.ts, deleted=excluded.deleted, updated_at=excluded.updated_at`
  ).bind(
    entryId, shopHash, status,
    String(entry.type || '').slice(0, 40), String(entry.item || '').slice(0, 500), String(entry.note || '').slice(0, 500),
    String(entry.qty || ''), String(entry.price || ''), String(entry.kind || ''), String(entry.method || ''),
    Number(entry.paid || 0), Number(entry.amount || 0), String(entry.source || '').slice(0, 40),
    String(entry.day || '').slice(0, 20), Number(entry.ts || now), deleted ? 1 : 0, now
  ).run();
  return cors(new Response(null, { status: 204 }));
}

// Owner-only recovery lookup, added 30 Aug: given a shop id you already know
// (never a search or a list of shops - same privacy shape as
// handleShopActivity below), returns every entry ever backed up for that
// shop, including ones the owner themselves deleted, so a lost phone or an
// accidental delete is never actually permanent. Same ADMIN_KEY gate as
// every other /admin/* route.
async function handleAdminEntries(request, env) {
  if (!env.COUNTMY_DB) return cors(new Response(JSON.stringify({ error: 'not configured' }), { status: 503 }));
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return cors(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
  }
  const shop = (url.searchParams.get('shop') || '').trim().toLowerCase();
  const rawHash = (url.searchParams.get('shopHash') || '').trim().toLowerCase();
  // Accepts either a plaintext shop id (hashed here, same as always) or an
  // already-hashed shopHash - the latter lets handleAdminRecentEntries's
  // browse view link straight into a full lookup once Bobby recognizes a
  // shop's content, without ever needing to learn its real name or id.
  if (!shop && !rawHash) return cors(new Response(JSON.stringify({ error: 'missing shop id' }), { status: 400 }));
  const shopHash = rawHash || (await sha256Hex(shop)).slice(0, 32);
  const { results } = await env.COUNTMY_DB.prepare(
    'SELECT entry_id, status, type, item, note, qty, price, kind, method, paid, amount, source, day, ts, deleted, updated_at FROM entries WHERE shop_hash = ? ORDER BY ts DESC'
  ).bind(shopHash).all();
  return cors(new Response(JSON.stringify({ shop: shop || null, shopHash, entries: results || [] }), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

// Owner-only "recent backups" browse, added 30 Aug: handleAdminEntries above
// only works if you already know the exact Shop ID - but most users, his mum
// included, never type one in at all (the app silently falls back to a random
// per-device id - see getShopId() || getDeviceId() in app.js), so there is
// often no name to look up. This is a real, deliberate widening of this
// file's own "never a list of shops" privacy rule stated above: it lists
// recently-active shop hashes (still one-way hashes, never a name or id) and,
// for each, a preview of its most recent real entries - real item names,
// notes, amounts, timestamps. The hash itself never identifies anyone; the
// entry CONTENT is what lets an owner who knows their own family's shop
// recognize which row is theirs, without ever needing to know its hash or id
// up front. Same ADMIN_KEY gate as every other /admin/* route - this is
// exactly as sensitive as it sounds, which is why it exists only behind that
// key, not as a feature reachable from the app itself.
async function handleAdminRecentEntries(request, env) {
  if (!env.COUNTMY_DB) return cors(new Response(JSON.stringify({ error: 'not configured' }), { status: 503 }));
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return cors(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
  }
  const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || 30));
  const since = Date.now() - days * 86400000;

  const summaryQuery = env.COUNTMY_DB.prepare(
    'SELECT shop_hash, COUNT(*) as total, MIN(ts) as firstSeen, MAX(ts) as lastSeen FROM entries WHERE ts >= ? GROUP BY shop_hash ORDER BY lastSeen DESC LIMIT 50'
  ).bind(since);
  const previewQuery = env.COUNTMY_DB.prepare(
    `SELECT shop_hash, entry_id, status, type, item, note, amount, ts, deleted FROM (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY shop_hash ORDER BY ts DESC) as rn
       FROM entries WHERE ts >= ?
     ) WHERE rn <= 3 ORDER BY shop_hash, ts DESC`
  ).bind(since);
  const [summaryRes, previewRes] = await env.COUNTMY_DB.batch([summaryQuery, previewQuery]);

  const previewsByShop = {};
  for (const row of (previewRes.results || [])) {
    (previewsByShop[row.shop_hash] = previewsByShop[row.shop_hash] || []).push(row);
  }
  const shops = (summaryRes.results || []).map(s => ({
    shopHash: s.shop_hash,
    total: s.total,
    firstSeen: s.firstSeen,
    lastSeen: s.lastSeen,
    preview: previewsByShop[s.shop_hash] || []
  }));
  return cors(new Response(JSON.stringify({ days, shops }), {
    headers: { 'Content-Type': 'application/json' }
  }));
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
    // Sourced from the entries table (real backed-up content), not the
    // anonymous events ping - this is the accurate count now that every
    // save is automatically backed up. notSaved is the same table's
    // deliberately-abandoned attempts (see app.js syncNotSaved) - the real
    // "how many people tried and gave up" number this dashboard never had
    // a way to show before.
    stmts.push(env.COUNTMY_DB.prepare(
      "SELECT COUNT(*) as n FROM entries WHERE status = 'saved' AND ts >= ?"
    ).bind(since));
    stmts.push(env.COUNTMY_DB.prepare(
      "SELECT COUNT(*) as n FROM entries WHERE status = 'not_saved' AND ts >= ?"
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
      entries: ((results[i++].results || [])[0] || {}).n || 0,
      notSaved: ((results[i++].results || [])[0] || {}).n || 0
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
// Split out 30 Aug so /transcribe-and-extract (see below) can run both AI
// steps back-to-back on Cloudflare's own edge, in one client request,
// instead of the client waiting for a full round trip back just to
// immediately start a second one - real latency this app's own users
// reported ("seems delayed... it's deffo delayed"), and exactly the kind
// of extra round trip that hurts most on the weak mobile connections this
// app is built to tolerate. handleTranscribe below still works standalone
// (nothing that already calls /transcribe breaks).
async function transcribeAudio(audioBytes, audioType, env) {
  if (audioBytes.length === 0) return { text: '', error: 'no audio received' };

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
    return { text: '', error: 'transcription unavailable right now - try again shortly, or type instead', detail: String(err).slice(0, 200) };
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
          'Content-Type': audioType || 'audio/webm'
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

  return { text };
}

// Thin wrapper kept for backward compatibility - anything still calling
// /transcribe directly (or a future non-voice-entry use of transcription
// alone) keeps working exactly as before.
async function handleTranscribe(request, env) {
  if (!env.AI) {
    return cors(new Response(JSON.stringify({ error: 'transcription not configured yet' }), { status: 503 }));
  }
  const incomingForm = await request.formData();
  const audio = incomingForm.get('audio');
  if (!audio) return cors(new Response(JSON.stringify({ error: 'no audio received' }), { status: 400 }));
  const audioBytes = new Uint8Array(await audio.arrayBuffer());
  const result = await transcribeAudio(audioBytes, audio.type, env);
  if (result.error) {
    return cors(new Response(JSON.stringify({ error: result.error, detail: result.detail }), { status: result.detail ? 502 : 400 }));
  }
  return cors(new Response(JSON.stringify({ text: result.text }), {
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

// Spells an integer the way a person says it, so a value the model returned
// as a digit can still be matched against a transcript that spelled it out.
// Bounded to what a market sentence actually contains.
function numberWordForms(n) {
  if (!Number.isInteger(n) || n < 0 || n > 999999) return [];
  const ones = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const under100 = (v) => {
    if (v < 20) return [ones[v]];
    const t = tens[Math.floor(v / 10)];
    const r = v % 10;
    return r === 0 ? [t] : [t + ' ' + ones[r]];
  };
  const under1000 = (v) => {
    if (v < 100) return under100(v);
    const h = ones[Math.floor(v / 100)] + ' hundred';
    const r = v % 100;
    if (r === 0) return [h];
    // Both "one hundred and twenty" and "one hundred twenty" are said.
    return under100(r).flatMap(tail => [h + ' and ' + tail, h + ' ' + tail]);
  };
  if (n < 1000) return under1000(n);
  const th = Math.floor(n / 1000);
  const rest = n % 1000;
  const head = under1000(th).map(w => w + ' thousand');
  if (rest === 0) return head;
  return head.flatMap(h => under1000(rest).flatMap(tail => [h + ' and ' + tail, h + ' ' + tail]));
}

// Second, independent way to verify a value - and a stronger one than the
// model's own claim about which words it used.
//
// Real bug, found by live testing 4 Sep: the evidence check above trusts the
// model to report WHICH words a value came from, and the model is simply not
// reliable about that. Measured against the live endpoint, 7 of 11 ordinary
// trader sentences lost data or produced nothing at all: "Ama owes me 120
// cedis" returned no events, "Kofi owes me fifty cedis" returned no events,
// "I sold two shirts for 50 cedis" silently dropped the 50, and the identical
// sentence gave different answers on different runs. The values were right;
// the model's pointer to its own evidence was not.
//
// So: check the VALUE against the transcript ourselves. A number the trader
// actually said, or a name that is actually in the sentence, is grounded no
// matter what the model claims about it. This does NOT reopen the fabrication
// hole this layer exists to close - an invented item ("pencils") is still not
// in the transcript, an invented amount is still not in the transcript, and
// an event with no verified identity is still dropped entirely below.
function valueGroundedInTranscript(value, transcriptNorm) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return false;
    const asDigits = String(value);
    if (transcriptNorm.includes(asDigits)) return true;
    // 30.5 is never spoken as words; only whole numbers get the word check.
    return numberWordForms(value).some(w => transcriptNorm.includes(w));
  }
  if (typeof value === 'string') {
    const norm = normalizeForMatch(value);
    // Two chars or fewer would match almost anything.
    if (!norm || norm.length < 3 || norm.length > 60) return false;
    return transcriptNorm.includes(norm);
  }
  return false;
}

function fieldValue(raw, transcriptNorm) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if (evidenceVerified(raw.evidence, transcriptNorm)) return raw.value;
  if (valueGroundedInTranscript(raw.value, transcriptNorm)) return raw.value;
  return undefined;
}

// Split 2 Sep so the photo path (sanitizeImageEvents below) shares the exact
// same typing, bounding, and drop rules as the voice path - one set of rules
// for what an event is allowed to look like, so the client never has to know
// which route produced it. The only thing that differs between the two is
// HOW a field's value is read out of the model's raw output (getField): the
// voice path evidence-checks each one against the transcript, the photo path
// has no transcript to check against (see sanitizeImageEvents).
function buildCleanEvents(rawEvents, getField) {
  if (!Array.isArray(rawEvents)) return [];
  // Number.isFinite, not !isNaN: JSON from a model can carry 1e999, which
  // parses to Infinity and would reach the client as a null price. Capped
  // at 1e9 - no cedi amount in a shop is a billion.
  const toNumOrUndefined = (v) => {
    const n = Number(v);
    return (typeof v !== 'object' && v !== '' && v !== null && Number.isFinite(n) && n <= 1e9) ? n : undefined;
  };
  return rawEvents
    .filter(e => e && typeof e === 'object' && ['sale', 'expense', 'debt_in', 'debt_out'].includes(e.type))
    .map(e => {
      const clean = { type: e.type };
      const item = getField(e, 'item');
      const customer = getField(e, 'customer');
      const supplier = getField(e, 'supplier');
      const note = getField(e, 'note');
      const qty = toNumOrUndefined(getField(e, 'qty'));
      let price = toNumOrUndefined(getField(e, 'price'));
      // "total" exists ONLY for sale events, and ONLY as a spoken amount divided
      // by an ALSO-verified qty - deterministically, in our own code, never by
      // trusting the model's own division. This is what fixes "2 bags for 300":
      // the model can ground "300" in real evidence (it was actually said), but
      // it can never ground "150" in evidence (nobody said "one fifty"), so
      // asking the model to hand back a pre-computed per-unit price forced it to
      // fabricate evidence text for a number that was never spoken. Computing it
      // here instead means the model only ever has to point at real words.
      if (price === undefined && e.type === 'sale' && qty !== undefined && qty > 0) {
        const total = toNumOrUndefined(getField(e, 'total'));
        if (total !== undefined && total > 0) price = total / qty;
      }
      // For everything that is not a sale, "price" already means the whole
      // amount (what was spent, what is owed), so a "total" IS the price -
      // no division. Found 2 Sep testing the photo path: a receipt line is
      // almost always "2 x Milo ... 60.00", and the model handing that back
      // as qty 2 / total 60 used to lose the 60 entirely for an expense.
      if (price === undefined && e.type !== 'sale') {
        const total = toNumOrUndefined(getField(e, 'total'));
        if (total !== undefined && total > 0) price = total;
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

function sanitizeEvents(rawEvents, transcript) {
  const transcriptNorm = normalizeForMatch(transcript || '');
  return buildCleanEvents(rawEvents, (e, key) => fieldValue(e[key], transcriptNorm));
}

// Photo path, 2 Sep. Honest difference from the voice path above: there is
// no transcript to evidence-check against - the image IS the source, and the
// model's own "text" field is its own reading of it, so verifying the model
// against itself would prove nothing. A fabricated event is therefore NOT
// caught server-side here the way it is for voice. That is exactly why the
// client never auto-saves photo events (see handleSnap in app.js): every
// card from a photo needs a real Save tap after the owner looks at it. The
// typing/bounding/drop rules are still the shared ones - a bare value or an
// {value: ...} object are both accepted so a model that copies the voice
// prompt's shape still parses.
function sanitizeImageEvents(rawEvents) {
  return buildCleanEvents(rawEvents, (e, key) => {
    const raw = e[key];
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw.value : raw;
  });
}

// Split out 30 Aug for the same reason as transcribeAudio above - lets
// /transcribe-and-extract run this step immediately after transcription,
// on the edge, without a round trip back to the client in between.
async function extractFromText(text, env) {
  if (!text) return { events: [] };
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
    return { events: [], error: 'extraction unavailable right now - try again, or fill in manually', detail: String(err).slice(0, 200) };
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

  return { events: sanitizeEvents(events, text) };
}

// Thin wrapper kept for backward compatibility.
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
  const result = await extractFromText(text, env);
  if (result.error) {
    return cors(new Response(JSON.stringify({ error: result.error, detail: result.detail }), { status: 502 }));
  }
  return cors(new Response(JSON.stringify({ events: result.events }), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

// The actual latency fix, added 30 Aug from real user feedback ("seems
// delayed... it's deffo delayed"): every voice entry used to need TWO full
// client-to-edge round trips - record, send, wait, get text back, send
// text, wait, get events back. This does both AI steps in one request:
// the client uploads audio once and gets back both the transcript and the
// extracted events together, cutting one full round trip - the exact kind
// of latency that hurts most on the weak mobile connections this app is
// built to tolerate. Falls back cleanly: an empty transcript or a failed
// extraction still returns whatever succeeded so the client's existing
// fallback logic (parseHeardText) has something to work with.
async function handleTranscribeAndExtract(request, env) {
  if (!env.AI) {
    return cors(new Response(JSON.stringify({ error: 'transcription not configured yet' }), { status: 503 }));
  }
  const incomingForm = await request.formData();
  const audio = incomingForm.get('audio');
  if (!audio) return cors(new Response(JSON.stringify({ error: 'no audio received' }), { status: 400 }));
  const audioBytes = new Uint8Array(await audio.arrayBuffer());

  const transcribed = await transcribeAudio(audioBytes, audio.type, env);
  if (transcribed.error) {
    return cors(new Response(JSON.stringify({ text: '', events: [], error: transcribed.error, detail: transcribed.detail }), { status: 502 }));
  }
  const text = transcribed.text || '';
  if (!text.trim()) {
    return cors(new Response(JSON.stringify({ text: '', events: [] }), { headers: { 'Content-Type': 'application/json' } }));
  }
  const extracted = await extractFromText(text, env);
  return cors(new Response(JSON.stringify({ text, events: extracted.events || [] }), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

// Photo entry, added 2 Sep: a shop owner who already writes sales in a paper
// notebook, or gets a printed receipt from a supplier, can snap it instead of
// reading it out or typing it. Same job as the voice pipeline above - free
// text (here, whatever is written or printed in the picture) in, the same
// structured events out - so the client reuses the exact same review cards.
//
// Model choice, verified against Cloudflare's live model catalog on 2 Sep:
// gemma-4-26b-a4b-it is on the free tier, takes an image, and its vendor
// card claims handwriting recognition, OCR and document parsing - the three
// things a Ghanaian notebook page and a supplier receipt actually need.
// llama-3.2-11b-vision-instruct is the fallback if Gemma errors (it needs a
// one-time license agreement on the account; if THAT comes back as a license
// error there is nothing more to try, so it is surfaced, not retried).
// Gemma is not on Workers AI's JSON-mode list, so the prompt asks for strict
// JSON and parseModelJson below is deliberately forgiving about fences and
// stray prose around it. Cost is roughly 20 neurons a photo out of the same
// 10,000/day account-wide pool Whisper draws from - it sits behind the same
// 'ai' rate-limit bucket as every other AI route for exactly that reason.
const IMAGE_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const IMAGE_FALLBACK_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const IMAGE_MAX_BYTES = 6 * 1024 * 1024; // the client sends ~200-500KB (1400px JPEG); anything near this is not from the app

// Same event types and field names as EXTRACT_SYSTEM_PROMPT / sanitizeEvents,
// on purpose - the client's eventToEntry() and review cards must not need to
// know which route produced an event. Plain values, not {value, evidence}
// pairs: there is no transcript for evidence to point at (see
// sanitizeImageEvents). "total" stays a separate field for the same reason
// as the voice prompt - a receipt line "2 x Milo ... 60.00" is qty 2, total
// 60, and the per-unit price is computed here, never by the model.
const IMAGE_EXTRACT_PROMPT = `This is a photo from a Ghanaian shop owner: a supplier receipt, a till slip, or a handwritten page from their sales notebook (amounts are in Ghana cedis; "GHS", "GHc", "GH", "c" or a plain number all mean cedis). Read everything written or printed in it, then list every distinct business event as JSON.
Each event has a "type" of "sale" (the owner sold something: fields item, qty, and EITHER price (per-unit) OR total (line total) - never divide yourself), "expense" (the owner bought or paid for something, including each line of a supplier receipt: fields item, qty if shown, and total = the amount paid for that line), "debt_in" (a customer owes the owner: fields customer, price, note) or "debt_out" (the owner owes a supplier: fields supplier, price, note).
Rules: only include a field you can actually read in the picture - never guess a number, never fill in a typical price, never invent an item that is not there. qty, price and total must be plain numbers. Skip totals, subtotals, tax lines, change, dates, phone numbers and shop names - they are not events. A receipt from a supplier is a list of "expense" events (one per line item), unless the picture clearly shows the owner's own sales.
Respond with ONLY this JSON object and nothing else - no explanation, no markdown fences:
{"text": "<one short line saying what the picture is, e.g. 'Receipt from Melcom, 3 items' or 'Notebook page, 5 sales'>", "events": [{"type":"expense","item":"Milo 400g","qty":2,"total":60}, {"type":"sale","item":"sugar","qty":5,"price":4}]}
If you cannot read any business event in the picture, respond with {"text": "<what you could see>", "events": []}.`;

// Gemma is not on the JSON-mode list, and vision models in general like to
// wrap their answer in ```json fences or a sentence of prose no matter how
// firmly the prompt says not to. Take whatever came back and pull out the
// first {...} or [...] span; anything unparseable is "nothing extracted",
// never a crash (the client already has a plain-language path for that).
function parseModelJson(raw) {
  if (raw && typeof raw === 'object') return raw; // already parsed by the runtime
  let s = String(raw || '').trim();
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '');
  // The prompt always asks for an object, so prefer '{' whenever one exists -
  // a stray "[Note]" before the object must not make us slice as an array.
  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  const start = firstObj !== -1 ? firstObj : firstArr;
  if (start === -1) return null;
  const closer = s[start] === '{' ? '}' : ']';
  const end = s.lastIndexOf(closer);
  if (end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
}

// The text of a chat-style Workers AI reply, whichever of the two shapes the
// runtime hands back: the plain { response } used by the text models above,
// or the OpenAI-style { choices: [{ message: { content } }] } the newer
// multimodal models return.
function modelReplyText(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (result.response !== undefined && result.response !== null) return result.response;
  const choice = Array.isArray(result.choices) && result.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => (c && c.text) || '').join('');
  return '';
}

async function runImageModel(model, dataUri, env) {
  const input = {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: IMAGE_EXTRACT_PROMPT },
        { type: 'image_url', image_url: { url: dataUri, detail: 'auto' } }
      ]
    }],
    max_tokens: 900
  };
  // Gemma's chat template has a "thinking" mode that spends tokens (and
  // neurons, and the owner's wait) reasoning out loud before the JSON.
  // Off, on purpose - and only sent to Gemma, since Llama's input schema
  // does not know the key and Workers AI's validator rejects unknown ones.
  if (model === IMAGE_MODEL) input.chat_template_kwargs = { enable_thinking: false };
  return env.AI.run(model, input);
}

async function extractFromImage(imageBytes, imageType, env) {
  if (!imageBytes.length) return { text: '', events: [], error: 'no photo received' };
  // Chunked base64, same reason as transcribeAudio: spreading a whole image's
  // bytes into one String.fromCharCode call blows the stack.
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < imageBytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, imageBytes.subarray(i, i + CHUNK));
  }
  const dataUri = 'data:' + (imageType || 'image/jpeg') + ';base64,' + btoa(binary);

  let result;
  let usedModel = IMAGE_MODEL;
  try {
    result = await runImageModel(IMAGE_MODEL, dataUri, env);
  } catch (primaryErr) {
    usedModel = IMAGE_FALLBACK_MODEL;
    try {
      result = await runImageModel(IMAGE_FALLBACK_MODEL, dataUri, env);
    } catch (fallbackErr) {
      // Both models failed - quota (4006/5035), a license gate on the
      // fallback, or an outage. Same honest-error shape as the voice
      // routes; the client tells the owner to type instead. The detail
      // names both errors so a real failure is diagnosable from the
      // response, not a guess.
      return {
        text: '', events: [],
        error: 'could not read the photo right now - try again shortly, or type instead',
        detail: ('gemma: ' + String(primaryErr).slice(0, 120) + ' | llama: ' + String(fallbackErr).slice(0, 120))
      };
    }
  }

  const parsed = parseModelJson(modelReplyText(result));
  let rawEvents = [];
  let text = '';
  if (Array.isArray(parsed)) {
    rawEvents = parsed;
  } else if (parsed && typeof parsed === 'object') {
    rawEvents = Array.isArray(parsed.events) ? parsed.events : [];
    text = typeof parsed.text === 'string' ? parsed.text : '';
  }
  return { text: text.slice(0, 200), events: sanitizeImageEvents(rawEvents), model: usedModel };
}

// POST /extract-from-image - multipart form with one 'image' file, the same
// shape as the audio routes so the client code is a near copy of
// transcribeAndExtract(). Returns { text, events } like /transcribe-and-
// extract does, so the client review flow needs no new code path.
async function handleExtractFromImage(request, env) {
  if (!env.AI) {
    return cors(new Response(JSON.stringify({ text: '', events: [], error: 'photo reading not configured yet' }), { status: 503 }));
  }
  // Refuse oversized uploads from the header, BEFORE formData() buffers the
  // whole body into the isolate's memory (a 100MB body would otherwise be
  // parsed in full just to be rejected).
  const declared = Number(request.headers.get('Content-Length')) || 0;
  if (declared > IMAGE_MAX_BYTES + 4096) {
    return cors(new Response(JSON.stringify({ text: '', events: [], error: 'photo too large' }), { status: 413 }));
  }
  let incomingForm;
  try { incomingForm = await request.formData(); } catch (e) {
    return cors(new Response(JSON.stringify({ text: '', events: [], error: 'invalid request' }), { status: 400 }));
  }
  const image = incomingForm.get('image');
  if (!image || typeof image === 'string') {
    return cors(new Response(JSON.stringify({ text: '', events: [], error: 'no photo received' }), { status: 400 }));
  }
  const imageType = String(image.type || '');
  if (!imageType.startsWith('image/')) {
    return cors(new Response(JSON.stringify({ text: '', events: [], error: 'not an image' }), { status: 400 }));
  }
  if (image.size > IMAGE_MAX_BYTES) {
    return cors(new Response(JSON.stringify({ text: '', events: [], error: 'photo too large' }), { status: 400 }));
  }
  const imageBytes = new Uint8Array(await image.arrayBuffer());
  const result = await extractFromImage(imageBytes, imageType, env);
  if (result.error) {
    return cors(new Response(JSON.stringify({ text: '', events: [], error: result.error, detail: result.detail }), {
      status: result.detail ? 502 : 400,
      headers: { 'Content-Type': 'application/json' }
    }));
  }
  return cors(new Response(JSON.stringify({ text: result.text, events: result.events }), {
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

      // Abuse limits (see the constants at the top). Checked before the
      // handler runs so a capped request never touches Workers AI or D1.
      const path = url.pathname;
      const isAiRoute = path === '/transcribe' || path === '/extract' || path === '/transcribe-and-extract' || path === '/extract-from-image';
      const isWriteRoute = path === '/ping' || path === '/sync';
      const isAdminRoute = path.startsWith('/admin/');
      const ip = clientIp(request);
      if (isAiRoute && request.method === 'POST') {
        if (!(await allowedByLimiter(env.AI_LIMIT, ip))) return tooManyRequests(MINUTE);
      }
      if (isWriteRoute && request.method === 'POST') {
        if (!(await allowedByLimiter(env.WRITE_LIMIT, ip))) return tooManyRequests(MINUTE);
      }
      if (isAdminRoute && request.method === 'GET') {
        // Check only - the counter is bumped further down, and only when the
        // request actually failed the key, so the real owner is never counted.
        if (await adminFailLimited(env, ip)) return tooManyRequests(MINUTE);
      }

      if (path === '/transcribe' && request.method === 'POST') return withLimitHeader(await handleTranscribe(request, env));
      if (path === '/extract' && request.method === 'POST') return withLimitHeader(await handleExtract(request, env));
      if (path === '/transcribe-and-extract' && request.method === 'POST') return withLimitHeader(await handleTranscribeAndExtract(request, env));
      if (path === '/extract-from-image' && request.method === 'POST') return withLimitHeader(await handleExtractFromImage(request, env));
      if (path === '/ping' && request.method === 'POST') return withLimitHeader(await handlePing(request, env));
      if (path === '/sync' && request.method === 'POST') return withLimitHeader(await handleSync(request, env));

      let adminResp = null;
      if (path === '/admin/stats' && request.method === 'GET') adminResp = await handleAdminStats(request, env);
      else if (path === '/admin/shop' && request.method === 'GET') adminResp = await handleShopActivity(request, env);
      else if (path === '/admin/entries' && request.method === 'GET') adminResp = await handleAdminEntries(request, env);
      else if (path === '/admin/entries/recent' && request.method === 'GET') adminResp = await handleAdminRecentEntries(request, env);
      if (adminResp) {
        if (adminResp.status === 401) await bumpAdminFail(env, ip);
        return adminResp;
      }
      return cors(new Response('Not found', { status: 404 }));
    } catch (err) {
      return cors(new Response(JSON.stringify({ error: 'server error', detail: String(err) }), { status: 500 }));
    }
  }
};
