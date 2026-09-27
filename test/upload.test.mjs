import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fmtMB, isVideoFile, pct, pendingIngests, uploadClip, uploadError, uploadId, uploadParts, waitIngest} from '../editor/upload.ts';

test('uploadError: the server JSON error and detail are shown with the status', () => {
  assert.equal(uploadError(500, 'Internal Server Error', JSON.stringify({error: 'transcode failed', detail: 'moov atom not found'})),
    '500 Internal Server Error — transcode failed: moov atom not found');
  assert.equal(uploadError(500, '', JSON.stringify({error: 'transcode failed', detail: 'libpostproc 57. 3.100\nError opening input files: Invalid data found when processing input\n'})),
    '500 — transcode failed: Error opening input files: Invalid data found when processing input');
  assert.equal(uploadError(403, '', JSON.stringify({error: 'path ingest needs the backend token'})), '403 — path ingest needs the backend token');
});

test('uploadError: non-JSON bodies, auth, size and network failures still say something', () => {
  assert.equal(uploadError(502, 'Bad Gateway', '<html><body><h1>502 Bad Gateway</h1></body></html>'), '502 Bad Gateway — 502 Bad Gateway');
  assert.equal(uploadError(401, 'Unauthorized', ''), '401 Unauthorized — not signed in');
  assert.equal(uploadError(413, '', ''), '413 — file too large');
  assert.match(uploadError(0, '', ''), /Network error/);
});

test('progress helpers', () => {
  assert.equal(pct(0, 0), 0);
  assert.equal(pct(512, 1024), 50);
  assert.equal(pct(2000, 1024), 100);
  assert.equal(fmtMB(1.6 * 1048576), '1.6 MB');
  assert.equal(fmtMB(250 * 1048576), '250 MB');
  assert.ok(isVideoFile({name: 'a.MOV', type: ''}));
  assert.ok(isVideoFile({name: 'x', type: 'video/mp4'}));
  assert.ok(!isVideoFile({name: 'notes.txt', type: 'text/plain'}));
});

// a fetch that answers the ingest polls in order; an Error entry throws like a network failure
const fakeFetch = (answers) => {
  const urls = [];
  const fn = async (url) => {
    urls.push(url);
    const a = answers.shift();
    if (a instanceof Error) throw a;
    const {status = 200, body} = a;
    return {ok: status < 300, status, statusText: '', json: async () => body, text: async () => JSON.stringify(body)};
  };
  return {fn, urls};
};
const fast = (fetchFn, extra = {}) => ({fetchFn, everyMs: 0, ...extra});

test('waitIngest: polls the job, reports % and label, resolves the clip', async () => {
  const clip = {id: 'take', src: 'clips/take.mp4', outSec: 3};
  const f = fakeFetch([
    {body: {status: 'running', progress: 0, label: 'Probing'}},
    {body: {status: 'running', progress: 40, label: 'Transcoding'}},
    {body: {status: 'running', progress: 96, label: 'Making thumbnail'}},
    {body: {status: 'done', progress: 100, label: 'Ready', clip}},
  ]);
  const seen = [];
  assert.deepEqual(await waitIngest('ab/c', {progress: (p, l) => seen.push(`${l} ${p}`)}, fast(f.fn)), clip);
  assert.deepEqual(seen, ['Probing 0', 'Transcoding 40', 'Making thumbnail 96']);
  assert.equal(f.urls[0], '/api/add-clip/ab%2Fc');
});

test('waitIngest: the server error, a forgotten job and a done job without a clip reject with a message', async () => {
  await assert.rejects(waitIngest('j', {}, fast(fakeFetch([{body: {status: 'error', error: 'transcode failed: moov atom not found'}}]).fn)), /transcode failed: moov atom not found/);
  await assert.rejects(waitIngest('j', {}, fast(fakeFetch([{body: {status: 'unknown'}}]).fn)), /upload the file again/);
  await assert.rejects(waitIngest('j', {}, fast(fakeFetch([{body: {status: 'done'}}]).fn)), /did not return a clip/);
});

