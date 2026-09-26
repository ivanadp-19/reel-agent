import {test} from 'node:test';
import assert from 'node:assert/strict';
import {heuristicClassify, refineSpans, yellowWords, sentenceIds, fold, FUNCTION_WORDS, MAX_PER_SENTENCE} from '../src/highlights.ts';
import {presetOf} from '../src/captionPresets.ts';
import {pageWords, projectTiers, reapplyTiers, repage} from '../src/paging.ts';

// transcript words as assembleWords emits them: one sentence per string, 300 ms a word
const M = (...sentences) => {
  const out = [];
  let t = 0;
  for (const s of sentences) for (const word of s.split(/\s+/)) { out.push({wid: `v:${out.length}`, word, startMs: t, endMs: t + 250}); t += 300; }
  return out;
};
const yellow = (words, spans) => words.filter((_, i) => spans.some((s) => s.start <= i && i <= s.end)).map((w) => fold(w));

// César's G2_H1_C1: the auto pass had "preventa" and "completo" yellow; his reference leaves them white
const PITCH = M('Montealbán 326, 54 departamentos en preventa al norte de Mérida.', 'Preventa con precio de lanzamiento.', 'Escríbeme y te enseño el proyecto completo.', 'Completo, con todo lo que necesitas.');

test('"preventa" and "completo" stay tier 0 (heuristic)', () => {
  const hl = yellow(PITCH, heuristicClassify(PITCH));
  assert.ok(!hl.includes('preventa'), hl.join(' '));
  assert.ok(!hl.includes('completo'), hl.join(' '));
  assert.ok(!hl.includes('proyecto') && !hl.includes('departamentos'), hl.join(' '));
  // the figures, the name and the CTA still are; "Mérida" is the third candidate of its sentence → white
  assert.ok(!hl.includes('merida'), hl.join(' '));
  for (const w of ['montealban', '326', '54', 'escribeme']) assert.ok(hl.includes(w), `${w} missing: ${hl.join(' ')}`);
});

test('meaning words ("mudar", "necesidades") get tier 1', () => {
  const ws = M('Si te quieres mudar este año, esto es para ti.', 'Cada espacio está pensado para tus necesidades.', 'Es una inversión con plusvalía.');
  const hl = yellow(ws, heuristicClassify(ws));
  assert.ok(hl.includes('mudar'), hl.join(' '));
  assert.ok(hl.includes('necesidades'), hl.join(' '));
  assert.ok(!hl.includes('espacio'), hl.join(' '));
});

test('at most MAX_PER_SENTENCE (2) highlights a sentence', () => {
  assert.equal(MAX_PER_SENTENCE, 2);
  const ws = M('Montealbán 326 tiene 54 departamentos, 90 metros y 3 niveles en Mérida para mudar tus necesidades.', 'Hola a todos.');
  const spans = heuristicClassify(ws);
  const sid = sentenceIds(ws);
  const per = new Map();
  for (const s of spans) per.set(sid[s.start], (per.get(sid[s.start]) ?? 0) + 1);
  for (const n of per.values()) assert.ok(n <= 2, `${n} spans in one sentence`);
  assert.equal(per.get(0), 2);
  assert.equal(per.get(1), undefined); // nothing worth yellow → all white
});

test('function words are never highlighted on their own or at a span edge', () => {
  const ws = M('El proyecto de la zona es para ti y tu familia.', 'Llena el formulario.', 'Esto es lo que hay en la Ciudad de México.');
  const spans = heuristicClassify(ws);
  for (const s of spans) {
    assert.ok(!FUNCTION_WORDS.has(fold(ws[s.start])), `starts on ${ws[s.start].word}`);
    assert.ok(!FUNCTION_WORDS.has(fold(ws[s.end])), `ends on ${ws[s.end].word}`);
  }
  // a sentence-initial capital is not a name: "El", "Esto" stay white
  const hl = yellow(ws, spans);
  assert.ok(!hl.includes('esto'));
  assert.deepEqual(hl.filter((w) => FUNCTION_WORDS.has(w)), ['el', 'de']); // only inside "Llena el formulario" and "Ciudad de México"
});

test('a CTA takes its object, not a name after it or a promotional word', () => {
  const ws = M('Ven a la Ciudad de México.', 'Aprovecha la preventa.', 'Llena el formulario.');
  assert.deepEqual(yellow(ws, heuristicClassify(ws)), ['ven', 'ciudad', 'de', 'mexico', 'aprovecha', 'llena', 'el', 'formulario']);
  // the usted form after 'que' is a subjunctive, not a CTA
  const sub = M('Queremos que conozca los 54 departamentos en Mérida.');
  assert.deepEqual(yellow(sub, heuristicClassify(sub)), ['54', 'merida']);
});

