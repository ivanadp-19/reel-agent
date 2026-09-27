import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {cube} from '../src/hdr.ts';
import {fitCube, labStats, lutSpans, matchCandidates, matchPair, mixCube, oklabToRgb, parseCube, rgbToOklab, sampleCube, transferFn} from '../src/lut.ts';
import {withLut} from '../src/grade.ts';
import {decode} from '../scripts/lut.mjs';

const close = (a, b, e = 2e-3) => a.every((v, i) => Math.abs(v - b[i]) < e);

test('a .cube round-trips: identity samples as identity, a mix goes half way', () => {
  const id = parseCube(cube((c) => c, 17, 'id'));
  assert.ok(close(sampleCube(id, [0.2, 0.5, 0.9]), [0.2, 0.5, 0.9]));
  const inv = parseCube(cube(([r, g, b]) => [1 - r, 1 - g, 1 - b], 17, 'inv'));
  assert.ok(close(sampleCube(inv, [0.2, 0.5, 0.9]), [0.8, 0.5, 0.1]));
  const half = parseCube(mixCube(inv, 0.5));
  assert.ok(close(sampleCube(half, [0.2, 0.5, 0.9]), [0.5, 0.5, 0.5]));
  assert.throws(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n'), /entries/);
  assert.throws(() => parseCube('LUT_1D_SIZE 4\n'), /1D/);
});

test('Oklab round-trip', () => {
  for (const c of [[0, 0, 0], [1, 1, 1], [0.8, 0.4, 0.2], [0.1, 0.5, 0.9]]) assert.ok(close(oklabToRgb(rgbToOklab(c)), c, 1e-4), String(c));
});

// synthetic "footage" and "references" as pixel arrays (no photos needed)
const img = (fn, n = 4000) => { const px = new Float32Array(n * 3); for (let i = 0; i < n; i++) { const t = i / (n - 1); px.set(fn(t, i), i * 3); } return px; };
test('reference transfer: warm, contrasty references pull flat, cool footage toward them — bounded, monotone', () => {
  const footage = labStats(img((t) => [0.3 + 0.35 * t, 0.32 + 0.35 * t, 0.38 + 0.35 * t])); // flat and bluish
  const refs = labStats(img((t) => [Math.min(1, 0.05 + 0.95 * t * 1.02), 0.04 + 0.9 * t, 0.02 + 0.8 * t])); // full range, warm
  const f = transferFn(footage, refs, {strength: 1});
  const [lo, hi] = [f([0.3, 0.32, 0.38]), f([0.65, 0.67, 0.73])];
  assert.ok(hi[1] - lo[1] > 0.35 - 0.02, 'more contrast');
  assert.ok(hi[0] - hi[2] > 0.65 - 0.73, 'warmer than it was');
  // monotone in lightness along a gray ramp
  let prev = -1;
  for (let v = 0; v <= 1.0001; v += 0.05) { const L = rgbToOklab(f([v, v, v]))[0]; assert.ok(L >= prev - 1e-6, `L at ${v}`); prev = L; }
  // strength 0 = identity
  assert.ok(close(transferFn(footage, refs, {strength: 0})([0.4, 0.5, 0.6]), [0.4, 0.5, 0.6], 1e-4));
});

// ---- match (fitCube): pixel pairs → a bounded .cube ----
const rand = (() => { let a = 7; return () => ((a = (a * 1664525 + 1013904223) >>> 0) / 2 ** 32); })(); // deterministic
const pairsOf = (n, pick, map) => { const x = new Float32Array(n * 3), y = new Float32Array(n * 3); for (let i = 0; i < n; i++) { const p = pick(); x.set(p, i * 3); y.set(map(p), i * 3); } return {x, y}; };
const affine = (M, o) => (p) => M.map((row, c) => row[0] * p[0] + row[1] * p[1] + row[2] * p[2] + o[c]);

test('fitCube recovers a known matrix + offset where the pairs are, and identity pairs give the identity', () => {
  const f = affine([[0.9, 0.12, -0.02], [0.05, 0.85, 0.05], [-0.03, 0.1, 0.8]], [0.04, 0.02, 0.07]);
  const {x, y} = pairsOf(20000, () => [0.1 + 0.8 * rand(), 0.1 + 0.8 * rand(), 0.1 + 0.8 * rand()], f);
  const l = parseCube(fitCube(x, y));
  for (const p of [[0.3, 0.5, 0.7], [0.6, 0.4, 0.2], [0.5, 0.5, 0.5]]) assert.ok(close(sampleCube(l, p), f(p), 3e-3), String(p));
  const id = parseCube(fitCube(x, x));
  for (const p of [[0.3, 0.5, 0.7], [0, 0, 0], [1, 1, 1], [1, 0, 0.2], [0.05, 0.95, 0.5]]) assert.ok(close(sampleCube(id, p), p, 3e-3), `identity at ${p}`);
});

test('fitCube is bounded out of sample: a color the pairs never showed gets the correction of the nearest one they did', () => {
  // flat, almost gray footage (a camera log profile) → ×5 saturation and a lift: what a pre-edit's grade does to its head
  const K = [0.2126, 0.7152, 0.0722], grade = (p) => { const Y = K[0] * p[0] + K[1] * p[1] + K[2] * p[2]; return p.map((v) => Y + 5 * (v - Y) + 0.1); };
  const {x, y} = pairsOf(20000, () => { const t = 0.25 + 0.45 * rand(); return [t + 0.03 * (rand() - 0.5), t + 0.03 * (rand() - 0.5), t + 0.03 * (rand() - 0.5)]; }, grade);
  let seen = 0; for (let i = 0; i < x.length; i++) seen = Math.max(seen, Math.abs(y[i] - x[i]));
  const l = parseCube(fitCube(x, y));
  assert.ok(close(sampleCube(l, [0.45, 0.46, 0.44]), grade([0.45, 0.46, 0.44]), 0.01), 'in sample it is the grade');
  // over the whole cube (saturated colors the footage never had): the unbounded fit pushes [0.5, 0.9, 0.5] by −0.5
  // in red; bounded, no correction exceeds what the pairs showed plus the ×5 gain over the one cube cell
  // the fit reaches past them (so the nodes around the data carry its gain)
  let worst = 0;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) for (let k = 0; k <= 10; k++) {
    const p = [i / 10, j / 10, k / 10], o = sampleCube(l, p);
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(o[c] - p[c]));
  }
  assert.ok(worst <= seen + 4 / 32 + 0.01, `worst correction ${worst.toFixed(3)} vs ${seen.toFixed(3)} seen in the pairs`);
  // and monotone: no channel falls while its own input rises
  for (let n = 0; n < l.size ** 3; n++) for (const [c, step] of [[0, 1], [1, l.size], [2, l.size ** 2]]) {
    if (Math.floor(n / step) % l.size > 0) assert.ok(l.data[n * 3 + c] >= l.data[(n - step) * 3 + c] - 1e-6, `node ${n} channel ${c}`);
  }
});

