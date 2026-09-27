import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {admitRender, aheadOf, createRenderJobs, descendants, describeJob, fairOrder, killTree, legacyView, listJobs, pidAlive, prune, readJob, writeJob} from '../scripts/render-jobs.mjs';
import {createRenderRunner, etaFor, overall, parseRemotion, planRender} from '../scripts/render-runner.mjs';
import {createMasterCache} from '../scripts/layers.mjs';
import {loadReviews, recordFinal} from '../scripts/reviews.mjs';

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
// {fake: {mode: 'ok' | 'fail' | 'hang' | 'die' | 'gate', frames, delayMs, pngs}}; the caption layer's pass
// (layer: 'captions') writes its folder of \`pngs\` PNG frames (60, the frames the fake probe gives the pair's files).
const FAKE_RENDER = `import fs from 'node:fs';
const [outFile, propsFile] = process.argv.slice(2);
const props = JSON.parse(fs.readFileSync(propsFile, 'utf8'));
const {mode = 'ok', frames = 6, delayMs = 5, pngs = 60} = props.fake ?? {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log('Bundling 50%');
console.log('Bundled code');
for (let i = 1; i <= frames; i++) {
  await sleep(delayMs);
  console.log('Rendered ' + i + '/' + frames + ', time remaining: 1s');
  if (mode === 'die' && i === 2) process.kill(process.pid, 'SIGKILL');
  // like V8 at its heap cap: the fatal message, then abort()
  if (mode === 'heap' && i === 2) { console.error('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'); process.abort(); }
  // like the kernel killing the CLI while Chrome (below it, same group) still holds its stdout
  if (mode === 'orphan' && i === 2) {
    const {spawn} = await import('node:child_process');
    const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], {stdio: ['ignore', 'inherit', 'inherit']});
    fs.writeFileSync(outFile + '.grandchild', String(g.pid));
    process.kill(process.pid, 'SIGKILL');
  }
  // the heap limit a node process below the render gets (npx → remotion is node → node)
  if (mode === 'heapcheck' && i === 1) {
    const {execFileSync} = await import('node:child_process');
    fs.writeFileSync(outFile + '.heap', execFileSync(process.execPath, ['-e', 'console.log(require("v8").getHeapStatistics().heap_size_limit)']).toString());
  }
  if (mode === 'fail' && i === 3) { console.error('Error: boom in frame 3'); process.exit(1); }
  if (mode === 'hang' && i === 2) { fs.writeFileSync(outFile, 'partial'); setInterval(() => {}, 1e6); } // like Remotion: a half-written file, then stuck
  // 'gate': stop after frame 4 until the test writes <outFile>.go (a mid-render state it can read at leisure)
  if (mode === 'gate' && i === 4) while (!fs.existsSync(outFile + '.go')) await sleep(5);
}
if (mode !== 'hang') {
  console.log('Encoded ' + frames + '/' + frames);
  if (props.layer !== 'captions') fs.writeFileSync(outFile, 'fake mp4');
  else { fs.mkdirSync(outFile, {recursive: true}); for (let i = 0; i < pngs; i++) fs.writeFileSync(outFile + '/element-' + String(i).padStart(4, '0') + '.png', 'png ' + i); }
}
`;
// Stand-in for mcp/proof.mjs (the proof lane's child): "still i/n" lines, then the sheet and result.json next to the
// spec; its props say how it behaves: {fake: {mode: 'ok' | 'crash' | 'hang' | 'gate', stills, delayMs}}; 'gate' waits
// after the first still for <spec>.go. The result tells the niceness it ran at.
const FAKE_PROOF = `import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const spec = process.argv[2];
const {what, times, props} = JSON.parse(fs.readFileSync(spec, 'utf8'));
const {mode = 'ok', stills = times?.length ?? 24, delayMs = 5} = props.fake ?? {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 1; i <= stills; i++) {
  await sleep(delayMs);
  console.log('still ' + i + '/' + stills);
  if (mode === 'crash' && i === 2) { console.error('Error: Target closed (the browser crashed)'); process.exit(1); }
  if (mode === 'hang' && i === 2) await new Promise(() => setInterval(() => {}, 1e6));
  if (mode === 'gate' && i === 1) while (!fs.existsSync(spec + '.go')) await sleep(5);
}
const out = path.dirname(spec);
fs.writeFileSync(path.join(out, 'proof-sheet.jpg'), 'jpg');
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({sheet: path.join(out, 'proof-sheet.jpg'), cols: stills, rows: 1, what, nice: os.getPriority()}));
`;
const FAKE_FINALIZE = `const ok = process.argv[2].indexOf('qcfail-me') < 0 && process.argv[3] !== 'fail';
if (process.argv[3] === 'hang') {
  // like qc.mjs normalizing: a half-written .loudnorm.mp4 next to the render, then stuck
  require('node:fs').writeFileSync(process.argv[2].replace(/\\.mp4$/, '.loudnorm.mp4'), 'half');
  console.error('normalizing');
  setInterval(() => {}, 1e6);
} else console.log(JSON.stringify({ok, error: null, checks: ok ? [] : [{name: 'loudness', value: '-20 LUFS', want: '-14 ±1', ok: false, blocking: true}], text: ok ? '✓ fake qc' : '✗ loudness', lufs: ok ? -14.2 : -20, truePeak: -1.6}));
`;

