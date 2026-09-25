import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fmtMB, isVideoFile, pct, pendingIngests, uploadError, waitIngest} from '../editor/upload.ts';

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
