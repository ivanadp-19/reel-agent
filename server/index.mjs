// Editor backend (port 3333):
//   projects   — multi-project library (list/get/save/delete)
//   add-clip   — upload video → remux/encode + thumbnail → return clip
//   music      — upload an audio track
//   transcribe — per-source WhisperX, words per clip for the agent (job)
//   captions   — words → caption pages + face-aware placement (job)
//   trim-silence — autocut plan (job)
//   render     — export the MultiClip composition to mp4: a job persisted on disk, queued,
//                cancellable (/api/render, /api/render-jobs; scripts/render-jobs.mjs); a final that
//                passes QC becomes a review version of its project (720p proxy + poster, scripts/reviews.mjs)
//   reviews    — review links per project (/api/reviews/…), the public pages /r/<token> (server/review.mjs)
//   health     — environment checks for the Start screen (ffmpeg, WhisperX, keys)
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {totalDurationFrames} from '../src/timeline.ts';
import {cube, hlgToSdr, pqToSdr} from '../src/hdr.ts';
import {lutBakes} from '../src/grade.ts';
import {brandSchema} from '../src/brand.ts';
import {FONT_FILE, clientFont} from '../src/fonts.ts';
import {ensureSfx} from '../scripts/sfx.mjs';
import {renderPlan} from '../scripts/render-queue.mjs';
import {localizeRemoteBrolls, runCmd} from '../scripts/remote-broll.mjs';
import {aheadOf, createRenderJobs, jobsDir} from '../scripts/render-jobs.mjs';
import {createRenderRunner} from '../scripts/render-runner.mjs';
import {ALPHA, createMasterCache} from '../scripts/layers.mjs';
import {logTiming, readTiming, summarize, timingText} from '../scripts/timing.mjs';
import {createLink, loadReviews, playableVersions, publicLink, reviewsDir, revokeLink} from '../scripts/reviews.mjs';
import {loadEntries, searchCatalog} from '../scripts/catalog.mjs';
import {gate, serveFile, tokenOk} from './http.mjs';
import {createLoginLimiter, handleLogin, trustedHops} from './session.mjs';
import {handleReview} from './review.mjs';
// sourcing, shared with the MCP tools: stock (Pexels), music (Openverse), decorative assets, the own B-roll library
import {searchStock} from '../mcp/stock.mjs';
import {creditOf, downloadMusic, loadMusicLibrary, searchMusic} from '../mcp/music.mjs';
import {findOrGenerate, librarySearch, listLibrary, searchAssets} from '../mcp/assets.mjs';
import {blackSpans, loadLibrary as loadBrollLibrary, searchLibrary as searchBrollLibrary, sheetFor, upsertAsset} from '../mcp/broll.mjs';

// HDR phone footage (HLG / PQ, BT.2020) is tone-mapped to SDR BT.709 at ingest
// through a 3D LUT computed in src/hdr.ts (this ffmpeg has no zscale); the
// LUT file is generated once into .models/luts/.
const HDR_TRC = {'arib-std-b67': ['hlg2sdr', hlgToSdr], smpte2084: ['pq2sdr', pqToSdr]};
function hdrLut(trc) {
  const [name, fn] = HDR_TRC[trc];
  const file = path.join(ROOT, '.models', 'luts', `${name}-33.cube`);
  if (!fs.existsSync(file)) { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, cube(fn, 33, name)); }
  return file;
}

// run a command async, resolve {code, stdout, stderr}
const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const c = spawn(cmd, args, {cwd: ROOT, ...opts});
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => resolve({code, stdout: out, stderr: err}));
    c.on('error', () => resolve({code: 1, stdout: out, stderr: err}));
  });

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const EXPORTS = path.join(PUBLIC, 'exports');
const PROJECTS_DIR = path.join(PUBLIC, 'projects');
const REVIEWS = reviewsDir(PUBLIC); // review versions + links, outside the project JSON (scripts/reviews.mjs)
fs.mkdirSync(EXPORTS, {recursive: true});
fs.mkdirSync(PROJECTS_DIR, {recursive: true});

// Per-run secret for calls that touch the local filesystem by path (the MCP
// server reads it from .backend-token). Other local pages/processes cannot
// make the backend ingest arbitrary files without it.
const TOKENS = (process.env.REEL_BACKEND_TOKEN || crypto.randomBytes(16).toString('hex')).split(',').map(t => t.trim()).filter(Boolean); // comma-separated: one per client, revocable individually
const TOKEN = TOKENS[0]; // primary, written to .backend-token for the local MCP client
fs.writeFileSync(path.join(ROOT, '.backend-token'), TOKEN, {mode: 0o600});
// our pid, so `npm run stop` can stop us by pid — never by a pkill pattern (see AGENTS.md)
fs.writeFileSync(path.join(ROOT, '.backend.pid'), String(process.pid));
process.once('exit', () => { try { if (fs.readFileSync(path.join(ROOT, '.backend.pid'), 'utf8') === String(process.pid)) fs.rmSync(path.join(ROOT, '.backend.pid')); } catch {} });

// backend work into the project's timing log (scripts/timing.mjs), when the request names the project
const logStage = (project, stage, ms, extra = {}) => project && logTiming(PROJECTS_DIR, project, {kind: 'stage', stage, ms, ...extra});
const captionJobs = {}; // jobId -> {status, progress, label, error}
const transcribeJobs = {}; // jobId -> {status, progress, label, error}
const trimJobs = {}; // jobId -> {status, progress, label, error}

const body = (req) =>
  new Promise((res) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => res(d));
  });

const json = (res, code, obj) => {
  res.writeHead(code, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(obj));
};

const musicRows = new Map(); // /api/music/search results by id, so /api/music/pick downloads only URLs Openverse gave us
const JOBS = {
  '/api/captions': {route: '/api/captions', stage: 'captions-paging', name: 'Captions', prefix: 'clips', script: 'scripts/captions-multiclip.mjs', store: captionJobs},
  '/api/trim-silence': {route: '/api/trim-silence', stage: 'autocut', name: 'Autocut', prefix: 'trim', script: 'scripts/trim-silence.mjs', store: trimJobs},
  '/api/transcribe': {route: '/api/transcribe', stage: 'transcribe', name: 'Transcribe', prefix: 'transcribe', script: 'scripts/transcribe.mjs', store: transcribeJobs},
  '/api/matte': {route: '/api/matte', stage: 'matte', name: 'Matte', prefix: 'matte', script: 'scripts/matte.mjs', store: {}},
  '/api/grade': {route: '/api/grade', stage: 'grade-analysis', name: 'Color analysis', prefix: 'grade', script: 'scripts/grade.mjs', store: {}},
  '/api/lut': {route: '/api/lut', stage: 'lut', name: 'LUT', prefix: 'lut', script: 'scripts/lut.mjs', store: {}},
};

