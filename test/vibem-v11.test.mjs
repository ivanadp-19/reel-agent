// César's pack is the v11 reel he approved (src/captionPresets.ts): the values the render
// comparison measured, the old id as an alias, and the layout rules that come with them.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PRESETS} from '../src/captionPresets.ts';
import {fitPage, realAdvances} from '../src/captionLayout.ts';
import {pageWords} from '../src/paging.ts';
import {fontFiles, validateProject} from '../src/validate.ts';
import {applyGlossary} from '../src/guion.ts';

const vibem = PRESETS.vibem;

test('vibem is v11: words in place, yellow at 1.15×, ~550 ms hold, no cascade, no bonds, 53 % top, 934 px wrap', () => {
  assert.equal(vibem.upcoming, 'hidden');
  assert.deepEqual([vibem.tiers[1].scale, vibem.tiers[2].scale], [1.15, 1.15]);
  assert.equal(vibem.holdMs, 550);
  assert.ok(!('fastBuildMs' in vibem));
  assert.ok(!vibem.layout.unbreakable);
  assert.equal(vibem.layout.topPct, 53);
  assert.equal(fitPage({words: [{text: 'vas'}]}, vibem).wrapPx, 934);
});

test('vibemReference is the same pack under its old id', () => {
  const {id, label, ...rest} = PRESETS.vibemReference;
  const {id: id0, label: label0, ...want} = vibem;
  assert.equal(id, 'vibemReference');
  assert.deepEqual(rest, want);
});

test('fitPage: a vibem word that still fits the frame keeps its size; a pack without overflowPad shrinks it inside the padding', () => {
  const page = {words: [{text: '54', tier: 1}, {text: 'departamentos', tier: 1, br: true}]}; // v11 P25: DEPARTAMENTOS at 93 % of the width, full size
  const fit = fitPage(page, vibem);
  assert.equal(fit.fontSize, 100);
  assert.ok(fit.widestPx > fit.wrapPx && !fit.overflows);
  const padded = {...vibem, layout: {...vibem.layout, overflowPad: false}};
  assert.ok(fitPage(page, padded).fontSize < 100);
  assert.ok(fitPage({words: [{text: 'departamentalizaciones', tier: 1}]}, vibem).fontSize < 100); // wider than the frame: shrinks
  // with the pack's font file read (src/projectFont.ts), the page is sized by its real widths plus the tracking:
  // 'DEPARTAMENTOS,' at 0.68 em a letter, ×1.15, −2 px × 14 = 1067 px fits the 1080 px frame; the Inter table says 1111
  const face = {...vibem, font: {...vibem.font, custom: {...vibem.font.custom, family: 'TestFace'}}};
  const comma = {words: [{text: '54', tier: 1}, {text: 'departamentos,', tier: 1}, {text: 'con'}]};
  assert.ok(fitPage(comma, face).fontSize < 100);
  realAdvances('TestFace', (t) => 0.68 * [...t].length);
  assert.equal(fitPage(comma, face).fontSize, 100);
});

test('the pager pins vibem pages at 53 % whatever face detection found; other packs follow the face', () => {
  const w = (word, i) => ({wid: `a:${i}`, word, src: 'clips/a.mp4', clipId: 'a', startMs: i * 300, endMs: i * 300 + 250, srcStartMs: i * 300, srcEndMs: i * 300 + 250});
  const words = ['Desde', 'el', 'rooftop.'].map(w);
  assert.equal(pageWords(words, vibem, {'clips/a.mp4': 64})[0].topPct, 53);
  assert.equal(pageWords(words, PRESETS.caja, {'clips/a.mp4': 64})[0].topPct, 64);
});