test('fitCube keeps grays gray where the pairs are, even where the fit dips next to them (the blacks of G10 s3)', () => {
  // crushed shadows, ×5 saturation, and a hue twist that grows toward the darks but keeps grays gray (what a real
  // join's motion makes the fit do): G's output falls as G rises just off the gray axis. A running max lifted the
  // gray nodes to their off-axis neighbour — +21/255 of green on a gray; the pairs' own nodes must keep their fit
  const K = [0.2126, 0.7152, 0.0722], grade = (p) => {
    const Y = K[0] * p[0] + K[1] * p[1] + K[2] * p[2], o = p.map((v) => Math.max(0, (Y - 0.1) * 1.5) + 5 * (v - Y));
    o[1] += 4 * ((0.5 - Y) / 0.25) * (p[2] - Y);
    return o;
  };
  const {x, y} = pairsOf(20000, () => { const t = rand() < 0.035 ? 0.14 + 0.08 * rand() : 0.3 + 0.4 * rand(); return [0, 0, 0].map(() => t + 0.03 * (rand() - 0.5)); }, grade);
  const l = parseCube(fitCube(x, y));
  for (let v = 0.16; v <= 0.68; v += 0.005) {
    if (v > 0.2 && v < 0.32) continue; // no pairs there (and few at the edges of the two groups)
    const o = sampleCube(l, [v, v, v]);
    assert.ok(Math.max(...o) - Math.min(...o) <= 2 / 255, `gray ${Math.round(v * 255)} → ${o.map((c) => Math.round(c * 255)).join('/')}`);
  }
});

