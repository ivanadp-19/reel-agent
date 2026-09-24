import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pageWords, reapplyTiers} from '../src/paging.ts';
import {PRESETS} from '../src/captionPresets.ts';

const W = (i, word, s, e) => ({wid: `a:${i}`, word, src: 'clips/a.mp4', clipId: 'a', startMs: s, endMs: e, srcStartMs: s, srcEndMs: e});
// "Todo esto es tuyo en Montalbán. 326." — 'en' is a glue word, then a 0.5 s pause before "326."
const words = [W(0, 'Todo', 0, 300), W(1, 'esto', 350, 600), W(2, 'es', 650, 800), W(3, 'tuyo', 850, 1200), W(4, 'en', 1250, 1400), W(5, 'Montalbán', 1450, 2000), W(6, '326.', 2500, 3000)];
const texts = (pages) => pages.map((p) => p.words.map((w) => w.text).join(' '));

test('palabra: one word per page, ids and word ids kept', () => {
  const pages = pageWords(words, PRESETS.palabra);
  assert.deepEqual(texts(pages), ['Todo', 'esto', 'es', 'tuyo', 'en', 'Montalbán', '326']);
  assert.equal(pages[5].words[0].wid, 'a:5');
  assert.deepEqual(pages.map((p) => p.id), ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
});

test('caja: fills up to maxWords, breaks on sentence end', () => {
  assert.deepEqual(texts(pageWords(words, PRESETS.caja)), ['Todo esto es tuyo en Montalbán', '326']);
});

test('tracked: never ends a page on a glue word, breaks on pauses', () => {
  const pages = pageWords(words, PRESETS.tracked);
  assert.deepEqual(texts(pages), ['Todo esto es tuyo', 'en Montalbán', '326']);
  for (const p of pages) assert.notEqual(p.words.at(-1).text, 'en');
});

test('reapplyTiers carries tiers onto re-paged captions by word id', () => {
  const old = pageWords(words, PRESETS.caja);
  old[0].words[5].tier = 2; // Montalbán
  const fresh = reapplyTiers(old, pageWords(words, PRESETS.palabra));
  assert.equal(fresh.find((p) => p.words[0].wid === 'a:5').words[0].tier, 2);
  assert.equal(fresh.find((p) => p.words[0].wid === 'a:4').words[0].tier, 0);
});
