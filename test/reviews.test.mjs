import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import bcrypt from 'bcryptjs';
import {createLink, hashToken, inReviewsRow, keepUnapproved, loadReviews, proxyArgs, pruneVersions, recordFinal, recordVersion, removeVersion, resolveToken, retainedFiles, revokeLink} from '../scripts/reviews.mjs';
import {gate, serveFile} from '../server/http.mjs';
import {bandejaRows, handleBandeja, handleReview, linkAccess} from '../server/review.mjs';
import {SESSION_COOKIE, createLoginLimiter, parseRoles, signSession} from '../server/session.mjs';

const DAY = 86400e3;
const T0 = Date.parse('2026-09-25T12:00:00Z');

const tmps = [];
const tmpdir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmps.push(d); return d; };
after(() => { for (const d of tmps) fs.rmSync(d, {recursive: true, force: true}); });

// a public/ with one project and n fake versions (bytes stand in for the mp4s)
function fixture(n = 2) {
  const pub = tmpdir('reel-reviews-');
  const dir = path.join(pub, 'reviews');
  fs.mkdirSync(path.join(pub, 'exports'), {recursive: true});
  fs.mkdirSync(path.join(pub, 'projects'), {recursive: true});
  fs.writeFileSync(path.join(pub, 'projects', 'p-1.json'), JSON.stringify({name: 'Café <promo>'}));
  for (let i = 1; i <= n; i++) {
    const full = path.join(pub, 'exports', `edited-${i}.mp4`);
    fs.writeFileSync(full, Buffer.alloc(5000, i));
    const proxy = path.join(pub, `.proxy-${i}`), poster = path.join(pub, `.poster-${i}`);
    fs.writeFileSync(proxy, Buffer.from(Array.from({length: 1000}, (_, k) => k % 256)));
    fs.writeFileSync(poster, 'jpeg');
    recordVersion(dir, 'p-1', {file: full, proxyTmp: proxy, posterTmp: poster, durationSec: 12.345, sizeBytes: 5000, publicDir: pub, jobId: `job-${i}`, now: T0 + i});
  }
  return {pub, dir};
}

test('versions: numbered, full + generated proxy/poster recorded, outside the project JSON', () => {
  const {pub, dir} = fixture(2);
  const r = loadReviews(dir, 'p-1');
  assert.deepEqual(r.versions.map((v) => v.v), [1, 2]);
  const v2 = r.versions[1];
  assert.equal(v2.file, 'exports/edited-2.mp4');
  assert.equal(v2.proxy, 'reviews/p-1/v2.mp4');
  assert.equal(v2.poster, 'reviews/p-1/v2.jpg');
  assert.deepEqual(v2.generated, ['reviews/p-1/v2.mp4', 'reviews/p-1/v2.jpg'], 'the files this feature made are marked');
  assert.equal(v2.durationSec, 12.35);
  assert.equal(v2.job, 'job-2', 'the render job it came from (public/render-jobs/)');
  assert.equal(r.managedBy, 'review-link');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pub, 'projects', 'p-1.json'), 'utf8')), {name: 'Café <promo>'}, 'the project JSON is untouched');
  assert.throws(() => loadReviews(dir, '../x'), /bad project id/);
});

