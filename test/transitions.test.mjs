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