test('waitIngest: a few failed polls (proxy 502, network) are tolerated; too many in a row give up readably', async () => {
  const clip = {id: 'x'};
  const f = fakeFetch([new TypeError('Failed to fetch'), {status: 502, body: {}}, {body: {status: 'running', progress: 5, label: 'Transcoding'}}, new TypeError('Failed to fetch'), {body: {status: 'done', clip}}]);
  assert.deepEqual(await waitIngest('j', {}, fast(f.fn, {maxMisses: 3})), clip);
  const g = fakeFetch([{status: 502, body: {error: 'bad gateway'}}, {status: 502, body: {error: 'bad gateway'}}, {status: 502, body: {error: 'bad gateway'}}]);
  await assert.rejects(waitIngest('j', {}, fast(g.fn, {maxMisses: 3})), /Lost contact with the server .*502 — bad gateway/);
});

test('pendingIngests: remembered across page loads, removed when settled, bad storage ignored', () => {
  const mem = new Map();
  const store = {getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v)};
  const p = pendingIngests(store);
  p.add({jobId: 'a', name: 'a.mp4', size: 1});
  p.add({jobId: 'b', name: 'b.mp4', size: 2});
  p.add({jobId: 'a', name: 'a.mp4', size: 1});
  assert.deepEqual(pendingIngests(store).list().map((x) => x.jobId), ['b', 'a']);
  p.remove('b');
  assert.deepEqual(p.list().map((x) => x.jobId), ['a']);
  mem.set('reel.pendingIngests', '{not json');
  assert.deepEqual(p.list(), []);
  assert.deepEqual(pendingIngests(undefined).list(), []);
});

test('pendingIngests: an upload still going up is kept by its part id, and becomes its job', () => {
  const mem = new Map();
  const p = pendingIngests({getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v)});
  p.add({upload: 'u1', name: 'a.mp4', size: 1});
  p.add({upload: 'u1', jobId: 'j1', name: 'a.mp4', size: 1});
  assert.deepEqual(p.list(), [{upload: 'u1', jobId: 'j1', name: 'a.mp4', size: 1}]);
  p.remove('u1');
  assert.deepEqual(p.list(), []);
});

// ---- chunked, resumable clip uploads (server/uploads.mjs as a fake: the part's bytes in memory) ----
// script(n, put) may answer the n-th PUT itself: 'drop' lands `put.half` bytes and throws like a cut network
function fakeServer({script = () => null, staleFirstGet = false, lostPosts = 0} = {}) {
  const part = [];
  const puts = [];
  const urls = [];
  let gets = 0;
  const res = (status, body) => ({ok: status < 300, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body});
  const fn = async (url, init = {}) => {
    const u = new URL(url, 'http://x');
    urls.push(`${init.method ?? 'GET'} ${u.search}`);
    if (u.pathname.startsWith('/api/uploads/') && !init.method) return res(200, {size: staleFirstGet && !gets++ ? 0 : part.length});
    if (init.method === 'PUT') {
      const offset = +u.searchParams.get('offset');
      const bytes = [...new Uint8Array(await init.body.arrayBuffer())];
      puts.push(offset);
      if (offset !== part.length) return res(409, {error: 'x', code: 'offset_mismatch', size: part.length});
      const a = script(puts.length, bytes);
      if (a === 'drop') { part.push(...bytes.slice(0, 2)); throw new TypeError('Failed to fetch'); }
      if (a) return res(a.status, a.body);
      part.push(...bytes);
      return res(200, {size: part.length});
    }
    if (init.method === 'POST' && u.pathname === '/api/add-clip') {
      puts.push(`add-clip ${u.searchParams}`);
      if (lostPosts-- > 0) throw new TypeError('Failed to fetch'); // the job started, its 202 did not come back
      return res(202, {jobId: 'job-1'});
    }
    if (u.pathname === '/api/add-clip/job-1') return res(200, {status: 'done', clip: {id: 'take', src: 'clips/take.mp4'}});
    return res(404, {error: 'no route'});
  };
  return {fn, part, puts, urls};
}
const bytes = Uint8Array.from({length: 10}, (_, i) => i + 1);
const net = (fetchFn) => ({fetchFn, chunk: 4, backoffMs: 0, everyMs: 0});

test('uploadParts: a slice that landed though its answer was lost (409 offset_mismatch) goes on from the server\'s size', async () => {
  const s = fakeServer({staleFirstGet: true});
  s.part.push(1, 2, 3, 4); // the first slice is there already, the client does not know it yet
  const seen = [];
  await uploadParts(new Blob([bytes]), 'a'.repeat(32), {progress: (n, t) => seen.push(`${n}/${t}`)}, net(s.fn));
  assert.deepEqual(s.puts, [0, 4, 8]);
  assert.deepEqual(s.part, [...bytes]);
  assert.deepEqual(seen, ['0/10', '4/10', '8/10', '10/10']);
});

