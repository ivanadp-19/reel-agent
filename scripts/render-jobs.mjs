// Render jobs on disk: the asynchronous render queue behind /api/render, the MCP
// start_render / render_status / list_render_jobs / cancel_render tools, the CLI
// (scripts/render-cli.mjs) and the editor's Renders panel.
//
// A render is a job: submit() writes it and returns at once with its id; the
// queue starts it when a slot frees; its status, stage and progress are written
// to disk as it goes, so any process (the backend, the MCP server, the CLI with
// the backend down) can read it by id, and a backend restart does not lose it.
//
// Store: public/render-jobs/ (gitignored like all of public/)
//   <id>.json        the job (see JOB below), written by write + rename
//   <id>.props.json  the composition props to render, deleted when the job ends
//   <id>.claim       exclusive-create claim of the backend that runs it (its pid):
//                    two backends on one public/ (REEL_PORT) never run one job twice
//   <id>.cancel      a cancel request (a file of its own so the owner's progress
//                    writes never overwrite it)
//
// JOB: {id, seq, status, stage, label, progress, frames?, etaSec?, draft, projectId,
//       expectSec, clean, createdAt, startedAt?, finishedAt?, heartbeatAt?, progressAt?,
//       owner? (backend pid), pid? (render process pid), attempts, result?, error?}
//   status   queued → running → done | failed | cancelled
//   progress 0–100 over the whole job (stage weights in scripts/render-runner.mjs)
//   mode     full | layers (scripts/render-runner.mjs; a reel layers cannot carry runs full, result.fallback says why)
//   result   {file (/exports/…), path (absolute), renderSec, mode, fallback?, master? ('cached' | 'rendered'), stages, qc?, version?, versionError?}
//
// Queue: serial by default (one render at a time on the whole machine, counted over
// every backend sharing public/); REEL_RENDER_WORKERS = N allows N at once. FIFO by seq.
//
// Liveness: while a job runs, its owner rewrites heartbeatAt every few seconds after
// checking that the render process (pid) is alive. A job is failed when
//   - its render process dies without reporting (pid gone, no close from the runner),
//   - it makes no progress for REEL_RENDER_STALL_SEC (default 900 s) while Remotion
//     bundles / renders / encodes (it prints progress all the time: silence = a hung Chrome),
//   - it makes no progress for REEL_RENDER_PREPARE_STALL_SEC (default 300 s) while it
//     prepares (B-roll downloads report every MB, each step reports itself: silence = a
//     hung download or LUT bake) or copies a cached master — the runner is aborted, so
//     the download / ffmpeg stops and the queue moves on,
//   - its backend died or was stopped (SIGTERM/SIGINT kill its renders — shutdown()):
//     on the next tick of any backend (restart included) the job
//     is re-queued once (attempts ≤ 2) and then failed; a render process it left
//     behind is killed first — by pid, only after /proc/<pid>/cmdline shows it is
//     that job's render (never a kill by pattern, AGENTS.md).
//
// Cleanup: prune() drops the STATE of finished jobs older than REEL_RENDER_JOBS_DAYS
// (default 14) — the job files only; the mp4s in public/exports/ and the review
// versions are never touched here (their retention is scripts/reviews.mjs's).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const STATES = ['queued', 'running', 'done', 'failed', 'cancelled'];
export const ACTIVE = new Set(['queued', 'running']);
export const MAX_ATTEMPTS = 2; // a job interrupted by a backend restart is re-queued once
const STALL_STAGES = new Set(['starting', 'bundling', 'rendering', 'encoding']); // the stages that report progress continuously
const PREPARE_STAGES = new Set(['preparing', 'master']); // downloads, LUT bakes, the cached master: a limit of their own
const ID_RE = /^[\w-]{6,64}$/;
const DAY = 86400e3;

export const jobsDir = (publicDir) => path.join(publicDir, 'render-jobs');
export const newJobId = (now = Date.now()) => `${now}${crypto.randomBytes(3).toString('hex')}`; // parallel agents may submit in the same ms