test('links: 128-bit token shown once, stored hashed, expires in 30 days, revocable', () => {
  const {dir} = fixture(1);
  assert.throws(() => createLink(dir, 'p-empty', {now: T0}), /no final render/);
  const l = createLink(dir, 'p-1', {now: T0});
  assert.match(l.token, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(Buffer.from(l.token, 'base64url').length, 16);
  assert.equal(l.path, `/r/${l.token}`);
  assert.equal(Date.parse(l.expiresAt) - T0, 30 * DAY);
  const raw = fs.readFileSync(path.join(dir, 'p-1.json'), 'utf8');
  assert.ok(!raw.includes(l.token), 'the token is never written');
  assert.ok(raw.includes(hashToken(l.token)), 'its sha256 is');
  assert.equal(createLink(dir, 'p-1', {now: T0, days: 400}).expiresAt, new Date(T0 + 30 * DAY).toISOString(), '30 days is the most');
  assert.notEqual(createLink(dir, 'p-1', {now: T0}).token, l.token);

  assert.equal(resolveToken(dir, l.token, {now: T0 + DAY}).state, 'live');
  assert.equal(resolveToken(dir, l.token, {now: T0 + DAY}).projectId, 'p-1');
  assert.equal(resolveToken(dir, l.token, {now: T0 + 30 * DAY}).state, 'expired');
  assert.equal(resolveToken(dir, 'A'.repeat(22), {now: T0}).state, 'unknown');
  assert.equal(resolveToken(dir, 'short', {now: T0}).state, 'unknown');
  assert.equal(revokeLink(dir, 'p-1', l.id, {now: T0 + 5}).state, 'revoked');
  assert.equal(resolveToken(dir, l.token, {now: T0 + DAY}).state, 'revoked');
  assert.equal(revokeLink(dir, 'p-1', 'deadbeef'), null);
});

test('retention: files of a project with a live link are kept, others are not', () => {
  const {pub, dir} = fixture(1);
  assert.equal(retainedFiles(dir, pub, {now: T0}).size, 0, 'no link, nothing pinned');
  const l = createLink(dir, 'p-1', {now: T0});
  const keep = retainedFiles(dir, pub, {now: T0 + DAY});
  assert.deepEqual([...keep].sort(), ['exports/edited-1.mp4', 'reviews/p-1.json', 'reviews/p-1/v1.jpg', 'reviews/p-1/v1.mp4']);
  assert.equal(retainedFiles(dir, pub, {now: T0 + 31 * DAY}).size, 0, 'expired link, nothing pinned');
  revokeLink(dir, 'p-1', l.id, {now: T0});
  assert.equal(retainedFiles(dir, pub, {now: T0 + DAY}).size, 0);
});

// the same order as server/index.mjs: gate first, /r/ → the review handler, else the static files.
// Login users made here (low-cost hashes, a test secret): an owner, a reviewer of acme, one of another client, one without a role
const SECRET = 'reviews-test-secret';
const AUTH = Object.fromEntries(['ana', 'boss', 'rev', 'otro', 'nadie'].map((u) => [u, bcrypt.hashSync('pw', 4)]));
const ROLES = parseRoles(JSON.stringify({boss: {role: 'owner'}, rev: {role: 'reviewer', clients: ['acme']}, otro: {role: 'reviewer', clients: ['other']}}));
const cookie = (user) => ({cookie: `${SESSION_COOKIE}=${signSession(SECRET, user, {hash: AUTH[user]})}`});
function serve(pub, {publicMode = true, now, limiter = null, log = () => {}, disk = () => null} = {}) {
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const g = await gate(req, url, {publicMode, auth: AUTH, tokens: ['backend-tok', 'second-tok'], sessionSecret: SECRET, roles: ROLES});
    if (g.kind === 'review') return handleReview(req, res, url, {publicDir: pub, now, g, login: publicMode});
    if (g.kind === 'bandeja') return handleBandeja(req, res, url, {publicDir: pub, g, login: publicMode, secret: SECRET, limiter, log, disk});
    if (g.kind === 'deny') { res.writeHead(g.status, g.headers); return res.end(g.body); }
    const f = path.join(pub, path.normalize(decodeURIComponent(url.pathname)));
    if (f.startsWith(pub) && fs.existsSync(f) && fs.statSync(f).isFile()) return serveFile(req, res, f);
    res.writeHead(404); res.end();
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
function get(srv, p, headers = {}, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port: srv.address().port, path: p, method, headers}, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('gate: /exports stays behind auth (public mode) and loopback (local); /r/ is the only open path', async () => {
  const {pub, dir} = fixture(1);
  const {token} = createLink(dir, 'p-1', {now: Date.now()});
  const srv = await serve(pub);
  try {
    assert.equal((await get(srv, '/exports/edited-1.mp4')).status, 401);
    assert.equal((await get(srv, '/reviews/p-1/v1.mp4')).status, 401, 'the proxy file itself is not public either');
    assert.equal((await get(srv, '/reviews/p-1.json')).status, 401);
    assert.equal((await get(srv, `/r/${token}/../../exports/edited-1.mp4`)).status, 401, 'dot segments collapse before the gate');
    assert.equal((await get(srv, `/r/${token}/%2e%2e/%2e%2e/exports/edited-1.mp4`)).status, 401);
    assert.equal((await get(srv, `/r/${token}/exports/edited-1.mp4`)).status, 404);
    assert.equal((await get(srv, `/r/${token}/v/1/../../../../exports/edited-1.mp4`)).status, 401);
    const basic = 'Basic ' + Buffer.from('ana:pw').toString('base64');
    assert.equal((await get(srv, '/exports/edited-1.mp4', {authorization: basic})).status, 200, 'the team still gets it with basic auth');
    assert.equal((await get(srv, `/r/${token}`, {}, 'POST')).status, 405);
  } finally { srv.close(); }
  const local = {headers: {host: 'reels.example.com'}};
  assert.equal((await gate(local, new URL('http://x/exports/edited-1.mp4'), {publicMode: false})).status, 403);
  assert.equal((await gate(local, new URL('http://x/api/projects'), {publicMode: false})).status, 403);
  assert.equal((await gate(local, new URL(`http://x/r/${token}`), {publicMode: false})).kind, 'review', 'behind Caddy the page is reachable by any Host');
  assert.equal((await gate({headers: {host: '127.0.0.1:3333', origin: 'https://evil.example'}}, new URL('http://x/api/render'), {publicMode: false})).status, 403);
});

test('review routes: page, proxy with ranges 206/416, poster, download, privacy headers, expiry and revocation', async () => {
  const {pub, dir} = fixture(2);
  const now = Date.now();
  const l = createLink(dir, 'p-1', {now});
  const srv = await serve(pub, {now: now + DAY});
  try {
    const page = await get(srv, `/r/${l.token}`);
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
    assert.match(page.headers['cache-control'], /private/);
    assert.ok(page.headers.etag);
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);
    const html = page.body.toString();
    assert.match(html, /<video src="\/r\/[\w-]+\/v\/2\.mp4" playsinline controls preload="metadata" poster="\/r\/[\w-]+\/v\/2\.jpg">/, 'the latest version plays');
    assert.match(html, new RegExp(`href="/r/${l.token}\\?v=1"`), 'the earlier one is a link');
    assert.match(html, /\/v\/2\/full\.mp4" download/);
    assert.match(html, /Café &lt;promo&gt;/, 'the project name is escaped');
    assert.ok(!/og:|twitter:/.test(html), 'no preview card');
    assert.ok(!/<script/i.test(html), 'no script');
    assert.equal((await get(srv, `/r/${l.token}`, {'if-none-match': page.headers.etag})).status, 304);
    assert.match((await get(srv, `/r/${l.token}?v=1`)).body.toString(), /<video src="\/r\/[\w-]+\/v\/1\.mp4"/);

    const whole = await get(srv, `/r/${l.token}/v/2.mp4`);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers['content-type'], 'video/mp4');
    assert.equal(whole.headers['accept-ranges'], 'bytes');
    assert.equal(whole.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
    assert.equal(whole.body.length, 1000);
    const part = await get(srv, `/r/${l.token}/v/2.mp4`, {range: 'bytes=100-199'});
    assert.equal(part.status, 206);
    assert.equal(part.headers['content-range'], 'bytes 100-199/1000');
    assert.equal(part.body.length, 100);
    assert.equal(part.body[0], 100);
    const tail = await get(srv, `/r/${l.token}/v/2.mp4`, {range: 'bytes=-10'});
    assert.equal(tail.status, 206); assert.equal(tail.headers['content-range'], 'bytes 990-999/1000');
    const open = await get(srv, `/r/${l.token}/v/2.mp4`, {range: 'bytes=900-'});
    assert.equal(open.status, 206); assert.equal(open.body.length, 100);
    const past = await get(srv, `/r/${l.token}/v/2.mp4`, {range: 'bytes=1000-'});
    assert.equal(past.status, 416);
    assert.equal(past.headers['content-range'], 'bytes */1000');
    assert.equal((await get(srv, `/r/${l.token}/v/2.mp4`, {range: 'bytes=500-100'})).status, 416);
    const stale = await get(srv, `/r/${l.token}/v/2.mp4`, {range: 'bytes=0-9', 'if-range': 'W/"old"'});
    assert.equal(stale.status, 200, 'If-Range that no longer matches → the whole file');
    const head = await get(srv, `/r/${l.token}/v/2.mp4`, {}, 'HEAD');
    assert.equal(head.status, 200); assert.equal(head.body.length, 0); assert.equal(head.headers['content-length'], '1000');
    assert.equal((await get(srv, `/r/${l.token}/v/2.mp4`, {'if-none-match': whole.headers.etag})).status, 304);

    assert.equal((await get(srv, `/r/${l.token}/v/1.jpg`)).headers['content-type'], 'image/jpeg');
    const dl = await get(srv, `/r/${l.token}/v/1/full.mp4`);
    assert.equal(dl.status, 200); assert.equal(dl.body.length, 5000);
    assert.match(dl.headers['content-disposition'], /attachment; filename="cafe-promo-v1\.mp4"/);
    assert.equal((await get(srv, `/r/${l.token}/v/9.mp4`)).status, 404);
    assert.equal((await get(srv, `/r/${'x'.repeat(22)}`)).status, 404);

    // a purged proxy drops that version from the page; a purged full drops the download
    fs.rmSync(path.join(pub, 'reviews', 'p-1', 'v2.mp4'));
    fs.rmSync(path.join(pub, 'exports', 'edited-1.mp4'));
    const after = (await get(srv, `/r/${l.token}`)).body.toString();
    assert.match(after, /<video src="\/r\/[\w-]+\/v\/1\.mp4"/);
    assert.ok(!/full\.mp4/.test(after));
    assert.equal((await get(srv, `/r/${l.token}/v/2.mp4`)).status, 404);

    revokeLink(dir, 'p-1', l.id);
    assert.equal((await get(srv, `/r/${l.token}`)).status, 410);
    assert.equal((await get(srv, `/r/${l.token}/v/1.mp4`)).status, 410);
  } finally { srv.close(); }
  const late = await serve(pub, {now: now + 31 * DAY});
  const l2 = createLink(dir, 'p-1', {now});
  try { assert.equal((await get(late, `/r/${l2.token}/v/1.mp4`)).status, 410, 'expired'); } finally { late.close(); }
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('recordFinal: only a final that passed QC, for a project, becomes a version (720p faststart proxy + poster)', {skip: !hasFfmpeg && 'ffmpeg not installed'}, async () => {
  const pub = tmpdir('reel-final-');
  const dir = path.join(pub, 'reviews');
  fs.mkdirSync(path.join(pub, 'exports'));
  const out = path.join(pub, 'exports', 'edited-1.mp4');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:r=30:d=2', '-f', 'lavfi', '-i', 'sine=f=440:d=2:sample_rate=48000', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]);
  assert.equal(r.status, 0, String(r.stderr));
  const base = {projectId: 'p-1', outFile: out, dir, publicDir: pub};
  assert.equal(await recordFinal({...base, draft: true, qcOk: true}), null, 'drafts never');
  assert.equal(await recordFinal({...base, draft: false, qcOk: false}), null, 'QC failures never');
  assert.equal(await recordFinal({...base, projectId: null, draft: false, qcOk: true}), null, 'no project, no version');
  assert.equal(loadReviews(dir, 'p-1').versions.length, 0);

  const v = await recordFinal({...base, draft: false, qcOk: true, jobId: 'j1'});
  assert.equal(v.v, 1);
  assert.ok(Math.abs(v.durationSec - 2) < 0.1);
  const proxy = path.join(pub, v.proxy);
  const probe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', proxy], {encoding: 'utf8'}).stdout);
  const vid = probe.streams.find((s) => s.width);
  assert.deepEqual([vid.codec_name, vid.width, vid.height], ['h264', 720, 1280]);
  assert.ok(probe.streams.some((s) => s.codec_name === 'aac'));
  const head = fs.readFileSync(proxy).subarray(0, 4096).toString('latin1');
  assert.ok(head.indexOf('moov') >= 0 && (head.indexOf('mdat') < 0 || head.indexOf('moov') < head.indexOf('mdat')), 'faststart: moov before mdat');
  assert.ok(fs.statSync(path.join(pub, v.poster)).size > 0);
  assert.ok(!fs.readdirSync(path.join(dir, 'p-1')).some((f) => f.startsWith('.tmp-')), 'no temp files left');
  assert.equal((await recordFinal({...base, draft: false, qcOk: true, jobId: 'j2'})).v, 2);
});

test('proxy settings: 720p H.264 CRF 26 veryfast with faststart', () => {
  const a = proxyArgs('in.mp4', 'out.mp4');
  for (const [k, v] of [['-c:v', 'libx264'], ['-preset', 'veryfast'], ['-crf', '26'], ['-movflags', '+faststart'], ['-vf', 'scale=720:-2']]) assert.equal(a[a.indexOf(k) + 1], v);
});

test('a version taken back (its render job was cancelled): entry and proxy/poster gone, the full render and the others stay', () => {
  const {pub, dir} = fixture(3);
  assert.equal(removeVersion(dir, 'p-1', 3, pub), true);
  const r = loadReviews(dir, 'p-1');
  assert.deepEqual(r.versions.map((v) => v.v), [1, 2]);
  assert.ok(!fs.existsSync(path.join(pub, 'reviews/p-1/v3.mp4')) && !fs.existsSync(path.join(pub, 'reviews/p-1/v3.jpg')));
  assert.ok(fs.existsSync(path.join(pub, 'exports/edited-3.mp4')), 'the export is not this feature\'s to delete');
  assert.ok(fs.existsSync(path.join(pub, 'reviews/p-1/v2.mp4')));
  assert.equal(removeVersion(dir, 'p-1', 9, pub), false);
});

test('recordFinal of a cancelled render job records nothing', async () => {
  const {pub, dir} = fixture(1);
  const ac = new AbortController();
  ac.abort(new Error('cancelled by request'));
  await assert.rejects(recordFinal({draft: false, qcOk: true, projectId: 'p-1', outFile: path.join(pub, 'exports/edited-1.mp4'), dir, publicDir: pub, jobId: 'j1', signal: ac.signal}), /cancelled/);
  assert.deepEqual(loadReviews(dir, 'p-1').versions.map((v) => v.v), [1]);
});

// ---- the delivered pair of a project with an identity (scripts/render-runner.mjs) ----
const IDENTITY = {client: 'acme', family: 'acme-G2', script: 2, variant: {hook: 1, cta: 1}};
// a version of p-1 with its pair (fake bytes): the temps where the runner leaves them, then recordVersion
function withPair(pub, dir, {captions = true, now = T0, master = 'master', masterKey, snapshot = {clips: [{id: 'c0'}], captionStyle: 'palabra'}} = {}) {
  const t = path.join(dir, 'p-1', '.tmp-pair-j9');
  fs.mkdirSync(t, {recursive: true});
  fs.writeFileSync(path.join(t, 'master.mp4'), master);
  if (captions) fs.writeFileSync(path.join(t, 'captions.mov'), 'prores');
  fs.writeFileSync(path.join(t, 'captions.png.zip'), 'zip');
  fs.writeFileSync(path.join(t, 'supers.mov'), 'prores supers');
  fs.writeFileSync(path.join(t, 'master_supers.mp4'), 'master + supers');
  fs.writeFileSync(path.join(pub, '.proxy-9'), 'proxy'); fs.writeFileSync(path.join(pub, '.poster-9'), 'jpeg');
  fs.writeFileSync(path.join(pub, 'exports', 'edited-9.mp4'), 'full');
  return recordVersion(dir, 'p-1', {file: path.join(pub, 'exports', 'edited-9.mp4'), proxyTmp: path.join(pub, '.proxy-9'), posterTmp: path.join(pub, '.poster-9'), durationSec: 2, sizeBytes: 4, publicDir: pub, jobId: 'j9', now,
    deliverables: {master: path.join(t, 'master.mp4'), captions: path.join(t, 'captions.mov'), captionsPng: path.join(t, 'captions.png.zip'), supers: path.join(t, 'supers.mov'), masterSupers: path.join(t, 'master_supers.mp4')}, identity: IDENTITY, snapshot, masterKey});
}

test('an unchanged master (same masterKey, same bytes) is a hard link to the earlier version\'s (design §5), never a copy', () => {
  const {pub, dir} = fixture(0);
  const st = (x) => fs.statSync(path.join(pub, x.deliverables.master));
  const v1 = withPair(pub, dir, {masterKey: 'k1'}), v2 = withPair(pub, dir, {masterKey: 'k1'});
  assert.equal(v2.masterKey, 'k1');
  assert.ok(st(v2).ino === st(v1).ino && st(v2).nlink === 2, 'one file, two names');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'p-1', '.tmp-pair-j9')), [], 'the fresh remux is gone');
  const v3 = withPair(pub, dir, {masterKey: 'k1', master: 'master, other final audio'}), v4 = withPair(pub, dir, {masterKey: 'k2'});
  assert.ok(st(v3).ino !== st(v1).ino && st(v4).ino !== st(v1).ino, 'other bytes, or another master: a file of its own');
  removeVersion(dir, 'p-1', 1, pub);
  assert.equal(fs.readFileSync(path.join(pub, v2.deliverables.master), 'utf8'), 'master', 'v1 taken back: v2 keeps its master');
});

test('a version with its pair: reviews/<id>/v<n>/ under the system names + the snapshot, taken back whole, kept while a link lives', () => {
  const {pub, dir} = fixture(1);
  const v = withPair(pub, dir);
  assert.equal(v.v, 2);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'p-1', 'v2')).sort(), ['ACME_G2_H1_C1_v2_captions.mov', 'ACME_G2_H1_C1_v2_captions.png.zip', 'ACME_G2_H1_C1_v2_master.mp4', 'ACME_G2_H1_C1_v2_master_supers.mp4', 'ACME_G2_H1_C1_v2_supers.mov', 'project.json']);
  assert.deepEqual(v.deliverables, {master: 'reviews/p-1/v2/ACME_G2_H1_C1_v2_master.mp4', captions: 'reviews/p-1/v2/ACME_G2_H1_C1_v2_captions.mov', captionsPng: 'reviews/p-1/v2/ACME_G2_H1_C1_v2_captions.png.zip', supers: 'reviews/p-1/v2/ACME_G2_H1_C1_v2_supers.mov', masterSupers: 'reviews/p-1/v2/ACME_G2_H1_C1_v2_master_supers.mp4'});
  assert.deepEqual(v.identity, IDENTITY);
  assert.equal(v.snapshot, 'reviews/p-1/v2/project.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pub, v.snapshot), 'utf8')), {clips: [{id: 'c0'}], captionStyle: 'palabra'});
  assert.deepEqual(v.generated, ['reviews/p-1/v2.mp4', 'reviews/p-1/v2.jpg', ...Object.values(v.deliverables), v.snapshot]);
  assert.deepEqual(loadReviews(dir, 'p-1').versions[1], v, 'what the JSON says');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'p-1', '.tmp-pair-j9')), [], 'moved, not copied');
  createLink(dir, 'p-1', {now: T0});
  const keep = retainedFiles(dir, pub, {now: T0 + DAY});
  for (const f of [...Object.values(v.deliverables), v.snapshot]) assert.ok(keep.has(f), f);
  assert.equal(removeVersion(dir, 'p-1', 2, pub), true);
  assert.ok(!fs.existsSync(path.join(dir, 'p-1', 'v2')) && !fs.existsSync(path.join(dir, 'p-1', 'v2.mp4')), 'the pair\'s folder goes with it');
  assert.ok(fs.existsSync(path.join(pub, 'exports', 'edited-9.mp4')), 'the export is not this feature\'s to delete');
});