// Turn a stderr tail into one line a user can act on.
function explainFailure(tail, fallback) {
  const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !/^(PROGRESS|TIMING):/.test(l));
  const known = [
    [/WhisperX is not installed|whisperx could not start|spawnSync \.venv\/bin\/whisperx/i, 'WhisperX is not installed — run `npm run setup` (creates .venv and installs whisperx)'],
    [/whisperx failed \(exit/i, null], // keep the script's own message (has the real whisperx error)
    [/ffmpeg.*(ENOENT|not found)|spawnSync ffmpeg/i, 'ffmpeg is not on PATH — install it (apt install ffmpeg / brew install ffmpeg)'],
    [/CUDA out of memory/i, 'GPU ran out of memory — set REEL_DEVICE=cpu in .env'],
    [/no clips/i, 'No clips on the timeline'],
  ];
  for (const l of lines) for (const [re, msg] of known) if (re.test(l)) return msg ?? l.replace(/^.*?Error: /, '').slice(0, 220);
  const meaningful = [...lines].reverse().find((l) => /error|failed|exception|traceback|not found|denied/i.test(l));
  return (meaningful || lines.at(-1) || fallback).replace(/\s+/g, ' ').slice(0, 220);
}

// ---- environment health (Start screen shows what is missing) ----
function readEnvFile() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {}
  return out;
}
let gpuProbe = null; // resolved once: 'cuda' | 'cpu' | null (no venv)
async function health() {
  const env = {...readEnvFile(), ...process.env};
  const ff = await run('ffmpeg', ['-version']);
  const fp = await run('ffprobe', ['-version']);
  const venv = fs.existsSync(path.join(ROOT, '.venv', 'bin', 'whisperx'));
  if (venv && gpuProbe === null) {
    const r = await run('.venv/bin/python', ['-c', 'import torch;print("cuda" if torch.cuda.is_available() else "cpu")']);
    gpuProbe = r.code === 0 ? r.stdout.trim() : 'cpu';
  }
  const forced = (env.REEL_DEVICE || '').toLowerCase();
  const checks = [
    {id: 'node', ok: +process.versions.node.split('.')[0] >= 24, label: `Node ${process.versions.node}`, hint: 'Node 24 is required (nvm install 24 && nvm use 24)'},
    {id: 'ffmpeg', ok: ff.code === 0 && fp.code === 0, label: ff.code === 0 ? `ffmpeg ${ff.stdout.match(/version (\S+)/)?.[1] ?? ''}` : 'ffmpeg', hint: 'Install ffmpeg (apt install ffmpeg / brew install ffmpeg) — needed for uploads, waveforms, exports'},
    {id: 'whisperx', ok: venv, label: venv ? `WhisperX (${forced || gpuProbe || 'cpu'})` : 'WhisperX', hint: 'Run `npm run setup` to create .venv and install WhisperX — needed for captions, autocut, transcripts'},
    {id: 'matte', ok: fs.existsSync(path.join(ROOT, '.models', 'selfie_segmenter.tflite')), label: 'Person segmenter (MediaPipe)', hint: 'Run `npm run setup` to install mediapipe + .models/selfie_segmenter.tflite — optional, needed for text behind the presenter', optional: true},
    {id: 'face', ok: fs.existsSync(path.join(ROOT, '.models', 'yunet.onnx')), label: 'Face detector (YuNet)', hint: 'Run `npm run setup` to download .models/yunet.onnx — optional, captions use the default position without it', optional: true},
    {id: 'pexels', ok: !!env.PEXELS_API_KEY, label: 'Pexels API key', hint: 'Add PEXELS_API_KEY to .env (free: pexels.com/api) — optional, stock B-roll fallback', optional: true},
    {id: 'openai', ok: !!env.OPENAI_API_KEY, label: 'OpenAI API key', hint: 'Add OPENAI_API_KEY to .env — optional, lets the agent generate stickers/textures (generate_asset)', optional: true},
  ];
  return {ok: checks.every((c) => c.ok || c.optional), checks};
}

// remote (Pexels) B-roll is downloaded into public/broll/ before a render (scripts/remote-broll.mjs:
// Pexels only, redirects re-checked, a deadline per download, abortable by the render job)
const BROLL_DIR = path.join(PUBLIC, 'broll');

// ---- render jobs (scripts/render-jobs.mjs + scripts/render-runner.mjs) ----
// A render is a job on disk (public/render-jobs/): POST /api/render answers with its
// id at once, the queue runs one at a time (REEL_RENDER_WORKERS = N for more), the
// status survives a restart, a job whose process dies is failed. The editor, the MCP
// (render, start_render, render_status, list_render_jobs, cancel_render) and the CLI
// (scripts/render-cli.mjs) all go through the routes below.
const PLAN = renderPlan();
// layered renders (scripts/layers.mjs, run by scripts/render-runner.mjs): masters cached outside public/ (never bundled, never committed)
const masterCache = createMasterCache(path.join(ROOT, '.render-cache', 'masters'));
const CAPTION_ALPHA = process.env.REEL_CAPTION_ALPHA in ALPHA ? process.env.REEL_CAPTION_ALPHA : 'png';
// the mode a render runs in when the request names none (full = the one-pass render)
const DEFAULT_MODE = process.env.REEL_RENDER_MODE === 'layers' ? 'layers' : 'full';
// LUT-graded copies the grade needs and does not have yet (a clip added after set_grade…):
// baked here, before the render, so no clip silently plays ungraded
async function bakeMissing(raw, id, {signal, setPid, progress} = {}) {
  const props = JSON.parse(raw);
  const g = props.grade;
  const missing = lutBakes(g, props.clips ?? [], props.mattes ?? []).filter((b) => !g.baked?.[b.key] || !fs.existsSync(path.join(PUBLIC, g.baked[b.key])));
  if (!missing.length) return raw;
  const inFile = path.join(ROOT, `.lut-${id}.json`), outFile = path.join(ROOT, '.captions-tmp', `lut-${id}.json`);
  fs.mkdirSync(path.dirname(outFile), {recursive: true});
  fs.writeFileSync(inFile, JSON.stringify({bake: missing}));
  progress?.(0.9, `Baking the LUT into ${missing.length} source${missing.length === 1 ? '' : 's'}`);
  let r;
  try { r = await runCmd('node', ['scripts/lut.mjs', inFile, outFile], {cwd: ROOT, signal, onPid: setPid}); }
  finally { fs.rmSync(inFile, {force: true}); }
  if (r.code !== 0) throw new Error(explainFailure(r.stderr, 'LUT bake failed'));
  g.baked = {...g.baked, ...JSON.parse(fs.readFileSync(outFile, 'utf8')).baked};
  fs.rmSync(outFile, {force: true});
  return JSON.stringify(props);
}
// before the render (inside its queue slot, so the submit answers at once): remote
// B-roll downloaded to disk, then the LUT bakes the grade still needs
// — both abortable: a cancel or the preparing stall limit stops them (the job's signal)
async function prepareRender(raw, id, {signal, setPid, progress} = {}) {
  const props = JSON.parse(raw);
  await localizeRemoteBrolls(props, {dir: BROLL_DIR, signal, onPid: setPid, progress: (f, label) => progress?.(f * 0.8, label)});
  return bakeMissing(JSON.stringify(props), id, {signal, setPid, progress});
}
const RENDER_JOBS = jobsDir(PUBLIC);
const renderJobs = createRenderJobs({
  dir: RENDER_JOBS,
  workers: PLAN.workers,
  // full or layers (master from the cache, caption layer, composite), then loudness + QC and the review version
  run: createRenderRunner({root: ROOT, publicDir: PUBLIC, exportsDir: EXPORTS, reviewsDir: REVIEWS, plan: PLAN, prepare: prepareRender, masterCache, captionAlpha: CAPTION_ALPHA, logStage}),
}).start();
// stopping (npm run stop, Ctrl-C in npm start): no render left running without a backend — the next start re-queues its job
for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { renderJobs.shutdown(); process.exit(0); });
console.log(`render queue: ${PLAN.workers} at a time × concurrency ${PLAN.concurrency}, default mode ${DEFAULT_MODE} — jobs in ${path.relative(ROOT, RENDER_JOBS)}/`);