test('refineSpans: promo edges trimmed, promo-only spans dropped, capped per sentence', () => {
  const ws = M('Montealbán 326, 54 departamentos en preventa al norte de Mérida.', 'Aprovecha la preventa.', 'Te enseño el proyecto completo.');
  const i = (w) => ws.findIndex((x) => fold(x) === w);
  const last = (w) => ws.findLastIndex((x) => fold(x) === w);
  const spans = refineSpans(ws, [
    {start: i('montealban'), end: i('326'), kind: 'keyword'},
    {start: i('54'), end: i('preventa'), kind: 'keyword'},     // "54 departamentos en preventa" → "54"
    {start: i('merida'), end: i('merida'), kind: 'keyword'},    // third span in the sentence → dropped
    {start: i('aprovecha'), end: last('preventa'), kind: 'cta'},  // "aprovecha la preventa" → "aprovecha"
    {start: i('proyecto'), end: i('completo'), kind: 'keyword'}, // generic + promo → nothing
  ]);
  const hl = yellow(ws, spans);
  assert.ok(hl.includes('54') && hl.includes('326'));
  assert.ok(!hl.includes('departamentos') && !hl.includes('preventa') && !hl.includes('completo') && !hl.includes('proyecto'), hl.join(' '));
  assert.ok(!hl.includes('merida'), 'a third span in one sentence is dropped');
  assert.ok(hl.includes('aprovecha'));
});

test('refineSpans keeps CTAs before keywords when capping', () => {
  const one = M('Montealbán 326 en Mérida, escríbeme hoy.');
  const spans = refineSpans(one, [{start: 0, end: 1, kind: 'keyword'}, {start: 3, end: 3, kind: 'keyword'}, {start: 4, end: 5, kind: 'cta'}]);
  assert.deepEqual(spans.map((s) => s.kind), ['keyword', 'cta']);
});

test('a pause of 0.7 s ends a sentence when the ASR gave no punctuation', () => {
  const ws = [{word: 'mudar', startMs: 0, endMs: 200}, {word: 'hoy', startMs: 300, endMs: 500}, {word: 'Mérida', startMs: 1300, endMs: 1600}];
  assert.deepEqual(sentenceIds(ws), [0, 0, 1]);
});

// César's v11 pattern (the vibem pack's rules): every figure and date, place and name, amenity and
// property noun, 'cerca' and the CTA — not 1–2 a sentence. Other packs keep the selective default.
const V11_PITCH = M('Desde la terraza ves todo lo que tienes cerca.', 'A diez minutos de Playa del Carmen, Puerto Aventuras y Tulum.', 'Aquí tienes el hospital, la escuela y el súper.', '32 departamentos que se entregan en marzo 2026.', 'Llene el formulario y te llamo.');

test('the vibem proposer marks places, names, amenities, property nouns, figures, dates and the CTA', () => {
  const hl = yellow(V11_PITCH, heuristicClassify(V11_PITCH, presetOf('vibem').highlight));
  assert.deepEqual(hl, ['terraza', 'cerca', 'diez', 'minutos', 'playa', 'del', 'carmen', 'puerto', 'aventuras', 'tulum', 'hospital', 'escuela', 'super', '32', 'departamentos', 'marzo', '2026', 'llene', 'el', 'formulario']);
  // the default rules (any other pack) stay selective: 2 a sentence, 'departamentos' white, no amenity list
  const plain = yellow(V11_PITCH, heuristicClassify(V11_PITCH, presetOf('caja').highlight));
  for (const w of ['terraza', 'tulum', 'hospital', 'departamentos']) assert.ok(!plain.includes(w), `${w}: ${plain.join(' ')}`);
  for (const w of ['diez', 'playa', '32', 'marzo', '2026', 'llene']) assert.ok(plain.includes(w), `${w} missing: ${plain.join(' ')}`);
  // a month alone is speech, not a date
  const month = M('Nos vemos en marzo.');
  assert.deepEqual(yellow(month, heuristicClassify(month, presetOf('vibem').highlight)), []);
  // a figure a guion spelled out is one span ('cincuenta y cuatro'), whatever the pack
  const spelled = M('Son cincuenta y cuatro departamentos.');
  assert.deepEqual(yellow(spelled, heuristicClassify(spelled)), ['cincuenta', 'y', 'cuatro']);
  // a sentence's first word is not a name, and does not take the figure after it: the figure keeps its unit
  const lead = M('Tenemos 54 departamentos.', 'Solo 5 minutos de Altabrisa.');
  assert.deepEqual(yellow(lead, heuristicClassify(lead, presetOf('vibem').highlight)), ['54', 'departamentos', '5', 'minutos', 'altabrisa']);
});