test('R-2: a version without a pair has exactly the fields it had; a pair that cannot be moved leaves no version and no file', () => {
  const {pub, dir} = fixture(1);
  assert.deepEqual(Object.keys(loadReviews(dir, 'p-1').versions[0]), ['v', 'createdAt', 'durationSec', 'sizeBytes', 'file', 'proxy', 'poster', 'proxyBytes', 'job', 'generated']);
  assert.throws(() => withPair(pub, dir, {captions: false}), /ENOENT/);
  assert.deepEqual(loadReviews(dir, 'p-1').versions.map((x) => x.v), [1]);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'p-1')).sort(), ['.tmp-pair-j9', 'v1.jpg', 'v1.mp4'], 'no v2.mp4, v2.jpg or v2/');
  fs.writeFileSync(path.join(pub, '.proxy-bad'), 'proxy');
  assert.throws(() => recordVersion(dir, 'p-1', {file: path.join(pub, 'exports', 'edited-1.mp4'), proxyTmp: path.join(pub, '.proxy-bad'), durationSec: 1, sizeBytes: 1, publicDir: pub, deliverables: {master: 'x', captions: 'y'}, identity: {client: 'Bad Client', script: 2}}), /identity\.client/);
  fs.writeFileSync(path.join(pub, '.proxy-bad'), 'proxy');
  assert.throws(() => recordVersion(dir, 'p-1', {file: path.join(pub, 'exports', 'edited-1.mp4'), proxyTmp: path.join(pub, '.proxy-bad'), durationSec: 1, sizeBytes: 1, publicDir: pub, deliverables: {other: 'x'}, identity: IDENTITY}), /unknown deliverable: other/);
  assert.equal(loadReviews(dir, 'p-1').versions.length, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'p-1', 'v2.mp4')) && !fs.existsSync(path.join(dir, 'p-1', 'v2')), 'a bad identity names no file');
});

test('a reviews JSON that cannot be read (damaged, an IO error) is never written over: the write fails, v1/ and the links stay', () => {
  const {pub, dir} = fixture(0);
  const v1 = withPair(pub, dir);
  const link = createLink(dir, 'p-1', {now: T0});
  const f = path.join(dir, 'p-1.json');
  const good = fs.readFileSync(f, 'utf8');
  const delivered = fs.readdirSync(path.join(dir, 'p-1', 'v1')).sort();
  fs.writeFileSync(f, good.slice(0, 40)); // half a file (a hand edit, a disk that filled up)
  assert.throws(() => withPair(pub, dir), /reviews of p-1 unreadable, nothing written/);
  assert.throws(() => createLink(dir, 'p-1', {now: T0}), /unreadable/);
  assert.throws(() => revokeLink(dir, 'p-1', link.id), /unreadable/);
  assert.throws(() => removeVersion(dir, 'p-1', 1, pub), /unreadable/);
  assert.equal(fs.readFileSync(f, 'utf8'), good.slice(0, 40), 'not rewritten as an empty history');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'p-1', 'v1')).sort(), delivered, 'the delivered pair of v1 is not taken for a crash leftover');
  assert.ok(fs.existsSync(path.join(pub, v1.proxy)));
  // an IO error (EISDIR standing in for EACCES / EIO / EMFILE): the same
  fs.rmSync(f); fs.mkdirSync(f);
  assert.throws(() => createLink(dir, 'p-1', {now: T0}), /unreadable.*EISDIR/);
  // readers stay lenient (the /r/ page, retention); a missing file is still an empty history for a write
  assert.deepEqual(loadReviews(dir, 'p-1').versions, []);
  fs.rmSync(f, {recursive: true});
  assert.throws(() => createLink(dir, 'p-1', {now: T0}), /no final render to share yet/);
});

test('the reviews row: 20 concurrent writes to one project lose none; one writer at a time, in order; a failure does not block the next', async () => {
  const {pub, dir} = fixture(1);
  const makeProxy = async (input, proxy, poster) => { await new Promise((r) => setTimeout(r, Math.random() * 10)); fs.writeFileSync(proxy, 'p'); fs.writeFileSync(poster, 'j'); return {durationSec: 1}; };
  const outFile = path.join(pub, 'exports', 'edited-1.mp4');
  await Promise.all([
    ...Array.from({length: 10}, (_, i) => recordFinal({draft: false, qcOk: true, projectId: 'p-1', outFile, dir, publicDir: pub, jobId: `c${i}`, makeProxy})),
    ...Array.from({length: 10}, () => inReviewsRow(dir, 'p-1', () => createLink(dir, 'p-1'))),
  ]);
  const r = loadReviews(dir, 'p-1');
  assert.deepEqual(r.versions.map((x) => x.v).sort((a, b) => a - b), Array.from({length: 11}, (_, i) => i + 1));
  assert.equal(r.links.length, 10);
  // a writer that awaits between its read and its write (what the row is for): none lost, never two at once, FIFO
  const f = path.join(pub, 'counter');
  fs.writeFileSync(f, '0');
  let live = 0, most = 0;
  const order = [];
  const runs = Array.from({length: 22}, (_, i) => inReviewsRow(dir, 'p-1', async () => {
    most = Math.max(most, ++live);
    const n = +fs.readFileSync(f, 'utf8');
    await new Promise((res) => setTimeout(res, 1));
    fs.writeFileSync(f, String(n + 1));
    order.push(i); live--;
    if (i === 3) throw new Error('boom');
  }));
  const settled = await Promise.allSettled(runs);
  assert.equal(fs.readFileSync(f, 'utf8'), '22');
  assert.equal(most, 1);
  assert.deepEqual(order, Array.from({length: 22}, (_, i) => i));
  assert.deepEqual(settled.map((x) => x.status).filter((x) => x === 'rejected').length, 1);
  assert.throws(() => inReviewsRow(dir, '../x', () => {}), /bad project id/);
});

