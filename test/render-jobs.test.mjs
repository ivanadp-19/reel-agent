import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {aheadOf, createRenderJobs, descendants, describeJob, killTree, legacyView, listJobs, pidAlive, prune, readJob, writeJob} from '../scripts/render-jobs.mjs';
import {createRenderRunner, etaFor, overall, parseRemotion} from '../scripts/render-runner.mjs';

const tmps = [];
const tmpdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'render-jobs-')); tmps.push(d); return d; };
const kids = [];
after(() => {
  for (const p of kids) try { process.kill(p, 'SIGKILL'); } catch {}
  for (const d of tmps) fs.rmSync(d, {recursive: true, force: true});
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timed out waiting'); await sleep(10); } };
const quiet = () => {};
// a pid that surely is not running any more
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

// Stand-ins for `remotion render` and `scripts/qc.mjs --finalize` (written at test time:
// node --test would run any .mjs under test/ as a test file). The fake render prints the
// same non-TTY progress lines; the props say how it behaves:
// {fake: {mode: 'ok' | 'fail' | 'hang' | 'die', frames, delayMs}}.
const FAKE_RENDER = `import fs from 'node:fs';
const [outFile, propsFile] = process.argv.slice(2);
const {mode = 'ok', frames = 6, delayMs = 5} = JSON.parse(fs.readFileSync(propsFile, 'utf8')).fake ?? {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log('Bundling 50%');
console.log('Bundled code');
for (let i = 1; i <= frames; i++) {
  await sleep(delayMs);
  console.log('Rendered ' + i + '/' + frames + ', time remaining: 1s');
  if (mode === 'die' && i === 2) process.kill(process.pid, 'SIGKILL');
  if (mode === 'fail' && i === 3) { console.error('Error: boom in frame 3'); process.exit(1); }
  if (mode === 'hang' && i === 2) setInterval(() => {}, 1e6);
}
if (mode !== 'hang') { console.log('Encoded ' + frames + '/' + frames); fs.writeFileSync(outFile, 'fake mp4'); }
`;
const FAKE_FINALIZE = `const ok = process.argv[2].indexOf('qcfail-me') < 0;
console.log(JSON.stringify({ok, error: null, checks: ok ? [] : [{name: 'loudness', value: '-20 LUFS', want: '-14 ±1', ok: false, blocking: true}], text: ok ? '✓ fake qc' : '✗ loudness'}));
`;

// a public/ + root with the fakes, a job store and a runner over them
function setup({workers = 1, master = null, record, stallMs, runner} = {}) {
  const root = tmpdir();
  const pub = path.join(root, 'public');
  fs.mkdirSync(path.join(pub, 'exports'), {recursive: true});
  fs.writeFileSync(path.join(root, 'fake-render.mjs'), FAKE_RENDER);
  fs.writeFileSync(path.join(root, 'fake-finalize.mjs'), FAKE_FINALIZE);
  const calls = {render: 0, record: [], updates: []};
  const commands = {
    render: ({outFile, propsFile}) => { calls.render++; return [process.execPath, [path.join(root, 'fake-render.mjs'), outFile, propsFile]]; },
    finalize: ({outFile}) => [process.execPath, [path.join(root, 'fake-finalize.mjs'), outFile]],
  };
  const run = runner ?? createRenderRunner({
    root, publicDir: pub, commands, master, log: quiet,
    record: record ?? (async (o) => { calls.record.push(o); return {v: calls.record.length}; }),
  });
  const dir = path.join(pub, 'render-jobs');
  const spy = (job, ctx) => run(job, {...ctx, props: ctx.props, update: (u) => { calls.updates.push({id: job.id, ...u}); ctx.update(u); }, setPid: ctx.setPid, signal: ctx.signal});
  const jobs = createRenderJobs({dir, run: spy, workers, log: quiet, ...(stallMs ? {stallMs} : {})});
  return {root, pub, dir, jobs, calls};
}
const props = (fake = {}, extra = {}) => JSON.stringify({clips: [{id: 'c0'}], fake, ...extra});

test('remotion progress lines → stage, fraction, frames; one overall 0–100 over the stages', () => {
  assert.deepEqual(parseRemotion('Bundling 45%'), {stage: 'bundling', frac: 0.45});
  assert.deepEqual(parseRemotion('Rendered 120/900, time remaining: 1m 3s'), {stage: 'rendering', frac: 120 / 900, frames: {done: 120, total: 900}});
  assert.equal(parseRemotion('Encoded 900/900').stage, 'encoding');
  assert.equal(parseRemotion('Getting compositions').stage, 'bundling');
  assert.equal(parseRemotion('some chrome log line'), null);
  // stages only move forward, drafts spend more of the bar rendering (no loudness/QC)
  const order = ['preparing', 'bundling', 'rendering', 'encoding', 'finalizing', 'review'];
  for (let i = 1; i < order.length; i++) assert.ok(overall(order[i], 0) >= overall(order[i - 1], 1), order[i]);
  assert.ok(overall('rendering', 1, true) > overall('rendering', 1, false));
  assert.ok(overall('review', 1) < 100, '100 only when done');
  // ETA from the frame rate: 100 of 1000 frames in 10 s → ~90 s of frames left + the tail
  const eta = etaFor({done: 100, total: 1000, sinceFirstFrameSec: 10, draft: true});
  assert.ok(eta >= 90 && eta < 100, String(eta));
  assert.equal(etaFor({done: 0, total: 10, sinceFirstFrameSec: 1}), null);
});

test('submit answers at once with a job id; the job and its props are on disk', async () => {
  const {jobs, dir} = setup();
  const t = Date.now();
  const {job, ahead} = jobs.submit({props: props({frames: 3}), draft: true, projectId: 'p1', expectSec: 2});
  assert.ok(Date.now() - t < 500, 'no waiting for the render');
  assert.match(job.id, /^\d{13}[0-9a-f]{6}$/);
  assert.equal(ahead, 0);
  const onDisk = readJob(dir, job.id);
  assert.equal(onDisk.projectId, 'p1'); assert.equal(onDisk.draft, true);
  assert.ok(['queued', 'running'].includes(onDisk.status));
  await jobs.idle();
  const done = readJob(dir, job.id);
  assert.equal(done.status, 'done'); assert.equal(done.progress, 100);
  assert.equal(done.result.file, `/exports/edited-${job.id}-draft.mp4`);
  assert.ok(fs.existsSync(done.result.path), 'the final file is where the job says');
  assert.ok(!fs.existsSync(path.join(dir, `${job.id}.props.json`)), 'props removed once the job ended');
  assert.ok(!fs.existsSync(path.join(dir, `${job.id}.claim`)));
});

test('progress: stages in order, frames, an ETA, heartbeat and progress timestamps', async () => {
  const {jobs, dir, calls} = setup();
  const {job} = jobs.submit({props: props({frames: 8, delayMs: 15}), draft: false, projectId: 'p1', expectSec: 1});
  // read it from disk mid-render, as another process would
  await until(() => readJob(dir, job.id)?.stage === 'rendering');
  const mid = readJob(dir, job.id);
  assert.equal(mid.status, 'running');
  assert.ok(mid.frames?.total === 8 && mid.progress >= 10 && mid.progress < 100);
  assert.ok(mid.heartbeatAt && mid.progressAt && mid.startedAt);
  assert.ok(Number.isInteger(mid.pid) && mid.pid > 0, 'the render pid is recorded');
  await jobs.idle();
  const stages = [...new Set(calls.updates.map((u) => u.stage))];
  assert.deepEqual(stages, ['preparing', 'bundling', 'rendering', 'encoding', 'finalizing', 'review']);
  const pcts = calls.updates.map((u) => u.progress);
  assert.deepEqual(pcts, [...pcts].sort((a, b) => a - b), 'progress never goes back');
  assert.ok(calls.updates.some((u) => Number.isFinite(u.etaSec)), 'an ETA while rendering');
  const done = readJob(dir, job.id);
  assert.equal(done.status, 'done');
  assert.equal(done.result.qc, '✓ fake qc');
  // registered for review-link: a final of a project → recordFinal with the job id
  assert.equal(done.result.version, 1);
  assert.equal(calls.record[0].projectId, 'p1'); assert.equal(calls.record[0].jobId, job.id); assert.equal(calls.record[0].draft, false);
});

test('jobs survive a restart: queued ones run in order on the next backend', async () => {
  const s = setup();
  // a backend that never starts anything (0 free slots: a foreign running job holds it)
  const blocker = {id: '1000000000000aaaaaa', seq: 1, status: 'running', owner: process.pid, attempts: 1, createdAt: new Date().toISOString()};
  writeJob(s.dir, blocker);
  const a = s.jobs.submit({props: props({frames: 2}), draft: true});
  const b = s.jobs.submit({props: props({frames: 2}), draft: true});
  assert.equal(a.ahead, 1); assert.equal(b.ahead, 2);
  assert.equal(readJob(s.dir, a.job.id).status, 'queued');
  // "restart": the blocker's backend is gone (a dead owner), a new store opens the same dir
  writeJob(s.dir, {...blocker, owner: deadPid(), attempts: 2});
  const order = [];
  const runner = createRenderRunner({root: s.root, publicDir: s.pub, log: quiet, commands: {render: ({outFile, propsFile}) => [process.execPath, [path.join(s.root, 'fake-render.mjs'), outFile, propsFile]]}});
  const next = createRenderJobs({dir: s.dir, workers: 1, log: quiet, run: (job, ctx) => { order.push(job.id); return runner(job, ctx); }});
  next.recover();
  assert.equal(readJob(s.dir, blocker.id).status, 'failed', 'interrupted twice → failed');
  assert.match(readJob(s.dir, blocker.id).error, /interrupted/);
  next.pump();
  await until(() => order.length === 2 && !next.running, 5000);
  await next.idle();
  assert.deepEqual(order, [a.job.id, b.job.id], 'FIFO across the restart');
  assert.equal(readJob(s.dir, b.job.id).status, 'done');
});

test('a job running when its backend died is re-queued (its orphan render killed by pid, never a bystander)', async () => {
  const {dir} = setup();
  const id = '1700000000000abcdef';
  // the render the dead backend left behind: its command line names the job
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', `.props-${id}.json`], {stdio: 'ignore'});
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], {stdio: 'ignore'});
  kids.push(orphan.pid, bystander.pid);
  fs.writeFileSync(path.join(dir, `${id}.props.json`), props());
  fs.writeFileSync(path.join(dir, `${id}.claim`), String(deadPid()));
  writeJob(dir, {id, seq: 5, status: 'running', owner: deadPid(), pid: orphan.pid, attempts: 1, draft: true, createdAt: new Date().toISOString()});
  const killed = [];
  const j2 = createRenderJobs({dir, workers: 1, log: quiet, run: () => new Promise(() => {}), kill: (pid, sig) => { killed.push(pid); try { process.kill(pid, sig); } catch {} return true; }});
  j2.recover();
  assert.deepEqual(killed, [orphan.pid], 'only the process whose command line is this job');
  const r = readJob(dir, id);
  assert.equal(r.status, 'queued'); assert.match(r.label, /restarted/);
  assert.ok(!fs.existsSync(path.join(dir, `${id}.claim`)), 'the dead claim is gone');
  // a pid that is alive but is not this job's render (pid reused) is never killed
  writeJob(dir, {...r, status: 'running', owner: deadPid(), pid: bystander.pid, attempts: 1});
  killed.length = 0;
  j2.recover();
  assert.deepEqual(killed, []);
  assert.ok(pidAlive(bystander.pid));
});