test('fitCube keeps the target\'s saturation where the pairs scatter (a pop: +luma, chroma ×2, clipped, off by a few pixels)', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const n = 6000, x = new Float64Array(n * 3), y = new Float64Array(n * 3);
  const C = (r, g, b) => { const l = 0.2126 * r + 0.7152 * g + 0.0722 * b; return Math.hypot(b - l, r - l); };
  let t = 0;
  for (let i = 0; i < n; i++) {
    const l = 0.15 + 0.7 * rnd(), rgb = [0, 1, 2].map(() => Math.min(1, Math.max(0, l + (rnd() - 0.5) * 0.5)));
    const ly = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    y.set(rgb, i * 3); t += C(...rgb);
    x.set(rgb.map((v) => Math.min(1, Math.max(0, ly + 0.1 + (v - ly) * 2 + (rnd() - 0.5) * 0.3))), i * 3);
  }
  const l = parseCube(fitCube(x, y));
  let o = 0;
  for (let i = 0; i < n; i++) o += C(...sampleCube(l, [x[i * 3], x[i * 3 + 1], x[i * 3 + 2]]));
  assert.ok(Math.abs(o / t - 1) < 0.03, `fitted saturation ×${(o / t).toFixed(3)} of the target's`);
});

test('lutSpans / matchPair / withLut: a clip\'s range, the clip continuing it, its grade taken over', () => {
  const clips = [{id: 'a', src: 'clips/x.mp4', inSec: 0, outSec: 8.87}, {id: 'head', src: 'clips/x.mp4', inSec: 8.87, outSec: 9.204}, {id: 'rest', src: 'clips/x.mp4', inSec: 9.204, outSec: 12.47}, {id: 'other', src: 'clips/y.mp4', inSec: 0, outSec: 3}];
  assert.deepEqual(lutSpans(clips, 'head'), [{id: 'head', src: 'clips/x.mp4', inSec: 8.87, outSec: 9.204}]);
  assert.equal(lutSpans(clips).length, 4);
  assert.equal(lutSpans(clips, 'clips/x.mp4').length, 3);
  assert.throws(() => lutSpans(clips, 'nope'), /no clip/);
  assert.equal(matchPair(clips, 'head').to.id, 'rest');
  assert.equal(matchPair([...clips].reverse(), 'head').to.id, 'rest', 'wherever it sits on the timeline');
  assert.throws(() => matchPair(clips, 'head', 'other'), /neither continues/); // another source: never (the shot before a cut, contiguous, the job refuses by its pixels)
  assert.throws(() => matchPair(clips, 'rest'), /no clip continues/); // the next clip is another source — and never, by default, the head it continues
  // a tail whose grade stops early: matched to the shot it ends when named (validate's fix names it), never the next shot by default
  const t = [{id: 'shot', src: 'clips/m.mp4', inSec: 0, outSec: 12.212}, {id: 'tail', src: 'clips/m.mp4', inSec: 12.212, outSec: 12.446}, {id: 'next', src: 'clips/m.mp4', inSec: 12.446, outSec: 20}];
  assert.deepEqual(matchPair(t, 'tail', 'shot'), {from: {id: 'tail', src: 'clips/m.mp4', inSec: 12.212, outSec: 12.446}, to: {id: 'shot', src: 'clips/m.mp4', inSec: 0, outSec: 12.212}});
  assert.deepEqual(matchCandidates(t, t[1]).map((c) => c.id), ['next', 'shot']);
  // the continuation plays with a whole-reel LUT: the match carries it (the head's LUT replaces it)
  assert.deepEqual(matchPair(clips, 'head', undefined, {look: 'none', intensity: 0.8, auto: false, bySrc: {}, lut: 'luts/brand.cube', lutMix: 0.7}).to, {id: 'rest', src: 'clips/x.mp4', inSec: 9.204, outSec: 12.47, lut: 'luts/brand.cube', mix: 0.7});
  const g = {look: 'none', intensity: 0.8, auto: false, bySrc: {}, lutMix: 0.5, overrides: {head: {adjust: {saturation: 2}, lut: 'luts/old.cube', lutMix: 0.5}, rest: {adjust: {contrast: 1.4}, highlights: 0.4}}};
  assert.deepEqual(withLut(g, 'luts/m.cube', 'head', 'rest').overrides.head, {adjust: {contrast: 1.4}, highlights: 0.4, lut: 'luts/m.cube', lutMix: 1});
  assert.deepEqual(withLut(g, 'luts/r.cube', 'rest').overrides.rest, {adjust: {contrast: 1.4}, highlights: 0.4, lut: 'luts/r.cube'});
  assert.equal(withLut(null, 'luts/r.cube').lut, 'luts/r.cube');
  // a new fit under the same name: the copies baked from the old .cube go, so the next settle bakes it again
  const baked = {'clips/x.mp4|luts/m.cube|100|gbrpf32le': 'clips/lut/x-old.mp4', 'clips/x.mp4|luts/m.cube|100': 'clips/lut/x-older.mp4', 'clips/x.mp4|luts/r.cube|50|gbrpf32le': 'clips/lut/x-r.mp4'};
  assert.deepEqual(withLut({...g, baked}, 'luts/m.cube', 'head', 'rest').baked, {'clips/x.mp4|luts/r.cube|50|gbrpf32le': 'clips/lut/x-r.mp4'});
});