test('a pair version plays on /r/ for a login of its client; its pair and snapshot are never served there', async () => {
  const {pub, dir} = fixture(1);
  const v = withPair(pub, dir);
  const l = createLink(dir, 'p-1', {now: Date.now()});
  const srv = await serve(pub);
  try {
    const rev = cookie('rev');
    assert.match((await get(srv, `/r/${l.token}`, rev)).body.toString(), /<video src="\/r\/[\w-]+\/v\/2\.mp4"/);
    assert.equal((await get(srv, `/r/${l.token}/v/2.mp4`, rev)).body.toString(), 'proxy');
    assert.equal((await get(srv, `/r/${l.token}/v/2/full.mp4`, rev)).body.toString(), 'full');
    for (const p of [`/r/${l.token}/v/2/ACME_G2_H1_C1_v2_master.mp4`, `/r/${l.token}/v/2/project.json`, `/r/${l.token}/${v.deliverables.captions}`]) assert.equal((await get(srv, p, rev)).status, 404, p);
    assert.equal((await get(srv, `/${v.deliverables.master}`)).status, 401, 'behind auth like every other file');
  } finally { srv.close(); }
});

test('R-1: the /r/ link of a project without a client answers the same to anyone, signed in or not, any role, any mode', async () => {
  const {pub, dir} = fixture(2);
  const l = createLink(dir, 'p-1', {now: Date.now()});
  const [pubSrv, localSrv] = [await serve(pub), await serve(pub, {publicMode: false})];
  try {
    const want = await get(pubSrv, `/r/${l.token}`);
    assert.equal(want.status, 200);
    assert.deepEqual(linkAccess(pub, 'p-1', {login: true}), {clients: [], access: null}, 'its Share surfaces add nothing');
    for (const [srv, headers] of [[pubSrv, {}], [pubSrv, cookie('otro')], [pubSrv, cookie('nadie')], [pubSrv, {authorization: 'Basic ' + Buffer.from('ana:pw').toString('base64')}], [pubSrv, {'x-reel-token': 'second-tok'}], [localSrv, {}]]) {
      const page = await get(srv, `/r/${l.token}`, headers);
      assert.deepEqual([page.status, page.body.toString()], [200, want.body.toString()], JSON.stringify(headers));
      assert.equal((await get(srv, `/r/${l.token}/v/2.mp4`, headers)).status, 200);
      assert.equal((await get(srv, `/r/${l.token}/v/1.jpg`, headers)).status, 200);
      assert.equal((await get(srv, `/r/${l.token}/v/1/full.mp4`, headers)).status, 200);
    }
  } finally { pubSrv.close(); localSrv.close(); }
});

test('a client\'s /r/ link (CEO-4, E-1): no login → /login, another client or no role → 403; its reviewer, the owner and the primary token see it', async () => {
  const {pub, dir} = fixture(1);
  fs.writeFileSync(path.join(pub, 'projects', 'p-1.json'), JSON.stringify({name: 'x', identity: IDENTITY}));
  const l = createLink(dir, 'p-1', {now: Date.now()});
  const [srv, local] = [await serve(pub), await serve(pub, {publicMode: false})];
  try {
    const page = `/r/${l.token}?v=1`, media = [`/r/${l.token}/v/1.mp4`, `/r/${l.token}/v/1.jpg`, `/r/${l.token}/v/1/full.mp4`];
    const anon = await get(srv, page);
    assert.deepEqual([anon.status, anon.headers.location], [303, `/login?next=${encodeURIComponent(page)}`]);
    assert.equal(anon.headers['referrer-policy'], 'no-referrer');
    const basic = {authorization: 'Basic ' + Buffer.from('boss:pw').toString('base64')};
    for (const [who, headers] of [['anonymous', {}], ['another client', cookie('otro')], ['no role', cookie('nadie')], ['basic auth, even the owner', basic], ['a second backend token', {'x-reel-token': 'second-tok'}]]) {
      for (const p of media) {
        const r = await get(srv, p, headers);
        assert.equal(r.status, 403, `${who} ${p}`);
        assert.ok(!['1000', '5000'].includes(r.headers['content-length']), 'no byte of the reel');
      }
      if (headers.cookie || headers.authorization || headers['x-reel-token']) assert.equal((await get(srv, page, headers)).status, headers.cookie ? 403 : 303, who);
    }
    assert.equal((await get(local, page)).status, 403, 'local mode has no login: never the page');
    for (const [who, headers] of [['its reviewer', cookie('rev')], ['the owner', cookie('boss')], ['the primary token', {'x-reel-token': 'backend-tok'}]]) {
      assert.equal((await get(srv, page, headers)).status, 200, who);
      for (const p of media) assert.equal((await get(srv, p, headers)).status, 200, `${who} ${p}`);
    }
    // what share_version, the Share panel and reel review-link pass on with the link (POST /api/reviews/<id>/links)
    assert.deepEqual(linkAccess(pub, 'p-1', {login: true}).clients, [IDENTITY.client]);
    assert.match(linkAccess(pub, 'p-1', {login: true}).access, new RegExp(`only with a login of client ${IDENTITY.client}`));
    assert.match(linkAccess(pub, 'p-1', {login: false}).access, /cannot be opened here/);
    revokeLink(dir, 'p-1', l.id);
    assert.equal((await get(srv, page, cookie('rev'))).status, 410, 'the link still expires and is revoked as before');
  } finally { srv.close(); local.close(); }
});

test('retention (T6): the newest unapproved versions and the approved ones stay whole; older ones lose their pair, and without notes their proxy, poster and snapshot too; off until set', () => {
  const {pub, dir} = fixture(0);
  for (let i = 0; i < 4; i++) withPair(pub, dir, {now: T0 + i});
  const exists = (f) => fs.existsSync(path.join(pub, f));
  const r = loadReviews(dir, 'p-1');
  r.versions[0].notes = [{atSec: 1, text: 'n'}]; // v1 has a note (T17), v2 is approved (T10) — the fields as the design names them
  r.versions[1].approval = {v: 2};
  fs.writeFileSync(path.join(dir, 'p-1.json'), JSON.stringify(r));
  const before = loadReviews(dir, 'p-1').versions;
  assert.equal(keepUnapproved(undefined), Infinity);
  assert.equal(keepUnapproved('0'), Infinity, 'the version just recorded always stays whole');
  assert.equal(keepUnapproved('2'), 2);
  assert.deepEqual(pruneVersions(dir, 'p-1', pub), [], 'REEL_REVIEW_KEEP_UNAPPROVED unset: every version kept');
  // a live link: every proxy stays playable, only the pairs of the old ones go
  const l = createLink(dir, 'p-1', {now: T0});
  pruneVersions(dir, 'p-1', pub, {keep: 1, now: T0 + DAY});
  for (const v of before) assert.equal(exists(v.proxy), true, `v${v.v} proxy while the link lives`);
  revokeLink(dir, 'p-1', l.id, {now: T0 + DAY});
  const gone = pruneVersions(dir, 'p-1', pub, {keep: 1, now: T0 + DAY});
  const [v1, v2, v3, v4] = loadReviews(dir, 'p-1').versions;
  for (const x of [v2, v4]) for (const f of [...Object.values(x.deliverables), x.proxy, x.poster, x.snapshot]) assert.ok(exists(f), `v${x.v} ${f}`);
  assert.ok(Object.values(v1.deliverables).every((f) => !exists(f)), 'v1: its pair goes');
  assert.ok([v1.proxy, v1.poster, v1.snapshot].every(exists), 'v1 has notes: proxy, poster and snapshot stay for good');
  assert.ok([...Object.values(v3.deliverables), v3.proxy, v3.poster, v3.snapshot].every((f) => !exists(f)), 'v3: nothing left');
  assert.ok(!fs.existsSync(path.join(dir, 'p-1', 'v3')), 'its empty folder too');
  assert.deepEqual(v3.pruned.sort(), [...Object.values(before[2].deliverables), before[2].proxy, before[2].poster, before[2].snapshot].sort());
  assert.deepEqual(gone.sort(), [before[2].proxy, before[2].poster, before[2].snapshot].sort(), 'the pairs went while the link lived; now the rest of v3');
  assert.ok(fs.existsSync(path.join(pub, 'exports', 'edited-9.mp4')), 'the export is cleanup-exports\' to purge, never this');
  assert.deepEqual(pruneVersions(dir, 'p-1', pub, {keep: 1}), [], 'twice: nothing more');
});

// ---- QC técnico on a client's version (CEO-6): the judge after the version, its four labels, re-run, restart ----
import {judgeText, judgeVersion, resumeJudges} from '../scripts/reviews.mjs';
import {pidAlive} from '../scripts/render-jobs.mjs';