test('validate: a font file the pack or the brand kit loads and public/ lacks is an error', () => {
  const cap = {id: 'c0', src: 'clips/a.mp4', words: [{text: 'hola', startMs: 0, endMs: 400}], startMs: 0, endMs: 400, topPct: 53};
  const p = {clips: [{id: 'a', src: 'clips/a.mp4', inSec: 0, outSec: 2, sourceDurationSec: 2}], captions: [cap], captionStyle: 'vibem', brand: {fonts: {files: [{file: 'fonts/Kit.otf'}]}}};
  assert.deepEqual(fontFiles(p), ['fonts/Helvetica-Bold.ttf', 'fonts/Kit.otf']);
  const missing = (fonts, q = p) => validateProject(q, 30, {}, fonts).filter((i) => i.code === 'font-missing').map((i) => i.level);
  assert.deepEqual(missing({'fonts/Helvetica-Bold.ttf': false, 'fonts/Kit.otf': true}), ['error']);
  assert.deepEqual(missing({'fonts/Helvetica-Bold.ttf': true, 'fonts/Kit.otf': true}), []);
  assert.deepEqual(missing({'fonts/Helvetica-Bold.ttf': false}, {...p, captionsOff: true, brand: null}), []); // no captions on screen: the pack's font is not loaded
  // another face under the pack's file name (an Arial saved as Helvetica-Bold.ttf) is an error too
  const wrong = (name) => validateProject(p, 30, {}, {'fonts/Helvetica-Bold.ttf': name, 'fonts/Kit.otf': 'Anything'}).filter((i) => i.code === 'font-wrong').map((i) => i.level);
  assert.deepEqual([wrong('Arial Bold'), wrong('Helvetica Bold')], [['error'], []]);
});

// ---- pages and display text (v11 G1: 'FARO DEL / MAYAB, ALTA' | 'ESPECIALIDAD, / STAR MÉDICA' | … | 'ESTO ES / MONTEALBÁN' | '326') ----
const tw = (words, tiers = {}) => words.map((word, i) => ({wid: `a:${i}`, word, src: 'clips/a.mp4', clipId: 'a', startMs: i * 300, endMs: i * 300 + 250, srcStartMs: i * 300, srcEndMs: i * 300 + 250, tier: tiers[i] ?? 0}));
const texts = (pages) => pages.map((p) => p.words.map((w) => w.text).join(' '));

test('vibem: a comma stays on screen mid-page and breaks nothing; a page-final comma and every period go; other packs unchanged', () => {
  const words = tw(['Faro', 'del', 'Mayab,', 'Alta', 'Especialidad,', 'Star', 'Médica,', 'entre', 'otros.']);
  assert.deepEqual(texts(pageWords(words, vibem)), ['Faro del Mayab, Alta', 'Especialidad, Star Médica', 'entre otros']);
  assert.deepEqual(texts(pageWords(words, PRESETS.caja)), ['Faro del Mayab', 'Alta Especialidad', 'Star Médica', 'entre otros']);
});

test('vibem: a highlighted figure is its own page, a plain one still merges; "desde" may end a page', () => {
  const said = ['Esto', 'es', 'Montealbán', '326.'];
  assert.deepEqual(texts(pageWords(tw(said, {2: 1, 3: 1}), vibem)), ['Esto es Montealbán', '326']);
  assert.deepEqual(texts(pageWords(tw(said), vibem)), ['Esto es Montealbán 326']);
  // a yellow figure with a comma after it ends its page; a plain one runs on
  const list = ['Esto', 'es', 'Montealbán', '326,', '54', 'departamentos.'];
  assert.deepEqual(texts(pageWords(tw(list, {2: 1, 3: 1, 4: 1, 5: 1}), vibem)), ['Esto es Montealbán', '326', '54 departamentos']);
  assert.deepEqual(texts(pageWords(tw(list), vibem)), ['Esto es Montealbán', '326, 54 departamentos']);
  assert.deepEqual(texts(pageWords(tw(['a', 'poder', 'ver', 'desde', 'tu', 'departamento.']), vibem)), ['a poder ver desde', 'tu departamento']);
  // only vibem (layout.glueExcept): other packs still carry a dangling 'desde' onto the next page
  const mar = tw('Puedes ver el mar desde tu nuevo departamento en Mérida.'.split(' '));
  assert.deepEqual(texts(pageWords(mar, PRESETS.caja)), ['Puedes ver el mar', 'desde tu nuevo departamento', 'en Mérida']);
});

