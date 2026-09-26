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
import {handleReview} from '../server/review.mjs';
import {SESSION_COOKIE, parseRoles, signSession} from '../server/session.mjs';

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
function serve(pub, {publicMode = true, now} = {}) {
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const g = await gate(req, url, {publicMode, auth: AUTH, tokens: ['backend-tok', 'second-tok'], sessionSecret: SECRET, roles: ROLES});
    if (g.kind === 'review') return handleReview(req, res, url, {publicDir: pub, now, g, login: publicMode});
    if (g.kind === 'deny') { res.writeHead(g.status, g.headers); return res.end(g.body); }
    const f = path.join(pub, path.normalize(decodeURIComponent(url.pathname)));
    if (f.startsWith(pub) && fs.existsSync(f) && fs.statSync(f).isFile()) return serveFile(req, res, f);
    res.writeHead(404); res.end();
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
function get(srv, p, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port: srv.address().port, path: p, method, headers}, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
    });
    req.on('error', reject);
    req.end();
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
function withPair(pub, dir, {captions = true, now = T0, master = 'master', masterKey} = {}) {
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
    deliverables: {master: path.join(t, 'master.mp4'), captions: path.join(t, 'captions.mov'), captionsPng: path.join(t, 'captions.png.zip'), supers: path.join(t, 'supers.mov'), masterSupers: path.join(t, 'master_supers.mp4')}, identity: IDENTITY, snapshot: {clips: [{id: 'c0'}], captionStyle: 'palabra'}, masterKey});
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
