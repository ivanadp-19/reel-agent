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

import {cutRange} from '../src/timeline.ts';

test('cutRange removes the middle words and mints short ids', () => {
  const r = cutRange([clip], 'a', 1.95, 2.35);
  assert.deepEqual(shown(r.clips), ['uno', 'dos', 'tres']);
  assert.deepEqual(r.clips.map((c) => c.id), ['a', 'a-s2']);
  const again = cutRange(r.clips, 'a-s2', 5, 6);
  assert.deepEqual(again.clips.map((c) => c.id), ['a', 'a-s2', 'a-s3']); // never a-s2-s1
});

test('cutRange at an edge trims; the whole clip removes it', () => {
  assert.equal(cutRange([clip], 'a', 0, 1.95).clips[0].inSec, 1.95);
  assert.equal(cutRange([clip], 'a', 2.35, 10).clips[0].outSec, 2.35);
  assert.equal(cutRange([clip], 'a', 0.1, 9.9).clips.length, 0); // slivers under 0.2 s fold into the cut
});

const gen = (id, words) => ({id, src: 'clips/a.mp4', words, startMs: words[0].startMs, endMs: words[words.length - 1].endMs, topPct: 58});
const wd = (wid, text, a) => ({wid, text, startMs: a, endMs: a + 300, tier: 0});

test('re-page (replace): deleted words stay gone, a retexted page survives without a duplicate', () => {
  const fresh = [gen('c0', [wd('a:0', 'uno', 0), wd('a:1', 'dos', 400)]), gen('c1', [wd('a:2', 'tres', 1000), wd('a:3', 'cuatro', 1400)])];
  const edited = {...gen('c1', [wd('a:2', 'tres', 1000), wd('a:3', 'CUATRO', 1400)]), covers: ['a:2', 'a:3']};
  const r = mergeCaptions([edited], fresh, [clip], {hidden: ['a:0', 'a:1'], replace: true});
  assert.deepEqual(r.captions.map((c) => c.words.map((x) => x.text).join(' ')), ['tres CUATRO']);
  assert.equal(r.added, 0);
});

test('generate (no replace): existing pages stay, only new words get pages', () => {
  const existing = [gen('c0', [wd('a:0', 'uno', 0), wd('a:1', 'dos', 400)])];
  const fresh = [gen('c0', [wd('a:0', 'uno', 0), wd('a:1', 'dos', 400), wd('a:2', 'tres', 800)])];
  const r = mergeCaptions(existing, fresh, [clip]);
  assert.deepEqual(r.captions.map((c) => `${c.id} ${c.words.map((x) => x.text).join(' ')}`), ['c0 uno dos', 'c1 tres']);
});

test('autocut: an empty segment list drops the clip, a missing entry keeps it', () => {
  const b = {...clip, id: 'b'}, c2 = {...clip, id: 'c'};
  const r = applyAutocut([clip, b, c2], [{id: 'b', segments: []}, {id: 'a', segments: [{inSec: 1, outSec: 2}]}]);
  assert.deepEqual(r.clips.map((x) => x.id), ['a', 'c']);
});

import {focusSpans} from '../src/captions.ts';
import {pageScale, PRESETS} from '../src/captionPresets.ts';

test('focusSpans: a tier-2 word blurs from just before its onset to the end of its page', () => {
  const pages = [
    {id: 'c0', src: 's', words: [{text: 'y', startMs: 1000, endMs: 1100}, {text: 'sky', startMs: 1200, endMs: 1600, tier: 2}], startMs: 1000, endMs: 1600, topPct: 58},
    {id: 'c1', src: 's', words: [{text: 'bar', startMs: 2000, endMs: 2300}], startMs: 2000, endMs: 2300, topPct: 58},
  ];
  assert.deepEqual(focusSpans(pages, 1200), [{startMs: 1080, endMs: 2000}]); // the next page cuts the hold
  assert.deepEqual(focusSpans(pages.slice(0, 1), 1200), [{startMs: 1080, endMs: 2800}]);
});

test('pageScale: short pages render bigger only in auto-scale packs', () => {
  assert.equal(pageScale(PRESETS.prism, 1), 1.5);
  assert.equal(pageScale(PRESETS.prism, 5), 1);
  assert.equal(pageScale(PRESETS.focus, 1), 1);
});

import {hideUnder} from '../src/captions.ts';

test('hideUnder: a page before the closing card cannot hold into it once the pages under the card are gone', () => {
  const P = (id, a, b) => ({id, src: 's', words: [{text: id, startMs: a, endMs: b}], startMs: a, endMs: b, topPct: 58, holdMaxMs: 10000});
  const pages = [P('c0', 1000, 2000), P('c1', 4000, 5000), P('c2', 5300, 6000)];
  const shown = hideUnder(pages, [{startMs: 5200, endMs: 8000}]);
  assert.deepEqual(shown.map((c) => c.id), ['c0', 'c1']); // c2 starts under the card
  assert.equal(shown[1].holdMaxMs, 5200); // c1's hold stops where the card starts
  assert.equal(shown[0].holdMaxMs, 5200); // (a cap earlier than the clip end is harmless)
  assert.equal(shown[1].endMs, 5000); // it ended before the card: its own end is kept
});

import {PACKS} from '../src/stylePacks.ts';
import {PRESETS as ALL_PRESETS} from '../src/captionPresets.ts';
import {ENTERS} from '../src/transitions.ts';
import {FONT_FAMILIES} from '../src/fonts.ts';
import {resolveBrand, DEFAULT_ACCENT} from '../src/brand.ts';

test('the 20 style packs are complete and consistent', () => {
  const ids = Object.keys(PACKS);
  assert.equal(ids.length, 20);
  for (const id of ids) {
    const p = PACKS[id];
    assert.ok(ALL_PRESETS[id], `${id} preset`);
    assert.ok(ENTERS.includes(p.transition), `${id} transition`);
    for (const c of [p.accent, p.dark, p.light]) assert.match(c, /^#[0-9A-Fa-f]{6}$/, `${id} ${c}`);
    if (p.display) assert.ok(FONT_FAMILIES.includes(p.display), `${id} display`);
    if (p.script) assert.ok(FONT_FAMILIES.includes(p.script), `${id} script`);
    assert.ok(p.desc.length > 20);
  }
});

test('resolveBrand: a brand kit wins, then a project accent that was set, then the pack palette', () => {
  const pack = PACKS.prime;
  assert.equal(resolveBrand(null, DEFAULT_ACCENT, pack).accent, pack.accent);
  assert.equal(resolveBrand(null, DEFAULT_ACCENT, pack).script, 'Kaushan Script');
  assert.equal(resolveBrand(null, '#123456', pack).accent, '#123456');
  assert.equal(resolveBrand({colors: {accent: '#abcdef'}, fonts: {}}, '#123456', pack).accent, '#abcdef');
  assert.equal(resolveBrand(null, DEFAULT_ACCENT).accent, DEFAULT_ACCENT);
});
