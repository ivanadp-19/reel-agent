// HTTP pieces of the backend that are tested on their own (test/reviews.test.mjs):
// the access gate and the file server with byte ranges.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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

// The files of public/ and the built editor (editor/dist), for a caller the gate let
// through in public mode — the team's browsers (session cookie, basic auth) and tokens.
// GET and HEAD only (players and download managers probe with HEAD); a write to a media
// path is 405, a missing media file 404 — never the editor's page, which a <video> shows
// as black. Other paths fall back to the editor's index.html (its client-side routes).
// → true when it answered, false for a request that is not its (the API routes take it).
// A client's files only for whoever may see that client (seesClient, `g` = the gate's answer): its review files
// (/reviews/<projectId>.json, /reviews/<projectId>/…: versions, proxies, the pair) and its volume
// (/clients/<client>/…: judge profile, deliveries, research); a project without a client keeps the rule above (R-1).
// Decided on the path as asked and on the file it opens (realpath: its case on a case-insensitive disk — /REVIEWS/…
// on a Mac is the same file, the same answer —, symlinks resolved: a reviews/ that links to a volume stays scoped).
export const cleanPath = (pathname) => path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, ''); // throws on bad %-encoding
export function servePublic(req, res, pathname, {publicDir, distDir, g}) {
  if (pathname.startsWith('/api/')) return false;
  const media = isMediaPath(pathname);
  const answer = (status, headers, body) => { res.writeHead(status, {'Content-Type': 'application/json', ...headers}); res.end(JSON.stringify(body)); return true; };
  if (!mediaMethodOk(req.method)) return media ? answer(405, {Allow: 'GET, HEAD'}, {error: 'media is read-only', code: 'method_not_allowed'}) : false;
  let clean;
  try { clean = cleanPath(pathname); } catch { return answer(400, {}, {error: 'bad path'}); }
  // the first name under reviews/ (the project id leads every name there: <id>.json, its .tmp, <id>/…) or clients/
  // (the client), read on the path as asked and on the file it opens — both count
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
  const opened = real(path.join(publicDir, clean));
  const clients = ['reviews', 'clients'].flatMap((dir) => {
    const root = real(path.join(publicDir, dir));
    return [path.relative(path.join(path.sep, dir), clean), opened && root && path.relative(root, opened)]
      .map((rel) => rel && /^[\w-]+/.exec(rel)?.[0]).filter(Boolean)
      .flatMap((id) => (dir === 'reviews' ? projectClients(publicDir, id) : [id]));
  });
  if (!seesClient(g, clients)) return answer(403, {'Cache-Control': 'no-store'}, {error: 'a client\'s project: sign in with an account of that client', code: 'forbidden'});
  for (const base of [publicDir, distDir]) {
    const file = path.join(base, clean);
    // a client's footage and renders: never kept by a shared cache between the browser and us
    if (file.startsWith(base + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) { serveFile(req, res, file, base === publicDir ? {'Cache-Control': 'private'} : {}); return true; }
  }
  if (media) return answer(404, {}, {error: 'not found', code: 'not_found'});
  const index = path.join(distDir, 'index.html');
  if (fs.existsSync(index)) { serveFile(req, res, index); return true; }
  return answer(404, {}, {error: 'not found'});
}

// Is `given` one of `tokens`? In constant time: both sides hashed to equal-length
// sha256 digests and compared with timingSafeEqual, every entry checked (no early
// exit), so the answer's timing tells nothing about how much of a token matched.
// The one token comparison of the backend: the gate, /mcp and the path ingest.
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
// token in the URL is the credential — and read-only; the gate hands them the login session
// (public mode only) and whether the primary token came along, because the page of a client's
// project needs a login of that client as well (server/review.mjs, seesClient; E-1). Everything else keeps the
// gate it had: in public mode (Railway) the backend token (x-reel-token), the signed
// session cookie of the form login (/login, server/session.mjs) or basic auth (failed
// attempts share the login's limiter: 429 + Retry-After); a browser page load without
// any is sent to /login, other requests get the 401 basic-auth challenge. Loopback
// Host + localhost Origin otherwise. public/exports/* is never reachable without one of
// those: in public mode a signed-in browser (session cookie or basic auth) reads it and the
// rest of the editor's media with GET / HEAD (isMediaPath, below), locally only loopback.
// Per-user tokens (server/tokens.mjs, the `reel` CLI) pass in both modes as x-reel-token
// and name the caller; a `reel_` token that is unknown or revoked is refused (401), on
// loopback too. With requireToken (REEL_REQUIRE_TOKEN=1: a box shared over SSH) loopback
// /api/* calls need a token as well — a user token or the backend token.
// The MCP over HTTP (/mcp, server/mcp-http.mjs) takes only the backend token, in
// both modes and before any other credential — never the editor's basic auth, its
// session cookie or a user token: an agent is a client with its own token
// (REEL_BACKEND_TOKEN lists one per client), revoked by removing it.
// Who the caller is: `via` loopback | user-token | backend-token (+ `primary` for the first of
// REEL_BACKEND_TOKEN, the backend's own) | session | basic; a session also carries its user's `role` and
// `clients` from REEL_USER_ROLES (`roles`, session.mjs parseRoles). Only a session is a human (humanOnly).
// A reviewer (a client's login: session, basic auth or user token) passes only for /reviews/* (scoped by servePublic)
// besides /r/ and /login: 403 on the editor, the API, every other media path and /cli-token (reviewerOff).
// Async: basic auth runs bcrypt off the event loop.
// → {kind: 'review' | 'ping' | 'login' | 'mcp' | 'ok', user?, admin?, uid?, via?, primary?, role?, clients?} or {kind: 'deny', status, headers, body}
export const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
export const isReviewPath = (pathname) => pathname === '/r' || pathname.startsWith('/r/');
export const isLoginPath = (pathname) => pathname === '/login' || pathname === '/logout';
export const isMcpPath = (pathname) => pathname === '/mcp' || pathname.startsWith('/mcp/');
// The media the editor reads by URL from public/: the <video> / <audio> / <img> sources of
// the preview (staticFile paths: clips, B-roll, music, assets, fonts, sfx…) and the Download
// links of finished renders (/exports/*). In public mode a signed-in browser — the session
// cookie of the form login or basic auth — reads them like any other credential that passes
// the gate; read-only: GET and HEAD, anything else is 405 (mediaMethodOk). Local mode keeps
// the loopback Host + localhost Origin rule for every caller.
export const MEDIA_DIRS = ['exports', 'clips', 'broll', 'broll-assets', 'music', 'assets', 'inputs', 'fonts', 'sfx', 'brands', 'catalog', 'reviews'];
export const isMediaPath = (pathname) => MEDIA_DIRS.some((d) => pathname.startsWith(`/${d}/`));
export const mediaMethodOk = (method) => method === 'GET' || method === 'HEAD';
const denyJson = (status, error, code, hint) => ({kind: 'deny', status, headers: {'Content-Type': 'application/json'}, body: JSON.stringify({error, code, hint})});
const reviewerPath = (pathname) => { try { return /^[/\\]reviews[/\\]/.test(cleanPath(pathname)); } catch { return false; } };
// a reviewer (a client's login — by session, basic auth or a user token alike: the role is the user's) reaches /r/,
// /login, /logout (above) and the /reviews/ files of their clients (servePublic) — never the editor, the API, other
// media or /cli-token → the 403, else null
const reviewerOff = (user, pathname, roles) => (roles && Object.hasOwn(roles, user) && roles[user].role === 'reviewer' && !reviewerPath(pathname)
  ? denyJson(403, 'a reviewer login opens only review links', 'forbidden', 'open the /r/ link you were sent') : null);
const human = (user, roles) => { const r = roles && Object.hasOwn(roles, user) ? roles[user] : null; return {user, via: 'session', role: r?.role ?? null, clients: r?.clients ?? []}; };
export async function gate(req, url, {publicMode, auth = {}, tokens = [], sessionSecret, limiter, hops = 0, users = null, requireToken = false, roles = null} = {}) {
  if (isReviewPath(url.pathname)) {
    const su = publicMode ? sessionUser(req, sessionSecret, auth) : null;
    return {kind: 'review', ...(su ? human(su, roles) : {user: null}), ...(tokenOk(tokens.slice(0, 1), req.headers['x-reel-token']) && {primary: true})};
  }
  const mcp = isMcpPath(url.pathname);
  if (mcp && !tokenOk(tokens, req.headers['x-reel-token'])) return {kind: 'deny', status: 401, headers: {'Content-Type': 'application/json'}, body: JSON.stringify({error: 'x-reel-token required'})};
  if (mcp && publicMode) return {kind: 'mcp'};
  if (publicMode && url.pathname === '/api/ping') return {kind: 'ping'}; // Railway healthcheck: no auth, no info
  if (publicMode && isLoginPath(url.pathname)) return {kind: 'login'};
  if (!publicMode) {
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!LOCAL_HOSTS.has(host)) return {kind: 'deny', status: 403, headers: {'Content-Type': 'application/json'}, body: JSON.stringify({error: 'local access only'})};
    if (req.headers.origin && !LOCAL_ORIGIN.test(req.headers.origin)) return {kind: 'deny', status: 403, headers: {'Content-Type': 'application/json'}, body: JSON.stringify({error: 'bad origin'})};
    if (mcp) return {kind: 'mcp'};
  }
  const given = req.headers['x-reel-token'];
  const u = users?.find(given);
  if (u) return reviewerOff(u.user, url.pathname, roles) || {kind: 'ok', user: u.user, admin: u.admin, uid: u.uid, via: 'user-token'};
  const backend = tokenOk(tokens, given);
  if (!backend && typeof given === 'string' && given.startsWith('reel_')) return denyJson(401, 'invalid or revoked token', 'bad_token', 'ask an admin for a new one (reel token create)');
  if (publicMode) {
    const h = req.headers.authorization || '';
    // MCP/backend clients authenticate with the shared backend token instead of basic auth
    if (backend) return {kind: 'ok', admin: true, via: 'backend-token', ...(tokenOk(tokens.slice(0, 1), given) && {primary: true})};
    const su = sessionUser(req, sessionSecret, auth);
    if (su) return reviewerOff(su, url.pathname, roles) || {kind: 'ok', ...human(su, roles)};
    if (h.startsWith('Basic ')) {
      const {user, wait} = await basicUser(h, auth, {limiter, ip: clientIp(req, hops)});
      if (user) return reviewerOff(user, url.pathname, roles) || {kind: 'ok', user, via: 'basic'};
      if (wait) return {kind: 'deny', status: 429, headers: {'Retry-After': String(wait), 'Content-Type': 'text/plain'}, body: 'too many attempts'};
    }
    const pageLoad = (req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/') && !h && /text\/html/.test(req.headers.accept || '');
    if (pageLoad) return {kind: 'deny', status: 303, headers: {Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}`, 'Cache-Control': 'no-store'}, body: ''};
    return {kind: 'deny', status: 401, headers: {'WWW-Authenticate': 'Basic realm="reel-agent"'}, body: 'auth required'};
  }
  if (backend) return {kind: 'ok', admin: true, via: 'backend-token', ...(tokenOk(tokens.slice(0, 1), given) && {primary: true})};
  if (requireToken && url.pathname.startsWith('/api/')) return denyJson(401, 'token required', 'token_required', 'put your token in ~/.config/reel/token (0600) or REEL_TOKEN');
  return {kind: 'ok', via: 'loopback'};
}

// The clients a project belongs to (identity.client, src/validate.ts): its project JSON's and those its review
// versions were rendered under (reviews/<id>.json) — a pair stays its client's when the identity changes or the
// project is gone. [] = no client: served as before (R-1).
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
export function projectClients(publicDir, projectId) {
  const out = new Set();
  const add = (identity) => { if (typeof identity?.client === 'string' && identity.client) out.add(identity.client); };
  add(readJson(path.join(publicDir, 'projects', `${projectId}.json`))?.identity);
  for (const v of readJson(path.join(publicDir, 'reviews', `${projectId}.json`))?.versions ?? []) add(v?.identity);
  return [...out];
}

// May the caller `g` (the gate's answer) see a project of these clients (CEO-4, R-1)? No client: yes, whoever
// the gate let through, as before. A client's: the primary backend token, an owner's login session, or a
// reviewer's session whose clients include every one of them — never basic auth, another token or loopback.
export function seesClient(g, clients) {
  if (!clients.length) return true;
  if (g?.primary) return true;
  if (g?.via !== 'session') return false;
  return g.role === 'owner' || (g.role === 'reviewer' && clients.every((c) => g.clients.includes(c)));
}

// Who may run the judge again on a review version (POST /api/reviews/<id>/versions/<v>/judge, CEO-6): the agents'
// backend token (the MCP rejudge), an owner's login session, or the local editor on loopback (local mode: the machine's
// own user). Never a reviewer, basic auth, a user token or a login without the owner role — a re-judge can turn
// 'hallazgos' into 'superado', the label approval waits for.
export const mayRejudge = (g) => g?.via === 'backend-token' || g?.via === 'loopback' || (g?.via === 'session' && g.role === 'owner');

// A human-only action (CEO-2, E-2: approve, revoke, confirm a note, waive a blocker, confirm a colorRef,
// stagesMode): only a login session, which exists in public mode only — never loopback, basic auth, the
// backend token or a user token, whoever holds them; no MCP tool does these (the parity exception, AGENTS.md).
// `role` 'owner' = owners only, else a reviewer of the project's `client` too (a project without a client:
// owners only). `by` is the session's user — the only place an action's by / actor comes from, never a body.
// → {ok: true, by} or {ok: false, status: 403, error, code}
export function humanOnly(g, {role, client} = {}) {
  const no = (error) => ({ok: false, status: 403, error, code: 'human_only'});
  if (g?.via !== 'session' || !g.user) return no('solo con login en la VM');
  if (g.role === 'owner') return {ok: true, by: g.user};
  if (g.role !== 'reviewer') return no(`${g.user} no tiene rol (REEL_USER_ROLES)`);
  if (role === 'owner') return no('solo el owner');
  if (!client || !g.clients.includes(client)) return no(`${g.user} no revisa ${client ? `el cliente ${client}` : 'proyectos sin cliente'}`);
  return {ok: true, by: g.user};
}