test('project tiers are authoritative: applied exactly, never re-derived; the proposer only fills words the project does not show', () => {
  const rules = presetOf('vibem').highlight;
  const ws = M('Llena el formulario hoy.', 'Son 54 departamentos.');
  // the project shows the first sentence: the agent set 'formulario' white and 'hoy' yellow
  const shown = (tiers) => [{words: [...tiers.map((tier, i) => ({wid: `v:${i}`, text: ['LLENA', 'el', 'formulario', 'HOY'][i], tier})), {text: 'hand', tier: 2}]}];
  const tiers = projectTiers(shown([1, 0, undefined, 1]));
  assert.deepEqual(tiers, {'v:0 llena': 1, 'v:1 el': 0, 'v:2 formulario': 0, 'v:3 hoy': 1}); // by id and word, case and punctuation aside
  assert.equal(yellowWords(ws, tiers, rules), 2); // only the sentence it does not show: 54, departamentos
  assert.deepEqual(ws.map((w) => w.tier ?? 0), [1, 0, 0, 1, 0, 1, 1]);
  // every word in the project: nothing is proposed, the proposer's picks stay white
  const all = M('Llena el formulario hoy.');
  assert.equal(yellowWords(all, projectTiers(shown([0, 0, 0, 0])), rules), 0);
  assert.deepEqual(all.map((w) => w.tier), [0, 0, 0, 0]);
  // re-paging carries them exactly too (MCP set_caption_style, the editor, the CLI): a fresh page's 1 goes back to the project's 0
  const page = (tier, text = 'formulario') => [{id: 'c0', src: 's', startMs: 0, endMs: 300, topPct: 53, words: [{wid: 'v:2', text, startMs: 0, endMs: 300, tier}]}];
  assert.equal(reapplyTiers(page(0), page(1))[0].words[0].tier, 0);
  // a new transcript renumbers the source (Deepgram after WhisperX): an id that now names another
  // word is new to the project, it neither takes nor gives the old word's tier
  const moved = M('Son 54 departamentos.'); // v:0 'Son' where the project had v:0 'LLENA' yellow
  assert.equal(yellowWords(moved, tiers, rules), 2);
  assert.deepEqual(moved.map((w) => w.tier ?? 0), [0, 1, 1]);
  assert.equal(reapplyTiers(page(1), page(0, 'Son'))[0].words[0].tier, 0);
});

test('re-paging (src/paging.ts repage): a source transcribed again moves the project to its new ids; a new pack re-proposes only the proposed tiers', () => {
  const vibem = presetOf('vibem'), clips = [{id: 'a', src: 'clips/a.mp4', inSec: 0, outSec: 10, sourceDurationSec: 10}];
  const tl = (ws) => ws.map(([word, was], i) => ({wid: `a:${i}`, word, src: 'clips/a.mp4', clipId: 'a', startMs: i * 300, endMs: i * 300 + 250, srcStartMs: i * 300, srcEndMs: i * 300 + 250, ...(was != null ? {was: `a:${was}`} : {})}));
  const job = (words, tiers, style = vibem) => { yellowWords(words, tiers, style.highlight); return pageWords(words, style); }; // what the captions job does
  const shown = (caps) => caps.flatMap((c) => c.words).map((w) => `${w.wid} ${w.text}${w.tier ? '*' : ''}`);
  // the approved reel on WhisperX's ids: the agent set 'Alta' white by hand and deleted 'entre otros'
  let {captions} = repage([], job(tl([['Son'], ['54'], ['departamentos'], ['en'], ['Alta'], ['Brisa,'], ['entre'], ['otros.']]), {}), clips);
  captions = captions.map((c) => ({...c, words: c.words.filter((w) => !['entre', 'otros'].includes(w.text)).map(({proposed, ...w}) => (w.text === 'Alta' ? {...w, tier: 0} : {...w, proposed}))})).filter((c) => c.words.length);
  const hidden = ['a:6', 'a:7'];
  assert.deepEqual(shown(captions), ['a:0 Son', 'a:1 54*', 'a:2 departamentos*', 'a:3 en', 'a:4 Alta', 'a:5 Brisa*']);
  // Deepgram hears one more word first: every id shifts by one, each word names its old id (`was`)
  const dg = () => tl([['Bueno,'], ['Son', 0], ['54', 1], ['departamentos', 2], ['en', 3], ['Alta', 4], ['Brisa,', 5], ['entre', 6], ['otros.', 7]]);
  const r = repage(captions, job(dg(), projectTiers(captions)), clips, {hidden, replace: true});
  assert.deepEqual(r.hidden, ['a:7', 'a:8']); // the deleted words stay deleted
  assert.deepEqual(shown(r.captions).slice(1), ['a:1 Son', 'a:2 54*', 'a:3 departamentos*', 'a:4 en', 'a:5 Alta', 'a:6 Brisa*']); // 'Alta' still white
  // another pack: the words the old one only proposed take the new one's proposal (caja: 'departamentos' white),
  // what the agent set stays ('Alta' white, though caja marks names)
  const caja = presetOf('caja');
  const c = repage(r.captions, job(dg(), projectTiers(r.captions, true), caja), clips, {hidden: r.hidden, replace: true, repropose: true});
  assert.deepEqual(shown(c.captions).slice(1), ['a:1 Son', 'a:2 54*', 'a:3 departamentos', 'a:4 en', 'a:5 Alta', 'a:6 Brisa*']);
});