// a public/ + root with the fakes, a job store and a runner over them
// (more: extra command fakes; unrecord null: the runner's own, over the real reviews store)
function setup({workers = 1, masterCache = null, chooseMode, keyOf, record, unrecord, prepare, stallMs, prepareStallMs, finalizeMode = '', runner, memory = () => null, childEnv, owner, more = {}, projects = {}, judge, env, queue = {}} = {}) {
  const root = tmpdir();
  const pub = path.join(root, 'public');
  fs.mkdirSync(path.join(pub, 'exports'), {recursive: true});
  // saved projects (public/projects/<id>.json): the identity a pair is checked against when it is recorded
  fs.mkdirSync(path.join(pub, 'projects'), {recursive: true});
  for (const [id, p] of Object.entries(projects)) fs.writeFileSync(path.join(pub, 'projects', `${id}.json`), JSON.stringify(p));
  fs.writeFileSync(path.join(root, 'fake-render.mjs'), FAKE_RENDER);
  fs.writeFileSync(path.join(root, 'fake-finalize.cjs'), FAKE_FINALIZE);
  fs.writeFileSync(path.join(root, 'fake-proof.mjs'), FAKE_PROOF);
  const calls = {render: 0, master: 0, captions: 0, supers: 0, composite: 0, record: [], updates: [], timing: []};
  const fake = (kind) => ({outFile, propsFile}) => { calls[kind]++; return [process.execPath, [path.join(root, 'fake-render.mjs'), outFile, propsFile]]; };
  const commands = {
    render: fake('render'),
    master: fake('master'),
    captions: fake('captions'),
    supers: fake('supers'),
    // the composite: the master (the fake caption "layer" is a file) copied to the export
    composite: ({master, outFile}) => { calls.composite++; return [process.execPath, ['-e', 'require("fs").copyFileSync(process.argv[1], process.argv[2])', master, outFile]]; },
    finalize: ({outFile}) => [process.execPath, [path.join(root, 'fake-finalize.cjs'), outFile, finalizeMode]],
    proof: ({spec}) => [process.execPath, [path.join(root, 'fake-proof.mjs'), spec]],
    ...more,
  };
  const run = runner ?? createRenderRunner({
    root, publicDir: pub, commands, masterCache, log: quiet, ...(childEnv ? {childEnv} : {}), ...(prepare ? {prepare} : {}), ...(chooseMode ? {chooseMode} : {}), ...(keyOf ? {keyOf} : {}), ...(judge ? {judge} : {}), ...(env ? {env} : {}),
    logStage: (project, stage, ms, extra) => calls.timing.push({project, stage, ms, ...extra}),
    record: record ?? (async (o) => { calls.record.push(o); return {v: calls.record.length}; }),
    ...(unrecord === null ? {} : {unrecord: unrecord ?? ((r) => { calls.unrecord = [...(calls.unrecord ?? []), r]; })}),
  });
  const dir = path.join(pub, 'render-jobs');
  const spy = (job, ctx) => run(job, {...ctx, props: ctx.props, update: (u) => { calls.updates.push({id: job.id, ...u}); ctx.update(u); }, setPid: ctx.setPid, signal: ctx.signal});
  const jobs = createRenderJobs({dir, run: spy, abandon: run.abandon, workers, log: quiet, memory, ...(owner ? {owner} : {}), ...(stallMs ? {stallMs} : {}), ...(prepareStallMs ? {prepareStallMs} : {}), ...queue});
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
  const {job} = jobs.submit({props: props({frames: 8, delayMs: 15, mode: 'gate'}), draft: false, projectId: 'p1', expectSec: 1});
  // read it from disk mid-render, as another process would (the fake render waits at frame 4)
  await until(() => readJob(dir, job.id)?.frames?.done === 4, 10000);
  const mid = readJob(dir, job.id);
  assert.equal(mid.stage, 'rendering');
  assert.equal(mid.status, 'running');
  assert.ok(mid.frames?.total === 8 && mid.progress >= 10 && mid.progress < 100);
  assert.ok(mid.heartbeatAt && mid.progressAt && mid.startedAt);
  assert.ok(Number.isInteger(mid.pid) && mid.pid > 0, 'the render pid is recorded');
  await sleep(20); // frames 5–8 come later than the first one: the ETA has a rate to work from
  fs.writeFileSync(path.join(path.dirname(dir), 'exports', `edited-${job.id}.mp4.go`), '');
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
      finalize: ({outFile}) => [process.execPath, [path.join(s2.root, 'fake-finalize.cjs'), outFile + '.qcfail-me']],
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

// ---- layered renders (#17): the queue and the master cache together ----
// the mode as asked; captions per props.fake.captions (default on); the master key from props.fake.key
const layered = (over = {}) => {
  const cacheDir = tmpdir();
  return {
    masterCache: createMasterCache(cacheDir),
    chooseMode: (requested, p) => ({mode: requested, reasons: [], captions: p.fake?.captions !== false, ...(p.fake?.blocked ? {mode: 'full', reasons: [p.fake.blocked]} : {})}),
    keyOf: (p, {draft}) => `k-${p.fake?.key ?? 'same'}-${draft ? 'd' : 'f'}`,
    cacheDir,
    ...over,
  };
};

test('layers: the master is rendered once, cached, and the next render of the reel only redoes the caption layer', async () => {
  const L = layered();
  const s = setup(L);
  const first = s.jobs.submit({props: props({frames: 2}), draft: false, projectId: 'p1', mode: 'layers'}).job;
  await s.jobs.idle();
  const a = readJob(s.dir, first.id);
  assert.equal(a.status, 'done');
  assert.equal(a.mode, 'layers');
  assert.deepEqual([a.result.mode, a.result.master], ['layers', 'rendered']);
  assert.ok(['master', 'captions', 'composite', 'qc'].every((k) => k in a.result.stages), JSON.stringify(a.result.stages));
  assert.deepEqual(fs.readdirSync(L.cacheDir), ['k-same-f.mp4'], 'the complete master is in the cache, no .part');
  assert.deepEqual([s.calls.master, s.calls.captions, s.calls.composite, s.calls.render], [1, 1, 1, 0]);
  const second = s.jobs.submit({props: props({frames: 2}), draft: false, projectId: 'p1', mode: 'layers'}).job;
  await s.jobs.idle();
  const b = readJob(s.dir, second.id);
  assert.equal(b.result.master, 'cached');
  assert.equal(s.calls.master, 1, 'no second master render');
  assert.equal(s.calls.captions, 2);
  // every stage in the project's timing log (drafts too, the finals here)
  const stages = s.calls.timing.filter((t) => t.job === second.id).map((t) => t.stage);
  assert.deepEqual(stages, ['captions', 'composite', 'qc']);
  assert.ok(s.calls.timing.every((t) => t.project === 'p1'));
  assert.equal(b.result.version, 2, 'a layered final is a review version like any other');
});

test('layers with 2 workers: two jobs needing one master render it once (single flight), the other waits for it', async () => {
  const L = layered();
  const s = setup({...L, workers: 2});
  const a = s.jobs.submit({props: props({frames: 6, delayMs: 20}), draft: true, mode: 'layers'}).job;
  const b = s.jobs.submit({props: props({frames: 6, delayMs: 20}), draft: true, mode: 'layers'}).job;
  await until(() => [a.id, b.id].every((id) => ['done', 'failed'].includes(readJob(s.dir, id).status)), 8000);
  assert.deepEqual([readJob(s.dir, a.id).status, readJob(s.dir, b.id).status], ['done', 'done']);
  assert.equal(s.calls.master, 1);
  assert.deepEqual([readJob(s.dir, a.id).result.master, readJob(s.dir, b.id).result.master].sort(), ['cached', 'rendered']);
  assert.ok(s.calls.updates.some((u) => /Waiting for the same master/.test(u.label ?? '')));
});

test('layers: a master cancelled mid-pass never enters the cache and leaves no .part; the next job renders it', async () => {
  const L = layered();
  const s = setup(L);
  const {job} = s.jobs.submit({props: props({mode: 'hang', frames: 5}), draft: true, mode: 'layers'});
  await until(() => readJob(s.dir, job.id).frames?.done >= 2);
  assert.match(readJob(s.dir, job.id).label, /master/);
  assert.ok(fs.readdirSync(L.cacheDir).some((f) => f.includes('.part-')), 'the master is written as .part');
  s.jobs.cancel(job.id);
  await s.jobs.idle();
  assert.equal(readJob(s.dir, job.id).status, 'cancelled');
  assert.deepEqual(fs.readdirSync(L.cacheDir), [], 'nothing cached, no .part');
  assert.deepEqual(exportsOf(s), []);
  const next = s.jobs.submit({props: props({frames: 1}), draft: true, mode: 'layers'}).job;
  await s.jobs.idle();
  assert.equal(readJob(s.dir, next.id).result.master, 'rendered');
});

test('layers falls back to full when the captions reach into the footage, and says why; no captions → the master is the reel', async () => {
  const L = layered();
  const s = setup(L);
  const blocked = s.jobs.submit({props: props({frames: 1, blocked: 'hero punch on key words'}), draft: true, mode: 'layers'}).job;
  await s.jobs.idle();
  const r = readJob(s.dir, blocked.id).result;
  assert.equal(r.mode, 'full');
  assert.deepEqual(r.fallback, ['hero punch on key words']);
  assert.deepEqual([s.calls.render, s.calls.master], [1, 0]);
  assert.match(describeJob(readJob(s.dir, blocked.id)), /\[full\] \(layers → full: hero punch on key words\)/);
  const bare = s.jobs.submit({props: props({frames: 1, captions: false, key: 'bare'}), draft: true, mode: 'layers'}).job;
  await s.jobs.idle();
  const r2 = readJob(s.dir, bare.id).result;
  assert.deepEqual([r2.mode, r2.master], ['layers', 'rendered']);
  assert.equal(s.calls.captions + s.calls.composite, 0);
  assert.equal(fs.readFileSync(r2.path, 'utf8'), 'fake mp4');
  // full by default: a job that names no mode renders in one pass
  const plain = s.jobs.submit({props: props({frames: 1}), draft: true}).job;
  await s.jobs.idle();
  assert.equal(readJob(s.dir, plain.id).result.mode, 'full');
});

// ---- the delivered pair: a final of a project with an identity (master + ProRes caption layer in reviews/<id>/v<n>/) ----
const IDENTITY = {client: 'acme', family: 'acme-G2', script: 2, variant: {hook: 1, cta: 1}};
// a pair job's props as the backend queues them: the delivery fps on them (src/renderProps.ts withDeliveryFps)
const pairProps = (fake, extra = {}) => props(fake, {fps: 30000 / 1001, ...extra});
const nodeE = (code, ...args) => [process.execPath, ['-e', code, ...args]];
// layered() + the pair's ffmpeg / ffprobe steps as fakes: encode writes the .mov, remux the master
// (P.hang: it stalls half-written), probe reports P.frames per file name, else per extension; frameStats finds nothing to repair
// (P.rate: the r_frame_rate it reports — a client's files come out at 29.97; P.fps: the rate each ffmpeg step was given;
// P.size: the width x height per file name, else 1080x1920)
const paired = () => {
  const P = {frames: {mp4: 60, mov: 60}, alpha: [], remux: [], hang: false, rate: '30000/1001', fps: [], size: {}};
  const more = {
    encode: ({outFile, alpha, fps}) => { P.alpha.push(alpha); P.fps.push(['encode', fps]); return nodeE('require("fs").writeFileSync(process.argv[1], "prores 4444")', outFile); },
    remux: ({video, audio, outFile}) => {
      P.remux.push({video, audio, held: fs.existsSync(video)});
      return P.hang ? nodeE('require("fs").writeFileSync(process.argv[1], "half"); setInterval(() => {}, 1e6)', outFile) : nodeE('require("fs").copyFileSync(process.argv[1], process.argv[2])', video, outFile);
    },
    probe: ({file}) => { const n = P.frames[path.basename(file)] ?? P.frames[path.extname(file).slice(1)]; const [a, b = 1] = P.rate.split('/').map(Number); const [w, h] = P.size[path.basename(file)] ?? [1080, 1920]; return nodeE(`console.log(JSON.stringify({streams: [{nb_frames: '${n}', r_frame_rate: '${P.rate}', duration: '${(n * b) / a}', width: ${w}, height: ${h}}]}))`); },
    frameStats: () => nodeE(''),
  };
  return {...layered(), more, P, projects: {p1: {name: 'one', identity: IDENTITY}}};
};
// the real recordFinal → recordVersion, its 720p proxy faked; seen: what record got, and whether the pair was on disk then
const recording = (seen) => async (o) => {
  seen.push({...o, onDisk: Object.values(o.deliverables ?? {}).map((f) => fs.existsSync(f))});
  return recordFinal({...o, makeProxy: async (input, proxy, poster) => { fs.copyFileSync(input, proxy); fs.writeFileSync(poster, 'jpg'); return {durationSec: 2}; }});
};
const filesUnder = (d) => (fs.existsSync(d) ? fs.readdirSync(d, {recursive: true}).filter((f) => fs.statSync(path.join(d, f)).isFile()).sort() : []);

test('a client\'s version is recorded with its qc (loudness as the gate measured it, the frames and rate of the pair) and "QC técnico en curso"; the judge then starts on it and the job is done without waiting (CEO-6)', async () => {
  const L = paired();
  const judged = [];
  let pub;
  // a judge that never answers: the job must be done anyway
  const s = setup({...L, record: recording([]), unrecord: null, judge: (x) => { judged.push({...x, label: loadReviews(path.join(pub, 'reviews'), x.projectId).versions.find((y) => y.v === x.v)?.judge?.label}); return new Promise(() => {}); }});
  pub = s.pub;
  const {job} = s.jobs.submit({props: pairProps({frames: 2}), draft: false, projectId: 'p1', identity: IDENTITY});
  await s.jobs.idle();
  const j = readJob(s.dir, job.id);
  assert.equal(j.status, 'done', j.error);
  assert.deepEqual(judged, [{projectId: 'p1', v: 1, label: 'en curso'}], 'started once, on the version already recorded');
  const v = loadReviews(path.join(pub, 'reviews'), 'p1').versions[0];
  assert.deepEqual(v.qc, {lufs: -14.2, truePeak: -1.6, parity: {frames: 60, fps: '30000/1001'}});
  assert.equal(v.masterKey, 'k-same-f');
  assert.equal(v.judge.label, 'en curso');
  // R-2: a final of a project without identity — a version as before, never judged by the queue
  const plain = s.jobs.submit({props: props({frames: 1}), draft: false, projectId: 'p2'}).job;
  await s.jobs.idle();
  assert.equal(readJob(s.dir, plain.id).status, 'done');
  const p2 = loadReviews(path.join(pub, 'reviews'), 'p2').versions[0];
  assert.ok(p2 && !('judge' in p2) && !('qc' in p2));
  assert.equal(judged.length, 1);
});

test('the pair: a layered final of a project with an identity leaves master + ProRes captions in reviews/<id>/v1/ under system names, with the snapshot; no text graphic → no supers, no master_supers, and the version says so', async () => {
  const L = paired();
  const seen = [];
  const s = setup({...L, record: recording(seen), unrecord: null});
  const {job} = s.jobs.submit({props: pairProps({frames: 2}), draft: false, projectId: 'p1', identity: IDENTITY}); // no mode: the pair forces layers
  await s.jobs.idle();
  const j = readJob(s.dir, job.id);
  assert.equal(j.status, 'done', j.error);
  assert.deepEqual(j.identity, IDENTITY, 'the job carries it (a re-queue keeps it)');
  assert.equal(j.result.mode, 'layers');
  assert.deepEqual(L.P.alpha, ['prores'], 'captions: ProRes 4444 although this backend composites PNG frames');
  assert.deepEqual([s.calls.master, s.calls.supers, s.calls.captions, s.calls.composite], [1, 0, 1, 1], 'no text graphic: no supers pass, no master_supers composite');
  assert.equal(L.P.remux.length, 1);
  assert.match(path.basename(L.P.remux[0].video), /^k-same-f\.part-pair-/, 'the cached master, held by its own link');
  assert.ok(L.P.remux[0].held);
  assert.equal(L.P.remux[0].audio, path.join(s.pub, 'exports', `edited-${job.id}.mp4`), 'the audio of the composite that passed loudness + QC');
  assert.deepEqual(seen[0].onDisk, [true, true, true], 'record gets the three files on disk');
  const v1 = path.join(s.pub, 'reviews', 'p1', 'v1');
  assert.deepEqual(fs.readdirSync(v1).sort(), ['ACME_G2_H1_C1_v1_captions.mov', 'ACME_G2_H1_C1_v1_captions.png.zip', 'ACME_G2_H1_C1_v1_master.mp4', 'project.json']);
  const v = loadReviews(path.join(s.pub, 'reviews'), 'p1').versions[0];
  assert.deepEqual(v.deliverables, {master: 'reviews/p1/v1/ACME_G2_H1_C1_v1_master.mp4', captions: 'reviews/p1/v1/ACME_G2_H1_C1_v1_captions.mov', captionsPng: 'reviews/p1/v1/ACME_G2_H1_C1_v1_captions.png.zip'});
  assert.deepEqual(Object.keys(v.omitted), ['supers', 'masterSupers'], 'the version names what it left out, and why');
  assert.match(v.omitted.supers, /no tiene gráficos de texto/);
  assert.deepEqual(v.identity, IDENTITY);
  assert.equal(v.snapshot, 'reviews/p1/v1/project.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.pub, v.snapshot), 'utf8')), JSON.parse(pairProps({frames: 2})), 'the props that were rendered');
  assert.equal(fs.readFileSync(path.join(s.pub, v.deliverables.captions), 'utf8'), 'prores 4444');
  assert.equal(fs.readFileSync(path.join(s.pub, v.deliverables.master), 'utf8'), 'fake mp4', 'the master\'s picture');
  assert.deepEqual(j.result.deliverables, v.deliverables);
  assert.equal(j.result.version, 1);
  assert.deepEqual(fs.readdirSync(path.join(s.pub, 'reviews', 'p1')).filter((f) => f.startsWith('.')), [], 'no temp of the pair left');
  assert.deepEqual(fs.readdirSync(L.cacheDir), ['k-same-f.mp4'], 'the master stays cached, its hold is gone');
  assert.ok(fs.existsSync(path.join(s.pub, 'exports', `edited-${job.id}.mp4.json`)), 'the composite is a final like any other');
});

// ---- captions only on the client's finished export: its own file is the master (Felipe, 2026-09-26) ----
// a project that asks for captions alone, over one whole untouched source that is on disk (public/clips/orig.mp4)
const origReel = (clip = {}) => ({clips: [{id: 'c0', src: 'clips/orig.mp4', inSec: 0, outSec: 2, sourceDurationSec: 2, ...clip}]});
const captionsOnly = (frames) => {
  const L = paired();
  L.projects.p1 = {name: 'one', identity: IDENTITY, scope: ['captions']};
  L.P.frames['orig.mp4'] = frames;
  const X = {composites: []};
  L.more.composite = ({master, layers, outFile}) => { X.composites.push({master: path.basename(master), layers: layers.length, out: path.basename(outFile)}); return nodeE('require("fs").copyFileSync(process.argv[1], process.argv[2])', master, outFile); };
  return {L, X};
};
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('captions only on the client\'s export: its own file is the master — no master pass, no remux, no supers; hard-linked into v1/, byte for byte, recorded as original', async () => {
  const {L, X} = captionsOnly(60); // 2 s at 29.97 = 60 frames, the caption layer's
  const seen = [];
  const s = setup({...L, record: recording(seen), unrecord: null});
  fs.mkdirSync(path.join(s.pub, 'clips'), {recursive: true});
  const orig = path.join(s.pub, 'clips', 'orig.mp4');
  fs.writeFileSync(orig, crypto.randomBytes(4096)); // César's export, as it came
  const {job} = s.jobs.submit({props: pairProps({frames: 2}, origReel()), draft: false, projectId: 'p1', identity: IDENTITY});
  await s.jobs.idle();
  const j = readJob(s.dir, job.id);
  assert.equal(j.status, 'done', j.error);
  assert.deepEqual([j.result.master, s.calls.master, s.calls.supers, s.calls.captions, L.P.remux.length], ['original', 0, 0, 1, 0], 'only the caption layer is rendered');
  assert.deepEqual(X.composites, [{master: 'orig.mp4', layers: 1, out: `edited-${job.id}.mp4`}], 'the export (and its proxy): the client\'s file + the captions');
  const v = loadReviews(path.join(s.pub, 'reviews'), 'p1').versions[0];
  const master = path.join(s.pub, v.deliverables.master);
  assert.deepEqual(Object.keys(v.deliverables), ['master', 'captions', 'captionsPng']);
  assert.equal(sha(master), sha(orig), 'byte for byte the client\'s file');
  assert.equal(fs.statSync(master).ino, fs.statSync(orig).ino, 'a hard link, not a copy');
  assert.deepEqual(v.original, {src: 'clips/orig.mp4', sha256: sha(orig), bytes: 4096});
  assert.ok(!('masterKey' in v) && !('audioHash' in v), 'no cached master behind it');
  assert.deepEqual(Object.keys(v.omitted), ['supers', 'masterSupers']);
  assert.deepEqual(fs.readdirSync(L.cacheDir), [], 'nothing rendered, nothing cached');
  // the plan says so before the job is queued
  const plan = planRender(JSON.parse(pairProps({}, origReel())), {pair: true, scope: ['captions'], masterCache: null, publicDir: s.pub, root: s.root});
  assert.deepEqual([plan.mode, plan.full, plan.master, !!plan.fails], ['layers', false, 'original', false]);
  assert.equal(planRender(JSON.parse(pairProps({}, origReel())), {pair: true, scope: ['captions', 'corte'], masterCache: null, publicDir: s.pub, root: s.root}).fails, true, 'another scope needs the rendered master');
});

test('captions only, but the file does not lay under the layer frame for frame, is not 1080x1920, or the clip is trimmed / outside public/clips: the master is rendered as always, and the job says why', async () => {
  for (const [frames, clip, why, size] of [[59, {}, /not the master: clips\/orig\.mp4 is 59 frames at 30000\/1001, the caption layer 60/], [60, {outSec: 1.5}, null],
    [60, {}, /not the master: clips\/orig\.mp4 is 720x1280, the composition 1080x1920/, [720, 1280]], [60, {src: '../../etc/orig.mp4'}, null]]) {
    const {L} = captionsOnly(frames);
    if (size) L.P.size['orig.mp4'] = size;
    const s = setup({...L, record: recording([]), unrecord: null});
    fs.mkdirSync(path.join(s.pub, 'clips'), {recursive: true});
    fs.writeFileSync(path.join(s.pub, 'clips', 'orig.mp4'), 'orig');
    const {job} = s.jobs.submit({props: pairProps({frames: 2}, origReel(clip)), draft: false, projectId: 'p1', identity: IDENTITY});
    await s.jobs.idle();
    const j = readJob(s.dir, job.id);
    assert.equal(j.status, 'done', j.error);
    assert.deepEqual([j.result.master, s.calls.master, L.P.remux.length], ['rendered', 1, 1]);
    if (why) assert.match(j.result.original, why); else assert.equal(j.result.original, undefined, 'a trimmed clip (or a path out of clips/) is not an original: nothing to say');
    const v = loadReviews(path.join(s.pub, 'reviews'), 'p1').versions[0];
    assert.ok(!v.original && v.masterKey);
  }
});

test('an unchanged master (same cached master, same final audio): the earlier version\'s file hard-linked, no remux; other audio → a remux of its own', async () => {
  const L = paired();
  let audio = 'a';
  L.more.audioHash = () => nodeE(`console.log('SHA256=' + process.argv[1].repeat(64))`, audio);
  const s = setup({...L, record: recording([]), unrecord: null});
  const run = async () => { const {job} = s.jobs.submit({props: pairProps({frames: 2}), draft: false, projectId: 'p1', identity: IDENTITY}); await s.jobs.idle(); return readJob(s.dir, job.id); };
  const j1 = await run(), j2 = await run();
  audio = 'b';
  const j3 = await run();
  assert.deepEqual([j1.status, j2.status, j3.status], ['done', 'done', 'done']);
  assert.equal(L.P.remux.length, 2, 'v2 remuxed nothing');
  const [v1, v2, v3] = loadReviews(path.join(s.pub, 'reviews'), 'p1').versions;
  const ino = (x) => fs.statSync(path.join(s.pub, x.deliverables.master)).ino;
  assert.equal(ino(v2), ino(v1), 'v2\'s master is v1\'s file');
  assert.equal(L.P.remux.at(-1).audio, path.join(s.pub, 'exports', `edited-${j3.id}.mp4`), 'other final audio: v3 remuxed its own');
  assert.deepEqual([v1.audioHash, v2.audioHash, v3.audioHash], ['a'.repeat(64), 'a'.repeat(64), 'b'.repeat(64)]);
  assert.equal(j2.result.masterLinked, v1.deliverables.master);
});

test('the pair never falls back to full: captions the layer cannot carry, or no master cache, fail the job with the reasons and record nothing', async () => {
  const seen = [];
  const L = paired();
  const s = setup({...L, record: recording(seen)});
  const blocked = s.jobs.submit({props: pairProps({frames: 1, blocked: 'hero punch: the pack scales the footage on its tier-2 words'}), draft: false, projectId: 'p1', identity: IDENTITY}).job;
  await s.jobs.idle();
  const j = readJob(s.dir, blocked.id);
  assert.equal(j.status, 'failed');
  assert.match(j.error, /deliverables need the layered render: hero punch: the pack scales the footage/);
  assert.deepEqual([s.calls.render, s.calls.master, s.calls.captions, seen.length], [0, 0, 0, 0]);
  const s2 = setup({...paired(), masterCache: null, record: recording(seen)});
  const noCache = s2.jobs.submit({props: pairProps({frames: 1}), draft: false, projectId: 'p1', identity: IDENTITY}).job;
  await s2.jobs.idle();
  assert.match(readJob(s2.dir, noCache.id).error, /deliverables need the layered render: no master cache/);
  assert.equal(s2.calls.render, 0);
  for (const x of [s, s2]) assert.deepEqual([filesUnder(path.join(x.pub, 'reviews')), exportsOf(x)], [[], []]);
});

test('the pair: a master and a caption layer that differ in frames fail the job — no version, no file of the pair; the render is kept as qcfail', async () => {
  const seen = [];
  const L = paired();
  L.P.frames.mov = 59;
  const s = setup({...L, record: recording(seen)});
  const {job} = s.jobs.submit({props: pairProps({frames: 2}), draft: false, projectId: 'p1', identity: IDENTITY});
  await s.jobs.idle();
  const j = readJob(s.dir, job.id);
  assert.equal(j.status, 'failed');
  assert.match(j.error, /no deliverables, no version: deliverables parity failed: frames: master 60, captions 59/);
  assert.equal(seen.length, 0, 'never recorded');
  assert.deepEqual(filesUnder(path.join(s.pub, 'reviews')), []);
  assert.deepEqual(fs.readdirSync(L.cacheDir), ['k-same-f.mp4']);
  assert.deepEqual(exportsOf(s).sort(), [`edited-${job.id}-qcfail.mp4`, `edited-${job.id}-qcfail.mp4.json`], 'never an unrecorded final');
});

test('the pair: a QC failure leaves nothing under reviews/', async () => {
  const seen = [];
  const L = paired();
  const s = setup({...L, record: recording(seen), finalizeMode: 'fail'});
  const {job} = s.jobs.submit({props: pairProps({frames: 2}), draft: false, projectId: 'p1', identity: IDENTITY});
  await s.jobs.idle();
  assert.match(readJob(s.dir, job.id).error, /QC failed/);
  assert.deepEqual([seen.length, L.P.remux.length], [0, 0]);
  assert.deepEqual(filesUnder(path.join(s.pub, 'reviews')), []);
  assert.deepEqual(fs.readdirSync(L.cacheDir), ['k-same-f.mp4']);
});

test('the pair: a cancel halfway (the remux) or after the version was recorded leaves no file of the pair and no version', async () => {
  const L = paired();
  L.P.hang = true;
  const seen = [];
  const s = setup({...L, record: recording(seen), unrecord: null});
  const {job} = s.jobs.submit({props: pairProps({frames: 2}), draft: false, projectId: 'p1', identity: IDENTITY});
  await until(() => filesUnder(path.join(s.pub, 'reviews')).some((f) => f.endsWith('master.mp4')), 5000);
  assert.deepEqual(filesUnder(path.join(s.pub, 'reviews')).map((f) => path.basename(f)), ['captions.mov', 'captions.png.zip', 'master.mp4'], 'mid-remux: the pair in its temp');
  s.jobs.cancel(job.id);
  await s.jobs.idle();
  assert.equal(readJob(s.dir, job.id).status, 'cancelled');
  assert.deepEqual([filesUnder(path.join(s.pub, 'reviews')), exportsOf(s), seen.length], [[], [], 0]);
  assert.deepEqual(fs.readdirSync(L.cacheDir), ['k-same-f.mp4']);
  // cancelled while the version is being recorded: the runner's own unrecord takes it back, v1/ included
  let release;
  const gate = new Promise((r) => { release = r; });
  const L2 = paired();
  const s2 = setup({...L2, record: async (o) => { const v = await recording(seen)(o); await gate; return v; }, unrecord: null});
  const late = s2.jobs.submit({props: pairProps({frames: 2}), draft: false, projectId: 'p1', identity: IDENTITY}).job;
  await until(() => fs.existsSync(path.join(s2.pub, 'reviews', 'p1', 'v1', 'project.json')), 5000);
  s2.jobs.cancel(late.id);
  release();
  await s2.jobs.idle();
  const j = readJob(s2.dir, late.id);
  assert.equal(j.status, 'cancelled');
  assert.equal(j.result, undefined);
  assert.deepEqual(loadReviews(path.join(s2.pub, 'reviews'), 'p1').versions, []);
  assert.deepEqual(filesUnder(path.join(s2.pub, 'reviews')), ['p1.json'], 'proxy, poster and v1/ gone');
  assert.deepEqual(exportsOf(s2), []);
});

test('the pair: an identity changed or cleared while the render ran records nothing under the old names (another project may hold them now)', async () => {
  for (const now of [{...IDENTITY, variant: {hook: 2, cta: 1}}, null]) {
    const seen = [];
    const L = paired();
    const s = setup({...L, record: recording(seen), unrecord: null});
    const {job} = s.jobs.submit({props: pairProps({frames: 2}), draft: false, projectId: 'p1', identity: IDENTITY});
    fs.writeFileSync(path.join(s.pub, 'projects', 'p1.json'), JSON.stringify({name: 'one', identity: now})); // set_identity / clear meanwhile
    await s.jobs.idle();
    const j = readJob(s.dir, job.id);
    assert.equal(j.status, 'failed');
    assert.match(j.error, /no deliverables, no version: the project's identity changed during the render/);
    assert.equal(seen.length, 1, 'refused in the reviews row, when the version would be numbered');
    assert.deepEqual(loadReviews(path.join(s.pub, 'reviews'), 'p1').versions, []);
    assert.deepEqual(filesUnder(path.join(s.pub, 'reviews')), [], 'no pair, no proxy, no temp');
    assert.deepEqual(fs.readdirSync(L.cacheDir), ['k-same-f.mp4']);
    assert.deepEqual(exportsOf(s).sort(), [`edited-${job.id}-qcfail.mp4`, `edited-${job.id}-qcfail.mp4.json`]);
  }
});

test('the pair: what a dead backend left (layer, remuxed master, proxy temps, held master) goes when recover() or a cancel ends the job', () => {
  const L = paired();
  const s = setup(L);
  const [failed, cancelled, requeued, other] = ['1700000000000aaaaaa', '1700000000000bbbbbb', '1700000000000cccccc', '1700000000000dddddd'];
  const leftovers = (id) => [
    path.join(s.pub, 'reviews', 'p1', `.tmp-pair-${id}`, 'captions.mov'), path.join(s.pub, 'reviews', 'p1', `.tmp-pair-${id}`, 'master.mp4'),
    path.join(s.pub, 'reviews', 'p1', `.tmp-pair-${id}`, 'supers.mov'), path.join(s.pub, 'reviews', 'p1', `.tmp-pair-${id}`, 'master_supers.mp4'),
    path.join(s.pub, 'reviews', 'p1', `.tmp-${id}.mp4`), path.join(s.pub, 'reviews', 'p1', `.tmp-${id}.jpg`),
    path.join(L.cacheDir, `k-same-f.part-pair-${id}.mp4`), path.join(L.cacheDir, `k-same-f.part-${id}.mp4`),
  ];
  for (const id of [failed, cancelled, requeued, other]) for (const f of leftovers(id)) { fs.mkdirSync(path.dirname(f), {recursive: true}); fs.writeFileSync(f, 'GBs'); }
  fs.writeFileSync(path.join(L.cacheDir, 'k-same-f.mp4'), 'cached');
  const job = (id, attempts) => {
    writeJob(s.dir, {id, seq: +id.slice(0, 13), status: 'running', owner: deadPid(), attempts, draft: false, projectId: 'p1', identity: IDENTITY, createdAt: new Date().toISOString()});
    fs.writeFileSync(path.join(s.dir, `${id}.props.json`), props());
  };
  job(failed, 2); // interrupted twice → failed
  job(cancelled, 1); fs.writeFileSync(path.join(s.dir, `${cancelled}.cancel`), 'x'); // a cancel asked while its backend was down
  job(requeued, 1); // re-queued: its next run takes its temps over
  s.jobs.recover();
  assert.deepEqual([failed, cancelled, requeued].map((id) => readJob(s.dir, id).status), ['failed', 'cancelled', 'queued']);
  const left = (id) => leftovers(id).filter((f) => fs.existsSync(f)).length;
  assert.deepEqual([left(failed), left(cancelled), left(requeued), left(other)], [0, 0, 8, 8], 'only the jobs that ended');
  assert.ok(!fs.existsSync(path.join(s.pub, 'reviews', 'p1', `.tmp-pair-${failed}`)), 'the temp folder itself');
  // the re-queued one cancelled before it runs again: its leftovers go too
  assert.equal(s.jobs.cancel(requeued).ok, true);
  assert.equal(left(requeued), 0);
  assert.equal(left(other), 8, 'a job this store never ended is not touched');
  assert.ok(fs.existsSync(path.join(L.cacheDir, 'k-same-f.mp4')), 'the cached master stays');
});

// a backend killed by SIGTERM exits before the job's finally: a re-queued pair job finds its .tmp-pair-<id>/ as it was left,
// its master.mp4 a hard link to an earlier version's master or to the client's clip — never written through (ffmpeg -y
// truncates the inode in place)
test('the pair: a re-queued job never writes into a hard link its first attempt left (an earlier version\'s master, the client\'s clip)', async () => {
  const L = paired();
  L.more.remux = ({outFile}) => { L.P.remux.push(outFile); return nodeE('require("fs").writeFileSync(process.argv[1], "REMUXED")', outFile); }; // like ffmpeg -y: O_TRUNC in place
  const s = setup({...L, record: recording([]), unrecord: null});
  fs.mkdirSync(path.join(s.pub, 'clips'), {recursive: true});
  const victim = path.join(s.pub, 'clips', 'orig.mp4');
  fs.writeFileSync(victim, 'CLIENT BYTES'); // César's export (or v1's delivered master): bytes that must never change
  const id = '1700000000000aaaaaa', tmp = path.join(s.pub, 'reviews', 'p1', `.tmp-pair-${id}`);
  fs.mkdirSync(tmp, {recursive: true});
  fs.linkSync(victim, path.join(tmp, 'master.mp4')); // what attempt 1 linked (captions only) before its backend died
  writeJob(s.dir, {id, seq: +id.slice(0, 13), status: 'running', owner: deadPid(), attempts: 1, draft: false, projectId: 'p1', identity: IDENTITY, createdAt: new Date().toISOString()});
  fs.writeFileSync(path.join(s.dir, `${id}.props.json`), pairProps({frames: 2}, origReel()));
  s.jobs.recover(); // re-queued; the scope is no longer captions only: this attempt renders the master and remuxes it
  s.jobs.pump();
  await s.jobs.idle();
  assert.equal(readJob(s.dir, id).status, 'done', readJob(s.dir, id).error);
  assert.equal(L.P.remux.length, 1);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'CLIENT BYTES', 'the linked file is untouched');
  const v = loadReviews(path.join(s.pub, 'reviews'), 'p1').versions[0];
  assert.equal(fs.readFileSync(path.join(s.pub, v.deliverables.master), 'utf8'), 'REMUXED', 'the version has its own master');
});

test('R-2: a draft with an identity, a layered final and a full final without one render exactly as before', async () => {
  const L = paired();
  const s = setup(L);
  const d = s.jobs.submit({props: pairProps({frames: 1}), draft: true, projectId: 'p1', identity: IDENTITY}).job;
  const f = s.jobs.submit({props: props({frames: 1}), draft: false, projectId: 'p1', mode: 'layers'}).job;
  const full = s.jobs.submit({props: props({frames: 1}), draft: false, projectId: 'p1'}).job;
  await s.jobs.idle();
  const [rd, rf, rfull] = [d, f, full].map((x) => readJob(s.dir, x.id));
  assert.deepEqual([rd.status, rf.status, rfull.status], ['done', 'done', 'done']);
  assert.deepEqual([rd.result.mode, rf.result.mode, rfull.result.mode], ['full', 'layers', 'full'], 'a draft is never forced to layers');
  assert.deepEqual([L.P.alpha, L.P.remux, s.calls.supers], [[], [], 0], 'no supers pass, no ProRes encode, no remux, no probe');
  assert.ok(!('identity' in rf) && !('identity' in rfull), 'no identity field on a job without one');
  assert.ok([rd, rf, rfull].every((x) => !('deliverables' in x.result)));
  assert.equal(s.calls.record.length, 2, 'the two finals, as always');
  for (const o of s.calls.record) assert.deepEqual(Object.keys(o).sort(), ['dir', 'draft', 'jobId', 'outFile', 'projectId', 'publicDir', 'qcOk', 'signal']);
  assert.deepEqual(fs.readdirSync(L.cacheDir), ['k-same-f.mp4']);
});

// frame 0 flat, frame 1 footage (scripts/first-frame.mjs parseStats): every guarded file gets repaired
const BLANK_LEAD = ['frame:0', ...['YMIN=25', 'YMAX=25', 'YAVG=25', 'UAVG=128', 'VAVG=128'].map((x) => `lavfi.signalstats.${x}`), 'frame:1', ...['YMIN=10', 'YMAX=200', 'YAVG=90', 'UAVG=120', 'VAVG=140'].map((x) => `lavfi.signalstats.${x}`)].join('\n');
const at2997 = () => {
  const L = paired();
  Object.assign(L.more, {
    frameStats: () => nodeE('console.log(process.argv[1])', BLANK_LEAD),
    fixFirstFrame: ({file, outFile, fps}) => { L.P.fps.push(['fixFirstFrame', fps]); return nodeE('require("fs").copyFileSync(process.argv[1], process.argv[2])', file, outFile); },
    composite: ({master, outFile, fps}) => { L.P.fps.push(['composite', fps]); return nodeE('require("fs").copyFileSync(process.argv[1], process.argv[2])', master, outFile); },
  });
  return L;
};

test('29.97: a client\'s final (props.fps 30000/1001, set by the backend) encodes, composites, repairs and checks parity at that rate; without fps, all at 30', async () => {
  const L = at2997();
  const seen = [];
  const s = setup({...L, record: recording(seen), unrecord: null});
  const {job} = s.jobs.submit({props: props({frames: 2}, {fps: 30000 / 1001}), draft: false, projectId: 'p1', identity: IDENTITY});
  await s.jobs.idle();
  const j = readJob(s.dir, job.id);
  assert.equal(j.status, 'done', j.error);
  assert.deepEqual([...new Set(L.P.fps.map(([k]) => k))].sort(), ['composite', 'encode', 'fixFirstFrame'], 'every ffmpeg step ran');
  assert.ok(L.P.fps.every(([, fps]) => fps === 30000 / 1001), JSON.stringify(L.P.fps));
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.pub, 'reviews', 'p1', 'v1', 'project.json'), 'utf8')).fps, 30000 / 1001, 'the snapshot says the rate');
  // R-2: the same reel of a project without identity
  const R = at2997();
  const s2 = setup(R);
  const plain = s2.jobs.submit({props: props({frames: 2}), draft: false, projectId: 'p1', mode: 'layers'}).job;
  await s2.jobs.idle();
  assert.equal(readJob(s2.dir, plain.id).status, 'done');
  assert.ok(R.P.fps.length && R.P.fps.every(([, fps]) => fps === 30), JSON.stringify(R.P.fps));
});

