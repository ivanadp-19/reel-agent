// HTTP pieces of the backend that are tested on their own (test/reviews.test.mjs):
// the access gate and the file server with byte ranges.
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import {sessionUser} from './session.mjs';

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

// Who may reach a path. The review pages (/r/...) are public in both modes — the
// token in the URL is the credential — and read-only; everything else keeps the
// gate it had: in public mode (Railway) the backend token (x-reel-token), the signed
// session cookie of the form login (/login, server/session.mjs) or basic auth; a
// browser page load without any is sent to /login, other requests get the 401
// basic-auth challenge. Loopback Host + localhost Origin otherwise.
// public/exports/* is never reachable without it.
// → {kind: 'review' | 'ping' | 'login' | 'ok'} or {kind: 'deny', status, headers, body}
export const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
export const isReviewPath = (pathname) => pathname === '/r' || pathname.startsWith('/r/');
export const isLoginPath = (pathname) => pathname === '/login' || pathname === '/logout';
export function gate(req, url, {publicMode, auth = {}, tokens = [], sessionSecret} = {}) {
  if (isReviewPath(url.pathname)) return {kind: 'review'};
  if (publicMode && url.pathname === '/api/ping') return {kind: 'ping'}; // Railway healthcheck: no auth, no info
  if (publicMode && isLoginPath(url.pathname)) return {kind: 'login'};
  if (publicMode) {
    const h = req.headers.authorization || '';
    const b = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString() : '';
    const i = b.indexOf(':');
    const tokOK = tokens.includes(req.headers['x-reel-token']); // MCP/backend clients authenticate with the shared backend token instead of basic auth
    const ok = tokOK || Boolean(sessionUser(req, sessionSecret, auth)) || (i > 0 && Object.hasOwn(auth, b.slice(0, i)) && bcrypt.compareSync(b.slice(i + 1), auth[b.slice(0, i)]));
    if (ok) return {kind: 'ok'};
    const pageLoad = (req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/') && !h && /text\/html/.test(req.headers.accept || '');
    if (pageLoad) return {kind: 'deny', status: 303, headers: {Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}`, 'Cache-Control': 'no-store'}, body: ''};
    return {kind: 'deny', status: 401, headers: {'WWW-Authenticate': 'Basic realm="reel-agent"'}, body: 'auth required'};
  }
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!LOCAL_HOSTS.has(host)) return {kind: 'deny', status: 403, headers: {'Content-Type': 'application/json'}, body: JSON.stringify({error: 'local access only'})};
  if (req.headers.origin && !LOCAL_ORIGIN.test(req.headers.origin)) return {kind: 'deny', status: 403, headers: {'Content-Type': 'application/json'}, body: JSON.stringify({error: 'bad origin'})};
  return {kind: 'ok'};
}
