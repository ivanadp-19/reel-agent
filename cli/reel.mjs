#!/usr/bin/env node
// reel — operate reel-agent from a shell on the box that runs its backend. Its main
// user is an agent (Codex, Claude Code) over SSH: every command takes --json (one JSON
// document on stdout — errors too, as {error, code, hint} — and an exit code ≠ 0 on
// error), nothing prompts or animates (the upload bar is drawn only on a TTY),
// `reel help --json` describes every command, flag and exit code. It talks only to the
// backend's HTTP API (REEL_URL, default http://127.0.0.1:3333) with the caller's own
// token (REEL_TOKEN or ~/.config/reel/token, mode 0600) and never reads the server's
// files. The flow: cli/AGENTS.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {PRESETS} from '../src/captionPresets.ts';
import {projectTiers, repage} from '../src/paging.ts';
import {applyAutocut, reanchor, totalDurationFrames} from '../src/timeline.ts';
import {newProject} from '../mcp/checks.mjs';

export const SCHEMA_VERSION = 1;
const FPS = 30;
const CHUNK = 8 * 2 ** 20;
const VIDEO = /\.(mp4|mov|m4v|webm|mkv|avi|mts)$/i;

// ---- errors: a code per failure, an exit code per family ----
export const EXIT = {
  ok: 0, error: 1, bad_usage: 2, confirm_required: 2,
  no_token: 3, bad_token: 3, token_required: 3, token_file_mode: 3, unauthorized: 3, forbidden: 3,
  not_found: 4, conflict: 5, revision_mismatch: 5, render_busy: 5, exists: 5, upload_incomplete: 5,
  too_large: 6, low_disk: 6, low_memory: 6, backend_unreachable: 7, render_failed: 8, invalid: 9, timeout: 124,
};
export class CliError extends Error {
  constructor(code, message, hint, extra = {}) { super(message); this.code = code; this.hint = hint; this.extra = extra; }
}
const STATUS_CODE = {400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 405: 'bad_request', 409: 'conflict', 411: 'bad_request', 413: 'too_large', 429: 'rate_limited', 503: 'low_memory', 507: 'low_disk'};
const STATUS_HINT = {401: 'check your token: reel doctor', 403: 'your token may not do this', 404: 'check the id: reel projects list / reel jobs list'};

// ---- config: the API address and the caller's token (never printed, never logged) ----
export function loadToken(env = process.env, home = os.homedir()) {
  if (env.REEL_TOKEN) return {token: env.REEL_TOKEN.trim(), source: 'REEL_TOKEN'};
  const file = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'reel', 'token');
  let st;
  try { st = fs.statSync(file); } catch { return {token: null, source: null, file}; }
  if (st.mode & 0o077) throw new CliError('token_file_mode', `${file} is readable by other users (mode ${(st.mode & 0o777).toString(8)})`, `chmod 600 ${file}`);
  return {token: fs.readFileSync(file, 'utf8').trim() || null, source: file};
}

// ---- HTTP over node:http: no body or header deadline of its own (an ingest can be quiet for minutes) ----
function request(ctx, method, route, {body, headers = {}, idleMs = 60e3, toStream} = {}) {
  const url = new URL(route, ctx.base);
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {method, timeout: idleMs, headers: {...(ctx.token ? {'x-reel-token': ctx.token} : {}), ...headers}}, (res) => {
      if (toStream && res.statusCode >= 200 && res.statusCode < 300) {
        pipeline(res, toStream).then(() => resolve({status: res.statusCode, headers: res.headers, body: Buffer.alloc(0)}), reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('no answer'), {code: 'ETIMEDOUT'})));
    req.on('error', reject);
    if (body == null || typeof body === 'string' || Buffer.isBuffer(body)) req.end(body);
    else body.pipe(req);
  });
}
const netError = (ctx, e) => e.code === 'ETIMEDOUT'
  ? new CliError('timeout', `no answer from ${ctx.base} in time`, 'the backend may be busy; retry')
  : new CliError('backend_unreachable', `cannot reach the backend at ${ctx.base} (${e.code || e.message})`, 'is the backend running? REEL_URL sets its address');
const parse = (buf) => { const t = buf.toString(); try { return JSON.parse(t || '{}'); } catch { return {error: t.slice(0, 200)}; } };
export function httpError(status, data) {
  const extra = {status};
  for (const k of ['jobId', 'size', 'updatedAt', 'revision']) if (data[k] != null) extra[k] = data[k];
  return new CliError(data.code || STATUS_CODE[status] || (status >= 500 ? 'server_error' : 'http_error'), data.error || `HTTP ${status}`, data.hint || STATUS_HINT[status], extra);
}
// JSON in and out; GETs are retried on network errors (safe), writes are not
async function api(ctx, method, route, {json, ...opts} = {}) {
  const tries = method === 'GET' ? 3 : 1;
  for (let i = 1; ; i++) {
    let r;
    try {
      r = await request(ctx, method, route, {...opts, ...(json !== undefined ? {body: JSON.stringify(json), headers: {'content-type': 'application/json', ...opts.headers}} : {})});
    } catch (e) {
      if (i >= tries) throw netError(ctx, e);
      await sleep(400 * i);
      continue;
    }
    const data = parse(r.body);
    if (r.status >= 400) throw httpError(r.status, data);
    return data;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)])).toString();