test('serial by default: one render at a time; workers = N runs N', async () => {
  const one = setup();
  let max = 0;
  const spyMax = () => { const n = listJobs(one.dir, {status: 'running'}).length; max = Math.max(max, n); };
  const ids = [1, 2, 3].map(() => one.jobs.submit({props: props({frames: 4, delayMs: 10}), draft: true}).job.id);
  const iv = setInterval(spyMax, 3);
  await until(() => ids.every((id) => readJob(one.dir, id).status === 'done'), 8000);
  clearInterval(iv);
  assert.equal(max, 1);
  assert.equal(one.jobs.workers, 1);
  const two = setup({workers: 2});
  const ids2 = [1, 2, 3].map(() => two.jobs.submit({props: props({frames: 6, delayMs: 20}), draft: true}).job.id);
  await sleep(40);
  assert.equal(listJobs(two.dir, {status: 'running'}).length, 2);
  assert.equal(aheadOf(listJobs(two.dir), ids2[2]), 2);
  await until(() => ids2.every((id) => readJob(two.dir, id).status === 'done'), 8000);
});

test('two backends on one public/ never run the same job twice', async () => {
  const s = setup({workers: 2});
  // another live backend has claimed this job (exclusive create) but not written 'running' yet
  const q = {id: '1800000000000fedcba', seq: 9e15, status: 'queued', attempts: 0, createdAt: new Date().toISOString(), draft: true};
  writeJob(s.dir, q);
  fs.writeFileSync(path.join(s.dir, `${q.id}.props.json`), props());
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], {stdio: 'ignore'});
  kids.push(other.pid);
  fs.writeFileSync(path.join(s.dir, `${q.id}.claim`), String(other.pid));
  s.jobs.pump();
  await sleep(50);
  assert.equal(readJob(s.dir, q.id).status, 'queued', 'claimed elsewhere → not started here');
  assert.equal(s.calls.render, 0);
  // and the claim takes a slot: with workers 2, one more job may start here, not two
  const a = s.jobs.submit({props: props({frames: 3, delayMs: 20}), draft: true}).job;
  const b = s.jobs.submit({props: props({frames: 1}), draft: true}).job;
  await sleep(30);
  assert.equal(readJob(s.dir, a.id).status, 'running');
  assert.equal(readJob(s.dir, b.id).status, 'queued');
  // the other backend dies: its claim is dropped and the job runs here, once
  other.kill('SIGKILL');
  await until(() => !pidAlive(other.pid));
  s.jobs.tick();
  await until(() => [q.id, a.id, b.id].every((id) => readJob(s.dir, id).status === 'done'), 8000);
  assert.equal(s.calls.render, 3);
});