test('29.97: a pair that comes out at 30 fails its parity against the delivery rate — no version, no file of the pair', async () => {
  // the files report 30/1: rendered at 30 although the props asked 29.97, or a job queued without the rate (before it existed)
  for (const extra of [{fps: 30000 / 1001}, {}]) {
    const L = paired();
    L.P.rate = '30/1';
    const seen = [];
    const s = setup({...L, record: recording(seen)});
    const {job} = s.jobs.submit({props: props({frames: 2}, extra), draft: false, projectId: 'p1', identity: IDENTITY});
    await s.jobs.idle();
    const j = readJob(s.dir, job.id);
    assert.equal(j.status, 'failed');
    assert.match(j.error, /deliverables parity failed: fps: 30\/1, want 30000\/1001/);
    assert.equal(seen.length, 0);
    assert.deepEqual(filesUnder(path.join(s.pub, 'reviews')), []);
  }
});

// ---- the supers: a client's text graphics as their own layer (master without text, master_supers) ----
// a reel whose clip carries a text graphic (a stat with a camera punch) and a decor one (a sticker)
const gfxReel = (over = {}) => ({
  clips: [{id: 'c0', src: 'clips/a.mp4', inSec: 0, outSec: 2, sourceDurationSec: 10}],
  graphics: [
    {id: 'g1', src: 'clips/a.mp4', startMs: 0, endMs: 1000, template: 'stat', props: {value: '3', label: 'rooms'}, camera: 'punch', ...over},
    {id: 'g2', src: 'clips/a.mp4', startMs: 200, endMs: 900, template: 'sticker', props: {src: 'assets/x.png'}},
  ],
});
// paired() whose passes keep the props they were given, whose key says whether the master has text, and whose composites are logged
const supersPaired = () => {
  const L = paired();
  const X = {passes: {}, keys: [], composites: []};
  const pass = (kind) => ({outFile, propsFile}) => { X.passes[kind] = JSON.parse(fs.readFileSync(propsFile, 'utf8')); return [process.execPath, [path.join(path.dirname(propsFile), 'fake-render.mjs'), outFile, propsFile]]; };
  Object.assign(L.more, {
    master: pass('master'), supers: pass('supers'), captions: pass('captions'),
    composite: ({master, layers, outFile}) => {
      X.composites.push({master: path.basename(master), layers: layers.map((l) => [path.basename(l.file).replace(/-\w+$/, '-<id>'), l.alpha ?? 'png']), out: path.basename(outFile)});
      return nodeE('require("fs").copyFileSync(process.argv[1], process.argv[2])', master, outFile);
    },
  });
  L.keyOf = (p, {draft}) => { X.keys.push(p); return `k-${p.textOff ? 'textoff' : 'text'}-${draft ? 'd' : 'f'}`; };
  return {L, X};
};

