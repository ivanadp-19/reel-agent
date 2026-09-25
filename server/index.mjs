// Editor backend (port 3333):
//   projects   — multi-project library (list/get/save/delete)
//   add-clip   — upload video → remux/encode + thumbnail → return clip
//   music      — upload an audio track
//   transcribe — per-source WhisperX, words per clip for the agent (job)
//   captions   — words → caption pages + face-aware placement (job)
//   trim-silence — autocut plan (job)
//   render     — export the MultiClip composition to mp4 (job)
//   health     — environment checks for the Start screen (ffmpeg, WhisperX, keys)
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import {totalDurationFrames} from '../src/timeline.ts';
import {cube, hlgToSdr, pqToSdr} from '../src/hdr.ts';
import {lutBakes} from '../src/grade.ts';
import {brandSchema} from '../src/brand.ts';
import {FONT_FILE, clientFont} from '../src/fonts.ts';
import {linkPublic} from '../scripts/public-links.mjs';
import {ensureSfx} from '../scripts/sfx.mjs';
import {createQueue, renderArgs, renderPlan} from '../scripts/render-queue.mjs';
import {ALPHA, alphaEncodeArgs, captionArgs, codeVersion, compositeArgs, createMasterCache, masterArgs, masterKey, probeColor} from '../scripts/layers.mjs';
import {chooseRenderMode} from '../src/layers.ts';
import {logTiming, readTiming, summarize, timingText} from '../scripts/timing.mjs';
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

const renders = {}; // jobId -> {status, progress, file, error}
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

// The only remote host we ever download from. Anything else in a B-roll src
// (an agent talked into it by a transcript, a stray URL) is refused, and
// redirects are re-checked hop by hop so a 302 cannot point at the LAN.
const ALLOWED_REMOTE = /(^|\.)pexels\.com$/i;
async function fetchAllowed(url, hops = 0) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !ALLOWED_REMOTE.test(u.hostname)) throw new Error(`refusing to download from ${u.hostname}: only Pexels URLs are fetched`);
  const r = await fetch(u, {redirect: 'manual'});
  if ([301, 302, 303, 307, 308].includes(r.status)) {
    if (hops >= 3) throw new Error('too many redirects');
    return fetchAllowed(new URL(r.headers.get('location') ?? '', u).href, hops + 1);
  }
  return r;
}

