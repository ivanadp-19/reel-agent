// B-roll contact sheets off the request path (fix 4.5): a batch upload of 18 videos
// made every GET /api/broll-library hang > 20 s while it awaited one ffmpeg pass per
// asset. Now the GET answers `sheet: null` for a missing one and a background job
// makes it (createSheetJobs): one pass per asset at a time, failures retried later.
import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createSheetJobs, sheetFor, withSheets} from '../mcp/broll.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-sheets-'));
after(() => fs.rmSync(tmp, {recursive: true, force: true}));
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return {p, resolve, reject}; };
const tick = () => new Promise((r) => setImmediate(r));

test('the library answers at once with sheet null, and the background pass fills the cache for the next GET', async () => {
  const pub = path.join(tmp, 'public-real'), sheets = path.join(pub, 'broll-assets', 'sheets');
  fs.mkdirSync(path.join(pub, 'broll-assets'), {recursive: true});
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x284:rate=10:duration=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(pub, 'broll-assets', 'city.mp4')]);
  assert.equal(r.status, 0);
  const asset = {id: 'city', src: 'broll-assets/city.mp4', kind: 'video', durationSec: 1, tags: []};
  const jobs = createSheetJobs({publicDir: pub, sheetsDir: sheets, log: () => {}});

  const first = withSheets([asset], jobs); // synchronous: no ffmpeg awaited
  assert.deepEqual(first, [{...asset, sheet: null}]);
  assert.ok(jobs.pending('city'));
  const done = await jobs.kick(asset); // joins the pass the GET started
  assert.equal(done, path.join(sheets, 'city.jpg'));
  assert.ok(fs.statSync(done).size > 0);
  assert.deepEqual(fs.readdirSync(sheets), ['city.jpg']); // the part file was renamed away
  assert.equal(jobs.pending('city'), false);
  assert.deepEqual(withSheets([asset], jobs), [{...asset, sheet: '/broll-assets/sheets/city.jpg'}]);
});

test('a GET waiting on a slow pass is not held: sheet null now, the URL once it finished', async () => {
  const sheets = path.join(tmp, 'public-slow', 'broll-assets', 'sheets');
  const made = new Set(), d = deferred();
  const jobs = createSheetJobs({publicDir: path.join(tmp, 'public-slow'), sheetsDir: sheets, exists: (a) => made.has(a.id), generate: async (a) => { await d.p; made.add(a.id); return a.id; }});
  const a = {id: 'slow', src: 'broll-assets/slow.mp4'};
  assert.equal(withSheets([a], jobs)[0].sheet, null);
  assert.equal(withSheets([a], jobs)[0].sheet, null); // still running: still null, no second pass
  d.resolve();
  await jobs.kick(a);
  assert.equal(withSheets([a], jobs)[0].sheet, '/broll-assets/sheets/slow.jpg');
});

test('concurrent triggers for one asset share one pass; passes over the library run one at a time', async () => {
  const calls = [], gates = {a: deferred(), b: deferred()};
  let running = 0, peak = 0;
  const jobs = createSheetJobs({exists: () => false, generate: async (x) => { calls.push(x.id); running++; peak = Math.max(peak, running); await gates[x.id].p; running--; return `${x.id}.jpg`; }});
  const A = {id: 'a'}, B = {id: 'b'};
  const ps = [jobs.kick(A), jobs.kick(A), jobs.kick(B), jobs.kick(A), jobs.kick(B)];
  withSheets([A, B, A], jobs); // the GET's triggers join too
  await tick();
  assert.deepEqual(calls, ['a']); // b waits for its turn
  gates.a.resolve(); await tick(); await tick();
  assert.deepEqual(calls, ['a', 'b']);
  gates.b.resolve();
  assert.deepEqual(await Promise.all(ps), ['a.jpg', 'a.jpg', 'b.jpg', 'a.jpg', 'b.jpg']);
  assert.equal(peak, 1);
});

test('a failed pass is logged, leaves sheet null, never rejects, and a later trigger retries', async () => {
  let t = 0, n = 0;
  const logs = [], made = new Set();
  const jobs = createSheetJobs({retryAfterMs: 1000, now: () => t, log: (m) => logs.push(m), exists: (a) => made.has(a.id),
    generate: async (a) => { if (++n === 1) throw new Error('contact sheet failed: moov atom not found'); made.add(a.id); return 'ok.jpg'; }});
  const a = {id: 'bad'};
  assert.equal(await jobs.kick(a), null); // resolves null, no rejection
  assert.match(logs[0], /bad: contact sheet failed: moov atom not found/);
  assert.equal(withSheets([a], jobs)[0].sheet, null);
  assert.equal(n, 1); // inside the back-off: no ffmpeg storm from a polling GET
  t = 1500;
  assert.equal(await jobs.kick(a), 'ok.jpg'); // retried, not a cached failure
  assert.equal(n, 2);
  assert.ok(withSheets([a], jobs)[0].sheet);
});

test('a generator that throws synchronously or a log that throws cannot escape as an unhandled rejection', async () => {
  const seen = [];
  const onRej = (e) => seen.push(e);
  process.on('unhandledRejection', onRej);
  try {
    const jobs = createSheetJobs({exists: () => false, retryAfterMs: 0, log: () => { throw new Error('log broke'); }, generate: () => { throw new Error('sync boom'); }});
    withSheets([{id: 'x'}, {id: 'y'}], jobs);
    assert.equal(await jobs.kick({id: 'x'}), null);
    await jobs.kick({id: 'y'});
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seen, []);
  } finally { process.off('unhandledRejection', onRej); }
});

test('sheetFor leaves no sheet (and no part file) when ffmpeg fails, so the next try starts clean', async () => {
  const pub = path.join(tmp, 'public-fail'), sheets = path.join(pub, 'broll-assets', 'sheets');
  fs.mkdirSync(path.join(pub, 'broll-assets'), {recursive: true});
  fs.writeFileSync(path.join(pub, 'broll-assets', 'junk.mp4'), 'not a video');
  await assert.rejects(sheetFor({id: 'junk', src: 'broll-assets/junk.mp4', kind: 'video', durationSec: 2}, {publicDir: pub, sheetsDir: sheets}), /contact sheet failed/);
  assert.deepEqual(fs.readdirSync(sheets), []);
});