test('cancel: a queued job ends at once; a running one has its process killed and leaves no file', async () => {
  const {jobs, dir} = setup();
  const run = jobs.submit({props: props({mode: 'hang', frames: 5, delayMs: 5}), draft: true}).job;
  const waiting = jobs.submit({props: props(), draft: true}).job;
  assert.equal(readJob(dir, waiting.id).status, 'queued');
  const c1 = jobs.cancel(waiting.id);
  assert.ok(c1.ok); assert.equal(readJob(dir, waiting.id).status, 'cancelled');
  await until(() => readJob(dir, run.id).pid && readJob(dir, run.id).frames?.done >= 2);
  const pid = readJob(dir, run.id).pid;
  assert.ok(pidAlive(pid));
  const c2 = jobs.cancel(run.id);
  assert.ok(c2.ok && c2.pending);
  await jobs.idle();
  const r = readJob(dir, run.id);
  assert.equal(r.status, 'cancelled');
  await until(() => !pidAlive(pid), 7000);
  assert.ok(!fs.existsSync(path.join(path.dirname(dir), 'exports', `edited-${run.id}-draft.mp4`)));
  assert.equal(jobs.cancel(run.id).ok, false, 'already finished');
  assert.match(jobs.cancel('nope123').error, /no render job/);
  assert.equal(legacyView(r).status, 'error');
  assert.match(legacyView(r).error, /cancelled/);
});

