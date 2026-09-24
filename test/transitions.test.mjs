import {test} from 'node:test';
import assert from 'node:assert/strict';
import {punchAlternate, transitionFx} from '../src/transitions.ts';

const c = (id, src = 's', enter) => ({id, src, inSec: 0, outSec: 2, sourceDurationSec: 9, ...(enter ? {enter} : {})});

test('punch holds the whole clip closer; zoom eases in with a blur that clears', () => {
  assert.deepEqual(transitionFx(c('a', 's', 'punch'), 30, 60), {scale: 1.12, dx: 0, blur: 0});
  const z0 = transitionFx(c('a', 's', 'zoom'), 0, 60), z8 = transitionFx(c('a', 's', 'zoom'), 8, 60);
  assert.ok(z0.scale > 1.04 && z0.blur === 4); // blurred edges pushed off frame
  assert.ok(Math.abs(z8.scale - 1.12) < 1e-9 && z8.blur === 0);
});

test('whip: this clip slides in, the previous one slides out, nothing in between', () => {
  const inFx = transitionFx(c('b', 's', 'whip'), 0, 60);
  assert.ok(inFx.dx > 0 && inFx.blur > 0);
  assert.deepEqual(transitionFx(c('b', 's', 'whip'), 10, 60), {scale: 1, dx: 0, blur: 0});
  const out = transitionFx(c('a'), 59, 60, c('b', 's', 'whip'));
  assert.ok(out.dx < -15 && out.blur > 15 && out.scale >= 1 + (2 * -out.dx) / 100);
  assert.deepEqual(transitionFx(c('a'), 30, 60, c('b', 's', 'whip')), {scale: 1, dx: 0, blur: 0});
});

test('punch-alternate: every other jump cut in a take, reset on a new source', () => {
  const r = punchAlternate([c('a'), c('b'), c('c'), c('d', 't'), c('e', 't')]);
  assert.deepEqual(r.map((x) => x.enter), [undefined, 'punch', 'cut', undefined, 'punch']);
});

test('card / split: the outgoing clip reports an exit over its last frames, a stepped ramp eases between speeds', async () => {
  const {transitionFx, speedRamp, OVERLAP} = await import('../src/transitions.ts');
  const a = c('a'), b = c('b', 's', 'card');
  assert.equal(transitionFx(a, 60 - OVERLAP - 1, 60, b).exit, undefined);
  const x = transitionFx(a, 59, 60, b).exit;
  assert.ok(x && x.type === 'card' && x.t > 0.99, JSON.stringify(x));
  assert.equal(transitionFx(a, 56, 60, c('b', 's', 'split')).exit.type, 'split');
  assert.deepEqual(speedRamp(1, 2.5, 3).length, 3);
  const r = speedRamp(1, 2.5, 3);
  assert.ok(r[0] > 1 && r[1] > r[0] && r[2] === 2.5, JSON.stringify(r));
  assert.deepEqual(speedRamp(2, 1, 2).at(-1), 1);
});

test('whipDiag: the outgoing clip smears along the diagonal, the incoming lands from 1.3× and clears in 8 frames', () => {
  const out = transitionFx(c('a'), 59, 60, c('b', 's', 'whipDiag'));
  assert.ok(out.blur > 15 && out.angle === 60 && out.dx === 0);
  const in0 = transitionFx(c('b', 's', 'whipDiag'), 0, 60);
  assert.ok(in0.blur > 10 && in0.scale > 1.2 && in0.angle === 60);
  assert.deepEqual(transitionFx(c('b', 's', 'whipDiag'), 8, 60), {scale: 1, dx: 0, blur: 0});
});

// ---- Phase 2: the transition pack ----
import {coverShapes, exitMask, overlapOf, DUR_MS, COVER, REVEALS, OVER, clipPoly} from '../src/transitions.ts';

test('clipPoly keeps the half-plane a·x + b·y ≤ c: a square cut by x + y ≤ 100 is a triangle', () => {
  const tri = clipPoly([[0, 0], [100, 0], [100, 100], [0, 100]], 1, 1, 100);
  assert.equal(tri.length, 3);
  assert.ok(tri.every(([x, y]) => x + y <= 100 + 1e-6));
});