// a stand-in for `judge.mjs --summary` (written at test time: node --test would run any .mjs under test/): its first
// argument says how it behaves, the judge's arguments follow and every call is kept in calls.jsonl next to it
const FAKE_JUDGE = `import fs from 'node:fs';
import path from 'node:path';
const here = path.dirname(process.argv[1]);
const [mode, ...args] = process.argv.slice(2);
fs.appendFileSync(path.join(here, 'calls.jsonl'), JSON.stringify({mode, args}) + '\\n');
const say = (x) => console.log(JSON.stringify(x));
if (mode === 'superado') say({label: 'superado', findings: [], profile: 'acme', report: '.captions-tmp/judge/p-1/r/report.json'});
if (mode === 'hallazgos') say({label: '2 hallazgos', findings: [{check: 'black-flash', severity: 'blocker', at: 1.2, end: 1.3, msg: 'negro de 3 frames'}, {check: 'pause', severity: 'major', at: 4, end: 4.8, msg: 'pausa'}], profile: 'acme'});
if (mode === 'reduced') say({label: 'superado (evidencia reducida)', findings: [], profile: 'acme'});
if (mode === 'crash') { console.error('TypeError: boom'); process.exit(1); }
if (mode === 'throw') throw new Error('no judge profile "acme"'); // uncaught: a stack, then Node's version banner
if (mode === 'aprobado') say({label: 'aprobado', findings: []});
if (mode === 'hang') setInterval(() => {}, 1e6);
if (mode === 'gate') { while (!fs.existsSync(path.join(here, 'go'))) await new Promise((r) => setTimeout(r, 10)); say({label: 'superado', findings: [], profile: null}); }
`;
function fakeJudge() {
  const d = tmpdir('fake-judge-');
  const file = path.join(d, 'judge.mjs');
  fs.writeFileSync(file, FAKE_JUDGE);
  return {cmd: (mode) => [process.execPath, file, mode], go: () => fs.writeFileSync(path.join(d, 'go'), ''),
    calls: () => { try { return fs.readFileSync(path.join(d, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } }};
}
// every file under reviews/p-1 with its bytes, and the project JSON: what a judge must never touch
const bytesUnder = (pub) => Object.fromEntries([...fs.readdirSync(path.join(pub, 'reviews', 'p-1'), {recursive: true}), '../../projects/p-1.json'].map((f) => path.join(pub, 'reviews', 'p-1', f)).filter((f) => fs.statSync(f).isFile()).map((f) => [f, fs.readFileSync(f, 'utf8')]));

test('QC técnico: a client\'s version is "en curso" the moment it is recorded; the judge answers superado or n hallazgos; a crash, a timeout or any other answer is "no disponible" with an owner alert — never "aprobado"', async () => {
  const {pub, dir} = fixture(0);
  const v = withPair(pub, dir);
  assert.deepEqual(v.judge, {label: 'en curso', at: new Date(T0).toISOString()});
  assert.equal(judgeText(v.judge), 'QC técnico en curso');
  const before = bytesUnder(pub);
  const fake = fakeJudge();
  const alerts = [];
  const run = async (mode) => {
    const r = await judgeVersion({dir, publicDir: pub, projectId: 'p-1', v: 1, cmd: fake.cmd(mode), timeoutMs: mode === 'hang' ? 300 : 20000, log: (m) => alerts.push(m)});
    assert.equal(r.version.judge.label, 'en curso', 'at once, before the judge answers');
    const j = await r.done;
    assert.deepEqual(loadReviews(dir, 'p-1').versions[0].judge, j, 'written in the reviews JSON');
    return j;
  };
  const pass = await run('superado');
  assert.deepEqual([pass.label, pass.profile, pass.report, judgeText(pass)], ['superado', 'acme', '.captions-tmp/judge/p-1/r/report.json', 'QC técnico superado']);
  const fail = await run('hallazgos');
  assert.deepEqual([fail.label, judgeText(fail), fail.findings.map((f) => f.check)], ['2 hallazgos', 'QC técnico: 2 hallazgos', ['black-flash', 'pause']]);
  const reduced = await run('reduced'); // a pass with checks skipped keeps saying so
  assert.deepEqual([reduced.label, judgeText(reduced)], ['superado (evidencia reducida)', 'QC técnico superado (evidencia reducida)']);
  assert.equal(alerts.length, 0);
  for (const [mode, why] of [['crash', /exit 1\): TypeError: boom$/], ['throw', /exit 1\): Error: no judge profile "acme"$/], ['aprobado', /no verdict/], ['hang', /did not finish in 0 s/]]) {
    const j = await run(mode);
    assert.deepEqual([j.label, j.findings], ['no disponible', []], mode);
    assert.match(j.error, why);
    assert.match(alerts.at(-1), /^\[owner-alert\] QC técnico no disponible — p-1 v1: /);
  }
  assert.equal(alerts.length, 4, 'one owner alert per judge that failed');
  assert.ok(!JSON.stringify(loadReviews(dir, 'p-1')).includes('aprobado'));
  // the judge got the version's render and the props it was rendered from; nothing of the version or the project changed
  assert.deepEqual(fake.calls()[0].args, ['p-1', path.join(pub, 'exports', 'edited-9.mp4'), '--summary', '--public', pub, '--snapshot', path.join(pub, v.snapshot)]);
  const after = bytesUnder(pub);
  delete before[path.join(dir, 'p-1.json')]; delete after[path.join(dir, 'p-1.json')];
  assert.deepEqual(after, before);
});

test('re-judge without a re-render: asked again while it runs → the same pass; afterwards a new one (attempt 1) relabels the version', async () => {
  const {pub, dir} = fixture(0);
  withPair(pub, dir);
  const fake = fakeJudge();
  const o = {dir, publicDir: pub, projectId: 'p-1', v: 1, log: () => {}};
  const a = judgeVersion({...o, cmd: fake.cmd('gate')}), b = judgeVersion({...o, cmd: fake.cmd('hallazgos')});
  assert.equal(a, b, 'one pass per version at a time');
  const r = await a;
  fake.go();
  assert.equal((await r.done).label, 'superado');
  const again = await judgeVersion({...o, cmd: fake.cmd('hallazgos'), fresh: true});
  assert.deepEqual([again.version.judge.label, again.version.judge.attempt], ['en curso', 1]);
  assert.equal((await again.done).label, '2 hallazgos', 'the label is the latest pass\'s');
  assert.deepEqual(fake.calls().map((c) => c.mode), ['gate', 'hallazgos']);
  assert.equal(await judgeVersion({...o, v: 7, cmd: fake.cmd('superado')}), null, 'no such version');
});

test('restart: a pass a dead backend left "en curso" runs again once, then is "no disponible"; another live backend\'s pass and settled labels are left alone', async () => {
  const {pub, dir} = fixture(0);
  for (let i = 0; i < 4; i++) withPair(pub, dir);
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const r = loadReviews(dir, 'p-1');
  const at = new Date(T0).toISOString();
  Object.assign(r.versions[0], {judge: {label: 'en curso', at, attempt: 1, owner: dead}}); // its first pass died with its backend
  Object.assign(r.versions[1], {judge: {label: 'en curso', at, attempt: 2, owner: dead}}); // and its second one too
  Object.assign(r.versions[2], {judge: {label: 'en curso', at, attempt: 1, owner: process.ppid}}); // running on a live backend
  Object.assign(r.versions[3], {judge: {label: 'superado', at, findings: [], profile: null}});
  fs.writeFileSync(path.join(dir, 'p-1.json'), JSON.stringify(r));
  const fake = fakeJudge();
  const alerts = [];
  const o = {dir, publicDir: pub, cmd: fake.cmd('hallazgos'), log: (m) => alerts.push(m)};
  const started = await resumeJudges(o);
  assert.deepEqual(started.map((x) => [x.version.v, x.version.judge.attempt]), [[1, 2]]);
  await started[0].done;
  const vs = loadReviews(dir, 'p-1').versions;
  assert.deepEqual(vs.map((x) => x.judge.label), ['2 hallazgos', 'no disponible', 'en curso', 'superado']);
  assert.match(vs[1].judge.error, /interrupted twice/);
  assert.deepEqual(alerts, [`[owner-alert] QC técnico no disponible — p-1 v2: ${vs[1].judge.error}`]);
  assert.equal(fake.calls().length, 1, 'only v1 was judged again');
  assert.deepEqual(await resumeJudges(o), [], 'the next start finds nothing left');
});

const until = async (ok, ms = 5000) => { for (const t0 = Date.now(); !ok() && Date.now() - t0 < ms;) await new Promise((r) => setTimeout(r, 20)); return ok(); };

test('judges run one at a time: a second version waits "en curso" for the first; the running judge\'s pid is on its version', async () => {
  const {pub, dir} = fixture(0);
  withPair(pub, dir); withPair(pub, dir);
  const fake = fakeJudge();
  const o = {dir, publicDir: pub, projectId: 'p-1', log: () => {}};
  const a = await judgeVersion({...o, v: 1, cmd: fake.cmd('gate')});
  const b = await judgeVersion({...o, v: 2, cmd: fake.cmd('hallazgos')});
  assert.equal(b.version.judge.label, 'en curso', 'queued, and labeled at once');
  assert.ok(await until(() => Number.isInteger(loadReviews(dir, 'p-1').versions[0].judge.pid)), 'the pid of v1\'s judge is recorded');
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(fake.calls().map((c) => c.mode), ['gate'], 'v2\'s judge has not started');
  fake.go();
  assert.deepEqual([(await a.done).label, (await b.done).label], ['superado', '2 hallazgos']);
  assert.deepEqual(fake.calls().map((c) => c.mode), ['gate', 'hallazgos']);
  assert.equal(loadReviews(dir, 'p-1').versions[0].judge.pid, undefined, 'a settled label keeps no pid');
});

test('restart after a SIGKILL: the judge a dead backend left behind is killed by pid once its command line names judge.mjs and the version\'s render — never a bystander', async () => {
  const {pub, dir} = fixture(0);
  withPair(pub, dir); withPair(pub, dir);
  const fake = fakeJudge();
  const render = path.join(pub, 'exports', 'edited-9.mp4');
  // a backend that started a detached child (as runJudge does) and died without its exit hook
  const orphanOf = (args) => {
    const r = spawnSync(process.execPath, ['-e', "const c = require('child_process').spawn(process.execPath, JSON.parse(process.argv[1]), {detached: true, stdio: 'ignore'}); c.unref(); console.log(c.pid)", JSON.stringify(args)], {encoding: 'utf8'});
    return {backend: r.pid, pid: +r.stdout.trim()};
  };
  const judge = orphanOf([...fake.cmd('hang').slice(1), 'p-1', render, '--summary']);
  const bystander = orphanOf(['-e', 'setInterval(() => {}, 1e6)', 'judge.mjs']); // names judge.mjs, not this render
  try {
    assert.ok(pidAlive(judge.pid) && pidAlive(bystander.pid));
    const r = loadReviews(dir, 'p-1'), at = new Date(T0).toISOString();
    Object.assign(r.versions[0], {judge: {label: 'en curso', at, attempt: 1, owner: judge.backend, pid: judge.pid}});
    Object.assign(r.versions[1], {judge: {label: 'en curso', at, attempt: 2, owner: bystander.backend, pid: bystander.pid}});
    fs.writeFileSync(path.join(dir, 'p-1.json'), JSON.stringify(r));
    const started = await resumeJudges({dir, publicDir: pub, cmd: fake.cmd('superado'), log: () => {}});
    assert.ok(await until(() => !pidAlive(judge.pid)), 'the orphan judge is gone');
    assert.equal((await started[0].done).label, 'superado', 'v1 judged again');
    assert.equal(loadReviews(dir, 'p-1').versions[1].judge.label, 'no disponible');
    assert.ok(pidAlive(bystander.pid), 'a process that is not this version\'s judge is left alone');
  } finally { for (const x of [judge, bystander]) try { process.kill(x.pid, 'SIGKILL'); } catch {} }
});