// ---- projects ----
const PROJECT_ID = /^[\w-]+$/;
const needId = (id, what = 'project') => { if (!id || !PROJECT_ID.test(id)) throw new CliError('bad_usage', `a ${what} id is required (letters, digits, _ -)`, 'reel projects list'); return id; };
export const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
async function getProject(ctx, id) { return api(ctx, 'GET', `/api/projects/${needId(id)}`); }
// the caption pages with the server's revision of them (server/captions-revision.mjs)
async function getCaptions(ctx, id) {
  const r = await api(ctx, 'GET', `/api/projects/${needId(id)}/captions`);
  return {revision: r.revision, captionsOff: !!r.captionsOff, captionStyle: r.captionStyle ?? null, captions: r.captions ?? []};
}
// read → change → write with the backend's compare-and-swap on updatedAt; a writer that
// lost the race (the editor, an agent) reads again and redoes its change
async function updateProject(ctx, id, change, tries = 4) {
  for (let i = 1; ; i++) {
    const p = await getProject(ctx, id);
    const patch = change(p);
    if (!patch) return {project: p, changed: false};
    try {
      const r = await api(ctx, 'POST', `/api/projects/${id}`, {json: {...patch, updatedAt: p.updatedAt}});
      return {project: {...p, ...patch, updatedAt: r.updatedAt}, changed: true};
    } catch (e) {
      if (e.extra?.status !== 409 || i >= tries) throw e;
    }
  }
}
// a project by id, or by its name (`projects create` keeps the name the user typed)
async function resolveProject(ctx, ref) {
  if (!ref) throw new CliError('bad_usage', 'a project id or name is required', 'reel projects list');
  if (PROJECT_ID.test(ref)) {
    try { await getProject(ctx, ref); return ref; } catch (e) { if (e.code !== 'not_found') throw e; }
  }
  const hits = (await api(ctx, 'GET', '/api/projects')).filter((p) => p.name === ref);
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1) throw new CliError('conflict', `${hits.length} projects are named "${ref}": ${hits.map((p) => p.id).join(', ')}`, 'pass the id');
  throw new CliError('not_found', `no project with id or name "${ref}"`, 'reel projects list');
}
// `projects set` flags → the project fields they write (the MCP's set_language / set_caption_style / rename_project)
export const LANGS = ['auto', 'es', 'en'];
export function projectPatch(o) {
  const patch = {};
  if (o.lang != null) {
    const lang = o.lang.trim().toLowerCase();
    if (!LANGS.includes(lang)) throw new CliError('bad_usage', `--lang takes a language code, not "${o.lang}"`, `one of: ${LANGS.join(', ')} (auto = detect per clip)`);
    patch.lang = lang;
  }
  if (o['caption-style'] != null) {
    if (!Object.hasOwn(PRESETS, o['caption-style'])) throw new CliError('bad_usage', `no caption style "${o['caption-style']}"`, `one of: ${Object.keys(PRESETS).join(', ')}`);
    patch.captionStyle = o['caption-style'];
  }
  if (o.name != null) {
    if (!o.name.trim()) throw new CliError('bad_usage', '--name cannot be empty');
    patch.name = o.name;
  }
  return patch;
}
// the autocut plan against the clips it was made for: the clips after it and what it removes
export function autocutPlan(clips, plan) {
  const {clips: after, remap} = applyAutocut(clips, plan);
  const sec = (cs) => +(totalDurationFrames(cs, FPS) / FPS).toFixed(2);
  return {clips: after, remap, before: {clips: clips.length, durationSec: sec(clips)}, after: {clips: after.length, durationSec: sec(after)}, removedSec: +(sec(clips) - sec(after)).toFixed(2),
    changed: plan.map((x) => ({id: x.id, segments: x.segments.map((g) => ({inSec: +g.inSec.toFixed(3), outSec: +g.outSec.toFixed(3)}))}))};
}
// a backend pipeline job (captions, autocut): start it, poll it, hand back its status when done
async function runJob(ctx, route, body, {timeout, what, retry}) {
  const {jobId} = await api(ctx, 'POST', route, {json: body});
  const limit = +(timeout ?? 1800), t0 = Date.now();
  let last = '';
  for (;;) {
    const s = await api(ctx, 'GET', `${route}/${jobId}`);
    if (!ctx.json && s.label && s.label !== last) { ctx.err(`${s.progress ?? 0}% ${s.label}`); last = s.label; }
    if (s.status === 'done') return s;
    if (s.status === 'error') throw new CliError('job_failed', s.error || `${what} failed`);
    if (s.status === 'unknown') throw new CliError('job_failed', `the ${what} job vanished (backend restarted?)`, retry);
    if ((Date.now() - t0) / 1000 > limit) throw new CliError('timeout', `${what} still running after ${limit}s`, 'retry with a longer --timeout');
    await sleep(ctx.pollMs);
  }
}
const durationSec = (p) => +(totalDurationFrames(p.clips ?? [], FPS) / FPS).toFixed(2);
const summary = (id, p) => ({id, name: p.name, clips: (p.clips ?? []).map((c) => ({id: c.id, label: c.label, src: c.src, inSec: c.inSec, outSec: c.outSec})), captions: (p.captions ?? []).length, captionsOff: !!p.captionsOff, captionStyle: p.captionStyle ?? null, durationSec: durationSec(p), updatedAt: p.updatedAt ?? null});

// ---- clips: a server path when the backend may read it, else a resumable upload ----
function videoFiles(target) {
  let st;
  try { st = fs.statSync(target); } catch { throw new CliError('not_found', `no such file or folder: ${target}`); }
  if (!st.isDirectory()) return [path.resolve(target)];
  return fs.readdirSync(target).filter((n) => VIDEO.test(n) && !n.startsWith('.')).sort().map((n) => path.resolve(target, n));
}
// a file is known by name, size and mtime: adding it twice keeps one clip
const ingestKey = (file, st) => `${path.basename(file)}:${st.size}:${Math.floor(st.mtimeMs)}`;

async function uploadFile(ctx, file, st, key) {
  const id = crypto.createHash('sha256').update(`${fs.realpathSync(file)}\n${key}`).digest('hex').slice(0, 32);
  let size = (await api(ctx, 'GET', `/api/uploads/${id}`)).size;
  const bar = ctx.progress(path.basename(file), st.size);
  const fd = fs.openSync(file, 'r');
  try {
    for (let fails = 0; size < st.size;) {
      bar(size);
      const buf = Buffer.alloc(Math.min(CHUNK, st.size - size));
      fs.readSync(fd, buf, 0, buf.length, size);
      try {
        size = (await api(ctx, 'PUT', `/api/uploads/${id}?offset=${size}`, {body: buf, headers: {'content-type': 'application/octet-stream', 'content-length': buf.length}})).size;
        fails = 0;
      } catch (e) {
        if (e.code === 'offset_mismatch' && Number.isInteger(e.extra.size)) { size = e.extra.size; continue; }
        if (!['backend_unreachable', 'timeout', 'server_error'].includes(e.code) || ++fails > 8) throw e;
        await sleep(Math.min(15e3, 500 * 2 ** fails));
        size = (await api(ctx, 'GET', `/api/uploads/${id}`)).size;
      }
    }
    bar(size, true);
  } finally {
    fs.closeSync(fd);
  }
  return api(ctx, 'POST', `/api/add-clip?${q({name: path.basename(file), upload: id, size: st.size})}`, {idleMs: 0});
}
async function ingest(ctx, file, st, key, {upload}) {
  if (!upload) {
    try {
      return {clip: await api(ctx, 'POST', `/api/add-clip?${q({name: path.basename(file), path: file})}`, {idleMs: 0}), via: 'path'};
    } catch (e) {
      // the backend may not read it for this user (or at all): send the bytes instead
      if (!['path_not_allowed', 'forbidden', 'bad_request'].includes(e.code)) throw e;
    }
  }
  return {clip: await uploadFile(ctx, file, st, key), via: 'upload'};
}

