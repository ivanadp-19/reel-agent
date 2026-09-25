// Form login for public mode (Railway): GET /login shows a form, POST /login checks
// the same bcrypt users as basic auth (REEL_AUTH_BCRYPT) and sets a signed session
// cookie, POST /logout clears it. The gate (server/http.mjs) accepts that cookie next to
// basic auth and the x-reel-token. Automated browsers cannot answer the native
// basic-auth dialog; a form they can fill.
//
// Cookie: reel_session=<base64url(JSON {u, exp})>.<base64url(HMAC-SHA256)>, httpOnly,
// SameSite=Lax, Secure always in public mode (else when the request came over https),
// 7 days. The key is REEL_SESSION_SECRET, or the first token of REEL_BACKEND_TOKEN when
// that is unset (server/index.mjs picks it). The MAC also covers a fragment of the
// user's bcrypt hash, so changing a user's password in REEL_AUTH_BCRYPT ends that
// user's sessions; a user who left REEL_AUTH_BCRYPT is refused too, both before expiry.
// POST /login and /logout need an Origin (or Referer) of this site (login CSRF).
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

export const SESSION_COOKIE = 'reel_session';
export const SESSION_TTL_MS = 7 * 86400e3;
const PREFIX = 'reel-session.v1.'; // domain separation: the key may also be a backend token

const b64url = (buf) => Buffer.from(buf).toString('base64url');
// the bcrypt checksum (last 31 chars): a new password (new salt + hash) changes it
const hashTag = (hash) => String(hash).slice(-31);
const mac = (secret, payload, hash) => crypto.createHmac('sha256', String(secret)).update(`${PREFIX}${payload}.${hashTag(hash)}`).digest();

// `hash` = the user's bcrypt hash from REEL_AUTH_BCRYPT
export function signSession(secret, user, {hash, now = Date.now(), ttlMs = SESSION_TTL_MS} = {}) {
  if (!secret) throw new Error('no session secret');
  if (!hash) throw new Error('no user hash');
  const payload = b64url(JSON.stringify({u: user, exp: now + ttlMs}));
  return `${payload}.${b64url(mac(secret, payload, hash))}`;
}

// → the user name, or null (bad signature, malformed, expired, unknown user, password changed)
export function verifySession(secret, value, {now = Date.now(), users} = {}) {
  if (!secret || !users || typeof value !== 'string') return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  if (!data || typeof data.u !== 'string' || !Number.isFinite(data.exp)) return null;
  // an unknown user is checked against a fixed tag, so the MAC always runs
  const hash = Object.hasOwn(users, data.u) ? users[data.u] : null;
  const sig = Buffer.from(value.slice(dot + 1), 'base64url');
  const want = mac(secret, payload, hash || '');
  if (sig.length !== want.length || !crypto.timingSafeEqual(sig, want)) return null;
  if (!hash || data.exp <= now) return null;
  return data.u;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) { try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); } }
  }
  return out;
}

export const sessionUser = (req, secret, users) => verifySession(secret, parseCookies(req.headers.cookie)[SESSION_COOKIE], {users});

