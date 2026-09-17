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

// Test flag (16 Sep). Every table that the dashboard counts carries is_test;
// the dashboard reads the live_* views, which exclude flagged rows, and shows
// the flagged count separately. Runs the ALTERs once per isolate; a column
// that already exists throws and is ignored.
let testSchemaReady = false;
async function ensureTestSchema(env) {
  if (testSchemaReady) return;
  await env.COUNTMY_DB.prepare('CREATE TABLE IF NOT EXISTS devices (device_hash TEXT PRIMARY KEY, source TEXT NOT NULL, first_ts INTEGER NOT NULL, saved_ts INTEGER)').run();
  await ensureShopsTable(env);
  for (const t of ['events', 'entries', 'devices', 'shops']) {
    try { await env.COUNTMY_DB.prepare('ALTER TABLE ' + t + ' ADD COLUMN is_test INTEGER DEFAULT 0').run(); } catch (e) { /* already there */ }
    if (t === 'devices') { try { await env.COUNTMY_DB.prepare('ALTER TABLE devices ADD COLUMN country TEXT').run(); } catch (e) { /* already there */ } }
    if (t === 'devices') {
      for (const col of ['nudge INTEGER', 'asked_ts INTEGER', 'tapped_ts INTEGER', 'first_ver TEXT', 'asn_org TEXT', 'is_dc INTEGER DEFAULT 0', 'mobile INTEGER', 'lang TEXT', 'installed_ts INTEGER', 'icon_opens INTEGER DEFAULT 0']) {
        try { await env.COUNTMY_DB.prepare('ALTER TABLE devices ADD COLUMN ' + col).run(); } catch (e) { /* already there */ }
      }
    }
    await env.COUNTMY_DB.prepare('CREATE VIEW IF NOT EXISTS live_' + t + ' AS SELECT * FROM ' + t + ' WHERE COALESCE(is_test, 0) = 0').run();
  }
  // 17 Sep: crawlers, link previews and ad reviewers (datacentre networks)
  // each create a device row AND events under that device hash, so they
  // used to count as "businesses". events.shop_hash equals devices.device_hash
  // for every row, so the live views can drop them at the source. The view
  // is recreated (not IF NOT EXISTS) so an existing database picks up the
  // new definition on the next isolate start.
  // One-shot, recorded in schema_meta: a DROP VIEW under a concurrent request
  // produced a real 500 on /ping for a user in Accra on 17 Sep 11:07. Every
  // isolate used to redo it; now only the first after the change does.
  await env.COUNTMY_DB.prepare('CREATE TABLE IF NOT EXISTS schema_meta (k TEXT PRIMARY KEY, v TEXT)').run();
  const viewsRow = await env.COUNTMY_DB.prepare("SELECT v FROM schema_meta WHERE k = 'live_views'").first();
  if (!viewsRow || viewsRow.v !== '2') {
    for (const t of ['events', 'entries']) {
      await env.COUNTMY_DB.prepare('DROP VIEW IF EXISTS live_' + t).run();
      await env.COUNTMY_DB.prepare('CREATE VIEW live_' + t + ' AS SELECT * FROM ' + t + ' WHERE COALESCE(is_test, 0) = 0 AND shop_hash NOT IN (SELECT device_hash FROM devices WHERE COALESCE(is_dc, 0) = 1)').run();
    }
    await env.COUNTMY_DB.prepare("INSERT OR REPLACE INTO schema_meta (k, v) VALUES ('live_views', '2')").run();
  }
  // Real people: not a test device and not a datacentre network (crawlers,
  // link previews, AI reviewers). Those are counted separately, never dropped.
  await env.COUNTMY_DB.prepare('CREATE VIEW IF NOT EXISTS people_devices AS SELECT * FROM devices WHERE COALESCE(is_test, 0) = 0 AND COALESCE(is_dc, 0) = 0').run();
  testSchemaReady = true;
}
function testFlag(body) { return body && (body.test === 1 || body.test === '1' || body.test === true) ? 1 : 0; }

