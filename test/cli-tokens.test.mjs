// Self-service CLI tokens (server/cli-tokens.mjs): a user signed in with the browser —
// the form login's cookie or basic auth — makes and revokes their own tokens at
// /cli-token; tokens never mint tokens, POSTs must come from this site.
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import {gate} from '../server/http.mjs';
import {SESSION_COOKIE, signSession} from '../server/session.mjs';
import {createTokenStore} from '../server/tokens.mjs';
import {MAX_LIVE, handleCliTokens, isCliTokenPath} from '../server/cli-tokens.mjs';

// users made here, never a real secret
const PASS = crypto.randomBytes(12).toString('hex');
const AUTH = {cesar: bcrypt.hashSync(PASS, 4), ana: bcrypt.hashSync(PASS, 4)};
const TOKEN = crypto.randomBytes(16).toString('hex');
const SECRET = crypto.randomBytes(32).toString('hex');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-cli-tokens-'));
const TOKENS_FILE = path.join(dir, 'tokens.json');
const users = createTokenStore(TOKENS_FILE);
const logs = [];

// the same order as server/index.mjs: gate, deny, then the cli-token routes before the app
function serve({publicMode = true} = {}) {
  const s = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const g = await gate(req, url, {publicMode, auth: AUTH, tokens: [TOKEN], sessionSecret: SECRET, users});
    if (g.kind === 'deny') { res.writeHead(g.status, g.headers); return res.end(g.body); }
    if (isCliTokenPath(url.pathname)) return handleCliTokens(req, res, url, g, {users, base: 'https://reels.example.com', publicUrl: '', log: (l) => logs.push(l)});
    res.writeHead(200); res.end('app');
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}
let srv;
before(async () => { srv = await serve(); });
after(() => { srv.close(); fs.rmSync(dir, {recursive: true, force: true}); });

function req(p, {method = 'GET', headers = {}} = {}, server = srv) {
  return new Promise((resolve, reject) => {
    const r = http.request({host: '127.0.0.1', port: server.address().port, path: p, method, headers}, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        let data = null; try { data = JSON.parse(body); } catch {}
        resolve({status: res.statusCode, headers: res.headers, body, data});
      });
    });
    r.on('error', reject);
    r.end();
  });
}
const origin = () => `http://127.0.0.1:${srv.address().port}`;
const session = (user) => ({Cookie: `${SESSION_COOKIE}=${signSession(SECRET, user, {hash: AUTH[user]})}`});
const basic = (user) => ({Authorization: 'Basic ' + Buffer.from(`${user}:${PASS}`).toString('base64')});
const post = (p, headers) => req(p, {method: 'POST', headers: {Origin: origin(), ...headers}});

test('page: served to a session or basic-auth user, a page load without either goes to /login', async () => {
  for (const creds of [session('cesar'), basic('cesar')]) {
    const r = await req('/cli-token', {headers: {Accept: 'text/html', ...creds}});
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    const nonce = r.headers['content-security-policy'].match(/'nonce-([^']+)'/)[1];
    assert.ok(r.body.includes(`<script nonce="${nonce}">`), 'the inline script carries the CSP nonce');
    assert.match(r.body, /Signed in as <b>cesar<\/b>/);
    assert.match(r.body, /Generate token/);
    assert.match(r.body, /mkdir -p ~\/\.config\/reel &amp;&amp; chmod 700 ~\/\.config\/reel/);
    assert.match(r.body, /chmod 600 ~\/\.config\/reel\/token/);
    assert.match(r.body, /export REEL_URL=https:\/\/reels\.example\.com/);
    assert.ok(!/reel_[\w-]{32}/.test(r.body), 'no token in the page itself');
  }
  const r = await req('/cli-token', {headers: {Accept: 'text/html'}});
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/login?next=%2Fcli-token');
});

test('tokens do not mint tokens: a user token or the backend token gets 401 with the hint to log in', async () => {
  const {token} = users.create({user: 'cesar'});
  for (const t of [token, TOKEN]) {
    const page = await req('/cli-token', {headers: {'x-reel-token': t}});
    assert.equal(page.status, 401);
    assert.match(page.body, /sign in to the editor in a browser/);
    for (const [p, method] of [['/api/cli-tokens', 'GET'], ['/api/cli-tokens', 'POST']]) {
      const r = await req(p, {method, headers: {'x-reel-token': t, Origin: origin()}});
      assert.equal(r.status, 401);
      assert.equal(r.data.code, 'session_required');
    }
  }
  users.revoke('cesar');
});

test('create: a non-admin token of the session user, sent once, never logged, hashed on disk', async () => {
  logs.length = 0;
  for (const creds of [session('cesar'), basic('cesar')]) {
    const r = await post('/api/cli-tokens', creds);
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(Object.keys(r.data).sort(), ['id', 'token']);
    assert.match(r.data.token, /^reel_[\w-]{32}$/);
    const g = await gate({method: 'GET', headers: {host: 'x', 'x-reel-token': r.data.token}}, new URL('http://x/api/whoami'), {publicMode: true, tokens: [TOKEN], users});
    assert.deepEqual({user: g.user, admin: g.admin}, {user: 'cesar', admin: false});
    assert.ok(!fs.readFileSync(TOKENS_FILE, 'utf8').includes(r.data.token), 'only the hash at rest');
    assert.ok(logs.length && logs.every((l) => !l.includes(r.data.token)), 'logged without the secret');
    const list = await req('/api/cli-tokens', {headers: creds});
    assert.ok(list.data.tokens.some((t) => t.id === r.data.id));
    assert.ok(!list.body.includes(r.data.token), 'the list never carries the secret');
  }
});

