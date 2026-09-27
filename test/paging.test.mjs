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

import {reapplyTiers as carry} from '../src/paging.ts';

test('re-paging carries pinned position, size and behind with the words', () => {
  const w = (wid, text, a) => ({wid, text, startMs: a, endMs: a + 200, tier: 0});
  const old = [{id: 'c0', src: 's', words: [w('s:0', 'big', 0), {...w('s:1', 'money', 300), tier: 2}], startMs: 0, endMs: 500, topPct: 30, pin: true, scale: 1.5, behind: true}];
  const fresh = [{id: 'c0', src: 's', words: [w('s:0', 'big', 0)], startMs: 0, endMs: 200, topPct: 58}, {id: 'c1', src: 's', words: [w('s:1', 'money', 300), w('s:2', 'lie', 600)], startMs: 300, endMs: 800, topPct: 58}];
  const r = carry(old, fresh);
  assert.deepEqual(r.map((c) => [c.topPct, c.pin, c.scale, c.behind]), [[30, true, 1.5, true], [30, true, 1.5, true]]);
  assert.equal(r[1].words[0].tier, 2);
});

test('re-paging keeps per-word emoji', () => {
  const old = [{id: 'c0', src: 's', words: [{wid: 's:0', text: 'money', startMs: 0, endMs: 300, tier: 0, emoji: '💰'}], startMs: 0, endMs: 300, topPct: 58}];
  const fresh = [{id: 'c0', src: 's', words: [{wid: 's:0', text: 'money', startMs: 0, endMs: 300, tier: 0}], startMs: 0, endMs: 300, topPct: 58}];
  assert.equal(carry(old, fresh)[0].words[0].emoji, '💰');
});

test('a full page breaks before its trailing function words, not after them', () => {
  const text = 'They all lied to us about this one thing.'.split(' ');
  const words = text.map((word, i) => ({wid: `s:${i}`, word, src: 's', clipId: 'a', startMs: i * 300, endMs: i * 300 + 250, srcStartMs: i * 300, srcEndMs: i * 300 + 250}));
  const pages = pageWords(words, PRESETS.focus).map((p) => p.words.map((w) => w.text).join(' '));
  assert.deepEqual(pages, ['They all lied to us', 'about this one thing']);
});

test('a sentence end always ends the page, even between bonded capitalized words (vibem); abbreviations do not', () => {
  const ws = ['Vive', 'en', 'Playa', 'del', 'Carmen.', 'Está', 'cerca', 'del', 'Sr.', 'Pérez.'].map((w, i) => ({wid: `a:${i}`, word: w, startMs: i * 400, endMs: i * 400 + 350, srcStartMs: i * 400, srcEndMs: i * 400 + 350, clipId: 'a', src: 'clips/a.mp4'}));
  const pages = pageWords(ws, PRESETS.vibem).map((p) => p.words.map((w) => w.text).join(' '));
  assert.deepEqual(pages, ['Vive en Playa del Carmen', 'Está cerca del Sr Pérez']);
});

// ---- the kit's multi-word glossary terms: never split across pages, in every pack (synthetic words) ----
import {repage} from '../src/paging.ts';
import {applyGlossary} from '../src/guion.ts';
import {splitNameFindings} from '../.agents/skills/render-judge/judge.mjs';

const GL = [{term: 'Pet Park', variants: ['Pit Bark']}, {term: 'Star Médica', variants: ['Esther Médica', 'Starmédica']}, {term: 'Playa del Carmen'}, {term: 'Río Verde Norte Sur'}, {term: 'Arboleda'}, {term: '45'}];
// words of one sentence, 300 ms apart; clipOf(i) picks the take
const said = (s, clipOf = () => 'a') => s.split(' ').map((word, i) => ({wid: `a:${i}`, word, src: 'clips/a.mp4', clipId: clipOf(i), startMs: i * 300, endMs: i * 300 + 250, srcStartMs: i * 300, srcEndMs: i * 300 + 250}));
const paged = (ws, pack, g = GL) => texts(pageWords(applyGlossary(ws, g).words, PRESETS[pack], g));

