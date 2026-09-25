import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cube} from '../src/hdr.ts';
import {labStats, mixCube, oklabToRgb, parseCube, rgbToOklab, sampleCube, transferFn} from '../src/lut.ts';

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
