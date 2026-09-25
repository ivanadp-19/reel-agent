import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import {gate, tokenOk} from '../server/http.mjs';
import {SESSION_COOKIE, clientIp, createLoginLimiter, handleLogin, parseCookies, safeNext, sameSite, signSession, trustedHops, verifySession} from '../server/session.mjs';

// users made here, never a real secret: random passwords, hashed at low cost
const PASS = crypto.randomBytes(12).toString('hex');
const AUTH = {ana: bcrypt.hashSync(PASS, 4)};
const TOKEN = crypto.randomBytes(16).toString('hex');
const SECRET = crypto.randomBytes(32).toString('hex');

// the same order as server/index.mjs: gate first, /r/ → review, /api/ping, /login → the form, else the app.
// One trusted proxy hop, as on Railway: the tests pick their client IP with X-Forwarded-For.
let srv;
function serve({forceSecure = false} = {}) {
  const limiter = createLoginLimiter({max: 5, windowMs: 60e3});
  const s = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const g = await gate(req, url, {publicMode: true, auth: AUTH, tokens: [TOKEN], sessionSecret: SECRET, limiter, hops: 1});
    if (g.kind === 'review') { res.writeHead(200); return res.end('review'); }
    if (g.kind === 'ping') { res.writeHead(200); return res.end('{"ok":true}'); }
    if (g.kind === 'login') return handleLogin(req, res, url, {auth: AUTH, secret: SECRET, limiter, hops: 1, forceSecure, publicUrl: ''});
    if (g.kind === 'deny') { res.writeHead(g.status, g.headers); return res.end(g.body); }
    res.writeHead(200); res.end('app');
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}
before(async () => { srv = await serve(); });
after(() => srv.close());