test('cancel through the .cancel file (the job runs on another backend): the owner stops it on its next tick', async () => {
  const {jobs, dir} = setup();
  const {job} = jobs.submit({props: props({mode: 'hang', frames: 5}), draft: true});
  await until(() => readJob(dir, job.id).frames?.done >= 2);
  fs.writeFileSync(path.join(dir, `${job.id}.cancel`), new Date().toISOString());
  jobs.tick();
  await jobs.idle();
  assert.equal(readJob(dir, job.id).status, 'cancelled');
});

test('process failure: a render that errors or is killed marks the job failed with the reason', async () => {
  const {jobs, dir} = setup();
  const bad = jobs.submit({props: props({mode: 'fail'}), draft: true}).job;
  const died = jobs.submit({props: props({mode: 'die'}), draft: true}).job;
  await until(() => ['failed', 'done'].includes(readJob(dir, died.id).status), 8000);
  assert.equal(readJob(dir, bad.id).status, 'failed');
  assert.match(readJob(dir, bad.id).error, /boom in frame 3/);
  assert.equal(readJob(dir, died.id).status, 'failed');
  assert.match(readJob(dir, died.id).error, /SIGKILL|exited/);
  assert.equal(legacyView(readJob(dir, died.id)).status, 'error');
});

test('heartbeat: a render process that dies without reporting, or stops making progress, fails the job', async () => {
  const dir = path.join(tmpdir(), 'jobs');
  const gone = deadPid();
  // a runner that lost its child: the pid is dead and nothing settles
  const lost = createRenderJobs({dir, workers: 1, log: quiet, run: (job, ctx) => { ctx.setPid(gone); return new Promise((_, rej) => ctx.signal.addEventListener('abort', () => rej(ctx.signal.reason))); }});
  const {job} = lost.submit({props: props(), draft: true});
  await sleep(10);
  lost.tick(); // first tick: grace (the runner may be reporting the exit right now)
  assert.equal(readJob(dir, job.id).status, 'running');
  lost.tick();
  await lost.idle();
  assert.equal(readJob(dir, job.id).status, 'failed');
  assert.match(readJob(dir, job.id).error, /died without reporting/);

  // a render that hangs: no progress for stallMs → killed and failed
  const dir2 = path.join(tmpdir(), 'jobs');
  const hung = createRenderJobs({dir: dir2, workers: 1, stallMs: 30, log: quiet, run: (job, ctx) => { ctx.setPid(process.pid); return new Promise((_, rej) => ctx.signal.addEventListener('abort', () => rej(ctx.signal.reason))); }});
  const h = hung.submit({props: props(), draft: true}).job;
  hung.tick();
  assert.equal(readJob(dir2, h.id).status, 'running');
  const beat = readJob(dir2, h.id).heartbeatAt;
  await sleep(60);
  hung.tick();
  await hung.idle();
  assert.equal(readJob(dir2, h.id).status, 'failed');
  assert.match(readJob(dir2, h.id).error, /no progress/);
  assert.ok(beat, 'the heartbeat was written while it ran');
});

