// Unit examples for the name/number + highlight-span bonding rule (layout.unbreakable).
// Rule: when preset.layout.unbreakable is set, pageWords must never place a page
// boundary (a) inside a run of tier>=1 highlight words, or (b) between a
// Capitalized word and a following Capitalized-or-digit word ("Montealbán 326",
// "Temozón Norte" are single names). 3 lines or a smaller size beats splitting.
// The same predicate guards line breaks in CaptionTrack (nowrap group).
// Run: node --test test/bonding.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pageWords} from '../src/paging.ts';

// minimal TimelineWord factory: 300ms words, 500ms gaps, one clip. The 500ms
// gaps exceed both GAP_MS (450, page-break pause) and the 350ms orphan-merge
// window, so every flush decision is driven by the bonding rule itself.
const W = (word, i, tier = 0) => ({
  wid: `s:${i}`, word, src: 's', clipId: 'clip1',
  startMs: i * 800, endMs: i * 800 + 300,
  srcStartMs: i * 800, srcEndMs: i * 800 + 300, tier,
});
const texts = (pages) => pages.map((p) => p.words.map((w) => w.text).join(' '));
const preset = (maxWords, maxCharsLine, unbreakable = true) => ({layout: {maxWords, maxCharsLine, unbreakable}});

test('name+number stays on one page even past maxCharsLine', () => {
  // "Montealbán" alone (10 chars) already exceeds maxCharsLine 8 — without
  // bonding the page would flush before "326".
  const pages = pageWords([W('Montealbán', 0, 1), W('326', 1, 1)], preset(6, 8));
  assert.deepEqual(texts(pages), ['Montealbán 326']);
});

test('proper-name pair (Capitalized + Capitalized) stays together', () => {
  const pages = pageWords([W('Temozón', 0), W('Norte', 1)], preset(6, 8));
  assert.deepEqual(texts(pages), ['Temozón Norte']);
});

test('lowercase word + number is NOT bonded and may split', () => {
  const pages = pageWords([W('departamento', 0), W('326', 1)], preset(6, 8));
  assert.deepEqual(texts(pages), ['departamento', '326']);
});

test('lowercase pair is NOT bonded', () => {
  const pages = pageWords([W('temozón', 0), W('norte', 1)], preset(6, 8));
  assert.deepEqual(texts(pages), ['temozón', 'norte']);
});

test('tier>=1 highlight span is one page even past maxWords', () => {
  // maxWords 2, but all three words are tier 1 -> single 3-word page
  const pages = pageWords([W('salón', 0, 1), W('para', 1, 1), W('sesenta', 2, 1)], preset(2, 24));
  assert.deepEqual(texts(pages), ['salón para sesenta']);
});

test('plain words still page normally under the same preset', () => {
  // no bonding between lowercase plain words: each 500ms pause flushes a page
  const pages = pageWords([W('hoy', 0), W('esto', 1), W('está', 2)], preset(2, 24));
  assert.deepEqual(texts(pages), ['hoy', 'esto', 'está']);
});

test('unbreakable off restores splitting inside name+number', () => {
  const pages = pageWords([W('Montealbán', 0, 1), W('326', 1, 1)], preset(6, 8, false));
  assert.deepEqual(texts(pages), ['Montealbán', '326']);
});

test('a clip boundary still separates pages (bonding never spans clips)', () => {
  const a = W('Montealbán', 0, 1);
  const b = {...W('326', 1, 1), clipId: 'clip2'};
  const pages = pageWords([a, b], preset(6, 34));
  assert.deepEqual(texts(pages), ['Montealbán', '326']);
});