async function handlePing(request, env) {
  if (!env.COUNTMY_DB) return cors(new Response(JSON.stringify({ error: 'not configured' }), { status: 503 }));
  let body;
  try { body = await request.json(); } catch (e) {
    return cors(new Response(JSON.stringify({ error: 'invalid request' }), { status: 400 }));
  }
  const shop = String((body && body.shop) || '').trim().toLowerCase().slice(0, 200);
  const eventType = String((body && body.event) || '');
  if (!shop) return cors(new Response(JSON.stringify({ error: 'missing shop id' }), { status: 400 }));
  // share_shop / shop_created added 16 Sep for the spread-loop numbers.
  // mic_* and iab (17 Sep): one name per voice-failure class, never content.
  if (!['open', 'save', 'share_shop', 'shop_created', 'ask', 'tap', 'install', 'voice_en', 'voice_twi', 'voice_pidgin',
    'iab', 'mic_denied', 'mic_nomic', 'mic_busy', 'mic_empty', 'mic_silent', 'mic_timeout', 'mic_server', 'mic_network'].includes(eventType)) {
    return cors(new Response(JSON.stringify({ error: 'invalid event' }), { status: 400 }));
  }
  const shopHash = (await sha256Hex(shop)).slice(0, 32);
  await ensureTestSchema(env);
  const isTest = testFlag(body);
  await env.COUNTMY_DB.prepare('INSERT INTO events (shop_hash, event_type, ts, is_test) VALUES (?, ?, ?, ?)')
    .bind(shopHash, eventType, Date.now(), isTest).run();
  // Programme attribution (15 Sep). The only revenue route with a Ghanaian
  // payer in evidence is an institution paying per trader (Oze's payers are
  // banks; MTN Adwumapa already bundles third-party tools). An institution
  // signs on proof of adoption among ITS traders, which needs one thing this
  // pipeline never had: which programme a trader came through. A short code
  // on the link (?p=adwumapa, printed on that programme's cards) is stored on
  // the phone and sent here; membership is recorded once, first code wins,
  // still keyed only by the one-way shop hash - no name, no number.
  const programme = String((body && body.programme) || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  if (programme) {
    try {
      // Keyed by the DEVICE id, not the shop id (integrity test, 15 Sep): the
      // shop id falls back to the device id until she types a shop name, and
      // the moment she does, the same phone would have enrolled twice. So
      // "enrolled" means unique devices - stated plainly to any partner. A
      // wiped browser is a new device; a shared phone is one device.
      const device = String((body && body.device) || '').trim().slice(0, 100);
      const memberHash = device ? (await sha256Hex(device)).slice(0, 32) : shopHash;
      await env.COUNTMY_DB.prepare('CREATE TABLE IF NOT EXISTS programme_members (shop_hash TEXT PRIMARY KEY, programme TEXT NOT NULL, first_ts INTEGER NOT NULL)').run();
      await env.COUNTMY_DB.prepare('INSERT OR IGNORE INTO programme_members (shop_hash, programme, first_ts) VALUES (?, ?, ?)')
        .bind(memberHash, programme, Date.now()).run();
      // Activity joins on the events table, which is keyed by shop hash, so the
      // device's activity is also stamped under the member hash when they differ.
      if (memberHash !== shopHash) {
        await env.COUNTMY_DB.prepare('INSERT INTO events (shop_hash, event_type, ts, is_test) VALUES (?, ?, ?, ?)')
          .bind(memberHash, eventType, Date.now(), isTest).run();
      }
    } catch (e) { /* attribution must never fail a ping */ }
  }
  // Source attribution (16 Sep): one row per device, first source wins,
  // saved_ts stamped on the first save so "came from X and actually
  // recorded something" is answerable per channel. Traffic with no
  // attribution is a vanity number.
  try {
    const device = String((body && body.device) || '').trim().slice(0, 100);
    const source = String((body && body.source) || '').trim().toLowerCase().replace(/[^a-z0-9_.:\/-]/g, '').slice(0, 60);
    if (device && source) {
      const dh = (await sha256Hex(device)).slice(0, 32);
      // Country from Cloudflare's edge (request.cf), never from the phone:
      // answers "is this traffic even Ghanaian?" without a session recorder.
      const country = String((request.cf && request.cf.country) || '').slice(0, 2).toUpperCase();
      const nudge = (body.nudge === 0 || body.nudge === '0') ? 0 : ((body.nudge === 1 || body.nudge === '1') ? 1 : null);
      const ver = String((body && body.ver) || '').replace(/[^a-z0-9]/gi, '').slice(0, 12);
      // Network owner from Cloudflare; a datacentre ASN is a crawler, a link
      // preview, or a reviewer's browsing agent - not a trader with a phone.
      const asnOrg = String((request.cf && request.cf.asOrganization) || '').slice(0, 60);
      const isDc = /google|amazon|aws|microsoft|azure|meta platforms|facebook|openai|oracle|digitalocean|hetzner|ovh|linode|akamai|alibaba|tencent|cloudflare|fastly|vultr|scaleway|contabo/i.test(asnOrg) ? 1 : 0;
      const mobile = (body.mobile === 1 || body.mobile === '1') ? 1 : 0;
      const lang = String((body && body.lang) || '').replace(/[^a-zA-Z-]/g, '').slice(0, 12);
      const standalone = (body.standalone === 1 || body.standalone === '1') ? 1 : 0;
      await env.COUNTMY_DB.prepare('INSERT OR IGNORE INTO devices (device_hash, source, first_ts, is_test, country, nudge, first_ver, asn_org, is_dc, mobile, lang) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(dh, source, Date.now(), isTest, country, nudge, ver, asnOrg, isDc, mobile, lang).run();
      // Devices first seen before these columns existed get them on their next visit.
      await env.COUNTMY_DB.prepare('UPDATE devices SET asn_org = ?, is_dc = ?, mobile = ?, lang = ? WHERE device_hash = ? AND asn_org IS NULL').bind(asnOrg, isDc, mobile, lang, dh).run();
      if (eventType === 'install') {
        await env.COUNTMY_DB.prepare('UPDATE devices SET installed_ts = ? WHERE device_hash = ? AND installed_ts IS NULL').bind(Date.now(), dh).run();
      }
      if (eventType === 'open' && standalone) {
        await env.COUNTMY_DB.prepare('UPDATE devices SET icon_opens = COALESCE(icon_opens, 0) + 1, installed_ts = COALESCE(installed_ts, ?) WHERE device_hash = ?').bind(Date.now(), dh).run();
      }
      if (eventType === 'tap') {
        await env.COUNTMY_DB.prepare('UPDATE devices SET tapped_ts = ? WHERE device_hash = ? AND tapped_ts IS NULL').bind(Date.now(), dh).run();
      }
      if (eventType === 'ask') {
        await env.COUNTMY_DB.prepare('UPDATE devices SET asked_ts = ? WHERE device_hash = ? AND asked_ts IS NULL').bind(Date.now(), dh).run();
      }
      if (isTest) {
        // A test device's whole history is test data, including rows written before it was flagged.
        await env.COUNTMY_DB.prepare('UPDATE devices SET is_test = 1 WHERE device_hash = ?').bind(dh).run();
        await env.COUNTMY_DB.prepare('UPDATE events SET is_test = 1 WHERE shop_hash IN (?, ?)').bind(dh, shopHash).run();
        await env.COUNTMY_DB.prepare('UPDATE entries SET is_test = 1 WHERE shop_hash = ?').bind(shopHash).run();
      }
      if (eventType === 'save') {
        await env.COUNTMY_DB.prepare('UPDATE devices SET saved_ts = ? WHERE device_hash = ? AND saved_ts IS NULL').bind(Date.now(), dh).run();
      }
    }
  } catch (e) { /* attribution must never fail a ping */ }
  return cors(new Response(null, { status: 204 }));
}

// ---------------------------------------------------------------------------
// Shop pages (16 Sep). The first thing in a month of work that gives a trader
// a reason to SEND CountMy to other people: a public page for her shop with a
// WhatsApp button, that she shares on her status and in her groups. Market
// access is the need Ghanaian MSMEs themselves rank first (GEA BizBox), and
// a shop link is something she wants to spread, unlike a ledger. Kill gate,
// 30 days: under half of shops shared, or under a fifth get WhatsApp taps,
// and this gets removed. Deliberately no photos, payments, reviews or search.
// ---------------------------------------------------------------------------
const SHOP_CATEGORIES = ['fashion', 'beauty', 'food', 'provisions', 'phones', 'fabrics', 'shoes', 'drinks', 'hardware', 'services', 'other'];

function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function slugify(name) {
  return String(name || '').toLowerCase().replace(/[\u0254]/g, 'o').replace(/[\u025b]/g, 'e').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'shop';
}
function cleanText(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function cleanPhone(v) {
  // Ghana numbers only, stored as digits with country code: 0244308111 -> 233244308111.
  let d = String(v || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0') && d.length === 10) d = '233' + d.slice(1);
  if (d.startsWith('233') && d.length === 12) return d;
  return '';
}
function cleanHandle(v) { return String(v || '').replace(/^@/, '').replace(/^https?:\/\/(www\.)?(instagram|tiktok)\.com\/@?/i, '').replace(/[^A-Za-z0-9._]/g, '').slice(0, 40); }
function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 10).map(it => {
    const name = cleanText(it && it.name, 60);
    const price = Number(it && it.price);
    return name ? { name, price: Number.isFinite(price) && price > 0 && price < 1e7 ? Math.round(price * 100) / 100 : null } : null;
  }).filter(Boolean);
}
async function ensureShopsTable(env) {
  await env.COUNTMY_DB.prepare('CREATE TABLE IF NOT EXISTS shops (slug TEXT PRIMARY KEY, edit_key TEXT NOT NULL, name TEXT NOT NULL, category TEXT, area TEXT, whatsapp TEXT, hours TEXT, ig TEXT, tiktok TEXT, items TEXT, programme TEXT, created_at INTEGER, updated_at INTEGER, views INTEGER DEFAULT 0)').run();
}

// POST /shop - create, or update when the caller holds the edit key.
async function handleShopUpsert(request, env) {
  if (!env.COUNTMY_DB) return cors(new Response(JSON.stringify({ error: 'not configured' }), { status: 503 }));
  let body;
  try { body = await request.json(); } catch (e) { return cors(new Response(JSON.stringify({ error: 'invalid request' }), { status: 400 })); }
  const name = cleanText(body.name, 60);
  const whatsapp = cleanPhone(body.whatsapp);
  if (!name) return cors(new Response(JSON.stringify({ error: 'Please give your business a name.' }), { status: 400 }));
  if (!whatsapp) return cors(new Response(JSON.stringify({ error: 'Please enter a Ghana WhatsApp number, like 024 430 8111.' }), { status: 400 }));
  const category = SHOP_CATEGORIES.includes(String(body.category)) ? String(body.category) : 'other';
  const row = {
    name, category, whatsapp,
    area: cleanText(body.area, 60), hours: cleanText(body.hours, 80),
    ig: cleanHandle(body.ig), tiktok: cleanHandle(body.tiktok),
    items: JSON.stringify(cleanItems(body.items)),
    programme: cleanText(body.programme, 32).toLowerCase().replace(/[^a-z0-9_-]/g, '')
  };
  await ensureShopsTable(env);
  const now = Date.now();
  const givenSlug = cleanText(body.slug, 40).toLowerCase();
  const givenKey = cleanText(body.editKey, 64);
  if (givenSlug && givenKey) {
    const existing = await env.COUNTMY_DB.prepare('SELECT edit_key FROM shops WHERE slug = ?').bind(givenSlug).first();
    if (!existing || existing.edit_key !== givenKey) return cors(new Response(JSON.stringify({ error: 'This page belongs to someone else.' }), { status: 403 }));
    await env.COUNTMY_DB.prepare('UPDATE shops SET name=?, category=?, area=?, whatsapp=?, hours=?, ig=?, tiktok=?, items=?, updated_at=? WHERE slug=?')
      .bind(row.name, row.category, row.area, row.whatsapp, row.hours, row.ig, row.tiktok, row.items, now, givenSlug).run();
    return cors(new Response(JSON.stringify({ slug: givenSlug, editKey: givenKey, url: shopUrl(request, givenSlug) }), { headers: { 'Content-Type': 'application/json' } }));
  }
  let base = slugify(name), slug = base;
  for (let i = 2; i < 50; i++) {
    const taken = await env.COUNTMY_DB.prepare('SELECT 1 FROM shops WHERE slug = ?').bind(slug).first();
    if (!taken) break;
    slug = base + '-' + i;
  }
  const editKey = crypto.randomUUID().replace(/-/g, '');
  await ensureTestSchema(env);
  await env.COUNTMY_DB.prepare('INSERT INTO shops (slug, edit_key, name, category, area, whatsapp, hours, ig, tiktok, items, programme, created_at, updated_at, views, is_test) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)')
    .bind(slug, editKey, row.name, row.category, row.area, row.whatsapp, row.hours, row.ig, row.tiktok, row.items, row.programme, now, now, testFlag(body)).run();
  return cors(new Response(JSON.stringify({ slug, editKey, url: shopUrl(request, slug) }), { headers: { 'Content-Type': 'application/json' } }));
}

// The public address. Prefers the short custom domain once it resolves;
// falls back to whatever host answered.
function shopUrl(request, slug) {
  const host = new URL(request.url).host;
  const short = env_short_host();
  return 'https://' + (short || host) + '/b/' + slug;
}
function env_short_host() { return 'b.countmy.app'; }

async function loadShop(env, slug) {
  await ensureShopsTable(env);
  const r = await env.COUNTMY_DB.prepare('SELECT slug, name, category, area, whatsapp, hours, ig, tiktok, items, views FROM shops WHERE slug = ?').bind(slug).first();
  if (!r) return null;
  let items = [];
  try { items = JSON.parse(r.items || '[]'); } catch (e) { items = []; }
  return { ...r, items };
}

// GET /shop/<slug> - JSON, used by the app to prefill the edit form.
async function handleShopJson(env, slug) {
  const shop = await loadShop(env, slug);
  if (!shop) return cors(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
  return cors(new Response(JSON.stringify(shop), { headers: { 'Content-Type': 'application/json' } }));
}

function fmtCedis(n) { return n == null ? '' : 'GH\u20b5 ' + Number(n).toLocaleString('en-GH'); }

// GET /b/<slug> - the page a customer opens from WhatsApp. Server-rendered
// so the WhatsApp/Facebook preview shows HER shop, not a generic card. Text
// first, no images in v1, one script (GA4) - loads on any phone on any data.
async function handleShopPage(request, env, slug) {
  const shop = await loadShop(env, slug);
  if (!shop) return new Response('<!doctype html><meta charset="utf-8"><title>Not found</title><p style="font-family:sans-serif;padding:24px">This shop page does not exist.</p>', { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  try { await env.COUNTMY_DB.prepare('UPDATE shops SET views = views + 1 WHERE slug = ?').bind(slug).run(); } catch (e) { /* counting is best-effort */ }
  const e = escapeHtml;
  const catLabel = { fashion: 'Fashion', beauty: 'Beauty', food: 'Food', provisions: 'Provisions', phones: 'Phones', fabrics: 'Fabrics', shoes: 'Shoes', drinks: 'Drinks', hardware: 'Hardware', services: 'Services', other: 'Shop' }[shop.category] || 'Shop';
  const line = [catLabel, shop.area].filter(Boolean).join(' \u00b7 ');
  const wa = 'https://wa.me/' + shop.whatsapp + '?text=' + encodeURIComponent('Hello ' + shop.name + ', I saw your CountMy page. ');
  const url = shopUrl(request, shop.slug);
  const desc = (shop.items.length ? shop.items.slice(0, 4).map(i => i.name).join(', ') + '. ' : '') + 'WhatsApp ' + shop.name + (shop.area ? ' in ' + shop.area : '') + '.';
  const itemsHtml = shop.items.length
    ? '<ul class="items">' + shop.items.map(i => '<li><span>' + e(i.name) + '</span><b>' + e(fmtCedis(i.price)) + '</b></li>').join('') + '</ul>'
    : '';
  const social = [
    shop.ig ? '<a class="soc" href="https://instagram.com/' + e(shop.ig) + '" target="_blank" rel="noopener" data-ev="social_open" data-net="instagram">Instagram</a>' : '',
    shop.tiktok ? '<a class="soc" href="https://www.tiktok.com/@' + e(shop.tiktok) + '" target="_blank" rel="noopener" data-ev="social_open" data-net="tiktok">TikTok</a>' : ''
  ].filter(Boolean).join('');
  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>' + e(shop.name) + (shop.area ? ' - ' + e(shop.area) : '') + ' | CountMy</title>',
    '<meta name="description" content="' + e(desc) + '">',
    '<link rel="canonical" href="' + e(url) + '">',
    '<meta property="og:type" content="profile"><meta property="og:title" content="' + e(shop.name) + '"><meta property="og:description" content="' + e(desc) + '"><meta property="og:url" content="' + e(url) + '"><meta property="og:image" content="https://countmy.app/og-image.png">',
    '<meta name="twitter:card" content="summary">',
    '<style>:root{--paper:#F8F3EC;--surface:#fff;--ink:#221A12;--soft:#5C5142;--muted:#6E6353;--rule:#E7DDCD;--flame:#D9541A;--leaf:#1B7A43;--leaf-deep:#125C32}',
    '*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;line-height:1.4}',
    '.wrap{max-width:480px;margin:0 auto;padding:20px 16px 40px}h1{font-size:1.9rem;line-height:1.1;margin:8px 0 4px;font-weight:800}.line{color:var(--soft);font-size:1rem;margin:0 0 18px}',
    '.wa{display:flex;align-items:center;justify-content:center;gap:10px;background:#25D366;color:#fff;text-decoration:none;font-weight:800;font-size:1.25rem;border-radius:16px;padding:20px 16px;box-shadow:0 4px 14px rgba(37,211,102,.35)}.wa svg{width:28px;height:28px;flex:none}',
    '.items{list-style:none;padding:0;margin:22px 0 0;background:var(--surface);border:1px solid var(--rule);border-radius:16px}.items li{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid var(--rule);font-size:1.05rem}.items li:last-child{border-bottom:none}.items b{color:var(--leaf-deep);font-variant-numeric:tabular-nums;white-space:nowrap;margin-left:12px}',
    '.hours{margin:16px 0 0;color:var(--soft)}.socials{display:flex;gap:10px;margin-top:18px}.soc{flex:1;text-align:center;border:1px solid var(--rule);background:var(--surface);border-radius:12px;padding:12px;color:var(--ink);text-decoration:none;font-weight:700}',
    '.share{display:block;margin-top:22px;text-align:center;border:1px solid var(--rule);border-radius:12px;padding:12px;color:var(--ink);text-decoration:none;font-weight:700;background:var(--surface)}',
    '.foot{margin-top:28px;text-align:center;font-size:.85rem;color:var(--muted)}.foot a{color:var(--muted)}</style></head><body><div class="wrap">',
    '<div class="line" style="margin:0;font-size:.85rem;letter-spacing:.06em;text-transform:uppercase">' + e(catLabel) + '</div>',
    '<h1>' + e(shop.name) + '</h1>',
    line ? '<p class="line">' + e(line) + '</p>' : '',
    '<a class="wa" id="waBtn" href="' + e(wa) + '" data-ev="whatsapp_click"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.5 3.5A11.9 11.9 0 0 0 12 0C5.4 0 0 5.4 0 12c0 2.1.6 4.2 1.6 6L0 24l6.2-1.6A12 12 0 0 0 12 24c6.6 0 12-5.4 12-12 0-3.2-1.2-6.2-3.5-8.5zM12 22a10 10 0 0 1-5.1-1.4l-.4-.2-3.7 1 1-3.6-.2-.4A10 10 0 1 1 12 22zm5.5-7.4c-.3-.2-1.8-.9-2.1-1s-.5-.2-.7.2-.8 1-1 1.2-.4.2-.7.1a8.2 8.2 0 0 1-4-3.5c-.3-.5.3-.5.9-1.6.1-.2 0-.4 0-.5l-.9-2.3c-.3-.6-.5-.5-.7-.5h-.6a1.2 1.2 0 0 0-.9.4 3.6 3.6 0 0 0-1.1 2.7c0 1.6 1.2 3.1 1.3 3.3.2.2 2.3 3.5 5.6 4.9 2.1.9 2.9 1 3.9.8.6-.1 1.8-.7 2.1-1.5.3-.7.3-1.3.2-1.5l-.6-.3z"/></svg>WhatsApp ' + e(shop.name.split(' ')[0]) + '</a>',
    itemsHtml,
    shop.hours ? '<p class="hours">' + e(shop.hours) + '</p>' : '',
    social ? '<div class="socials">' + social + '</div>' : '',
    '<a class="share" id="shareBtn" href="https://wa.me/?text=' + encodeURIComponent(shop.name + ' - ' + (line || 'shop') + '\n' + url) + '" data-ev="share_business">Share this shop</a>',
    '<p class="foot">Free shop page by <a href="https://countmy.app/?utm_source=shoppage&utm_medium=footer&utm_campaign=' + e(shop.slug) + '">CountMy</a> - the money notebook you talk to</p>',
    '</div>',
    '<script async src="https://www.googletagmanager.com/gtag/js?id=G-YJW9J53BL9"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag("js",new Date());gtag("config","G-YJW9J53BL9",{anonymize_ip:true});',
    'gtag("event","business_view",{shop:"' + e(shop.slug) + '",category:"' + e(shop.category) + '"});',
    'document.querySelectorAll("[data-ev]").forEach(function(a){a.addEventListener("click",function(){gtag("event",a.getAttribute("data-ev"),{shop:"' + e(shop.slug) + '",network:a.getAttribute("data-net")||""})})});',
    'document.querySelectorAll(".items li").forEach(function(li,i){li.addEventListener("click",function(){gtag("event","product_view",{shop:"' + e(shop.slug) + '",index:i})})});</script>',
    '</body></html>'
  ].join('');
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' } });
}

// The page an institution sees before it pays: adoption among the traders
// that came through ITS programme, nothing about any individual. Same
// ADMIN_KEY gate as every other /admin/* route.
async function handleProgrammeReport(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return cors(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
  }
  if (!env.COUNTMY_DB) return cors(new Response(JSON.stringify({ error: 'not configured' }), { status: 503 }));
  const programme = String(url.searchParams.get('p') || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  const now = Date.now();
  const d7 = now - 7 * 86400000, d30 = now - 30 * 86400000;
  try {
    await env.COUNTMY_DB.prepare('CREATE TABLE IF NOT EXISTS programme_members (shop_hash TEXT PRIMARY KEY, programme TEXT NOT NULL, first_ts INTEGER NOT NULL)').run();
    const where = programme ? 'WHERE m.programme = ?' : '';
    const bindP = programme ? [programme] : [];
    const q = `SELECT m.programme AS programme,
        COUNT(*) AS enrolled,
        SUM(CASE WHEN m.first_ts >= ? THEN 1 ELSE 0 END) AS enrolled_30d,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM events e WHERE e.shop_hash = m.shop_hash AND e.ts >= ?) THEN 1 ELSE 0 END) AS active_7d,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM events e WHERE e.shop_hash = m.shop_hash AND e.ts >= ?) THEN 1 ELSE 0 END) AS active_30d,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM events e WHERE e.shop_hash = m.shop_hash AND e.event_type = 'save') THEN 1 ELSE 0 END) AS ever_saved,
        (SELECT COUNT(*) FROM events e WHERE e.event_type = 'save' AND e.shop_hash IN (SELECT shop_hash FROM programme_members x WHERE x.programme = m.programme)) AS saves_total
      FROM programme_members m ${where} GROUP BY m.programme ORDER BY enrolled DESC`;
    const rows = (await env.COUNTMY_DB.prepare(q).bind(d30, d7, d30, ...bindP).all()).results || [];
    return cors(new Response(JSON.stringify({ generatedAt: now, programmes: rows }), { headers: { 'Content-Type': 'application/json' } }));
  } catch (e) {
    return cors(new Response(JSON.stringify({ error: 'report failed', detail: String(e).slice(0, 200) }), { status: 500 }));
  }
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
  await ensureTestSchema(env);
  await env.COUNTMY_DB.prepare(
    `INSERT INTO entries (entry_id, shop_hash, status, type, item, note, qty, price, kind, method, paid, amount, source, day, ts, deleted, updated_at, is_test)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    String(entry.day || '').slice(0, 20), Number(entry.ts || now), deleted ? 1 : 0, now, testFlag(body)
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
  await ensureTestSchema(env);
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
      'SELECT COUNT(*) as n FROM (SELECT shop_hash, MIN(ts) as first_ts FROM live_events GROUP BY shop_hash) WHERE first_ts >= ?'
    ).bind(since));
    stmts.push(env.COUNTMY_DB.prepare(
      'SELECT COUNT(DISTINCT shop_hash) as n FROM live_events WHERE ts >= ?'
    ).bind(since));
    // Sourced from the entries table (real backed-up content), not the
    // anonymous events ping - this is the accurate count now that every
    // save is automatically backed up. notSaved is the same table's
    // deliberately-abandoned attempts (see app.js syncNotSaved) - the real
    // "how many people tried and gave up" number this dashboard never had
    // a way to show before.
    stmts.push(env.COUNTMY_DB.prepare(
      "SELECT COUNT(*) as n FROM live_entries WHERE status = 'saved' AND ts >= ?"
    ).bind(since));
    stmts.push(env.COUNTMY_DB.prepare(
      "SELECT COUNT(*) as n FROM live_entries WHERE status = 'not_saved' AND ts >= ?"
    ).bind(since));
  }
  // Daily trend series, last 120 days - enough for the day/week/month views;
  // the dashboard sums these client-side for week/month bars, and for the
  // year view only (where a day-by-day trend line would be unreadable
  // anyway) falls back to the exact 'year' period totals above instead of
  // trying to stretch 120 days of daily data across 365.
  const dailySince = now - 120 * DAY;
  stmts.push(env.COUNTMY_DB.prepare(
    'SELECT CAST(first_ts / ? AS INTEGER) as bucket, COUNT(*) as n FROM (SELECT shop_hash, MIN(ts) as first_ts FROM live_events GROUP BY shop_hash) WHERE first_ts >= ? GROUP BY bucket'
  ).bind(DAY, dailySince));
  stmts.push(env.COUNTMY_DB.prepare(
    'SELECT CAST(ts / ? AS INTEGER) as bucket, COUNT(DISTINCT shop_hash) as n FROM live_events WHERE ts >= ? GROUP BY bucket'
  ).bind(DAY, dailySince));
  stmts.push(env.COUNTMY_DB.prepare(
    "SELECT CAST(ts / ? AS INTEGER) as bucket, COUNT(*) as n FROM live_entries WHERE status = 'saved' AND ts >= ? GROUP BY bucket"
  ).bind(DAY, dailySince));

  // Spread loop (16 Sep): the five numbers the 90-day window is judged on.
  // 'returning' = a device seen on two or more different days, latest of
  // them inside the window - the only honest definition of "came back".
  // Shares are the ping 'share_shop' (sent when Share my shop is tapped),
  // shop views are the counter the public page increments.
  stmts.push(env.COUNTMY_DB.prepare(
    'SELECT COUNT(*) as n FROM (SELECT shop_hash, COUNT(DISTINCT CAST(ts / ? AS INTEGER)) as d, MAX(ts) as last_ts FROM live_events GROUP BY shop_hash) WHERE d >= 2 AND last_ts >= ?'
  ).bind(DAY, now - 7 * DAY));
  stmts.push(env.COUNTMY_DB.prepare(
    'SELECT COUNT(*) as n FROM (SELECT shop_hash, COUNT(DISTINCT CAST(ts / ? AS INTEGER)) as d, MAX(ts) as last_ts FROM live_events GROUP BY shop_hash) WHERE d >= 2 AND last_ts >= ?'
  ).bind(DAY, now - 30 * DAY));
  stmts.push(env.COUNTMY_DB.prepare("SELECT COUNT(DISTINCT shop_hash) as n FROM live_events WHERE event_type = 'ask'"));
  stmts.push(env.COUNTMY_DB.prepare("SELECT COUNT(DISTINCT shop_hash) as n FROM live_events WHERE event_type = 'share_shop'"));
  stmts.push(env.COUNTMY_DB.prepare("SELECT COUNT(DISTINCT shop_hash) as n FROM live_events WHERE event_type = 'share_shop' AND ts >= ?").bind(now - 7 * DAY));
  await ensureShopsTable(env);
  stmts.push(env.COUNTMY_DB.prepare('SELECT COUNT(*) as n, COALESCE(SUM(views), 0) as v FROM live_shops'));
  stmts.push(env.COUNTMY_DB.prepare('SELECT COUNT(*) as n FROM live_shops WHERE created_at >= ?').bind(now - 7 * DAY));
  await env.COUNTMY_DB.prepare('CREATE TABLE IF NOT EXISTS devices (device_hash TEXT PRIMARY KEY, source TEXT NOT NULL, first_ts INTEGER NOT NULL, saved_ts INTEGER)').run();
  // Funnel by the build a device first saw (16 Sep): opened -> tapped the
  // button -> made a record -> asked. This is how a first-screen change is
  // judged: activation per version, not opinion.
  stmts.push(env.COUNTMY_DB.prepare(
    "SELECT COALESCE(first_ver, '') as ver, COUNT(*) as devices, SUM(CASE WHEN country = 'GH' THEN 1 ELSE 0 END) as gh, SUM(CASE WHEN tapped_ts IS NOT NULL THEN 1 ELSE 0 END) as tapped, SUM(CASE WHEN saved_ts IS NOT NULL THEN 1 ELSE 0 END) as recorded, SUM(CASE WHEN asked_ts IS NOT NULL THEN 1 ELSE 0 END) as asked, SUM(CASE WHEN installed_ts IS NOT NULL THEN 1 ELSE 0 END) as installed, SUM(CASE WHEN mobile = 1 THEN 1 ELSE 0 END) as mobile FROM people_devices GROUP BY ver ORDER BY ver DESC LIMIT 30"
  ));
  // Memory activation by cohort: of the devices that made a record, how many
  // asked a question - with the spoken prompt (nudge 1) and without (0).
  stmts.push(env.COUNTMY_DB.prepare(
    'SELECT nudge, COUNT(*) as devices, SUM(CASE WHEN saved_ts IS NOT NULL THEN 1 ELSE 0 END) as activated, SUM(CASE WHEN saved_ts IS NOT NULL AND asked_ts IS NOT NULL THEN 1 ELSE 0 END) as asked, SUM(CASE WHEN country = ? THEN 1 ELSE 0 END) as gh FROM people_devices GROUP BY nudge'
  ).bind('GH'));
  stmts.push(env.COUNTMY_DB.prepare(
    "SELECT source, COUNT(*) as n, SUM(CASE WHEN first_ts >= ? THEN 1 ELSE 0 END) as n7, SUM(CASE WHEN saved_ts IS NOT NULL THEN 1 ELSE 0 END) as activated, SUM(CASE WHEN country = 'GH' THEN 1 ELSE 0 END) as gh, SUM(CASE WHEN mobile = 1 THEN 1 ELSE 0 END) as mobile FROM people_devices GROUP BY source ORDER BY n DESC LIMIT 40"
  ).bind(now - 7 * DAY));

  stmts.push(env.COUNTMY_DB.prepare("SELECT asn_org, COUNT(*) as n, SUM(CASE WHEN country = 'GH' THEN 1 ELSE 0 END) as gh FROM live_devices WHERE COALESCE(is_dc, 0) = 1 GROUP BY asn_org ORDER BY n DESC LIMIT 15"));
  stmts.push(env.COUNTMY_DB.prepare("SELECT COALESCE(lang, '') as lang, COUNT(*) as n FROM people_devices GROUP BY lang ORDER BY n DESC LIMIT 12"));
  // Spoken language per voice entry, and how long a real person takes from
  // opening to the first tap and to the first record (the "30 seconds" test).
  stmts.push(env.COUNTMY_DB.prepare("SELECT event_type, COUNT(*) as n, COUNT(DISTINCT shop_hash) as devices FROM live_events WHERE event_type IN ('voice_en', 'voice_twi', 'voice_pidgin') GROUP BY event_type"));
  stmts.push(env.COUNTMY_DB.prepare('SELECT tapped_ts - first_ts as ms FROM people_devices WHERE tapped_ts IS NOT NULL AND tapped_ts >= first_ts ORDER BY ms LIMIT 500'));
  stmts.push(env.COUNTMY_DB.prepare('SELECT saved_ts - first_ts as ms FROM people_devices WHERE saved_ts IS NOT NULL AND saved_ts >= first_ts ORDER BY ms LIMIT 500'));
  stmts.push(env.COUNTMY_DB.prepare('SELECT (SELECT COUNT(*) FROM devices WHERE is_test = 1) as devices, (SELECT COUNT(*) FROM events WHERE is_test = 1) as events, (SELECT COUNT(*) FROM entries WHERE is_test = 1) as entries, (SELECT COUNT(*) FROM shops WHERE is_test = 1) as shops'));
  const results = await env.COUNTMY_DB.batch(stmts);

  const out = { generatedAt: now, periods: {}, daily: { signups: {}, active: {}, entries: {} }, loop: {} };
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
  const one = () => ((results[i++].results || [])[0] || {});
  out.loop.returning7 = one().n || 0;
  out.loop.returning30 = one().n || 0;
  out.loop.asked = one().n || 0;
  out.loop.sharedEver = one().n || 0;
  out.loop.shared7 = one().n || 0;
  const shopsRow = one();
  out.loop.shops = shopsRow.n || 0;
  out.loop.shopViews = shopsRow.v || 0;
  out.loop.shops7 = one().n || 0;
  out.test = ((results[results.length - 1].results || [])[0]) || { devices: 0, events: 0, entries: 0, shops: 0 };
  out.funnel = (results[i++].results || []).map(r => ({ ver: r.ver || 'before v85', devices: r.devices || 0, gh: r.gh || 0, tapped: r.tapped || 0, recorded: r.recorded || 0, asked: r.asked || 0, installed: r.installed || 0, mobile: r.mobile || 0 }));
  out.cohorts = (results[i++].results || []).map(r => ({ nudge: r.nudge, devices: r.devices || 0, activated: r.activated || 0, asked: r.asked || 0, gh: r.gh || 0 }));
  out.sources = (results[i++].results || []).map(r => ({ source: r.source, devices: r.n || 0, week: r.n7 || 0, activated: r.activated || 0, gh: r.gh || 0, mobile: r.mobile || 0 }));
  out.datacentre = (results[i++].results || []).map(r => ({ org: r.asn_org || '', devices: r.n || 0, gh: r.gh || 0 }));
  out.languages = (results[i++].results || []).map(r => ({ lang: r.lang || '(none)', devices: r.n || 0 }));
  out.spoken = (results[i++].results || []).map(r => ({ lang: String(r.event_type).replace('voice_', ''), entries: r.n || 0, devices: r.devices || 0 }));
  const median = rows => { const v = rows.map(r => Number(r.ms)).filter(x => x >= 0); if (!v.length) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
  const tapRows = results[i++].results || [], recRows = results[i++].results || [];
  out.timing = { tapMedianMs: median(tapRows), tapN: tapRows.length, recordMedianMs: median(recRows), recordN: recRows.length };

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
async function transcribeAudio(audioBytes, audioType, env, lang) {
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
    // 17 Sep: Spanish (Venezuela) gets an explicit language so Whisper never
    // guesses Portuguese/Italian on a short clip, plus a short vocabulary
    // prompt in both languages so money words are spelled the way the
    // extractor expects. English/Twi/Pidgin keeps auto-detect (Twi is not a
    // Whisper language; forcing 'en' hurt Pidgin - see above).
    const whisperInput = { audio: base64Audio };
    if (lang === 'es') {
      whisperInput.language = 'es';
      whisperInput.initial_prompt = 'Vendí, compré, me debe, le debo, fiao, dólares, bolívares, bs, cedis.';
    } else {
      whisperInput.initial_prompt = 'Sold, bought, owes me, cedis, momo, Ama, Kofi.';
    }
    result = await env.AI.run('@cf/openai/whisper-large-v3-turbo', whisperInput);
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
  if (!audio) return cors(new Response(JSON.stringify({ error: 'no audio received' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
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
const WORKER_VERSION = 'w42';

// Spanish (Venezuela) twin of EXTRACT_SYSTEM_PROMPT below: same event types,
// same {value, evidence} rule, same JSON-only answer. Amounts are bare
// numbers; the currency word is kept in "currency" evidence only so the app
// can show $ or Bs. "fiao/fiado" = sold on credit = debt_in.
const EXTRACT_SYSTEM_PROMPT_ES = `Lees una transcripción de voz, posiblemente desordenada, de un vendedor o comerciante venezolano contando qué pasó hoy en su negocio, en español (puede usar palabras como "fiao", "fiado", "me quedó debiendo", "plata", "real", "lucas", "verdes", "dólares", "bolívares", "bs"). Extrae cada evento de negocio distinto como un arreglo JSON. Cada evento es de uno de estos tipos:
- "sale": el dueño vendió algo. Campos: type, item, qty, y O BIEN price (precio por unidad, solo si se dijo un precio por unidad) O BIEN total (el monto total dicho, si solo se dijo un total - por ejemplo "2 sacos por 300" tiene qty 2 y total 300, NO price 150 - nunca hagas la división tú mismo).
- "expense": el dueño gastó dinero en algo. Campos: type, item, price (monto total).
- "debt_in": un cliente le debe dinero al dueño (incluye "fiao", "fiado", "me debe", "me quedó debiendo"). Campos: type, customer (nombre de la persona), price (monto), note (opcional, por qué).
- "debt_out": el dueño le debe a un proveedor. Campos: type, supplier (nombre de la persona o negocio), price (monto), note (opcional).
REGLA CRÍTICA: cada campo excepto "type" debe ser un objeto {"value": ..., "evidence": "..."}, donde "evidence" es el fragmento EXACTO copiado palabra por palabra de la transcripción en el que se basa el valor (por ejemplo evidence "tres" para qty 3, evidence "300" para total 300, evidence "Carlos" para customer). NUNCA inventes evidence para un número que calculaste tú. Si no puedes señalar palabras reales que respalden un campo, NO incluyas ese campo - no adivines, no uses precios típicos. Los "value" de qty, price y total deben ser números simples. Ignora palabras de ruido que no encajan con ningún producto.
Responde SOLO con un arreglo JSON crudo, sin prosa, sin marcas de código, sin campos extra. Si no hay nada extraíble, responde [].
Si alguien le debe al dueño y no se dijo un nombre (por ejemplo "un cliente me debe 20 dólares"), igual devuelve debt_in usando la palabra exacta dicha para la persona, como "cliente".
Ejemplos, uno por tipo - todos los tipos son igual de probables, NO asumas que es una venta:
[{"type":"sale","item":{"value":"arroz","evidence":"arroz"},"qty":{"value":5,"evidence":"cinco"},"price":{"value":2,"evidence":"dos dólares"}}]
[{"type":"sale","item":{"value":"camisas","evidence":"camisas"},"qty":{"value":2,"evidence":"dos"},"total":{"value":30,"evidence":"30"}}]
[{"type":"expense","item":{"value":"transporte","evidence":"transporte"},"price":{"value":5,"evidence":"5 dólares"}}]
[{"type":"expense","item":{"value":"mercancía","evidence":"mercancía"},"price":{"value":200,"evidence":"200"}}]
[{"type":"debt_in","customer":{"value":"Carlos","evidence":"Carlos"},"price":{"value":20,"evidence":"20 dólares"}}]
[{"type":"debt_in","customer":{"value":"María","evidence":"María"},"price":{"value":15,"evidence":"quince"},"note":{"value":"fiao","evidence":"fiao"}}]
[{"type":"debt_out","supplier":{"value":"Pedro","evidence":"Pedro"},"price":{"value":400,"evidence":"400"}}]`;

const EXTRACT_SYSTEM_PROMPT = `You read a rough, possibly messy speech-to-text transcript from a Ghanaian shop owner describing what happened in their shop today, in English, Twi or Pidgin (Twi numbers: baako 1, mmienu 2, mmiensa 3, enan 4, anum 5, du 10, aduonu 20, aduasa 30, aduonum 50, oha 100, apem 1000; "de me ka" = owes me; transcripts may contain mistranscribed words like "cds" for "cedis"). Extract every distinct business event as a JSON array. Each event is one of these types:
- "sale": the owner sold something. Fields: type, item, qty, and EITHER price (per-unit price in cedis, only if a per-unit price was actually spoken) OR total (the total amount actually spoken, if only a total was said - e.g. "2 bags for 300" has qty 2 and total 300, NOT price 150 - never do the division yourself).
- "expense": the owner spent money on something. Fields: type, item, price (total amount in cedis).
- "debt_in": a customer owes the owner money. Fields: type, customer (the person's name), price (amount owed in cedis), note (optional, what for).
- "debt_out": the owner owes a supplier money. Fields: type, supplier (the person/business name), price (amount owed in cedis), note (optional).
CRITICAL RULE: every field except "type" must be an object of the form {"value": ..., "evidence": "..."}, where "evidence" is the EXACT short substring copied word-for-word from the transcript that this value is based on (e.g. evidence "three" for qty 3, evidence "300" for total 300, evidence "Kwame" for customer). NEVER invent evidence text for a number you calculated yourself (like a divided-out per-unit price) - only use evidence for words that were ACTUALLY spoken. If you cannot point to actual words in the transcript supporting a field, DO NOT include that field at all - do not guess, do not use general knowledge about typical prices. qty, price, and total "value" must be plain numbers. Ignore transcription noise words that don't fit any product (like a stray "cds" or "think" with no context) - do not turn noise into a fabricated item.
Respond with ONLY a raw JSON array, no prose, no markdown fences, no extra fields beyond what's listed above. If nothing extractable, respond with [].
If someone owes the owner money and no personal name was said (e.g. "a customer owes me 80 cedis"), still return debt_in and use the exact word that was spoken for the person, such as "customer".
Examples, one per type - every type below is equally likely, do NOT assume an utterance is a sale:
[{"type":"sale","item":{"value":"rice","evidence":"rice"},"qty":{"value":5,"evidence":"five"},"price":{"value":10,"evidence":"ten cedis"}}]
[{"type":"sale","item":{"value":"bags","evidence":"bags"},"qty":{"value":2,"evidence":"two"},"total":{"value":300,"evidence":"300"}}]
[{"type":"expense","item":{"value":"transport","evidence":"transport"},"price":{"value":35,"evidence":"35 cedis"}}]
[{"type":"expense","item":{"value":"stock","evidence":"stock"},"price":{"value":200,"evidence":"200 cedis"}}]
[{"type":"debt_in","customer":{"value":"Ama","evidence":"Ama"},"price":{"value":120,"evidence":"120 cedis"}}]
[{"type":"debt_in","customer":{"value":"Kofi","evidence":"Kofi"},"price":{"value":50,"evidence":"fifty cedis"},"note":{"value":"soap","evidence":"soap"}}]
[{"type":"debt_out","supplier":{"value":"Mensah","evidence":"Mensah"},"price":{"value":400,"evidence":"400 cedis"}}]`;

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
  // Akan open vowels folded to ASCII first (15 Sep), otherwise the plain
  // a-z strip splits a Twi number word like "aduoson" (70) in two.
  return String(s).toLowerCase().replace(/\u0254/g, 'o').replace(/\u025b/g, 'e')
    // Spanish accents and n-tilde (17 Sep): "María" must stay one token.
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
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
// Akan (Twi) number words, ASCII-folded (15 Sep). Live test the same day:
// "meton rice bags mmienu, cedis aduasa" came back as qty 20 / price 180,
// "anum" (5) became 1, "baako" (1) vanished - the model half-knows these and
// the grounding check below, which only knew English number words, rejected
// or mangled the rest. Akan compounds are additive ("oha aduonu" = 100+20), so
// every run of consecutive number words yields its running sums as candidates.
const TWI_NUMBERS = {
  baako: 1, koro: 1, mmienu: 2, mienu: 2, abien: 2, mmiensa: 3, miensa: 3, abiesa: 3, enan: 4, anan: 4, nan: 4,
  anum: 5, enum: 5, num: 5, nsia: 6, asia: 6, nson: 7, ason: 7, nwotwe: 8, awotwe: 8, nkron: 9, akron: 9,
  du: 10, edu: 10, dubaako: 11, dummienu: 12, dumienu: 12, dumiensa: 13, dunan: 14, dunum: 15, dunsia: 16,
  dunson: 17, dunwotwe: 18, dunkron: 19,
  aduonu: 20, aduasa: 30, aduanan: 40, aduonum: 50, aduosia: 60, aduoson: 70, aduowotwe: 80, aduokron: 90,
  oha: 100, ha: 100, ahanu: 200, ahaanu: 200, ahasa: 300, ahanan: 400, ahanum: 500, ahasia: 600, ahason: 700,
  ahawotwe: 800, ahakron: 900, apem: 1000
};
function twiNumberCandidates(transcriptNorm) {
  const out = new Set();
  let run = 0;
  for (const tok of transcriptNorm.split(' ')) {
    const v = Object.prototype.hasOwnProperty.call(TWI_NUMBERS, tok) ? TWI_NUMBERS[tok] : undefined;
    if (v === undefined) { run = 0; continue; }
    out.add(v);
    run += v;
    out.add(run);
  }
  return out;
}

function valueGroundedInTranscript(value, transcriptNorm) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return false;
    const asDigits = String(value);
    if (transcriptNorm.includes(asDigits)) return true;
    // 30.5 is never spoken as words; only whole numbers get the word check.
    if (numberWordForms(value).some(w => transcriptNorm.includes(w))) return true;
    return twiNumberCandidates(transcriptNorm).has(value);
  }
  if (typeof value === 'string') {
    const norm = normalizeForMatch(value);
    // Two chars or fewer would match almost anything.
    if (!norm || norm.length < 3 || norm.length > 60) return false;
    return transcriptNorm.includes(norm);
  }
  return false;
}

// If the evidence the model points at is made only of Twi number words, the
// value is whatever those words add up to - not what the model thinks they
// mean. Live, 15 Sep: it pointed at "aduonum" (50) and wrote 1000, and the
// evidence check alone let that through because the word really was said.
function twiEvidenceValue(evidence) {
  const IGNORE = new Set(['cedis', 'cedi', 'ghs', 'cds', 'cd', 'ma', 'no', 'ye', 'yee', 'ne']);
  const toks = normalizeForMatch(evidence).split(' ').filter(t => t && !IGNORE.has(t));
  if (!toks.length) return undefined;
  let sum = 0;
  for (const t of toks) {
    if (!Object.prototype.hasOwnProperty.call(TWI_NUMBERS, t)) return undefined;
    sum += TWI_NUMBERS[t];
  }
  return sum;
}

// Twi amounts in the transcript, as the sums of each run of number words,
// largest first. "cedis aduasa" -> [30]; "ntoma anum, cedis oha" -> [100, 5].
function twiRunSums(transcriptNorm) {
  const sums = [];
  let run = 0, inRun = false;
  for (const tok of transcriptNorm.split(' ')) {
    const own = Object.prototype.hasOwnProperty.call(TWI_NUMBERS, tok);
    if (own) { run += TWI_NUMBERS[tok]; inRun = true; continue; }
    if (inRun) { sums.push(run); run = 0; inRun = false; }
  }
  if (inRun) sums.push(run);
  return sums.sort((a, b) => b - a);
}

function fieldValue(raw, transcriptNorm, fieldName) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if (typeof raw.value === 'number') {
    const twi = twiEvidenceValue(raw.evidence);
    if (twi !== undefined) return twi;
    if (valueGroundedInTranscript(raw.value, transcriptNorm)) return raw.value;
    // The model's number matches nothing that was said. If Twi number words
    // were said, the amount is the largest Twi run and a quantity the
    // smallest - deterministic, and right for "ntoma anum, cedis oha".
    const sums = twiRunSums(transcriptNorm);
    if (sums.length) return fieldName === 'qty' ? sums[sums.length - 1] : sums[0];
    return evidenceVerified(raw.evidence, transcriptNorm) ? raw.value : undefined;
  }
  if (valueGroundedInTranscript(raw.value, transcriptNorm)) return raw.value;
  // A string the model made up but pinned to real spoken words - typically a
  // translation ("ntoma" -> "money"). The word she said is the record.
  if (evidenceVerified(raw.evidence, transcriptNorm)) return String(raw.evidence).trim();
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

// Which way does a debt run? Decided from the words she said, never from the
// model. Battery, 15 Sep: "I owe Kofi 50 cedis" came back as Kofi owing HER -
// an inverted debt is the one error a trader cannot see and cannot forgive.
// "I owe", "we owe", "I still owe" -> she owes them. "owes me", "owe me",
// "de me ka", "dey owe me" -> they owe her. If the transcript says one and
// the model said the other, the model is corrected. If it says neither, the
// model's call stands.
const OWED_BY_ME = /\b(i|we)\s+(still\s+|also\s+)?owe\b(?!\s+me\b)/;
const OWED_TO_ME = /\b(owes?\s+me|de\s+me\s+ka|dey\s+owe\s+me|owing\s+me)\b/;
function debtDirection(transcriptNorm) {
  const byMe = OWED_BY_ME.test(transcriptNorm);
  const toMe = OWED_TO_ME.test(transcriptNorm);
  if (byMe && !toMe) return 'debt_out';
  if (toMe && !byMe) return 'debt_in';
  return null;
}
function fixDebtDirection(events, transcriptNorm) {
  const dir = debtDirection(transcriptNorm);
  if (!dir) return events;
  return events.map(e => {
    if (e.type === 'debt_in' && dir === 'debt_out') {
      const { customer, ...rest } = e;
      return { ...rest, type: 'debt_out', supplier: customer };
    }
    if (e.type === 'debt_out' && dir === 'debt_in') {
      const { supplier, ...rest } = e;
      return { ...rest, type: 'debt_in', customer: supplier };
    }
    return e;
  });
}

// Last resort when the model returns nothing for the plainest possible debt
// sentence ("I owe Mensah 400 cedis" came back empty, 15 Sep): a strict
// pattern, digits only, name must be a single capitalised-or-plain word
// right after "owe". Anything looser is left to the model.
// Spanish twin of debtFallback: "le debo a Pedro 400" / "Carlos me debe 20".
function debtFallbackEs(transcript) {
  const t = String(transcript || '').toLowerCase();
  let m = t.match(/\ble\s+debo\s+a\s+([a-záéíóúñ]+)\s+(\d{1,7})/i);
  if (m) return [{ type: 'debt_out', supplier: m[1], price: Number(m[2]) }];
  m = t.match(/\b([a-záéíóúñ]+)\s+me\s+(?:debe|quedó\s+debiendo|quedo\s+debiendo)\s+(\d{1,7})/i);
  if (m) return [{ type: 'debt_in', customer: m[1], price: Number(m[2]) }];
  return [];
}
function debtFallback(transcript) {
  const m = /\b(?:i|we)\s+(?:still\s+)?owe\s+([a-z]+)\s+(\d{1,7})\s*(?:cedis|cedi|ghs|cds)?\b/i.exec(transcript || '');
  if (!m) return [];
  const name = m[1];
  if (/^(me|him|her|them|you|it|the|a|an|my|our)$/i.test(name)) return [];
  return [{ type: 'debt_out', supplier: name, price: Number(m[2]) }];
}

function sanitizeEvents(rawEvents, transcript) {
  const transcriptNorm = normalizeForMatch(transcript || '');
  const clean = buildCleanEvents(rawEvents, (e, key) => fieldValue(e[key], transcriptNorm, key));
  return fixDebtDirection(clean, transcriptNorm);
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
// Does the sentence contain an amount at all? Used only to decide whether a
// completely empty extraction is worth one more attempt - there is no point
// retrying "hello" or a cough.
// Spanish number words to digits (17 Sep): the 3B extractor dropped
// "veinte dólares" and "mil quinientos bolos" while handling "20" fine, so
// the transcript is normalised first and the evidence rule then matches
// the digits. Handles 0-999999 built from units, tens (+ y), hundreds, mil.
const ES_UNITS = { cero: 0, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29 };
const ES_TENS = { treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 };
const ES_HUNDREDS = { cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400, quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600, setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900 };
function spanishNumbersToDigits(text) {
  const fold = w => w.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const words = String(text || '').split(/(\s+)/);
  const out = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^\s+$/.test(w) || w === '') { out.push(w); i++; continue; }
    const f = fold(w).replace(/[.,;:!?]+$/, '');
    const isNum = t => t in ES_UNITS || t in ES_TENS || t in ES_HUNDREDS || t === 'mil';
    if (!isNum(f) || f === 'una' || f === 'uno') { out.push(w); i++; continue; }
    // consume a run of number words (with "y" joining tens and units);
    // `last` is the index just after the final number word, so the spaces
    // that follow the run are kept ("20 dólares", not "20dólares").
    let total = 0, cur = 0, j = i, any = false, last = i;
    while (j < words.length) {
      const wj = words[j];
      if (/^\s+$/.test(wj) || wj === '') { j++; continue; }
      const fj = fold(wj).replace(/[.,;:!?]+$/, '');
      if (fj === 'y' && any) { j++; continue; }
      if (fj in ES_HUNDREDS) { cur += ES_HUNDREDS[fj]; any = true; }
      else if (fj in ES_TENS) { cur += ES_TENS[fj]; any = true; }
      else if (fj in ES_UNITS && fj !== 'una' && (fj !== 'uno' || any)) { cur += ES_UNITS[fj]; any = true; }
      else if (fj === 'mil') { total += (cur || 1) * 1000; cur = 0; any = true; }
      else break;
      j++; last = j;
    }
    if (!any) { out.push(w); i++; continue; }
    total += cur;
    const trailing = (words[last - 1] || '').match(/[.,;:!?]+$/);
    out.push(String(total) + (trailing ? trailing[0] : ''));
    i = last;
  }
  return out.join('');
}
function mentionsANumber(text) {
  const t = String(text || '').toLowerCase();
  if (/\d/.test(t)) return true;
  if (/\b(uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte|treinta|cuarenta|cincuenta|cien|ciento|quinientos|mil)\b/.test(t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) return true;
  return /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\b/.test(t);
}

async function runExtractionModel(text, env, temperature, lang) {
  // Spanish gets the 8B model (fp8-fast: cheaper than the plain 8B and far
  // better than 3B on two-event sentences); English keeps the tested 3B path.
  return env.AI.run(lang === 'es' ? '@cf/meta/llama-3.1-8b-instruct-fp8-fast' : '@cf/meta/llama-3.2-3b-instruct', {
    messages: [
      { role: 'system', content: lang === 'es' ? EXTRACT_SYSTEM_PROMPT_ES : EXTRACT_SYSTEM_PROMPT },
      { role: 'user', content: text }
    ],
    max_tokens: 700,
    // Real bug, measured live 4 Sep: with no temperature set, the model
    // samples at its default and the SAME sentence gives different answers on
    // different runs - "I spent 35 cedis on transport" extracted correctly on
    // one call and returned nothing at all on the next. For pulling three
    // fixed fields out of one short sentence there is no upside to sampling;
    // it is pure variance on top of an already-hard task. 0 makes the same
    // words always produce the same entry, which is also what makes this
    // testable at all.
    temperature
  });
}

async function extractFromText(text, env, lang) {
  if (!text) return { events: [] };
  let result;
  try {
    result = await runExtractionModel(text, env, 0, lang);
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

  let clean = sanitizeEvents(events, text);
  // Getting nothing back is the worst outcome there is: the owner spoke, the
  // app heard her, and then silently offered her nothing. If she clearly said
  // an amount and we still produced no entry, it is worth one more attempt -
  // at a non-zero temperature, since repeating the deterministic call would
  // return the identical empty answer. Only ever one retry, and only when a
  // number was actually mentioned, so a cough never costs a second call.
  if (clean.length === 0 && mentionsANumber(text)) {
    try {
      const retry = await runExtractionModel(text, env, 0.4, lang);
      const retryField = retry && retry.response;
      let retryEvents = [];
      if (Array.isArray(retryField)) {
        retryEvents = retryField;
      } else if (typeof retryField === 'string') {
        try {
          const m = retryField.match(/\[[\s\S]*\]/);
          retryEvents = m ? JSON.parse(m[0]) : [];
        } catch (e) { retryEvents = []; }
      }
      if (Array.isArray(retryEvents)) clean = sanitizeEvents(retryEvents, text);
    } catch (e) {
      // Keep the empty first answer; a failed retry must never fail the request.
    }
  }

  if (clean.length === 0) clean = lang === 'es' ? debtFallbackEs(text) : debtFallback(text);
  if (lang === 'es') {
    const tt = String(text).toLowerCase();
    // A name of one or two letters is a preposition the model grabbed
    // ("fié a María" -> customer "a"), never a person.
    clean = clean.filter(e => (e.item || e.customer || e.supplier || '').trim().length > 2);
    // One number in the sentence and an event without an amount: that number
    // is the amount ("Pedro me quedó debiendo 2000 bolos").
    const nums = (tt.match(/\d+(?:[.,]\d+)?/g) || []);
    if (nums.length === 1) clean = clean.map(e => (e.price === undefined && e.type !== 'sale') ? Object.assign({}, e, { price: Number(nums[0].replace(',', '.')) }) : e);
    // Currency per event: the money word nearest AFTER the event's amount
    // decides; if none, the sentence-wide word; default dollars (Venezuela
    // prices in dollars and pays in bolívares).
    const isBs = /bol[ií]var|\bbolos?\b|\bbs\b/, isUsd = /d[oó]lar|\bverdes?\b|\$/;
    const curAt = pos => { const after = tt.slice(pos, pos + 40); return isBs.test(after) ? 'VES' : isUsd.test(after) ? 'USD' : null; };
    const global = isBs.test(tt) && !isUsd.test(tt) ? 'VES' : 'USD';
    clean = clean.map(e => {
      let cur = null;
      const amts = e.type === 'sale' && e.qty && e.price ? [String(e.price * e.qty), String(e.price)] : [String(e.price || '')];
      for (const x of amts) { const i = x ? tt.indexOf(x) : -1; if (i >= 0) { cur = curAt(i + x.length); if (cur) break; } }
      return Object.assign({}, e, { currency: cur || global });
    });
  }
  return { events: clean };
}

// Thin wrapper kept for backward compatibility.
// Spoken replies (17 Sep). The phone's own voice is robotic and has no
// Spanish worth hearing; this returns a short clip the app plays instead.
// English: MeloTTS (about one neuron per phrase). Spanish: Deepgram Aura-2
// Latin-American voice, which costs ~100x more, so it runs under a daily
// character cap in KV; past the cap (or on any error) the app falls back to
// the phone's voice. Clips are cached at the edge by URL, so a fixed phrase
// ("Saved.") costs once. Text is capped at 220 characters. Never logs the text.
const TTS_ES_DAILY_CHARS = 2500;
const TTS_EN_AURA_DAILY_CHARS = 3000;
async function ttsBudget(env, key, chars, cap) {
  const day = new Date().toISOString().slice(0, 10);
  const k = key + ':' + day;
  const used = Number((env.COUNTMY_STATUS && await env.COUNTMY_STATUS.get(k)) || 0);
  if (used + chars > cap) return false;
  if (env.COUNTMY_STATUS) await env.COUNTMY_STATUS.put(k, String(used + chars), { expirationTtl: 172800 });
  return true;
}
async function auraBytes(env, model, text, speaker) {
  const resp = await env.AI.run(model, { text, speaker, encoding: 'mp3' }, { returnRawResponse: true });
  if (!resp || !resp.ok) throw new Error(model + ' ' + (resp && resp.status));
  return new Uint8Array(await resp.arrayBuffer());
}
async function melottsBytes(env, text) {
  const r = await env.AI.run('@cf/myshell-ai/melotts', { prompt: text, lang: 'en' });
  if (r instanceof ArrayBuffer) return new Uint8Array(r);
  if (r instanceof Uint8Array) return r;
  if (r && typeof r.arrayBuffer === 'function') return new Uint8Array(await r.arrayBuffer());
  if (r && r.getReader) { const chunks = []; const rd = r.getReader(); for (;;) { const { done, value } = await rd.read(); if (done) break; chunks.push(value); } const n = chunks.reduce((a, c) => a + c.length, 0); const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out; }
  const b64 = r && (r.audio || (typeof r === 'string' ? r : ''));
  if (!b64) throw new Error('melotts empty');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
async function handleSay(request, env) {
  if (!env.AI) return cors(new Response('', { status: 503 }));
  const url = new URL(request.url);
  const lang = url.searchParams.get('l') === 'es' ? 'es' : 'en';
  const text = String(url.searchParams.get('t') || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  if (!text) return cors(new Response('', { status: 400 }));
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const edge = caches.default;
  const hit = await edge.match(cacheKey);
  if (hit) return cors(new Response(hit.body, hit));
  let bytes = null, mime = 'audio/mpeg', engine = '';
  try {
    if (lang === 'es') {
      if (!await ttsBudget(env, 'tts-es', text.length, TTS_ES_DAILY_CHARS)) return cors(new Response('', { status: 429 }));
      bytes = await auraBytes(env, '@cf/deepgram/aura-2-es', text, 'aquila'); engine = 'aura-2-es';
    } else {
      try { bytes = await melottsBytes(env, text); engine = 'melotts'; }
      catch (e1) {
        // MeloTTS returned AiError 3043 on 17 Sep; Aura-1 is the fallback,
        // ~70x dearer per phrase, so it lives under its own daily cap.
        if (!await ttsBudget(env, 'tts-en', text.length, TTS_EN_AURA_DAILY_CHARS)) throw e1;
        bytes = await auraBytes(env, '@cf/deepgram/aura-1', text, 'luna'); engine = 'aura-1';
      }
    }
  } catch (err) {
    console.log('say failed', { lang, chars: text.length, err: String(err).slice(0, 120) });
    return cors(new Response('', { status: 503 }));
  }
  console.log('say', { lang, engine, chars: text.length, bytes: bytes.length });
  const out = new Response(bytes, { headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable' } });
  try { await edge.put(cacheKey, out.clone()); } catch (e) { /* cache is a bonus */ }
  return cors(out);
}

async function handleExtract(request, env) {
  if (!env.AI) {
    return cors(new Response(JSON.stringify({ error: 'extraction not configured yet' }), { status: 503 }));
  }
  let body;
  try { body = await request.json(); } catch (e) {
    return cors(new Response(JSON.stringify({ error: 'invalid request' }), { status: 400 }));
  }
  let text = (body && body.text || '').trim();
  if (!text) return cors(new Response(JSON.stringify({ error: 'no text received' }), { status: 400 }));
  const lang = (body && body.lang) === 'es' ? 'es' : 'en';
  if (lang === 'es') text = spanishNumbersToDigits(text);
  const result = await extractFromText(text, env, lang);
  if (result.error) {
    return cors(new Response(JSON.stringify({ error: result.error, detail: result.detail }), { status: 502 }));
  }
  return cors(new Response(JSON.stringify({ events: result.events, wv: WORKER_VERSION }), {
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
  const t0 = Date.now();
  let incomingForm;
  try { incomingForm = await request.formData(); } catch (err) {
    console.log('transcribe form-error', { ctype: request.headers.get('content-type') || '', ua: (request.headers.get('user-agent') || '').slice(0, 80), err: String(err).slice(0, 120) });
    return cors(new Response(JSON.stringify({ error: 'bad upload', detail: String(err).slice(0, 120) }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
  }
  const audio = incomingForm.get('audio');
  // Field diagnostics (17 Sep, observability on): size, type, browser family
  // and outcome per voice upload. Never the audio, never the words.
  const diag = { bytes: (audio && audio.size) || 0, type: (audio && audio.type) || '', ua: (request.headers.get('user-agent') || '').slice(0, 80), country: (request.cf && request.cf.country) || '' };
  if (!audio) { console.log('transcribe no-audio', diag); return cors(new Response(JSON.stringify({ error: 'no audio received' }), { status: 400, headers: { 'Content-Type': 'application/json' } })); }
  const audioBytes = new Uint8Array(await audio.arrayBuffer());
  const lang = String(incomingForm.get('lang') || '') === 'es' ? 'es' : 'en';
  diag.lang = lang;

  const transcribed = await transcribeAudio(audioBytes, audio.type, env, lang);
  console.log('transcribe', Object.assign(diag, { ms: Date.now() - t0, ok: !transcribed.error, chars: (transcribed.text || '').length, err: transcribed.error ? String(transcribed.detail || transcribed.error).slice(0, 100) : '' }));
  if (transcribed.error) {
    return cors(new Response(JSON.stringify({ text: '', events: [], error: transcribed.error, detail: transcribed.detail }), { status: 502, headers: { 'Content-Type': 'application/json' } }));
  }
  let text = transcribed.text || '';
  // Whisper answers silence and noise with a stock phrase ("Thank you.",
  // "Bye.", "."). Treat those as nothing heard, so the phone says so instead
  // of "I heard 'Thank you' but could not work out what happened".
  if (/^[\s.!?,¡¿]*$|^(thank you|thanks|thank you very much|bye|you|okay|ok|hello|hi|mm+|hmm+|uh+|gracias|muchas gracias|adiós|adios|hola|sí|si)[.!?]?$/i.test(text.trim()) || /amara\.org|subt[ií]tulos/i.test(text)) text = '';
  if (!text.trim()) {
    return cors(new Response(JSON.stringify({ text: '', events: [] }), { headers: { 'Content-Type': 'application/json' } }));
  }
  if (lang === 'es') text = spanishNumbersToDigits(text);
  const extracted = await extractFromText(text, env, lang);
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
      const isAiRoute = path === '/transcribe' || path === '/extract' || path === '/transcribe-and-extract' || path === '/extract-from-image' || path === '/say';
      const isWriteRoute = path === '/ping' || path === '/sync' || path === '/shop';
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
      if (path === '/say' && request.method === 'GET') return withLimitHeader(await handleSay(request, env));
      if (path === '/extract' && request.method === 'POST') return withLimitHeader(await handleExtract(request, env));
      if (path === '/transcribe-and-extract' && request.method === 'POST') return withLimitHeader(await handleTranscribeAndExtract(request, env));
      if (path === '/extract-from-image' && request.method === 'POST') return withLimitHeader(await handleExtractFromImage(request, env));
      if (path === '/ping' && request.method === 'POST') return withLimitHeader(await handlePing(request, env));
      if (path === '/sync' && request.method === 'POST') return withLimitHeader(await handleSync(request, env));
      if (path === '/shop' && request.method === 'POST') return withLimitHeader(await handleShopUpsert(request, env));
      if (path.startsWith('/shop/') && request.method === 'GET') return withLimitHeader(await handleShopJson(env, path.slice(6).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 44)));
      if (path.startsWith('/b/') && request.method === 'GET') return await handleShopPage(request, env, path.slice(3).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 44));

      let adminResp = null;
      if (path === '/admin/stats' && request.method === 'GET') adminResp = await handleAdminStats(request, env);
      else if (path === '/admin/shop' && request.method === 'GET') adminResp = await handleShopActivity(request, env);
      else if (path === '/admin/entries' && request.method === 'GET') adminResp = await handleAdminEntries(request, env);
      else if (path === '/admin/entries/recent' && request.method === 'GET') adminResp = await handleAdminRecentEntries(request, env);
      else if (path === '/admin/programme' && request.method === 'GET') adminResp = await handleProgrammeReport(request, env);
      if (adminResp) {
        if (adminResp.status === 401) await bumpAdminFail(env, ip);
        return adminResp;
      }
      return cors(new Response('Not found', { status: 404 }));
    } catch (err) {
      // Visible in the Worker logs: which route, which phone, what broke.
      console.log('unhandled', { path, ua: (request.headers.get('user-agent') || '').slice(0, 80), err: String(err).slice(0, 200) });
      return cors(new Response(JSON.stringify({ error: 'server error', detail: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
    }
  }
};