// ---- ffmpeg: decoding the frames the reel shows, and the bake ----
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lut-'));
const ff = (args) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], {encoding: 'utf8'}); assert.equal(r.status, 0, r.stderr); };
const x264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];

test('two clips of one source are measured on their own ranges — the frame nearest each time, as the reel shows it', () => {
  const dir = tmp(), file = path.join(dir, 's.mp4');
  // 30 fps: frames 0–9 dark gray, from frame 10 (0.333 s) orange — a split 1/3 frame later, at 0.3433 s, like a
  // shot-change split: the reel shows frame 10 at the split time (nearest), so it belongs to the second clip
  ff(['-f', 'lavfi', '-i', "color=c=0x303030:s=160x284:r=30:d=1,drawbox=c=0xd08040:t=fill:enable='gte(n\\,10)'", ...x264, file]);
  const clips = [{id: 'a', src: file, inSec: 0, outSec: 0.3433}, {id: 'b', src: file, inSec: 0.3433, outSec: 1}];
  const [a] = lutSpans(clips, 'a'), [b] = lutSpans(clips, 'b');
  const fa = decode(file, {span: a, count: 0}), fb = decode(file, {span: b, count: 0});
  assert.equal(fa.length, 10);
  const red = (px) => px[0]; // first pixel's red
  assert.ok(red(fa.at(-1)) < 0.3 && red(fb[0]) > 0.7, `a ends dark (${red(fa.at(-1))}), b starts orange (${red(fb[0])})`);
  const sa = labStats(decode(file, {span: a, count: 4}).flatMap((f) => [...f])), sb = labStats(decode(file, {span: b, count: 4}).flatMap((f) => [...f]));
  assert.ok(sb.q[10] - sa.q[10] > 0.2 && sb.a[0] - sa.a[0] > 0.05, 'different footage stats');
  fs.rmSync(dir, {recursive: true, force: true});
});

