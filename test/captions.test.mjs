import {test} from 'node:test';
import assert from 'node:assert/strict';
import {projectCaptions, mergeCaptions} from '../src/captions.ts';
import {splitClip, applyAutocut} from '../src/timeline.ts';

const FPS = 30;
const clip = {id: 'a', src: 'clips/a.mp4', inSec: 0, outSec: 10, sourceDurationSec: 10};
const W = (text, startMs, endMs) => ({text, startMs, endMs, accent: false});
// one page: "uno dos eh tres", the "eh" at 2.0–2.3 s is the filler we cut out
const page = {id: 'c0', src: 'clips/a.mp4', words: [W('uno', 1000, 1400), W('dos', 1500, 1900), W('eh', 2000, 2300), W('tres', 2400, 2800)], startMs: 1000, endMs: 2800, topPct: 58};
const shown = (clips) => projectCaptions([page], clips, FPS).flatMap((p) => p.words.map((w) => w.text));

test('an autocut inside a page drops the removed word and closes the gap', () => {
  const r = applyAutocut([clip], [{id: 'a', segments: [{inSec: 0, outSec: 1.95}, {inSec: 2.35, outSec: 10}]}]);
  assert.deepEqual(shown(r.clips), ['uno', 'dos', 'tres']);
  const tres = projectCaptions([page], r.clips, FPS).flatMap((p) => p.words).find((w) => w.text === 'tres');
  assert.ok(Math.abs(tres.startMs - 2000) < 40, `tres should start ~2.0 s, got ${tres.startMs}`); // 0.4 s earlier: the gap is gone
});

test('split twice + delete the middle piece removes only those words', () => {
  let r = splitClip([clip], 'a', 1.95);
  r = splitClip(r.clips, r.newId, 2.35);
  const middle = r.clips[1].id;
  assert.deepEqual(shown(r.clips), ['uno', 'dos', 'eh', 'tres']); // nothing lost by splitting alone
  assert.deepEqual(shown(r.clips.filter((c) => c.id !== middle)), ['uno', 'dos', 'tres']);
});

test('a source placed twice shows its captions in both places', () => {
  const proj = projectCaptions([page], [clip, {...clip, id: 'a2'}], FPS);
  assert.deepEqual(proj.map((p) => p.clipId), ['a', 'a2']);
  assert.equal(proj[1].startMs, 10000 + 1000);
});

test('mergeCaptions keeps edited pages (stable ids) and adds only uncovered fresh ones', () => {
  const fresh = [{...page, id: 'c0'}, {id: 'c1', src: 'clips/a.mp4', words: [W('cuatro', 5000, 5400)], startMs: 5000, endMs: 5400, topPct: 58}];
  const edited = {...page, id: 'c7', words: page.words.map((w) => ({...w, accent: w.text === 'dos'}))};
  const {captions, added} = mergeCaptions([edited], fresh, [clip]);
  assert.equal(added, 1);
  assert.deepEqual(captions.map((c) => c.id), ['c7', 'c8']);
  assert.ok(captions[0].words[1].accent);
});
