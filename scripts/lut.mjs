// LUT jobs (the backend's /api/lut, shared by set_grade / create_lut and the Styles tab):
//
//   {bake: [{key, src, lut, mix}]}   bake a .cube into a graded copy of each file
//     (public/clips/lut/<name>-<hash>.mp4 or .webm for person mattes, alpha kept),
//     cached by content; → public/lut.json {baked: {key: file}}
//   {make: {name, refs: [public paths], clips: [{src, inSec, outSec}], strength}}  make a .cube
//     from reference photos: the footage's color statistics (frames of the clips'
//     ranges, src/lut.ts lutSpans) matched to the references' → public/luts/<name>.cube;
//     → public/lut.json {lut: 'luts/<name>.cube'}
//   {match: {name, from: {id, src, inSec, outSec}, to: {id, src, inSec, outSec, lut?, mix?}, frames}}  fit a
//     .cube on pixel pairs (src/lut.ts fitCube): the frames of `from` at the join against `to`'s there (from's last vs
//     to's first; a tail after its shot: from's first vs to's last) through to's own LUT — the same shot a frame
//     apart (src/lut.ts matchPair) → public/luts/<name>.cube;
//     → public/lut.json {lut, pairs, before, after, worst} (mean |difference| of the pairs, of 255; worst = the
//     luma band the fit leaves most off, its mean R/G/B error); refused when the pairs stay far apart (another shot)
//
// Input: JSON (argv[2]); output file argv[3] (default public/lut.json). Deterministic ffmpeg + math, no model, no network.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {cubeFromReferences, fitCube, labStats, mixCube, parseCube, sampleCube} from '../src/lut.ts';
import {BAKE} from '../src/grade.ts';

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(PUBLIC, 'clips', 'lut');
const progress = (pct, label) => console.log(`PROGRESS:${pct}:${label}`);
const inPublic = (rel) => {
  const abs = path.resolve(PUBLIC, rel);
  if (!abs.startsWith(PUBLIC + path.sep) || !fs.existsSync(abs)) throw new Error(`not found under public/: ${rel}`);
  return abs;
};
const fpsOf = (file) => {
  const [a, b] = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate', '-of', 'csv=p=0', file], {encoding: 'utf8'}).stdout.trim().split('/').map(Number);
  return a / (b || 1) || 30;
};