test('CSRF: a POST from another site, or with no Origin/Referer, is refused — cookie and basic auth alike', async () => {
  const before = users.list().length;
  for (const creds of [session('cesar'), basic('cesar')]) {
    for (const from of [{Origin: 'https://evil.example'}, {Referer: 'https://evil.example/x'}, {Origin: 'null'}, {}]) {
      const r = await req('/api/cli-tokens', {method: 'POST', headers: {...creds, ...from}});
      assert.equal(r.status, 403, JSON.stringify(from));
    }
    const {id} = users.create({user: 'cesar'});
    assert.equal((await req(`/api/cli-tokens/${id}/revoke`, {method: 'POST', headers: {...creds, Origin: 'https://evil.example'}})).status, 403);
    assert.equal(users.list().find((t) => t.id === id).revokedAt, undefined, 'still live');
    users.revoke(id);
  }
  // a Referer of this site is enough
  assert.equal((await req('/api/cli-tokens', {method: 'POST', headers: {...session('cesar'), Referer: `${origin()}/cli-token`}})).status, 200);
  assert.equal(users.list().length, before + 3);
});

test('list and revoke: own tokens only (id, createdAt, revokedAt), someone else\'s is 404, revoking again is fine', async () => {
  const mine = users.create({user: 'cesar'});
  const hers = users.create({user: 'ana'});
  const list = await req('/api/cli-tokens', {headers: session('cesar')});
  assert.equal(list.status, 200);
  assert.equal(list.data.user, 'cesar');
  const ids = list.data.tokens.map((t) => t.id);
  assert.ok(ids.includes(mine.id) && !ids.includes(hers.id));
  for (const t of list.data.tokens) assert.deepEqual(Object.keys(t).sort(), ['createdAt', 'id', 'revokedAt']);

  assert.equal((await post(`/api/cli-tokens/${hers.id}/revoke`, session('cesar'))).status, 404);
  assert.equal((await post('/api/cli-tokens/deadbeef/revoke', session('cesar'))).status, 404);
  assert.ok(users.find(hers.token), 'her token still works');

  const r = await post(`/api/cli-tokens/${mine.id}/revoke`, session('cesar'));
  assert.equal(r.status, 200);
  assert.equal(r.data.id, mine.id);
  assert.ok(r.data.revokedAt);
  assert.equal(users.find(mine.token), null);
  const again = await post(`/api/cli-tokens/${mine.id}/revoke`, basic('cesar'));
  assert.deepEqual([again.status, again.data.revokedAt], [200, r.data.revokedAt]);
  assert.equal((await req(`/api/cli-tokens/${mine.id}/revoke`, {headers: session('cesar')})).status, 405);
});

test('revoke by id never takes the tokens of a user whose name equals that id', () => {
  const file = path.join(dir, 'clash.json');
  const rec = (id, user) => ({id, user, admin: false, uid: null, hash: crypto.randomBytes(32).toString('hex'), createdAt: new Date(0).toISOString()});
  const seed = () => fs.writeFileSync(file, JSON.stringify({tokens: [rec('abcdef12', 'ana'), rec('11111111', 'abcdef12')]}));
  seed();
  assert.deepEqual(createTokenStore(file).revoke('abcdef12', new Date(), {idOnly: true}), ['abcdef12']);
  seed();
  assert.deepEqual(createTokenStore(file).revoke('abcdef12'), ['abcdef12', '11111111'], 'the admin route still revokes by id or user');
});

test(`at most ${MAX_LIVE} live tokens per user: the next one is 409 until one is revoked`, async () => {
  for (const t of users.list()) if (t.user === 'ana' && !t.revokedAt) users.revoke(t.id);
  for (let i = 0; i < MAX_LIVE; i++) assert.equal((await post('/api/cli-tokens', session('ana'))).status, 200);
  const full = await post('/api/cli-tokens', session('ana'));
  assert.equal(full.status, 409);
  assert.equal(full.data.code, 'too_many');
  const {data} = await req('/api/cli-tokens', {headers: session('ana')});
  assert.equal((await post(`/api/cli-tokens/${data.tokens.find((t) => !t.revokedAt).id}/revoke`, session('ana'))).status, 200);
  assert.equal((await post('/api/cli-tokens', session('ana'))).status, 200);
});

test('local mode: loopback callers carry no user, so the page and the API are 401', async () => {
  const local = await serve({publicMode: false});
  try {
    const r = await req('/cli-token', {headers: {Host: `localhost:${local.address().port}`}}, local);
    assert.equal(r.status, 401);
    const a = await req('/api/cli-tokens', {method: 'POST', headers: {Host: `localhost:${local.address().port}`, Origin: `http://localhost:${local.address().port}`}}, local);
    assert.equal(a.status, 401);
    assert.equal(a.data.code, 'session_required');
  } finally { local.close(); }
});
