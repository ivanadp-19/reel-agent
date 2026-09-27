#!/usr/bin/env node
// Faces over a whole source, for captions that never cover one (src/faces.ts). One ffmpeg pass per file,
// niced, one decoder thread: every frame tiny — the grade scan's 27×24 looks, whose structure hash splits the
// file into shots (sameShot: the rule the grade scan links a shot by; César's finished exports are one file of
// many shots) — and RATE frames a second at 640 px for YuNet (scripts/face.py: every face ≥ 3 % of the frame's
// height, with its score). Cached by path + size + mtime in public/clips/faces/<source>.json (faceCacheName),
// keeping the old summary (found, left, top, right, bottom: the largest face, at its median) for older readers,
// plus samples [{t, faces}], cuts [the source second each new shot starts] and the frame's size.
// The backend runs it in the grade scan's background lane after an ingest (and for the sources a validate finds
// unscanned); the captions job scans what it needs first. No venv or model (the VM): it throws with retry and
// the captions stay at the base top, with a warning. On demand:
//   node scripts/face-scan.mjs <file under public/ or absolute> … [--force] [--json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {LOOKS_VF, frameLooks, sameShot} from './grade-scan.mjs';
import {faceCacheName} from '../src/faces.ts';

export const FACE_VERSION = 1;
export const RATE = 2; // face samples a second
const ROOT = path.resolve(import.meta.dirname, '..');
const MODEL = path.join(ROOT, '.models', 'yunet.onnx');
const PY = path.join(ROOT, '.venv', 'bin', 'python');
const NICE = () => Number(process.env.REEL_GRADE_SCAN_NICE ?? 15);
const TIMEOUT = () => Number(process.env.REEL_GRADE_SCAN_TIMEOUT_MS || 600000);
const LOOK = 27 * 24 * 3;
const fileOf = (publicDir, src) => (path.isAbsolute(src) ? src : path.join(publicDir, src.replace(/^\//, '')));
const relOf = (publicDir, src) => path.relative(publicDir, fileOf(publicDir, src));
export const faceFile = (publicDir, src) => path.join(publicDir, 'clips', 'faces', faceCacheName(src));
const keyOf = (file) => { const st = fs.statSync(file); return {size: st.size, mtimeMs: Math.round(st.mtimeMs)}; };
export const canScanFaces = () => fs.existsSync(MODEL) && fs.existsSync(PY);

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

// a child niced, with a deadline; resolves its stdout (a Buffer), rejects with why ({retry} when it is not the file's fault)
function run(cmd, args, name, onData) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args);
    try { if (NICE() > 0) os.setPriority(c.pid, Math.min(19, NICE())); } catch {}
    const chunks = [];
    let err = '';
    const timer = setTimeout(() => c.kill('SIGKILL'), TIMEOUT());
    c.stdout.on('data', (d) => (onData ? onData(d) : chunks.push(d)));
    c.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    const fail = (msg, retry) => reject(Object.assign(new Error(`face scan of ${name}${msg}`), {retry}));
    c.on('error', (e) => { clearTimeout(timer); fail(`: ${e.code ?? e.message}`, true); });
    c.on('close', (code, sig) => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(chunks)) : sig ? fail(` stopped (${sig}: over ${TIMEOUT() / 1000} s?)`, true) : fail(`: ${err.trim().split('\n').pop() || `${path.basename(cmd)} exit ${code}`}`, false); });
  });
}
const probe = async (file, name) => {
  try { const s = JSON.parse(String(await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate,r_frame_rate', '-of', 'json', file], name))).streams[0]; const f = (r) => { const [n, d] = String(r).split('/').map(Number); return d ? n / d : n; }; return f(s.avg_frame_rate) || f(s.r_frame_rate) || 30; } catch { return 30; }
};
const median = (xs) => { const a = [...xs].sort((p, q) => p - q); return a[Math.floor(a.length / 2)]; };

// scan one file (cached): {version, src, size, mtimeMs, fps, rate, width, height, found, left…, samples, cuts}.
// cuts: false leaves the looks out (the judge's renders: only the faces). A file that does not decode is cached
// with its error (no samples; --force retries); no model, a deadline or no ffmpeg only throws: the next kick retries
export async function scanFaces(publicDir, src, {force = false, out = faceFile(publicDir, src), cuts = true} = {}) {
  const hit = !force && readFaces(publicDir, src, out);
  if (hit) return hit;
  if (!canScanFaces()) throw Object.assign(new Error('face scan: .venv or .models/yunet.onnx missing (run `npm run setup`)'), {retry: true});
  const file = fileOf(publicDir, src), name = relOf(publicDir, src), k = keyOf(file);
  const save = (e) => {
    const entry = {version: FACE_VERSION, src: name, ...k, ...e, scannedAt: new Date().toISOString()};
    const tmp = `${out}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(out), {recursive: true});
    fs.writeFileSync(tmp, JSON.stringify(entry));
    fs.renameSync(tmp, out);
    return entry;
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faces-'));
  try {
    const still = /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i.test(file); // an image B-roll: its one frame, no shots
    cuts &&= !still;
    const fps = cuts ? await probe(file, name) : null;
    const looks = [];
    let rest = Buffer.alloc(0);
    const graph = cuts ? `[0:v]split=2[a][b];[a]${LOOKS_VF}[l];[b]fps=${RATE},scale=-2:640[f]` : `[0:v]${still ? '' : `fps=${RATE},`}scale=-2:640[f]`;
    try {
      await run('ffmpeg', ['-hide_banner', '-v', 'error', '-threads', '1', '-filter_complex_threads', '1', '-i', file, '-an', '-filter_complex', graph,
        '-map', '[f]', '-q:v', '4', path.join(dir, '%06d.jpg'), ...(cuts ? ['-map', '[l]', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'] : [])], name, (d) => {
        const buf = Buffer.concat([rest, d]), whole = buf.length - (buf.length % LOOK);
        for (const f of frameLooks(buf.subarray(0, whole))) looks.push(f);
        rest = buf.subarray(whole);
      });
    } catch (e) { if (!e.retry) save({error: String(e.message).slice(0, 300), samples: [], cuts: []}); throw e; }
    const jpgs = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort().map((f) => path.join(dir, f));
    const found = jpgs.length ? JSON.parse(String(await run(PY, [path.join(ROOT, 'scripts', 'face.py'), MODEL, ...jpgs], name))) : {};
    const samples = jpgs.map((j, i) => ({t: Math.round((i / RATE) * 1000) / 1000, faces: (found[j]?.faces ?? []).map(({left, top, right, bottom, score}) => ({left: +left.toFixed(4), top: +top.toFixed(4), right: +right.toFixed(4), bottom: +bottom.toFixed(4), score}))}));
    const [width, height] = found[jpgs[0]]?.size ?? [];
    // the shots: frame k starts a new one where the structure jumps (k / fps, CFR as the grade scan reads it)
    const shotCuts = cuts ? looks.flatMap((f, i) => (i && !sameShot(looks[i - 1], f) ? [Math.round((i / fps) * 1000) / 1000] : [])) : undefined;
    const big = samples.map((s) => s.faces[0]).filter(Boolean);
    const summary = big.length ? {found: true, ...Object.fromEntries(['left', 'top', 'right', 'bottom'].map((x) => [x, median(big.map((b) => b[x]))]))} : {found: false};
    return save({...summary, rate: RATE, width, height, ...(cuts ? {fps: Math.round(fps * 1000) / 1000, cuts: shotCuts} : {}), samples});
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
