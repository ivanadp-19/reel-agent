#!/usr/bin/env node
// Faces over a whole source, for captions that never cover one (src/faces.ts). One ffmpeg pass per file, niced, one
// thread: every frame tiny — the grade scan's 27×24 looks, whose structure hash splits the file into shots (sameShot:
// the rule the grade scan links a shot by; César's finished exports are one file of many shots) — and every k-th frame
// (RATE a second: exact frames, select=not(mod(n,k)), each labelled with its own pts) for YuNet (scripts/face.py: every
// face ≥ 3 % of the frame's height with its score at 640 px, and a doubtful one looked at again at full resolution —
// `look`; src/faces.ts decides which it trusts).
// Cached by path + size + mtime in public/clips/faces/<its path under public/>.json (src/faces.ts faceCacheName),
// keeping the old summary (found, left, top, right, bottom: the largest face, at its median) for older readers, plus
// samples [{t, faces}], cuts [the source second each new shot starts] and the frame's size.
// The backend runs it in the grade scan's background lane after an ingest, for the clips and the B-roll a validate
// finds unscanned and for a B-roll added; the captions job scans what it needs first. One scan of a file at a time,
// across processes (a lock next to its cache file). No venv, no cv2 or a model that does not load (the VM): it throws
// with retry — checked once per process — and the captions stay at the pack's top, with a warning.
//   node scripts/face-scan.mjs <file under public/ or absolute> … [--force] [--json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {frameLooks, looksVf, rangeOf, sameShot} from './grade-scan.mjs';
import {acquireLock, releaseLock} from './project-lock.mjs';
import {faceCacheName} from '../src/faces.ts';

