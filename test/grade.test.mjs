import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyGrade, autoGrade, bakeKey, compose, gradeFor, lookGrade, lutBakes, paramsFor, shoulder, toneTable, IDENTITY} from '../src/grade.ts';

// pruebaeditoria.mp4, lit frames: flat and washed out
const flat = {yLow: 64, yHigh: 129.1, yAvg: 95.1, uAvg: 128.8, vAvg: 128.7, satAvg: 4.6};
// IMG_1778.mp4: well exposed, a little warm
const normal = {yLow: 24.1, yHigh: 170.4, yAvg: 90.7, uAvg: 127.9, vAvg: 130.6, satAvg: 7.1};
const y = (v) => (v - 16) / 219;

test('flat footage gets its tones stretched, bounded, mid-tone kept', () => {
  const g = autoGrade(flat);
  assert.equal(g.slope[0], 1.35); // capped (1.5 burnt the first G1 draft)
  const [lo] = applyGrade(g, [y(64), y(64), y(64)]);
  const [hi] = applyGrade(g, [y(129.1), y(129.1), y(129.1)]);
  assert.ok(hi - lo > 0.39 && hi - lo < 0.41, `spread ${hi - lo}`); // 0.297 → 0.40
  const mid = (y(64) + y(129.1)) / 2;
  assert.ok(Math.abs(applyGrade(g, [mid, mid, mid])[1] - mid) < 0.02); // within the white-balance nudge
  assert.equal(g.saturation, 1.25); // capped
});

test('well exposed footage is left almost alone', () => {
  const g = autoGrade(normal);
  assert.deepEqual(g.slope, [1, 1, 1]);
  assert.ok(g.intercept.every((i) => Math.abs(i) <= 0.02), JSON.stringify(g));
  assert.ok(g.saturation <= 1.15);
});

test('looks: none is identity, clean brightens and warms, intensity 0 is off', () => {
  assert.deepEqual(lookGrade('none', 1), IDENTITY);
  const c = lookGrade('clean', 1);
  const [r, , b] = applyGrade(c, [0.5, 0.5, 0.5]);
  assert.ok(r > b, 'warmer');
  assert.deepEqual(lookGrade('clean', 0), IDENTITY);
});

test('compose applies the first grade then the second; gradeFor skips identity', () => {
  const a = {slope: [2, 2, 2], intercept: [0.1, 0.1, 0.1], saturation: 1.2};
  const b = {slope: [0.5, 0.5, 0.5], intercept: [0, 0, 0.2], saturation: 0.5};
  assert.deepEqual(applyGrade(compose(a, b), [0.2, 0.2, 0.2]), applyGrade(b, applyGrade(a, [0.2, 0.2, 0.2])));
  assert.equal(compose(a, b).saturation, 0.6);
  assert.equal(gradeFor({look: 'none', intensity: 1, auto: false, bySrc: {}}, 'x'), null);
  assert.ok(gradeFor({look: 'clean', intensity: 0.8, auto: true, bySrc: {x: autoGrade(flat)}}, 'x'));
});

test('highlight shoulder: values pushed past white bend into it smoothly instead of clipping', () => {
  const top = 1.3;
  assert.equal(shoulder(0.5, 0.5, top), 0.5); // below the knee: untouched
  const ys = [0.85, 0.95, 1.05, 1.15, 1.25, 1.3].map((v) => shoulder(v, 0.5, top));
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] > ys[i - 1], `monotone ${ys}`);
  assert.ok(ys.at(-2) < 1 && Math.abs(ys.at(-1) - 1) < 1e-9, 'reaches white only at the top');
  assert.equal(shoulder(1.2, 0, top), 1, 'highlights 0 = hard clip');
  // a clipping grade: 1.3× contrast used to flatten everything above 0.77 to white; now it keeps separation
  const t = toneTable(1.3, 0, 0.5);
  const at = (x) => t[Math.round(x * (t.length - 1))];
  assert.ok(at(0.84) < at(0.94) && at(0.94) < at(1), `${at(0.84)} ${at(0.94)} ${at(1)}`);
  // identity grade with the default rolloff stays identity (whites are not dimmed)
  assert.ok(toneTable(1, 0, 0.5).every((v, i, a) => Math.abs(v - i / (a.length - 1)) < 1e-4));
});