// is a pid alive? (EPERM = alive, someone else's)
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// the command line of a pid (Linux /proc); null elsewhere or when it is gone
export function pidCmdline(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' '); } catch { return null; }
}
// every process below pid (Linux /proc; [] elsewhere)
export function descendants(pid) {
  const kids = new Map();
  let names = [];
  try { names = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return []; }
  for (const n of names) {
    try {
      const st = fs.readFileSync(`/proc/${n}/stat`, 'utf8');
      const ppid = +st.slice(st.lastIndexOf(')') + 2).split(' ')[1]; // "pid (comm) state ppid …"
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(+n);
    } catch {}
  }
  const out = [];
  for (const q = [pid]; q.length;) for (const c of kids.get(q.shift()) ?? []) { out.push(c); q.push(c); }
  return out;
}
// Kill a render: its process group (it runs detached: npx → node) and everything below
// it — Chrome runs in a process group of its own, so the group alone would leave it
// behind when Remotion cannot clean up (SIGKILL). SIGTERM first lets Remotion close it.
export function killTree(pid, signal = 'SIGTERM') {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const below = descendants(pid); // before the kill: once the parent dies they are re-parented and lost
  let ok = false;
  try { process.kill(-pid, signal); ok = true; } catch {}
  if (!ok) try { process.kill(pid, signal); ok = true; } catch {}
  for (const c of below) try { process.kill(c, signal); } catch {}
  return ok;
}

// ---- the store: plain functions over the directory, usable read-only by any process ----
const fileOf = (dir, id, ext = '.json') => {
  if (!ID_RE.test(id ?? '')) throw new Error(`bad render job id: ${id}`);
  return path.join(dir, `${id}${ext}`);
};
export function readJob(dir, id) {
  try { return JSON.parse(fs.readFileSync(fileOf(dir, id), 'utf8')); } catch (e) { if (/bad render job id/.test(e.message)) throw e; return null; }
}
export function writeJob(dir, job) {
  fs.mkdirSync(dir, {recursive: true});
  const f = fileOf(dir, job.id);
  const tmp = `${f}.${process.pid}.tmp`; // write + rename: a reader never sees half a file
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
  fs.renameSync(tmp, f);
  return job;
}
export function listJobs(dir, {projectId, status, limit} = {}) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => /^[\w-]+\.json$/.test(f) && !f.endsWith('.props.json')); } catch {}
  let jobs = names.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } }).filter((j) => j?.id);
  if (projectId) jobs = jobs.filter((j) => j.projectId === projectId);
  if (status) { const want = new Set([].concat(status)); jobs = jobs.filter((j) => want.has(j.status)); }
  jobs.sort((a, b) => b.seq - a.seq); // newest first
  return limit ? jobs.slice(0, limit) : jobs;
}
// how many jobs are ahead of a queued one (0 = it is next / not queued)
export function aheadOf(jobs, id) {
  const j = jobs.find((x) => x.id === id);
  if (j?.status !== 'queued') return 0;
  return jobs.filter((x) => x.status === 'running' || (x.status === 'queued' && x.seq < j.seq)).length;
}
const removeJobFiles = (dir, id, exts = ['.json', '.props.json', '.claim', '.cancel']) => { for (const e of exts) fs.rmSync(fileOf(dir, id, e), {force: true}); };

// Drop the state of finished jobs older than `days` (never their mp4s) → the ids removed.
export function prune(dir, {days = +(process.env.REEL_RENDER_JOBS_DAYS || 14), now = Date.now()} = {}) {
  const cut = now - days * DAY;
  const gone = [];
  for (const j of listJobs(dir)) {
    if (ACTIVE.has(j.status)) continue;
    const t = Date.parse(j.finishedAt || j.createdAt);
    if (Number.isFinite(t) && t < cut) { removeJobFiles(dir, j.id); gone.push(j.id); }
  }
  return gone;
}