// ---- captions ----
function readJsonArg(ctx, src) {
  let text;
  try { text = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(ctx.cwd, src), 'utf8'); } catch { throw new CliError('not_found', `cannot read ${src}`); }
  try { return JSON.parse(text); } catch (e) { throw new CliError('bad_usage', `${src} is not JSON: ${e.message}`); }
}
export function checkCaptions(v) {
  const list = Array.isArray(v) ? v : v?.captions;
  if (!Array.isArray(list)) throw new CliError('bad_usage', 'captions: a JSON array of pages, or {captions: [...]} as `reel captions get --json` prints it');
  const ids = new Set();
  list.forEach((c, i) => {
    const bad = (why) => { throw new CliError('invalid', `caption ${i}${c?.id ? ` (${c.id})` : ''}: ${why}`, 'pages look like the ones `reel captions get --json` prints'); };
    if (!c || typeof c !== 'object') bad('not an object');
    if (typeof c.id !== 'string' || !c.id) bad('id missing');
    if (ids.has(c.id)) bad('duplicate id');
    ids.add(c.id);
    if (typeof c.src !== 'string') bad('src missing');
    if (!Number.isFinite(c.startMs) || !Number.isFinite(c.endMs) || c.endMs <= c.startMs) bad('startMs < endMs required');
    if (!Array.isArray(c.words) || c.words.some((w) => typeof w?.text !== 'string' || !Number.isFinite(w.startMs) || !Number.isFinite(w.endMs))) bad('words: [{text, startMs, endMs}]');
  });
  return list;
}
const pageText = (c) => c.words.map((w) => w.text).join(' ');
// page by page, by id: what a `captions set` of `next` would change
export function diffCaptions(prev, next) {
  const before = new Map(prev.map((c) => [c.id, c]));
  const after = new Map(next.map((c) => [c.id, c]));
  const changed = [];
  for (const [id, c] of after) {
    const b = before.get(id);
    if (!b) continue;
    const fields = [...new Set([...Object.keys(b), ...Object.keys(c)])].filter((k) => JSON.stringify(b[k]) !== JSON.stringify(c[k])).sort();
    if (fields.length) changed.push({id, fields, ...(pageText(b) !== pageText(c) ? {text: [pageText(b), pageText(c)]} : {})});
  }
  return {added: [...after.keys()].filter((id) => !before.has(id)), removed: [...before.keys()].filter((id) => !after.has(id)), changed};
}
const fmtMs = (ms) => `${(ms / 1000).toFixed(2)}s`;

// ---- render ----
const ACTIVE = new Set(['queued', 'running']);
function jobLine(j) {
  const kind = j.draft ? 'draft' : 'final';
  const head = `${j.id}  ${kind}${j.projectId ? ` ${j.projectId}` : ''}  ${String(j.status).toUpperCase()}`;
  if (j.status === 'queued') return `${head} — ${j.ahead ? `${j.ahead} ahead` : 'next'}`;
  if (j.status === 'running') return `${head} ${j.progress ?? 0}% — ${j.label || j.stage || 'working'}${Number.isFinite(j.etaSec) ? ` · ~${Math.round(j.etaSec)}s left` : ''}`;
  if (j.status === 'done') return `${head} → ${j.result?.file ?? ''}${j.result?.mode ? ` [${j.result.mode}${j.result.master ? `, master ${j.result.master}` : ''}]` : ''}`;
  return `${head}${j.error ? ` — ${j.error}` : ''}`;
}
const planLines = (plan) => !plan ? [] : plan.full
  ? [`complete render (${plan.mode}${plan.master ? `, master ${plan.master}` : ''}) because:`, ...plan.reasons.map((r) => `  - ${r}`)]
  : [`layers: master cached — only the caption layer is rendered`];
async function waitJob(ctx, id, timeoutSec) {
  const t0 = Date.now();
  let last = '';
  for (;;) {
    const j = await api(ctx, 'GET', `/api/render-jobs/${needId(id, 'job')}`);
    const line = jobLine(j);
    if (!ACTIVE.has(j.status)) return j;
    if (!ctx.json && line !== last) { ctx.err(line); last = line; }
    if (timeoutSec > 0 && (Date.now() - t0) / 1000 >= timeoutSec) throw new CliError('timeout', `render ${id} still ${j.status} after ${timeoutSec}s (it keeps going)`, `reel render wait ${id} --timeout <s>`, {job: j});
    await sleep(ctx.pollMs);
  }
}
const finished = (j) => {
  if (j.status === 'done') return j;
  throw new CliError('render_failed', `render ${j.id} ${j.status}${j.error ? `: ${j.error}` : ''}`, j.status === 'failed' ? 'reel render status <id> --json has the details' : undefined, {job: j});
};

