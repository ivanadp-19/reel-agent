#!/usr/bin/env node
// Look steps inside continuous footage, frame by frame — shared by the half-graded source scan
// (validate 'half-graded') and the render judge's grade-coverage.
//
// A pre-edit graded only in part (César's G10: the grade starts ~10 frames after a real cut) cannot be
// seen at 1 or 2 fps (scripts/grade.mjs, the judge's 2 fps medians): this decodes EVERY frame, tiny
// (27×24 yuv444p — mean Y/U/V, saturation and the 9×8 structure hash of each), and calls a step a
// change of look between two consecutive frames whose structure stays the same (hash within
// MAX_HASH bits). A real cut changes the structure, so it is never a step; neither is a drift, a
// flicker, a camera's exposure / white balance or a dissolve (the look must switch between two frames
// and hold on both sides), nor the odd frame at a cut (each side needs a few frames): lookSteps.
//
// The source scan: one pass per source at its native frame rate, niced (REEL_GRADE_SCAN_NICE, 15),
// one decoder thread, cached by path + size + mtime (the catalog's pattern) in
// public/clips/grade-scan/<its path under public/>.json. The backend runs it in the background after an ingest and
// when validate finds a source unscanned (createGradeScans) — never inside a request; on demand:
//   node scripts/grade-scan.mjs <file under public/ or absolute> … [--force] [--json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

export const SCAN_VERSION = 4; // 2: stretches link over camera motion, the shorter side is the odd one, the whole picture moves; 3: tone + color together (SOURCE_NEED), the input's own range on any ffmpeg; 4: one channel alone on the same picture, one (limited) scale
const W = 27, H = 24, N = W * H; // 3×3 blocks → the judge's 9×8 hash grid
export const MAX_HASH = 6; // dHash bits (of 64) apart = the same picture (the judge's hashDist)
export const CUT_HASH = 12; // … and still the same shot: camera motion reaches 7–11 bits in César's footage, his real cuts ≥ 14
export const GLOBAL = 0.5; // how much of the frame's move the median block must share (lookSteps)
// ponytail: what a real Morantes 10 shot with a synthetic step shows is NOT found: a contrast-only change (an S-curve:
// mean luma −0.7, the median block 0.2 of it), a hue rotation (V −2.5, saturation unchanged), saturation ×1.38 alone
// (log2 0.47, U −3.3) or with ΔY +2 — every one under its bar; a gradient channel would see the first, lower chroma
// bars the others at the price of the jump cuts' ~2
// the source rule (SOURCE_NEED): a grade moves tone AND color in the same frame — ΔY ≥ 4 together with saturation ×1.4
// (log2 of it ≥ 0.5, floored at 1 so grey footage never divides by ~0) — or either far on its own (ΔY ≥ 12,
// saturation ×2), up to the shot's link (CUT_HASH): a strong grade flips the structure hash by itself; and on the same
// picture (≤ MAX_HASH) one channel alone — ΔY ≥ 7 (an exposure lift, an RGB gain) or U / V ≥ 4 (a white balance). A
// camera's exposure ramps over frames (the `once` guard), a take's new white balance comes with a jump cut: the
// picture moves (6–12 bits) and the chroma only ~2. Calibrated on every frame of G1, G2's three takes, G10, the 14
// finished exports (Morantes) and 3 test clips (sourceSteps), all read on limited range (frameLooks): G10's three heads
// step ΔY +32..37, ×4.4–5.0 (3–4 bits); Morantes 10's tails ΔY +7.7, ×1.97, U +7.7 (7 frames at 12.212 s, 0 bits) and
// ΔY +9.4..10.4, ×1.9 (3 frames at 8.742 and 24.591 s, 8–10 bits). Nothing else passes: what passes every other guard
// is a jump cut between takes — Morantes 10.1 at 14.748 s (V +2.2, ×1.15, 6 bits), the rooftop's in G10, Morantes 10
// and 10.1 at 30.9–31.2 s (U, V ±2.2, 8 bits), Morantes 9 at 37.571 s (luma +6, 12 bits) — or under 0.2 of any;
// without the other guards a 1-frame card at a cut (Morantes 4.1, minSide) would, and without the structure hash
// every real cut (15–42 bits). Synthetic steps inside a real Morantes 10 shot (0 bits): an exposure step ΔY +8, an RGB
// gain +9.4 and a white balance U −5.2 / V +4.9 are found; ΔY +6 alone is not. The old bars (12 or ×2 alone, 6 bits)
// missed all three of Morantes 10
export const SOURCE_CHANNELS = [{key: 'luma', t: 4, of: (f) => f.y}, {key: 'log2 sat', t: 0.5, of: (f) => Math.log2(Math.max(f.s, 1))}, {key: 'U', t: 4, of: (f) => f.u}, {key: 'V', t: 4, of: (f) => f.v}];
export const SOURCE_NEED = (by, bits = 0) => (by.luma != null && by['log2 sat'] != null) || Math.abs(by.luma ?? 0) >= 12 || Math.abs(by['log2 sat'] ?? 0) >= 1
  || (bits <= MAX_HASH && (Math.abs(by.luma ?? 0) >= 7 || by.U != null || by.V != null));