test('supers: a client\'s reel with a text graphic — a text-free master under its own key, the text graphics in a pass of their own, the export stacks master + supers + captions, master_supers = master + supers', async () => {
  const {L, X} = supersPaired();
  const seen = [];
  const s = setup({...L, record: recording(seen), unrecord: null});
  const {job} = s.jobs.submit({props: pairProps({}, gfxReel()), draft: false, projectId: 'p1', identity: IDENTITY});
  await s.jobs.idle();
  const j = readJob(s.dir, job.id);
  assert.equal(j.status, 'done', j.error);
  assert.deepEqual([X.passes.master.textOff, X.passes.master.captionsOff, X.passes.master.layer], [true, true, undefined], 'the master: no caption, no text graphic');
  assert.deepEqual([X.passes.supers.layer, X.passes.supers.textOff], ['supers', undefined]);
  assert.equal(X.passes.captions.layer, 'captions');
  assert.ok(X.keys.length && X.keys.every((p) => p.textOff === true), 'the master key is the text-free master\'s');
  assert.deepEqual(fs.readdirSync(L.cacheDir), ['k-textoff-f.mp4'], 'cached under its own key, never a master with text');
  assert.deepEqual(X.composites, [
    {master: 'k-textoff-f.mp4', layers: [['supers.mov', 'prores'], ['captions.mov', 'prores']], out: `edited-${job.id}.mp4`},
    {master: 'master.mp4', layers: [['supers.mov', 'prores']], out: 'master_supers.mp4'},
  ], 'the export: master, supers, captions bottom to top; master_supers: the remuxed master (final audio) + supers');
  assert.deepEqual(L.P.alpha, ['prores', 'prores']);
  assert.deepEqual(fs.readdirSync(path.join(s.pub, 'reviews', 'p1', 'v1')).sort(), ['ACME_G2_H1_C1_v1_captions.mov', 'ACME_G2_H1_C1_v1_captions.png.zip', 'ACME_G2_H1_C1_v1_master.mp4', 'ACME_G2_H1_C1_v1_master_supers.mp4', 'ACME_G2_H1_C1_v1_supers.mov', 'project.json']);
  assert.deepEqual(Object.keys(j.result.deliverables), ['master', 'captions', 'captionsPng', 'supers', 'masterSupers']);
  assert.ok(['supers', 'supers-encode', 'captions-png', 'pair'].every((k) => k in j.result.stages), JSON.stringify(j.result.stages));
  assert.ok(!fs.existsSync(path.join(os.tmpdir(), `reel-supers-${job.id}`)), 'the supers frames are gone');
  // R-2: the same reel without identity — the master keeps its text and its key, no supers pass, one composite
  const {L: R, X: Y} = supersPaired();
  const s2 = setup(R);
  const plain = s2.jobs.submit({props: props({}, gfxReel()), draft: false, projectId: 'p1', mode: 'layers'}).job;
  await s2.jobs.idle();
  assert.equal(readJob(s2.dir, plain.id).status, 'done');
  assert.deepEqual([Y.passes.master.textOff, Y.passes.supers, s2.calls.supers], [undefined, undefined, 0]);
  assert.ok(Y.keys.every((p) => !('textOff' in p)));
  assert.deepEqual(fs.readdirSync(R.cacheDir), ['k-text-f.mp4']);
  assert.deepEqual(Y.composites, [{master: 'k-text-f.mp4', layers: [['reel-captions-<id>', 'png']], out: `edited-${plain.id}.mp4`}]);
});