export const FACE_VERSION = 2; // 2: exact frames with their own pts (1 took each half second's last frame, 0.24 s early)
export const RATE = 2; // face samples a second
const ROOT = path.resolve(import.meta.dirname, '..');
const MODEL = path.join(ROOT, '.models', 'yunet.onnx');
const PY = path.join(ROOT, '.venv', 'bin', 'python');
const NICE = () => Number(process.env.REEL_GRADE_SCAN_NICE ?? 15);
const TIMEOUT = () => Number(process.env.REEL_GRADE_SCAN_TIMEOUT_MS || 600000);
const LOOK = 27 * 24 * 3;
const fileOf = (publicDir, src) => (path.isAbsolute(src) ? src : path.join(publicDir, src.replace(/^\//, '')));
const relOf = (publicDir, src) => path.relative(publicDir, fileOf(publicDir, src));
export const faceFile = (publicDir, src) => path.join(publicDir, 'clips', 'faces', faceCacheName(relOf(publicDir, src)));
const keyOf = (file) => { const st = fs.statSync(file); return {size: st.size, mtimeMs: Math.round(st.mtimeMs)}; };

// Can this box find faces: the venv's python imports cv2 and YuNet loads the model — checked once per process (a VM
// without them must not decode every source on every validate to find out). null = yes, else why not
let problem;
export function faceScanProblem() {
  if (problem !== undefined) return problem;
  if (!fs.existsSync(PY) || !fs.existsSync(MODEL)) return (problem = '.venv or .models/yunet.onnx missing (run `npm run setup`)');
  const r = spawnSync(PY, ['-c', 'import sys, cv2; cv2.FaceDetectorYN.create(sys.argv[1], "", (320, 320))', MODEL], {encoding: 'utf8', timeout: 60000});
  return (problem = r.status === 0 ? null : `YuNet does not load here (${String(r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n').pop()?.slice(0, 160)})`);
}
export const canScanFaces = () => faceScanProblem() === null;

// the cached scan while it is current (this version, same path, size + mtime), else null; undefined = no such file.
// out: where it is kept (the judge keeps its renders' scans apart)
export function readFaces(publicDir, src, out = faceFile(publicDir, src)) {
  const file = fileOf(publicDir, src);
  if (!fs.existsSync(file)) return undefined;
  try {
    const e = JSON.parse(fs.readFileSync(out, 'utf8')), k = keyOf(file);
    return e.version === FACE_VERSION && e.src === relOf(publicDir, src) && e.size === k.size && e.mtimeMs === k.mtimeMs ? e : null;
  } catch { return null; }
}

// not the file's fault: the disk full, a signal, a deadline — tried again, never cached as the file's result
const transient = (text) => /no space left|ENOSPC|EDQUOT|EMFILE|ENOMEM/i.test(text);
// a child niced, with a deadline; resolves its stdout (a Buffer), rejects with why ({retry} when it is not the file's
// fault). onOut / onErr: its output as it comes (the looks; showinfo's lines)
function run(cmd, args, name, {onOut, onErr} = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args);
    try { if (NICE() > 0) os.setPriority(c.pid, Math.min(19, NICE())); } catch {}
    const chunks = [];
    let err = '';
    const timer = setTimeout(() => c.kill('SIGKILL'), TIMEOUT());
    c.stdout.on('data', (d) => (onOut ? onOut(d) : chunks.push(d)));
    c.stderr.on('data', (d) => { onErr?.(d); err = (err + d).slice(-2000); });
    const fail = (msg, retry) => reject(Object.assign(new Error(`face scan of ${name}${msg}`), {retry}));
    c.on('error', (e) => { clearTimeout(timer); fail(`: ${e.code ?? e.message}`, true); });
    c.on('close', (code, sig) => {
      clearTimeout(timer);
      const why = err.trim().split('\n').filter((l) => !/Parsed_showinfo|^\s/.test(l)).pop() || `${path.basename(cmd)} exit ${code}`;
      code === 0 ? resolve(Buffer.concat(chunks)) : sig ? fail(` stopped (${sig}: over ${TIMEOUT() / 1000} s?)`, true) : fail(`: ${why}`, transient(err));
    });
  });
}
// → {fps, range}: the frame rate, and the file's own range (grade-scan.mjs rangeOf: the shot rule reads its frames in it)
const probe = async (file, name) => {
  try { const s = JSON.parse(String(await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate,r_frame_rate,color_range,pix_fmt', '-of', 'json', file], name))).streams[0]; const f = (r) => { const [n, d] = String(r).split('/').map(Number); return d ? n / d : n; }; return {fps: f(s.avg_frame_rate) || f(s.r_frame_rate) || 30, range: rangeOf(s)}; } catch { return {fps: 30, range: 'tv'}; }
};
const median = (xs) => { const a = [...xs].sort((p, q) => p - q); return a[Math.floor(a.length / 2)]; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// scan one file (cached): {version, src, size, mtimeMs, fps, rate, width, height, found, left…, samples, cuts}.
// cuts: false leaves the looks out (the judge's renders: only the faces). A file that does not decode — or that YuNet
// fails on — is cached with its error (no samples; --force retries); no model, a full disk, a deadline or no ffmpeg
// only throws: the next kick retries. One scan of a file at a time: in this process (the same promise) and across
// processes (the lane and the captions job: a lock next to the cache file — the second waits, then reads the first's)
const running = new Map();
export function scanFaces(publicDir, src, o = {}) {
  const out = o.out ?? faceFile(publicDir, src);
  if (!running.has(out)) running.set(out, scanOnce(publicDir, src, {...o, out}).finally(() => running.delete(out)));
  return running.get(out);
}
async function scanOnce(publicDir, src, {force = false, out, cuts = true}) {
  const hit = !force && readFaces(publicDir, src, out);
  if (hit) return hit;
  const why = faceScanProblem();
  if (why) throw Object.assign(new Error(`face scan: ${why}`), {retry: true, unavailable: true});
  const lockDir = path.dirname(out), lockId = `.${path.basename(out)}`;
  fs.mkdirSync(lockDir, {recursive: true});
  for (const t0 = Date.now(); !acquireLock(lockDir, lockId, {owner: 'face scan'}).ok;) {
    if (Date.now() - t0 > TIMEOUT()) throw Object.assign(new Error(`face scan of ${relOf(publicDir, src)}: another process holds it past ${TIMEOUT() / 1000} s`), {retry: true});
    await wait(1000);
  }
  try {
    const done = !force && readFaces(publicDir, src, out); // the other process scanned it meanwhile
    return done || (await scanFile(publicDir, src, out, cuts));
  } finally { releaseLock(lockDir, lockId); }
}
async function scanFile(publicDir, src, out, cuts) {
  const file = fileOf(publicDir, src), name = relOf(publicDir, src), k = keyOf(file);
  const save = (e) => {
    const entry = {version: FACE_VERSION, src: name, ...k, ...e, scannedAt: new Date().toISOString()};
    const tmp = `${out}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry));
    fs.renameSync(tmp, out);
    return entry;
  };
  // the file's own fault, cached so no lane decodes it again; anything else thrown (retried)
  const settle = (e) => { if (!e.retry) save({error: String(e.message).slice(0, 300), samples: [], cuts: []}); throw e; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faces-'));
  try {
    const still = /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i.test(file); // an image B-roll: its one frame, no shots
    cuts &&= !still;
    const {fps, range} = still ? {fps: 30, range: 'tv'} : await probe(file, name), every = Math.max(1, Math.round(fps / RATE));
    const looks = [], pts = [];
    let rest = Buffer.alloc(0), line = '';
    const faces = still ? 'null' : `select=not(mod(n\\,${every})),showinfo`; // full resolution: face.py scales it for the search
    const graph = cuts ? `[0:v]split=2[a][b];[a]${looksVf(range)}[l];[b]${faces}[f]` : `[0:v]${faces}[f]`;
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'info', '-nostats', '-threads', '1', '-filter_complex_threads', '1', '-i', file, '-an', '-filter_complex', graph,
      '-map', '[f]', '-fps_mode', 'passthrough', '-q:v', '4', path.join(dir, '%06d.jpg'), ...(cuts ? ['-map', '[l]', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'] : [])], name, {
      onOut: (d) => {
        const buf = Buffer.concat([rest, d]), whole = buf.length - (buf.length % LOOK);
        for (const f of frameLooks(buf.subarray(0, whole), range)) looks.push(f);
        rest = buf.subarray(whole);
      },
      onErr: (d) => { // showinfo: each face frame's own time
        const text = line + d, lines = text.split('\n');
        line = lines.pop();
        for (const l of lines) { const m = /Parsed_showinfo.*\bpts_time:\s*(-?[\d.]+)/.exec(l); if (m) pts.push(+m[1]); }
      },
    }).catch(settle);
    const jpgs = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort().map((f) => path.join(dir, f));
    let found = {};
    if (jpgs.length) {
      const raw = await run(PY, [path.join(ROOT, 'scripts', 'face.py'), MODEL, ...jpgs], name).catch(settle);
      try { found = JSON.parse(String(raw)); } catch { settle(new Error(`face scan of ${name}: face.py answered no JSON`)); }
    }
    const t0 = pts[0] ?? 0; // a source whose first frame is not at 0 (an edit list): its times from its first frame
    const samples = jpgs.map((j, i) => ({t: Math.round(((pts[i] ?? i / RATE) - (pts.length ? t0 : 0)) * 1000) / 1000, faces: (found[j]?.faces ?? []).map(({left, top, right, bottom, score, look}) => ({left: +left.toFixed(4), top: +top.toFixed(4), right: +right.toFixed(4), bottom: +bottom.toFixed(4), score, ...(look != null ? {look} : {})}))}));
    const [width, height] = found[jpgs[0]]?.size ?? [];
    // the shots: frame k starts a new one where the structure jumps (k / fps, CFR as the grade scan reads it)
    const shotCuts = cuts ? looks.flatMap((f, i) => (i && !sameShot(looks[i - 1], f) ? [Math.round((i / fps) * 1000) / 1000] : [])) : undefined;
    const big = samples.map((s) => s.faces[0]).filter(Boolean);
    const summary = big.length ? {found: true, ...Object.fromEntries(['left', 'top', 'right', 'bottom'].map((x) => [x, median(big.map((b) => b[x]))]))} : {found: false};
    return save({...summary, rate: RATE, width, height, fps: Math.round(fps * 1000) / 1000, ...(cuts ? {cuts: shotCuts} : {}), samples});
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), force = args.includes('--force'), asJson = args.includes('--json');
  const publicDir = path.join(ROOT, 'public');
  try { if (NICE() > 0) os.setPriority(0, Math.min(19, NICE())); } catch {}
  const srcs = args.filter((a) => !a.startsWith('--'));
  if (!srcs.length) { console.error('usage: node scripts/face-scan.mjs <file under public/ or absolute> … [--force] [--json]'); process.exit(2); }
  const all = [];
  for (const src of srcs) {
    const t0 = Date.now();
    const e = await scanFaces(publicDir, path.isAbsolute(src) || !src.startsWith('public/') ? src : src.slice(7), {force});
    all.push(e);
    if (!asJson) console.log(`${src}: ${e.samples.length} samples, ${e.samples.filter((s) => s.faces.length).length} with a face (at most ${Math.max(0, ...e.samples.map((s) => s.faces.length))}), ${e.cuts?.length ?? 0} shot change(s)${e.cuts?.length ? ` at ${e.cuts.join(', ')} s` : ''} — ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  if (asJson) console.log(JSON.stringify(all, null, 2));
}
