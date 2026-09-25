import {test} from 'node:test';
import assert from 'node:assert/strict';
import {heuristicClassify, refineSpans, guardHighlights, applyHighlights, sentenceIds, fold, FUNCTION_WORDS, MAX_PER_SENTENCE, CLASSIFY_PROMPT} from '../src/highlights.ts';

// transcript words as assembleWords emits them: one sentence per string, 300 ms a word
const M = (...sentences) => {
  const out = [];
  let t = 0;
  for (const s of sentences) for (const word of s.split(/\s+/)) { out.push({wid: `v:${out.length}`, word, startMs: t, endMs: t + 250}); t += 300; }
  return out;
};
const tiered = (words, spans) => { const ws = words.map((w) => ({...w})); applyHighlights(ws, {spans}); return ws; };
const yellow = (words, spans) => tiered(words, spans).filter((w) => w.tier === 1).map((w) => fold(w));

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
});

test('LLM spans pass the same gate: promo edges trimmed, promo-only spans dropped, capped per sentence', () => {
  const ws = M('Montealbán 326, 54 departamentos en preventa al norte de Mérida.', 'Aprovecha la preventa.', 'Te enseño el proyecto completo.');
  const i = (w) => ws.findIndex((x) => fold(x) === w);
  const last = (w) => ws.findLastIndex((x) => fold(x) === w);
  // what an over-eager model answers (mocked — no API in tests)
  const llm = {spans: [
    {start: i('montealban'), end: i('326'), kind: 'keyword'},
    {start: i('54'), end: i('preventa'), kind: 'keyword'},     // "54 departamentos en preventa" → "54"
    {start: i('merida'), end: i('merida'), kind: 'keyword'},    // third span in the sentence → dropped
    {start: i('aprovecha'), end: last('preventa'), kind: 'cta'},  // "aprovecha la preventa" → "aprovecha"
    {start: i('proyecto'), end: i('completo'), kind: 'keyword'}, // generic + promo → nothing
    {start: 'x', end: 2, kind: 'keyword'},                       // garbage ignored
  ], fixes: [{index: 0, text: 'Montealbán'}]};
  const res = guardHighlights(ws, llm);
  assert.deepEqual(res.fixes, llm.fixes);
  const hl = yellow(ws, res.spans);
  assert.ok(hl.includes('54') && hl.includes('326'));
  assert.ok(!hl.includes('departamentos') && !hl.includes('preventa') && !hl.includes('completo') && !hl.includes('proyecto'), hl.join(' '));
  assert.ok(!hl.includes('merida'), 'a third span in one sentence is dropped');
  assert.ok(hl.includes('aprovecha'));
});

test('refineSpans keeps questions whole and CTAs before keywords when capping', () => {
  const ws = M('¿Te quieres mudar a Mérida en 2026? Escríbeme hoy.');
  const q = {start: 0, end: 6, kind: 'question'};
  assert.deepEqual(refineSpans(ws, [q]), [q]);
  const one = M('Montealbán 326 en Mérida, escríbeme hoy.');
  const spans = refineSpans(one, [{start: 0, end: 1, kind: 'keyword'}, {start: 3, end: 3, kind: 'keyword'}, {start: 4, end: 5, kind: 'cta'}]);
  assert.deepEqual(spans.map((s) => s.kind), ['keyword', 'cta']);
});

test('a pause of 0.7 s ends a sentence when the ASR gave no punctuation', () => {
  const ws = [{word: 'mudar', startMs: 0, endMs: 200}, {word: 'hoy', startMs: 300, endMs: 500}, {word: 'Mérida', startMs: 1300, endMs: 1600}];
  assert.deepEqual(sentenceIds(ws), [0, 0, 1]);
});

test('the prompt names the counter-examples and the cap', () => {
  for (const s of ['preventa', 'completo', 'mudar', 'necesidades', '1–2 spans per sentence']) assert.ok(CLASSIFY_PROMPT.includes(s), s);
});
