import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyGrade, autoGrade, compose, gradeFor, lookGrade, IDENTITY} from '../src/grade.ts';

// pruebaeditoria.mp4, lit frames: flat and washed out
const flat = {yLow: 64, yHigh: 129.1, yAvg: 95.1, uAvg: 128.8, vAvg: 128.7, satAvg: 4.6};
// IMG_1778.mp4: well exposed, a little warm
const normal = {yLow: 24.1, yHigh: 170.4, yAvg: 90.7, uAvg: 127.9, vAvg: 130.6, satAvg: 7.1};
const y = (v) => (v - 16) / 219;

test('flat footage gets its tones stretched, bounded, mid-tone kept', () => {
  const g = autoGrade(flat);
  assert.equal(g.slope[0], 1.5); // capped
  const [lo] = applyGrade(g, [y(64), y(64), y(64)]);
  const [hi] = applyGrade(g, [y(129.1), y(129.1), y(129.1)]);
  assert.ok(hi - lo > 0.44 && hi - lo < 0.46, `spread ${hi - lo}`); // 0.297 → 0.446
  const mid = (y(64) + y(129.1)) / 2;
  assert.ok(Math.abs(applyGrade(g, [mid, mid, mid])[1] - mid) < 0.02); // within the white-balance nudge
  assert.equal(g.saturation, 1.4); // capped
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