test('QC failure keeps the file as -qcfail and fails the job; drafts are never recorded as review versions', async () => {
  const {jobs, dir, calls} = setup();
  const fin = jobs.submit({props: props({frames: 2}), draft: false, projectId: null}).job;
  const dr = jobs.submit({props: props({frames: 2}), draft: true, projectId: 'p1'}).job;
  await until(() => readJob(dir, dr.id).status === 'done', 8000);
  assert.equal(readJob(dir, fin.id).status, 'done');
  assert.equal(readJob(dir, fin.id).result.version, undefined, 'a final without a project is not a version');
  assert.equal(calls.record.length, 0, 'drafts never become versions');
  // a failing gate (the fake finalize fails when the file name it gets says so)
  const s2 = setup();
  const failingRunner = createRenderRunner({
    root: s2.root, publicDir: s2.pub, log: quiet,
    commands: {
      render: ({outFile, propsFile}) => [process.execPath, [path.join(s2.root, 'fake-render.mjs'), outFile, propsFile]],
      finalize: ({outFile}) => [process.execPath, [path.join(s2.root, 'fake-finalize.mjs'), outFile + '.qcfail-me']],
    },
  });
  const j3 = createRenderJobs({dir: path.join(s2.pub, 'render-jobs'), log: quiet, run: failingRunner});
  const q = j3.submit({props: props({frames: 2}), draft: false, projectId: 'p1'}).job;
  await j3.idle();
  const r = readJob(j3.dir, q.id);
  assert.equal(r.status, 'failed');
  assert.match(r.error, /QC failed .*loudness/);
  assert.ok(fs.existsSync(path.join(s2.pub, 'exports', `edited-${q.id}-qcfail.mp4`)));
  assert.equal(r.result.qc, '✗ loudness');
});

