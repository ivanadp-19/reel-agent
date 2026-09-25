#!/usr/bin/env node
// Render jobs from a terminal or a script — the same queue as the editor's export
// button and the MCP start_render / render_status / list_render_jobs / cancel_render
// (the backend's /api/render and /api/render-jobs; scripts/render-jobs.mjs).
//
//   npm run render -- start <project_id> [--draft] [--mode full|layers] [--wait]   → prints the job id at once (--wait: follow it to the end)
//   npm run render -- status <job_id> [--watch]              → progress %, stage, frames, ETA; the file when done
//   npm run render -- list [--project <id>] [--active] [--limit 20]
//   npm run render -- cancel <job_id>
//   npm run render -- prune [--days 14]                      → drop the state of old finished jobs (never the mp4s)
//   add --json to any command for machine-readable output
//
// Exit codes: 0 ok (with --wait/--watch: the job ended done), 1 error / the job failed
// or was cancelled, 2 bad usage. status and list work with the backend down (they read
// public/render-jobs/ directly); start, cancel and prune need it (`npm start`).
// REEL_API points at another backend (as for the MCP server).
import fs from 'node:fs';
import path from 'node:path';
import {projectRenderProps} from '../src/renderProps.ts';
import {aheadOf, describeJob, jobsDir, listJobs, readJob} from './render-jobs.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const API = process.env.REEL_API || 'http://127.0.0.1:3333';
const TOK = process.env.REEL_BACKEND_TOKEN || (() => { try { return fs.readFileSync(path.join(ROOT, '.backend-token'), 'utf8').trim(); } catch { return ''; } })();
const DIR = jobsDir(PUBLIC);

const USAGE = `usage: npm run render -- <command>
  start <project_id> [--draft] [--mode full|layers] [--wait]
                                           queue an export, print its job id at once
  status <job_id> [--watch]                progress / file of a job
  list [--project <id>] [--active] [--limit n]
  cancel <job_id>
  prune [--days n]
  (--json on any command: JSON output)`;

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt; };
const optValues = new Set(['project', 'limit', 'days', 'mode'].map((n) => opt(n)).filter(Boolean));
const [cmd, arg] = argv.filter((a) => !a.startsWith('--') && !optValues.has(a));
const asJson = flags.has('--json');

const api = async (route, opts = {}) => {
  const r = await fetch(`${API}${route}`, {...opts, headers: {...(TOK ? {'x-reel-token': TOK} : {}), ...(opts.headers ?? {})}});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${route}: HTTP ${r.status}`);
  return j;
};
const backendUp = () => fetch(`${API}/api/health`, {signal: AbortSignal.timeout(2500), headers: TOK ? {'x-reel-token': TOK} : {}}).then((r) => r.ok, () => false);
const needBackend = async () => { if (!(await backendUp())) die(`the reel-agent backend is not running at ${API} — run \`npm start\``); };
function die(msg, code = 1) { console.error(msg); process.exit(code); }
const out = (obj, line) => console.log(asJson ? JSON.stringify(obj, null, 2) : line);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJob(id) {
  if (await backendUp()) return {job: await api(`/api/render-jobs/${id}`), live: true};
  const job = readJob(DIR, id);
  if (!job) die(`no render job ${id}`);
  return {job: {...job, ahead: aheadOf(listJobs(DIR), id)}, live: false};
}
function show(job, live) {
  const extra = [];
  if (job.status === 'done' && job.result?.qc) extra.push(job.result.qc);
  if (!live) extra.push('(backend not running — read from disk)');
  out(job, [describeJob(job, {ahead: job.ahead ?? 0}), ...extra].join('\n'));
}
// follow a job to its end: one line per change (a TTY rewrites it in place)
async function follow(id) {
  let last = '';
  for (;;) {
    const {job, live} = await getJob(id);
    const line = describeJob(job, {ahead: job.ahead ?? 0});
    if (!asJson && line !== last) {
      if (process.stdout.isTTY) process.stdout.write(`\r\x1b[K${line}`); else console.log(line);
      last = line;
    }
    if (!['queued', 'running'].includes(job.status)) {
      if (process.stdout.isTTY && !asJson) process.stdout.write('\n');
      if (asJson) out(job);
      else if (job.status === 'done' && job.result?.qc) console.log(job.result.qc);
      process.exit(job.status === 'done' ? 0 : 1);
    }
    if (!live) die('\nthe backend stopped — the job resumes when it starts again (`npm run render -- status ' + id + ' --watch`)');
    await sleep(2000);
  }
}

switch (cmd) {
  case 'start': {
    if (!arg || !/^[\w-]+$/.test(arg)) die(USAGE, 2);
    const f = path.join(PUBLIC, 'projects', `${arg}.json`);
    if (!fs.existsSync(f)) die(`project ${arg} not found in public/projects/`);
    const p = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!p.clips?.length) die(`project ${arg} has no clips`);
    await needBackend();
    const draft = flags.has('--draft');
    const mode = opt('mode');
    if (mode && !['full', 'layers'].includes(mode)) die('--mode is full or layers', 2);
    const r = await api('/api/render', {method: 'POST', body: JSON.stringify({...projectRenderProps(p), draft, project_id: arg, ...(mode ? {mode} : {})})});
    if (!asJson || !flags.has('--wait')) out(r, `${r.jobId}  ${draft ? 'draft' : 'final'} ${arg}  ${r.ahead ? `QUEUED — ${r.ahead} render${r.ahead === 1 ? '' : 's'} ahead` : 'STARTED'}\n  follow: npm run render -- status ${r.jobId} --watch\n  cancel: npm run render -- cancel ${r.jobId}`);
    if (flags.has('--wait')) await follow(r.jobId);
    break;
  }
  case 'status': {
    if (!arg) die(USAGE, 2);
    if (flags.has('--watch')) await follow(arg);
    const {job, live} = await getJob(arg);
    show(job, live);
    break;
  }
  case 'list': {
    const limit = Math.max(1, Math.min(200, +opt('limit', 20) || 20));
    const project = opt('project');
    const active = flags.has('--active');
    const live = await backendUp();
    const q = new URLSearchParams({limit: String(limit), ...(project ? {project} : {}), ...(active ? {status: 'queued,running'} : {})});
    const all = live ? null : listJobs(DIR);
    const jobs = live ? (await api(`/api/render-jobs?${q}`)).jobs : listJobs(DIR, {projectId: project, status: active ? ['queued', 'running'] : undefined, limit}).map((j) => ({...j, ahead: aheadOf(all, j.id)}));
    out(jobs, jobs.length ? jobs.map((j) => describeJob(j, {ahead: j.ahead ?? 0})).join('\n') + (live ? '' : '\n(backend not running — read from disk)') : 'no render jobs');
    break;
  }
  case 'cancel': {
    if (!arg) die(USAGE, 2);
    await needBackend();
    const j = await api(`/api/render-jobs/${arg}/cancel`, {method: 'POST', body: '{}'});
    out(j, j.pending ? `${arg} cancelling — its render process is being stopped` : `${arg} cancelled`);
    break;
  }
  case 'prune': {
    await needBackend();
    const days = opt('days');
    const r = await api('/api/render-jobs/prune', {method: 'POST', body: JSON.stringify(days != null ? {days: +days} : {})});
    out(r, `pruned ${r.removed.length} finished job${r.removed.length === 1 ? '' : 's'} (state only; the mp4s stay)`);
    break;
  }
  default:
    die(USAGE, cmd ? 2 : 0);
}
