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
  for (const want of ['safe-top', 'glue', 'matte']) assert.ok(c.includes(want), `missing ${want} in ${c}`); // c1 steps below the stat instead of overlapping it
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

test('a caption under the hook moves just below it; with no room it stays and validate reports it', async () => {
  const {avoidGraphics, validateProject: vp} = await import('../src/validate.ts');
  const clip = {id: 'a', src: 'clips/a.mp4', inSec: 0, outSec: 10, sourceDurationSec: 10};
  const hook = {id: 'g0', src: 'clips/a.mp4', startMs: 0, endMs: 2500, template: 'hook-stack', yPct: 45, props: {lines: [{text: 'THE BIGGEST', size: 'lg', accent: false}, {text: 'LIE ABOUT MONEY', size: 'lg', accent: true}], upper: false}};
  const cap = (id, a, b, topPct = 50) => ({id, src: 'clips/a.mp4', words: [{text: 'the', startMs: a, endMs: a + 200}, {text: 'media', startMs: a + 250, endMs: b}], startMs: a, endMs: b, topPct});
  const [moved, later] = avoidGraphics([cap('c0', 500, 1500), cap('c1', 3000, 4000)], [hook], 'focus');
  assert.ok(moved.pin && moved.topPct > 58 && moved.topPct < 75, JSON.stringify(moved));
  assert.equal(later.topPct, 50);
  const codes = (h) => vp({clips: [clip], captions: [cap('c0', 500, 1500)], graphics: [h]}, 30).map((i) => i.code);
  assert.ok(!codes(hook).includes('overlap-graphic'));
  // a 4-line hook at 30–67 % and a huge caption (21 % tall): no room above or below
  const tall = {...hook, yPct: 30, props: {lines: ['A', 'B', 'C', 'D'].map((text) => ({text, size: 'xl', accent: false})), upper: false}};
  const huge = {...cap('c0', 500, 1500), scale: 4};
  assert.equal(avoidGraphics([huge], [tall]).at(0).topPct, 50);
  assert.ok(vp({clips: [clip], captions: [huge], graphics: [tall]}, 30).some((i) => i.code === 'overlap-graphic'));
});

test('transcriptIssues: an off-mic word listed on two pieces of one source counts once, in one run', async () => {
  const {transcriptIssues} = await import('../src/validate.ts');
  const w = (i, s, e, off) => ({i, word: `w${i}`, startMs: s, endMs: e, ...(off ? {off: true} : {})});
  // w1 straddles the split at 1.5 s, so the transcript lists it on both pieces
  const tr = [{clipId: 'a', source: 'S', words: [w(0, 0, 900), w(1, 1000, 2000, true)]}, {clipId: 'b', source: 'S', words: [w(1, 1000, 2000, true), w(2, 2100, 2600, true)]}];
  const clips = [{id: 'a', src: 'clips/S.mp4', inSec: 0, outSec: 1.5, sourceDurationSec: 5}, {id: 'b', src: 'clips/S.mp4', inSec: 1.5, outSec: 3, sourceDurationSec: 5}];
  const off = transcriptIssues({clips}, tr).filter((x) => x.code === 'off-mic');
  assert.match(off.find((x) => x.ref === 'b').msg, /^b: 2 off-mic word\(s\) still in the cut: cut_words S:1…S:2 "w1 w2"/);
});

test('captions switched off (set_captions): their pages are not checked', () => {
  const p = {clips: [clip], captionStyle: 'caja', captions: [page('c0', 500, 1500, [W('Todo', 500, 800), W('en', 900, 1500)], 5)], graphics: []};
  assert.ok(codes(validateProject(p)).includes('glue'));
  const off = codes(validateProject({...p, captionsOff: true}));
  assert.ok(!off.includes('glue') && !off.includes('safe-top'), String(off));
});