function req(p, {method = 'GET', headers = {}, body} = {}, server = srv) {
  return new Promise((resolve, reject) => {
    const r = http.request({host: '127.0.0.1', port: server.address().port, path: p, method, headers}, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString()}));
    });
    r.on('error', reject);
    r.end(body);
  });
}
// POSTs from the login page itself: Origin = this server
const origin = (server = srv) => `http://127.0.0.1:${server.address().port}`;
const form = (fields, headers = {}) => ({method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': '203.0.113.1', Origin: origin(), ...headers}, body: new URLSearchParams(fields).toString()});
const jsonPost = (body, headers = {}) => ({method: 'POST', headers: {'Content-Type': 'application/json', Origin: origin(), ...headers}, body: JSON.stringify(body)});
const basicOf = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
const cookieOf = (res) => (res.headers['set-cookie'] || [])[0]?.split(';')[0];

test('login: the right password sets a signed session cookie the gate accepts', async () => {
  const page = await req('/login');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.body, /<form method="post" action="\/login">/);

  const r = await req('/login', form({username: 'ana', password: PASS, next: '/editor?p=1'}, {'X-Forwarded-For': '203.0.113.10'}));
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/editor?p=1');
  const set = r.headers['set-cookie'][0];
  assert.match(set, new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/);
  assert.match(set, /Max-Age=604800/, '7 days');
  assert.doesNotMatch(set, /Secure/, 'plain http: no Secure flag');

  const cookie = cookieOf(r);
  assert.equal((await req('/api/projects', {headers: {Cookie: cookie}})).status, 200);
  assert.equal((await req('/', {headers: {Cookie: `other=1; ${cookie}`}})).body, 'app');
  assert.equal((await req('/login', {headers: {Cookie: cookie}})).status, 303, 'already signed in → away from the form');
  assert.equal((await req('/login', {headers: {Cookie: cookie}})).headers.location, '/');

  // JSON body too, and Secure behind an https proxy
  const j = await req('/login', jsonPost({username: 'ana', password: PASS}, {'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.11'}));
  assert.equal(j.status, 200);
  assert.deepEqual(JSON.parse(j.body), {ok: true, user: 'ana'});
  assert.match(j.headers['set-cookie'][0], /; Secure/);
  assert.equal((await req('/api/projects', {headers: {Cookie: cookieOf(j)}})).status, 200);
});

test('login: a wrong password or an unknown user is the same generic 401', async () => {
  const bad = await req('/login', form({username: 'ana', password: 'nope'}, {'X-Forwarded-For': '203.0.113.20'}));
  const ghost = await req('/login', form({username: 'nobody', password: PASS}, {'X-Forwarded-For': '203.0.113.21'}));
  for (const r of [bad, ghost]) {
    assert.equal(r.status, 401);
    assert.equal(r.headers['set-cookie'], undefined);
    assert.match(r.body, /Invalid credentials\./);
  }
  const j = await req('/login', jsonPost({username: 'nobody', password: 'x'}, {'X-Forwarded-For': '203.0.113.22'}));
  assert.equal(j.status, 401);
  assert.deepEqual(JSON.parse(j.body), {error: 'Invalid credentials.'});
});

test('session cookie: tampered, forged, expired or of a removed user is refused', async () => {
  const now = Date.now();
  const good = signSession(SECRET, 'ana', {hash: AUTH.ana, now});
  assert.equal(verifySession(SECRET, good, {now, users: AUTH}), 'ana');
  const [payload, sig] = good.split('.');
  const asAdmin = Buffer.from(JSON.stringify({u: 'admin', exp: now + 1e9})).toString('base64url');
  const flipped = sig.slice(0, -2) + (sig.at(-2) === 'A' ? 'B' : 'A') + sig.at(-1);
  const longer = Buffer.from(JSON.stringify({u: 'ana', exp: now + 365 * 86400e3})).toString('base64url');
  const cases = {
    tampered: `${asAdmin}.${sig}`,
    'longer expiry, old signature': `${longer}.${sig}`,
    'bad signature': `${payload}.${flipped}`,
    'other key': signSession('another-secret', 'ana', {hash: AUTH.ana, now}),
    expired: signSession(SECRET, 'ana', {hash: AUTH.ana, now: now - 8 * 86400e3}),
    'removed user': signSession(SECRET, 'bob', {hash: AUTH.ana, now}),
    'other hash': signSession(SECRET, 'ana', {hash: bcrypt.hashSync('other', 4), now}),
    garbage: 'not-a-cookie',
    empty: '',
  };
  for (const [name, value] of Object.entries(cases)) {
    assert.equal(verifySession(SECRET, value, {now, users: AUTH}), null, name);
    const r = await req('/api/projects', {headers: {Cookie: `${SESSION_COOKIE}=${value}`}});
    assert.equal(r.status, 401, name);
  }
  assert.equal(verifySession(SECRET, signSession(SECRET, 'ana', {hash: AUTH.ana, now, ttlMs: 1000}), {now: now + 1000, users: AUTH}), null, 'expires at exp');
  assert.equal(verifySession(undefined, good, {now, users: AUTH}), null, 'no secret → no session');
  assert.equal(verifySession(SECRET, good, {now}), null, 'no user list → no session');
});

test('session cookie: changing the password ends the sessions of that user', async () => {
  const r = await req('/login', form({username: 'ana', password: PASS}, {'X-Forwarded-For': '203.0.113.30'}));
  const cookie = cookieOf(r);
  assert.equal((await req('/api/projects', {headers: {Cookie: cookie}})).status, 200);
  const old = AUTH.ana;
  AUTH.ana = bcrypt.hashSync(crypto.randomBytes(12).toString('hex'), 4);
  try {
    assert.equal((await req('/api/projects', {headers: {Cookie: cookie}})).status, 401, 'new hash → the old cookie is dead');
    assert.equal((await req('/login', {headers: {Cookie: cookie}})).status, 200, 'back to the form');
  } finally { AUTH.ana = old; }
  assert.equal((await req('/api/projects', {headers: {Cookie: cookie}})).status, 200, 'same hash back → valid again');
});

test('rate limit: the 6th failed login from one IP within a minute is 429 with Retry-After, other IPs are unaffected', async () => {
  const ip = {'X-Forwarded-For': '198.51.100.7'};
  for (let i = 0; i < 5; i++) assert.equal((await req('/login', form({username: 'ana', password: 'wrong'}, ip))).status, 401, `attempt ${i + 1}`);
  const blocked = await req('/login', form({username: 'ana', password: PASS}, ip));
  assert.equal(blocked.status, 429, 'even the right password waits');
  assert.equal(blocked.headers['set-cookie'], undefined);
  assert.ok(+blocked.headers['retry-after'] >= 1 && +blocked.headers['retry-after'] <= 60);
  // the last X-Forwarded-For hop counts (the one the trusted proxy appended), not what the client claims first
  assert.equal((await req('/login', form({username: 'ana', password: PASS}, {'X-Forwarded-For': '10.9.9.9, 198.51.100.7'}))).status, 429);
  assert.equal((await req('/login', form({username: 'ana', password: PASS}, {'X-Forwarded-For': '198.51.100.8'}))).status, 303);

  const lim = createLoginLimiter({max: 5, windowMs: 60e3});
  for (let i = 0; i < 5; i++) assert.equal(lim.attempt('x', 1000 + i), 0);
  assert.equal(lim.attempt('x', 2000), 59, 'the 6th is refused and not counted');
  assert.equal(lim.retryAfter('x', 60999), 1);
  assert.equal(lim.retryAfter('x', 61000), 0, 'the window slides');
  lim.attempt('y', 0); lim.release('y', 0);
  assert.equal(lim.retryAfter('y', 1), 0, 'a successful attempt no longer counts');
});

test('rate limit: parallel failed logins cannot race past it (the attempt is counted before bcrypt)', async () => {
  const ip = {'X-Forwarded-For': '198.51.100.20'};
  const all = await Promise.all(Array.from({length: 12}, (_, i) => req('/login', form({username: 'ana', password: `wrong-${i}`}, ip))));
  const codes = all.map((r) => r.status).sort();
  assert.equal(codes.filter((c) => c === 401).length, 5, codes.join());
  assert.equal(codes.filter((c) => c === 429).length, 7, codes.join());
});

test('rate limit: failed basic auth shares the limiter, in parallel too, and an unknown user costs bcrypt as well', async () => {
  const ip = {'X-Forwarded-For': '198.51.100.30'};
  const all = await Promise.all(Array.from({length: 12}, (_, i) => req('/api/projects', {headers: {Authorization: basicOf(i % 2 ? 'ana' : 'ghost', `wrong-${i}`), ...ip}})));
  const codes = all.map((r) => r.status);
  assert.equal(codes.filter((c) => c === 401).length, 5, codes.join());
  assert.equal(codes.filter((c) => c === 429).length, 7, codes.join());
  const blocked = all.find((r) => r.status === 429);
  assert.ok(+blocked.headers['retry-after'] >= 1 && +blocked.headers['retry-after'] <= 60);
  assert.equal((await req('/api/projects', {headers: {Authorization: basicOf('ana', PASS), ...ip}})).status, 429, 'blocked IP: even the right password waits');
  assert.equal((await req('/login', form({username: 'ana', password: PASS}, ip))).status, 429, 'and the form is blocked too');
  // many right requests at once from a fresh IP: one bcrypt, no lockout
  const ok = await Promise.all(Array.from({length: 10}, () => req('/api/projects', {headers: {Authorization: basicOf('ana', PASS), 'X-Forwarded-For': '198.51.100.31'}})));
  assert.deepEqual([...new Set(ok.map((r) => r.status))], [200]);
});

test('client IP: X-Forwarded-For only behind a trusted proxy (REEL_TRUST_PROXY)', () => {
  const r = {headers: {'x-forwarded-for': '6.6.6.6, 10.0.0.1, 192.0.2.9'}, socket: {remoteAddress: '10.1.1.1'}};
  assert.equal(clientIp(r), '10.1.1.1', 'no trusted proxy: the header is ignored');
  assert.equal(clientIp(r, 1), '192.0.2.9');
  assert.equal(clientIp(r, 2), '10.0.0.1');
  assert.equal(clientIp({headers: {}, socket: {remoteAddress: '10.1.1.1'}}, 1), '10.1.1.1');
  assert.deepEqual(['1', '2', 'true', '', undefined, 'no'].map(trustedHops), [1, 2, 1, 0, 0, 0]);
});

test('logout: POST from this site clears the cookie and goes back to /login; GET is 405', async () => {
  const r = await req('/logout', {method: 'POST', headers: {Origin: origin()}});
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/login');
  assert.match(r.headers['set-cookie'][0], new RegExp(`^${SESSION_COOKIE}=; .*Max-Age=0`));
  const viaReferer = await req('/logout', {method: 'POST', headers: {Referer: `${origin()}/projects`}});
  assert.equal(viaReferer.status, 303);
  const get = await req('/logout');
  assert.equal(get.status, 405);
  assert.equal(get.headers.allow, 'POST');
  assert.equal(get.headers['set-cookie'], undefined);
});

test('CSRF: POST /login and /logout from another site, or with no Origin/Referer, are refused', async () => {
  for (const headers of [{Origin: 'https://evil.example'}, {Origin: 'null'}, {Referer: 'https://evil.example/x'}, {Origin: undefined}]) {
    const h = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));
    const f = form({username: 'ana', password: PASS}, {'X-Forwarded-For': '203.0.113.40', ...h});
    if (!h.Origin) delete f.headers.Origin;
    const r = await req('/login', f);
    assert.equal(r.status, 403, JSON.stringify(h));
    assert.equal(r.headers['set-cookie'], undefined);
    const out = await req('/logout', {method: 'POST', headers: h});
    assert.equal(out.status, 403, JSON.stringify(h));
  }
  // a refused cross-site login does not burn the IP's attempts
  assert.equal((await req('/login', form({username: 'ana', password: PASS}, {'X-Forwarded-For': '203.0.113.40'}))).status, 303);
  const fake = {headers: {host: 'app.example', origin: 'https://reels.example'}};
  assert.equal(sameSite(fake, {publicUrl: 'https://reels.example'}), true, 'REEL_PUBLIC_URL counts as this site');
  assert.equal(sameSite({headers: {host: 'app.internal', 'x-forwarded-host': 'reels.example', origin: 'https://reels.example'}}, {hops: 1, publicUrl: ''}), true);
  assert.equal(sameSite({headers: {host: 'app.internal', 'x-forwarded-host': 'reels.example', origin: 'https://reels.example'}}, {hops: 0, publicUrl: ''}), false, 'X-Forwarded-Host only from a trusted proxy');
});