// ---- the commands: run + what `reel help --json` says about them ----
const F = {
  json: {type: 'boolean', description: 'machine output: one JSON document on stdout (errors: {error, code, hint})'},
};
export const COMMANDS = [
  {name: 'help', args: '[command]', summary: 'this help; --json describes every command, flag, output and exit code', examples: ['reel help --json', 'reel help render start'],
    run: async (ctx, [first, second]) => {
      const pick = COMMANDS.find((c) => c.name === [first, second].filter(Boolean).join(' ')) ?? COMMANDS.find((c) => c.name === first);
      const doc = first ? (pick ? describe(pick) : null) : helpDoc();
      if (first && !doc) throw new CliError('bad_usage', `no command ${first}${second ? ` ${second}` : ''}`, 'reel help');
      return [doc, first ? helpText([pick]) : helpText(COMMANDS)];
    }},
  {name: 'whoami', summary: 'who the backend takes you for (checks the connection and the token)', output: '{user, admin, via, url, tokenSource}', examples: ['reel whoami --json'],
    run: async (ctx) => {
      const w = await api(ctx, 'GET', '/api/whoami');
      const out = {...w, url: ctx.base, tokenSource: ctx.tokenSource};
      return [out, `${w.user ?? '(no user)'}${w.admin ? ' (admin)' : ''} via ${w.via} at ${ctx.base}`];
    }},
  {name: 'doctor', summary: 'connection, token, free disk / memory, render queue — what is wrong and how to fix it', output: '{ok, checks: [{id, ok, detail, hint?}]}', examples: ['reel doctor --json'],
    run: async (ctx) => {
      const checks = [];
      const add = (id, ok, detail, hint) => checks.push({id, ok, detail, ...(ok ? {} : {hint})});
      add('node', +process.versions.node.split('.')[0] >= 24, `node ${process.versions.node}`, 'Node 24 is required');
      add('token', !!ctx.token, ctx.token ? `token from ${ctx.tokenSource}` : 'no token', 'put yours in ~/.config/reel/token (chmod 600) or REEL_TOKEN — an admin makes it: reel token create <you> --out <file>');
      let who = null;
      try { who = await api(ctx, 'GET', '/api/whoami'); add('backend', true, `reachable at ${ctx.base}`); } catch (e) { add('backend', e.code !== 'backend_unreachable', e.message, e.hint); if (e.code !== 'backend_unreachable') add('auth', false, e.message, e.hint); }
      if (who) {
        add('auth', !!who.user || who.admin, who.user ? `${who.user}${who.admin ? ' (admin)' : ''} via ${who.via}` : `anonymous (${who.via})`, 'without a user token there is no per-user render slot, and REEL_REQUIRE_TOKEN backends refuse you');
        try {
          const h = await api(ctx, 'GET', '/api/health');
          const r = h.resources ?? {};
          add('disk', r.freeDiskMb == null || !r.minDiskMb || r.freeDiskMb >= r.minDiskMb, `${r.freeDiskMb ?? '?'} MB free (render floor ${r.minDiskMb} MB)`, 'free disk: old exports go with scripts/cleanup-exports.mjs --apply (admin)');
          add('memory', r.freeMemMb == null || !r.minMemMb || r.freeMemMb >= r.minMemMb, r.freeMemMb == null ? 'not measured on this OS' : `${r.freeMemMb} MB available (render floor ${r.minMemMb} MB)`, 'renders are refused while memory is this low — retry later');
          for (const c of h.checks ?? []) if (!c.optional && c.id !== 'node') add(c.id, c.ok, c.label, c.hint);
        } catch (e) { add('health', false, e.message, e.hint); }
        try {
          const {jobs = [], workers} = await api(ctx, 'GET', `/api/render-jobs?${q({status: 'queued,running', limit: 50})}`);
          const mine = jobs.filter((j) => who.user && j.user === who.user);
          add('queue', true, `${jobs.filter((j) => j.status === 'running').length} running, ${jobs.filter((j) => j.status === 'queued').length} queued (${workers} at a time)${mine.length ? ` — yours: ${mine.map((j) => `${j.id} ${j.status}`).join(', ')}` : ''}`);
        } catch (e) { add('queue', false, e.message, e.hint); }
      }
      const ok = checks.every((c) => c.ok);
      const text = checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'} ${c.id.padEnd(8)} ${c.detail}${c.ok ? '' : `\n              → ${c.hint}`}`).join('\n');
      if (!ok) throw new CliError('doctor_failed', `${checks.filter((c) => !c.ok).map((c) => c.id).join(', ')} failed`, checks.find((c) => !c.ok).hint, {checks, text});
      return [{ok, checks}, text];
    }},

  {name: 'projects list', summary: 'every project, newest first', output: '{projects: [{id, name, clips, updatedAt}]}', examples: ['reel projects list --json'],
    run: async (ctx) => {
      const list = (await api(ctx, 'GET', '/api/projects')).map(({thumb, ...p}) => p);
      return [{projects: list}, list.length ? list.map((p) => `${p.id}  ${p.name}  (${p.clips} clip${p.clips === 1 ? '' : 's'}, ${p.updatedAt ?? 'never saved'})`).join('\n') : 'no projects'];
    }},
  {name: 'projects show', args: '<project>', flags: {full: {type: 'boolean', description: 'the whole project JSON'}}, summary: 'one project: clips, caption count, duration', output: '{id, name, clips: [{id, label, src, inSec, outSec}], captions, captionsOff, captionStyle, durationSec, updatedAt} (--full: the project JSON)', examples: ['reel projects show promo-cafe --json'],
    run: async (ctx, [id], o) => {
      const p = await getProject(ctx, id);
      const s = summary(id, p);
      return [o.full ? {id, ...p} : s, [`${s.id}  ${s.name}  ${s.durationSec}s  ${s.captions} caption pages${s.captionsOff ? ' (off)' : ''}  style ${s.captionStyle}`, ...s.clips.map((c) => `  ${c.id}  ${c.label ?? ''}  ${c.inSec}–${c.outSec}s`)].join('\n')];
    }},
  {name: 'projects create', args: '<name>', flags: {id: {type: 'string', description: 'the project id (default: the name as a slug)'}}, summary: 'a new empty project; creating one that exists with the same name returns it (safe to retry)', output: '{id, name, created}', examples: ['reel projects create "Promo café" --json', 'reel projects create "Promo café" --id promo-cafe-v2'],
    run: async (ctx, [name], o) => {
      if (!name) throw new CliError('bad_usage', 'a project name is required', 'reel projects create "<name>"');
      const id = o.id ?? slug(name);
      if (!id || !PROJECT_ID.test(id)) throw new CliError('bad_usage', `no usable id from "${name}"`, 'pass --id <letters-digits>');
      let existing = null;
      try { existing = await getProject(ctx, id); } catch (e) { if (e.code !== 'not_found') throw e; }
      if (existing) {
        if (existing.name !== name) throw new CliError('exists', `project ${id} exists with another name (${existing.name})`, 'pick another --id');
        return [{id, name, created: false}, `${id} already exists`];
      }
      await api(ctx, 'POST', `/api/projects/${id}`, {json: newProject(name)});
      return [{id, name, created: true}, `created ${id}`];
    }},
  {name: 'projects set', args: '<project|name>', flags: {lang: {type: 'string', description: `transcription language code: ${LANGS.join(', ')} (auto = detect per clip)`}, 'caption-style': {type: 'string', description: 'the caption style pack (reel help projects set --json lists them)', choices: Object.keys(PRESETS)}, name: {type: 'string', description: 'rename the project'}, timeout: {type: 'string', description: 'seconds to wait for the re-paging (default 1800)'}},
    summary: 'set the language, the caption style pack or the name of a project (the project by id or name); a new style re-pages the generated captions, keeping tiers and hand-made pages; setting what is already set changes nothing',
    output: '{project, changed, set: {lang?, captionStyle?, name?}, captions}', examples: ['reel projects set promo-cafe --lang es --json', 'reel projects set "Promo café" --caption-style caja --json'],
    run: async (ctx, [ref], o) => {
      const patch = projectPatch(o);
      if (!Object.keys(patch).length) throw new CliError('bad_usage', 'nothing to set', 'reel projects set <project> --lang es | --caption-style <pack> | --name "<name>"');
      const id = await resolveProject(ctx, ref);
      const p = await getProject(ctx, id);
      // a new pack re-pages the generated captions, as the MCP's set_caption_style does
      let fresh = null;
      if (patch.captionStyle && patch.captionStyle !== p.captionStyle && p.clips?.length && p.captions?.length) {
        const s = await runJob(ctx, '/api/captions', {clips: p.clips, lang: patch.lang ?? p.lang ?? 'auto', style: patch.captionStyle, offMic: p.offMic ?? 'mark', tiers: projectTiers(p.captions, true), project_id: id}, {timeout: o.timeout, what: 'captions', retry: `reel projects set ${id} --caption-style ${patch.captionStyle}`});
        if (!Array.isArray(s.result)) throw new CliError('job_failed', 'the captions job returned no pages', 'is the backend up to date?');
        fresh = s.result;
      }
      const {project, changed} = await updateProject(ctx, id, (cur) => {
        const next = {...patch};
        if (fresh) {
          // a new pack: re-paged as the MCP's set_caption_style does (src/paging.ts repage)
          const r = repage(cur.captions ?? [], fresh, cur.clips ?? [], {hidden: cur.hiddenWids ?? [], replace: true, repropose: true});
          next.captions = r.captions; next.hiddenWids = r.hidden;
        }
        return Object.entries(next).every(([k, v]) => JSON.stringify(cur[k]) === JSON.stringify(v)) ? null : next;
      });
      const set = Object.fromEntries(Object.keys(patch).map((k) => [k, project[k]]));
      return [{project: id, changed, set, captions: (project.captions ?? []).length}, `${id}: ${Object.entries(set).map(([k, v]) => `${k} ${v}`).join(', ')}${changed ? '' : ' (already set)'}${fresh ? ` — ${project.captions.length} caption pages re-paged` : ''}`];
    }},
  {name: 'projects delete', args: '<project>', flags: {yes: {type: 'boolean', description: 'required: deleting cannot be undone'}}, summary: 'delete a project (its media stays); deleting one that is gone is not an error', output: '{id, deleted}', examples: ['reel projects delete old-test --yes --json'],
    run: async (ctx, [id], o) => {
      needId(id);
      if (!o.yes) throw new CliError('confirm_required', `deleting ${id} cannot be undone`, `reel projects delete ${id} --yes`);
      await api(ctx, 'DELETE', `/api/projects/${id}`);
      return [{id, deleted: true}, `deleted ${id}`];
    }},

  {name: 'clips add', args: '<project> <file|folder>...', flags: {upload: {type: 'boolean', description: 'always upload (skip handing the backend the path)'}},
    summary: 'add videos to the end of the timeline: the backend reads the path when it may (your file, or readable by everyone), else a resumable chunked upload with retries (30–500 MB files); a file added before is skipped (safe to retry)',
    output: '{project, added: [{file, clip, via: path|upload, ingest?}], skipped: [{file, clip}], clips}', examples: ['reel clips add promo-cafe ~/shoot/take3.mp4 --json', 'reel clips add promo-cafe ~/shoot/ --json'],
    run: async (ctx, [id, ...targets], o) => {
      needId(id);
      if (!targets.length) throw new CliError('bad_usage', 'files or a folder are required', 'reel clips add <project> <file|folder>...');
      const files = targets.flatMap((t) => videoFiles(path.resolve(ctx.cwd, t)));
      if (!files.length) throw new CliError('not_found', 'no video files there', 'mp4 mov m4v webm mkv avi mts');
      const known = new Map(((await getProject(ctx, id)).clips ?? []).filter((c) => c.srcKey).map((c) => [c.srcKey, c.id]));
      const added = [], skipped = [];
      for (const file of files) {
        if (!VIDEO.test(file)) throw new CliError('bad_usage', `not a video file: ${file}`);
        const st = fs.statSync(file);
        const key = ingestKey(file, st);
        if (known.has(key)) { skipped.push({file, clip: known.get(key)}); continue; }
        const {clip: r, via} = await ingest(ctx, file, st, key, o);
        const {ingest: note, ...clip} = r;
        clip.srcKey = key;
        // saved clip by clip: a failure later keeps what is in
        await updateProject(ctx, id, (p) => ((p.clips ?? []).some((c) => c.srcKey === key) ? null : {clips: [...(p.clips ?? []), clip]}));
        known.set(key, clip.id);
        added.push({file, clip: clip.id, via, ...(note ? {ingest: note} : {})});
        if (!ctx.json) ctx.err(`added ${clip.id} (${(clip.outSec ?? 0).toFixed(1)}s, ${via})${note ? ` — ${note}` : ''}`);
      }
      const p = await getProject(ctx, id);
      return [{project: id, added, skipped, clips: (p.clips ?? []).length}, `${id}: ${added.length} added, ${skipped.length} already there, ${(p.clips ?? []).length} clips on the timeline`];
    }},

  {name: 'autocut', args: '<project|name>', flags: {'dry-run': {type: 'boolean', description: 'print the plan (clips before / after, segments kept) and change nothing'}, timeout: {type: 'string', description: 'seconds to wait for the analysis (default 1800)'}},
    summary: 'remove the silence at the ends of each clip and the long pauses inside it (the editor\'s / MCP\'s autocut step): clips are split into their speech segments, B-roll follows them; the project by id or name',
    output: '{project, changed, dryRun, before: {clips, durationSec}, after: {clips, durationSec}, removedSec, plan: [{id, segments: [{inSec, outSec}]}]}', examples: ['reel autocut promo-cafe --dry-run --json', 'reel autocut promo-cafe --json'],
    run: async (ctx, [ref], o) => {
      const id = await resolveProject(ctx, ref);
      const p = await getProject(ctx, id);
      if (!p.clips?.length) throw new CliError('invalid', `project ${id} has no clips`, 'reel clips add first');
      const s = await runJob(ctx, '/api/trim-silence', {clips: p.clips, lang: p.lang ?? 'auto', offMic: p.offMic ?? 'mark', project_id: id}, {timeout: o.timeout, what: 'autocut', retry: `reel autocut ${id}`});
      // the plan comes in the job status when the backend hands it back, else from the file the job writes (as the editor reads it)
      const plan = s.result?.plan ?? (await api(ctx, 'GET', `/trim-silence.json?_=${Date.now()}`).catch(() => null))?.plan;
      if (!Array.isArray(plan)) throw new CliError('job_failed', 'the autocut job returned no plan', `reel autocut ${id}`);
      // the file is shared by every autocut of the backend: a plan for other clips is another job's
      const ids = new Set(p.clips.map((c) => c.id));
      if (plan.some((x) => !ids.has(x.id))) throw new CliError('conflict', 'the autocut plan names clips this project does not have (another autocut ran at the same time)', `reel autocut ${id}`);
      const r = autocutPlan(p.clips, plan);
      const out = {project: id, changed: false, dryRun: !!o['dry-run'], before: r.before, after: r.after, removedSec: r.removedSec, plan: r.changed};
      const line = `${id}: ${r.before.clips} clip(s) ${r.before.durationSec}s → ${r.after.clips} clip(s) ${r.after.durationSec}s (−${r.removedSec}s)`;
      if (!plan.length) return [out, `${id}: nothing to cut`];
      if (o['dry-run']) return [out, `${line} — dry run, nothing saved`];
      const {changed} = await updateProject(ctx, id, (cur) => {
        // the plan is by clip id and source seconds: a timeline edited meanwhile needs a new analysis
        if (JSON.stringify(cur.clips ?? []) !== JSON.stringify(p.clips)) throw new CliError('conflict', `the clips of ${id} changed while autocut ran`, `reel autocut ${id}`);
        return {clips: r.clips, brolls: reanchor(cur.brolls ?? [], r.remap)};
      });
      return [{...out, changed}, line];
    }},
  {name: 'captions get', args: '<project>', summary: 'the caption pages (source-relative ms, words with tiers) and their revision (changes whenever anyone changes the pages)', output: '{project, revision, captionsOff, captionStyle, captions: [page]}', examples: ['reel captions get promo-cafe --json > caps.json'],
    run: async (ctx, [id]) => {
      const p = await getCaptions(ctx, id);
      const caps = p.captions;
      return [{project: id, revision: p.revision, captionsOff: p.captionsOff, captionStyle: p.captionStyle, captions: caps}, [`revision ${p.revision}`, ...(caps.length ? caps.map((c) => `${c.id}  ${fmtMs(c.startMs)}–${fmtMs(c.endMs)}  ${pageText(c)}`) : ['no captions (reel captions generate)'])].join('\n')];
    }},
  {name: 'captions generate', args: '<project>', flags: {timeout: {type: 'string', description: 'seconds to wait (default 1800)'}},
    summary: 'transcribe and page the speech into captions (the editor\'s / MCP\'s captions step); pages already on a clip are kept',
    output: '{project, added, captions}', examples: ['reel captions generate promo-cafe --json'],
    run: async (ctx, [id], o) => {
      const p = await getProject(ctx, id);
      if (!p.clips?.length) throw new CliError('invalid', `project ${id} has no clips`, 'reel clips add first');
      const s = await runJob(ctx, '/api/captions', {clips: p.clips, lang: p.lang ?? 'auto', style: p.captionStyle ?? 'palabra', offMic: p.offMic ?? 'mark', tiers: projectTiers(p.captions ?? []), project_id: id}, {timeout: o.timeout, what: 'captions', retry: `reel captions generate ${id}`});
      if (!Array.isArray(s.result)) throw new CliError('job_failed', 'the captions job returned no pages', 'is the backend up to date?');
      let added = 0;
      const {project} = await updateProject(ctx, id, (cur) => {
        const r = repage(cur.captions ?? [], s.result, cur.clips ?? [], {hidden: cur.hiddenWids ?? []});
        added = r.added;
        return {captions: r.captions, hiddenWids: r.hidden};
      });
      return [{project: id, added, captions: project.captions.length}, `${id}: +${added} caption pages (${project.captions.length} total)`];
    }},
  {name: 'captions set', args: '<project> <file.json|->', flags: {'expected-revision': {type: 'string', description: 'the revision `captions get` printed: refused (exit 5, revision_mismatch) when the pages changed since'}},
    summary: 'replace the caption pages with a JSON file (or stdin); only the captions change, so a layers render reuses the cached master; the same pages again change nothing',
    output: '{project, changed, count, revision, diff: {added, removed, changed}}', examples: ['reel captions set promo-cafe caps.json --expected-revision "$(jq -r .revision caps.json)" --json', 'jq ... caps.json | reel captions set promo-cafe - --json'],
    run: async (ctx, [id, src], o) => {
      needId(id);
      if (!src) throw new CliError('bad_usage', 'a JSON file (or - for stdin) is required', 'reel captions set <project> caps.json');
      const expected = o['expected-revision'];
      if (expected != null && !/^[\w-]{1,64}$/.test(expected)) throw new CliError('bad_usage', '--expected-revision takes the revision `reel captions get --json` prints');
      const next = checkCaptions(readJsonArg(ctx, src));
      // the server checks the revision and writes in one step; without --expected-revision the one
      // just read is sent, and a writer that got in between makes us read again and redo the diff
      for (let i = 1; ; i++) {
        const cur = await getCaptions(ctx, id);
        const diff = diffCaptions(cur.captions, next);
        try {
          const r = await api(ctx, 'PUT', `/api/projects/${id}/captions`, {json: {captions: next, expectedRevision: expected ?? cur.revision}});
          return [{project: id, changed: r.changed, count: next.length, revision: r.revision, diff}, r.changed ? `${id}: ${next.length} pages (+${diff.added.length} −${diff.removed.length} ~${diff.changed.length}), revision ${r.revision}` : `${id}: unchanged (revision ${r.revision})`];
        } catch (e) {
          if (e.code !== 'revision_mismatch' || expected != null || i >= 4) throw e;
        }
      }
    }},
  {name: 'captions diff', args: '<project> <file.json|->', summary: 'what `captions set` of that file would change, page by page', output: '{project, added: [id], removed: [id], changed: [{id, fields, text?: [before, after]}]}', examples: ['reel captions diff promo-cafe caps.json --json'],
    run: async (ctx, [id, src]) => {
      if (!src) throw new CliError('bad_usage', 'a JSON file (or - for stdin) is required');
      const d = diffCaptions((await getProject(ctx, id)).captions ?? [], checkCaptions(readJsonArg(ctx, src)));
      const lines = [...d.added.map((x) => `+ ${x}`), ...d.removed.map((x) => `- ${x}`), ...d.changed.map((c) => `~ ${c.id} ${c.fields.join(',')}${c.text ? `: "${c.text[0]}" → "${c.text[1]}"` : ''}`)];
      return [{project: id, ...d}, lines.join('\n') || 'no differences'];
    }},
  {name: 'captions validate', args: '<project>', summary: 'the deterministic checks before a render (safe zones, timing, emphasis, overlaps, off-mic words left in); exit 9 when there are errors',
    output: '{project, ok, issues: [{level: error|warn, code, msg}]}', examples: ['reel captions validate promo-cafe --json'],
    run: async (ctx, [id]) => {
      const r = await api(ctx, 'GET', `/api/validate/${needId(id)}`);
      const text = r.issues.length ? r.issues.map((i) => `${i.level === 'error' ? 'ERR ' : 'WARN'} ${i.code}: ${i.msg}`).join('\n') : 'OK — no issues';
      if (!r.ok) throw new CliError('invalid', `${r.issues.filter((i) => i.level === 'error').length} error(s) in ${id}`, 'fix them, then validate again', {project: id, ok: false, issues: r.issues, text});
      return [{project: id, ...r}, text];
    }},

  {name: 'render start', args: '<project>', flags: {draft: {type: 'boolean', description: 'half resolution, fast, no review version'}, mode: {type: 'string', description: 'layers (default: reuses the cached master when only captions changed) | full'}, plan: {type: 'boolean', description: 'only say what the render would do; queue nothing'}, wait: {type: 'boolean', description: 'follow it to the end'}, timeout: {type: 'string', description: 'with --wait: seconds (default 0 = no limit)'}},
    summary: 'queue an export of the saved project and return its job id at once; says whether it is a complete render and why. One render at a time per user: the same render again returns the same job (safe to retry)',
    output: '{jobId, status, ahead, reused?, plan: {mode, full, master?, reasons}} (--wait: the finished job)', examples: ['reel render start promo-cafe --json', 'reel render start promo-cafe --plan --json', 'reel render start promo-cafe --draft --wait --timeout 900 --json'],
    run: async (ctx, [id], o) => {
      needId(id);
      const mode = o.mode ?? 'layers';
      if (!['layers', 'full'].includes(mode)) throw new CliError('bad_usage', '--mode is layers or full');
      const body = {project_id: id, draft: !!o.draft, mode};
      if (o.plan) {
        const {plan} = await api(ctx, 'POST', '/api/render?plan=1', {json: body});
        return [{project: id, plan}, planLines(plan).join('\n')];
      }
      const r = await api(ctx, 'POST', '/api/render', {json: body});
      const text = [`${r.jobId}  ${o.draft ? 'draft' : 'final'} ${id}  ${r.reused ? `ALREADY ${String(r.status).toUpperCase()} (same render)` : r.ahead ? `QUEUED — ${r.ahead} ahead` : 'STARTED'}`, ...planLines(r.plan)].join('\n');
      if (!o.wait) return [r, `${text}\n  follow: reel render wait ${r.jobId}`];
      if (!ctx.json) ctx.err(text);
      const j = finished(await waitJob(ctx, r.jobId, +(o.timeout ?? 0)));
      return [j, jobLine(j)];
    }},
  {name: 'render status', args: '<job>', summary: 'where a render job is: queued (how many ahead), running (stage, %, ETA), done (file, mode, master), failed', output: 'the job: {id, status, stage, progress, etaSec?, ahead, draft, projectId, user?, result?: {file, mode, master?, fallback?, qc?, version?}, error?}', examples: ['reel render status 1758800000000abc123 --json'],
    run: async (ctx, [job]) => {
      const j = await api(ctx, 'GET', `/api/render-jobs/${needId(job, 'job')}`);
      return [j, jobLine(j)];
    }},
  {name: 'render wait', args: '<job>', flags: {timeout: {type: 'string', description: 'seconds (default 0 = no limit); on timeout exit 124 and the render keeps going'}}, summary: 'block until the job ends: exit 0 done, 8 failed or cancelled, 124 timeout', output: 'the finished job (as render status)', examples: ['reel render wait 1758800000000abc123 --timeout 1200 --json'],
    run: async (ctx, [job], o) => {
      const j = finished(await waitJob(ctx, job, +(o.timeout ?? 0)));
      return [j, jobLine(j)];
    }},
  {name: 'render download', args: '<job>', flags: {out: {type: 'string', description: 'file to write (default: the export\'s name in the current folder)'}}, summary: 'save the finished mp4; an interrupted download resumes, one already complete is not fetched again', output: '{job, file, bytes, skipped?}', examples: ['reel render download 1758800000000abc123 --out promo.mp4 --json'],
    run: async (ctx, [job], o) => {
      const route = `/api/render-jobs/${needId(job, 'job')}/file`;
      let head;
      try { head = await request(ctx, 'HEAD', route); } catch (e) { throw netError(ctx, e); }
      if (head.status >= 400) throw httpError(head.status, parse((await request(ctx, 'GET', route).catch((e) => { throw netError(ctx, e); })).body));
      const total = +head.headers['content-length'];
      const name = /filename="([^"]+)"/.exec(head.headers['content-disposition'] ?? '')?.[1] ?? `${job}.mp4`;
      const out = path.resolve(ctx.cwd, o.out ?? name);
      if (fs.existsSync(out) && fs.statSync(out).size === total) return [{job, file: out, bytes: total, skipped: true}, `${out} already complete`];
      const part = `${out}.part`;
      for (let fails = 0; ;) {
        const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
        if (have >= total) break;
        try {
          const r = await request(ctx, 'GET', route, {headers: {range: `bytes=${have}-`, 'if-range': head.headers.etag ?? ''}, toStream: fs.createWriteStream(part, {flags: have ? 'a' : 'w'})});
          if (r.status === 200 && have) { fs.rmSync(part, {force: true}); continue; } // the file changed: whole again
          if (r.status >= 400) throw httpError(r.status, parse(r.body));
        } catch (e) {
          if (e instanceof CliError && e.code !== 'server_error') throw e;
          if (++fails > 6) throw e instanceof CliError ? e : netError(ctx, e);
          await sleep(Math.min(15e3, 500 * 2 ** fails));
        }
      }
      fs.renameSync(part, out);
      return [{job, file: out, bytes: total}, `saved ${out} (${(total / 2 ** 20).toFixed(1)} MB)`];
    }},
  {name: 'render cancel', args: '<job>', summary: 'cancel a queued or running render (its files are removed)', output: 'the job, with pending: true while its process stops', examples: ['reel render cancel 1758800000000abc123 --json'],
    run: async (ctx, [job]) => {
      const j = await api(ctx, 'POST', `/api/render-jobs/${needId(job, 'job')}/cancel`, {json: {}});
      return [j, `${job} ${j.pending ? 'cancelling' : 'cancelled'}`];
    }},

  {name: 'review-link', args: '<project>', flags: {days: {type: 'string', description: 'days the link lives (default 30, at most 30)'}, list: {type: 'boolean', description: 'the versions and live links instead of a new link'}, revoke: {type: 'string', description: 'revoke this link id'}},
    summary: 'a private review link (mobile page) for the latest final render that passed QC; every call makes a new link — --list shows them, --revoke ends one',
    output: '{project, url, id, expiresAt} (--list: {versions, links}; --revoke: the link)', examples: ['reel review-link promo-cafe --json', 'reel review-link promo-cafe --list --json', 'reel review-link promo-cafe --revoke 1a2b3c4d --json'],
    run: async (ctx, [id], o) => {
      needId(id);
      if (o.list) {
        const r = await api(ctx, 'GET', `/api/reviews/${id}`);
        return [r, [...r.versions.map((v) => `v${v.v}  ${v.createdAt ?? ''}${v.playable ? '' : '  (file gone)'}`), ...r.links.map((l) => `link ${l.id}  ${l.revokedAt ? 'revoked' : `until ${l.expiresAt}`}`)].join('\n') || 'no versions yet'];
      }
      if (o.revoke) {
        const l = await api(ctx, 'DELETE', `/api/reviews/${id}/links/${o.revoke}`);
        return [l, `revoked ${o.revoke}`];
      }
      const l = await api(ctx, 'POST', `/api/reviews/${id}/links`, {json: o.days ? {days: +o.days} : {}});
      return [{project: id, url: l.url, id: l.id, expiresAt: l.expiresAt}, `${l.url}\n  link ${l.id}, until ${l.expiresAt} (revoke: reel review-link ${id} --revoke ${l.id})`];
    }},

  {name: 'jobs list', flags: {project: {type: 'string', description: 'only this project'}, active: {type: 'boolean', description: 'only queued and running'}, mine: {type: 'boolean', description: 'only the ones you submitted'}, limit: {type: 'string', description: 'at most n (default 20)'}},
    summary: 'render jobs, newest first', output: '{workers, jobs: [job]}', examples: ['reel jobs list --active --json', 'reel jobs list --mine --json'],
    run: async (ctx, _, o) => {
      const r = await api(ctx, 'GET', `/api/render-jobs?${q({project: o.project, status: o.active ? 'queued,running' : null, limit: o.mine ? 200 : (o.limit ?? 20)})}`);
      let jobs = r.jobs;
      if (o.mine) { const me = (await api(ctx, 'GET', '/api/whoami')).user; jobs = jobs.filter((j) => me && j.user === me).slice(0, +(o.limit ?? 20)); }
      return [{workers: r.workers, jobs}, jobs.length ? jobs.map(jobLine).join('\n') : 'no render jobs'];
    }},

  {name: 'token create', args: '<user>', admin: true, flags: {out: {type: 'string', description: 'required: file to write the token to (created 0600, never overwritten) — it is never printed'}, admin: {type: 'boolean', description: 'may manage tokens'}, uid: {type: 'string', description: 'the user\'s Unix uid, so the backend may read that user\'s own files by path (default: id -u <user> when that user exists here)'}},
    summary: '(admin) a token for a person or agent; hand them the file (it goes to their ~/.config/reel/token, 0600)', output: '{id, user, admin, uid, out}', examples: ['reel token create ana --out /tmp/ana.token --json'],
    run: async (ctx, [user], o) => {
      if (!user) throw new CliError('bad_usage', 'a user name is required');
      if (!o.out) throw new CliError('bad_usage', '--out <file> is required: the token is written there, never printed');
      const out = path.resolve(ctx.cwd, o.out);
      if (fs.existsSync(out)) throw new CliError('exists', `${out} exists`, 'pick a new file: tokens are never overwritten');
      try { fs.accessSync(path.dirname(out), fs.constants.W_OK); } catch { throw new CliError('bad_usage', `cannot write in ${path.dirname(out)}`); }
      let uid = o.uid != null ? +o.uid : ctx.uidOf(user);
      if (uid != null && !Number.isInteger(uid)) throw new CliError('bad_usage', '--uid is a number');
      const t = await api(ctx, 'POST', '/api/tokens', {json: {user, admin: !!o.admin, uid}});
      const {token, ...rec} = t;
      try { fs.writeFileSync(out, `${token}\n`, {mode: 0o600, flag: 'wx'}); } catch (e) {
        await api(ctx, 'DELETE', `/api/tokens/${rec.id}`).catch(() => {}); // a token nobody holds must not live
        throw new CliError('error', `could not write ${out} (${e.code}); token ${rec.id} revoked`, 'retry with another --out');
      }
      return [{...rec, out}, `token ${rec.id} for ${rec.user}${rec.admin ? ' (admin)' : ''} written to ${out} — install it as their ~/.config/reel/token (0600)`];
    }},
  {name: 'token list', admin: true, summary: '(admin) every token: id, user, admin, created, revoked (never the secrets)', output: '{tokens: [{id, user, admin, uid, createdAt, revokedAt?}]}', examples: ['reel token list --json'],
    run: async (ctx) => {
      const r = await api(ctx, 'GET', '/api/tokens');
      return [r, r.tokens.map((t) => `${t.id}  ${t.user}${t.admin ? ' (admin)' : ''}  ${t.revokedAt ? `revoked ${t.revokedAt}` : `since ${t.createdAt}`}`).join('\n') || 'no tokens'];
    }},
  {name: 'token revoke', args: '<id|user>', admin: true, summary: '(admin) revoke one token by id, or every token of a user; revoking again is not an error', output: '{revoked: [id]}', examples: ['reel token revoke ana --json'],
    run: async (ctx, [who]) => {
      if (!who) throw new CliError('bad_usage', 'a token id or a user is required');
      const r = await api(ctx, 'DELETE', `/api/tokens/${encodeURIComponent(who)}`);
      return [r, r.revoked.length ? `revoked ${r.revoked.join(', ')}` : 'nothing to revoke'];
    }},
];