const clipsAB = [{id: 'k0', src: 'clips/a.mp4'}, {id: 'k1', src: 'clips/a.mp4'}, {id: 'k2', src: 'clips/b.mp4'}];
test('per-source and per-clip overrides stack on the whole-reel grade; auto is opt-in per source', () => {
  const pg = {look: 'none', intensity: 0.8, auto: false, bySrc: {'clips/b.mp4': autoGrade(flat)}, adjust: {temperature: 0.2}, overrides: {'clips/b.mp4': {auto: true, adjust: {exposure: -0.3}}, k1: {look: 'mono', intensity: 1}}};
  assert.equal(paramsFor(pg, 'clips/a.mp4', 'k0').look, 'none');
  assert.equal(paramsFor(pg, 'clips/a.mp4', 'k1').look, 'mono');
  const b = paramsFor(pg, 'clips/b.mp4', 'k2');
  assert.equal(b.auto, true); assert.deepEqual(b.adjust, {temperature: 0.2, exposure: -0.3}); // merged knob by knob
  assert.equal(gradeFor(pg, 'clips/a.mp4', 'k1').saturation, 0); // mono only on that clip
  assert.ok(gradeFor(pg, 'clips/a.mp4', 'k0').saturation === 1);
  assert.equal(gradeFor({look: 'none', intensity: 1, auto: false, bySrc: {}}, 'x'), null, 'nothing set → untouched');
});

test('skin protection: a warm, saturated grade leaves skin tones less warm and less saturated', () => {
  const pg = {look: 'warm', intensity: 1, auto: false, bySrc: {}, adjust: {saturation: 1.3, temperature: 0.5}, skin: 0.8};
  const g = gradeFor(pg, 'x');
  assert.ok(g.skin, 'a skin layer');
  assert.ok(g.skin.saturation < g.saturation);
  const mid = Math.floor(g.tables[0].length / 2);
  assert.ok(g.skin.tables[0][mid] - g.skin.tables[2][mid] < g.tables[0][mid] - g.tables[2][mid], 'less red-over-blue on skin');
  assert.equal(gradeFor({...pg, skin: 0}, 'x').skin, null);
  assert.equal(gradeFor({look: 'none', intensity: 1, auto: false, bySrc: {}, adjust: {exposure: 0.2}}, 'x').skin, null, 'nothing to protect');
});

test('LUTs: every clip (and its person mattes) that resolves to a LUT is baked once; the render plays the baked copy', () => {
  const pg = {look: 'none', intensity: 0.8, auto: false, bySrc: {}, lut: 'luts/cesar.cube', lutMix: 0.8, overrides: {'clips/b.mp4': {lut: null}}};
  const bakes = lutBakes(pg, clipsAB, [{src: 'clips/a.mp4', file: 'mattes/a-0-2000.webm'}]);
  assert.deepEqual(bakes.map((b) => b.src).sort(), ['clips/a.mp4', 'mattes/a-0-2000.webm']);
  const key = bakeKey('clips/a.mp4', 'luts/cesar.cube', 0.8);
  assert.equal(gradeFor({...pg, baked: {[key]: 'clips/lut/a-123.mp4'}}, 'clips/a.mp4', 'k0').media, 'clips/lut/a-123.mp4');
  assert.equal(gradeFor(pg, 'clips/b.mp4', 'k2'), null);
  // a copy baked before the float conversion was in the key: it plays until the re-bake, and the re-bake is asked for
  const old = {...pg, baked: {'clips/a.mp4|luts/cesar.cube|80': 'clips/lut/a-rgb24.mp4'}};
  assert.equal(gradeFor(old, 'clips/a.mp4', 'k0').media, 'clips/lut/a-rgb24.mp4');
  assert.ok(lutBakes(old, clipsAB).some((b) => !old.baked[b.key]), 'baked again');
});

// ---- half-graded sources (scripts/grade-scan.mjs): a pre-edit whose grade starts a few frames into a shot ----
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createGradeScans, frameLooks, hamming, lookSteps, looksVf, rangeOf, readScan, scanSource, sourceSteps, SOURCE_CHANNELS} from '../scripts/grade-scan.mjs';