// What a client (the editor's pollJob, the MCP render tool) reads at /api/render/<id>:
// the shape the backend answered before the jobs were persisted — 'running' while
// queued or rendering, 'done', or 'error' — plus the job fields.
export function legacyView(job, ahead = 0) {
  if (!job) return {status: 'unknown'};
  const base = {jobId: job.id, state: job.status, stage: job.stage, progress: job.progress ?? 0, label: job.label, frames: job.frames, etaSec: job.etaSec};
  if (job.status === 'queued') return {...base, status: 'running', queued: true, ahead, label: `Queued — ${ahead} render${ahead === 1 ? '' : 's'} ahead`};
  if (job.status === 'running') return {...base, status: 'running'};
  if (job.status === 'done') return {...base, status: 'done', progress: 100, ...job.result};
  return {...base, status: 'error', error: job.status === 'cancelled' ? `cancelled${job.error ? `: ${job.error}` : ''}` : job.error || 'render failed', ...(job.result?.qc ? {qc: job.result.qc} : {})};
}

// One line per job for the MCP tools and the CLI.
const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
export function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return '?';
  sec = Math.max(0, Math.round(sec));
  return sec >= 3600 ? `${Math.floor(sec / 3600)}h${String(Math.floor(sec / 60) % 60).padStart(2, '0')}m` : sec >= 60 ? `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s` : `${sec}s`;
}
export function describeJob(job, {ahead = 0, now = Date.now()} = {}) {
  const kind = job.draft ? 'draft' : 'final';
  const who = job.projectId ? ` ${job.projectId}` : '';
  const head = `${job.id}  ${kind}${who}  ${job.status.toUpperCase()}`;
  if (job.status === 'queued') return `${head} — ${ahead ? `${ahead} render${ahead === 1 ? '' : 's'} ahead` : 'next'}, submitted ${fmtDuration((now - Date.parse(job.createdAt)) / 1000)} ago`;
  if (job.status === 'running') {
    const fr = job.frames?.total && !/frame/i.test(job.label ?? '') ? ` · frame ${job.frames.done}/${job.frames.total}` : '';
    const eta = Number.isFinite(job.etaSec) ? ` · ~${fmtDuration(job.etaSec)} left` : '';
    const beat = job.heartbeatAt ? (now - Date.parse(job.heartbeatAt)) / 1000 : 0;
    return `${head} ${job.progress ?? 0}% — ${job.label || job.stage || 'working'}${fr}${eta} · running ${fmtDuration((now - Date.parse(job.startedAt || job.createdAt)) / 1000)}${beat > 60 ? ` · ⚠ no heartbeat for ${fmtDuration(beat)}` : ''}`;
  }
  if (job.status === 'done') {
    const r = job.result ?? {};
    return `${head} → ${r.path || r.file}${r.renderSec != null ? ` (${fmtDuration(r.renderSec)} for ${f1(job.expectSec ?? 0)}s of video)` : ''}${r.mode ? ` [${r.mode}${r.master ? `, master ${r.master}` : ''}]` : ''}${r.fallback?.length ? ` (layers → full: ${r.fallback.join('; ')})` : ''}${r.version ? ` · review version v${r.version}` : ''}${r.versionError ? ` · review version NOT recorded: ${r.versionError}` : ''}`;
  }
  return `${head}${job.error ? ` — ${job.error}` : ''}`;
}

