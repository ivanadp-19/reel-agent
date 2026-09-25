// Form login for public mode (Railway): GET /login shows a form, POST /login checks
// the same bcrypt users as basic auth (REEL_AUTH_BCRYPT) and sets a signed session
// cookie, /logout clears it. The gate (server/http.mjs) accepts that cookie next to
// basic auth and the x-reel-token. Automated browsers cannot answer the native
// basic-auth dialog; a form they can fill.
//
// Cookie: reel_session=<base64url(JSON {u, exp})>.<base64url(HMAC-SHA256)>, httpOnly,
// SameSite=Lax, Secure when the request came over https (directly or through the
// proxy's X-Forwarded-Proto), 7 days. The key is REEL_SESSION_SECRET, or the first
// token of REEL_BACKEND_TOKEN when that is unset (server/index.mjs picks it). A
// session whose user left REEL_AUTH_BCRYPT is refused even before it expires.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

export const SESSION_COOKIE = 'reel_session';
export const SESSION_TTL_MS = 7 * 86400e3;
const PREFIX = 'reel-session.v1.'; // domain separation: the key may also be a backend token

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const mac = (secret, payload) => crypto.createHmac('sha256', String(secret)).update(PREFIX + payload).digest();

export function signSession(secret, user, {now = Date.now(), ttlMs = SESSION_TTL_MS} = {}) {
  if (!secret) throw new Error('no session secret');
  const payload = b64url(JSON.stringify({u: user, exp: now + ttlMs}));
  return `${payload}.${b64url(mac(secret, payload))}`;
}

// → the user name, or null (bad signature, malformed, expired, unknown user)
export function verifySession(secret, value, {now = Date.now(), users} = {}) {
  if (!secret || typeof value !== 'string') return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const sig = Buffer.from(value.slice(dot + 1), 'base64url');
  const want = mac(secret, payload);
  if (sig.length !== want.length || !crypto.timingSafeEqual(sig, want)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  if (!data || typeof data.u !== 'string' || !Number.isFinite(data.exp) || data.exp <= now) return null;
  if (users && !Object.hasOwn(users, data.u)) return null;
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
function cookieHeader(req, value, maxAgeSec) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
}

// Where to go after the login: a path on this site only (no //host, no scheme)
export const safeNext = (next) => (typeof next === 'string' && /^\/(?![/\\])/.test(next) && !/[\r\n]/.test(next) ? next : '/');

// Failed logins per client IP: at most `max` in a sliding `windowMs`. In memory.
export function createLoginLimiter({max = 5, windowMs = 60e3} = {}) {
  const fails = new Map(); // ip → [timestamps]
  const recent = (ip, now) => {
    const list = (fails.get(ip) || []).filter((t) => now - t < windowMs);
    if (list.length) fails.set(ip, list); else fails.delete(ip);
    return list;
  };
  return {
    // → seconds to wait, or 0 when the client may try
    retryAfter(ip, now = Date.now()) {
      const list = recent(ip, now);
      return list.length >= max ? Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000)) : 0;
    },
    fail(ip, now = Date.now()) { fails.set(ip, [...recent(ip, now), now]); },
    get size() { return fails.size; },
  };
}

// The client's IP: behind Railway's proxy the last X-Forwarded-For hop is the one
// the proxy appended (earlier ones are whatever the client claimed), else the socket.
export function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.at(-1) || req.socket?.remoteAddress || 'unknown';
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

// A hash to compare against when the user does not exist, so both failures cost the same
let dummyHash;
const dummy = () => (dummyHash ||= bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10));

// GET/POST /login, GET/POST /logout. `auth` = {user: bcryptHash}, `secret` = the HMAC key.
export async function handleLogin(req, res, url, {auth = {}, secret, limiter, now = Date.now}) {
  const send = (status, headers, body) => { res.writeHead(status, {'Cache-Control': 'no-store', ...headers}); res.end(body); };
  const html = (status, body, headers = {}) => send(status, {'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', ...headers}, body);

  if (url.pathname === '/logout') {
    if (req.method !== 'GET' && req.method !== 'POST') return send(405, {Allow: 'GET, POST'}, '');
    return send(303, {Location: '/login', 'Set-Cookie': cookieHeader(req, '', 0)}, '');
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

  const ip = clientIp(req);
  const wait = limiter?.retryAfter(ip, now()) || 0;
  if (wait) return fail(429, 'Too many attempts, try again later.', {'Retry-After': String(wait)});

  try {
    const raw = await readBody(req);
    if (wantsJson) form = JSON.parse(raw || '{}') || {};
    else form = Object.fromEntries(new URLSearchParams(raw));
  } catch (e) {
    return fail(e.status || 400, 'Bad request.');
  }
  const user = typeof form.username === 'string' ? form.username : typeof form.user === 'string' ? form.user : '';
  const pass = typeof form.password === 'string' ? form.password : '';
  const hash = user && Object.hasOwn(auth, user) ? auth[user] : null;
  const ok = (await bcrypt.compare(pass, hash || dummy()).catch(() => false)) && Boolean(hash) && Boolean(secret);
  if (!ok) {
    limiter?.fail(ip, now());
    return fail(401, 'Invalid credentials.');
  }
  const cookie = cookieHeader(req, signSession(secret, user, {now: now()}), SESSION_TTL_MS / 1000);
  if (wantsJson) return send(200, {'Content-Type': 'application/json', 'Set-Cookie': cookie}, JSON.stringify({ok: true, user}));
  return send(303, {Location: safeNext(form.next), 'Set-Cookie': cookie}, '');
}
