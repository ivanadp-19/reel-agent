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
