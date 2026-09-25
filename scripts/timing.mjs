// Where the time of a reel goes, per project: one JSON line per event in
// public/projects/<id>.timing.jsonl (next to the project, gitignored, append-only).
//
//   tool   — an MCP tool call (mcp/server.mjs): its duration, the part of it spent
//            waiting on backend jobs (`jobMs`, logged again as stages), and `gapMs`, the
//            time since the previous call of the same session ended = the agent deciding
//            (model turn: reading the result, planning, writing the next call)
//   stage  — backend work (server/index.mjs): transcription and the other pipeline
//            jobs, the render stages (full, or master / captions / composite) and
//            loudness + QC, whoever asked for them (the editor or the agent)
//
// summarize() folds a log into the buckets that answer "is it the model or the CPU":
// agent decisions, inspection (proofs, frames), transcription, render by stage,
// QC/loudness, the render queue, other tools, and idle (gaps too long to be a model turn).
//
//   node scripts/timing.mjs <project_id> [--json]
import fs from 'node:fs';
import path from 'node:path';

// a gap longer than this between two tool calls is somebody away, not a model turn
export const IDLE_MS = 5 * 60 * 1000;
// tools whose job is looking at the reel (the agent's inspection loop)
export const INSPECT = new Set(['caption_proof', 'motion_proof', 'frame_at', 'validate', 'get_project', 'get_transcript', 'qc']);

export const timingFile = (projectsDir, id) => path.join(projectsDir, `${id}.timing.jsonl`);

const safeId = (id) => typeof id === 'string' && /^[\w.-]{1,120}$/.test(id) && !id.includes('..');
// append one event; never throws (timing must not break an edit)
export function logTiming(projectsDir, id, event) {
  if (!safeId(id)) return false;
  try {
    fs.mkdirSync(projectsDir, {recursive: true});
    fs.appendFileSync(timingFile(projectsDir, id), JSON.stringify({t: new Date().toISOString(), ...event}) + '\n');
    return true;
  } catch { return false; }
}

export function readTiming(projectsDir, id) {
  if (!safeId(id)) return [];
  let text = '';
  try { text = fs.readFileSync(timingFile(projectsDir, id), 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// A session's tool calls one after the other: each call's gap is the agent's turn
// before it. createToolClock() keeps that per MCP process. Calls the client sends in
// parallel (one model turn, several tools) start while another is still in flight:
// only the first of them carries the turn, the others get gapMs 0 — three frame_at
// after 20 s of thinking are one 20 s turn, not three.
export function createToolClock(now = () => Date.now()) {
  let lastEnd = null;
  let inFlight = 0;
  return {
    start() {
      const t = now();
      const gapMs = inFlight > 0 ? 0 : lastEnd == null ? null : Math.max(0, t - lastEnd);
      inFlight++;
      return {t, gapMs};
    },
    end(started) { inFlight = Math.max(0, inFlight - 1); lastEnd = now(); return lastEnd - started.t; },
  };
}

const r1 = (ms) => +(ms / 1000).toFixed(1);
// buckets in seconds + the biggest one
export function summarize(events) {
  const b = {agent: 0, inspect: 0, transcribe: 0, render: 0, qc: 0, queue: 0, tools: 0, idle: 0};
  const renderStages = {}, tools = {}, jobs = {};
  let turns = 0;
  const renderJobs = new Set();
  const sessions = new Set();
  for (const e of events) {
    if (e.kind === 'tool') {
      sessions.add(e.session);
      if (e.gapMs) { // null = a session's first call, 0 = sent in the same turn as a call still running
        if (e.gapMs > IDLE_MS) b.idle += e.gapMs;
        else { b.agent += e.gapMs; turns++; }
      }
      const t = (tools[e.tool] ??= {n: 0, ms: 0, errors: 0});
      t.n++; t.ms += e.ms; if (e.ok === false) t.errors++;
      const own = Math.max(0, e.ms - (e.jobMs ?? 0)); // the backend's part is in its stages
      if (INSPECT.has(e.tool)) b.inspect += own;
      else b.tools += own;
    } else if (e.kind === 'stage') {
      if (e.stage === 'qc') b.qc += e.ms;
      else if (e.stage === 'queue') b.queue += e.ms;
      else if (['render', 'master', 'captions', 'encode', 'composite', 'prepare', 'first-frame'].includes(e.stage)) {
        b.render += e.ms;
        renderStages[e.stage] = (renderStages[e.stage] ?? 0) + e.ms;
        if (e.stage !== 'prepare') renderJobs.add(e.job ?? e.t); // one render = one backend job, whatever its stages
      } else if (e.stage === 'transcribe') b.transcribe += e.ms;
      else { b.tools += e.ms; jobs[e.stage] = (jobs[e.stage] ?? 0) + e.ms; }
    }
  }
  const secs = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, r1(v)]));
  const work = Object.entries(secs).filter(([k]) => k !== 'idle');
  const total = work.reduce((s, [, v]) => s + v, 0);
  const [top] = [...work].sort((x, y) => y[1] - x[1]);
  return {
    events: events.length, sessions: sessions.size, turns, renders: renderJobs.size, totalSec: +total.toFixed(1), buckets: secs,
    share: Object.fromEntries(work.map(([k, v]) => [k, total ? +(v / total).toFixed(3) : 0])),
    biggest: top && top[1] > 0 ? top[0] : null,
    renderStages: Object.fromEntries(Object.entries(renderStages).map(([k, v]) => [k, r1(v)])),
    jobs: Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, r1(v)])),
    tools: Object.fromEntries(Object.entries(tools).sort((x, y) => y[1].ms - x[1].ms).map(([k, v]) => [k, {n: v.n, sec: r1(v.ms), ...(v.errors ? {errors: v.errors} : {})}])),
  };
}

const LABEL = {agent: 'agent decisions (model turns between tool calls)', inspect: 'inspection (proofs, frames, validate)', transcribe: 'transcription', render: 'render', qc: 'loudness + QC', queue: 'waiting in the render queue (other renders)', tools: 'other tools and jobs', idle: 'idle (gaps > 5 min, not counted)'};
export function timingText(s) {
  if (!s.events) return 'No timing logged for this project yet.';
  const pct = (k) => (k in s.share ? ` (${Math.round(s.share[k] * 100)}%)` : '');
  const lines = Object.keys(LABEL).map((k) => `${LABEL[k]}: ${s.buckets[k]} s${pct(k)}${k === 'agent' ? ` over ${s.turns} turns` : ''}${k === 'render' && Object.keys(s.renderStages).length ? ` — ${Object.entries(s.renderStages).map(([n, v]) => `${n} ${v} s`).join(', ')}` : ''}`);
  const top = Object.entries(s.tools).slice(0, 8).map(([k, v]) => `${k} ×${v.n} ${v.sec} s${v.errors ? ` (${v.errors} failed)` : ''}`).join(', ');
  return [`${s.totalSec} s of work over ${s.sessions} agent session(s), ${s.renders} render(s); biggest: ${s.biggest ? LABEL[s.biggest] : '—'}`, ...lines, top ? `tools by time: ${top}` : ''].filter(Boolean).join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const id = process.argv[2];
  if (!id) { console.error('usage: node scripts/timing.mjs <project_id> [--json]'); process.exit(2); }
  const s = summarize(readTiming(path.resolve(import.meta.dirname, '..', 'public', 'projects'), id));
  console.log(process.argv.includes('--json') ? JSON.stringify(s, null, 2) : timingText(s));
}
