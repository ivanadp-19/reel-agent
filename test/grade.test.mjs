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
import {createGradeScans, frameLooks, lookSteps, readScan, scanSource, LOOKS_VF, SOURCE_CHANNELS} from '../scripts/grade-scan.mjs';

// synthetic footage (no client media): a flat testsrc2 shot whose eq grade switches on at frame 10, and a
// hard cut from that flat shot into colour bars
const ffmpeg = (args) => spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, '-c:v', 'libx264', '-pix_fmt', 'yuv420p'], {encoding: 'utf8'});
const FLAT = 'eq=saturation=0.35:contrast=0.75';
function synthClips(dir) {
  fs.mkdirSync(path.join(dir, 'clips'), {recursive: true});
  const f = (n) => path.join(dir, 'clips', n);
  const ok = [
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=180x320:r=30:d=2', '-vf', `${FLAT},eq=contrast=1.35:saturation=2.8:brightness=0.06:enable='gte(n,10)'`, f('head.mp4')]),
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=180x320:r=30:d=2', '-vf', `${FLAT},eq=contrast=1.35:saturation=2.8:brightness=0.06`, f('fixed.mp4')]),
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=180x320:r=30:d=2', '-vf', `${FLAT},eq=contrast=1.35:saturation=2.8:brightness=0.06:enable='lt(n,50)'`, f('tail.mp4')]),
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=180x320:r=30:d=1', '-f', 'lavfi', '-i', 'smptebars=s=180x320:r=30:d=1', '-filter_complex', `[0:v]${FLAT}[a];[a][1:v]concat=n=2:v=1[v]`, '-map', '[v]', f('cut.mp4')]),
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
    const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', path.join(pub, 'clips/cut.mp4'), '-vf', LOOKS_VF, '-f', 'rawvideo', '-'], {maxBuffer: 1 << 26}).stdout;
    assert.equal(lookSteps(frameLooks(raw), SOURCE_CHANNELS, {maxHash: 64}).length, 1, 'only the structure hash keeps the cut out');
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
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
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});
