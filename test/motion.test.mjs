import {test} from 'node:test';
import assert from 'node:assert/strict';
import {arrive, leave, ms, boxTravel, cardLanding} from '../src/motion.ts';

test('ghost: starts at 40 % opacity and the shine crosses the word in 250 ms', () => {
  const a0 = arrive('ghost', 0, 30), a3 = arrive('ghost', 3, 30), a8 = arrive('ghost', 8, 30);
  assert.ok(a0.opacity >= 0.38 && a0.opacity <= 0.42);
  assert.ok(a3.shine > 0 && a3.shine < 1);
  assert.equal(a8.opacity, 1); assert.equal(a8.shine, 1); assert.equal(a8.scale, 1);
});

test('before the onset every arrival is invisible; cut is fully there at frame 0', () => {
  assert.equal(arrive('fade', -1, 30).opacity, 0);
  assert.equal(arrive('ghost', -1, 30).opacity, 0);
  assert.deepEqual(arrive('cut', 0, 30), {opacity: 1, scale: 1, dx: 0, dy: 0, blur: 0, rgb: 0, shine: 1});
});

test('rgb: blur and channel split fall to 0 within 125 ms', () => {
  assert.ok(arrive('rgb', 0, 30).rgb > 0);
  assert.equal(arrive('rgb', ms(30, 125), 30).rgb, 0);
  assert.equal(arrive('rgb', ms(30, 125), 30).blur, 0);
});

test('pop keeps the word visible while it scales from 0.7', () => {
  const p0 = arrive('pop', 0, 30);
  assert.equal(p0.opacity, 1); assert.ok(p0.scale >= 0.7 && p0.scale < 0.75);
  assert.ok(Math.abs(arrive('pop', 40, 30).scale - 1) < 0.01);
});

test('leave letters: the last letter goes first, ~1.5 frames apart at 24 fps', () => {
  assert.equal(leave('letters', 100, 24).letterCut, 0);
  assert.ok(leave('letters', 3, 24).letterCut >= 2);
  assert.equal(leave('cut', 0, 30).opacity, 1);
  assert.equal(leave('fade', 0, 30).opacity, 0);
});

test('boxTravel: 80 ms from one word to the next, monotonic', () => {
  assert.equal(boxTravel(0, 100, 0, 30), 0);
  assert.equal(boxTravel(0, 100, ms(30, 80), 30), 100);
  const mid = boxTravel(0, 100, 1, 30);
  assert.ok(mid > 0 && mid < 100);
});

test('cardLanding: 70 % of the way in 330 ms, the rest drifting for 700 ms', () => {
  assert.equal(cardLanding(0, 30), 0);
  assert.ok(Math.abs(cardLanding(ms(30, 330), 30) - 0.7) < 0.01);
  assert.equal(cardLanding(ms(30, 330) + ms(30, 700), 30), 1);
});