const isHttps = (req) => Boolean(req.socket?.encrypted) || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
function cookieHeader(req, value, maxAgeSec, forceSecure) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${forceSecure || isHttps(req) ? '; Secure' : ''}`;
}

// Where to go after the login: a path on this site only (no //host, no scheme, no
// control characters — browsers drop a tab or newline and "/\t/evil" becomes "//evil")
const NEXT_BASE = 'http://reel.invalid';
export function safeNext(next) {
  if (typeof next !== 'string' || !/^\/(?![/\\])/.test(next) || /[\x00-\x1f\x7f]/.test(next)) return '/';
  try { return new URL(next, NEXT_BASE).origin === NEXT_BASE ? next : '/'; } catch { return '/'; }
}

// Login attempts per client IP: at most `max` in a sliding `windowMs`. In memory.
// An attempt is counted BEFORE the password is checked (`attempt`) and handed back
// when it succeeds (`release`), so parallel requests cannot all slip past the check.
// Idle IPs are swept at most once per window, so the map does not grow without bound.
export function createLoginLimiter({max = 5, windowMs = 60e3} = {}) {
  const hits = new Map(); // ip → [timestamps]
  let swept = 0;
  const recent = (ip, now) => {
    const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (list.length) hits.set(ip, list); else hits.delete(ip);
    return list;
  };
  const sweep = (now) => {
    if (now - swept < windowMs) return;
    swept = now;
    for (const ip of [...hits.keys()]) recent(ip, now);
  };
  const wait = (list, now) => Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000));
  return {
    // → seconds to wait, or 0 when the client may try (read-only)
    retryAfter(ip, now = Date.now()) {
      const list = recent(ip, now);
      return list.length >= max ? wait(list, now) : 0;
    },
    // reserve a slot → 0 (counted, go ahead) or the seconds to wait (not counted)
    attempt(ip, now = Date.now()) {
      sweep(now);
      const list = recent(ip, now);
      if (list.length >= max) return wait(list, now);
      hits.set(ip, [...list, now]);
      return 0;
    },
    // the attempt made at `at` succeeded: it no longer counts
    release(ip, at) {
      const list = hits.get(ip);
      const i = list ? list.indexOf(at) : -1;
      if (i < 0) return;
      list.splice(i, 1);
      if (!list.length) hits.delete(ip);
    },
    get size() { return hits.size; },
  };
}

// Proxy hops to trust from REEL_TRUST_PROXY: a number (Railway: 1), "true" = 1, else 0
export const trustedHops = (v = process.env.REEL_TRUST_PROXY) => (/^\d+$/.test(String(v ?? '')) ? +v : /^(true|yes)$/i.test(String(v ?? '')) ? 1 : 0);

// The client's IP. X-Forwarded-For only behind trusted proxies (`hops`, REEL_TRUST_PROXY):
// each appends the address it saw, so the entry `hops` from the end is the one the
// outermost trusted proxy saw (earlier ones are whatever the client claimed). Without
// a trusted proxy the header is the client's own words: the socket address counts.
export function clientIp(req, hops = 0) {
  if (hops > 0) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[Math.max(0, xff.length - hops)];
  }
  return req.socket?.remoteAddress || 'unknown';
}

// A POST from this site: its Origin (else Referer) names the host the request came
// to (Host, the trusted proxy's X-Forwarded-Host, or REEL_PUBLIC_URL). None → refused.
export function sameSite(req, {hops = 0, publicUrl = process.env.REEL_PUBLIC_URL} = {}) {
  const from = req.headers.origin || req.headers.referer;
  if (!from || from === 'null') return false;
  let host;
  try { host = new URL(from).host.toLowerCase(); } catch { return false; }
  const hosts = new Set([String(req.headers.host || '').toLowerCase()]);
  if (hops > 0 && req.headers['x-forwarded-host']) hosts.add(String(req.headers['x-forwarded-host']).split(',')[0].trim().toLowerCase());
  if (publicUrl) { try { hosts.add(new URL(publicUrl).host.toLowerCase()); } catch {} }
  hosts.delete('');
  return hosts.has(host);
}

// A hash to compare against when the user does not exist, at the cost of the real
// hashes (bcrypt.getRounds of the first one: Caddy's are 14), so both failures cost the same
const dummies = new Map(); // rounds → Promise<hash>
function dummyHash(auth) {
  let rounds = 10;
  const first = Object.values(auth || {})[0];
  if (first) { try { rounds = bcrypt.getRounds(first); } catch {} }
  if (!dummies.has(rounds)) dummies.set(rounds, bcrypt.hash(crypto.randomBytes(16).toString('hex'), rounds));
  return dummies.get(rounds);
}
// → true when `pass` is `user`'s password. bcrypt always runs, known user or not.
export async function checkPassword(auth, user, pass) {
  const hash = typeof user === 'string' && user && Object.hasOwn(auth, user) ? auth[user] : null;
  const ok = await bcrypt.compare(String(pass ?? ''), hash || await dummyHash(auth)).catch(() => false);
  return ok && Boolean(hash);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
export function loginPage({error = '', next = '/'} = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Sign in · reel-agent</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111; color: #eee; font: 15px/1.4 system-ui, -apple-system, sans-serif; }
  form { width: min(320px, 90vw); display: grid; gap: 12px; padding: 28px; background: #1b1b1b; border: 1px solid #2c2c2c; border-radius: 10px; }
  h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
  label { display: grid; gap: 4px; font-size: 13px; color: #aaa; }
  input { padding: 9px 10px; border-radius: 6px; border: 1px solid #333; background: #111; color: #eee; font: inherit; }
  input:focus { outline: 2px solid #4a7dff; outline-offset: -1px; }
  button { margin-top: 4px; padding: 10px; border: 0; border-radius: 6px; background: #4a7dff; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  .err { margin: 0; color: #ff7a7a; font-size: 13px; }
</style></head>
<body><form method="post" action="/login">
  <h1>reel-agent</h1>
  ${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
  <label>User <input name="username" autocomplete="username" autocapitalize="off" required autofocus></label>
  <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
  <input type="hidden" name="next" value="${esc(safeNext(next))}">
  <button type="submit">Sign in</button>
</form></body></html>`;
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('body too large'), {status: 413})); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// GET/POST /login, POST /logout. `auth` = {user: bcryptHash}, `secret` = the HMAC key,
// `hops` = trusted proxy hops (REEL_TRUST_PROXY), `forceSecure` = public mode (always https).
export async function handleLogin(req, res, url, {auth = {}, secret, limiter, now = Date.now, hops = 0, forceSecure = false, publicUrl}) {
  const send = (status, headers, body) => { res.writeHead(status, {'Cache-Control': 'no-store', ...headers}); res.end(body); };
  const html = (status, body, headers = {}) => send(status, {'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', ...headers}, body);

  if (url.pathname === '/logout') {
    if (req.method !== 'POST') return send(405, {Allow: 'POST'}, '');
    if (!sameSite(req, {hops, publicUrl})) return send(403, {'Content-Type': 'text/plain'}, 'cross-site request refused');
    return send(303, {Location: '/login', 'Set-Cookie': cookieHeader(req, '', 0, forceSecure)}, '');
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    const next = safeNext(url.searchParams.get('next'));
    if (sessionUser(req, secret, auth)) return send(303, {Location: next}, '');
    return html(200, req.method === 'HEAD' ? '' : loginPage({next}));
  }
  if (req.method !== 'POST') return send(405, {Allow: 'GET, POST'}, '');

  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const wantsJson = type === 'application/json';
  let form = {};
  const fail = (status, error, headers = {}) => (wantsJson
    ? send(status, {'Content-Type': 'application/json', ...headers}, JSON.stringify({error}))
    : html(status, loginPage({error, next: form.next}), headers));

  if (!sameSite(req, {hops, publicUrl})) return fail(403, 'Cross-site request refused.');
  const ip = clientIp(req, hops);
  const at = now();
  const wait = limiter?.attempt(ip, at) || 0; // counted before bcrypt: parallel requests cannot race past it
  if (wait) return fail(429, 'Too many attempts, try again later.', {'Retry-After': String(wait)});

  try {
    const raw = await readBody(req);
    if (wantsJson) form = JSON.parse(raw || '{}') || {};
    else form = Object.fromEntries(new URLSearchParams(raw));
  } catch (e) {
    limiter?.release(ip, at); // no password was tried
    return fail(e.status || 400, 'Bad request.');
  }
  const user = typeof form.username === 'string' ? form.username : typeof form.user === 'string' ? form.user : '';
  const pass = typeof form.password === 'string' ? form.password : '';
  const ok = (await checkPassword(auth, user, pass)) && Boolean(secret);
  if (!ok) return fail(401, 'Invalid credentials.');
  limiter?.release(ip, at);
  const cookie = cookieHeader(req, signSession(secret, user, {hash: auth[user], now: now()}), SESSION_TTL_MS / 1000, forceSecure);
  if (wantsJson) return send(200, {'Content-Type': 'application/json', 'Set-Cookie': cookie}, JSON.stringify({ok: true, user}));
  return send(303, {Location: safeNext(form.next), 'Set-Cookie': cookie}, '');
}
