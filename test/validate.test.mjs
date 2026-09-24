import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateProject} from '../src/validate.ts';

const clip = {id: 'a', src: 'clips/a.mp4', inSec: 0, outSec: 20, sourceDurationSec: 20};
const W = (text, s, e, tier = 0) => ({wid: `a:${s}`, text, startMs: s, endMs: e, tier});
const page = (id, s, e, words, topPct = 58) => ({id, src: 'clips/a.mp4', words, startMs: s, endMs: e, topPct});
const codes = (issues) => issues.map((i) => i.code);

test('clean project → no issues', () => {
  const p = {clips: [clip], captions: [page('c0', 500, 1500, [W('Tu', 500, 800), W('cava', 900, 1500, 1)])], graphics: [], captionStyle: 'palabra'};
  assert.deepEqual(validateProject(p), []);
});

test('flags safe zones, glue endings, missing mattes and caption/graphic overlap', () => {
  const p = {
    clips: [clip], captionStyle: 'caja',
    captions: [page('c0', 500, 1500, [W('Todo', 500, 800), W('en', 900, 1500)], 5), page('c1', 4000, 5000, [W('ok', 4000, 5000)], 30)],
    graphics: [{id: 'g0', src: 'clips/a.mp4', startMs: 3900, endMs: 6000, template: 'stat', props: {value: '54', label: 'x'}, yPct: 28}, {id: 'g1', src: 'clips/a.mp4', startMs: 9000, endMs: 10000, template: 'big-word', props: {text: 'X'}, behind: true}],
    mattes: [],
  };
  const c = codes(validateProject(p));
  for (const want of ['safe-top', 'glue', 'overlap-graphic', 'matte']) assert.ok(c.includes(want), `missing ${want} in ${c}`);
});

test('too many tier-2 words is a warning', () => {
  const words = Array.from({length: 6}, (_, i) => W(`w${i}`, i * 2000, i * 2000 + 500, 2));
  const p = {clips: [clip], captions: words.map((w, i) => page(`c${i}`, w.startMs, w.endMs, [w])), graphics: []};
  assert.ok(codes(validateProject(p)).includes('tier2-density'));
});

test('a stacked hook behind the head is flagged when the head hides most of it; a word above the head is fine', async () => {
  const {validateProject: vp} = await import('../src/validate.ts');
  const clip = {id: 'a', src: 'clips/a.mp4', inSec: 0, outSec: 10, sourceDurationSec: 10};
  const face = {'clips/a.mp4': {found: true, left: 0.315, top: 0.2035, right: 0.585, bottom: 0.413}}; // IMG_1778
  const hook = {id: 'g0', src: 'clips/a.mp4', startMs: 0, endMs: 2500, template: 'hook-stack', behind: true, yPct: 16, props: {lines: [{text: 'THE BIGGEST', size: 'lg', accent: false}, {text: 'LIE ABOUT', size: 'lg', accent: false}, {text: 'MONEY', size: 'xl', accent: true}], upper: false}};
  const word = {id: 'g1', src: 'clips/a.mp4', startMs: 0, endMs: 2500, template: 'big-word', behind: true, yPct: 3, props: {text: 'DEBT', font: 'condensed', color: 'accent', size: 'xl', repeat: false, upper: true}};
  const codes = (g) => vp({clips: [clip], captions: [], graphics: [g], mattes: [{src: 'clips/a.mp4', startMs: 0, endMs: 10000}]}, 30, face).map((i) => i.code);
  assert.ok(codes(hook).includes('behind-hidden'));
  assert.ok(!codes(word).includes('behind-hidden'));
});