// Who may reach what (server/http.mjs gate): loopback Host + localhost Origin
// locally (the editor, the MCP server, curl — DNS-rebinding and CSRF pages are
// refused); in Railway / public mode (REEL_PUBLIC=1) HTTP basic auth instead, with
// the bcrypt hashes from REEL_AUTH_BCRYPT ("user:$2a$...,user:$2a$...") - the same
// hashes Caddy uses on the VM, so existing passwords keep working and no secret
// crosses a chat. The review pages /r/<token> are the one public exception.
// Browsers that cannot answer the basic-auth dialog use the form at /login instead
// (server/session.mjs): same users, a signed session cookie keyed by
// REEL_SESSION_SECRET, else the first REEL_BACKEND_TOKEN; ≤ 5 failed logins per IP per
// minute, form and basic auth alike. The client IP comes from X-Forwarded-For only
// behind REEL_TRUST_PROXY trusted hops (Railway: 1, set in the Dockerfile).
const PUBLIC_MODE = process.env.REEL_PUBLIC === '1';
const AUTH = Object.fromEntries((process.env.REEL_AUTH_BCRYPT || '').split(',').filter(Boolean).map((pair) => { const i = pair.indexOf(':'); return [pair.slice(0, i), pair.slice(i + 1)]; }));
const SESSION_SECRET = process.env.REEL_SESSION_SECRET || TOKEN;
const LOGIN_LIMITER = createLoginLimiter({max: 5, windowMs: 60e3});
const TRUST_HOPS = trustedHops();
const DIST = path.join(ROOT, 'editor', 'dist');
function serveStatic(req, res, pathname) {
  const clean = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  for (const base of [PUBLIC, DIST]) {
    const file = path.join(base, clean);
    if (file.startsWith(base) && fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(req, res, file);
  }
  const index = path.join(DIST, 'index.html');
  if (fs.existsSync(index)) return serveFile(req, res, index);
  return json(res, 404, {error: 'not found'});
}
// Where a review link points: REEL_PUBLIC_URL (https://reels.example.com) when set,
// else the address this request came through (the proxy's forwarded host first).
function publicBase(req) {
  if (process.env.REEL_PUBLIC_URL) return process.env.REEL_PUBLIC_URL.replace(/\/+$/, '');
  const first = (h) => String(h || '').split(',')[0].trim();
  const host = first(req.headers['x-forwarded-host']) || req.headers.host || `127.0.0.1:${PORT}`;
  const proto = first(req.headers['x-forwarded-proto']) || 'http';
  return `${/^https?$/.test(proto) ? proto : 'http'}://${host}`;
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const g = await gate(req, url, {publicMode: PUBLIC_MODE, auth: AUTH, tokens: TOKENS, sessionSecret: SESSION_SECRET, limiter: LOGIN_LIMITER, hops: TRUST_HOPS});
  if (g.kind === 'review') return handleReview(req, res, url, {publicDir: PUBLIC}); // token-gated, read-only, never /exports/*
  if (g.kind === 'login') return handleLogin(req, res, url, {auth: AUTH, secret: SESSION_SECRET, limiter: LOGIN_LIMITER, hops: TRUST_HOPS, forceSecure: PUBLIC_MODE});
  if (g.kind === 'ping') return json(res, 200, {ok: true});
  if (g.kind === 'deny') { res.writeHead(g.status, g.headers); return res.end(g.body); }
  if (PUBLIC_MODE && req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, await health());

  // ---- multi-project library ----
  if (req.method === 'GET' && url.pathname === '/api/projects') {
    const list = fs.readdirSync(PROJECTS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const p = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf8'));
          return {
            id: f.replace(/\.json$/, ''),
            name: p.name || 'Untitled project',
            clips: p.clips?.length || 0,
            updatedAt: p.updatedAt || null,
            // thumbs are stored per SOURCE file (segments share their source's thumb)
            thumb: p.clips?.[0]?.src ? '/clips/thumbs/' + path.basename(p.clips[0].src).replace(/\.\w+$/, '.jpg') : null,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return json(res, 200, list);
  }
  if (url.pathname.startsWith('/api/projects/')) {
    const id = url.pathname.split('/').pop();
    if (!id || !/^[\w-]+$/.test(id)) return json(res, 400, {error: 'bad id'});
    const file = path.join(PROJECTS_DIR, `${id}.json`);
    if (req.method === 'GET') {
      if (!fs.existsSync(file)) return json(res, 404, {error: 'not found'});
      return json(res, 200, JSON.parse(fs.readFileSync(file, 'utf8')));
    }
    if (req.method === 'POST') {
      let incoming;
      try {
        incoming = JSON.parse((await body(req)) || '{}');
      } catch {
        return json(res, 400, {error: 'bad json'});
      }
      let prev = {};
      try {
        prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      } catch {
        /* corrupt previous file — overwrite */
      }
      // compare-and-swap: a writer that read an older version (editor vs agent)
      // is rejected instead of silently overwriting the other's work
      if (incoming.updatedAt && prev.updatedAt && incoming.updatedAt !== prev.updatedAt) return json(res, 409, {error: 'stale: project changed since you read it', updatedAt: prev.updatedAt});
      const now = new Date().toISOString();
      // merge: a writer that does not know a field (an older editor, a new
      // project setting) must not wipe it; clearing is done with null / []
      const saved = {...prev, ...incoming, createdAt: prev.createdAt || now, updatedAt: now};
      fs.writeFileSync(file, JSON.stringify(saved, null, 2));
      return json(res, 200, {ok: true, updatedAt: now});
    }
    if (req.method === 'DELETE') {
      fs.rmSync(file, {force: true});
      return json(res, 200, {ok: true});
    }
  }

  // ---- sourcing for the editor (the same modules the MCP tools use) ----
  const env = () => ({...readEnvFile(), ...process.env});
  const fail = (e) => json(res, 500, {error: String(e?.message ?? e).slice(0, 300)});
  if (req.method === 'GET' && url.pathname === '/api/stock') {
    const q = url.searchParams.get('q') || '';
    if (!q.trim()) return json(res, 400, {error: 'q required'});
    try { return json(res, 200, await searchStock(q, url.searchParams.get('kind') === 'image' ? 'image' : 'video', Math.min(10, +(url.searchParams.get('count') || 6)), env().PEXELS_API_KEY)); } catch (e) { return fail(e); }
  }
  if (req.method === 'GET' && url.pathname === '/api/music/search') {
    const q = url.searchParams.get('q') || '';
    if (q.trim().length < 2) return json(res, 400, {error: 'q required'});
    try {
      const rows = await searchMusic(q, {limit: Math.min(10, +(url.searchParams.get('limit') || 6)), minSec: +(url.searchParams.get('min_sec') || 20)});
      for (const r of rows) musicRows.set(r.id, r); // what pick may download: only what Openverse returned
      if (musicRows.size > 200) for (const k of [...musicRows.keys()].slice(0, musicRows.size - 200)) musicRows.delete(k);
      return json(res, 200, rows);
    } catch (e) { return fail(e); }
  }
  if (req.method === 'GET' && url.pathname === '/api/music/library') return json(res, 200, loadMusicLibrary());
  if (req.method === 'POST' && url.pathname === '/api/music/pick') {
    // the client names a track by id; the URL comes from the server's own search results or the library, never from the request
    let b; try { b = JSON.parse(await body(req)); } catch { return json(res, 400, {error: 'bad json'}); }
    const row = musicRows.get(String(b?.id ?? '')) ?? loadMusicLibrary().find((r) => r.id === b?.id);
    if (!row) return json(res, 404, {error: 'unknown track — search first'});
    try { const e = await downloadMusic(row); return json(res, 200, {src: e.src, credit: e.credit ?? creditOf(e)}); } catch (e) { return fail(e); }
  }
  if (req.method === 'GET' && url.pathname === '/api/assets') {
    const q = url.searchParams.get('q'), kind = url.searchParams.get('kind') || undefined;
    return json(res, 200, q ? librarySearch(q, {kind, limit: 30}) : listLibrary().filter((e) => !kind || e.kind === kind).slice(-30).reverse());
  }
  if (req.method === 'GET' && url.pathname === '/api/assets/search') {
    const q = url.searchParams.get('q') || '';
    if (!q.trim()) return json(res, 400, {error: 'q required'});
    try { return json(res, 200, await searchAssets({query: q, kind: url.searchParams.get('kind') || 'sticker', style: url.searchParams.get('style') || undefined, limit: Math.min(12, +(url.searchParams.get('limit') || 8))})); } catch (e) { return fail(e); }
  }
  if (req.method === 'POST' && url.pathname === '/api/assets/generate') {
    let b; try { b = JSON.parse(await body(req)); } catch { return json(res, 400, {error: 'bad json'}); }
    if (!b?.prompt || String(b.prompt).length < 3) return json(res, 400, {error: 'prompt required'});
    const e = env();
    try { return json(res, 200, await findOrGenerate({prompt: String(b.prompt).slice(0, 400), kind: b.kind, size: b.size, quality: b.quality, force: !!b.force, apiKey: e.OPENAI_API_KEY, model: e.REEL_IMAGE_MODEL || 'gpt-image-1.5'})); } catch (e) { return fail(e); }
  }
  if (req.method === 'GET' && url.pathname === '/api/broll-library') {
    const rows = searchBrollLibrary(url.searchParams.get('q') || '');
    return json(res, 200, rows.map((a) => { let sheet = null; try { sheet = '/' + path.relative(PUBLIC, sheetFor(a)).split(path.sep).join('/'); } catch {} return {...a, sheet}; }));
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/broll-library/')) {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    if (!loadBrollLibrary().some((a) => a.id === id)) return json(res, 404, {error: `no library asset ${id}`});
    let b; try { b = JSON.parse(await body(req)); } catch { return json(res, 400, {error: 'bad json'}); }
    const tags = Array.isArray(b.tags) ? b.tags.map((t) => String(t).trim()).filter((t) => t.length >= 2 && t.length <= 30).slice(0, 12) : undefined;
    return json(res, 200, upsertAsset({id, ...(tags ? {tags} : {}), ...(typeof b.desc === 'string' ? {desc: b.desc.trim().slice(0, 200)} : {})}));
  }
  // asset catalog (scripts/catalog.mjs): read-only here — building it is `node scripts/catalog.mjs` or MCP catalog_assets, never the backend
  if (req.method === 'GET' && url.pathname === '/api/catalog') {
    const q = url.searchParams;
    const bool = (k) => (q.has(k) ? q.get(k) === 'true' : undefined);
    const num = (k) => (q.has(k) && q.get(k) !== '' && Number.isFinite(+q.get(k)) ? +q.get(k) : undefined);
    const dir = q.get('dir') || undefined;
    if (dir && !/^[\w-]+(\/[\w-]+)*$/.test(dir)) return json(res, 400, {error: 'bad dir'});
    const list = (k) => (q.get(k) ? q.get(k).split(',').map((t) => t.trim()).filter(Boolean) : undefined);
    const rows = searchCatalog(loadEntries(PUBLIC, dir ? [dir] : undefined), {dir, kind: q.get('kind') || undefined, minSec: num('min_sec'), maxSec: num('max_sec'), daylight: q.get('daylight') || undefined, orientation: q.get('orientation') || undefined, hasBlack: bool('has_black'), maxBlackRatio: num('max_black_ratio'), hasSpeech: bool('has_speech'), tags: list('tags'), excludeTags: list('exclude_tags'), text: q.get('text') || undefined, limit: Math.min(500, num('limit') ?? 200)});
    return json(res, 200, rows);
  }
  if (req.method === 'GET' && url.pathname === '/api/black') {
    const src = url.searchParams.get('src') || '';
    if (!/^clips\/[\w.\-]+\.(mp4|mov|m4v|webm)$/i.test(src) || !fs.existsSync(path.join(PUBLIC, src))) return json(res, 400, {error: 'src must be a clip under public/clips'});
    try { return json(res, 200, blackSpans(src)); } catch (e) { return fail(e); }
  }

  // ---- brand kits: public/brands/<slug>.json (set_brand from / save_as, the Styles tab) ----
  const BRANDS = path.join(PUBLIC, 'brands');
  const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  if (req.method === 'GET' && url.pathname === '/api/brands') {
    let files = []; try { files = fs.readdirSync(BRANDS).filter((f) => f.endsWith('.json')); } catch {}
    return json(res, 200, files.map((f) => { try { return {slug: f.slice(0, -5), name: JSON.parse(fs.readFileSync(path.join(BRANDS, f), 'utf8')).name || f.slice(0, -5)}; } catch { return null; } }).filter(Boolean));
  }
  if (url.pathname.startsWith('/api/brands/')) {
    const id = slug(decodeURIComponent(url.pathname.split('/').pop()));
    if (!id) return json(res, 400, {error: 'bad kit name'});
    const file = path.join(BRANDS, `${id}.json`);
    if (req.method === 'GET') return fs.existsSync(file) ? json(res, 200, JSON.parse(fs.readFileSync(file, 'utf8'))) : json(res, 404, {error: 'not found'});
    if (req.method === 'POST') {
      let kit; try { kit = JSON.parse(await body(req)); } catch { return json(res, 400, {error: 'bad json'}); }
      // the same rule as set_brand (src/brand.ts): colors, fonts, font files, style
      const r = brandSchema.safeParse({...kit, name: kit?.name || id});
      if (!r.success) return json(res, 400, {error: r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ').slice(0, 300)});
      fs.mkdirSync(BRANDS, {recursive: true});
      fs.writeFileSync(file, JSON.stringify(r.data, null, 2));
      return json(res, 200, {slug: id});
    }
  }

  // ---- upload an image (brand logo) → public/brand/ ----
  if (req.method === 'POST' && url.pathname === '/api/upload-image') {
    const safe = (url.searchParams.get('name') || 'logo.png').replace(/[^\w.\-]/g, '_');
    if (!/\.(png|jpe?g|webp|svg)$/i.test(safe)) return json(res, 400, {error: 'png, jpg, webp or svg'});
    const dir = path.join(PUBLIC, 'brand');
    fs.mkdirSync(dir, {recursive: true});
    const ws = fs.createWriteStream(path.join(dir, safe));
    req.pipe(ws);
    ws.on('finish', () => json(res, 200, {src: `brand/${safe}`}));
    ws.on('error', () => json(res, 500, {error: 'write failed'}));
    return;
  }

  // ---- upload a client font file (brand kit) → public/fonts/ (gitignored, never in the repo) ----
  if (req.method === 'POST' && url.pathname === '/api/upload-font') {
    const safe = (url.searchParams.get('name') || '').replace(/[^\w.\-]/g, '_');
    if (!FONT_FILE.test(safe)) return json(res, 400, {error: 'a .ttf, .otf, .woff or .woff2 file'});
    const dir = path.join(PUBLIC, 'fonts');
    fs.mkdirSync(dir, {recursive: true});
    const ws = fs.createWriteStream(path.join(dir, safe));
    req.pipe(ws);
    ws.on('finish', () => json(res, 200, clientFont(`fonts/${safe}`))); // same guess as set_brand font_files
    ws.on('error', () => json(res, 500, {error: 'write failed'}));
    return;
  }

  // ---- LUTs (set_grade lut / create_lut, the Styles tab): public/luts/*.cube, reference photos under public/luts/refs/<name>/ ----
  if (req.method === 'GET' && url.pathname === '/api/luts') {
    let files = []; try { files = fs.readdirSync(path.join(PUBLIC, 'luts')).filter((f) => f.endsWith('.cube')); } catch {}
    return json(res, 200, files.map((f) => ({name: f.slice(0, -5), file: `luts/${f}`})));
  }
  if (req.method === 'POST' && (url.pathname === '/api/upload-lut' || url.pathname === '/api/upload-ref')) {
    const safe = (url.searchParams.get('name') || '').replace(/[^\w.\-]/g, '_');
    const lut = (url.searchParams.get('lut') || '').replace(/[^\w-]/g, '').slice(0, 40);
    const ref = url.pathname === '/api/upload-ref';
    if (ref ? !lut || !/\.(png|jpe?g|webp|heic|tiff?)$/i.test(safe) : !/\.cube$/i.test(safe)) return json(res, 400, {error: ref ? 'an image, with ?lut=<name>' : 'a .cube file'});
    const dir = ref ? path.join(PUBLIC, 'luts', 'refs', lut) : path.join(PUBLIC, 'luts');
    fs.mkdirSync(dir, {recursive: true});
    const ws = fs.createWriteStream(path.join(dir, safe));
    req.pipe(ws);
    ws.on('finish', () => json(res, 200, {file: path.relative(PUBLIC, path.join(dir, safe)).split(path.sep).join('/')}));
    ws.on('error', () => json(res, 500, {error: 'write failed'}));
    return;
  }

  // ---- upload a music track → public/music/ ----
  if (req.method === 'POST' && url.pathname === '/api/music') {
    const safe = (url.searchParams.get('name') || 'track.mp3').replace(/[^\w.\-]/g, '_');
    const dir = path.join(PUBLIC, 'music');
    fs.mkdirSync(dir, {recursive: true});
    const ws = fs.createWriteStream(path.join(dir, safe));
    req.pipe(ws);
    ws.on('finish', () => json(res, 200, {src: `music/${safe}`}));
    ws.on('error', () => json(res, 500, {error: 'write failed'}));
    return;
  }

  // ---- audio waveform peaks for a local media file (cached) ----
  if (req.method === 'GET' && url.pathname === '/api/waveform') {
    const src = url.searchParams.get('src') || '';
    if (!/^[\w\-./]+$/.test(src) || src.includes('..')) return json(res, 400, {error: 'bad src'});
    const abs = path.join(PUBLIC, src);
    if (!fs.existsSync(abs)) return json(res, 404, {error: 'not found'});
    const dir = path.join(PUBLIC, 'waveforms');
    fs.mkdirSync(dir, {recursive: true});
    const cache = path.join(dir, src.replace(/[^\w]/g, '_') + '.json');
    if (fs.existsSync(cache) && fs.statSync(cache).mtimeMs >= fs.statSync(abs).mtimeMs) {
      return json(res, 200, JSON.parse(fs.readFileSync(cache, 'utf8')));
    }
    // decode to mono 8kHz PCM and take max-abs peaks over ~1000 buckets
    const child = spawn('ffmpeg', ['-v', 'error', '-i', abs, '-ac', '1', '-ar', '8000', '-f', 's16le', '-']);
    const bufs = [];
    child.stdout.on('data', (d) => bufs.push(d));
    child.on('close', (code) => {
      if (code !== 0 || !bufs.length) return json(res, 500, {error: 'ffmpeg failed'});
      const buf = Buffer.concat(bufs);
      const samples = Math.floor(buf.length / 2);
      const N = 1000;
      const per = Math.max(1, Math.floor(samples / N));
      const peaks = new Array(N).fill(0);
      for (let i = 0; i < N; i++) {
        let m = 0;
        const start = i * per;
        const end = Math.min(samples, start + per);
        for (let j = start; j < end; j++) {
          const v = Math.abs(buf.readInt16LE(j * 2));
          if (v > m) m = v;
        }
        peaks[i] = Math.round((m / 32768) * 100) / 100;
      }
      const out = {peaks, durationSec: samples / 8000};
      fs.writeFileSync(cache, JSON.stringify(out));
      json(res, 200, out);
    });
    return;
  }

  // ---- add a B-roll asset (own footage/photo): upload → encode/thumbnail ----
  if (req.method === 'POST' && url.pathname === '/api/add-broll-asset') {
    const rawName = url.searchParams.get('name') || 'asset';
    const kind = url.searchParams.get('kind') === 'image' ? 'image' : 'video';
    const base = rawName.replace(/\.[^.]+$/, '').replace(/[^\w\-]/g, '_').slice(0, 40) || 'asset';
    const dir = path.join(PUBLIC, 'broll-assets');
    const thumbs = path.join(dir, 'thumbs');
    fs.mkdirSync(thumbs, {recursive: true});
    let id = base;
    let n = 2;
    const ext = kind === 'image' ? 'jpg' : 'mp4';
    while (fs.existsSync(path.join(dir, `${id}.${ext}`))) id = `${base}-${n++}`;

    // a local path (same machine, from the MCP server) skips the upload — token-gated, like add-clip
    const local = url.searchParams.get('path');
    if (local) {
      if (!tokenOk(TOKENS, req.headers['x-reel-token'])) return json(res, 403, {error: 'path ingest needs the backend token'});
      if (!/\.(mp4|mov|m4v|webm|mkv|avi|mts|jpe?g|png|webp|heic)$/i.test(local) || !fs.existsSync(local)) return json(res, 400, {error: 'path must be an existing video or image file'});
    }
    const tmp = local ?? path.join(ROOT, `.upload-broll-${id}.bin`);
    const cleanup = () => { if (tmp !== local) { try { fs.rmSync(tmp, {force: true}); } catch {} } };
    const ingest = async () => {
      try {
        const out = path.join(dir, `${id}.${ext}`);
        const thumb = path.join(thumbs, `${id}.jpg`);
        let durationSec = null;
        if (kind === 'image') {
          // normalize to jpg (handles png/heic/webp) + a thumbnail
          await run('ffmpeg', ['-y', '-i', tmp, '-vf', 'scale=1080:-1', out]);
          await run('ffmpeg', ['-y', '-i', out, '-vf', 'scale=160:-1', thumb]);
        } else {
          const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt,width,height:stream_side_data=rotation:format=duration', '-of', 'json', tmp]);
          let codec = '', pix = '', w = 0, h = 0, rotated = false;
          try { const p = JSON.parse(probe.stdout); const s = p.streams?.[0] ?? {}; codec = s.codec_name ?? ''; pix = s.pix_fmt ?? ''; w = s.width ?? 0; h = s.height ?? 0; rotated = (s.side_data_list ?? []).some((d) => d.rotation && d.rotation % 180 !== 0); durationSec = parseFloat(p.format?.duration ?? '0') || null; } catch {}
          // same rule as clips: 1080p-class h264 remuxes, anything bigger/rotated/other is fitted into 1080×1920 / 1920×1080
          const compatible = codec === 'h264' && pix.startsWith('yuv420') && !rotated && w <= 1080 && h <= 1920;
          const fit = "scale=w='if(gt(iw,ih),1920,1080)':h='if(gt(iw,ih),1080,1920)':force_original_aspect_ratio=decrease:force_divisible_by=2";
          const enc = compatible
            ? await run('ffmpeg', ['-y', '-i', tmp, '-c', 'copy', '-movflags', '+faststart', out])
            : await run('ffmpeg', ['-y', '-i', tmp, '-vf', fit, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', out]);
          if (enc.code !== 0) { cleanup(); return json(res, 500, {error: 'transcode failed'}); }
          await run('ffmpeg', ['-y', '-ss', '0.3', '-i', out, '-frames:v', '1', '-vf', 'scale=160:-1', thumb]);
        }
        cleanup();
        const asset = {id, src: `broll-assets/${id}.${ext}`, kind, label: rawName.replace(/\.[^.]+$/, ''), thumb: `/broll-assets/thumbs/${id}.jpg`, ...(durationSec ? {durationSec: +durationSec.toFixed(2)} : {})};
        try { upsertAsset({id, src: asset.src, kind, label: asset.label, durationSec: asset.durationSec ?? null}); } catch {}
        return json(res, 200, asset);
      } catch (e) {
        cleanup();
        return json(res, 500, {error: String(e).slice(0, 200)});
      }
    };
    if (local) { ingest(); return; }
    const ws = fs.createWriteStream(tmp);
    req.pipe(ws);
    req.on('error', () => { cleanup(); json(res, 500, {error: 'upload failed'}); });
    ws.on('finish', ingest);
    return;
  }

  // ---- add a clip to the timeline: upload → remux/encode → thumbnail ----
  if (req.method === 'POST' && url.pathname === '/api/add-clip') {
    const rawName = url.searchParams.get('name') || 'clip.mp4';
    const base = rawName.replace(/\.[^.]+$/, '').replace(/[^\w\-]/g, '_').slice(0, 40) || 'clip';
    const clipsDir = path.join(PUBLIC, 'clips');
    const thumbsDir = path.join(clipsDir, 'thumbs');
    fs.mkdirSync(thumbsDir, {recursive: true});

    // unique id (avoid clobbering existing clips)
    let id = base;
    let n = 2;
    while (fs.existsSync(path.join(clipsDir, `${id}.mp4`))) id = `${base}-${n++}`;

    // a local file path (same machine, from the MCP server) skips the upload —
    // only with the run token, and only video files
    const local = url.searchParams.get('path');
    if (local) {
      if (!tokenOk(TOKENS, req.headers['x-reel-token'])) return json(res, 403, {error: 'path ingest needs the backend token'});
      if (!/\.(mp4|mov|m4v|webm|mkv|avi|mts)$/i.test(local) || !fs.existsSync(local)) return json(res, 400, {error: 'path must be an existing video file'});
    }
    const tmp = local ? local : path.join(ROOT, `.upload-${id}.bin`);
    const cleanup = () => { if (tmp !== local) { try { fs.rmSync(tmp, {force: true}); } catch {} } };
    const ingest = async () => {
      try {
        const out = path.join(clipsDir, `${id}.mp4`);
        // probe codec / pixel format / size / rotation / duration
        const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
          '-show_entries', 'stream=codec_name,pix_fmt,width,height,color_transfer:stream_side_data=rotation:format=duration', '-of', 'json', tmp]);
        let codec = '', pix = '', duration = 0, w = 0, h = 0, rotated = false, trc = '';
        try {
          const p = JSON.parse(probe.stdout);
          const s = p.streams?.[0] ?? {};
          codec = s.codec_name ?? ''; pix = s.pix_fmt ?? ''; w = s.width ?? 0; h = s.height ?? 0; trc = s.color_transfer ?? '';
          rotated = (s.side_data_list ?? []).some((d) => d.rotation && d.rotation % 180 !== 0);
          duration = parseFloat(p.format?.duration ?? '0');
        } catch {}

        // Already 1080p-class h264/yuv420 and not rotated → fast remux. Anything
        // else (4K phones, HEVC, rotation metadata, 10-bit) is re-encoded: rotation
        // baked in, fitted inside 1080×1920 (portrait) or 1920×1080 (landscape).
        // Remotion's compositor cannot read 2160-tall sources.
        const hdr = trc in HDR_TRC;
        const compatible = codec === 'h264' && pix.startsWith('yuv420') && !rotated && w <= 1080 && h <= 1920 && !hdr;
        const fit = "scale=w='if(gt(iw,ih),1920,1080)':h='if(gt(iw,ih),1080,1920)':force_original_aspect_ratio=decrease:force_divisible_by=2";
        // HDR: fit first (cheaper), then BT.2020 YUV → RGB → LUT → BT.709 YUV
        const vf = hdr
          ? `${fit},scale=in_color_matrix=bt2020:in_range=tv:out_range=pc,format=gbrp16le,lut3d=file=${hdrLut(trc)},scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv`
          : fit;
        const enc = compatible
          ? await run('ffmpeg', ['-y', '-i', tmp, '-c', 'copy', '-movflags', '+faststart', out])
          : await run('ffmpeg', ['-y', '-i', tmp, '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
              ...(hdr ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'] : []),
              '-c:a', 'aac', '-ar', '48000', '-movflags', '+faststart', out]);
        if (enc.code !== 0) {
          cleanup();
          return json(res, 500, {error: 'transcode failed', detail: enc.stderr.slice(-300)});
        }

        // re-probe duration from the output (authoritative)
        const dp = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of',
          'default=noprint_wrappers=1:nokey=1', out]);
        const dur = parseFloat(dp.stdout) || duration || 0;

        // thumbnail
        await run('ffmpeg', ['-y', '-ss', String(Math.min(0.5, dur / 2)), '-i', out, '-frames:v', '1',
          '-vf', 'scale=160:-1', path.join(thumbsDir, `${id}.jpg`)]);

        cleanup();
        return json(res, 200, {
          id, src: `clips/${id}.mp4`, label: rawName.replace(/\.[^.]+$/, ''),
          inSec: 0, outSec: dur, sourceDurationSec: dur,
          ...(hdr ? {ingest: `${trc === 'smpte2084' ? 'PQ' : 'HLG'} HDR tone-mapped to SDR`} : {}),
        });
      } catch (e) {
        cleanup();
        return json(res, 500, {error: String(e).slice(0, 200)});
      }
    };
    if (tmp === local) { ingest(); return; }
    const ws = fs.createWriteStream(tmp);
    req.pipe(ws);
    req.on('error', () => { cleanup(); json(res, 500, {error: 'upload failed'}); });
    ws.on('finish', ingest);
    return;
  }

  // ---- pipeline jobs: transcribe / captions / autocut ----
  // Each spawns one pipeline script with the request body as its input file and
  // relays PROGRESS lines; on failure the LAST meaningful stderr line is returned
  // to the UI instead of "see server logs".
  const job = JOBS[url.pathname];
  if (req.method === 'POST' && job) {
    const id = String(Date.now());
    const inFile = path.join(ROOT, `.${job.prefix}-${id}.json`);
    const raw = await body(req);
    fs.writeFileSync(inFile, raw);
    let project = null;
    try { const p = JSON.parse(raw).project_id; if (typeof p === 'string') project = p; } catch {}
    const t0 = Date.now();
    job.store[id] = {status: 'running', progress: 0, label: 'Starting'};
    const child = spawn('node', [job.script, inFile], {cwd: ROOT, env: process.env});
    let errTail = '';
    let innerMs = 0; // transcription inside the job (TIMING lines of scripts/lib-transcribe.mjs), logged as its own stage
    const onChunk = (d) => {
      for (const m of String(d).matchAll(/TIMING:transcribe:(\d+):(\d+)/g)) {
        innerMs += +m[1];
        if (job.stage !== 'transcribe') logStage(project, 'transcribe', +m[1], {job: id, sources: +m[2], in: job.stage});
      }
      for (const m of String(d).matchAll(/PROGRESS:(\d+):([^\n]+)/g)) {
        job.store[id] = {status: 'running', progress: +m[1], label: m[2].trim()};
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', (d) => {
      onChunk(d);
      errTail = (errTail + d).slice(-4000);
      process.stderr.write(d);
    });
    child.on('close', (code) => {
      fs.rmSync(inFile, {force: true});
      // a transcribe job is all transcription; another job logs its own part apart from the transcription it ran
      const ms = Date.now() - t0 - (job.stage === 'transcribe' ? 0 : innerMs);
      logStage(project, job.stage, ms, {job: id, ...(code === 0 ? {} : {ok: false})});
      job.store[id] = code === 0
        ? {status: 'done', progress: 100, label: 'Ready'}
        : {status: 'error', error: explainFailure(errTail, `${job.name} exited ${code}`)};
    });
    return json(res, 200, {jobId: id});
  }
  const statusJob = Object.values(JOBS).find((j) => url.pathname.startsWith(j.route + '/'));
  if (req.method === 'GET' && statusJob) {
    const id = url.pathname.split('/').pop();
    return json(res, 200, statusJob.store[id] ?? {status: 'unknown'});
  }

  // ---- review links (scripts/reviews.mjs): the editor's Share button and the MCP share_version / list_versions / revoke_review_link ----
  //   GET    /api/reviews/<projectId>                → {versions, links}
  //   POST   /api/reviews/<projectId>/links {days?}  → a new link: {id, token, path, url, expiresAt} (the token is shown once)
  //   DELETE /api/reviews/<projectId>/links/<linkId> → revoked
  const rv = url.pathname.match(/^\/api\/reviews\/([\w-]+)(?:\/links(?:\/([0-9a-f]{8}))?)?$/);
  if (rv) {
    const [, projectId, linkId] = rv;
    const withLinks = url.pathname.includes('/links');
    if (req.method === 'GET' && !withLinks) {
      const r = loadReviews(REVIEWS, projectId);
      const playable = new Set(playableVersions(r, PUBLIC).map((x) => x.v));
      return json(res, 200, {projectId, versions: r.versions.map((x) => ({...x, playable: playable.has(x.v)})).reverse(), links: r.links.map((l) => publicLink(l)).reverse()});
    }
    if (req.method === 'POST' && withLinks && !linkId) {
      let b = {}; try { b = JSON.parse((await body(req)) || '{}'); } catch { return json(res, 400, {error: 'bad json'}); }
      if (!playableVersions(loadReviews(REVIEWS, projectId), PUBLIC).length) return json(res, 400, {error: 'no final render to share yet — export a final (not a draft) first'});
      try {
        const l = createLink(REVIEWS, projectId, {days: b?.days});
        return json(res, 200, {...l, url: `${publicBase(req)}${l.path}`});
      } catch (e) { return json(res, 400, {error: String(e?.message ?? e).slice(0, 200)}); }
    }
    if (req.method === 'DELETE' && linkId) {
      const l = revokeLink(REVIEWS, projectId, linkId);
      return l ? json(res, 200, l) : json(res, 404, {error: `no link ${linkId}`});
    }
    return json(res, 405, {error: 'method not allowed'});
  }

  // where a project's time went (scripts/timing.mjs) — the MCP's timing_report reads the same log
  if (req.method === 'GET' && url.pathname.startsWith('/api/timing/')) {
    const s = summarize(readTiming(PROJECTS_DIR, decodeURIComponent(url.pathname.split('/').pop())));
    return json(res, 200, {...s, text: timingText(s)});
  }

  // ---- render jobs ----
  //   POST   /api/render {…props, draft?, mode?, project_id?} → {jobId, status: 'queued', ahead} at once
  //   GET    /api/render/<id>                → the job in the shape pollers read (running / done / error)
  //   GET    /api/render-jobs?project=&status=&limit= → {jobs (newest first, each with ahead), workers}
  //   GET    /api/render-jobs/<id>           → the job as stored + ahead
  //   POST   /api/render-jobs/<id>/cancel    → cancelled (queued: at once; running: its process is killed)
  //   POST   /api/render-jobs/prune {days?}  → {removed}: state of finished jobs older than days (never the mp4s)
  if (req.method === 'POST' && url.pathname === '/api/render') {
    let raw = await body(req); // {clips, music, captions, brolls, accentColor, draft?, project_id?}
    let draft = false;
    let expectSec, clean = 'off', projectId = null, mode = DEFAULT_MODE;
    try {
      const props = JSON.parse(raw);
      draft = !!props.draft;
      if (props.mode === 'full' || props.mode === 'layers') mode = props.mode;
      // project_id (editor, MCP render): a final that passes QC is recorded as a review version of that project
      if (props.project_id != null) {
        if (!/^[\w-]+$/.test(String(props.project_id))) throw new Error('bad project_id');
        if (fs.existsSync(path.join(PROJECTS_DIR, `${props.project_id}.json`))) projectId = String(props.project_id);
      }
      delete props.project_id;
      if (!Array.isArray(props.clips) || !props.clips.length) throw new Error('no clips on the timeline');
      clean = props.audio?.clean ?? 'off';
      expectSec = totalDurationFrames(props.clips ?? [], 30) / 30;
      raw = JSON.stringify(props);
    } catch (e) {
      return json(res, 400, {error: `render: ${e?.message ?? e}`.slice(0, 200)});
    }
    // drafts keep their project (job list, timing log); only finals become review versions (the runner checks draft)
    const {job, ahead} = renderJobs.submit({props: raw, draft, expectSec, clean, projectId, mode});
    if (ahead) console.log(`render ${job.id} queued (${ahead} ahead)`);
    return json(res, 200, {jobId: job.id, status: job.status, ahead, ...(ahead ? {queued: ahead} : {})});
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/render/')) {
    const id = url.pathname.split('/').pop();
    if (!/^[\w-]{6,64}$/.test(id)) return json(res, 200, {status: 'unknown'});
    return json(res, 200, renderJobs.view(id));
  }
  if (url.pathname === '/api/render-jobs/prune' && req.method === 'POST') {
    let b = {}; try { b = JSON.parse((await body(req)) || '{}'); } catch { return json(res, 400, {error: 'bad json'}); }
    const days = b.days == null ? undefined : Math.max(0, +b.days);
    if (days != null && !Number.isFinite(days)) return json(res, 400, {error: 'days must be a number'});
    return json(res, 200, {removed: renderJobs.prune(days != null ? {days} : {})});
  }
  const rj = url.pathname.match(/^\/api\/render-jobs(?:\/([\w-]{6,64}))?(\/cancel)?$/);
  if (rj) {
    const [, id, cancel] = rj;
    const all = renderJobs.list();
    const withAhead = (j) => ({...j, ahead: j.status === 'queued' ? aheadOf(all, j.id) : 0});
    if (req.method === 'GET' && !id) {
      const status = url.searchParams.get('status')?.split(',').filter(Boolean);
      const project = url.searchParams.get('project') || undefined;
      const limit = Math.min(200, +url.searchParams.get('limit') || 50);
      return json(res, 200, {workers: renderJobs.workers, jobs: renderJobs.list({projectId: project, status, limit}).map(withAhead)});
    }
    if (req.method === 'GET' && id && !cancel) {
      const j = renderJobs.get(id);
      return j ? json(res, 200, withAhead(j)) : json(res, 404, {error: `no render job ${id}`});
    }
    if ((req.method === 'POST' && cancel) || (req.method === 'DELETE' && id && !cancel)) {
      const r = renderJobs.cancel(id);
      return r.ok ? json(res, 200, {...r.job, pending: !!r.pending}) : json(res, r.job ? 409 : 404, {error: r.error});
    }
    return json(res, 405, {error: 'method not allowed'});
  }

  json(res, 404, {error: 'not found'});
});

// a single bad request/job must not kill the whole backend
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

try { ensureSfx(); } catch (e) { console.error('sfx:', e.message); }

// Export cleanup for a deploy with no system cron that can reach public/ (Railway's volume):
// REEL_CLEANUP_EVERY_H=N runs scripts/cleanup-exports.mjs every N hours (first run 5 min after boot),
// in a child process, DRY-RUN unless REEL_CLEANUP_APPLY=1. Off when unset. On the VM use cron instead.
const CLEANUP_EVERY_H = +(process.env.REEL_CLEANUP_EVERY_H || 0);
if (CLEANUP_EVERY_H >= 1) {
  const sweep = () => {
    const c = spawn('node', ['scripts/cleanup-exports.mjs', ...(process.env.REEL_CLEANUP_APPLY === '1' ? ['--apply'] : [])], {cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit']});
    c.on('error', (e) => console.error('cleanup-exports could not start:', e.message));
  };
  setTimeout(sweep, 5 * 60e3).unref();
  setInterval(sweep, CLEANUP_EVERY_H * 3600e3).unref();
}
const PORT = +(process.env.REEL_PORT || 3333); // another port for a second backend on the same box (the MCP then needs REEL_API)
const HOST = process.env.REEL_HOST || '127.0.0.1';
const BIND_PORT = +(process.env.PORT || PORT);
server.listen(BIND_PORT, HOST, () => console.log(`editor backend → http://${HOST}:${BIND_PORT}`));