const yuvAvg = (file) => {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-'], {encoding: 'utf8'}).stdout;
  return ['YAVG', 'UAVG', 'VAVG'].map((k) => { const v = [...out.matchAll(new RegExp(`${k}=([\\d.]+)`, 'g'))].map((m) => +m[1]); return v.reduce((s, x) => s + x, 0) / v.length; });
};
test('an identity .cube bakes without loss (planar float around lut3d, not 8-bit RGB)', () => {
  const dir = tmp(), pub = path.join(dir, 'public');
  fs.mkdirSync(path.join(pub, 'clips'), {recursive: true}); fs.mkdirSync(path.join(pub, 'luts'));
  // footage-like saturation (fully saturated primaries clip at the gamut edge in any RGB round trip)
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x568:r=30:d=1,hue=s=0.5', ...x264, path.join(pub, 'clips', 'a.mp4')]);
  fs.writeFileSync(path.join(pub, 'luts', 'id.cube'), cube((c) => c, 33, 'id'));
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({bake: [{key: 'k', src: 'clips/a.mp4', lut: 'luts/id.cube', mix: 1}]}));
  const r = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/lut.mjs'), 'job.json', 'out.json'], {cwd: dir, encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  const baked = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8')).baked.k;
  const [src, out] = [path.join(pub, 'clips', 'a.mp4'), path.join(pub, baked)].map(yuvAvg);
  src.forEach((v, c) => assert.ok(Math.abs(out[c] - v) <= 0.3, `${['Y', 'U', 'V'][c]} ${v.toFixed(2)} → ${out[c].toFixed(2)}`));
  fs.rmSync(dir, {recursive: true, force: true});
});

test('match: fitted to the continuation as it plays (its LUT in), refused across two shots', () => {
  const dir = tmp(), pub = path.join(dir, 'public');
  fs.mkdirSync(path.join(pub, 'clips'), {recursive: true}); fs.mkdirSync(path.join(pub, 'luts'));
  // one still shot whose grade starts at frame 10 (the head is 0–9), and another picture
  ff(['-f', 'lavfi', '-i', "testsrc2=s=160x284:r=1:d=1,fps=30,hue=s=0.5,colorchannelmixer=rr=0.8:bb=0.9:enable='gte(n\\,10)'", ...x264, path.join(pub, 'clips', 's.mp4')]);
  ff(['-f', 'lavfi', '-i', 'smptebars=s=160x284:r=30:d=1', ...x264, path.join(pub, 'clips', 'o.mp4')]);
  fs.writeFileSync(path.join(pub, 'luts', 'tint.cube'), cube(([r, g, b]) => [r * 0.7, g, b], 17, 'tint'));
  const head = {id: 'head', src: 'clips/s.mp4', inSec: 0, outSec: 10 / 30}, rest = {id: 'rest', src: 'clips/s.mp4', inSec: 10 / 30, outSec: 1};
  const job = (name, to) => {
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({match: {name, from: head, to}}));
    const r = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/lut.mjs'), 'job.json', 'out.json'], {cwd: dir, encoding: 'utf8'});
    return {r, out: r.status === 0 ? JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8')) : null, lut: () => parseCube(fs.readFileSync(path.join(pub, 'luts', `${name}.cube`), 'utf8'))};
  };
  const plain = job('plain', rest), tinted = job('tinted', {...rest, lut: 'luts/tint.cube', mix: 1});
  assert.equal(plain.r.status, 0, plain.r.stderr);
  assert.ok(plain.out.after < 10 && plain.out.worst.rgb.length === 3, JSON.stringify(plain.out));
  const [a, b] = [plain.lut(), tinted.lut()], px = decode(path.join(pub, 'clips', 's.mp4'), {span: head, count: 2})[0];
  let red = 0, green = 0, n = 0;
  for (let i = 0; i < px.length; i += 3 * 97) { const p = [px[i], px[i + 1], px[i + 2]], oa = sampleCube(a, p), ob = sampleCube(b, p); red += Math.abs(ob[0] - 0.7 * oa[0]); green += Math.abs(ob[1] - oa[1]); n++; }
  assert.ok(red / n < 0.01 && green / n < 0.01, `the head's LUT has the continuation's in it: R off ${(red / n).toFixed(3)}, G off ${(green / n).toFixed(3)}`);
  const other = job('other', {id: 'bars', src: 'clips/o.mp4', inSec: 0, outSec: 1});
  assert.notEqual(other.r.status, 0);
  assert.match(other.r.stderr, /do not show the same picture/);
  assert.ok(!fs.existsSync(path.join(pub, 'luts', 'other.cube')), 'nothing written');
  fs.rmSync(dir, {recursive: true, force: true});
});