// 64-bit difference hash of a 9×8 grayscale frame (the judge's frame hash)
export function dhash(px) {
  let h = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) h = (h << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
  return h;
}
export function hamming(a, b) { let x = a ^ b, n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; }

// raw 27×24 yuv444p frames → [{y, u, v, s, h, b}]: mean luma / chroma, mean saturation (signalstats' SATAVG:
// |U−128, V−128|), the dHash of the 3×3-block means (8-bit, as ffmpeg delivers them) and those 72 blocks'
// own means (b: y, u, v, s × 72 — lookSteps' check that a step moves the whole picture). range: the frames' own
// (looksVf); a full-range file's values are mapped onto the limited scale (luma 16 + y × 219/255, chroma × 224/255
// around 128 — affine, so exact on the means), so a render (pc) and its sources (tv) are measured on one scale by one
// set of bars — on any ffmpeg (6.1's own pc → tv conversion rounds chroma differently from 8's)
export function frameLooks(buf, range = 'tv') {
  const [ky, kc] = range === 'pc' ? [219 / 255, 224 / 255] : [1, 1], y0 = range === 'pc' ? 16 : 0;
  const out = [];
  for (let o = 0; o + 3 * N <= buf.length; o += 3 * N) {
    const g = new Float64Array(4 * 72);
    let y = 0, u = 0, v = 0, s = 0;
    for (let i = 0; i < N; i++) {
      const a = buf[o + i], p = buf[o + N + i] - 128, q = buf[o + 2 * N + i] - 128, r = Math.hypot(p, q);
      const j = Math.floor(i / W / 3) * 9 + Math.floor((i % W) / 3);
      y += a; u += p; v += q; s += r;
      g[j] += a; g[72 + j] += p; g[144 + j] += q; g[216 + j] += r;
    }
    const b = Float32Array.from(g, (x, i) => (i < 72 ? y0 + (x / 9) * ky : i < 216 ? 128 + (x / 9) * kc : (x / 9) * kc));
    out.push({y: y0 + (y / N) * ky, u: 128 + (u / N) * kc, v: 128 + (v / N) * kc, s: (s / N) * kc, h: dhash(g), b});
  }
  return out;
}
// the ffmpeg filter that makes those frames — the source scan's, and the judge's on a render's own frames — in the
// input's own range (rangeOf; frameLooks puts them on one scale): ffmpeg < 7.1 (the VM's 6.1) squeezes a full-range
// input to limited on the way to yuv444p unless told (steps ×0.86 luma, ×0.88 chroma) and, without accurate_rnd +
// full_chroma_int, averages a 1080×1920 frame off by up to 14 %; so 6.1.1 and 8.0.1 give the same bytes
export const looksVf = (range) => { const r = range === 'pc' ? 'pc' : 'tv'; return `scale=${W}:${H}:flags=area+accurate_rnd+full_chroma_int:in_range=${r}:out_range=${r},format=yuv444p`; };
// a video stream's range as ffprobe reports it: pc (full: Remotion's renders, phone footage) when tagged so or in a
// J pixel format, else tv
export const rangeOf = (s) => (s?.color_range === 'pc' || /^yuvj/.test(s?.pix_fmt ?? '') ? 'pc' : 'tv');

const median = (xs) => { const a = [...xs].sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : 0; };
const spread = (xs) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);

