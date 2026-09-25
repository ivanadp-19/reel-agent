import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import bcrypt from 'bcryptjs';
import {createLink, hashToken, loadReviews, proxyArgs, recordFinal, recordVersion, removeVersion, resolveToken, retainedFiles, revokeLink} from '../scripts/reviews.mjs';
import {gate, serveFile} from '../server/http.mjs';
import {handleReview} from '../server/review.mjs';

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

// the same order as server/index.mjs: gate first, /r/ → the review handler, else the static files
function serve(pub, {publicMode = true, now} = {}) {
  const auth = {ana: bcrypt.hashSync('pw', 4)};
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const g = gate(req, url, {publicMode, auth, tokens: ['backend-tok']});
    if (g.kind === 'review') return handleReview(req, res, url, {publicDir: pub, now});
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
  assert.equal(gate(local, new URL('http://x/exports/edited-1.mp4'), {publicMode: false}).status, 403);
  assert.equal(gate(local, new URL('http://x/api/projects'), {publicMode: false}).status, 403);
  assert.equal(gate(local, new URL(`http://x/r/${token}`), {publicMode: false}).kind, 'review', 'behind Caddy the page is reachable by any Host');
  assert.equal(gate({headers: {host: '127.0.0.1:3333', origin: 'https://evil.example'}}, new URL('http://x/api/render'), {publicMode: false}).status, 403);
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
