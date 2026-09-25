import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import {gate} from '../server/http.mjs';
import {SESSION_COOKIE, createLoginLimiter, handleLogin, parseCookies, safeNext, signSession, verifySession} from '../server/session.mjs';

// users made here, never a real secret: random passwords, hashed at low cost
const PASS = crypto.randomBytes(12).toString('hex');
const AUTH = {ana: bcrypt.hashSync(PASS, 4)};
const TOKEN = crypto.randomBytes(16).toString('hex');
const SECRET = crypto.randomBytes(32).toString('hex');

// the same order as server/index.mjs: gate first, /r/ → review, /api/ping, /login → the form, else the app
let srv;
function serve() {
  const limiter = createLoginLimiter({max: 5, windowMs: 60e3});
  const s = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const g = gate(req, url, {publicMode: true, auth: AUTH, tokens: [TOKEN], sessionSecret: SECRET});
    if (g.kind === 'review') { res.writeHead(200); return res.end('review'); }
    if (g.kind === 'ping') { res.writeHead(200); return res.end('{"ok":true}'); }
    if (g.kind === 'login') return handleLogin(req, res, url, {auth: AUTH, secret: SECRET, limiter});
    if (g.kind === 'deny') { res.writeHead(g.status, g.headers); return res.end(g.body); }
    res.writeHead(200); res.end('app');
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}
before(async () => { srv = await serve(); });
after(() => srv.close());

function req(p, {method = 'GET', headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({host: '127.0.0.1', port: srv.address().port, path: p, method, headers}, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString()}));
    });
    r.on('error', reject);
    r.end(body);
  });
}
const form = (fields, headers = {}) => ({method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': '203.0.113.1', ...headers}, body: new URLSearchParams(fields).toString()});
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
  const j = await req('/login', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.11'}, body: JSON.stringify({username: 'ana', password: PASS})});
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
  const j = await req('/login', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.22'}, body: JSON.stringify({username: 'nobody', password: 'x'})});
  assert.equal(j.status, 401);
  assert.deepEqual(JSON.parse(j.body), {error: 'Invalid credentials.'});
});

test('session cookie: tampered, forged, expired or of a removed user is refused', async () => {
  const now = Date.now();
  const good = signSession(SECRET, 'ana', {now});
  assert.equal(verifySession(SECRET, good, {now, users: AUTH}), 'ana');
  const [payload, sig] = good.split('.');
  const asAdmin = Buffer.from(JSON.stringify({u: 'admin', exp: now + 1e9})).toString('base64url');
  const flipped = sig.slice(0, -2) + (sig.at(-2) === 'A' ? 'B' : 'A') + sig.at(-1);
  const longer = Buffer.from(JSON.stringify({u: 'ana', exp: now + 365 * 86400e3})).toString('base64url');
  const cases = {
    tampered: `${asAdmin}.${sig}`,
    'longer expiry, old signature': `${longer}.${sig}`,
    'bad signature': `${payload}.${flipped}`,
    'other key': signSession('another-secret', 'ana', {now}),
    expired: signSession(SECRET, 'ana', {now: now - 8 * 86400e3}),
    'removed user': signSession(SECRET, 'bob', {now}),
    garbage: 'not-a-cookie',
    empty: '',
  };
  for (const [name, value] of Object.entries(cases)) {
    assert.equal(verifySession(SECRET, value, {now, users: AUTH}), null, name);
    const r = await req('/api/projects', {headers: {Cookie: `${SESSION_COOKIE}=${value}`}});
    assert.equal(r.status, 401, name);
  }
  assert.equal(verifySession(SECRET, signSession(SECRET, 'ana', {now, ttlMs: 1000}), {now: now + 1000, users: AUTH}), null, 'expires at exp');
  assert.equal(verifySession(undefined, good, {now}), null, 'no secret → no session');
});

test('rate limit: the 6th failed login from one IP within a minute is 429 with Retry-After, other IPs are unaffected', async () => {
  const ip = {'X-Forwarded-For': '198.51.100.7'};
  for (let i = 0; i < 5; i++) assert.equal((await req('/login', form({username: 'ana', password: 'wrong'}, ip))).status, 401, `attempt ${i + 1}`);
  const blocked = await req('/login', form({username: 'ana', password: PASS}, ip));
  assert.equal(blocked.status, 429, 'even the right password waits');
  assert.equal(blocked.headers['set-cookie'], undefined);
  assert.ok(+blocked.headers['retry-after'] >= 1 && +blocked.headers['retry-after'] <= 60);
  // the last X-Forwarded-For hop counts (the one the proxy appended), not what the client claims first
  assert.equal((await req('/login', form({username: 'ana', password: PASS}, {'X-Forwarded-For': '10.9.9.9, 198.51.100.7'}))).status, 429);
  assert.equal((await req('/login', form({username: 'ana', password: PASS}, {'X-Forwarded-For': '198.51.100.8'}))).status, 303);

  const lim = createLoginLimiter({max: 5, windowMs: 60e3});
  for (let i = 0; i < 5; i++) lim.fail('x', 1000 + i);
  assert.equal(lim.retryAfter('x', 2000), 59);
  assert.equal(lim.retryAfter('x', 60999), 1);
  assert.equal(lim.retryAfter('x', 61000), 0, 'the window slides');
});

test('logout clears the cookie and goes back to /login', async () => {
  for (const method of ['GET', 'POST']) {
    const r = await req('/logout', {method});
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, '/login');
    assert.match(r.headers['set-cookie'][0], new RegExp(`^${SESSION_COOKIE}=; .*Max-Age=0`));
  }
});

test('gate: basic auth and x-reel-token still pass, /r/ and /api/ping stay public, page loads go to /login', async () => {
  const basic = 'Basic ' + Buffer.from(`ana:${PASS}`).toString('base64');
  assert.equal((await req('/api/projects', {headers: {Authorization: basic}})).status, 200);
  assert.equal((await req('/api/projects', {headers: {Authorization: 'Basic ' + Buffer.from('ana:wrong').toString('base64')}})).status, 401);
  assert.equal((await req('/api/projects', {headers: {'x-reel-token': TOKEN}})).status, 200);
  assert.equal((await req('/api/projects', {headers: {'x-reel-token': 'nope'}})).status, 401);
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
  assert.equal(gate({headers: {host: 'evil.example'}}, new URL('http://x/login'), {publicMode: false}).status, 403);
});

test('helpers: next stays on this site, cookies parse', () => {
  assert.equal(safeNext('/a?b=1'), '/a?b=1');
  for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', '', null, '/a\r\nSet-Cookie: x']) assert.equal(safeNext(bad), '/');
  assert.deepEqual(parseCookies('a=1; b=x%20y; a=2; junk'), {a: '1', b: 'x y'});
});