// Steps of look inside continuous footage. frames: frameLooks'; channels: [{key, t, of(frame)}] — a step
// needs, on one channel: the jump between frames k−1 and k ≥ t and ≥ noiseK × the local noise (median
// |change| of the other pairs in the windows); the level (medians of up to `win` frames each side) moved
// ≥ t, ≥ `once` of it in that one jump (a grade switches between two frames; a camera's exposure or
// white balance and a dissolve spread over several: G2's takes 0.6–0.85, G10's heads 0.96–1.03); both
// sides steady (their spreads together ≤ half the move — no drift, no flicker) and ≥ minSide frames
// long (the odd blended frame right at a cut is not a head); the whole picture moving — the median of the
// 72 blocks' own level moves ≥ `global` × the frame's (a grade moves every region: G10's heads 0.8–1.3, a
// half-fixed join's residual 0.7–0.9; a screen, a lamp or a window behind the presenter moves one: ≤ 0.25,
// even punched in close enough to share the structure hash).
// Frames k−1 and k show the same picture (hash ≤ maxHash); the same-shot stretch around it links frames
// up to cutHash apart (camera motion 7–11 bits in César's footage, real cuts ≥ 14).
// ok(k): frame k may be measured (the judge: not under B-roll, text or a transition); joined(k): frames
// k−1 and k are one stretch of footage (the judge: the same clip, or a clip that continues it); need(by): which
// channels that stepped make a step, given the hash bits k−1 → k (default any one — the source rule: SOURCE_NEED).
// → [{k, from, to, by: {key: move}}], from / to = the footage the step splits: back to the cut that starts
// the shot (or the step before it), on to the next step (or the cut that ends it) — the shorter side is
// the part in another grade
// ponytail: a look change shorter than minSide frames (a 1–2-frame flash) is not seen here
export function lookSteps(frames, channels, {win = 6, noiseK = 4, once = 0.9, minSide = 3, maxHash = MAX_HASH, cutHash = CUT_HASH, global = GLOBAL, ok = () => true, joined = () => true, need = (by) => Object.keys(by).length > 0} = {}) {
  const hd = (k) => hamming(frames[k - 1].h, frames[k].h);
  const link = (k) => k > 0 && k < frames.length && ok(k - 1) && ok(k) && joined(k) && hd(k) <= cutHash;
  const block = (f, j) => ({y: f.b[j], u: f.b[72 + j], v: f.b[144 + j], s: f.b[216 + j]});
  const out = [];
  for (let a = 0; a < frames.length;) {
    let b = a + 1; // [a, b): one same-shot stretch
    while (b < frames.length && link(b)) b++;
    const here = [];
    for (let k = a + minSide; k <= b - minSide; k++) {
      if (hd(k) > maxHash) continue;
      const before = frames.slice(Math.max(a, k - win), k), after = frames.slice(k, Math.min(b, k + win));
      const by = {};
      for (const c of channels) {
        const jump = c.of(frames[k]) - c.of(frames[k - 1]);
        if (Math.abs(jump) < c.t) continue;
        const bv = before.map(c.of), av = after.map(c.of);
        const move = median(av) - median(bv);
        if (Math.abs(move) < c.t || jump / move < once || spread(bv) + spread(av) > Math.abs(move) / 2) continue;
        const d = (xs) => xs.slice(1).map((x, i) => Math.abs(x - xs[i]));
        if (Math.abs(jump) < noiseK * median([...d(bv), ...d(av)])) continue;
        const blocks = Array.from({length: 72}, (_, j) => (median(after.map((f) => c.of(block(f, j)))) - median(before.map((f) => c.of(block(f, j))))) / move);
        if (median(blocks) < global) continue;
        by[c.key] = Math.round(move * 100) / 100;
      }
      if (need(by, hd(k))) here.push({k, by});
    }
    here.forEach(({k, by}, i) => out.push({k, from: here[i - 1]?.k ?? a, to: here[i + 1]?.k ?? b, by}));
    a = b;
  }
  return out;
}

// ---------- the source scan (half-graded pre-edits) ----------