// ---- help ----
const usage = (c) => `reel ${c.name}${c.args ? ` ${c.args}` : ''}${Object.keys(c.flags ?? {}).map((f) => ` [--${f}${c.flags[f].type === 'string' ? ' <v>' : ''}]`).join('')} [--json]`;
const describe = (c) => ({name: c.name, usage: usage(c), summary: c.summary, args: c.args ?? '', flags: {...c.flags, ...F}, output: c.output ?? null, examples: c.examples ?? [], ...(c.admin ? {admin: true} : {})});
export function helpDoc() {
  return {
    name: 'reel', schemaVersion: SCHEMA_VERSION,
    about: 'reel-agent from a shell on the box that runs its backend: projects, clips, captions, validate, render, review links. Every command takes --json.',
    env: {REEL_URL: 'backend address (default http://127.0.0.1:3333)', REEL_TOKEN: 'your token (else ~/.config/reel/token, mode 0600)'},
    output: 'with --json: one JSON document on stdout — the command\'s output, or {error, code, hint, ...} with a non-zero exit code',
    exitCodes: {0: 'ok', 1: 'other error', 2: 'bad usage / confirmation required', 3: 'no or bad token, not allowed', 4: 'not found', 5: 'conflict: exists, busy (one render per user), changed meanwhile', 6: 'resources: disk, memory, size', 7: 'backend unreachable', 8: 'render failed or cancelled', 9: 'validation errors', 124: 'timeout (the work goes on)'},
    flow: ['reel projects create "<name>"', 'reel projects set <project> --lang es --caption-style <pack>', 'reel clips add <project> <files|folder>', 'reel autocut <project> [--dry-run]', 'reel captions generate <project>', 'reel captions get <project> --json > caps.json  (edit)  reel captions diff/set <project> caps.json', 'reel captions validate <project>', 'reel render start <project> --wait', 'reel review-link <project>'],
    commands: COMMANDS.map(describe),
  };
}
const helpText = (cmds) => ['reel — reel-agent from a shell (every command takes --json; reel help --json describes everything)', '', ...cmds.map((c) => `  ${usage(c).padEnd(60)} ${c.summary}`), '', 'env: REEL_URL (default http://127.0.0.1:3333), REEL_TOKEN or ~/.config/reel/token (0600)'].join('\n');