test('a glossary term at a page boundary stays on one page — vibem and other packs, variants respelled first', () => {
  const pet = said('Aquí tienes el Pit Bark, la alberca y el gym.');
  assert.deepEqual(paged(pet, 'vibem', []), ['Aquí tienes el Pit', 'Bark, la alberca', 'y el gym']); // before: split at the 18-char page
  assert.deepEqual(paged(pet, 'vibem'), ['Aquí tienes', 'el Pet Park, la alberca', 'y el gym']); // the break moves before the term (and its article)
  assert.deepEqual(paged(said('Tu hospital es Esther Médica, muy cerca.'), 'vibem', []), ['Tu hospital es Esther', 'Médica, muy cerca']);
  assert.deepEqual(paged(said('Tu hospital es Esther Médica, muy cerca.'), 'vibem'), ['Tu hospital', 'es Star Médica', 'muy cerca']);
  // one ASR word the glossary splits in two (pieces share the id) is a term too
  assert.deepEqual(paged(said('Tu hospital es Starmédica, muy cerca.'), 'vibem'), ['Tu hospital', 'es Star Médica', 'muy cerca']);
  assert.deepEqual(paged(said('Hoy visitamos el Pet Park techado.'), 'tracked', []), ['Hoy visitamos el Pet', 'Park techado']);
  assert.deepEqual(paged(said('Hoy visitamos el Pet Park techado.'), 'tracked'), ['Hoy visitamos', 'el Pet Park techado']);
  assert.deepEqual(paged(said('La clínica hoy es Star Médica abierta.'), 'evo'), ['La clínica hoy', 'es Star Médica abierta']);
  // every pack, those with Fats403's caps (minWords / minMs) included
  for (const pack of Object.keys(PRESETS)) {
    const pages = pageWords(applyGlossary(pet, GL).words, PRESETS[pack], GL);
    const at = pages.findIndex((p) => p.words.some((w) => w.text === 'Pet'));
    assert.ok(pages[at].words.some((w) => w.text.startsWith('Park')), `${pack}: ${texts(pages).join(' | ')}`);
  }
});

test('a 3-word term, a term longer than the page (its own page), a word-at-a-time pack', () => {
  assert.deepEqual(paged(said('Vivir aquí en Playa del Carmen es fácil.'), 'tracked', []), ['Vivir aquí en Playa', 'del Carmen es fácil']);
  assert.deepEqual(paged(said('Vivir aquí en Playa del Carmen es fácil.'), 'tracked'), ['Vivir aquí', 'en Playa del Carmen', 'es fácil']);
  // evo holds 3 words: a 4-word term opens its own page and grows past it
  assert.deepEqual(paged(said('Hoy abre Río Verde Norte Sur ya.'), 'evo'), ['Hoy abre', 'Río Verde Norte Sur', 'ya']);
  assert.deepEqual(paged(said('Visita el Pet Park hoy.'), 'palabra'), ['Visita', 'el', 'Pet Park', 'hoy']);
});

test('a term at the start or the end of a take; never bonded across a clip cut, a parenthesis or a sentence end', () => {
  const takes = said('Pet Park abre hoy con sol y música. Ven al Pet Park', (i) => (i < 8 ? 'a' : 'b'));
  assert.deepEqual(paged(takes, 'evo'), ['Pet Park abre', 'hoy con sol', 'y música', 'Ven al Pet Park']); // 'Ven' alone would be an orphan: the page takes the term
  // the same source cut between the two words: two takes, two pages (the pager never spans clips)
  assert.deepEqual(paged(said('Visita el Pet Park hoy.', (i) => (i < 3 ? 'a' : 'b')), 'caja'), ['Visita el Pet', 'Park hoy']);
  assert.deepEqual(paged(said('Visita el Pet ( risas ) Park hoy.'), 'caja'), ['Visita el Pet', 'Park hoy']);
  assert.deepEqual(paged(said('Llegamos al Pet. Park es otra cosa.'), 'caja'), ['Llegamos al Pet', 'Park es otra cosa']);
  // a guion sentence start inside a name is an alignment slip: the name wins, as a bond does
  const slip = said('Aquí tienes el Pet Park, la alberca.');
  slip[4].sentenceStart = true;
  assert.deepEqual(paged(slip, 'vibem'), ['Aquí tienes', 'el Pet Park, la alberca']);
});