const NICE = () => Number(process.env.REEL_GRADE_SCAN_NICE ?? 15);
const THREADS = () => String(process.env.REEL_GRADE_SCAN_THREADS || 1);
const TIMEOUT = () => Number(process.env.REEL_GRADE_SCAN_TIMEOUT_MS || 600000);
const fileOf = (publicDir, src) => (path.isAbsolute(src) ? src : path.join(publicDir, src.replace(/^\//, '')));
// a source's key: its path under public/ ("clips/a.mp4", however it was named), + size + mtime
const relOf = (publicDir, src) => path.relative(publicDir, fileOf(publicDir, src));
export const cacheFile = (publicDir, src) => path.join(publicDir, 'clips', 'grade-scan', `${relOf(publicDir, src).replace(/[^\w.-]+/g, '_')}.json`);
const keyOf = (file) => { const st = fs.statSync(file); return {size: st.size, mtimeMs: Math.round(st.mtimeMs)}; };

// the cached scan of a source while it is current (same path, size + mtime), else null; undefined = no such file
export function readScan(publicDir, src) {
  const file = fileOf(publicDir, src);
  if (!fs.existsSync(file)) return undefined;
  try {
    const e = JSON.parse(fs.readFileSync(cacheFile(publicDir, src), 'utf8')), k = keyOf(file);
    return e.version === SCAN_VERSION && e.src === relOf(publicDir, src) && e.size === k.size && e.mtimeMs === k.mtimeMs ? e : null;
  } catch { return null; }
}

// one decode of the whole file at its own frame rate → its frames; niced, one thread, a deadline. Errors
// name the source by `name` (its path under public/: the message reaches remote agents); one that is
// not the file's fault (killed at the deadline, ffmpeg missing) is `retry`
function decode(file, name, range) {
  return new Promise((resolve, reject) => {
    const c = spawn('ffmpeg', ['-hide_banner', '-v', 'error', '-threads', THREADS(), '-i', file, '-an', '-fps_mode', 'passthrough', '-vf', looksVf(range), '-f', 'rawvideo', '-']);
    try { if (NICE() > 0) os.setPriority(c.pid, Math.min(19, NICE())); } catch {}
    const looks = [];
    let rest = Buffer.alloc(0), err = '';
    const timer = setTimeout(() => c.kill('SIGKILL'), TIMEOUT());
    c.stdout.on('data', (d) => { // frame by frame as they come: a long source never sits in memory raw
      const buf = Buffer.concat([rest, d]), whole = buf.length - (buf.length % (3 * N));
      for (const f of frameLooks(buf.subarray(0, whole), range)) looks.push(f);
      rest = buf.subarray(whole);
    });
    c.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    const fail = (msg, retry) => reject(Object.assign(new Error(`grade scan of ${name}${msg}`), {retry}));
    c.on('error', (e) => { clearTimeout(timer); fail(`: ${e.code ?? e.message}`, true); });
    c.on('close', (code, sig) => { clearTimeout(timer); code === 0 ? resolve(looks) : sig ? fail(` stopped (${sig}: over ${TIMEOUT() / 1000} s?)`, true) : fail(`: ${err.trim().split('\n').pop().split(file).join(name) || `ffmpeg exit ${code}`}`, false); });
  });
}
// → {fps, range}
const probe = (file) => new Promise((resolve) => {
  const c = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate,r_frame_rate,color_range,pix_fmt', '-of', 'json', file]);
  let out = '';
  c.stdout.on('data', (d) => (out += d));
  c.on('close', () => { try { const s = JSON.parse(out).streams[0]; const f = (r) => { const [n, d] = String(r).split('/').map(Number); return d ? n / d : n; }; resolve({fps: f(s.avg_frame_rate) || f(s.r_frame_rate) || 30, range: rangeOf(s)}); } catch { resolve({fps: 30, range: 'tv'}); } });
  c.on('error', () => resolve({fps: 30, range: 'tv'}));
});

// frames + fps → the half-graded steps, in source seconds: at = the first frame with the new look, from / to =
// the footage the step splits (from = the cut that starts the shot, or the step before); dY and the saturation
// either side for the message. The shorter side is the part in another grade (as the judge's grade-coverage):
// before the step = the grade switches on late (a head, [from, at) — César's G10), after it = it stops early
// (off: a tail, [at, to)); frames = its length. Which side is flatter says nothing: a pop can be over-graded.
// ponytail: frame k at k / fps — exact for CFR (César's exports, the ingest's transcodes); a VFR phone
// remux drifts by its jitter (pts from the decode if one ever lands a split on the wrong frame)
export function sourceSteps(frames, fps) {
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return lookSteps(frames, SOURCE_CHANNELS, {need: SOURCE_NEED, maxHash: CUT_HASH}).map(({k, from, to}) => {
    const off = to - k < k - from;
    return {frame: k, at: r3(k / fps), from: r3(from / fps), to: r3(to / fps), ...(off ? {off} : {}), frames: off ? to - k : k - from, dY: Math.round((frames[k].y - frames[k - 1].y) * 10) / 10, sat: [frames[k - 1].s, frames[k].s].map((x) => Math.round(x * 10) / 10)};
  });
}

// scan one source (cached): {version, src, size, mtimeMs, fps, frames, steps}. A file that does not decode is
// cached too ({error}, no steps) and thrown: it is not decoded again on every validate (--force retries); a
// scan stopped for any other reason (its deadline on a busy box, no ffmpeg) is only thrown: the next kick retries
export async function scanSource(publicDir, src, {force = false} = {}) {
  const hit = !force && readScan(publicDir, src);
  if (hit) return hit;
  const file = fileOf(publicDir, src);
  const k = keyOf(file);
  const save = (e) => {
    const entry = {version: SCAN_VERSION, src: relOf(publicDir, src), ...k, ...e, scannedAt: new Date().toISOString()};
    const out = cacheFile(publicDir, src), tmp = `${out}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(out), {recursive: true});
    fs.writeFileSync(tmp, JSON.stringify(entry));
    fs.renameSync(tmp, out);
    return entry;
  };
  const {fps, range} = await probe(file);
  let frames;
  try { frames = await decode(file, relOf(publicDir, src), range); } catch (e) { if (!e.retry) save({error: String(e?.message ?? e).slice(0, 300), steps: []}); throw e; }
  return save({fps: Math.round(fps * 1000) / 1000, frames: frames.length, steps: sourceSteps(frames, fps)});
}

// The backend's background lane: kick(srcs) queues each unscanned source (a second kick of one queued
// or running joins it) and never throws; one scan at a time for the whole backend. read: what counts as
// scanned (the backend's lane also runs the wind scan, scripts/wind-scan.mjs, and wants both current)
export function createGradeScans({publicDir, log = console.log, scan = (src) => scanSource(publicDir, src), read = readScan} = {}) {
  const queued = new Set();
  let chain = Promise.resolve();
  const kick = (srcs) => {
    for (const src of [].concat(srcs)) {
      if (queued.has(src) || read(publicDir, src) !== null) continue; // current, or no such file
      queued.add(src);
      chain = chain.then(async () => {
        const t0 = Date.now();
        try { const e = await scan(src); log(`grade scan ${src}: ${e.frames} frames, ${e.steps.length} half-graded step(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s`); } catch (e) { log(`grade scan ${src}: ${String(e?.message ?? e).slice(0, 300)}`); } finally { queued.delete(src); }
      });
    }
    return chain;
  };
  return {kick, pending: (src) => queued.has(src)};
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), force = args.includes('--force'), asJson = args.includes('--json');
  const publicDir = path.resolve(import.meta.dirname, '..', 'public');
  try { if (NICE() > 0) os.setPriority(0, Math.min(19, NICE())); } catch {}
  const srcs = args.filter((a) => !a.startsWith('--'));
  if (!srcs.length) { console.error('usage: node scripts/grade-scan.mjs <file under public/ or absolute> … [--force] [--json]'); process.exit(2); }
  const all = [];
  for (const src of srcs) {
    const e = await scanSource(publicDir, path.isAbsolute(src) || !src.startsWith('public/') ? src : src.slice(7), {force});
    all.push(e);
    if (!asJson) console.log(`${src}: ${e.frames} frames at ${e.fps} fps — ${e.steps.length ? e.steps.map((s) => `look changes at ${s.at} s (frame ${s.frame}; ΔY ${s.dY}, saturation ${s.sat[0]} → ${s.sat[1]}) inside the shot from ${s.from} s`).join('; ') : 'no half-graded step'}`);
  }
  if (asJson) console.log(JSON.stringify(all, null, 2));
}