// Decode to 0–1 RGB floats, one Float32Array (interleaved) per frame, W×H (the reel's 9:16 — color statistics and
// pixel pairs do not care about the aspect). Through planar float, the conversion the bake feeds lut3d, so a LUT is
// measured on what it will be applied to. span {inSec, outSec} = the frames the reel shows of a clip: the frame
// nearest each time, so [in, out) plays the frames with pts in [in − ½ frame, out − ½ frame); count = how many,
// spread over it (0 = all). Without a span: the first frame (a photo).
const W = 160, H = 284;
export function decode(file, {span, count = 1} = {}) {
  const pre = [], vf = [];
  if (span) {
    const half = 0.5 / fpsOf(file), start = Math.max(0, span.inSec - half), dur = span.outSec - half - start;
    pre.push('-ss', String(start), '-t', String(dur + 1));
    vf.push(`trim=end=${dur}`, ...(count ? [`fps=${count / dur}`] : []));
  }
  const r = spawnSync('ffmpeg', ['-v', 'error', ...pre, '-i', file, '-vf', [...vf, `scale=${W}:${H}:flags=area`, 'format=gbrpf32le'].join(','), ...(count ? ['-frames:v', String(count)] : []), '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], {maxBuffer: 1 << 30});
  if (r.status !== 0) throw new Error(`could not decode ${path.basename(file)}: ${String(r.stderr).trim().split('\n').pop()}`);
  const f = new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length)), n = W * H, out = [];
  for (let o = 0; o + n * 3 <= f.length; o += n * 3) {
    const px = new Float32Array(n * 3); // planes G, B, R → interleaved RGB
    for (let i = 0; i < n; i++) { px[i * 3] = f[o + 2 * n + i]; px[i * 3 + 1] = f[o + i]; px[i * 3 + 2] = f[o + n + i]; }
    out.push(px);
  }
  if (!out.length) throw new Error(`no frames in ${path.basename(file)}${span ? ` between ${span.inSec} and ${span.outSec} s` : ''}`);
  return out;
}
const concat = (arrs) => { const out = new Float32Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
const lutRel = (name) => { if (!/^[\w-]{1,40}$/.test(name)) throw new Error('LUT name: letters, digits, - and _ (≤ 40)'); return `luts/${name}.cube`; };
const writeLut = (rel, text) => { fs.mkdirSync(path.join(PUBLIC, 'luts'), {recursive: true}); fs.writeFileSync(path.join(PUBLIC, rel), text); return rel; };

export function makeLut({name, refs, clips = [], strength = 0.7}) {
  const rel = lutRel(name);
  if (!refs?.length) throw new Error('give at least one reference photo');
  if (!clips.length) throw new Error('the project has no clips to measure the footage from');
  progress(10, `Measuring ${refs.length} reference photo(s)`);
  const ref = labStats(concat(refs.flatMap((r) => decode(inPublic(r)))));
  progress(40, `Measuring ${clips.length} clip(s)`);
  const count = Math.max(2, Math.ceil(12 / clips.length)); // ~12 frames in all, spread over each clip's range
  const foot = labStats(concat(clips.flatMap((c) => decode(inPublic(c.src), {span: c, count}))));
  progress(80, 'Writing the LUT');
  return writeLut(rel, cubeFromReferences(foot, ref, name, {strength}));
}

// the frames either side of the join, nearest it first: `from`'s last ones against `to`'s first ones (a head before
// its continuation) — or, when `to` ends where `from` starts (a tail after its shot), from's first against to's last —
// through the LUT `to` plays with. SAME_SHOT = the mean difference (of 255) the fit must get under: a frame of motion
// leaves ~5, another shot ~40 (least squares on unrelated pixels regresses to gray, and the mean still falls)
const SAME_SHOT = 10;
const cubeAt = (lut, mix) => { const text = fs.readFileSync(inPublic(lut), 'utf8'); return parseCube(mix >= 1 ? text : mixCube(parseCube(text), mix)); };
const firstOf = (s) => decode(inPublic(s.src), {span: {...s, outSec: Math.min(s.outSec, s.inSec + 1)}, count: 0});
const lastOf = (s) => decode(inPublic(s.src), {span: {...s, inSec: Math.max(s.inSec, s.outSec - 1)}, count: 0}).reverse();
export function matchLut({name, from, to, frames = 3}) {
  const rel = lutRel(name);
  progress(10, 'Reading the frames at the join');
  const tail = Math.abs(to.outSec - from.inSec) < 0.001;
  const [a, b] = tail ? [firstOf(from), lastOf(to)] : [lastOf(from), firstOf(to)];
  const k = Math.min(frames, a.length, b.length);
  const x = concat(a.slice(0, k)), y = concat(b.slice(0, k));
  if (to.lut) { const l = cubeAt(to.lut, to.mix ?? 1); for (let i = 0; i < y.length; i += 3) y.set(sampleCube(l, [y[i], y[i + 1], y[i + 2]]), i); }
  progress(50, `Fitting ${k} frame pair(s)`);
  const text = fitCube(x, y, {title: name});
  const l = parseCube(text), n = x.length / 3, bands = Array.from({length: 10}, () => [0, 0, 0, 0]); // luma tenths: R, G, B error, pairs
  let before = 0, after = 0;
  for (let i = 0; i < n; i++) {
    const p = [x[i * 3], x[i * 3 + 1], x[i * 3 + 2]], o = sampleCube(l, p), band = bands[Math.min(9, Math.floor((0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) * 10))];
    band[3]++;
    for (let c = 0; c < 3; c++) { before += Math.abs(y[i * 3 + c] - p[c]); after += Math.abs(y[i * 3 + c] - o[c]); band[c] += o[c] - y[i * 3 + c]; }
  }
  const r1 = (v) => Math.round(v * 2550) / 10, bef = r1(before / n / 3), aft = r1(after / n / 3);
  if (aft > SAME_SHOT) throw new Error(`${from.id ?? 'the clip'} and ${to.id ?? 'the other'} do not show the same picture at the join (mean difference ${bef} → ${aft} of 255 after the fit, over ${SAME_SHOT}): a match needs the same shot either side of a split`);
  // the mean hides a cast on a tenth of the picture (the blacks): the band (≥ 1 % of the pairs) left most off
  const worst = bands.map((s, i) => ({luma: [Math.round(i * 25.5), Math.round((i + 1) * 25.5)], rgb: s.slice(0, 3).map((v) => r1(v / s[3])), share: s[3] / n}))
    .filter((w) => w.share >= 0.01).reduce((w, v) => (Math.max(...v.rgb.map(Math.abs)) > Math.max(...w.rgb.map(Math.abs)) ? v : w));
  return {lut: writeLut(rel, text), pairs: k, before: bef, after: aft, worst: {luma: worst.luma, rgb: worst.rgb}};
}

export function bake({key, src, lut, mix}) {
  const input = inPublic(src);
  const text = fs.readFileSync(inPublic(lut), 'utf8');
  const cubeText = mix >= 1 ? text : mixCube(parseCube(text), mix);
  parseCube(cubeText); // refuse a broken .cube before ffmpeg does
  const alpha = /\.webm$/i.test(src); // a person matte: VP9 with alpha, as scripts/matte.mjs writes it
  const hash = crypto.createHash('sha1').update(cubeText).update(String(fs.statSync(input).mtimeMs)).update(src).update(BAKE).digest('hex').slice(0, 10);
  const rel = `clips/lut/${path.basename(src).replace(/\.[^.]+$/, '')}-${hash}.${alpha ? 'webm' : 'mp4'}`;
  const out = path.join(PUBLIC, rel);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return rel;
  fs.mkdirSync(OUT, {recursive: true});
  // this process's own temp names: two bakes of one key (a render's and the editor's, a retry next to an orphan)
  // never write into each other's file — the last complete one is renamed in
  const cubeFile = path.join(OUT, `.${hash}-${process.pid}.cube`);
  fs.writeFileSync(cubeFile, cubeText);
  const vf = `format=${alpha ? 'gbrapf32le' : 'gbrpf32le'},lut3d=file=${cubeFile}:interp=tetrahedral,format=${alpha ? 'yuva420p' : 'yuv420p'}`;
  const enc = alpha
    ? ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30', '-row-mt', '1', '-an']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart'];
  const tmp = `${out}.part-${process.pid}${path.extname(out)}`;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...(alpha ? ['-c:v', 'libvpx-vp9'] : []), '-i', input, '-vf', vf, ...enc, tmp]);
  fs.rmSync(cubeFile, {force: true});
  if (r.status !== 0) { fs.rmSync(tmp, {force: true}); throw new Error(`LUT bake failed for ${path.basename(src)}: ${String(r.stderr).trim().split('\n').pop()}`); }
  fs.renameSync(tmp, out);
  return rel;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const result = {};
  if (job.make) result.lut = makeLut(job.make);
  if (job.match) Object.assign(result, matchLut(job.match));
  if (job.bake?.length) {
    result.baked = {};
    job.bake.forEach((b, i) => {
      progress(5 + Math.round((i / job.bake.length) * 90), `Applying ${path.basename(b.lut)} to ${path.basename(b.src)}`);
      result.baked[b.key] = bake(b);
    });
  }
  // argv[3]: where to write the result (a job's or a render's bake: its own file; by hand: public/lut.json)
  fs.writeFileSync(process.argv[3] ?? path.join(PUBLIC, 'lut.json'), JSON.stringify(result, null, 2));
  progress(100, 'Done');
}