test('master cache hook: a hit skips the render; a miss renders and offers the master', async () => {
  const cacheDir = tmpdir();
  const cached = path.join(cacheDir, 'master-abc.mp4');
  fs.writeFileSync(cached, 'cached master');
  const seen = {lookups: 0, stored: []};
  const master = {
    lookupMaster: async ({props: p}) => { seen.lookups++; return p.fake?.cached ? {file: cached, key: 'abc'} : null; },
    storeMaster: async ({file}) => { seen.stored.push(fs.readFileSync(file, 'utf8')); },
  };
  const {jobs, dir, calls} = setup({master});
  const hit = jobs.submit({props: props({cached: true}), draft: false, projectId: 'p1'}).job;
  await jobs.idle();
  const h = readJob(dir, hit.id);
  assert.equal(h.status, 'done');
  assert.deepEqual(h.result.master, {hit: true, key: 'abc'});
  assert.equal(calls.render, 0, 'no remotion render on a hit');
  assert.equal(fs.readFileSync(h.result.path, 'utf8'), 'cached master');
  assert.equal(h.result.version, 1, 'a cached final still becomes a review version');
  const miss = jobs.submit({props: props({frames: 2}), draft: true}).job;
  await jobs.idle();
  assert.deepEqual(readJob(dir, miss.id).result.master, {hit: false});
  assert.equal(calls.render, 1);
  assert.deepEqual(seen.stored, ['fake mp4']);
  // a broken cache never fails a render
  const broken = setup({master: {lookupMaster: async () => { throw new Error('disk gone'); }, storeMaster: async () => { throw new Error('nope'); }}});
  const b = broken.jobs.submit({props: props({frames: 1}), draft: true}).job;
  await broken.jobs.idle();
  assert.equal(readJob(broken.dir, b.id).status, 'done');
});

test('prune drops the state of old finished jobs only — never an active job, never an mp4', () => {
  const dir = path.join(tmpdir(), 'jobs');
  const exp = path.join(path.dirname(dir), 'exports');
  fs.mkdirSync(exp, {recursive: true});
  const now = Date.parse('2026-09-25T12:00:00Z');
  const old = new Date(now - 20 * 86400e3).toISOString(), fresh = new Date(now - 86400e3).toISOString();
  writeJob(dir, {id: '1000000000001aaaaaa', seq: 1, status: 'done', createdAt: old, finishedAt: old, result: {file: '/exports/a.mp4'}});
  writeJob(dir, {id: '1000000000002aaaaaa', seq: 2, status: 'failed', createdAt: old, finishedAt: old});
  writeJob(dir, {id: '1000000000003aaaaaa', seq: 3, status: 'done', createdAt: fresh, finishedAt: fresh});
  writeJob(dir, {id: '1000000000004aaaaaa', seq: 4, status: 'queued', createdAt: old});
  fs.writeFileSync(path.join(exp, 'a.mp4'), 'keep me');
  const gone = prune(dir, {days: 14, now});
  assert.deepEqual(gone.sort(), ['1000000000001aaaaaa', '1000000000002aaaaaa']);
  assert.deepEqual(listJobs(dir).map((j) => j.id).sort(), ['1000000000003aaaaaa', '1000000000004aaaaaa']);
  assert.ok(fs.existsSync(path.join(exp, 'a.mp4')));
});

