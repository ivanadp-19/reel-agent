// Clip ingest (server/ingest.mjs): browser uploads are a job (202 + polling); the MCP's ?path= and the reel CLI's
// ?path= (user token) / ?upload= stay synchronous.
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {createClipIngest, progressSec} from '../server/ingest.mjs';
import {openForUser} from '../server/tokens.mjs';
import {partFile} from '../server/uploads.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const TOKEN = 'tok-primary';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-ingest-'));
const pub = path.join(dir, 'public');
const clips = path.join(pub, 'clips');
const logs = [];
let srv, base, ingest;
const uploadsDir = path.join(dir, '.uploads');
const opens = []; // every descriptor openForUser handed out, and whether it was closed
const uid = process.getuid?.() ?? 0;

// a small test video: h264 (remuxed) or mpeg4 (transcoded)
const video = (name, codec) => {
  const f = path.join(dir, name);
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2',
    '-c:v', codec, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]);
  return f;
};

before(async () => {
  const spyOpen = (file, u) => {
    const o = openForUser(file, u);
    if (!o) return null;
    const rec = {closed: false};
    opens.push(rec);
    return {path: o.path, close: () => { rec.closed = true; o.close(); }};
  };
  ingest = createClipIngest({publicDir: pub, root: dir, token: TOKEN, uploadsDir, openForUser: spyOpen, explain: (tail, fb) => tail.trim().split('\n').pop() || fb, log: (l) => logs.push(l)});
  // x-test-user: user:uid → the gate's verdict for a reel CLI user token (server/http.mjs gate)
  const gateOf = (req) => {
    const [user, u] = String(req.headers['x-test-user'] ?? '').split(':');
    return user ? {via: 'user-token', user, uid: u === '' ? null : +u} : {};
  };
  srv = http.createServer((req, res) => { if (!ingest.handle(req, res, new URL(req.url, 'http://x'), gateOf(req))) { res.writeHead(404); res.end(); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv?.close(); fs.rmSync(dir, {recursive: true, force: true}); });

const poll = async (jobId, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    const s = await fetch(`${base}/api/add-clip/${jobId}`).then((r) => r.json());
    if (s.status !== 'running') return s;
    assert.ok(Date.now() - t0 < ms, 'ingest job did not finish');
    await new Promise((r) => setTimeout(r, 50));
  }
};
const uploads = () => fs.readdirSync(dir).filter((f) => f.startsWith('.upload-'));

test('progressSec reads out_time_us / out_time_ms (both microseconds)', () => {
  assert.equal(progressSec('frame=10\nout_time_us=1500000\nout_time_ms=1500000\nprogress=continue\n'), 1.5);
  assert.equal(progressSec('out_time_ms=2000000\n'), 2);
  assert.equal(progressSec('frame=1\n'), null);
});

test('a browser upload answers 202 {jobId} at once; the job ends with the same clip the sync answer carries', {skip: !hasFfmpeg}, async () => {
  const src = video('phone.mp4', 'mpeg4');
  const r = await fetch(`${base}/api/add-clip?name=phone.mov`, {method: 'POST', body: fs.readFileSync(src)});
  assert.equal(r.status, 202);
  const {jobId} = await r.json();
  assert.match(jobId, /^[0-9a-f-]{36}$/);
  const s = await poll(jobId);
  assert.equal(s.status, 'done', JSON.stringify(s));
  assert.equal(s.progress, 100);
  assert.equal(s.clip.id, 'phone');
  assert.equal(s.clip.src, 'clips/phone.mp4');
  assert.equal(s.clip.label, 'phone');
  assert.ok(Math.abs(s.clip.sourceDurationSec - 2) < 0.2, String(s.clip.sourceDurationSec));
  assert.equal(s.clip.outSec, s.clip.sourceDurationSec);
  assert.ok(fs.statSync(path.join(clips, 'phone.mp4')).size > 0);
  assert.ok(fs.existsSync(path.join(clips, 'thumbs', 'phone.jpg')));
  assert.deepEqual(uploads(), [], 'the upload tmp is removed');
  // one line per transition: start, probed (codec/size/duration), transcode done, done
  const mine = logs.filter((l) => l.includes(jobId.slice(0, 8)));
  assert.match(mine[0], /start \([\d.]+ MB uploaded\)/);
  assert.match(mine[1], /probed mpeg4 yuv420p 320x240 2\.\ds → transcoding/);
  assert.match(mine[2], /transcode done in [\d.]+s/);
  assert.match(mine[3], /done clips\/phone\.mp4/);
});

test('?path= (the MCP, primary token) stays synchronous: 200 with the clip JSON', {skip: !hasFfmpeg}, async () => {
  const src = video('take.mp4', 'libx264');
  const q = `${base}/api/add-clip?name=take.mp4&path=${encodeURIComponent(src)}`;
  assert.equal((await fetch(q, {method: 'POST'})).status, 403);
  assert.equal((await fetch(q, {method: 'POST', headers: {'x-reel-token': 'another'}})).status, 403);
  const r = await fetch(q, {method: 'POST', headers: {'x-reel-token': TOKEN}});
  assert.equal(r.status, 200);
  const clip = await r.json();
  assert.equal(clip.id, 'take');
  assert.equal(clip.src, 'clips/take.mp4');
  assert.ok(clip.sourceDurationSec > 1.5);
  assert.ok(fs.existsSync(src), 'the caller\'s file is never deleted');
  assert.ok(logs.some((l) => /ingest take: probed h264 .* → remuxing/.test(l)));
  assert.ok(logs.some((l) => /ingest take: remux done/.test(l)));
});

test('a file ffmpeg cannot read: the job fails with a readable message, nothing is left behind', async () => {
  const r = await fetch(`${base}/api/add-clip?name=broken.mp4`, {method: 'POST', body: Buffer.alloc(4096, 7)});
  assert.equal(r.status, 202);
  const s = await poll((await r.json()).jobId);
  assert.equal(s.status, 'error');
  assert.match(s.error, /^transcode failed: \S/);
  assert.ok(!fs.existsSync(path.join(clips, 'broken.mp4')));
  assert.deepEqual(uploads(), []);
  assert.ok(logs.some((l) => /ingest .* broken: error — transcode failed/.test(l)));
});

test('the job survives the client going away after the upload: the clip still lands', {skip: !hasFfmpeg}, async () => {
  const data = fs.readFileSync(video('gone.mp4', 'mpeg4'));
  await new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/add-clip?name=gone.mp4`, {method: 'POST', headers: {'content-length': data.length}});
    req.on('response', (res) => { assert.equal(res.statusCode, 202); req.destroy(); resolve(); }); // the browser tab closes
    req.on('error', reject);
    req.end(data);
  });
  const t0 = Date.now();
  while (!Object.values(ingest.jobs).some((j) => j.status === 'done' && j.clip.id === 'gone')) {
    assert.ok(Date.now() - t0 < 20000, 'the ingest did not finish');
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(fs.existsSync(path.join(clips, 'gone.mp4')));
  assert.ok(fs.existsSync(path.join(clips, 'thumbs', 'gone.jpg')));
});

test('an upload cut off halfway: no job, the tmp is removed', async () => {
  const before = Object.keys(ingest.jobs).length;
  await new Promise((resolve) => {
    const req = http.request(`${base}/api/add-clip?name=cut.mp4`, {method: 'POST', headers: {'content-length': 1 << 20}});
    req.on('error', () => resolve());
    req.write(Buffer.alloc(64 * 1024));
    setTimeout(() => { req.destroy(); resolve(); }, 100);
  });
  const t0 = Date.now();
  while (!logs.some((l) => /ingest cut: upload (interrupted|failed)/.test(l))) {
    assert.ok(Date.now() - t0 < 5000, 'the interrupted upload was not noticed');
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.deepEqual(uploads(), []);
  assert.equal(Object.keys(ingest.jobs).length, before);
});

test('two uploads of one name in flight get different ids', {skip: !hasFfmpeg}, async () => {
  const data = fs.readFileSync(video('twin.mp4', 'libx264'));
  const ids = await Promise.all([0, 1].map(async () => {
    const r = await fetch(`${base}/api/add-clip?name=twin.mp4`, {method: 'POST', body: data});
    return (await poll((await r.json()).jobId)).clip.id;
  }));
  assert.deepEqual(ids.sort(), ['twin', 'twin-2']);
});

test('an unknown job id → {status: unknown}', async () => {
  assert.deepEqual(await fetch(`${base}/api/add-clip/nope`).then((r) => r.json()), {status: 'unknown'});
});

// ---- the reel CLI: path ingest with a user token, chunked upload parts ----
const post = (q, headers = {}) => fetch(`${base}/api/add-clip?${q}`, {method: 'POST', headers});

test('?path= with a user token: the user\'s own file is ingested synchronously through the checked descriptor', {skip: !hasFfmpeg || process.platform !== 'linux'}, async () => {
  const src = video('mine.mp4', 'libx264');
  fs.chmodSync(src, 0o600);
  const n = opens.length;
  const r = await post(`name=mine.mp4&path=${encodeURIComponent(src)}`, {'x-test-user': `alice:${uid}`});
  assert.equal(r.status, 200);
  const clip = await r.json();
  assert.equal(clip.id, 'mine');
  assert.ok(fs.existsSync(path.join(clips, 'mine.mp4')));
  assert.ok(fs.existsSync(src), 'the user\'s file is never deleted');
  assert.equal(opens.length, n + 1);
  assert.equal(opens.at(-1).closed, true, 'the descriptor is closed after the ingest');
});

test('?path= with a user token: another user\'s file → 403 path_not_allowed with the upload hint; a non-video → 400 bad_path', async () => {
  const src = path.join(dir, 'theirs.mp4');
  fs.writeFileSync(src, 'x');
  fs.chmodSync(src, 0o600); // not readable by everyone, and not owned by uid + 1
  const r = await post(`name=theirs.mp4&path=${encodeURIComponent(src)}`, {'x-test-user': `bob:${uid + 1}`});
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), {error: 'the backend may not read this file for you: it is not yours and not readable by everyone', code: 'path_not_allowed', hint: 'upload it instead (reel clips add does when this happens)'});
  const missing = await post(`name=gone.mp4&path=${encodeURIComponent(path.join(dir, 'nope.mp4'))}`, {'x-test-user': `bob:${uid}`});
  assert.equal(missing.status, 403);
  assert.equal((await missing.json()).code, 'path_not_allowed');
  const bad = await post(`name=a.txt&path=${encodeURIComponent(src.replace(/mp4$/, 'txt'))}`, {'x-test-user': `alice:${uid}`});
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), {error: 'path must be a video file', code: 'bad_path'});
  assert.ok(fs.existsSync(src));
});

test('?upload=<id> complete: synchronous 200 with the clip, the part is removed', {skip: !hasFfmpeg}, async () => {
  const id = 'a'.repeat(32);
  const part = partFile(uploadsDir, 'alice', id);
  fs.mkdirSync(uploadsDir, {recursive: true});
  fs.copyFileSync(video('chunked.mp4', 'mpeg4'), part);
  const size = fs.statSync(part).size;
  const r = await post(`name=chunked.mp4&upload=${id}&size=${size}`, {'x-test-user': `alice:${uid}`});
  assert.equal(r.status, 200);
  const clip = await r.json();
  assert.equal(clip.id, 'chunked');
  assert.equal(clip.src, 'clips/chunked.mp4');
  assert.ok(fs.existsSync(path.join(clips, 'chunked.mp4')));
  assert.ok(!fs.existsSync(part), 'the ingested part is removed');
});

test('?upload=<id> incomplete → 409 upload_incomplete with its size (kept); absent → 404; bad id → 400; another user\'s part is not found', async () => {
  const id = 'b'.repeat(32);
  const part = partFile(uploadsDir, 'alice', id);
  fs.mkdirSync(uploadsDir, {recursive: true});
  fs.writeFileSync(part, Buffer.alloc(100));
  const inc = await post(`name=x.mp4&upload=${id}&size=250`, {'x-test-user': `alice:${uid}`});
  assert.equal(inc.status, 409);
  assert.deepEqual(await inc.json(), {error: `upload ${id} has 100 of 250 bytes`, code: 'upload_incomplete', size: 100});
  assert.ok(fs.existsSync(part), 'an incomplete part stays for the CLI to resume');
  const other = await post(`name=x.mp4&upload=${id}&size=100`, {'x-test-user': `bob:${uid}`});
  assert.equal(other.status, 404);
  const none = await post(`name=x.mp4&upload=${'c'.repeat(32)}&size=10`, {'x-test-user': `alice:${uid}`});
  assert.equal(none.status, 404);
  assert.deepEqual(await none.json(), {error: `no upload ${'c'.repeat(32)}`, code: 'not_found'});
  const bad = await post('name=x.mp4&upload=../etc', {'x-test-user': `alice:${uid}`});
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), {error: 'bad upload id', code: 'bad_request'});
  assert.ok(!Object.values(ingest.jobs).some((j) => j.clip?.id === 'x'), 'no async job for the CLI\'s ways');
});