test('a version without a snapshot (no identity, or from before them) is never judged: re-judge refused, and one left "en curso" is "no disponible" on restart', async () => {
  const {pub, dir} = fixture(1);
  const fake = fakeJudge();
  const o = {dir, publicDir: pub, projectId: 'p-1', v: 1, cmd: fake.cmd('superado'), log: () => {}};
  await assert.rejects(judgeVersion({...o, fresh: true}), (e) => e.code === 'no_snapshot' && /cannot be judged as it was rendered/.test(e.message));
  assert.equal(loadReviews(dir, 'p-1').versions[0].judge, undefined, 'nothing written');
  const r = loadReviews(dir, 'p-1');
  r.versions[0].judge = {label: 'en curso', at: new Date(T0).toISOString(), attempt: 1, owner: spawnSync(process.execPath, ['-e', '']).pid};
  fs.writeFileSync(path.join(dir, 'p-1.json'), JSON.stringify(r));
  const alerts = [];
  assert.deepEqual(await resumeJudges({...o, log: (m) => alerts.push(m)}), []);
  assert.match(loadReviews(dir, 'p-1').versions[0].judge.error, /no snapshot/);
  assert.equal(alerts.length, 1);
  assert.deepEqual(fake.calls(), [], 'the live project was never judged in its place');
});

import {reviewPage} from '../server/review.mjs';

test('datos por confirmar (CEO-21): kept in the version, shown on its review page, escaped', () => {
  const {pub, dir} = fixture(0);
  const full = path.join(pub, 'exports', 'edited-7.mp4'), proxy = path.join(pub, '.proxy-7');
  fs.writeFileSync(full, 'mp4'); fs.writeFileSync(proxy, 'proxy');
  const datos = [{graphic: 'g2', dato: '<80>', src: 'toma-a', atSec: 21.4}];
  const v = recordVersion(dir, 'p-1', {file: full, proxyTmp: proxy, durationSec: 30, sizeBytes: 3, publicDir: pub, jobId: 'j7', datosPorConfirmar: datos});
  assert.deepEqual(loadReviews(dir, 'p-1').versions[0].datosPorConfirmar, datos);
  const html = reviewPage({token: 'x'.repeat(22), name: 'Reel', versions: [v], current: v.v, fullOf: () => null});
  assert.match(html, /<h2>Datos por confirmar<\/h2><ul><li>«&lt;80&gt;» en 0:21 — no se oye en el audio de este reel<\/li><\/ul>/);
  assert.doesNotMatch(reviewPage({token: 'x'.repeat(22), name: 'Reel', versions: [{...v, datosPorConfirmar: []}], current: v.v, fullOf: () => null}), /Datos por confirmar/);
});

// ---- the bandeja (server/review.mjs handleBandeja; its steps: scripts/review-states.mjs) ----
import {withVersion} from '../scripts/reviews.mjs';
import {actorOf, moveNote} from '../scripts/review-states.mjs';
import {DELIVERY_FPS} from '../src/timeline.ts';
// the version as rendered: c0 = a.mp4 0–1 s, c1 = b.mp4 from 10 s; 1.5 s on the reel (at 29.97) is b.mp4 10.499 s, in "propia"
const SNAP = {fps: DELIVERY_FPS, clips: [{id: 'c0', src: 'clips/a.mp4', inSec: 0, outSec: 1}, {id: 'c1', src: 'clips/b.mp4', inSec: 10, outSec: 20}],
  captions: [{id: 'p1', src: 'clips/b.mp4', startMs: 10000, endMs: 10900, words: [{wid: 'b:1', text: 'tu', startMs: 10000, endMs: 10400}, {wid: 'b:2', text: 'propia', startMs: 10400, endMs: 10900}]}]};
const ANCHOR = {clipId: 'c1', src: 'clips/b.mp4', srcSec: 10.499, wordId: 'b:2'};
// p-1 = acme's ACME_G2_H1_C1 with n versions (en curso), p-2 = another client's variant
function bandejaFixture(n = 1) {
  const {pub, dir} = fixture(0);
  for (let i = 0; i < n; i++) withPair(pub, dir, {snapshot: SNAP, now: T0 + i});
  // the live project moved on (other clips): notes still anchor on the version's snapshot
  fs.writeFileSync(path.join(pub, 'projects', 'p-1.json'), JSON.stringify({name: 'G2', identity: IDENTITY, clips: [{id: 'z9', src: 'clips/z.mp4', inSec: 0, outSec: 9}], captions: []}));
  fs.writeFileSync(path.join(dir, 'p-2.json'), JSON.stringify({projectId: 'p-2', versions: [{v: 1, createdAt: new Date(T0).toISOString(), durationSec: 2, proxy: 'reviews/p-2/v1.mp4', identity: {client: 'other', family: 'other-G2', script: 2, variant: {hook: 1}}, judge: {label: 'superado', findings: []}}], links: []}));
  return {pub, dir};
}
// one login per user (the CSRF token belongs to that session's cookie)
const jar = {};
const ck = (user) => (jar[user] ??= cookie(user));
const setJudge = (dir, v, label) => withVersion(dir, 'p-1', v, (x) => { x.judge = {label, findings: [], at: 'now'}; });
async function page(srv, who) {
  const r = await get(srv, '/bandeja', who ? ck(who) : {});
  const html = r.body.toString();
  return {...r, html, csrf: html.match(/name="csrf" value="([^"]+)"/)?.[1]};
}
const post = (srv, route, headers, fields) => get(srv, route, {origin: `http://127.0.0.1:${srv.address().port}`, 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'TestPhone/1', ...headers}, 'POST', new URLSearchParams(fields).toString());

test('the bandeja: a login session only; a reviewer sees their clients\' variants and never the owner\'s inbox; the owner sees every client and the inbox', async () => {
  const {pub} = bandejaFixture(1);
  const [srv, local] = [await serve(pub), await serve(pub, {publicMode: false})];
  try {
    for (const [who, headers] of [['anonymous', {}], ['basic auth, even the owner', {authorization: 'Basic ' + Buffer.from('boss:pw').toString('base64')}], ['the primary token', {'x-reel-token': 'backend-tok'}]]) {
      const r = await get(srv, '/bandeja', headers);
      assert.deepEqual([r.status, r.headers.location], [303, '/login?next=%2Fbandeja'], who);
    }
    assert.equal((await get(local, '/bandeja')).status, 403, 'local mode has no login: never the bandeja');
    const rev = await page(srv, 'rev');
    assert.equal(rev.status, 200);
    assert.match(rev.headers['content-security-policy'], /form-action 'self'/);
    assert.match(rev.headers['content-security-policy'], /script-src 'sha256-[A-Za-z0-9+/=]+'/);
    assert.equal(rev.headers['referrer-policy'], 'no-referrer');
    assert.equal(rev.headers['cache-control'], 'no-store');
    assert.match(rev.html, /ACME_G2_H1_C1/);
    assert.match(rev.html, /<video id="vid-p-1-1" src="\/reviews\/p-1\/v1\.mp4"/);
    assert.match(rev.html, /<button type="button" disabled>Aprobar v1<\/button> <span>QC técnico en curso: aprobar se habilita con QC técnico superado/);
    assert.ok(!/OTHER_G2/.test(rev.html), 'another client\'s variant is never listed');
    assert.ok(!/<section class="inbox"|Pendientes|owner-inbox/.test(rev.html), 'the reviewer never sees the inbox');
    const boss = await page(srv, 'boss');
    assert.match(boss.html, /<section class="inbox"/);
    assert.match(boss.html, /ACME_G2_H1_C1/);
    assert.match(boss.html, /OTHER_G2_H1/);
    assert.ok(!boss.html.includes('/bandeja/aprobar') && !boss.html.includes('/bandeja/nota"'), 'the owner neither approves nor writes the client\'s notes');
    const otro = await page(srv, 'otro');
    assert.ok(/OTHER_G2_H1/.test(otro.html) && !/ACME_G2/.test(otro.html) && !/Pendientes/.test(otro.html));
    assert.match((await page(srv, 'nadie')).html, /nadie no tiene rol en REEL_USER_ROLES/);
    assert.equal((await get(srv, '/bandeja/aprobar', ck('rev'))).status, 405, 'no GET on a step');
    assert.equal((await get(srv, '/bandeja/otra', ck('rev'))).status, 404);
    const out = await post(srv, '/bandeja/salir', ck('rev'), {csrf: rev.csrf});
    assert.deepEqual([out.status, out.headers.location], [303, '/login?next=%2Fbandeja'], 'signing in again lands on the bandeja');
    assert.match(out.headers['set-cookie'][0], new RegExp(`^${SESSION_COOKIE}=; .*Max-Age=0.*; Secure`));
    assert.equal((await post(srv, '/bandeja/salir', ck('rev'), {csrf: 'x'})).status, 403, 'not without its CSRF token');
  } finally { srv.close(); local.close(); }
  // the gate: the bandeja gets the session or nobody — never a token, basic auth or loopback
  const req = (headers) => ({headers: {host: '127.0.0.1:3333', ...headers}});
  const o = {publicMode: true, auth: AUTH, tokens: ['backend-tok'], sessionSecret: SECRET, roles: ROLES};
  assert.deepEqual(await gate(req(ck('rev')), new URL('http://x/bandeja'), o), {kind: 'bandeja', user: 'rev', via: 'session', role: 'reviewer', clients: ['acme']});
  assert.deepEqual(await gate(req({'x-reel-token': 'backend-tok'}), new URL('http://x/bandeja/aprobar'), o), {kind: 'bandeja', user: null});
  assert.deepEqual(await gate(req(ck('rev')), new URL('http://x/bandeja'), {...o, publicMode: false}), {kind: 'bandeja', user: null});
});

