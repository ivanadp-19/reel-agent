import test from 'node:test';
import assert from 'node:assert/strict';
import {jCutSec, lCutSec, clipDurationSec} from '../src/timeline.ts';

const clip = (over = {}) => ({id: 'a', src: 'clips/a.mp4', inSec: 2, outSec: 8, sourceDurationSec: 12, ...over});

test('no J/L by default: zero, and the helpers ignore undefined', () => {
  const c = clip();
  assert.equal(jCutSec(c), 0);
  assert.equal(lCutSec(c), 0);
});

test('J-cut: the lead fits in the clip and in the previous one', () => {
  const c = clip({jSec: 1.2});
  assert.equal(jCutSec(c, 10), 1.2);
  assert.equal(jCutSec(c, 0.5), 0.5); // previous clip is shorter than the lead
  assert.equal(jCutSec(clip({jSec: 99}), 99), clipDurationSec(c)); // never longer than the clip
  assert.equal(jCutSec(c, 0), 0); // first clip on the timeline has no J-cut
});

test('L-cut: bounded by the audio left in the source and by the next clip', () => {
  const c = clip({lSec: 3}); // 4 s of source left after outSec
  assert.equal(lCutSec(c, 10), 3);
  assert.equal(lCutSec(clip({lSec: 99}), 99), 4); // only 4 s left in the source
  assert.equal(lCutSec(c, 1), 1); // the next clip is shorter than the trail
  assert.equal(lCutSec(c, 0), 0); // last clip: nothing to trail under
});

test('speed: durations and source bounds follow the playback rate', () => {
  const c = clip({speed: 2, lSec: 99}); // at 2x the 4 s left in the source last 2 s
  assert.equal(clipDurationSec(c), 3);
  assert.equal(lCutSec(c, 99), 2);
  assert.equal(jCutSec(clip({speed: 2, jSec: 99}), 99), 3);
});

test('out at the source edge: no L-cut possible', () => {
  assert.equal(lCutSec(clip({outSec: 12, lSec: 2}), 10), 0);
});