// ---- the queue: one per backend process ----
// run(job, ctx) does the render and resolves with the result (or throws); ctx:
//   update({stage, label, progress, frames, etaSec})  progress as it goes
//   setPid(pid)    the render process, for the heartbeat and orphan cleanup
//   signal         AbortSignal: cancel / stall / dead process — kill the child and throw
//   props          the composition props (JSON string) submitted with the job
export function createRenderJobs({
  dir,
  run,
  workers = Math.max(1, +(process.env.REEL_RENDER_WORKERS || 1)),
  tickMs = 5000,
  stallMs = +(process.env.REEL_RENDER_STALL_SEC || 900) * 1000,
  prepareStallMs = +(process.env.REEL_RENDER_PREPARE_STALL_SEC || 300) * 1000,
  now = Date.now,
  isAlive = pidAlive,
  cmdline = pidCmdline,
  kill = killTree,
  owner = process.pid,
  log = (m) => console.log(m),
} = {}) {
  fs.mkdirSync(dir, {recursive: true});
  const active = new Map(); // id → {ac, pid, settled}
  const iso = () => new Date(now()).toISOString();
  let timer = null;
  let seqLast = 0;
  let stopping = false; // shutdown(): leave the killed jobs 'running' for the next start to re-queue

  const save = (job) => writeJob(dir, job);
  const patch = (id, fields) => { const j = readJob(dir, id); if (!j) return null; return save({...j, ...fields}); };
  const finish = (id, fields) => {
    const j = patch(id, {...fields, finishedAt: iso(), pid: null});
    for (const e of ['.props.json', '.claim', '.cancel']) fs.rmSync(fileOf(dir, id, e), {force: true});
    return j;
  };
  const claimOwner = (id) => { try { return +fs.readFileSync(fileOf(dir, id, '.claim'), 'utf8'); } catch { return null; } };
  // exclusive create: of several backends ticking together exactly one wins the job
  const claim = (id) => {
    try { fs.writeFileSync(fileOf(dir, id, '.claim'), String(owner), {flag: 'wx'}); return true; } catch { return false; }
  };
  const cancelRequested = (id) => fs.existsSync(fileOf(dir, id, '.cancel'));

  function submit({props, draft = false, projectId = null, expectSec = null, clean = 'off', mode = 'full', label} = {}) {
    if (typeof props !== 'string') props = JSON.stringify(props ?? {});
    const t = now();
    const id = newJobId(t);
    // seq orders the queue: time-based so the order holds across backends and restarts
    const seq = Math.max(t * 1000, seqLast + 1); seqLast = seq;
    fs.writeFileSync(fileOf(dir, id, '.props.json'), props);
    const job = save({id, seq, status: 'queued', stage: 'queued', label: label ?? 'Queued', progress: 0, draft: !!draft, projectId: projectId ?? null, expectSec, clean, mode: mode === 'layers' ? 'layers' : 'full', createdAt: iso(), attempts: 0});
    pump();
    const jobs = listJobs(dir);
    return {job: readJob(dir, id) ?? job, ahead: aheadOf(jobs, id)};
  }

  function start(job) {
    const ac = new AbortController();
    const slot = {ac, pid: null, settled: false};
    active.set(job.id, slot);
    const t = iso();
    save({...job, status: 'running', stage: 'starting', label: 'Starting', progress: 0, startedAt: t, heartbeatAt: t, progressAt: t, owner, pid: null, attempts: (job.attempts ?? 0) + 1, error: undefined});
    let props = '{}';
    try { props = fs.readFileSync(fileOf(dir, job.id, '.props.json'), 'utf8'); } catch {}
    let lastPct = -1;
    const ctx = {
      signal: ac.signal,
      props,
      update(u) {
        if (slot.settled) return;
        const cur = readJob(dir, job.id);
        if (!cur || cur.status !== 'running') return;
        // a new label counts too: "Downloading B-roll 2/5 · 34 MB" moves inside one percent
        const moved = (u.progress != null && u.progress !== lastPct) || (u.stage && u.stage !== cur.stage) || (u.frames && u.frames.done !== cur.frames?.done) || (u.label != null && u.label !== cur.label);
        if (u.progress != null) lastPct = u.progress;
        const t2 = iso();
        save({...cur, ...u, heartbeatAt: t2, ...(moved ? {progressAt: t2} : {})});
      },
      // the process the heartbeat watches (null between processes: preparing, copying, the review proxy)
      setPid(pid) { slot.pid = pid ?? null; slot.deadSince = null; if (!slot.settled) patch(job.id, {pid: pid ?? null}); },
    };
    log(`render ${job.id} started (${job.draft ? 'draft' : 'final'}${job.projectId ? ` of ${job.projectId}` : ''}, attempt ${(job.attempts ?? 0) + 1})`);
    Promise.resolve()
      .then(() => run(readJob(dir, job.id), ctx))
      .then(
        (result) => {
          if (stopping) return;
          if (ac.signal.aborted) throw ac.signal.reason ?? new Error('aborted');
          finish(job.id, {status: 'done', stage: 'done', label: 'Done', progress: 100, result, etaSec: 0});
          log(`render ${job.id} done → ${result?.file}`);
        },
      )
      .catch((e) => {
        if (stopping) return;
        const why = ac.signal.aborted ? ac.signal.reason : e;
        const cancelled = why?.code === 'CANCELLED';
        const cur = readJob(dir, job.id);
        if (cur && ACTIVE.has(cur.status)) {
          finish(job.id, {status: cancelled ? 'cancelled' : 'failed', stage: cancelled ? 'cancelled' : 'failed', label: cancelled ? 'Cancelled' : 'Failed', error: String(cancelled ? why.detail ?? '' : e?.message ?? e).slice(0, 400) || undefined, ...(e?.result ? {result: e.result} : {})});
        }
        log(`render ${job.id} ${cancelled ? 'cancelled' : `failed: ${String(why?.message ?? why).slice(0, 200)}`}`);
      })
      .finally(() => { slot.settled = true; active.delete(job.id); if (!stopping) pump(); });
  }

  const abort = (id, code, detail) => {
    const slot = active.get(id);
    if (!slot || slot.ac.signal.aborted) return false;
    const err = Object.assign(new Error(detail || code), {code, detail});
    slot.ac.abort(err);
    return true;
  };

  // Jobs marked running whose backend is gone (a restart, a crash): re-queue once, then fail.
  function recover() {
    for (const j of listJobs(dir, {status: 'running'})) {
      if (active.has(j.id)) continue;
      const holder = j.owner ?? claimOwner(j.id);
      if (holder !== owner && isAlive(holder)) continue; // another live backend runs it
      // the render it left behind, if still alive and really this job's (pid reuse): stop it
      const ours = (pid) => pid && isAlive(pid) && (cmdline(pid) ?? '').includes(j.id);
      if (ours(j.pid)) {
        kill(j.pid, 'SIGTERM');
        const t = setTimeout(() => { if (ours(j.pid)) kill(j.pid, 'SIGKILL'); }, 5000); t.unref?.();
      }
      fs.rmSync(fileOf(dir, j.id, '.claim'), {force: true});
      const hasProps = fs.existsSync(fileOf(dir, j.id, '.props.json'));
      if (cancelRequested(j.id)) { finish(j.id, {status: 'cancelled', stage: 'cancelled', label: 'Cancelled'}); continue; }
      if ((j.attempts ?? 1) < MAX_ATTEMPTS && hasProps) {
        save({...j, status: 'queued', stage: 'queued', label: 'Queued (restarted after the backend stopped)', progress: 0, frames: undefined, etaSec: undefined, pid: null, owner: undefined, requeuedAt: iso()});
        log(`render ${j.id} re-queued: its backend (pid ${holder}) stopped mid-render`);
      } else {
        finish(j.id, {status: 'failed', stage: 'failed', label: 'Failed', error: `interrupted: the backend (pid ${holder}) stopped during the render${hasProps ? ` — ${j.attempts} attempts` : ''}`});
        log(`render ${j.id} failed: interrupted`);
      }
    }
    // claims left by a dead backend on jobs that never started
    for (const j of listJobs(dir, {status: 'queued'})) {
      const holder = claimOwner(j.id);
      if (holder && holder !== owner && !isAlive(holder)) fs.rmSync(fileOf(dir, j.id, '.claim'), {force: true});
    }
  }

  // Start queued jobs while there are free slots (counted over every backend on this dir).
  function pump() {
    const jobs = listJobs(dir);
    // a claimed job that has not written 'running' yet takes its slot too (another backend is starting it)
    let running = jobs.filter((j) => j.status === 'running' || (j.status === 'queued' && isAlive(claimOwner(j.id)))).length;
    const queued = jobs.filter((j) => j.status === 'queued').sort((a, b) => a.seq - b.seq);
    for (const j of queued) {
      if (running >= workers) break;
      if (cancelRequested(j.id)) { finish(j.id, {status: 'cancelled', stage: 'cancelled', label: 'Cancelled'}); continue; }
      if (!fs.existsSync(fileOf(dir, j.id, '.props.json'))) { finish(j.id, {status: 'failed', stage: 'failed', label: 'Failed', error: 'its props file is gone'}); continue; }
      if (!claim(j.id)) continue; // another backend took it
      const fresh = readJob(dir, j.id);
      if (fresh?.status !== 'queued') { fs.rmSync(fileOf(dir, j.id, '.claim'), {force: true}); continue; }
      running++;
      start(fresh);
    }
  }

  // The heartbeat: every tickMs, for each job this backend runs — cancel requests,
  // a render process that died, a render that stopped making progress.
  function tick() {
    const t = now();
    for (const [id, slot] of active) {
      if (slot.settled) continue;
      const j = readJob(dir, id);
      if (!j) continue;
      if (cancelRequested(id)) { abort(id, 'CANCELLED', 'cancelled by request'); continue; }
      if (slot.pid && !isAlive(slot.pid)) {
        // the runner normally reports the exit itself; give it one tick, then fail the job
        if (slot.deadSince == null) { slot.deadSince = t; continue; }
        abort(id, 'DIED', `the render process (pid ${slot.pid}) died without reporting`);
        continue;
      }
      // stalled: Remotion prints progress all the time, so silence while it bundles or renders means a
      // hung Chrome; preparing reports every step and every downloaded MB, so silence there is a hung download
      const limit = STALL_STAGES.has(j.stage) ? stallMs : PREPARE_STAGES.has(j.stage) ? prepareStallMs : 0;
      if (limit > 0 && j.progressAt && t - Date.parse(j.progressAt) > limit) {
        abort(id, 'STALLED', `no progress for ${fmtDuration((t - Date.parse(j.progressAt)) / 1000)} (stage ${j.stage}) — killed`);
        continue;
      }
      patch(id, {heartbeatAt: new Date(t).toISOString()});
    }
    recover();
    pump();
  }

  // Cancel: a queued job ends at once; a running one is stopped (its owner kills the
  // render process group) — on another backend through the .cancel file.
  function cancel(id) {
    const j = readJob(dir, id);
    if (!j) return {ok: false, error: `no render job ${id}`};
    if (!ACTIVE.has(j.status)) return {ok: false, error: `render ${id} already ${j.status}`, job: j};
    fs.writeFileSync(fileOf(dir, id, '.cancel'), iso());
    if (j.status === 'queued' && claim(id)) {
      const k = finish(id, {status: 'cancelled', stage: 'cancelled', label: 'Cancelled'});
      return {ok: true, job: k};
    }
    if (active.has(id)) abort(id, 'CANCELLED', 'cancelled by request');
    return {ok: true, job: readJob(dir, id), pending: true};
  }

  return {
    dir,
    workers,
    submit,
    cancel,
    get: (id) => readJob(dir, id),
    list: (opts) => listJobs(dir, opts),
    ahead: (id) => aheadOf(listJobs(dir), id),
    prune: (opts) => prune(dir, opts),
    view: (id) => { const jobs = listJobs(dir); return legacyView(jobs.find((j) => j.id === id) ?? null, aheadOf(jobs, id)); },
    tick,
    pump,
    recover,
    // startup: recover what a previous run left, prune old state, start the queue and the heartbeat
    start({pruneEveryMs = 3600e3} = {}) {
      recover();
      try { const gone = prune(dir); if (gone.length) log(`render jobs: pruned ${gone.length} old job(s)`); } catch {}
      pump();
      if (!timer) {
        timer = setInterval(tick, tickMs); timer.unref?.();
        const p = setInterval(() => { try { prune(dir); } catch {} }, pruneEveryMs); p.unref?.();
      }
      return this;
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    // the backend is stopping: kill the renders it runs (their jobs stay 'running' with
    // this owner on disk, so the next start re-queues them — recover())
    shutdown() {
      stopping = true;
      if (timer) clearInterval(timer); timer = null;
      // SIGTERM: the renders are detached and outlive this process, so Remotion still gets to close its Chrome
      for (const [, slot] of active) if (slot.pid) kill(slot.pid, 'SIGTERM');
    },
    get running() { return active.size; },
    // wait until every job this backend runs has settled (tests, graceful stop)
    idle: () => new Promise((resolve) => { const w = () => (active.size ? setTimeout(w, 10) : resolve()); w(); }),
  };
}