test('glossary: variants take the term, a longer variant joins into it (first id, whole span), never across a clip', () => {
  const glossary = [{term: 'Altabrisa', variants: ['Alta Brisa']}, {term: 'Star Médica', variants: ['Esther Médica']}, {term: 'súper', variants: ['super']}];
  const words = tw(['Plaza', 'Alta', 'Brisa,', 'Esther', 'Médica,', 'Super,', 'el', 'banco']);
  const {words: out, fixed} = applyGlossary(words, glossary);
  assert.equal(out.map((w) => w.word).join(' '), 'Plaza Altabrisa, Star Médica, Súper, el banco');
  const alta = out[1];
  assert.deepEqual([alta.wid, alta.startMs, alta.endMs, alta.srcEndMs, alta.asr], ['a:1', 300, 850, 850, 'Alta Brisa,']);
  assert.equal(out[3], words[4]); // 'Médica,' already spelled so: the same word, no asr
  assert.deepEqual(fixed.map((f) => f.text), ['Altabrisa,', 'Star Médica,', 'Súper,']);
  const split = tw(['Alta', 'Brisa']).map((w, i) => ({...w, clipId: `k${i}`}));
  assert.equal(applyGlossary(split, glossary).words.map((w) => w.word).join(' '), 'Alta Brisa');
});

// The golden check's Layer A (scripts/golden.mjs) on a synthetic mini-golden: pinned words and the
// pack through the real pager → ranges, text, yellow words, lines; a wrong expectation is a FAIL row
test('golden Layer A: the pager on pinned words matches its expected pages, and says where it does not', async () => {
  const {layerA} = await import('../scripts/golden.mjs');
  const said = 'Hola, soy Ana. Tenemos 54 departamentos. Llama hoy.'.split(' ');
  const words = said.map((text, i) => ({wid: `s:${i}`, text, startMs: 200 + 300 * i, endMs: 450 + 300 * i, tier: /^(54|departamentos\.)$/.test(text) ? 1 : 0}));
  const pages = [
    {wids: ['s:0', 's:2'], text: 'HOLA, SOY ANA', lines: ['HOLA, SOY ANA'], yellow: []},
    {wids: ['s:3', 's:5'], text: 'TENEMOS 54 DEPARTAMENTOS', lines: ['TENEMOS 54', 'DEPARTAMENTOS'], yellow: ['s:4', 's:5']},
    {wids: ['s:6', 's:7'], text: 'LLAMA HOY', lines: ['LLAMA HOY'], yellow: []},
  ];
  const exp = {pack: 'vibem', source: 'clips/s.mp4', pages};
  const rows = layerA(words, exp); // no font file: lines from the width estimate
  assert.ok(rows.every((r) => r.ok), JSON.stringify(rows.filter((r) => !r.ok)));
  assert.deepEqual([...new Set(rows.map((r) => r.check))], ['pages', 'range', 'text', 'yellow', 'lines~']);
  const fails = (e) => layerA(words, {...exp, pages: e}).filter((r) => !r.ok).map((r) => `${r.page} ${r.check}: ${r.got}`);
  assert.deepEqual(fails([pages[0], {...pages[1], yellow: ['s:5']}, {...pages[2], lines: ['LLAMA', 'HOY']}]), ['P2 yellow: s:4 s:5', 'P3 lines~: LLAMA HOY']);
  assert.deepEqual(fails([{...pages[0], wids: ['s:0', 's:1']}, ...pages.slice(1)]), ['P1 range: HOLA, SOY ANA'], 'a page break elsewhere names what was paged');
});