test('approve / revoke in the bandeja: only the client\'s reviewer, same-site, with the session\'s CSRF token, from QC superado, retyping the variant name; tokens 403; two at once = one approval; /r/ stays read-only', async () => {
  const {pub, dir} = bandejaFixture(2);
  const srv = await serve(pub, {limiter: createLoginLimiter({max: 100})});
  try {
    const {csrf} = await page(srv, 'rev');
    const ok = {csrf, project: 'p-1', v: '1', confirm: 'ACME_G2_H1_C1'};
    const approval = () => loadReviews(dir, 'p-1').versions[0].approval;
    let r = await post(srv, '/bandeja/aprobar', ck('rev'), ok);
    assert.equal(r.status, 409, 'QC técnico en curso');
    assert.match(r.body.toString(), /role="alert">No se puede aprobar v1: QC técnico en curso/);
    for (const label of ['2 hallazgos', 'no disponible']) {
      await setJudge(dir, 1, label);
      assert.equal((await post(srv, '/bandeja/aprobar', ck('rev'), ok)).status, 409, label);
    }
    await setJudge(dir, 1, 'superado');
    const {csrf: bossCsrf} = await page(srv, 'boss');
    for (const [who, headers, fields, status] of [
      ['the primary token', {'x-reel-token': 'backend-tok'}, ok, 403], ['basic auth', {authorization: 'Basic ' + Buffer.from('rev:pw').toString('base64')}, ok, 403],
      ['the owner (never writes approval)', ck('boss'), {...ok, csrf: bossCsrf}, 403], ['another client\'s reviewer', ck('otro'), ok, 403],
      ['no CSRF token', ck('rev'), {...ok, csrf: ''}, 403], ['another session\'s CSRF token', ck('rev'), {...ok, csrf: bossCsrf}, 403],
      ['the wrong name', ck('rev'), {...ok, confirm: 'ACME_G2_H1_C2'}, 400]]) assert.equal((await post(srv, '/bandeja/aprobar', headers, fields)).status, status, who);
    assert.equal((await get(srv, '/bandeja/aprobar', {...ck('rev'), 'content-type': 'application/x-www-form-urlencoded'}, 'POST', new URLSearchParams(ok).toString())).status, 403, 'no Origin: cross-site refused');
    assert.equal((await post(srv, '/bandeja/aprobar', {...ck('rev'), origin: 'https://evil.example'}, ok)).status, 403, 'another site\'s Origin');
    assert.match((await post(srv, '/bandeja/aprobar', ck('boss'), {...ok, csrf: bossCsrf})).body.toString(), /role="alert">Solo el revisor del cliente puede aprobar — el owner nunca escribe la aprobación/, 'the owner\'s own valid session: refused by the life cycle itself');
    assert.equal(approval(), undefined, 'none of those wrote an approval');
    // a double click: two POSTs at once → one approval, both answered like the first. The second comes as a browser sends it
    // from this page (its Referrer-Policy no-referrer: Origin null) — the CSRF token decides
    const both = await Promise.all([post(srv, '/bandeja/aprobar', ck('rev'), ok), post(srv, '/bandeja/aprobar', {...ck('rev'), origin: 'null'}, ok)]);
    assert.deepEqual(both.map((x) => [x.status, x.headers.location]), [[303, '/bandeja?ok=aprobada#p-1-ACME_G2_H1_C1'], [303, '/bandeja?ok=aprobada#p-1-ACME_G2_H1_C1']]);
    assert.equal(approval().by, 'rev');
    assert.match(approval().ipHash, /^[0-9a-f]{16}$/);
    assert.equal(approval().userAgent, 'TestPhone/1');
    assert.deepEqual(loadReviews(dir, 'p-1').versions[0].log.map((l) => l.action), ['aprobar']);
    const after = await get(srv, '/bandeja?ok=aprobada', ck('rev'));
    assert.match(after.body.toString(), /role="status">Aprobada\./);
    assert.match(after.body.toString(), /aprobada = v1/);
    // v2 approved too, at the same moment as a revoke of v1 is refused: the newer approval is the delivered one
    await setJudge(dir, 2, 'superado (evidencia reducida)');
    const [a2, bad] = await Promise.all([post(srv, '/bandeja/aprobar', ck('rev'), {...ok, v: '2'}), post(srv, '/bandeja/revocar', ck('rev'), {...ok, reason: ''})]);
    assert.deepEqual([a2.status, bad.status], [303, 400]);
    assert.match((await page(srv, 'rev')).html, /aprobada = v2/);
    const api = loadReviews(dir, 'p-1').versions;
    assert.deepEqual(api.map((x) => x.approval?.by), ['rev', 'rev']);
    // revoke: the reviewer, with a reason → por revisar
    assert.equal((await post(srv, '/bandeja/revocar', ck('boss'), {...ok, csrf: bossCsrf, v: '2', reason: 'no'})).status, 403, 'the owner asks the client to revoke; never does it');
    assert.equal((await post(srv, '/bandeja/revocar', ck('rev'), {...ok, v: '2', reason: 'el precio cambió'})).status, 303);
    const v2 = loadReviews(dir, 'p-1').versions[1];
    assert.deepEqual([v2.approval, v2.log.at(-1).action, v2.log.at(-1).reason], [undefined, 'revocar', 'el precio cambió']);
    assert.match((await page(srv, 'rev')).html, /aprobada = v1/, 'v1 is the delivered one again');
    // R-1 / read-only /r/: a link of this client's project plays for its reviewer, takes no POST and has no form
    const l = createLink(dir, 'p-1', {now: Date.now()});
    const rp = await get(srv, `/r/${l.token}`, ck('rev'));
    assert.equal(rp.status, 200);
    assert.ok(!/<form|aprobar|csrf/i.test(rp.body.toString()), 'the /r/ page stays a player');
    assert.match(rp.headers['content-security-policy'], /form-action 'none'/);
    for (const p of [`/r/${l.token}`, `/r/${l.token}/v/1.mp4`]) assert.equal((await post(srv, p, ck('rev'), ok)).status, 405, p);
    for (const p of [`/r/${l.token}/v/1/ACME_G2_H1_C1_v1_master.mp4`, `/r/${l.token}/v/1/project.json`]) assert.equal((await get(srv, p, ck('rev'))).status, 404, `${p}: no pair there`);
  } finally { srv.close(); }
});