test('cover shapes: nothing before, everything at the middle, nothing after', () => {
  for (const kind of ['bands', 'clock', 'blinds', 'mosaic']) {
    const mid = coverShapes(kind, 0.5, 7);
    assert.ok(mid.length > 0, `${kind} covers at t=0.5`);
    const ends = [...coverShapes(kind, 0, 7), ...coverShapes(kind, 1, 7)].filter((s) => (s.opacity ?? 1) > 0.01);
    // whatever is returned at the ends must not be drawn on screen: an empty list or an off-frame / zero-size shape
    assert.ok(ends.every((s) => !s.clip || /polygon|inset|circle/.test(s.clip)), `${kind} shapes are clip paths`);
  }
  assert.equal(coverShapes('flash', 0.3, 1)[0].tone, 'white');
  assert.ok(coverShapes('flash', 0.3, 1)[0].opacity > 0.99 && coverShapes('flash', 1, 1)[0].opacity < 0.01);
  assert.equal(coverShapes('bands', 0.5, 0).length, 3);
  assert.ok(coverShapes('mosaic', 0.5, 3).length >= 60);
  assert.ok(coverShapes('lightLeak', 0.5, 0).every((s) => s.screen && s.gradient));
});

test('exit masks: the outgoing clip keeps everything at t=0 and nothing at t=1', () => {
  for (const kind of ['polyWipe', 'diagWipe', 'particles', 'blocks']) {
    const m0 = exitMask(kind, 0, 5), m1 = exitMask(kind, 1, 5);
    assert.ok(m0 && m0.startsWith('polygon('), `${kind} at 0`);
    assert.ok(m1 === null || m1.startsWith('polygon('), `${kind} at 1`);
  }
  // particles: the frontier is jagged (different x per row) and moves left → right
  const a = exitMask('particles', 0.3, 5), b = exitMask('particles', 0.6, 5);
  const xs = (m) => [...m.matchAll(/([\d.]+)% [\d.]+%/g)].map((r) => +r[1]);
  assert.ok(new Set(xs(a)).size > 5);
  assert.ok(Math.min(...xs(b)) > Math.min(...xs(a)));
});

test('overlaps: reveal and over kinds pre-start the incoming clip for their whole duration', () => {
  assert.equal(overlapOf('crossBlur', 30), Math.round((30 * DUR_MS.crossBlur) / 1000));
  assert.equal(overlapOf('flash', 30), 0);
  assert.ok(REVEALS.has('particles') && OVER.has('cardDrop') && COVER.has('bands'));
});

test('crossBlur, spin, rgbFlash and cardDrop report their per-frame effects', () => {
  const inFx = transitionFx(c('b', 's', 'crossBlur'), -3, 60, undefined, 30); // 3 frames before the cut, under the outgoing
  assert.ok(inFx.blur > 5);
  const out = transitionFx(c('a'), 59, 60, c('b', 's', 'crossBlur'), 30);
  assert.equal(out.exit.type, 'fade'); assert.ok(out.exit.t > 0.8);
  assert.ok(transitionFx(c('b', 's', 'spin'), 0, 60, undefined, 30).spin > 2);
  assert.ok(transitionFx(c('b', 's', 'rgbFlash'), 0, 60, undefined, 30).rgb > 2);
  assert.ok(transitionFx(c('b', 's', 'cardDrop'), -5, 60, undefined, 30).drop < 0.5);
  assert.equal(transitionFx(c('a'), 59, 60, c('b', 's', 'cardDrop'), 30).exit.type, 'shrink');
  assert.equal(transitionFx(c('a'), 59, 60, c('b', 's', 'particles'), 30).exit.type, 'dissolve');
});

test('disc: the incoming clip brings a light canvas from the corner, shows itself in a growing circle with a ring, then opens', () => {
  const n = overlapOf('disc', 30);
  const early = transitionFx(c('b', 's', 'disc'), -n + 1, 60, undefined, 30);
  assert.ok(early.canvas && early.canvas.clip.startsWith('circle(') && early.enterMask.startsWith('circle(0'));
  const mid = transitionFx(c('b', 's', 'disc'), -Math.round(n * 0.5), 60, undefined, 30);
  assert.ok(mid.ring && mid.ring.r > 3 && parseFloat(mid.enterMask.match(/circle\(([\d.]+)%/)[1]) > 10);
  const last = transitionFx(c('b', 's', 'disc'), -1, 60, undefined, 30);
  assert.ok(parseFloat(last.enterMask.match(/circle\(([\d.]+)%/)[1]) > 80); // 80 % from (40 %, 45 %) reaches the farthest corner
  assert.equal(transitionFx(c('a'), 59, 60, c('b', 's', 'disc'), 30).exit, undefined); // the canvas covers it
  assert.ok(OVER.has('disc') && !COVER.has('disc'));
});

test('particles: the outgoing clip dissolves with a seeded grain, not a mask', () => {
  const e = transitionFx(c('a'), 55, 60, c('b', 's', 'particles'), 30).exit;
  assert.equal(e.type, 'dissolve'); assert.ok(e.t > 0 && e.t < 1 && Number.isInteger(e.seed));
});
