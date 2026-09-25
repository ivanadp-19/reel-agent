// The media the editor reads by URL in public mode (server/http.mjs servePublic): a browser
// signed in with the form login (session cookie) or basic auth GETs /exports/* (render
// downloads) and the clips, B-roll, music… its <video> elements play; anonymous callers get
// 401; media is read-only (405 for writes); a missing media file is a 404, not the editor's
// page. Local mode keeps loopback Host + localhost Origin for every caller.
import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import bcrypt from 'bcryptjs';
import {gate, isMediaPath, servePublic} from '../server/http.mjs';
import {SESSION_COOKIE, createLoginLimiter, handleLogin, signSession} from '../server/session.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-media-'));
after(() => fs.rmSync(tmp, {recursive: true, force: true}));
const pub = path.join(tmp, 'public'), dist = path.join(tmp, 'dist');
for (const [f, body] of [['exports/edited-1.mp4', 'render bytes'], ['clips/take1.mp4', 'clip bytes'], ['clips/thumbs/take1.jpg', 'jpg'], ['music/bed.mp3', 'mp3'], ['broll/city.mp4', 'broll']]) {
  fs.mkdirSync(path.dirname(path.join(pub, f)), {recursive: true});
  fs.writeFileSync(path.join(pub, f), body);
}
fs.mkdirSync(dist);
fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>editor</title>');

const SECRET = 'session-secret-for-tests';
const AUTH = {ana: bcrypt.hashSync('pw', 4)};
// the same order as server/index.mjs: gate, /login, deny, then the public files, else the API
function serve({publicMode = true} = {}) {
  const limiter = createLoginLimiter({max: 50});
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const g = await gate(req, url, {publicMode, auth: AUTH, tokens: ['backend-tok'], sessionSecret: SECRET, limiter});
    if (g.kind === 'login') return handleLogin(req, res, url, {auth: AUTH, secret: SECRET, limiter});
    if (g.kind === 'deny') { res.writeHead(g.status, g.headers); return res.end(g.body); }
    if (publicMode && servePublic(req, res, url.pathname, {publicDir: pub, distDir: dist})) return;
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({api: url.pathname, via: g.via, user: g.user ?? null}));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
function req(srv, p, {method = 'GET', headers = {}, body} = {}) {
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

test('public mode: a signed-in browser (form login session, basic auth) GETs renders and clip media; anonymous is 401', async () => {
  const srv = await serve();
  try {
    // a real form login: the cookie the browser then sends with every <video> and Download request
    const origin = `http://127.0.0.1:${srv.address().port}`;
    const login = await req(srv, '/login', {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded', origin}, body: 'user=ana&password=pw&next=/'});
    assert.equal(login.status, 303);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    assert.ok(cookie.startsWith(`${SESSION_COOKIE}=`));
    const basic = 'Basic ' + Buffer.from('ana:pw').toString('base64');
    const media = {'/exports/edited-1.mp4': 'render bytes', '/clips/take1.mp4': 'clip bytes', '/clips/thumbs/take1.jpg': 'jpg', '/music/bed.mp3': 'mp3', '/broll/city.mp4': 'broll'};
    for (const [p, bytes] of Object.entries(media)) {
      assert.ok(isMediaPath(p), p);
      const anon = await req(srv, p);
      assert.equal(anon.status, 401, `${p} anonymous`);
      assert.ok(!anon.body.includes(bytes));
      assert.equal((await req(srv, p, {headers: {accept: 'text/html'}})).status, 303, 'a page load without credentials goes to /login');
      for (const [who, headers] of [['session', {cookie}], ['basic', {authorization: basic}], ['backend token', {'x-reel-token': 'backend-tok'}]]) {
        const r = await req(srv, p, {headers});
        assert.deepEqual([r.status, r.body], [200, bytes], `${p} ${who}`);
        assert.equal(r.headers['cache-control'], 'private', 'never kept by a shared cache');
      }
    }
    // what a <video> and a resumed download do: byte ranges and HEAD
    const range = await req(srv, '/clips/take1.mp4', {headers: {cookie, range: 'bytes=0-3'}});
    assert.deepEqual([range.status, range.body, range.headers['content-range']], [206, 'clip', 'bytes 0-3/10']);
    const head = await req(srv, '/exports/edited-1.mp4', {method: 'HEAD', headers: {cookie}});
    assert.deepEqual([head.status, head.body, head.headers['content-length']], [200, '', '12']);
    assert.equal((await req(srv, '/exports/edited-1.mp4', {method: 'HEAD'})).status, 401);
    // a forged or foreign cookie is no session
    const forged = `${SESSION_COOKIE}=${signSession('another-secret', 'ana', {hash: AUTH.ana})}`;
    assert.equal((await req(srv, '/exports/edited-1.mp4', {headers: {cookie: forged}})).status, 401);
    // read-only: no write to media, even signed in
    for (const method of ['PUT', 'POST', 'DELETE']) {
      const w = await req(srv, '/exports/edited-1.mp4', {method, headers: {cookie}, body: method === 'DELETE' ? undefined : 'x'});
      assert.deepEqual([w.status, w.headers.allow, JSON.parse(w.body).code], [405, 'GET, HEAD', 'method_not_allowed'], method);
    }
    assert.equal(fs.readFileSync(path.join(pub, 'exports/edited-1.mp4'), 'utf8'), 'render bytes');
    // a missing clip is a 404, not the editor's page (which a <video> shows as black); the editor's routes still get it
    const missing = await req(srv, '/clips/gone.mp4', {headers: {cookie}});
    assert.deepEqual([missing.status, JSON.parse(missing.body).code], [404, 'not_found']);
    assert.match((await req(srv, '/p/some-project', {headers: {cookie}})).body, /<title>editor</);
    // no way out of public/: dot segments collapse in the URL (→ the editor's page), encoded ones stay inside
    assert.match((await req(srv, '/exports/../../../etc/passwd', {headers: {cookie}})).body, /<title>editor</);
    assert.equal((await req(srv, '/exports/..%2f..%2f..%2fetc%2fpasswd', {headers: {cookie}})).status, 404);
    // the API is not served as files: it reaches the routes with the session user
    assert.deepEqual(JSON.parse((await req(srv, '/api/projects', {headers: {cookie}})).body), {api: '/api/projects', via: 'session', user: 'ana'});
  } finally { srv.close(); }
});

test('local mode: media keeps loopback Host + localhost Origin for everyone; a session cookie opens nothing there', async () => {
  const cookie = `${SESSION_COOKIE}=${signSession(SECRET, 'ana', {hash: AUTH.ana})}`;
  const at = (headers) => gate({method: 'GET', headers}, new URL('http://x/exports/edited-1.mp4'), {publicMode: false, auth: AUTH, sessionSecret: SECRET});
  assert.equal((await at({host: 'reels.example.com', cookie})).status, 403);
  assert.equal((await at({host: '127.0.0.1:3333', origin: 'https://evil.example', cookie})).status, 403);
  assert.deepEqual(await at({host: '127.0.0.1:3333'}), {kind: 'ok', via: 'loopback'});
});