// synthetic footage (no client media): a flat testsrc2 shot whose eq grade switches on at frame 10, and a
// hard cut from that flat shot into colour bars
const ffmpeg = (args) => spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, '-c:v', 'libx264', '-pix_fmt', 'yuv420p'], {encoding: 'utf8'});
const FLAT = 'eq=saturation=0.35:contrast=0.75', POP = 'lutyuv=y=val+8:u=(val-128)*2+128:v=(val-128)*2+128';
function synthClips(dir) {
  fs.mkdirSync(path.join(dir, 'clips'), {recursive: true});
  const f = (n) => path.join(dir, 'clips', n);
  const ok = [
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=180x320:r=30:d=2', '-vf', `${FLAT},eq=contrast=1.35:saturation=2.8:brightness=0.06:enable='gte(n,10)'`, f('head.mp4')]),
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=180x320:r=30:d=2', '-vf', `${FLAT},eq=contrast=1.35:saturation=2.8:brightness=0.06`, f('fixed.mp4')]),
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=180x320:r=30:d=2', '-vf', `${FLAT},eq=contrast=1.35:saturation=2.8:brightness=0.06:enable='lt(n,50)'`, f('tail.mp4')]),
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=180x320:r=30:d=1', '-f', 'lavfi', '-i', 'smptebars=s=180x320:r=30:d=1', '-filter_complex', `[0:v]${FLAT}[a];[a][1:v]concat=n=2:v=1[v]`, '-map', '[v]', f('cut.mp4')]),
    // Morantes 10's pop: the last 7 frames of a shot +8 luma and twice as saturated
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=180x320:r=30:d=2', '-vf', `${FLAT},${POP}:enable='gte(n,53)'`, f('tail7.mp4')]),
    // what must stay quiet, in one shot: a camera's exposure ramp (tone and color over 10 frames, 20–29), a flash frame
    // (60), a 2-frame blip of the tail's look (80–81), an exposure step (tone alone, 100–119) and a white-balance step
    // (color alone, 130–149); then a cut into bars (150)
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=180x320:r=30:d=5', '-f', 'lavfi', '-i', 'smptebars=s=180x320:r=30:d=1', '-filter_complex', `[0:v]${FLAT},eq=brightness='0.004*clip(n-20,0,10)':saturation='1+0.1*clip(n-20,0,10)':eval=frame,eq=brightness=0.3:enable='eq(n,60)',${POP}:enable='between(n,80,81)',lutyuv=y=val+8:enable='between(n,100,119)',eq=saturation=1.6:enable='between(n,130,149)'[a];[a][1:v]concat=n=2:v=1[v]`, '-map', '[v]', f('quiet.mp4')]),
  ].every((r) => r.status === 0);
  return ok;
}

