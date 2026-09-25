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
});