test('vibem keeps its own splits: single-word terms bond nothing (a name | its figure), figures stand alone', () => {
  const ws = said('Esto es Arboleda 45, con alberca.').map((w, i) => ({...w, tier: i === 2 || i === 3 ? 1 : 0}));
  ws[3].startMs = ws[3].srcStartMs = 900 + 500; ws[3].endMs = ws[3].srcEndMs = 1650; // a pause before the figure
  assert.deepEqual(paged(ws, 'vibem'), paged(ws, 'vibem', []));
  assert.deepEqual(paged(ws, 'vibem'), ['Esto es Arboleda', '45', 'con alberca']);
});

test('re-paging with the glossary joins the term and keeps tiers, hand pages and deleted words', () => {
  const clips = [{id: 'a', src: 'clips/a.mp4', inSec: 0, outSec: 20, sourceDurationSec: 20}];
  const ws = said('Aquí tienes el Pet Park, la alberca y el gym.');
  const job = (g) => pageWords(applyGlossary(structuredClone(ws), g).words, PRESETS.vibem, g); // the captions job, with the kit's glossary or none
  const shown = (cs) => cs.map((c) => c.words.map((w) => `${w.tier ? '*' : ''}${w.text}`).join(' '));
  let {captions} = repage([], job([]), clips);
  assert.deepEqual(shown(captions), ['Aquí tienes el Pet', 'Park, la alberca', 'y el gym']);
  captions = captions.map((c) => ({...c, words: c.words.map((w) => (w.text === 'Park,' ? {...w, tier: 1} : w))})); // annotate_captions
  const hand = {id: 'h0', src: 'clips/a.mp4', words: [{text: 'Fin', startMs: 15000, endMs: 15500}], startMs: 15000, endMs: 15500, topPct: 53}; // typed by hand
  const r = repage([...captions, hand], job(GL), clips, {hidden: ['a:9'], replace: true}); // 'gym.' deleted
  assert.deepEqual(shown([...r.captions].sort((a, b) => a.startMs - b.startMs)), ['Aquí tienes', 'el Pet *Park, la alberca', 'y el', 'Fin']);
  // the judge has nothing to say about the term; a hand edit that splits it again gets the page-break fix
  const pages = r.captions.filter((c) => c.words.some((w) => w.wid)).sort((a, b) => a.startMs - b.startMs).map((c) => ({...c, clipId: 'a'}));
  assert.deepEqual(splitNameFindings(pages, GL, 'vibem', undefined, true), []);
  const split = [{...pages[0], words: [...pages[0].words, ...pages[1].words.slice(0, 2)]}, {...pages[1], words: pages[1].words.slice(2)}]; // 'Aquí tienes el Pet' | 'Park, la alberca'
  const [f] = splitNameFindings(split, GL, 'vibem', undefined, true);
  assert.deepEqual(f.fix.map((x) => [x.tool, x.args]), [['edit_caption', {caption_id: pages[1].id, starts_at_wid: 'a:3'}]]);
  assert.match(f.fix[0].note, /hand edit/);
  assert.deepEqual(splitNameFindings(split, GL, 'bonded')[0].fix.map((x) => x.tool), ['edit_caption']); // a term: no name to highlight first
  const both = [{...pages[1], id: 'x0', words: [pages[1].words[1]]}, {...pages[1], id: 'x1', words: [pages[1].words[2]]}]; // 'Pet' | 'Park,'
  assert.deepEqual(splitNameFindings(both, GL, 'vibem', undefined, true)[0].fix.map((x) => [x.tool, x.args]), [['set_caption_style', {style: 'vibem'}]]);
});
