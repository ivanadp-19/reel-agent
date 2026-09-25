// HTTP pieces of the backend that are tested on their own (test/reviews.test.mjs):
// the access gate and the file server with byte ranges.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {checkPassword, clientIp, sessionUser} from './session.mjs';

export const MIME = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.cube': 'text/plain', '.vtt': 'text/vtt', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon'};

export const etagOf = (st) => `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;

// Serve a file with byte ranges (video seeking on phones): 206 for a satisfiable
// range, 416 for one past the end, 304 when If-None-Match still matches; HEAD
// sends the headers only. `headers` are added to every response (the review
// routes pass their privacy headers).
export function serveFile(req, res, file, headers = {}) {
  const st = fs.statSync(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const etag = etagOf(st);
  const base = {...headers, 'Accept-Ranges': 'bytes', ETag: etag, 'Last-Modified': st.mtime.toUTCString()};
  const head = req.method === 'HEAD';
  if (req.headers['if-none-match'] && req.headers['if-none-match'].split(/\s*,\s*/).includes(etag)) { res.writeHead(304, base); return res.end(); }
  // If-Range with a stale validator: the file changed since the client's first bytes → send it whole
  const ifRange = req.headers['if-range'];
  const rangeOk = !ifRange || ifRange === etag || ifRange === base['Last-Modified'];
  const range = rangeOk && req.headers.range && req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start, end;
    if (range[1]) { start = +range[1]; end = range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1; }
    else { start = Math.max(0, st.size - (+range[2])); end = st.size - 1; } // suffix: the last n bytes
    if (start >= st.size || start > end || (!range[1] && +range[2] === 0)) {
      res.writeHead(416, {...base, 'Content-Range': `bytes */${st.size}`});
      return res.end();
    }
    res.writeHead(206, {...base, 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}`});
    if (head) return res.end();
    return fs.createReadStream(file, {start, end}).pipe(res);
  }
  res.writeHead(200, {...base, 'Content-Type': type, 'Content-Length': st.size});
  if (head) return res.end();
  fs.createReadStream(file).pipe(res);
}

// The backend token in constant time: sha256 digests of both sides (equal length),
// compared with timingSafeEqual, every configured token tried.
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
export function tokenOk(tokens, given) {
  if (typeof given !== 'string' || !given) return false;
  const g = sha(given);
  let ok = false;
  for (const t of tokens || []) if (t && crypto.timingSafeEqual(sha(t), g)) ok = true;
  return ok;
}

// Basic auth: bcrypt for every header not seen yet (a dummy hash when the user does
// not exist), the login limiter on the attempts (counted before bcrypt, handed back on
// success), then the verified header is remembered for a few minutes — as long as the
// user's hash is unchanged — so an editor session does not pay bcrypt per request.
// Identical headers in flight share one check.
const BASIC_TTL_MS = 5 * 60e3;
const basicOk = new Map(); // sha256(header) → {user, hash, exp}
const basicPending = new Map(); // sha256(header) → Promise<user | null>
async function basicUser(header, auth, {limiter, ip, now = Date.now()} = {}) {
  const b = Buffer.from(header.slice(6), 'base64').toString();
  const i = b.indexOf(':');
  if (i <= 0) return {user: null};
  const user = b.slice(0, i);
  const key = sha(header).toString('hex');
  const hit = basicOk.get(key);
  if (hit && hit.exp > now && Object.hasOwn(auth, hit.user) && auth[hit.user] === hit.hash) return {user: hit.user};
  if (hit) basicOk.delete(key);
  if (basicPending.has(key)) return {user: await basicPending.get(key)};
  const wait = limiter?.attempt(ip, now) || 0;
  if (wait) return {user: null, wait};
  const check = checkPassword(auth, user, b.slice(i + 1)).then((ok) => {
    if (!ok) return null;
    limiter?.release(ip, now);
    if (basicOk.size >= 1000) basicOk.clear();
    basicOk.set(key, {user, hash: auth[user], exp: now + BASIC_TTL_MS});
    return user;
  }).finally(() => basicPending.delete(key));
  basicPending.set(key, check);
  return {user: await check};
}

// Who may reach a path. The review pages (/r/...) are public in both modes — the
// token in the URL is the credential — and read-only; everything else keeps the
// gate it had: in public mode (Railway) the backend token (x-reel-token), the signed
// session cookie of the form login (/login, server/session.mjs) or basic auth (failed
// attempts share the login's limiter: 429 + Retry-After); a browser page load without
// any is sent to /login, other requests get the 401 basic-auth challenge. Loopback
// Host + localhost Origin otherwise. public/exports/* is never reachable without it.
// Async: basic auth runs bcrypt off the event loop.
// → {kind: 'review' | 'ping' | 'login' | 'ok'} or {kind: 'deny', status, headers, body}
export const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
export const isReviewPath = (pathname) => pathname === '/r' || pathname.startsWith('/r/');
export const isLoginPath = (pathname) => pathname === '/login' || pathname === '/logout';
export async function gate(req, url, {publicMode, auth = {}, tokens = [], sessionSecret, limiter, hops = 0} = {}) {
  if (isReviewPath(url.pathname)) return {kind: 'review'};
  if (publicMode && url.pathname === '/api/ping') return {kind: 'ping'}; // Railway healthcheck: no auth, no info
  if (publicMode && isLoginPath(url.pathname)) return {kind: 'login'};
  if (publicMode) {
    const h = req.headers.authorization || '';
    // MCP/backend clients authenticate with the shared backend token instead of basic auth
    if (tokenOk(tokens, req.headers['x-reel-token']) || sessionUser(req, sessionSecret, auth)) return {kind: 'ok'};
    if (h.startsWith('Basic ')) {
      const {user, wait} = await basicUser(h, auth, {limiter, ip: clientIp(req, hops)});
      if (user) return {kind: 'ok'};
      if (wait) return {kind: 'deny', status: 429, headers: {'Retry-After': String(wait), 'Content-Type': 'text/plain'}, body: 'too many attempts'};
    }
    const pageLoad = (req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/') && !h && /text\/html/.test(req.headers.accept || '');
    if (pageLoad) return {kind: 'deny', status: 303, headers: {Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}`, 'Cache-Control': 'no-store'}, body: ''};
    return {kind: 'deny', status: 401, headers: {'WWW-Authenticate': 'Basic realm="reel-agent"'}, body: 'auth required'};
  }
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!LOCAL_HOSTS.has(host)) return {kind: 'deny', status: 403, headers: {'Content-Type': 'application/json'}, body: JSON.stringify({error: 'local access only'})};
  if (req.headers.origin && !LOCAL_ORIGIN.test(req.headers.origin)) return {kind: 'deny', status: 403, headers: {'Content-Type': 'application/json'}, body: JSON.stringify({error: 'bad origin'})};
  return {kind: 'ok'};
}