test('supers: a text graphic behind the presenter fails a client\'s final with the reason (it cannot be its own layer); decor behind, or no identity, renders', async () => {
  const seen = [];
  const L = paired();
  const s = setup({...L, chooseMode: undefined, record: recording(seen)}); // the runner's own chooseRenderMode
  const behind = s.jobs.submit({props: pairProps({frames: 1}, gfxReel({behind: true})), draft: false, projectId: 'p1', identity: IDENTITY}).job;
  await s.jobs.idle();
  const j = readJob(s.dir, behind.id);
  assert.equal(j.status, 'failed');
  assert.match(j.error, /deliverables need the layered render: text graphic behind the presenter: stat g1/);
  assert.deepEqual([s.calls.master, s.calls.supers, seen.length, filesUnder(path.join(s.pub, 'reviews'))], [0, 0, 0, []]);
  // the sticker behind: decor stays in the master, nothing to split
  const decor = gfxReel();
  decor.graphics[1].behind = true;
  const ok = s.jobs.submit({props: pairProps({frames: 1}, decor), draft: false, projectId: 'p1', identity: IDENTITY}).job;
  // a project without identity: the text graphic behind is drawn in its master as always
  const plain = s.jobs.submit({props: props({frames: 1}, gfxReel({behind: true})), draft: false, projectId: 'p1', mode: 'layers'}).job;
  await s.jobs.idle();
  assert.equal(readJob(s.dir, ok.id).status, 'done', readJob(s.dir, ok.id).error);
  assert.deepEqual([readJob(s.dir, plain.id).status, readJob(s.dir, plain.id).result.mode], ['done', 'layers']);
});