test('half-graded scan: the grade that switches on 10 frames into a shot is found at its exact frame (and one that stops 10 before its end); a hard cut is not', async () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-'));
  try {
    assert.ok(synthClips(pub), 'ffmpeg with libx264');
    const head = await scanSource(pub, 'clips/head.mp4');
    assert.equal(head.frames, 60);
    assert.deepEqual(head.steps.map((s) => [s.frame, s.at, s.from, s.frames]), [[10, 0.333, 0, 10]]);
    assert.ok(head.steps[0].sat[1] / head.steps[0].sat[0] >= 2);
    // the grade that stops 10 frames before the shot ends: the flatter side is the tail
    assert.deepEqual((await scanSource(pub, 'clips/tail.mp4')).steps.map((s) => [s.frame, s.at, s.to, s.off, s.frames]), [[50, 1.667, 2, true, 10]]);
    // cached by path + size + mtime: read back as is (an absolute path under public/ is the same source), a touched file is stale
    assert.equal(readScan(pub, path.join(pub, 'clips/head.mp4')).scannedAt, head.scannedAt);
    fs.utimesSync(path.join(pub, 'clips/head.mp4'), new Date(), new Date(Date.now() + 5000));
    assert.equal(readScan(pub, 'clips/head.mp4'), null);
    assert.equal(readScan(pub, 'clips/nope.mp4'), undefined);
    // a file that does not decode: thrown, and cached with its error so a validate never decodes it again
    fs.writeFileSync(path.join(pub, 'clips/bad.mp4'), 'not a video');
    await assert.rejects(scanSource(pub, 'clips/bad.mp4'));
    assert.deepEqual(Object.keys(readScan(pub, 'clips/bad.mp4')).filter((k) => k === 'error' || k === 'steps'), ['error', 'steps']);
    // the cut steps far past the rule, but the picture changes: not a head
    assert.deepEqual((await scanSource(pub, 'clips/cut.mp4')).steps, []);
    const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', path.join(pub, 'clips/cut.mp4'), '-vf', looksVf('tv'), '-f', 'rawvideo', '-'], {maxBuffer: 1 << 26}).stdout;
    assert.equal(lookSteps(frameLooks(raw), SOURCE_CHANNELS, {maxHash: 64, cutHash: 64, global: 0}).length, 1, 'only the structure hash and the whole-picture check keep the cut out');
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

test('half-graded scan: a 7-frame tail +8 luma / saturation ×2 inside a shot is found; a ramp, a flash, a 2-frame blip, tone or color alone and a cut are not', async () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'hg7-'));
  try {
    assert.ok(synthClips(pub), 'ffmpeg with libx264');
    const [t] = (await scanSource(pub, 'clips/tail7.mp4')).steps;
    assert.deepEqual([t.frame, t.at, t.to, t.off, t.frames], [53, 1.767, 2, true, 7]);
    assert.ok(t.dY === 8 && t.sat[1] / t.sat[0] >= 1.9 && t.sat[1] / t.sat[0] <= 2.1, JSON.stringify(t));
    const quiet = await scanSource(pub, 'clips/quiet.mp4');
    assert.equal(quiet.frames, 180);
    assert.deepEqual(quiet.steps, []);
    // what keeps them out: the exposure step (100, back at 120) and the white-balance step (130, back at 150 is the cut)
    // switch in one frame and hold, but each moves tone or color alone — any single channel would call them steps
    const looks = frameLooks(spawnSync('ffmpeg', ['-v', 'error', '-i', path.join(pub, 'clips/quiet.mp4'), '-vf', looksVf('tv'), '-f', 'rawvideo', '-'], {maxBuffer: 1 << 26}).stdout);
    assert.deepEqual(lookSteps(looks, SOURCE_CHANNELS).map((x) => x.k), [100, 120, 130]);
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

test('frame looks in the input\'s own range: a full-range clip reads its own levels (ffmpeg < 7.1 squeezed them to limited)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hgr-')), f = path.join(dir, 'pc.mp4');
  try {
    // gray 100 for a second, then 200 — full range (yuvj420p, tagged pc), as Remotion renders and phones write it
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x646464:s=64x64:r=30:d=1', '-f', 'lavfi', '-i', 'color=c=0xc8c8c8:s=64x64:r=30:d=1', '-filter_complex', '[0:v][1:v]concat=n=2:v=1,scale=out_range=pc,format=yuvj420p[v]', '-map', '[v]', '-c:v', 'libx264', '-crf', '1', '-color_range', 'pc', f], {encoding: 'utf8'});
    assert.equal(r.status, 0, r.stderr);
    const stream = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_range,pix_fmt', '-of', 'json', f], {encoding: 'utf8'}).stdout).streams[0];
    assert.equal(rangeOf(stream), 'pc');
    assert.deepEqual([rangeOf({pix_fmt: 'yuv420p'}), rangeOf({pix_fmt: 'yuv420p', color_range: 'tv'}), rangeOf({pix_fmt: 'yuvj420p'})], ['tv', 'tv', 'pc']);
    const y = (vf) => { const l = frameLooks(spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-vf', vf, '-f', 'rawvideo', '-'], {maxBuffer: 1 << 26}).stdout); return [l[0].y, l[59].y].map(Math.round); };
    assert.deepEqual(y(looksVf(rangeOf(stream))), [100, 200], 'the step is 100, as the file has it (ffmpeg 6.1 untold: 102 → 188, a step of 86)');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

// frames drawn here (27×24 yuv444p, what LOOKS_VF delivers): a picture (seed), panned dx px, in a look (lift:
// luma, gain: chroma); quad: only the top-left quarter takes the look. runs: [[frames, picture], …]
const pic = ({seed = 1, dx = 0, lift = 0, gain = 1, quad = false} = {}) => {
  const W = 27, H = 24, N = W * H, b = Buffer.alloc(3 * N), cl = (x) => Math.max(0, Math.min(255, Math.round(x)));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, t = Math.sin((x + dx) * 0.5 + y * 0.35 * seed) * Math.cos(y * 0.45 + seed), on = !quad || (x < 14 && y < 12);
    b[i] = cl(100 + 50 * t + (on ? lift : 0));
    b[N + i] = cl(128 + (on ? gain : 1) * (7 + 4 * t));
    b[2 * N + i] = cl(128 + (on ? gain : 1) * (-5 + 3 * Math.cos(x * 0.3 + seed)));
  }
  return b;
};
const drawn = (...runs) => frameLooks(Buffer.concat(runs.flatMap(([n, o]) => Array.from({length: n}, () => pic(o)))));

test('half-graded steps: a camera move inside the head keeps its start at the cut; an over-graded pop is the odd part; one region changing is no grade', () => {
  const graded = {lift: 25, gain: 3};
  // shot A, a cut, then 10 ungraded frames of shot B with a 1 px pan jump after 4 (a camera move), then B in the grade
  const head = drawn([30, {seed: 2, ...graded}], [4, {}], [6, {dx: 1}], [40, {dx: 1, ...graded}]);
  const hd = hamming(head[33].h, head[34].h);
  assert.ok(hd > 6 && hd <= 12, `the pan jump is camera motion (${hd} bits)`);
  assert.deepEqual(sourceSteps(head, 30).map((s) => [s.frame, s.from, s.frames, !!s.off]), [[40, 1, 10, false]]);
  // a shot whose last 8 frames pop MORE saturated than the rest: those 8 are the odd part, not the 40 before
  const pop = drawn([20, {seed: 2}], [40, {gain: 1.5}], [8, {gain: 3.5}], [20, {seed: 2}]);
  assert.deepEqual(sourceSteps(pop, 30).map((s) => [s.frame, s.to, s.frames, !!s.off]), [[60, 2.267, 8, true]]);
  // only the top-left quarter changes (a screen behind the presenter): the frame's saturation doubles, but no grade
  const screen = drawn([30, {}], [30, {quad: true, gain: 8}]);
  assert.equal(lookSteps(screen, SOURCE_CHANNELS, {global: 0}).length, 1);
  assert.deepEqual(lookSteps(screen, SOURCE_CHANNELS), []);
});

test('half-graded scan: stopped at its deadline (a busy box) it is not cached — the next kick scans it again', async () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'hgt-'));
  try {
    fs.mkdirSync(path.join(pub, 'clips'));
    assert.equal(ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=180x320:r=30:d=1', path.join(pub, 'clips/t.mp4')]).status, 0);
    process.env.REEL_GRADE_SCAN_TIMEOUT_MS = '1';
    await assert.rejects(scanSource(pub, 'clips/t.mp4'), (e) => e.retry && /^grade scan of clips\/t\.mp4 stopped/.test(e.message)); // its path under public/, never the server's
    delete process.env.REEL_GRADE_SCAN_TIMEOUT_MS;
    assert.equal(readScan(pub, 'clips/t.mp4'), null);
    await createGradeScans({publicDir: pub, log: () => {}}).kick(['clips/t.mp4']);
    assert.equal(readScan(pub, 'clips/t.mp4').frames, 30);
  } finally { delete process.env.REEL_GRADE_SCAN_TIMEOUT_MS; fs.rmSync(pub, {recursive: true, force: true}); }
});

test('half-graded scan lane: one scan at a time, a source queued twice is scanned once, a failure is logged and never thrown', async () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'hgq-'));
  try {
    fs.mkdirSync(path.join(pub, 'clips'));
    for (const n of ['a', 'b', 'bad']) fs.writeFileSync(path.join(pub, 'clips', `${n}.mp4`), n);
    let running = 0, most = 0;
    const seen = [], logs = [];
    const lane = createGradeScans({publicDir: pub, log: (l) => logs.push(l), scan: async (src) => {
      seen.push(src); most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      if (src.includes('bad')) throw new Error('not a video');
      return {frames: 1, steps: []};
    }});
    lane.kick(['clips/a.mp4', 'clips/b.mp4', 'clips/missing.mp4']);
    await lane.kick(['clips/a.mp4', 'clips/bad.mp4']);
    assert.deepEqual(seen, ['clips/a.mp4', 'clips/b.mp4', 'clips/bad.mp4']);
    assert.equal(most, 1);
    assert.match(logs.at(-1), /clips\/bad\.mp4: not a video/);
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

import {analyzeVideo, gradeCoverageFindings, verdictOf} from '../.agents/skills/render-judge/judge.mjs';
import {placeClips} from '../src/timeline.ts';

test('grade-coverage (render judge): the synthetic head blocks on the render\'s own frames, with the fix; fixed, it passes', () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-'));
  try {
    assert.ok(synthClips(pub), 'ffmpeg with libx264');
    const fps = 30, clip = (id, src, inSec, outSec, x = {}) => ({id, src, inSec, outSec, sourceDurationSec: 2, ...x});
    const looks = (f) => analyzeVideo(path.join(pub, 'clips', f), {hashes: false, looks: true}).looks;
    const judge = (f, clips, spans = []) => gradeCoverageFindings(looks(f), placeClips(clips, fps), spans, fps);
    // one clip over the whole shot: split where the look changes, then the match on the head
    const r = judge('head.mp4', [clip('k0', 'clips/head.mp4', 0, 2)]);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].severity, 'blocker');
    assert.deepEqual(r.findings[0].evidence.frames, [0, 10, 60]); // the shot, the first frame in the grade, its end
    assert.deepEqual(r.findings[0].fix.map((x) => [x.tool, x.args.at_sec ?? x.args.clip_id]), [['split_clip', 0.333], ['create_lut', 'k0']]);
    assert.equal(verdictOf(r.findings).verdict, 'FAIL');
    // split there but not matched yet: the head matches the clip continuing it
    const split = [clip('k0', 'clips/head.mp4', 0, 1 / 3), clip('k0-s1', 'clips/head.mp4', 1 / 3, 2)];
    assert.deepEqual(judge('head.mp4', split).findings.map((f) => f.fix), [[{tool: 'create_lut', note: 'the head takes the grade of the clip continuing it', args: {clip_id: 'k0', to_clip_id: 'k0-s1', match: true, name: 'k0-match'}}]]);
    // fixed: the render shows the head in the shot's grade
    assert.deepEqual(judge('fixed.mp4', split), {findings: [], skipped: []});
    // under B-roll the head is not measured, and a clip all under it is skipped with a note; a transition covers the join
    const covered = judge('head.mp4', split, [{startMs: 0, endMs: 400}]);
    assert.deepEqual(covered.findings, []);
    assert.match(covered.skipped[0], /^grade-coverage: k0 — every frame under B-roll/);
    assert.deepEqual(judge('head.mp4', [split[0], {...split[1], enter: 'whip'}]).findings, []);
    // a hard cut between two shots inside one clip (a pre-edit's own cut) is no finding
    assert.deepEqual(judge('cut.mp4', [clip('c', 'clips/cut.mp4', 0, 2)]).findings, []);
    // a tail in another grade (Morantes 10's pop): split it off, then match IT to the shot it ends
    const [t] = judge('tail7.mp4', [clip('k0', 'clips/tail7.mp4', 0, 2)]).findings;
    assert.deepEqual(t.evidence.frames, [0, 53, 60]);
    assert.deepEqual(t.fix, [{tool: 'split_clip', args: {at_sec: 1.767}, changesIds: true}, {tool: 'create_lut', note: 'the tail takes the grade of the shot it ends', args: {clip_id: '<the piece from 1.767 s>', to_clip_id: 'k0', match: true, name: 'k0-tail-match'}}]);
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});