test('notes in the bandeja: 20 at once (and 2 approvals) lose none, each anchored on the version\'s snapshot to the right word; plain text, escaped, never a link; each lands in the owner\'s log', async () => {
  const {pub, dir} = bandejaFixture(2);
  await setJudge(dir, 1, 'superado'); await setJudge(dir, 2, 'superado');
  const lines = [];
  const srv = await serve(pub, {limiter: createLoginLimiter({max: 100}), log: (m) => lines.push(m), disk: () => ({freeDiskMb: 100, minDiskMb: 3072})});
  try {
    const {csrf} = await page(srv, 'rev');
    const note = (i) => post(srv, '/bandeja/nota', ck('rev'), {csrf, project: 'p-1', v: '1', atSec: i % 2 ? '1.5' : '1,5', text: `nota ${i}`});
    const approveV = (v) => post(srv, '/bandeja/aprobar', ck('rev'), {csrf, project: 'p-1', v: String(v), confirm: 'ACME_G2_H1_C1'});
    const all = await Promise.all([...Array.from({length: 20}, (_, i) => note(i)), approveV(1), approveV(2)]);
    assert.deepEqual([...new Set(all.map((x) => x.status))], [303]);
    const [v1, v2] = loadReviews(dir, 'p-1').versions;
    assert.equal(v1.notes.length, 20, 'none lost');
    assert.deepEqual(v1.notes.map((n) => n.text).sort(), Array.from({length: 20}, (_, i) => `nota ${i}`).sort());
    assert.equal(new Set(v1.notes.map((n) => n.id)).size, 20);
    assert.ok(v1.approval && v2.approval, 'both approvals written');
    for (const n of v1.notes) assert.deepEqual([n.atSec, n.anchor, n.by, n.state], [1.5, ANCHOR, 'rev', 'abierta'], n.id);
    assert.ok(v1.notes.some((n) => !n.afterApproval) && v1.notes.every((n) => !n.afterApproval || v1.log.findIndex((l) => l.action === 'aprobar') < v1.log.findIndex((l) => l.note === n.id)), 'flagged only when written after the approval');
    // the owner's log: one line per note, the low disk too — each once
    assert.equal(lines.filter((l) => /^\[owner-inbox\] nota: ACME_G2_H1_C1 v1 @0:01\.5, de rev \(abierta/.test(l)).length, 20);
    assert.equal(lines.filter((l) => l.startsWith('[owner-inbox] disco:')).length, 1);
    // hostile text: escaped, never a tag, never a link
    assert.equal((await post(srv, '/bandeja/nota', ck('rev'), {csrf, project: 'p-1', v: '2', atSec: '0.5', text: '<script>alert(1)</script> mira https://evil.example/x'})).status, 303);
    for (const who of ['rev', 'boss']) {
      const html = (await page(srv, who)).html;
      assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; mira https://evil.example/x'), who);
      assert.ok(!/<script>alert|href="https:\/\/evil/.test(html), who);
    }
    assert.match((await page(srv, 'boss')).html, /palabra b:2/, 'the owner sees where it anchored');
    // bad notes: the page again, the draft kept in its form
    const bad = await post(srv, '/bandeja/nota', ck('rev'), {csrf, project: 'p-1', v: '1', atSec: '99', text: 'fuera del reel'});
    assert.equal(bad.status, 400);
    assert.match(bad.body.toString(), /<details class="note" data-draft="nota:p-1:1:" data-video="vid-p-1-1" open>/);
    assert.match(bad.body.toString(), />fuera del reel<\/textarea>/);
    assert.equal((await post(srv, '/bandeja/nota', {'x-reel-token': 'backend-tok'}, {csrf, project: 'p-1', v: '1', atSec: '1', text: 'x'})).status, 403, 'an agent never writes the client\'s notes');
    assert.equal((await post(srv, '/bandeja/nota', ck('rev'), {csrf, project: 'p-2', v: '1', atSec: '1', text: 'x'})).status, 404, 'another client\'s version is not there for them');
  } finally { srv.close(); }
  // at most 30 steps a minute per user (here 2)
  const slow = await serve(pub, {limiter: createLoginLimiter({max: 2})});
  try {
    const {csrf} = await page(slow, 'rev');
    const r = [];
    for (let i = 0; i < 3; i++) r.push(await post(slow, '/bandeja/nota', ck('rev'), {csrf, project: 'p-1', v: '1', atSec: '1', text: 'x'}));
    assert.deepEqual(r.map((x) => x.status), [303, 303, 429]);
    assert.ok(+r[2].headers['retry-after'] > 0);
  } finally { slow.close(); }
});

test('note steps in the bandeja: the owner confirms a classified note or discards one (the client sees why); the reviewer verifies only a resolved one', async () => {
  const {pub, dir} = bandejaFixture(1);
  const srv = await serve(pub, {limiter: createLoginLimiter({max: 100})});
  try {
    const rev = (await page(srv, 'rev')).csrf, boss = (await page(srv, 'boss')).csrf;
    for (const text of ['sube la voz', 'quita el logo']) assert.equal((await post(srv, '/bandeja/nota', ck('rev'), {csrf: rev, project: 'p-1', v: '1', atSec: '0.4', text})).status, 303);
    const step = (who, csrf, note, s, extra = {}) => post(srv, '/bandeja/nota/estado', ck(who), {csrf, project: 'p-1', v: '1', note, step: s, ...extra});
    const state = (id) => loadReviews(dir, 'p-1').versions[0].notes.find((n) => n.id === id).state;
    assert.equal((await step('rev', rev, 'n1', 'confirmar')).status, 403, 'the reviewer never confirms');
    assert.equal((await step('boss', boss, 'n1', 'confirmar')).status, 409, 'an unclassified note is not confirmed');
    const unclassified = (await page(srv, 'boss')).html;
    assert.match(unclassified, /Se confirma cuando el agente la clasifique/, 'the owner is told why there is no Confirmar yet');
    assert.doesNotMatch(unclassified, /value="confirmar"/);
    assert.equal((await step('boss', boss, 'n1', 'resolver')).status, 400, 'the agent\'s steps are not the bandeja\'s');
    const agent = actorOf({via: 'backend-token'});
    await withVersion(dir, 'p-1', 1, (x) => moveNote(x, 'n1', 'clasificar', agent, {at: 'now', kind: 'fix'})); // the agent's side (phase 8: review_notes)
    assert.equal((await step('boss', boss, 'n1', 'confirmar')).status, 303);
    assert.equal(state('n1'), 'confirmada');
    assert.equal((await step('rev', rev, 'n1', 'verificar')).status, 409, 'verificada without resuelta');
    await withVersion(dir, 'p-1', 1, (x) => moveNote(x, 'n1', 'resolver', agent, {at: 'now', v: 2}));
    assert.equal((await step('boss', boss, 'n1', 'verificar')).status, 403, 'only the client verifies');
    assert.equal((await step('rev', rev, 'n1', 'verificar')).status, 303);
    assert.equal(state('n1'), 'verificada');
    assert.equal((await step('boss', boss, 'n2', 'descartar')).status, 400, 'a reason is required');
    assert.equal((await step('rev', rev, 'n2', 'descartar', {reason: 'x'})).status, 403, 'the reviewer never discards');
    assert.equal((await step('boss', boss, 'n2', 'descartar', {reason: 'el logo es del cliente'})).status, 303);
    const html = (await page(srv, 'rev')).html;
    assert.match(html, /Descartada: el logo es del cliente/);
    assert.match(html, /verificada/);
    assert.deepEqual(loadReviews(dir, 'p-1').versions[0].log.map((l) => `${l.action}:${l.by}`), ['nota:rev', 'nota:rev', 'clasificar:backend-token', 'confirmar:boss', 'resolver:backend-token', 'verificar:rev', 'descartar:boss']);
  } finally { srv.close(); }
});

test('the bandeja after the reviews: a variant reads only its own versions; retention-stripped versions take no approval or note; drafts of a version no longer shown come back; a note\'s answer names its draft; a stale page is answered with a working one', async () => {
  const {pub, dir} = bandejaFixture(3);
  for (const v of [1, 2, 3]) await setJudge(dir, v, 'superado');
  const srv = await serve(pub, {limiter: createLoginLimiter({max: 100})});
  try {
    const {csrf, html} = await page(srv, 'rev');
    // v3 is the newest: v1 and v2 keep a hidden note form each, where a draft left on them comes back (UX-1)
    assert.match(html, /<details class="note" data-draft="nota:p-1:3:" data-video="vid-p-1-3">/);
    for (const v of [1, 2]) assert.match(html, new RegExp(`<details class="note" data-draft="nota:p-1:${v}:" data-video="" hidden><summary>Nota sin enviar en v${v}`));
    assert.match(html, /name="atSec" type="number" inputmode="decimal" step="any" min="0" max="2.5"/, 'the form takes what the server takes: the length + 0.5 s');
    // a note's answer names the draft it confirms; the anchor is the variant's row
    const sent = await post(srv, '/bandeja/nota', {...ck('rev'), origin: 'null'}, {csrf, project: 'p-1', v: '2', atSec: '2.4', text: 'al final'});
    assert.deepEqual([sent.status, sent.headers.location], [303, '/bandeja?ok=nota&k=p-1%3A2%3A2.4#p-1-ACME_G2_H1_C1']);
    assert.match(html, /<article class="variant" id="p-1-ACME_G2_H1_C1">/);
    // a page of an earlier login: 403 with the bandeja itself — this session's token, the note still in its form
    const stale = await post(srv, '/bandeja/nota', ck('rev'), {csrf: 'from-an-earlier-login', project: 'p-1', v: '1', atSec: '1', text: 'mi nota'});
    const body = stale.body.toString();
    assert.equal(stale.status, 403);
    assert.match(body, /role="alert">La página había caducado/);
    assert.match(body, new RegExp(`name="csrf" value="${csrf}"`));
    assert.match(body, /data-draft="nota:p-1:1:" data-video="vid-p-1-1" open>.*>mi nota<\/textarea>/s);
    // a refusal outside the page: plain HTML with the way back, never a dead end
    const late = await post(srv, '/bandeja/nota', {'x-reel-token': 'backend-tok'}, {csrf, project: 'p-1', v: '1', atSec: '1', text: 'x'});
    assert.equal(late.status, 403);
    assert.match(late.body.toString(), /<a style="color:#8ab4ff" href="\/login\?next=%2Fbandeja">Entrar<\/a>/);
    // the retention stripped v1 (REEL_REVIEW_KEEP_UNAPPROVED): neither approved nor annotated, and the page says so
    await withVersion(dir, 'p-1', 1, (x) => { x.pruned = Object.values(x.deliverables); });
    for (const [route, fields] of [['/bandeja/aprobar', {confirm: 'ACME_G2_H1_C1'}], ['/bandeja/nota', {atSec: '1', text: 'tarde'}]]) {
      const r = await post(srv, route, ck('rev'), {csrf, project: 'p-1', v: '1', ...fields});
      assert.equal(r.status, 409, route);
      assert.match(r.body.toString(), /role="alert">No se puede (aprobar|anotar) v1: sus archivos ya no están/, route);
    }
    assert.equal(loadReviews(dir, 'p-1').versions[0].approval, undefined);
    // the project's identity moves to H2 after v1 (H1) was approved: H2 is not 'aprobada = v1'; H1 keeps its approval
    await withVersion(dir, 'p-1', 1, (x) => { delete x.pruned; });
    assert.equal((await post(srv, '/bandeja/aprobar', ck('rev'), {csrf, project: 'p-1', v: '1', confirm: 'ACME_G2_H1_C1'})).status, 303);
    const h2 = {...IDENTITY, variant: {hook: 2, cta: 1}};
    await withVersion(dir, 'p-1', 3, (x) => { x.identity = h2; });
    fs.writeFileSync(path.join(pub, 'projects', 'p-1.json'), JSON.stringify({name: 'G2', identity: h2}));
    const moved = (await page(srv, 'rev')).html;
    assert.match(moved, /<article class="variant" id="p-1-ACME_G2_H1_C1">\n<header><h3>ACME_G2_H1_C1<\/h3><span class="badge st-aprobada">aprobada = v1</);
    assert.match(moved, /<article class="variant" id="p-1-ACME_G2_H2_C1">\n<header><h3>ACME_G2_H2_C1<\/h3><span class="badge st-por-revisar">por revisar</);
    const rows = bandejaRows(pub, () => true).filter((r) => r.projectId === 'p-1');
    assert.deepEqual(rows.map((r) => [r.stem, r.versions.map((x) => x.v), !!r.project]), [['ACME_G2_H1_C1', [1, 2], false], ['ACME_G2_H2_C1', [3], true]]);
  } finally { srv.close(); }
});
