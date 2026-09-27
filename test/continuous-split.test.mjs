// A split with nothing cut out (a shot change in a pre-edit) is one take to the speech: the word on
// the join is not doubled, pages run across it and stay one page on the timeline (G10 "ESO ESO").
// A real cut still breaks the page.
import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {projectCaptions} from '../src/captions.ts';
import {cutRange, placeClips, splitClip} from '../src/timeline.ts';
import {pageWords} from '../src/paging.ts';
import {presetOf} from '../src/captionPresets.ts';

const FPS = 30;
const clip = {id: 'a', src: 'clips/a.mp4', inSec: 0, outSec: 10, sourceDurationSec: 10};
// "Mira ESO ahora." — ESO (1.1–1.5 s) straddles the split at 1.3 s
const heard = [['Mira', 800, 1050], ['ESO', 1100, 1500], ['ahora.', 1550, 1900]].map(([word, startMs, endMs]) => ({word, startMs, endMs}));
const split = splitClip([clip], 'a', 1.3).clips;
const ramp = split.map((c, i) => ({...c, speed: [1.44, 1.5][i]})); // set_speed_ramp: the same split, a speed per piece

// lib-transcribe reads public/ from the cwd at import: one temp dir for the file
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-split-'));
fs.mkdirSync(path.join(dir, 'public/clips/transcripts'), {recursive: true});
fs.writeFileSync(path.join(dir, 'public/clips/transcripts/a.auto.json'), JSON.stringify(heard));
const cwd = process.cwd();
process.chdir(dir);
const {assembleWords} = await import('../scripts/lib-transcribe.mjs');
process.chdir(cwd);
after(() => fs.rmSync(dir, {recursive: true, force: true}));

for (const [name, clips] of [['a split', split], ['a speed ramp', ramp]]) test(`assembled + paged across ${name}: ESO once, one page`, async () => {
  const words = await assembleWords(clips, null, 'auto', 'off');
  assert.deepEqual(words.map((w) => w.word), ['Mira', 'ESO', 'ahora.']);
  const pages = pageWords(words, presetOf('vibem'));
  assert.deepEqual(pages.map((p) => p.words.map((w) => w.text).join(' ')), ['Mira ESO ahora']);
  const shown = projectCaptions(pages, clips, FPS);
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0].words.map((w) => w.text), ['Mira', 'ESO', 'ahora']);
  assert.equal(shown[0].clipId, 'a'); // pages of one take share its id: validate's overlap check compares them
  assert.equal(shown[0].holdMaxMs, placeClips(clips, FPS).at(-1).endMs); // holds to the end of the take, not of the first piece
});

test('a real cut inside the page still makes two pages', () => {
  const page = {id: 'c0', src: 'clips/a.mp4', words: heard.map((w) => ({text: w.word, startMs: w.startMs, endMs: w.endMs})), startMs: 800, endMs: 1900, topPct: 58};
  assert.equal(projectCaptions([page], split, FPS).length, 1);
  const cut = cutRange([clip], 'a', 1.5, 1.75).clips; // a real cut: 250 ms gone after ESO
  assert.equal(projectCaptions([page], cut, FPS).length, 2);
});

// ---- 3-frame pieces left behind, speeds, the trim handle (the verifier's split findings) ----
import {cutRange as cutR, MIN_PIECE_SEC as MIN, placeClips as placeC, rampClip, splitClip as splitC, trimDragSec} from '../src/timeline.ts';
import {applyWordCuts, planWordCuts} from '../src/cuts.ts';