test('the poller view keeps the old /api/render/<id> shape; describeJob reads well', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const base = {id: '1000000000001aaaaaa', seq: 1, draft: false, projectId: 'p1', expectSec: 30, createdAt: new Date(now - 90e3).toISOString()};
  assert.deepEqual(legacyView(null), {status: 'unknown'});
  const q = legacyView({...base, status: 'queued'}, 2);
  assert.equal(q.status, 'running'); assert.equal(q.queued, true); assert.equal(q.label, 'Queued — 2 renders ahead');
  const d = legacyView({...base, status: 'done', result: {file: '/exports/x.mp4', version: 3, qc: 'ok'}});
  assert.equal(d.status, 'done'); assert.equal(d.file, '/exports/x.mp4'); assert.equal(d.version, 3);
  assert.equal(legacyView({...base, status: 'failed', error: 'boom'}).error, 'boom');
  const running = describeJob({...base, status: 'running', progress: 42, label: 'Rendering frame 300/900', frames: {done: 300, total: 900}, etaSec: 95, startedAt: new Date(now - 60e3).toISOString(), heartbeatAt: new Date(now - 2e3).toISOString()}, {now});
  assert.match(running, /RUNNING 42% — Rendering frame 300\/900 · ~1m35s left · running 1m00s/);
  assert.match(describeJob({...base, status: 'running', progress: 5, startedAt: base.createdAt, heartbeatAt: new Date(now - 300e3).toISOString()}, {now}), /no heartbeat for 5m00s/);
  assert.match(describeJob({...base, status: 'done', result: {path: '/abs/x.mp4', renderSec: 200, version: 2}}, {now}), /DONE → \/abs\/x\.mp4 \(3m20s for 30\.0s of video\) · review version v2/);
  assert.match(describeJob({...base, status: 'queued'}, {now, ahead: 1}), /QUEUED — 1 render ahead/);
});

test('between processes (review proxy, copying) the heartbeat does not take the job for dead, nor for stalled', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = setup({stallMs: 20, record: async () => { await gate; return {v: 7}; }});
  const {job} = s.jobs.submit({props: props({frames: 2}), draft: false, projectId: 'p1', expectSec: 1});
  await until(() => readJob(s.dir, job.id)?.stage === 'review', 8000);
  assert.equal(readJob(s.dir, job.id).pid, null, 'the finalize process has exited: no pid to watch');
  for (let i = 0; i < 3; i++) { s.jobs.tick(); await sleep(30); } // longer than the stall limit, three ticks
  assert.equal(readJob(s.dir, job.id).status, 'running');
  release();
  await s.jobs.idle();
  assert.equal(readJob(s.dir, job.id).status, 'done');
  assert.equal(readJob(s.dir, job.id).result.version, 7);
});

test('shutdown kills the renders a stopping backend runs; the next start re-queues them', async () => {
  const s = setup();
  const {job} = s.jobs.submit({props: props({mode: 'hang', frames: 5}), draft: true});
  await until(() => readJob(s.dir, job.id).frames?.done >= 2);
  const pid = readJob(s.dir, job.id).pid;
  s.jobs.shutdown();
  await until(() => !pidAlive(pid), 5000);
  await s.jobs.idle();
  // what a restart finds: still 'running' under the stopped backend (not failed) → re-queued
  const j = readJob(s.dir, job.id);
  assert.equal(j.status, 'running');
  writeJob(s.dir, {...j, owner: deadPid()}); // the stopped backend's pid is gone
  const next = createRenderJobs({dir: s.dir, workers: 1, log: quiet, run: () => new Promise(() => {})});
  next.recover();
  assert.equal(readJob(s.dir, job.id).status, 'queued');
});

test('killTree reaches what runs in another process group below the render (Chrome does)', async () => {
  // a detached parent (its own group) whose child starts a group of its own, like Remotion → Chrome
  const parent = spawn(process.execPath, ['-e', `
    const {spawn} = require('node:child_process');
    const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], {detached: true, stdio: 'ignore'});
    console.log(c.pid); setInterval(() => {}, 1e6);`], {detached: true, stdio: ['ignore', 'pipe', 'ignore']});
  const childPid = await new Promise((r) => parent.stdout.once('data', (d) => r(+String(d).trim())));
  kids.push(parent.pid, childPid);
  assert.ok(descendants(parent.pid).includes(childPid));
  assert.ok(killTree(parent.pid, 'SIGKILL'));
  await until(() => !pidAlive(parent.pid) && !pidAlive(childPid), 5000);
});