test('public mode: the session cookie is always Secure, even without X-Forwarded-Proto', async () => {
  const s2 = await serve({forceSecure: true});
  try {
    const r = await req('/login', {...form({username: 'ana', password: PASS}, {'X-Forwarded-For': '203.0.113.50', Origin: origin(s2)})}, s2);
    assert.equal(r.status, 303);
    assert.match(r.headers['set-cookie'][0], /; Secure/);
    const out = await req('/logout', {method: 'POST', headers: {Origin: origin(s2)}}, s2);
    assert.match(out.headers['set-cookie'][0], /; Secure/);
  } finally { s2.close(); }
});

test('gate: basic auth and x-reel-token still pass, /r/ and /api/ping stay public, page loads go to /login', async () => {
  assert.equal((await req('/api/projects', {headers: {Authorization: basicOf('ana', PASS)}})).status, 200);
  assert.equal((await req('/api/projects', {headers: {Authorization: basicOf('ana', 'wrong'), 'X-Forwarded-For': '203.0.113.60'}})).status, 401);
  assert.equal((await req('/api/projects', {headers: {'x-reel-token': TOKEN}})).status, 200);
  assert.equal((await req('/api/projects', {headers: {'x-reel-token': 'nope'}})).status, 401);
  assert.equal((await req('/api/projects', {headers: {'x-reel-token': TOKEN.slice(0, -1)}})).status, 401, 'a prefix is not the token');
  const none = await req('/api/projects');
  assert.equal(none.status, 401);
  assert.equal(none.headers['www-authenticate'], 'Basic realm="reel-agent"', 'API clients keep the basic-auth challenge');
  assert.equal((await req('/r/abc')).body, 'review');
  assert.equal((await req('/api/ping')).status, 200);
  const nav = await req('/projects/x?y=1', {headers: {Accept: 'text/html,application/xhtml+xml'}});
  assert.equal(nav.status, 303);
  assert.equal(nav.headers.location, '/login?next=%2Fprojects%2Fx%3Fy%3D1');
  assert.equal((await req('/exports/a.mp4', {headers: {Accept: 'text/html'}})).status, 303, 'still behind the login');
  // local mode knows no /login: loopback only, as before
  assert.equal((await gate({headers: {host: 'evil.example'}}, new URL('http://x/login'), {publicMode: false})).status, 403);
  assert.equal(tokenOk([TOKEN], TOKEN), true);
  for (const bad of [undefined, '', 'x', TOKEN + 'x']) assert.equal(tokenOk([TOKEN], bad), false);
});

test('next: a tab (%09) cannot turn /login?next= into an open redirect', async () => {
  const page = await req('/login?next=/%09/evil.example');
  assert.match(page.body, /name="next" value="\/"/);
  const r = await req('/login', form({username: 'ana', password: PASS, next: '/\t/evil.example'}, {'X-Forwarded-For': '203.0.113.70'}));
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/');
  const signedIn = await req('/login?next=/%09/evil.example', {headers: {Cookie: cookieOf(r)}});
  assert.equal(signedIn.status, 303);
  assert.equal(signedIn.headers.location, '/');
});

test('helpers: next stays on this site, cookies parse', () => {
  assert.equal(safeNext('/a?b=1'), '/a?b=1');
  for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', '', null, '/a\r\nSet-Cookie: x', '/\t/evil.example', '/\x00/evil', '/\x7f/x']) assert.equal(safeNext(bad), '/');
  assert.deepEqual(parseCookies('a=1; b=x%20y; a=2; junk'), {a: '1', b: 'x y'});
});