test('cut_words drops the 3-frame piece it strands: a half-graded tail whose shot the cut took would flash on its own', () => {
  // Morantes 10's fix at 8.742 (split at the cut 8.842, then at the change), then cut_words on the sentence the tail ends
  const src = 'clips/m.mp4', c0 = {id: 'M', src, inSec: 0, outSec: 20, sourceDurationSec: 44.778};
  let clips = splitC([c0], 'M', 8.842).clips;
  clips = splitC(clips, 'M', 8.742).clips; // M 0–8.742 | M-s2 8.742–8.842 (the tail) | M-s1 8.842–20
  const words = [{i: 0, word: 'uno', startMs: 5000, endMs: 5600}, {i: 1, word: 'dos', startMs: 6000, endMs: 8300}, {i: 2, word: 'tres', startMs: 9500, endMs: 9900}];
  const tr = clips.map((c) => ({clipId: c.id, source: 'm', words: words.filter((w) => w.endMs > c.inSec * 1000 && w.startMs < c.outSec * 1000)}));
  const {spans} = planWordCuts(tr, clips, [{from_wid: 'm:1'}]);
  const r = applyWordCuts(clips, [], spans, tr);
  assert.deepEqual(r.clips.map((c) => [c.id, c.inSec, c.outSec]), [['M', 0, 5.85], ['M-s1', 8.842, 20]]);
  assert.match(r.lines.at(-1), /^dropped M-s2 \(0\.1s\): the cut took the clip it continued/);
  // a cut that leaves both its neighbours in place leaves it (the word before, cut out of M's middle)
  const keep = applyWordCuts(clips, [], planWordCuts(tr, clips, [{from_wid: 'm:0'}]).spans, tr);
  assert.ok(keep.clips.some((c) => c.id === 'M-s2'), keep.lines.join('; '));
});

test('cutRange: a cut near the edge of a fast clip folds in (3 frames on screen), and the removed middle has no minimum', () => {
  for (const speed of [1, 3, 4]) {
    const c = {id: 'A', src: 'clips/a.mp4', inSec: 0, outSec: 10, sourceDurationSec: 10, speed};
    const mid = cutR([c], 'A', 5, 5.05); // 1.5 frames of source cut out: fine, nothing is left that short
    assert.deepEqual(mid.clips.map((x) => [x.inSec, x.outSec]), [[0, 5], [5.05, 10]], `×${speed}`);
    const edge = cutR([c], 'A', 0.25, 5);
    const left = edge.clips.map((x) => [x.inSec, x.outSec]);
    // 0.25 s of source at ×3 / ×4 is under 3 frames on screen: folded into the cut instead of a piece split_clip refuses
    assert.deepEqual(left, speed * MIN > 0.25 ? [[5, 10]] : [[0, 0.25], [5, 10]], `×${speed}`);
    assert.ok(placeC(edge.clips, 30).every((p) => p.durFrames >= 3), `×${speed}: every piece ≥ 3 frames`);
  }
});

test('rampClip: a clip already at ×3.5 ramps like a slow one (split at ×1, then each piece its speed); the editor and set_speed_ramp use it', () => {
  const c = {id: 'X', src: 'clips/x.mp4', inSec: 2, outSec: 3, sourceDurationSec: 20, speed: 3.5};
  const r = rampClip([c], 'X', [3.5, 2, 1]);
  assert.deepEqual(r.clips.map((x) => [x.id, +x.inSec.toFixed(3), +x.outSec.toFixed(3), x.speed]), [['X', 2, 2.333, 3.5], ['X-s1', 2.333, 2.667, 2], ['X-s2', 2.667, 3, 1]]);
  assert.deepEqual(r.remap.map((m) => m.segId), ['X', 'X-s1', 'X-s2']);
  assert.equal(rampClip([{...c, outSec: 2.2}], 'X', [3.5, 2, 1]), null, 'pieces under 3 frames: refused');
});

test('trimDragSec (the editor\'s trim handle): a piece under the trim minimum never shrinks and never grows the wrong way', () => {
  const t = {inSec: 8.742, outSec: 8.842, sourceDurationSec: 44.778}; // a 3-frame half-graded tail
  assert.equal(trimDragSec(t, 'left', 0.04), 0, 'dragged in: stays');
  assert.equal(trimDragSec(t, 'left', -0.1), -0.1, 'dragged out: grows');
  assert.equal(trimDragSec(t, 'right', -0.04), 0);
  assert.equal(trimDragSec(t, 'right', 0.1), 0.1);
  const c = {inSec: 2, outSec: 5, sourceDurationSec: 6};
  assert.deepEqual([trimDragSec(c, 'left', 9), trimDragSec(c, 'left', -9), trimDragSec(c, 'right', -9), trimDragSec(c, 'right', 9)], [2.8, -2, -2.8, 1]);
});
