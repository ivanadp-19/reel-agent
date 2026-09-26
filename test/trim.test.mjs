import test from 'node:test';
import assert from 'node:assert/strict';
import {trimClip} from '../src/timeline.ts';

const clips = [{id: 'a', src: 'clips/a.mp4', inSec: 2, outSec: 8, sourceDurationSec: 12}, {id: 'b', src: 'clips/b.mp4', inSec: 0, outSec: 3, sourceDurationSec: 3}];

test('trimClip: clamps to the source, keeps an omitted end, refuses under 0.2 s', () => {
  const r = trimClip(clips, 'a', -1, 20);
  assert.deepEqual([r.clip.inSec, r.clip.outSec], [0, 12]);
  assert.equal(r.clips[1], clips[1]);
  assert.deepEqual([trimClip(clips, 'a', 5).clip.inSec, trimClip(clips, 'a', 5).clip.outSec], [5, 8]);
  assert.equal(trimClip(clips, 'a', 0.1, 0.3).clip.outSec, 0.3); // exactly the minimum is fine (0.3 - 0.1 < 0.2 in floats)
  assert.match(trimClip(clips, 'a', 7.9).error, /shorter than 0\.2 s/);
  assert.match(trimClip(clips, 'a', 13).error, /shorter than 0\.2 s/); // past the source end
  assert.match(trimClip(clips, 'x', 1).error, /no clip x/);
  assert.deepEqual([clips[0].inSec, clips[0].outSec], [2, 8]); // input untouched
});