test('supers: a supers layer or master_supers off by a frame, or a supers pass that fails, leaves no file of the four and no version', async () => {
  for (const spoil of [(L) => { L.P.frames['supers.mov'] = 59; }, (L) => { L.P.frames['master_supers.mp4'] = 61; }, (L) => { L.more.supers = () => nodeE('process.exit(3)'); }]) {
    const seen = [];
    const {L} = supersPaired();
    spoil(L);
    const s = setup({...L, record: recording(seen)});
    const {job} = s.jobs.submit({props: pairProps({}, gfxReel()), draft: false, projectId: 'p1', identity: IDENTITY});
    await s.jobs.idle();
    const j = readJob(s.dir, job.id);
    assert.equal(j.status, 'failed');
    assert.match(j.error, /deliverables parity failed: frames: master 60, supers 59|deliverables parity failed: frames: master 60, master_supers 61|render exited 3/);
    assert.equal(seen.length, 0);
    assert.deepEqual(filesUnder(path.join(s.pub, 'reviews')), [], 'no file of the four, no temp');
    assert.ok(!fs.existsSync(path.join(os.tmpdir(), `reel-supers-${job.id}`)));
  }
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

// ---- preparing: a hung download / bake must not hold the (serial) queue ----
// a prepare that hangs and ignores its signal — the worst case the runner must survive
const hungPrepare = (seen) => (raw, id, {signal}) => { seen.signal = signal; return new Promise(() => {}); };
const exportsOf = (s) => fs.readdirSync(path.join(s.pub, 'exports'));

test('cancel while preparing: the job ends at once even if the step ignores its signal, and the queue moves on', async () => {
  const seen = {};
  let calls = 0;
  const s = setup({prepare: (raw, id, ctx) => (++calls === 1 ? hungPrepare(seen)(raw, id, ctx) : raw)});
  const stuck = s.jobs.submit({props: props(), draft: true}).job;
  const next = s.jobs.submit({props: props({frames: 1}), draft: true}).job;
  await until(() => readJob(s.dir, stuck.id).stage === 'preparing');
  assert.equal(readJob(s.dir, next.id).status, 'queued', 'serial: the next one waits');
  assert.ok(s.jobs.cancel(stuck.id).ok);
  await until(() => readJob(s.dir, stuck.id).status === 'cancelled', 2000);
  assert.ok(seen.signal.aborted, 'prepare got the job signal (downloads and bakes stop on it)');
  await until(() => readJob(s.dir, next.id).status === 'done', 5000);
});

test('a download stuck in preparing is caught by its own stall limit (the render limit does not apply there)', async () => {
  const seen = {};
  let calls = 0;
  const s = setup({stallMs: 60e3, prepareStallMs: 30, prepare: (raw, id, ctx) => (++calls === 1 ? hungPrepare(seen)(raw, id, ctx) : raw)});
  const stuck = s.jobs.submit({props: props(), draft: true}).job;
  const next = s.jobs.submit({props: props({frames: 1}), draft: true}).job;
  await until(() => readJob(s.dir, stuck.id).stage === 'preparing');
  await sleep(60);
  s.jobs.tick();
  await until(() => readJob(s.dir, stuck.id).status === 'failed', 2000);
  assert.match(readJob(s.dir, stuck.id).error, /no progress .*stage preparing/);
  assert.ok(seen.signal.aborted);
  await until(() => readJob(s.dir, next.id).status === 'done', 5000);
});

test('a slow download that keeps reporting (per MB) is not taken for stalled', async () => {
  const s = setup({prepareStallMs: 40, prepare: async (raw, id, {progress}) => {
    for (let mb = 1; mb <= 8; mb++) { await sleep(15); progress(0.1, `Downloading B-roll 1/1 · ${mb} MB`); }
    return raw;
  }});
  const {job} = s.jobs.submit({props: props({frames: 1}), draft: true});
  for (let i = 0; i < 6; i++) { await sleep(20); s.jobs.tick(); }
  await s.jobs.idle();
  assert.equal(readJob(s.dir, job.id).status, 'done');
  assert.ok(s.calls.updates.some((u) => /· 8 MB/.test(u.label ?? '')), 'the MB count reaches the job');
});

// ---- cancel after the render: no half file, no review version ----
test('cancel during finalizing: the render and finalize\'s half .loudnorm.mp4 are removed; nothing is recorded', async () => {
  const s = setup({finalizeMode: 'hang'});
  const {job} = s.jobs.submit({props: props({frames: 2}), draft: false, projectId: 'p1'});
  await until(() => exportsOf(s).some((f) => f.endsWith('.loudnorm.mp4')), 5000);
  assert.equal(readJob(s.dir, job.id).stage, 'finalizing');
  s.jobs.cancel(job.id);
  await s.jobs.idle();
  assert.equal(readJob(s.dir, job.id).status, 'cancelled');
  assert.deepEqual(exportsOf(s).filter((f) => f.includes(job.id)), [], 'no file of the job is left');
  assert.equal(s.calls.record.length, 0, 'no review version');
});

test('cancel while the review version is being recorded: the version is taken back', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = setup({record: async (o) => { s.calls.record.push(o); await gate; return {v: 4}; }});
  const {job} = s.jobs.submit({props: props({frames: 2}), draft: false, projectId: 'p1'});
  await until(() => readJob(s.dir, job.id).stage === 'review', 5000);
  assert.ok(s.calls.record[0].signal, 'record gets the job signal (the proxy ffmpeg stops on it)');
  s.jobs.cancel(job.id);
  release(); // the recording finishes after the cancel came in
  await s.jobs.idle();
  const j = readJob(s.dir, job.id);
  assert.equal(j.status, 'cancelled');
  assert.equal(j.result, undefined, 'no version on a cancelled job');
  assert.deepEqual(s.calls.unrecord, [{projectId: 'p1', v: 4}]);
  assert.deepEqual(exportsOf(s).filter((f) => f.includes(job.id)), []);
});

test('render records: every settled job leaves <mp4>.json with its project and kind (final, draft, qcfail); a cancel leaves none', async () => {
  const s = setup();
  const ex = path.join(s.pub, 'exports');
  const rec = (name) => JSON.parse(fs.readFileSync(path.join(ex, `${name}.json`), 'utf8'));
  const fin = s.jobs.submit({props: props({frames: 2}), draft: false, projectId: 'p1'}).job;
  const dr = s.jobs.submit({props: props({frames: 2}), draft: true, projectId: 'p1'}).job;
  const loose = s.jobs.submit({props: props({frames: 2}), draft: false, projectId: null}).job;
  await s.jobs.idle();
  assert.deepEqual([rec(`edited-${fin.id}.mp4`).projectId, rec(`edited-${fin.id}.mp4`).kind], ['p1', 'final']);
  assert.equal(typeof rec(`edited-${fin.id}.mp4`).renderSec, 'number');
  assert.deepEqual([rec(`edited-${dr.id}-draft.mp4`).projectId, rec(`edited-${dr.id}-draft.mp4`).kind], ['p1', 'draft']);
  assert.deepEqual([rec(`edited-${loose.id}.mp4`).projectId, rec(`edited-${loose.id}.mp4`).kind], [null, 'final']);
  // QC failure: the record follows the renamed file
  const s2 = setup();
  const failing = createRenderRunner({
    root: s2.root, publicDir: s2.pub, log: quiet,
    commands: {
      render: ({outFile, propsFile}) => [process.execPath, [path.join(s2.root, 'fake-render.mjs'), outFile, propsFile]],
      finalize: ({outFile}) => [process.execPath, [path.join(s2.root, 'fake-finalize.cjs'), outFile + '.qcfail-me']],
    },
  });
  const j2 = createRenderJobs({dir: path.join(s2.pub, 'render-jobs'), log: quiet, run: failing});
  const q = j2.submit({props: props({frames: 2}), draft: false, projectId: 'p2'}).job;
  await j2.idle();
  const qr = JSON.parse(fs.readFileSync(path.join(s2.pub, 'exports', `edited-${q.id}-qcfail.mp4.json`), 'utf8'));
  assert.deepEqual([qr.projectId, qr.kind], ['p2', 'qcfail']);
  assert.ok(!fs.existsSync(path.join(s2.pub, 'exports', `edited-${q.id}.mp4.json`)));
  // a cancelled job: no record either
  const s3 = setup();
  const c = s3.jobs.submit({props: props({mode: 'gate', frames: 6, delayMs: 2}), draft: true, projectId: 'p1'}).job;
  await until(() => readJob(s3.dir, c.id).frames?.done >= 4);
  s3.jobs.cancel(c.id);
  await s3.jobs.idle();
  assert.deepEqual(exportsOf(s3).filter((f) => f.includes(c.id)), []);
});

// ---- the memory guard (scripts/render-memory.mjs) ----
test('OOM: a render killed by SIGKILL or aborted at its heap cap fails as out of memory, and the queue goes on', async () => {
  const {jobs, dir} = setup();
  const killed = jobs.submit({props: props({mode: 'die'}), draft: true}).job;
  const heap = jobs.submit({props: props({mode: 'heap'}), draft: true}).job;
  const after = jobs.submit({props: props({frames: 2}), draft: true}).job;
  await until(() => readJob(dir, after.id).status === 'done', 8000);
  for (const [j, why] of [[killed, /SIGKILL/], [heap, /heap limit/]]) {
    const k = readJob(dir, j.id);
    assert.equal(k.status, 'failed');
    assert.equal(k.errorCode, 'OOM');
    assert.equal(k.label, 'Failed — out of memory');
    assert.match(k.error, /^out of memory/);
    assert.match(k.error, why);
    assert.equal(legacyView(k).status, 'error');
  }
});

test('OOM: a render that dies while something below it holds its pipes open still settles, its group killed', async () => {
  const {jobs, dir, pub} = setup();
  const {job} = jobs.submit({props: props({mode: 'orphan', frames: 5}), draft: true});
  await until(() => readJob(dir, job.id).status === 'failed', 8000);
  assert.match(readJob(dir, job.id).error, /out of memory.*SIGKILL/);
  const g = +fs.readFileSync(path.join(pub, 'exports', `edited-${job.id}-draft.mp4.grandchild`), 'utf8');
  kids.push(g);
  await until(() => !pidAlive(g), 3000);
});

test('the heap cap reaches the node processes below the render (npx → remotion)', async () => {
  const {jobs, dir, pub} = setup({childEnv: {...process.env, NODE_OPTIONS: '--max-old-space-size=300'}});
  const {job} = jobs.submit({props: props({mode: 'heapcheck', frames: 1}), draft: true});
  await until(() => readJob(dir, job.id).status === 'done', 8000);
  const limit = +fs.readFileSync(path.join(pub, 'exports', `edited-${job.id}-draft.mp4.heap`), 'utf8') / 2 ** 20;
  assert.ok(limit > 250 && limit < 600, `heap limit ${limit} MB`); // the old space cap + the young generation (~200 MB)
});

test('pre-flight memory: below the floor a queued job waits (and says so), then starts when memory is back', async () => {
  let avail = 900;
  const s = setup({memory: () => avail});
  const {job} = s.jobs.submit({props: props({frames: 1}), draft: true});
  const behind = s.jobs.submit({props: props({frames: 1}), draft: true}).job;
  await sleep(30);
  s.jobs.tick();
  let j = readJob(s.dir, job.id);
  assert.equal(j.status, 'queued');
  assert.equal(s.calls.render, 0);
  assert.equal(j.memoryWait.availMb, 900);
  assert.equal(j.memoryWait.needMb, 2560);
  assert.equal(j.memoryWait.checks, 3); // at each submit and on the tick
  assert.match(j.label, /waiting for memory \(900 MB available, needs 2560 MB\)/);
  assert.match(legacyView(j).label, /waiting for memory/);
  assert.match(describeJob(j), /waiting for memory/);
  assert.equal(readJob(s.dir, behind.id).memoryWait, undefined, 'FIFO: only the head of the queue is checked');
  avail = 8000;
  s.jobs.tick();
  await until(() => [job.id, behind.id].every((id) => readJob(s.dir, id).status === 'done'), 8000);
  j = readJob(s.dir, job.id);
  assert.equal(j.memoryWait, undefined);
  assert.equal(j.memoryWaited.checks, 3);
  // not measured (macOS) → no floor
  const m = setup({memory: () => null});
  const free = m.jobs.submit({props: props({frames: 1}), draft: true}).job;
  await until(() => readJob(m.dir, free.id).status === 'done', 8000);
});

test('global render lock: a slot held by another live backend blocks a start; stale slots are taken over; a job gives its slot back', async () => {
  const s = setup();
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], {stdio: 'ignore'});
  kids.push(other.pid);
  // the other backend took the slot for a job it is starting: claimed, still 'queued' on disk
  const theirs = {id: '1800000000000abcdef', seq: 1, status: 'queued', attempts: 0, createdAt: new Date().toISOString(), draft: true};
  writeJob(s.dir, theirs);
  fs.writeFileSync(path.join(s.dir, `${theirs.id}.claim`), String(other.pid));
  fs.writeFileSync(path.join(s.dir, `${theirs.id}.props.json`), props());
  const slot = path.join(s.dir, '.slot-0.lock');
  fs.writeFileSync(slot, JSON.stringify({owner: other.pid, job: theirs.id}));
  const mine = s.jobs.submit({props: props({frames: 1}), draft: true}).job;
  await sleep(40);
  assert.equal(readJob(s.dir, mine.id).status, 'queued');
  assert.equal(s.calls.render, 0);
  // their job ends (on disk) but the slot file stays behind: stale, taken over
  writeJob(s.dir, {...theirs, status: 'done'});
  fs.rmSync(path.join(s.dir, `${theirs.id}.claim`));
  s.jobs.tick();
  await until(() => readJob(s.dir, mine.id).status === 'done', 8000);
  assert.ok(!fs.existsSync(slot), 'the slot is given back when the job settles');
  // a slot of a dead backend is stale too
  fs.writeFileSync(slot, JSON.stringify({owner: deadPid(), job: mine.id}));
  const next = s.jobs.submit({props: props({frames: 1}), draft: true}).job;
  await until(() => readJob(s.dir, next.id).status === 'done', 8000);
});