test('match, a tail: its first frames fitted to the shot\'s last ones before it (the grade stops early), refused across two shots', () => {
  const dir = tmp(), pub = path.join(dir, 'public');
  fs.mkdirSync(path.join(pub, 'clips'), {recursive: true});
  // bars (0–9), then one still shot (10–29) whose last 7 frames (23–29) pop: brighter and twice as saturated — the pairs
  // must be the tail's first frames against the shot's LAST ones (its first are the bars: the old head-only pairing
  // is refused here); and another picture
  ff(['-f', 'lavfi', '-i', 'smptebars=s=160x284:r=30:d=0.3333', '-f', 'lavfi', '-i', 'testsrc2=s=160x284:r=1:d=1,fps=30,trim=end_frame=20,hue=s=0.2', '-filter_complex', "[0:v][1:v]concat=n=2:v=1,eq=brightness=0.03:saturation=2:enable='gte(n\\,23)'[v]", '-map', '[v]', ...x264, path.join(pub, 'clips', 's.mp4')]);
  ff(['-f', 'lavfi', '-i', 'smptebars=s=160x284:r=30:d=1', ...x264, path.join(pub, 'clips', 'o.mp4')]);
  const shot = {id: 'shot', src: 'clips/s.mp4', inSec: 0, outSec: 23 / 30}, tail = {id: 'tail', src: 'clips/s.mp4', inSec: 23 / 30, outSec: 1};
  const job = (name, to) => {
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({match: {name, from: tail, to}}));
    const r = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/lut.mjs'), 'job.json', 'out.json'], {cwd: dir, encoding: 'utf8'});
    return {r, out: r.status === 0 ? JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8')) : null};
  };
  const ok = job('tail', shot);
  assert.equal(ok.r.status, 0, ok.r.stderr);
  assert.ok(ok.out.before > 10 && ok.out.after < 1, JSON.stringify(ok.out));
  // the tail through it looks like the shot: its first frame lands on the shot's last
  const l = parseCube(fs.readFileSync(path.join(pub, 'luts', 'tail.cube'), 'utf8'));
  const [a] = decode(path.join(pub, 'clips', 's.mp4'), {span: tail, count: 1}), [b] = decode(path.join(pub, 'clips', 's.mp4'), {span: {...shot, inSec: 22 / 30}, count: 1});
  let off = 0;
  for (let i = 0; i < a.length; i += 3) { const o = sampleCube(l, [a[i], a[i + 1], a[i + 2]]); for (let c = 0; c < 3; c++) off += Math.abs(o[c] - b[i + c]); }
  assert.ok((off / a.length) * 255 < 1, `the matched tail is ${((off / a.length) * 255).toFixed(1)} of 255 from the shot`);
  const bad = job('bad', {id: 'bars', src: 'clips/o.mp4', inSec: 0, outSec: 23 / 30});
  assert.notEqual(bad.r.status, 0);
  assert.match(bad.r.stderr, /do not show the same picture/);
  fs.rmSync(dir, {recursive: true, force: true});
});