// ---- main: argv → one command → stdout / stderr / exit code ----
export async function main(argv, {env = process.env, stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), home = os.homedir(), pollMs = 2000, uidOf = unixUid} = {}) {
  const json = argv.includes('--json');
  const write = (s) => stdout.write(s.endsWith('\n') ? s : `${s}\n`);
  try {
    const words = argv.filter((a) => !a.startsWith('-'));
    const cmd = COMMANDS.find((c) => c.name === words.slice(0, 2).join(' ')) ?? COMMANDS.find((c) => c.name === words[0]);
    if (!cmd) {
      if (!words.length || argv.includes('--help') || argv.includes('-h')) { write(json ? JSON.stringify(helpDoc()) : helpText(COMMANDS)); return 0; }
      throw new CliError('bad_usage', `unknown command: ${words.slice(0, 2).join(' ')}`, 'reel help');
    }
    const rest = argv.slice(argv.indexOf(cmd.name.split(' ').at(-1)) + 1);
    let values, positionals;
    try {
      ({values, positionals} = parseArgs({args: rest, options: {...cmd.flags, ...F, help: {type: 'boolean', short: 'h'}}, allowPositionals: true, strict: true}));
    } catch (e) { throw new CliError('bad_usage', e.message, `reel help ${cmd.name}`); }
    if (values.help) { write(json ? JSON.stringify(describe(cmd)) : helpText([cmd])); return 0; }
    const tok = cmd.name === 'help' ? {token: null, source: null} : loadToken(env, home);
    const ctx = {
      base: (env.REEL_URL || 'http://127.0.0.1:3333').replace(/\/+$/, ''), token: tok.token, tokenSource: tok.source, json, cwd, pollMs, uidOf,
      err: (s) => stderr.write(`${s}\n`),
      // an upload bar on a TTY only; nothing when piped or with --json
      progress: (label, total) => (!json && stderr.isTTY ? (done, end) => stderr.write(`\r${label} ${Math.floor((done / total) * 100)}% (${(done / 2 ** 20).toFixed(0)}/${(total / 2 ** 20).toFixed(0)} MB)${end ? '\n' : ''}`) : () => {}),
    };
    const [data, text] = await cmd.run(ctx, positionals, values);
    write(json ? JSON.stringify(data) : text);
    return 0;
  } catch (e) {
    const err = e instanceof CliError ? e : new CliError('error', e?.message ?? String(e));
    const {text, ...extra} = err.extra ?? {};
    if (json) write(JSON.stringify({error: err.message, code: err.code, ...(err.hint ? {hint: err.hint} : {}), ...extra}));
    else stderr.write(`${text ? `${text}\n` : ''}error: ${err.message}${err.hint ? `\nhint: ${err.hint}` : ''}\n`);
    return EXIT[err.code] ?? 1;
  }
}
// the Unix uid of a user on this box (token create), null when there is none
function unixUid(user) {
  try { const out = execFileSync('id', ['-u', user], {stdio: ['ignore', 'pipe', 'ignore']}).toString().trim(); return /^\d+$/.test(out) ? +out : null; } catch { return null; }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