test('global render lock: two backends on one public/ never render at the same time', async () => {
  const a = setup();
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], {stdio: 'ignore'});
  kids.push(other.pid);
  // backend B: same store, its own owner id (a live pid), its own runner
  const b = createRenderJobs({dir: a.dir, run: (job, ctx) => createRenderRunner({root: a.root, publicDir: a.pub, log: quiet, commands: {render: ({outFile, propsFile}) => [process.execPath, [path.join(a.root, 'fake-render.mjs'), outFile, propsFile]]}})(job, ctx), workers: 1, owner: other.pid, log: quiet, memory: () => null});
  const ids = [];
  for (let i = 0; i < 3; i++) { ids.push(a.jobs.submit({props: props({frames: 3, delayMs: 10}), draft: true}).job.id); ids.push(b.submit({props: props({frames: 3, delayMs: 10}), draft: true}).job.id); }
  let max = 0;
  const iv = setInterval(() => { a.jobs.tick(); b.tick(); max = Math.max(max, listJobs(a.dir, {status: 'running'}).length, a.jobs.running + b.running); }, 2);
  await until(() => ids.every((id) => readJob(a.dir, id).status === 'done'), 15000);
  clearInterval(iv);
  assert.equal(max, 1);
});

test('a final records the data its graphics show that its own audio does not say (datosPorConfirmar, CEO-21)', async () => {
  const s = setup({projects: {p1: {lang: 'es'}}});
  fs.mkdirSync(path.join(s.pub, 'clips', 'transcripts'), {recursive: true});
  fs.writeFileSync(path.join(s.pub, 'clips', 'transcripts', 'toma.es.json'), JSON.stringify([{word: 'Tiene', startMs: 0, endMs: 300}, {word: '3', startMs: 350, endMs: 600}, {word: 'recámaras.', startMs: 650, endMs: 1200}]));
  const clips = [{id: 'c0', src: 'clips/toma.mp4', inSec: 0, outSec: 4, sourceDurationSec: 4}];
  const g = (id, value) => ({id, src: 'clips/toma.mp4', startMs: 400, endMs: 2000, template: 'stat', props: {value, label: 'recámaras'}});
  s.jobs.submit({props: props({}, {clips, graphics: [g('g0', '3'), g('g1', '4')]}), draft: false, projectId: 'p1', expectSec: 1});
  await s.jobs.idle();
  assert.deepEqual(s.calls.record[0].datosPorConfirmar, [{graphic: 'g1', dato: '4', src: 'toma', atSec: 0.4}]);
});

test('datosPorConfirmar reads the transcript with the env it is given (the backend: its ROOT .env + process env, as validate does)', async () => {
  const s = setup({projects: {p1: {lang: 'es'}}, env: () => ({DEEPGRAM_API_KEY: 'x'})});
  const dir = path.join(s.pub, 'clips', 'transcripts');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'toma.es.json'), JSON.stringify([{word: 'Tiene', startMs: 0, endMs: 300}, {word: '3', startMs: 350, endMs: 600}]));
  fs.writeFileSync(path.join(dir, 'toma.es.dg.json'), JSON.stringify([{word: 'Tiene', startMs: 0, endMs: 300}, {word: 'cuatro', startMs: 350, endMs: 600}]));
  const clips = [{id: 'c0', src: 'clips/toma.mp4', inSec: 0, outSec: 4, sourceDurationSec: 4}];
  s.jobs.submit({props: props({}, {clips, graphics: [{id: 'g0', src: 'clips/toma.mp4', startMs: 400, endMs: 2000, template: 'stat', props: {value: '3', label: 'recámaras'}}]}), draft: false, projectId: 'p1', expectSec: 1});
  await s.jobs.idle();
  assert.deepEqual(s.calls.record[0].datosPorConfirmar?.map((d) => d.dato), ['3']); // the Deepgram cache says "cuatro"
});

// ---- the proof lane (kind 'proof') and the fair order (CEO-18) ----
const proofOf = (s, fake = {}, extra = {}) => s.jobs.submit({kind: 'proof', proof: {what: 'caption', times: [1, 2, 3], rev: 'r1'}, props: props(fake), projectId: 'p1', ...extra}).job;
const proofDir = (s, id) => path.join(s.root, '.captions-tmp', `proof-${id}`);

test('proofs run in series at REEL_PROOF_CONCURRENCY 1, each leaves its sheet under .captions-tmp/proof-<id>/, and none is a final', async () => {
  const s = setup();
  let max = 0;
  const iv = setInterval(() => { max = Math.max(max, listJobs(s.dir, {status: 'running', kind: 'proof'}).length); }, 2);
  const ids = [1, 2, 3].map(() => proofOf(s, {stills: 4, delayMs: 10}).id);
  assert.equal(s.jobs.proofWorkers, 1);
  assert.equal(aheadOf(listJobs(s.dir), ids[2]), 2, 'one running + one queued before it');
  assert.equal(legacyView(readJob(s.dir, ids[2]), 2).label, 'proof en fila, 2 antes');
  await until(() => ids.every((id) => readJob(s.dir, id).status === 'done'), 8000);
  clearInterval(iv);
  assert.equal(max, 1);
  const starts = ids.map((id) => Date.parse(readJob(s.dir, id).startedAt));
  for (let i = 1; i < ids.length; i++) assert.ok(starts[i] >= Date.parse(readJob(s.dir, ids[i - 1]).finishedAt), 'the next starts once the previous is done');
  const done = readJob(s.dir, ids[0]);
  assert.equal(done.kind, 'proof'); assert.equal(done.draft, true);
  assert.equal(done.result.sheet, path.join(proofDir(s, ids[0]), 'proof-sheet.jpg'));
  assert.ok(fs.existsSync(done.result.sheet));
  assert.equal(done.result.rev, 'r1', 'the revision it shows, for the captions stage');
  assert.deepEqual(done.frames, {done: 4, total: 4});
  assert.equal(s.calls.record.length, 0, 'never a review version');
  assert.deepEqual(fs.readdirSync(path.join(s.pub, 'exports')), [], 'never an export');
  assert.equal(legacyView(done).sheet, done.result.sheet);
  assert.match(describeJob(done), new RegExp(` proof p1 {2}DONE → ${done.result.sheet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\d+s\\)$`));
});

