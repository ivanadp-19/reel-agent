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

// ---- Phase 3: titles ----
import {revealText, scrambleChar, lifeFx} from '../src/motion.ts';

test('letters: one character every ~42 ms, the leading one blurred', () => {
  const r0 = revealText('letters', 0, 30, 8), r4 = revealText('letters', 4, 30, 8), rEnd = revealText('letters', 30, 30, 8);
  assert.ok(r0.shown < 1 && r0.blur > 0);
  assert.ok(r4.shown > 2.5 && r4.shown < 4.5);
  assert.equal(rEnd.shown, 8); assert.equal(rEnd.blur, 0); assert.equal(rEnd.scramble, false);
});

test('typewriter is faster than letters and never blurs; shuffle resolves left → right in 290 ms', () => {
  assert.ok(revealText('typewriter', 4, 30, 16).shown > revealText('letters', 4, 30, 16).shown);
  assert.equal(revealText('typewriter', 4, 30, 16).blur, 0);
  const s = revealText('shuffle', 3, 30, 10);
  assert.ok(s.scramble && s.shown > 2 && s.shown < 8);
  assert.equal(revealText('shuffle', 20, 30, 10).scramble, false);
  const a = scrambleChar(7, 3, 5), b = scrambleChar(7, 3, 5), c = scrambleChar(7, 3, 6);
  assert.equal(a, b); assert.ok(/^[A-Z0-9]$/.test(a)); assert.ok(a !== c || scrambleChar(7, 4, 5) !== scrambleChar(7, 4, 6));
});

test('tracking settles from 0.7 em to 0.38 em in 375 ms with every char shown', () => {
  const t0 = revealText('tracking', 0, 30, 5), t1 = revealText('tracking', 30, 30, 5);
  assert.equal(t0.shown, 5); assert.ok(Math.abs(t0.tracking - 0.7) < 0.01); assert.ok(Math.abs(t1.tracking - 0.38) < 0.01);
});

test('arrivals for title blocks: band rises from below, slideDown drops from above, wipe sweeps a clip from the left', () => {
  assert.ok(arrive('band', 0, 30).dy > 300 && arrive('band', 10, 30).dy === 0);
  assert.ok(arrive('slideDown', 0, 30).dy < -200 && arrive('slideDown', 10, 30).dy === 0);
  assert.ok(arrive('wipe', 0, 30).clip.startsWith('polygon(') && arrive('wipe', 10, 30).clip === undefined);
});

test('life: grow reaches 1.3× after 1.2 s, marquee runs ~408 px/s, oscillate stays within ±3°', () => {
  assert.equal(lifeFx('grow', 0, 30).scale, 1);
  assert.ok(Math.abs(lifeFx('grow', 36, 30).scale - 1.3) < 0.01 && Math.abs(lifeFx('grow', 90, 30).scale - 1.3) < 0.01);
  assert.ok(Math.abs(lifeFx('marquee', 30, 30).dx + 408) < 1);
  for (const f of [0, 7, 19, 40]) assert.ok(Math.abs(lifeFx('oscillate', f, 30).rotate) <= 3.001);
  assert.deepEqual(lifeFx('none', 12, 30), {scale: 1, dx: 0, rotate: 0});
});