// download remote B-roll srcs into public/broll/ and rewrite props in place
const BROLL_DIR = path.join(PUBLIC, 'broll');
async function localizeRemoteBrolls(props) {
  const items = Array.isArray(props?.brolls) ? props.brolls : [];
  fs.mkdirSync(BROLL_DIR, {recursive: true});
  for (const b of items) {
    if (!/^https?:\/\//.test(b.src ?? '')) continue;
    const ext = b.kind === 'video' ? 'mp4' : (b.src.match(/\.(jpe?g|png|webp)(\?|$)/i)?.[1] ?? 'jpg');
    // named by a hash of the whole URL: Pexels files of one size share their last
    // characters ("…_1080_1920_30fps.mp4"), and a name from those made two cues share one file
    const name = `px-${crypto.createHash('sha1').update(b.src).digest('hex').slice(0, 16)}.${ext}`;
    const file = path.join(BROLL_DIR, name);
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
      const r = await fetchAllowed(b.src);
      if (!r.ok) throw new Error(`B-roll download ${r.status}: ${b.src}`);
      const tmp = file + '.part';
      fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
      if (ext === 'mp4') {
        // Remotion's compositor fails on 4K sources ("Could not extract frame ...
        // Request closed"); the output is 1080x1920 anyway, so cap the height.
        const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', tmp]);
        const h = parseInt(probe.stdout, 10) || 0;
        if (h > 1920) {
          const small = file + '.small.mp4';
          const enc = await run('ffmpeg', ['-y', '-i', tmp, '-vf', 'scale=-2:1920', '-c:v', 'libx264', '-preset', 'veryfast',
            '-crf', '20', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', small]);
          if (enc.code !== 0) throw new Error(`B-roll downscale failed: ${enc.stderr.slice(-200)}`);
          fs.rmSync(tmp, {force: true});
          fs.renameSync(small, file);
        } else fs.renameSync(tmp, file);
      } else fs.renameSync(tmp, file);
    }
    b.src = `broll/${name}`;
  }
}

// ---- render queue (scripts/render-queue.mjs): `workers` exports at once, the rest wait ----
const PLAN = renderPlan();
console.log(`render queue: ${PLAN.workers} worker(s) × concurrency ${PLAN.concurrency}`);
const FPS = 30;
// layered renders (scripts/layers.mjs): masters cached outside public/ (never bundled, never committed)
const masterCache = createMasterCache(path.join(ROOT, '.render-cache', 'masters'));
const CAPTION_ALPHA = process.env.REEL_CAPTION_ALPHA in ALPHA ? process.env.REEL_CAPTION_ALPHA : 'png';
// the mode a render runs in when the request names none (full = the one-pass render)
const DEFAULT_MODE = process.env.REEL_RENDER_MODE === 'layers' ? 'layers' : 'full';
// one export: remotion render, then (final only) loudness + QC in a child process; resolves when the job is settled
// LUT-graded copies the grade needs and does not have yet (a clip added after set_grade…):
// baked here, before the render, so no clip silently plays ungraded
async function bakeMissing(raw, id) {
  const props = JSON.parse(raw);
  const g = props.grade;
  const missing = lutBakes(g, props.clips ?? [], props.mattes ?? []).filter((b) => !g.baked?.[b.key] || !fs.existsSync(path.join(PUBLIC, g.baked[b.key])));
  if (!missing.length) return raw;
  const inFile = path.join(ROOT, `.lut-${id}.json`), outFile = path.join(ROOT, '.captions-tmp', `lut-${id}.json`);
  fs.mkdirSync(path.dirname(outFile), {recursive: true});
  fs.writeFileSync(inFile, JSON.stringify({bake: missing}));
  const r = await run('node', ['scripts/lut.mjs', inFile, outFile]);
  fs.rmSync(inFile, {force: true});
  if (r.code !== 0) throw new Error(explainFailure(r.stderr, 'LUT bake failed'));
  g.baked = {...g.baked, ...JSON.parse(fs.readFileSync(outFile, 'utf8')).baked};
  fs.rmSync(outFile, {force: true});
  return JSON.stringify(props);
}
function renderJob(job, id) {
  renders[id] = {status: 'running', progress: 0, label: 'Preparing'}; // out of the queue: the LUT bake counts as render time
  const t = Date.now();
  if (t - job.queuedAt > 1000) logStage(job.project, 'queue', t - job.queuedAt, {job: id});
  return bakeMissing(job.raw, id).then((raw) => { if (Date.now() - t > 1000) logStage(job.project, 'prepare', Date.now() - t, {job: id}); return renderProps({...job, raw}, id); }, (e) => { renders[id] = {status: 'error', error: String(e?.message ?? e).slice(0, 300)}; });
}
// one `remotion render`: progress into renders[id] (scaled into [from, to] %), resolves {code, errTail}
function remotion(args, id, {from = 0, to = 100} = {}) {
  return new Promise((resolve) => {
    const child = spawn('npx', args, {cwd: ROOT});
    let errTail = ''; // keep the tail of output so failures show a real message
    const onProgress = (d) => {
      const s = String(d);
      const m = s.match(/Rendered\s+(\d+)\/(\d+)/);
      if (m) renders[id].progress = Math.round(from + ((to - from) * +m[1]) / +m[2]);
      errTail = (errTail + s).slice(-2000);
    };
    child.stdout.on('data', onProgress);
    child.stderr.on('data', onProgress);
    child.on('close', (code) => resolve({code, errTail}));
    child.on('error', (e) => resolve({code: -1, errTail: `render could not start: ${e.message}`}));
  });
}
const renderError = ({code, errTail}) => {
  console.error(`render failed:\n${errTail.slice(-1200)}`);
  return errTail.split('\n').reverse().find((l) => /error|Error/.test(l))?.trim().slice(0, 200) || `render exited ${code}`;
};
// final: two-pass loudness to −14 LUFS, then the QC gate, in a child process (a few
// seconds of ffmpeg must not block this event loop) → the scripts/qc.mjs report
function finalize(outFile, expectSec, clean) {
  return new Promise((resolve) => {
    const fin = spawn('node', ['scripts/qc.mjs', '--finalize', outFile, String(expectSec), String(clean)], {cwd: ROOT});
    let out = '';
    fin.stdout.on('data', (d) => (out += d));
    fin.stderr.on('data', (d) => process.stderr.write(d));
    fin.on('close', () => {
      try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { resolve({ok: false, error: 'QC did not report', checks: [], text: ''}); }
    });
  });
}

// Two modes (src/layers.ts picks, scripts/layers.mjs builds):
//   full   — the whole reel in one remotion pass (captions included)
//   layers — the master without captions (cached by its inputs, scripts/layers.mjs),
//            a transparent caption layer, an ffmpeg composite
// then, final renders only, loudness + QC on the file that ships.
async function renderProps({raw, draft, expectSec, clean, mode: requested, project}, id) {
  const outName = `edited-${id}${draft ? '-draft' : ''}.mp4`;
  const outFile = path.join(EXPORTS, outName);
  const tmp = [];
  const info = {};
  let links = null;
  // everything that can throw is inside the try: a job that fails must say so, never hang in "running"
  try {
    const props = JSON.parse(raw);
    const choice = chooseRenderMode(requested, props, FPS);
    info.mode = choice.mode;
    if (choice.reasons.length) info.fallback = choice.reasons;
    // public/ as symlinks: the CLI would otherwise copy every clip, matte and earlier export into its bundle
    links = linkPublic(PUBLIC, path.join(ROOT, '.captions-tmp', `render-public-${id}`));
    const propsFile = (name, p) => { const f = path.join(ROOT, `.props-${id}${name}.json`); fs.writeFileSync(f, JSON.stringify(p)); tmp.push(f); return f; };
    const opts = {propsFile: null, publicDir: links, draft, concurrency: PLAN.concurrency, cacheBytes: PLAN.cacheBytes};
    const stages = {};
    const t0 = Date.now();
    const stage = async (name, fn) => {
      const t = Date.now();
      const r = await fn();
      const ms = Date.now() - t;
      stages[name] = +(ms / 1000).toFixed(1);
      logStage(project, name, ms, {job: id, mode: choice.mode, draft, ...(name === 'render' || name === 'master' ? {videoSec: expectSec} : {}), ...(r?.code || r?.ok === false ? {ok: false} : {})});
      return r;
    };
    if (choice.reasons.length) console.log(`render ${id}: layers → full (${choice.reasons.join('; ')})`);
    if (choice.mode === 'full') {
      renders[id] = {status: 'running', progress: 0, ...info};
      const r = await stage('render', () => remotion(renderArgs({...opts, outFile, propsFile: propsFile('', props)}), id));
      if (r.code !== 0) { renders[id] = {status: 'error', error: renderError(r), ...info}; return; }
    } else {
      const key = masterKey(props, {code: codeVersion(ROOT), fps: FPS, draft, publicDir: PUBLIC});
      let master = masterCache.get(key);
      info.master = master ? 'cached' : 'rendered';
      const split = choice.captions ? 70 : 100; // progress: the master is most of the work
      if (!master) {
        renders[id] = {status: 'running', progress: 0, label: 'Rendering master', ...info};
        const part = path.join(masterCache.dir, `${key}.part-${id}.mp4`);
        tmp.push(part);
        const r = await stage('master', () => remotion(masterArgs({...opts, outFile: part, propsFile: propsFile('-master', {...props, captionsOff: true})}), id, {to: split}));
        if (r.code !== 0) { renders[id] = {status: 'error', error: renderError(r), ...info}; return; }
        master = masterCache.put(key, part);
      }
      if (choice.captions) {
        renders[id] = {status: 'running', progress: split, label: 'Rendering captions layer', ...info};
        // Remotion reads any dot in a sequence folder's path as an extension and refuses it (.captions-tmp would): the OS temp dir
        const frames = path.join(os.tmpdir(), `reel-captions-${id}`);
        tmp.push(frames);
        const r = await stage('captions', () => remotion(captionArgs({...opts, outFile: frames, propsFile: propsFile('-captions', {...props, layer: 'captions'})}), id, {from: split, to: 92}));
        if (r.code !== 0) { renders[id] = {status: 'error', error: renderError(r), ...info}; return; }
        let layer = frames;
        const enc = ALPHA[CAPTION_ALPHA].ext && alphaEncodeArgs({frames, outFile: (layer = `${frames}.${ALPHA[CAPTION_ALPHA].ext}`), alpha: CAPTION_ALPHA, fps: FPS});
        if (enc) {
          tmp.push(layer);
          renders[id] = {status: 'running', progress: 92, label: `Encoding captions layer (${CAPTION_ALPHA})`, ...info};
          const e = await stage('encode', () => run('ffmpeg', enc));
          if (e.code !== 0) { renders[id] = {status: 'error', error: `captions layer encode failed: ${e.stderr.trim().split('\n').pop()}`.slice(0, 300), ...info}; return; }
        }
        renders[id] = {status: 'running', progress: 95, label: 'Compositing', ...info};
        const c = await stage('composite', () => run('ffmpeg', compositeArgs({master, overlays: [{file: layer, alpha: CAPTION_ALPHA}], outFile, fps: FPS, draft, color: probeColor(master)})));
        if (c.code !== 0) { renders[id] = {status: 'error', error: `composite failed: ${c.stderr.trim().split('\n').pop()}`.slice(0, 300), ...info}; return; }
      } else fs.copyFileSync(master, outFile); // nothing to lay over it: the master is the reel
    }
    const secs = Math.round((Date.now() - t0) / 1000);
    console.log(`render ${id} ${draft ? 'draft ' : ''}[${info.mode}${info.master ? `, master ${info.master}` : ''}] took ${secs}s for ${expectSec?.toFixed(1)}s of video ${JSON.stringify(stages)}`);
    if (draft) { renders[id] = {status: 'done', progress: 100, file: `/exports/${outName}`, renderSec: secs, stages, ...info}; return; }
    // A render that fails QC is kept as *-qcfail.mp4 for inspection and reported as an error.
    renders[id] = {status: 'running', progress: 100, label: 'Loudness + QC', ...info};
    const r = await stage('qc', () => finalize(outFile, expectSec, clean));
    if (r.ok) renders[id] = {status: 'done', progress: 100, file: `/exports/${outName}`, qc: r.text, renderSec: secs, stages, ...info};
    else {
      const failed = outName.replace(/\.mp4$/, '-qcfail.mp4');
      try { fs.renameSync(outFile, path.join(EXPORTS, failed)); } catch {}
      renders[id] = {status: 'error', error: `QC failed (kept as /exports/${failed}): ${[r.error, ...r.checks.filter((c) => !c.ok && c.blocking).map((c) => `${c.name} ${c.value}, want ${c.want}`)].filter(Boolean).join('; ')}`, qc: r.text, stages, ...info};
    }
  } catch (e) {
    renders[id] = {status: 'error', error: String(e?.message ?? e).slice(0, 300), ...info};
  } finally {
    for (const f of tmp) fs.rmSync(f, {recursive: true, force: true});
    if (links) fs.rmSync(links, {recursive: true, force: true});
  }
}
const renderQueue = createQueue(PLAN.workers, renderJob);

// The backend has no auth, so only local callers may reach it:
// - Host must be loopback (DNS-rebinding pages send a foreign Host header)
// - a browser Origin, when present, must be a localhost page (the editor);
//   cross-origin pages always send Origin, so this blocks CSRF POSTs, while
//   non-browser clients (the MCP server, curl) send none and pass
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
// Railway / public mode (REEL_PUBLIC=1): the backend faces the internet, so the
// loopback gate is replaced by HTTP basic auth. The bcrypt hashes come from
// REEL_AUTH_BCRYPT ("user:$2a$...,user:$2a$...") - the same hashes Caddy uses on
// the VM, so existing passwords keep working and no secret crosses a chat.
const PUBLIC_MODE = process.env.REEL_PUBLIC === '1';
const AUTH = Object.fromEntries((process.env.REEL_AUTH_BCRYPT || '').split(',').filter(Boolean).map((pair) => { const i = pair.indexOf(':'); return [pair.slice(0, i), pair.slice(i + 1)]; }));
const MIME = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.cube': 'text/plain', '.vtt': 'text/vtt', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon'};
const DIST = path.join(ROOT, 'editor', 'dist');
function serveFile(req, res, file) {
  const st = fs.statSync(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range && req.headers.range.match(/bytes=(\d*)-(\d*)/);
  if (range && (range[1] || range[2])) {
    const start = range[1] ? +range[1] : Math.max(0, st.size - (+range[2]));
    const end = range[1] ? (range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1) : st.size - 1;
    res.writeHead(206, {'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes'});
    return fs.createReadStream(file, {start, end}).pipe(res);
  }
  res.writeHead(200, {'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes'});
  fs.createReadStream(file).pipe(res);
}
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
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (PUBLIC_MODE && url.pathname === '/api/ping') return json(res, 200, {ok: true}); // Railway healthcheck: no auth, no info
  if (PUBLIC_MODE) {
    const h = req.headers.authorization || '';
    const b = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString() : '';
    const i = b.indexOf(':');
    const tokOK = TOKENS.includes(req.headers['x-reel-token']); // MCP/backend clients authenticate with the shared backend token instead of basic auth
    const ok = tokOK || i > 0 && AUTH[b.slice(0, i)] && bcrypt.compareSync(b.slice(i + 1), AUTH[b.slice(0, i)]);
    if (!ok) { res.writeHead(401, {'WWW-Authenticate': 'Basic realm="reel-agent"'}); return res.end('auth required'); }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  } else {
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!LOCAL_HOSTS.has(host)) return json(res, 403, {error: 'local access only'});
    if (req.headers.origin && !LOCAL_ORIGIN.test(req.headers.origin)) return json(res, 403, {error: 'bad origin'});
  }

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
      if (!TOKENS.includes(req.headers['x-reel-token'])) return json(res, 403, {error: 'path ingest needs the backend token'});
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
      if (!TOKENS.includes(req.headers['x-reel-token'])) return json(res, 403, {error: 'path ingest needs the backend token'});
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

  // ---- E9: запустить рендер ----
  // where a project's time went (scripts/timing.mjs) — the MCP's timing_report reads the same log
  if (req.method === 'GET' && url.pathname.startsWith('/api/timing/')) {
    const s = summarize(readTiming(PROJECTS_DIR, decodeURIComponent(url.pathname.split('/').pop())));
    return json(res, 200, {...s, text: timingText(s)});
  }
  if (req.method === 'POST' && url.pathname === '/api/render') {
    let raw = await body(req); // {clips, music, captions, brolls, accentColor, draft?}
    let draft = false;
    let expectSec, clean = 'off', mode = DEFAULT_MODE, project = null;
    try {
      const props = JSON.parse(raw);
      draft = !!props.draft;
      if (props.mode === 'full' || props.mode === 'layers') mode = props.mode;
      if (typeof props.project_id === 'string') project = props.project_id;
      clean = props.audio?.clean ?? 'off';
      expectSec = totalDurationFrames(props.clips ?? [], 30) / 30;
      // Remote (Pexels) B-roll is fetched by headless Chrome during the render and
      // that fetch was failing mid-way on big files. Download every remote asset
      // once into public/broll/ and render from disk instead.
      await localizeRemoteBrolls(props);
      raw = JSON.stringify(props);
    } catch (e) {
      return json(res, 400, {error: `render: ${e?.message ?? e}`.slice(0, 200)});
    }
    const id = `${Date.now()}${crypto.randomBytes(2).toString('hex')}`; // parallel agents may submit in the same ms
    // queued: the status reads "running" with a label so every client keeps polling (queued: true, ahead: n)
    renders[id] = {status: 'running', progress: 0, queued: true};
    const ahead = renderQueue.push(id, {raw, draft, expectSec, clean, mode, project, queuedAt: Date.now()});
    if (ahead) console.log(`render ${id} queued (${ahead} ahead)`);
    return json(res, 200, {jobId: id, ...(ahead ? {queued: ahead} : {})});
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/render/')) {
    const id = url.pathname.split('/').pop();
    const r = renders[id];
    if (r?.queued) { const n = renderQueue.ahead(id); return json(res, 200, {...r, ahead: n, label: `Queued — ${n} render${n === 1 ? '' : 's'} ahead`}); }
    return json(res, 200, r ?? {status: 'unknown'});
  }

  json(res, 404, {error: 'not found'});
});

// a single bad request/job must not kill the whole backend
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

try { ensureSfx(); } catch (e) { console.error('sfx:', e.message); }
const PORT = +(process.env.REEL_PORT || 3333); // another port for a second backend on the same box (the MCP then needs REEL_API)
const HOST = process.env.REEL_HOST || '127.0.0.1';
const BIND_PORT = +(process.env.PORT || PORT);
server.listen(BIND_PORT, HOST, () => console.log(`editor backend → http://${HOST}:${BIND_PORT}`));
