import test from 'node:test';
import assert from 'node:assert/strict';
import {applyAutocut, clipDurationSec, cutRange, jCutSec, lCutSec, placeClips, splitClip} from '../src/timeline.ts';

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

test('a split leaves the J-cut on the head piece and the L-cut on the tail piece only', () => {
  const [a, b] = splitClip([clip({jSec: 1, lSec: 1})], 'a', 5).clips;
  assert.deepEqual([a.jSec, a.lSec], [1, undefined]);
  assert.deepEqual([b.jSec, b.lSec], [undefined, 1]);
});

test('autocut: only the first segment keeps the J-cut, only the last the L-cut', () => {
  const r = applyAutocut([clip({jSec: 1, lSec: 1})], [{id: 'a', segments: [{inSec: 2, outSec: 3}, {inSec: 4, outSec: 5}, {inSec: 6, outSec: 8}]}]);
  assert.deepEqual(r.clips.map((c) => [c.jSec, c.lSec]), [[1, undefined], [undefined, undefined], [undefined, 1]]);
});

test('cut_words in the middle of a clip: the same rule (first piece J, last piece L)', () => {
  const r = cutRange([clip({jSec: 1, lSec: 1})], 'a', 4, 6);
  assert.deepEqual(r.clips.map((c) => [c.jSec, c.lSec]), [[1, undefined], [undefined, 1]]);
});

test('placeClips decides the J/L frames once, against the real neighbours', () => {
  const clips = [clip({id: 'a', outSec: 3, jSec: 2}), clip({id: 'b', inSec: 0, outSec: 1, jSec: 3, lSec: 1}), clip({id: 'c', jSec: 3, lSec: 2})];
  const [a, b, c] = placeClips(clips, 30);
  assert.equal(a.jFrames, 0); // first clip: nothing to lead under
  assert.equal(b.jFrames, 30); // b lasts 1 s: its lead is at most 1 s
  assert.equal(b.lFrames, 30);
  assert.equal(c.jFrames, 30); // the previous clip lasts 1 s — not the 4 s of timeline before c
  assert.equal(c.lFrames, 0); // last clip: nothing to trail under
});