test('a proof never takes a final\'s slot, and a final never waits on a proof\'s', async () => {
  const s = setup();
  // a final holds the render slot (stopped at frame 4) → a proof still runs, in its own slot, niced
  const fin = s.jobs.submit({props: props({mode: 'gate', frames: 6}), draft: false, projectId: 'p2', expectSec: 1}).job;
  await until(() => readJob(s.dir, fin.id).frames?.done === 4);
  const pr = proofOf(s);
  await until(() => readJob(s.dir, pr.id).status === 'done');
  assert.equal(readJob(s.dir, fin.id).status, 'running');
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, '.slot-0.lock'), 'utf8')).job, fin.id);
  assert.ok(readJob(s.dir, pr.id).result.nice >= 15, 'niced while a render holds a slot');
  fs.writeFileSync(path.join(s.pub, 'exports', `edited-${fin.id}.mp4.go`), '');
  await until(() => readJob(s.dir, fin.id).status === 'done', 8000);
  // a proof holds the proof slot → a final starts at once
  const held = proofOf(s, {mode: 'gate'});
  await until(() => readJob(s.dir, held.id).frames?.done === 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, '.proof-slot-0.lock'), 'utf8')).job, held.id);
  const fin2 = s.jobs.submit({props: props({frames: 2}), draft: true, projectId: 'p2'}).job;
  await until(() => readJob(s.dir, fin2.id).status === 'done');
  assert.equal(readJob(s.dir, held.id).status, 'running');
  fs.writeFileSync(path.join(proofDir(s, held.id), 'spec.json.go'), '');
  await until(() => readJob(s.dir, held.id).status === 'done');
  assert.equal(readJob(s.dir, held.id).result.nice, os.getPriority(), 'not niced when no render runs');
  assert.ok(!fs.existsSync(path.join(s.dir, '.proof-slot-0.lock')), 'the proof slot is given back');
});

test('a proof past REEL_PROOF_TIMEOUT_SEC is killed and failed with the message; the next proof goes on', async () => {
  const s = setup({queue: {proofTimeoutMs: 150}});
  const hung = proofOf(s, {mode: 'hang'});
  const next = proofOf(s, {stills: 2});
  await until(() => readJob(s.dir, hung.id).frames?.done === 2);
  const pid = readJob(s.dir, hung.id).pid;
  await sleep(200);
  s.jobs.tick();
  await until(() => readJob(s.dir, hung.id).status === 'failed');
  const j = readJob(s.dir, hung.id);
  assert.equal(j.errorCode, 'TIMEOUT');
  assert.match(j.error, /proof timed out: still running after \ds \(REEL_PROOF_TIMEOUT_SEC=0\) — killed/);
  assert.match(legacyView(j).error, /proof timed out/);
  await until(() => !pidAlive(pid), 7000);
  assert.ok(!fs.existsSync(proofDir(s, hung.id)), 'nothing of it left');
  await until(() => readJob(s.dir, next.id).status === 'done');
});

test('a proof that crashes fails with the reason and leaves nothing; a cancelled one is killed; the lane goes on', async () => {
  const s = setup();
  const crash = proofOf(s, {mode: 'crash'});
  await until(() => readJob(s.dir, crash.id).status === 'failed');
  assert.match(readJob(s.dir, crash.id).error, /proof failed \(exit 1\): .*Target closed/);
  assert.ok(!fs.existsSync(proofDir(s, crash.id)));
  const hung = proofOf(s, {mode: 'hang'});
  const queued = proofOf(s);
  const dropped = proofOf(s);
  assert.ok(s.jobs.cancel(dropped.id).ok);
  assert.equal(readJob(s.dir, dropped.id).status, 'cancelled', 'a queued proof ends at once');
  await until(() => readJob(s.dir, hung.id).frames?.done === 2);
  const pid = readJob(s.dir, hung.id).pid;
  assert.ok(s.jobs.cancel(hung.id).pending);
  await until(() => readJob(s.dir, hung.id).status === 'cancelled');
  await until(() => !pidAlive(pid), 7000);
  assert.ok(!fs.existsSync(proofDir(s, hung.id)));
  await until(() => readJob(s.dir, queued.id).status === 'done');
});

test('memory: a proof waits under REEL_PROOF_START_MIN_MEM_MB (1024), and never takes the memory a final is waiting for', async () => {
  let avail = 900;
  const s = setup({memory: () => avail});
  const pr = proofOf(s);
  s.jobs.tick();
  let j = readJob(s.dir, pr.id);
  assert.equal(j.status, 'queued');
  assert.equal(j.memoryWait.needMb, 1024);
  assert.match(legacyView(j).label, /waiting for memory \(900 MB available, needs 1024 MB\)/);
  // enough for a proof, not for a final: the final (render slot free) waits, and so does the proof
  avail = 1500;
  const fin = s.jobs.submit({props: props({frames: 2}), draft: false, projectId: 'p2', expectSec: 1}).job;
  s.jobs.tick();
  assert.equal(readJob(s.dir, fin.id).memoryWait.needMb, 2560);
  j = readJob(s.dir, pr.id);
  assert.equal(j.status, 'queued', 'the proof does not start into the final\'s memory');
  assert.equal(j.memoryWait.render, fin.id);
  assert.equal(j.label, `Queued — render ${fin.id} is waiting for memory first (1500 MB available)`);
  assert.match(describeJob(j), new RegExp(`waiting: render ${fin.id} waits for memory first`));
  avail = 3000;
  s.jobs.tick();
  await until(() => [fin.id, pr.id].every((id) => readJob(s.dir, id).status === 'done'), 8000);
  assert.ok(Date.parse(readJob(s.dir, fin.id).startedAt) <= Date.parse(readJob(s.dir, pr.id).startedAt), 'the final first');
  // a final waiting behind a running one does not hold the proofs (it is not waiting for memory)
  avail = 1500;
  const run = s.jobs.submit({props: props({mode: 'gate', frames: 6}), draft: true, projectId: 'p3'}).job;
  avail = 3000; s.jobs.tick(); avail = 1500;
  await until(() => readJob(s.dir, run.id).frames?.done === 4);
  const behind = s.jobs.submit({props: props({frames: 1}), draft: true, projectId: 'p4'}).job;
  const pr2 = proofOf(s);
  await until(() => readJob(s.dir, pr2.id).status === 'done');
  assert.equal(readJob(s.dir, behind.id).status, 'queued');
  fs.writeFileSync(path.join(s.pub, 'exports', `edited-${run.id}-draft.mp4.go`), '');
  avail = 3000;
  await until(() => readJob(s.dir, behind.id).status === 'done', 8000);
});

test('fair queue (CEO-18): A1 A2 B1 C1 submitted in that order start A1, B1, C1, A2; aheadOf counts in that order', async () => {
  const q = (id, projectId, seq, extra = {}) => ({id, projectId, seq, status: 'queued', ...extra});
  assert.deepEqual(fairOrder([q('A1', 'A', 1), q('A2', 'A', 2), q('B1', 'B', 3), q('C1', 'C', 4)]).map((j) => j.id), ['A1', 'B1', 'C1', 'A2']);
  // the least recently served project first; jobs without a project are a bucket of their own
  const t = (m) => new Date(Date.UTC(2026, 8, 27, 0, m)).toISOString();
  const jobs = [q('A0', 'A', 0, {status: 'done', startedAt: t(5)}), q('B0', 'B', 0, {status: 'running', startedAt: t(9)}), q('A2', 'A', 2), q('B1', 'B', 3), q('n1', null, 4), q('n2', null, 5), q('A3', 'A', 6)];
  assert.deepEqual(fairOrder(jobs).map((j) => j.id), ['n1', 'A2', 'B1', 'n2', 'A3']);
  assert.equal(aheadOf(jobs, 'B1'), 1 + 2, 'the running one + n1, A2');
  // proofs count only proofs
  assert.equal(aheadOf([...jobs, q('P1', 'A', 7, {kind: 'proof'})], 'P1'), 0);
  // the queue itself
  const s = setup();
  const order = [];
  const sub = (projectId) => { const j = s.jobs.submit({props: props({frames: 2, delayMs: 5}), draft: true, projectId}).job; order.push([projectId, j.id]); return j; };
  const [a1, a2, b1, c1] = ['A', 'A', 'B', 'C'].map(sub);
  assert.equal(readJob(s.dir, a1.id).status, 'running');
  assert.deepEqual([b1, c1, a2].map((j) => aheadOf(listJobs(s.dir), j.id)), [1, 2, 3]);
  await until(() => [a1, a2, b1, c1].every((j) => readJob(s.dir, j.id).status === 'done'), 10000);
  const started = [a1, a2, b1, c1].sort((x, y) => Date.parse(readJob(s.dir, x.id).startedAt) - Date.parse(readJob(s.dir, y.id).startedAt) || readJob(s.dir, x.id).seq - readJob(s.dir, y.id).seq);
  assert.deepEqual(started.map((j) => j.id), [a1.id, b1.id, c1.id, a2.id]);
});

test('a proof is none of a user\'s renders (admitRender), and its state goes after a day with the sheet nobody took', () => {
  const props0 = JSON.stringify({clips: [{id: 'c'}]});
  const proof = {id: '1000000000001aaaaaa', kind: 'proof', user: 'ana', status: 'running', propsHash: 'x'};
  assert.equal(admitRender([proof], {user: 'ana', props: props0, mode: 'full'}, {}), null);
  const dir = path.join(tmpdir(), 'jobs');
  const out = path.join(path.dirname(dir), '.captions-tmp', 'proof-1000000000002aaaaaa');
  fs.mkdirSync(out, {recursive: true});
  const now = Date.parse('2026-09-27T12:00:00Z');
  const ago = (h) => new Date(now - h * 3600e3).toISOString();
  writeJob(dir, {id: '1000000000002aaaaaa', kind: 'proof', seq: 1, status: 'done', createdAt: ago(30), finishedAt: ago(30), result: {dir: out}});
  writeJob(dir, {id: '1000000000003aaaaaa', kind: 'proof', seq: 2, status: 'done', createdAt: ago(2), finishedAt: ago(2)});
  writeJob(dir, {id: '1000000000004aaaaaa', seq: 3, status: 'done', createdAt: ago(30), finishedAt: ago(30)});
  assert.deepEqual(prune(dir, {now}), ['1000000000002aaaaaa']);
  assert.ok(!fs.existsSync(out));
  assert.deepEqual(listJobs(dir, {kind: 'render'}).map((j) => j.id), ['1000000000004aaaaaa']);
});