test('uploadParts: a PUT dropped halfway resumes where the server\'s part ends; a 502 is retried too', async () => {
  const s = fakeServer({script: (n) => (n === 2 ? 'drop' : n === 3 ? {status: 502, body: {}} : null)});
  await uploadParts(new Blob([bytes]), 'b'.repeat(32), {}, net(s.fn));
  assert.deepEqual(s.puts, [0, 4, 6, 6], 'the dropped slice left 2 bytes: it goes on at 6 (and again after the 502)');
  assert.deepEqual(s.part, [...bytes]);
});

test('uploadParts: a part another request is still writing (409 over and over) is waited for, longer each time, and asked again — no storm of slices', async () => {
  const s = fakeServer({script: (n) => (n <= 3 ? {status: 409, body: {error: 'another chunk of this upload is being written', code: 'offset_mismatch', size: 0}} : null)});
  const t0 = Date.now();
  await uploadParts(new Blob([bytes]), 'e'.repeat(32), {}, {...net(s.fn), backoffMs: 20});
  assert.ok(Date.now() - t0 >= 40 + 80 + 160 - 10, `waited ${Date.now() - t0} ms`);
  assert.deepEqual(s.urls.slice(0, 7).map((u) => u.split('&')[0]), ['GET ', 'PUT ?offset=0', 'GET ', 'PUT ?offset=0', 'GET ', 'PUT ?offset=0', 'GET ']);
  assert.ok(s.urls.every((u) => !u.startsWith('PUT') || u.endsWith('&total=10')), 'every slice says the file\'s size (a capped server refuses it at the first)');
  assert.deepEqual(s.part, [...bytes]);
});

test('uploadParts: 507 low_disk and a 4xx stop at once with the server\'s words; a network down for good gives up', async () => {
  const full = fakeServer({script: () => ({status: 507, body: {error: 'not enough free disk for this upload', code: 'low_disk'}})});
  await assert.rejects(uploadParts(new Blob([bytes]), 'c'.repeat(32), {}, net(full.fn)), /^Error: 507 — not enough free disk for this upload$/);
  assert.equal(full.puts.length, 1, 'never retried');
  const big = fakeServer({script: () => ({status: 413, body: {error: 'uploads of at most 2048 MB', code: 'too_large'}})});
  await assert.rejects(uploadParts(new Blob([bytes]), 'c'.repeat(32), {}, net(big.fn)), /413 — uploads of at most 2048 MB/);
  const down = fakeServer({script: () => 'drop'});
  await assert.rejects(uploadParts(new Blob([bytes]), 'd'.repeat(32), {}, {...net(down.fn), retries: 2}), /Network error/);
  assert.equal(down.puts.length, 3);
});

test('uploadClip: the part\'s id from the file, its slices, then add-clip ?upload&async=1 → the job\'s clip', async () => {
  const file = new File([bytes], 'Guion 1.mp4', {lastModified: 1790000000000});
  const id = await uploadId(file);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(id, await uploadId({name: 'Guion 1.mp4', size: 10, lastModified: 1790000000000}), 'the same file after a reload is the same part');
  assert.notEqual(id, await uploadId({name: 'Guion 1.mp4', size: 10, lastModified: 1790000000001}));
  const s = fakeServer();
  const calls = [];
  const clip = await uploadClip(file, {upload: (u) => calls.push(`upload ${u === id}`), uploaded: () => calls.push('uploaded'), job: (j) => calls.push(`job ${j}`)}, net(s.fn));
  assert.deepEqual(clip, {id: 'take', src: 'clips/take.mp4'});
  assert.deepEqual(calls, ['upload true', 'uploaded', 'job job-1']);
  assert.deepEqual(s.puts, [0, 4, 8, `add-clip name=Guion+1.mp4&upload=${id}&size=10&async=1`]);
  // the add-clip answer lost on the way: asked again, the server answers the job it started
  const lost = fakeServer({lostPosts: 1});
  assert.deepEqual(await uploadClip(file, {}, net(lost.fn)), {id: 'take', src: 'clips/take.mp4'});
  assert.equal(lost.puts.filter((p) => String(p).startsWith('add-clip')).length, 2);
});
