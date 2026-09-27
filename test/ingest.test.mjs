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
import {addedClip} from '../src/timeline.ts';

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
let free = Infinity; // the disk the clips land on (the backend: statfs of public/), over a 1 MB floor here

// a small test video: h264 (remuxed) or mpeg4 (transcoded); its name in its metadata, so no two are the same bytes
const video = (name, codec) => {
  const f = path.join(dir, name);
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2',
    '-c:v', codec, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-metadata', `title=${name}`, '-shortest', f]);
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
  ingest = createClipIngest({publicDir: pub, root: dir, token: TOKEN, uploadsDir, openForUser: spyOpen, explain: (tail, fb) => tail.trim().split('\n').pop() || fb, log: (l) => logs.push(l), freeBytes: () => free, minFreeBytes: 2 ** 20});
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
  const files = [video('twin.mp4', 'libx264'), video('twin-b.mp4', 'libx264')]; // two files, one name
  const ids = await Promise.all(files.map(async (f) => {
    const r = await fetch(`${base}/api/add-clip?name=twin.mp4`, {method: 'POST', body: fs.readFileSync(f)});
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

test('?upload=<id>&async=1 (the editor): 202 {jobId} at once, the job ends with the clip, the part is removed', {skip: !hasFfmpeg}, async () => {
  const id = 'e'.repeat(32);
  const part = partFile(uploadsDir, 'local', id); // a browser without a user: the loopback's namespace
  fs.mkdirSync(uploadsDir, {recursive: true});
  fs.copyFileSync(video('edited.mp4', 'mpeg4'), part);
  const r = await post(`name=edited.mov&upload=${id}&size=${fs.statSync(part).size}&async=1`);
  assert.equal(r.status, 202);
  const {jobId} = await r.json();
  const s = await poll(jobId);
  assert.equal(s.status, 'done', JSON.stringify(s));
  assert.equal(s.clip.id, 'edited');
  assert.equal(s.clip.src, 'clips/edited.mp4');
  assert.ok(fs.existsSync(path.join(clips, 'edited.mp4')));
  assert.ok(!fs.existsSync(part), 'the ingested part is removed');
  assert.ok(logs.some((l) => l.includes(`${jobId.slice(0, 8)} edited: start (upload ${id}, `)));
});

test('a file with the same bytes as a source in public/clips is that source: no new clip, its transcripts kept (path, copy, upload)', {skip: !hasFfmpeg}, async () => {
  const kept = path.join(clips, 'take.mp4'); // ingested by the ?path= test above
  const before = fs.readdirSync(clips).sort();
  const same = (c) => {
    assert.equal(c.id, 'take');
    assert.equal(c.src, 'clips/take.mp4', 'the source its transcript caches are keyed by');
    assert.ok(Math.abs(c.sourceDurationSec - 2) < 0.2 && c.outSec === c.sourceDurationSec);
    assert.match(c.ingest, /same file as clips\/take\.mp4/);
  };
  const byPath = await fetch(`${base}/api/add-clip?name=take.mp4&path=${encodeURIComponent(kept)}`, {method: 'POST', headers: {'x-reel-token': TOKEN}});
  assert.equal(byPath.status, 200);
  same(await byPath.json());
  const copy = path.join(dir, 'again.mp4');
  fs.copyFileSync(kept, copy);
  same(await (await fetch(`${base}/api/add-clip?name=again.mp4&path=${encodeURIComponent(copy)}`, {method: 'POST', headers: {'x-reel-token': TOKEN}})).json());
  const body = await fetch(`${base}/api/add-clip?name=again.mp4`, {method: 'POST', body: fs.readFileSync(kept)});
  same((await poll((await body.json()).jobId)).clip);
  assert.deepEqual(fs.readdirSync(clips).sort(), before, 'nothing new in public/clips');
  assert.ok(fs.existsSync(kept) && fs.existsSync(copy), 'the source and the caller\'s file stay');
  assert.deepEqual(uploads(), [], 'the upload tmp is removed');
  assert.ok(logs.some((l) => /ingest .*take-\d+: same bytes as clips\/take\.mp4 → reused/.test(l)));
});

test('a file ingested before from outside public/clips (clips/ has its transcode: other bytes) is that source again — one after another or at once', {skip: !hasFfmpeg}, async () => {
  const shoot = video('shoot.mp4', 'mpeg4');
  const add = () => post(`name=shoot.mp4&path=${encodeURIComponent(shoot)}`, {'x-reel-token': TOKEN}).then((r) => r.json());
  const both = await Promise.all([add(), add()]); // neither has an output yet when both start
  assert.deepEqual(both.map((c) => c.id), ['shoot', 'shoot']);
  assert.equal(both.filter((c) => c.ingest).length, 1, 'one made it, the other reused it');
  assert.notEqual(fs.statSync(path.join(clips, 'shoot.mp4')).size, fs.statSync(shoot).size, 'transcoded: the clip is other bytes');
  const again = await add();
  assert.deepEqual([again.id, again.src], ['shoot', 'clips/shoot.mp4']);
  assert.match(again.ingest, /reused with its transcripts/);
  assert.deepEqual(fs.readdirSync(clips).filter((n) => n.startsWith('shoot')), ['shoot.mp4']);
});

test('?upload&async=1 asked again for one part (a second tab, a 202 lost on the way) answers the job it has — also after it is done', {skip: !hasFfmpeg}, async () => {
  const id = 'f'.repeat(32);
  const part = partFile(uploadsDir, 'local', id);
  const src = video('tab.mp4', 'mpeg4');
  fs.copyFileSync(src, part);
  const q = `name=tab.mp4&upload=${id}&size=${fs.statSync(part).size}&async=1`;
  const [a, b] = await Promise.all([post(q), post(q)]);
  const jobs = [(await a.json()).jobId, (await b.json()).jobId];
  assert.deepEqual([a.status, b.status, jobs[0]], [202, 202, jobs[1]]);
  assert.equal((await poll(jobs[0])).clip.id, 'tab');
  fs.copyFileSync(src, part); // the same file uploaded again once it is a clip
  const c = await post(q);
  assert.deepEqual([c.status, (await c.json()).jobId], [202, jobs[0]]);
  assert.ok(!fs.existsSync(part), 'the new part goes');
  assert.deepEqual(fs.readdirSync(clips).filter((n) => n.startsWith('tab')), ['tab.mp4']);
});

test('addedClip: a source the project has already is not added twice (its words would share ids); a new source whose id is taken gets the next one', () => {
  const take = {id: 'take', src: 'clips/take.mp4'};
  assert.equal(addedClip([], take), take);
  assert.equal(addedClip([take], take), null);
  assert.equal(addedClip([{id: 'take-s2', src: 'clips/take.mp4'}], take), null, 'a piece of it counts');
  assert.deepEqual(addedClip([{id: 'take', src: 'clips/other.mp4'}], take), {id: 'take-c1', src: 'clips/take.mp4'});
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

test('a clip the disk cannot take over its floor is refused 507 low_disk before anything is written (a body, a path)', async () => {
  const src = path.join(dir, 'disk.mp4');
  fs.writeFileSync(src, Buffer.alloc(6000));
  const before = fs.existsSync(clips) ? fs.readdirSync(clips) : [];
  free = 2 ** 20 + 5000; // the floor + 5000 bytes
  try {
    const answers = [
      await fetch(`${base}/api/add-clip?name=big.mp4`, {method: 'POST', body: Buffer.alloc(3000)}), // 3000 uploaded + ~3000 of clip
      await fetch(`${base}/api/add-clip?path=${encodeURIComponent(src)}`, {method: 'POST', headers: {'x-reel-token': TOKEN}}), // ~6000 of clip
    ];
    for (const r of answers) {
      assert.equal(r.status, 507);
      const x = await r.json();
      assert.equal(x.code, 'low_disk');
      assert.match(x.error, /^not enough free disk for this clip: 1 MB free, it needs 0 MB over the 1 MB floor/);
    }
  } finally { free = Infinity; }
  assert.deepEqual(uploads(), [], 'no upload left on disk');
  assert.deepEqual(fs.existsSync(clips) ? fs.readdirSync(clips) : [], before, 'no clip');
});
