import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reconcileWords, guionIssues, tokenizeGuion, normKey, numberOf, align, joinFigures} from '../src/guion.ts';
import {validateProject} from '../src/validate.ts';
import {pageWords} from '../src/paging.ts';
import {presetOf} from '../src/captionPresets.ts';
import {verdictOf, captionTextFindings} from '../.agents/skills/render-judge/judge.mjs';

// transcript words as assembleWords emits them (one clip, source = timeline)
const W = (rows, clipId = 'k1') => rows.map(([word, s, e], i) => ({wid: `v:${i}`, word, src: 'clips/v.mp4', clipId, startMs: s, endMs: e, srcStartMs: s, srcEndMs: e}));
const texts = (ws) => ws.map((w) => w.word).join(' ');
const clip = {id: 'k1', src: 'clips/v.mp4', inSec: 0, outSec: 60, sourceDurationSec: 60};
const projectOf = (words, guion) => ({clips: [clip], captions: pageWords(words, presetOf('palabra')), graphics: [], captionStyle: 'palabra', guion});
const guionCodes = (issues) => issues.filter((i) => i.code.startsWith('guion-')).map((i) => i.code);

// the confirmed case: Whisper heard "acomodan" 37632–38053 ms, the reference has "acomoda" 37632–37963 + "a" 37963–38053
const ACOMODAN = W([['Aquí', 37000, 37300], ['se', 37320, 37600], ['acomodan', 37632, 38053], ['los', 38060, 38200], ['invitados.', 38620, 39100]]);

test('a merged ASR word is split into the guion tokens inside its own span', () => {
  const {words, report} = reconcileWords(ACOMODAN, 'Aquí se acomoda a los invitados.');
  assert.equal(texts(words), 'Aquí se acomoda a los invitados.');
  const [acomoda, a] = words.slice(2, 4);
  assert.equal(acomoda.startMs, 37632); // the span's start and end are kept …
  assert.equal(a.endMs, 38053);
  assert.equal(acomoda.endMs, a.startMs); // … and the pieces tile it, proportional to their length
  assert.ok(acomoda.endMs > 37900 && acomoda.endMs < 38053, `cut at ${acomoda.endMs}`);
  assert.deepEqual([acomoda.srcStartMs, acomoda.srcEndMs, a.srcStartMs, a.srcEndMs], [acomoda.startMs, acomoda.endMs, a.startMs, a.endMs]);
  assert.equal(acomoda.wid, 'v:2'); // pieces keep the transcript word's id (cut_words, tiers)
  assert.equal(a.wid, 'v:2');
  assert.equal(acomoda.asr, 'acomodan');
  assert.deepEqual(report.adopted, [{wid: 'v:2', asr: 'acomodan', text: 'acomoda a', how: 'split'}]);
  // the reconciled words validate clean against the guion
  assert.deepEqual(guionCodes(validateProject(projectOf(words, 'Aquí se acomoda a los invitados.'))), []);
});

test('the guion wording is adopted with the ASR timing: accents, ñ, a near-miss, number style, a split word', () => {
  const words = W([['El', 0, 100], ['salon', 100, 500], ['tiene', 520, 800], ['setenta', 820, 1200], ['metros,', 1220, 1600], ['cada', 1700, 1900], ['ano', 1920, 2200], ['mas', 2220, 2400], ['invitado', 2420, 2900], ['con', 3000, 3100], ['sky', 3120, 3300], ['pool.', 3320, 3700]]);
  const {words: out, report} = reconcileWords(words, 'El salón tiene 70 metros, cada año más invitados con skypool.');
  assert.equal(texts(out), 'El salón tiene 70 metros, cada año más invitados con skypool.');
  const by = Object.fromEntries(out.map((w) => [w.wid, w]));
  assert.deepEqual([by['v:1'].startMs, by['v:1'].endMs, by['v:1'].asr], [100, 500, 'salon']);
  assert.equal(by['v:3'].word, '70'); // same number, the guion's style
  assert.deepEqual([by['v:10'].word, by['v:10'].startMs, by['v:10'].endMs, by['v:10'].asr], ['skypool.', 3120, 3700, 'sky pool.']);
  assert.equal(by['v:11'], undefined); // joined into v:10
  assert.equal(by['v:4'].word, 'metros,'); // untouched words stay as they were (no asr mark)
  assert.equal(by['v:4'].asr, undefined);
  assert.deepEqual(report.adopted.map((a) => a.how).sort(), ['join', 'spelling', 'spelling', 'spelling', 'spelling', 'spelling']);
});

test('70 vs 60: a content conflict keeps the audio on screen and is flagged, never resolved', () => {
  const words = W([['Caben', 0, 300], ['70', 320, 700], ['invitados', 720, 1200], ['en', 1220, 1300], ['el', 1320, 1400], ['salón.', 1420, 1900]]);
  const guion = 'Caben 60 invitados en el salón.';
  const {words: out, report} = reconcileWords(words, guion);
  assert.equal(out[1].word, '70');
  assert.equal(out[1].asr, undefined);
  assert.deepEqual(report.conflicts, [{wid: 'v:1', asr: '70', guion: '60', what: 'number'}]);
  // number words compare by value too: "setenta" is not "sesenta", however close the spelling
  assert.equal(reconcileWords(W([['Caben', 0, 300], ['setenta', 320, 700], ['invitados', 720, 1200]]), 'Caben sesenta invitados').words[1].word, 'setenta');
  // the render keeps the audio (the pages say 70), validate warns for a human
  const p = projectOf(out, guion);
  assert.ok(p.captions.some((c) => c.words.some((w) => w.text === '70')));
  const issues = validateProject(p);
  const conflict = issues.find((i) => i.code === 'guion-conflict');
  assert.equal(conflict?.level, 'warn');
  assert.match(conflict.msg, /"70".*"60"/);
  assert.ok(!issues.some((i) => i.level === 'error'));
  // the judge passes it to the client as advisory: it never fails the reel
  const f = {check: 'validate-guion-conflict', severity: 'major', kind: 'rule'};
  assert.equal(verdictOf([f]).verdict, 'PASS');
});

test('a named entity the audio says differently is a conflict too', () => {
  const words = W([['Estamos', 0, 300], ['en', 320, 400], ['Tulum,', 420, 800], ['frente', 820, 1100], ['al', 1120, 1200], ['mar.', 1220, 1600]]);
  const {words: out, report} = reconcileWords(words, 'Estamos en Cancún, frente al mar.');
  assert.equal(out[2].word, 'Tulum,');
  assert.deepEqual(report.conflicts.map((c) => [c.asr, c.guion, c.what]), [['Tulum,', 'Cancún', 'entity']]);
});

test('an ambiguous alignment is left as heard and reported', () => {
  // other wording, no name or figure: not a conflict, not a fix — leave it
  const words = W([['La', 0, 100], ['cocina', 120, 500], ['es', 520, 600], ['bonita', 620, 1000], ['y', 1020, 1100], ['luminosa.', 1120, 1600]]);
  const guion = 'La cocina es amplia y luminosa.';
  const {words: out, report} = reconcileWords(words, guion);
  assert.equal(texts(out), texts(words));
  assert.deepEqual(report.ambiguous, [{wid: 'v:3', asr: 'bonita', guion: 'amplia'}]);
  assert.deepEqual(guionCodes(validateProject(projectOf(out, guion))), ['guion-altered']);
  // a near-miss with no exact match beside it has no anchor: left, reported
  const lone = reconcileWords(W([['terrasa', 0, 400], ['grande', 420, 800]]), 'terraza amplia');
  assert.equal(texts(lone.words), 'terrasa grande');
  assert.equal(lone.report.adopted.length, 0);
  assert.deepEqual(lone.report.ambiguous.map((a) => a.asr), ['terrasa', 'grande']);
});

test('accents, ñ and Spanish number words normalize for matching; surface forms are kept', () => {
  assert.equal(normKey('Año'), 'ano');
  assert.equal(normKey('¿Cuántos?'), 'cuantos');
  assert.equal(normKey('MONTEALBÁN'), 'montealban');
  assert.equal(normKey('pingüino'), 'pinguino');
  assert.equal(numberOf(['treinta', 'y', 'dos']), 32);
  assert.equal(numberOf([normKey('veintidós')]), 22);
  assert.equal(numberOf(['dos', 'mil', 'quinientos']), 2500);
  assert.equal(numberOf(['y']), undefined);
  const toks = tokenizeGuion('¿Cuántos años tiene? (pausa) Señora Peña: niños.\nINSERTO: plazas y hospitales\n[B-roll de la alberca] Muchas gracias.');
  assert.deepEqual(toks.map((t) => t.core), ['Cuántos', 'años', 'tiene', 'Señora', 'Peña', 'niños', 'Muchas', 'gracias']); // directions are not speech
  assert.deepEqual(toks.map((t) => t.sentStart), [true, false, false, true, false, false, true, false]);
  assert.equal(toks.find((t) => t.core === 'Peña').entity, true);
  // "32" said, "treinta y dos" written: one word split into the guion's
  const {words} = reconcileWords(W([['Son', 0, 200], ['32', 220, 820], ['lotes.', 840, 1200]]), 'Son treinta y dos lotes.');
  assert.equal(texts(words), 'Son treinta y dos lotes.');
  assert.equal(words[1].startMs, 220);
  assert.equal(words[3].endMs, 820);
  // keepDigits (vibem): the same figure stays digits (v11 shows 54, not 'cincuenta y cuatro'); an article is wording
  const kept = reconcileWords(W([['Son', 0, 200], ['32', 220, 820], ['lotes', 840, 1100], ['con', 1120, 1300], ['1', 1320, 1500], ['baño.', 1520, 1900]]), 'Son treinta y dos lotes con un baño.', {keepDigits: true});
  assert.equal(texts(kept.words), 'Son 32 lotes con un baño.');
  assert.equal(kept.report.aligned, 8);
  assert.equal(kept.words[1].asr, undefined);
  // spelled out in the audio, digits in the guion: the guion's digits
  assert.equal(texts(reconcileWords(W([['Son', 0, 200], ['treinta', 220, 500], ['y', 500, 560], ['dos', 560, 820], ['lotes.', 840, 1200]]), 'Son 32 lotes.').words), 'Son 32 lotes.');
  // "un"/"una" is wording, not a number, unless the other side is digits
  assert.notEqual(align([{text: 'un'}], tokenizeGuion('una'))[0].class, 'exact');
  assert.equal(align([{text: '1'}], tokenizeGuion('una'))[0].class, 'exact');
});

test('a sentence-initial guion capital does not capitalize a word mid-sentence in the reel', () => {
  const {words} = reconcileWords(W([['y', 0, 100], ['la', 120, 200], ['terraza', 220, 600], ['tambien', 620, 1000]]), 'Y la terraza. También');
  assert.equal(texts(words), 'y la terraza también');
});

test('coverage: guion words not in the captions and an isolated extra word are flagged', () => {
  const words = W([['Aquí', 0, 300], ['está', 320, 600], ['la', 620, 700], ['de', 710, 760], ['alberca', 780, 1200], ['techada.', 1220, 1700]]);
  const guion = 'Aquí está la alberca techada. Y un gimnasio completo.';
  const {report} = reconcileWords(words, guion);
  assert.deepEqual(report.extra, [{wid: 'v:3', asr: 'de'}]); // reported, never dropped: it may have been said
  assert.deepEqual(report.missing, [{guion: 'Y un gimnasio completo', afterWid: 'v:5'}]);
  const issues = validateProject(projectOf(words, guion));
  assert.deepEqual(guionCodes(issues).sort(), ['guion-extra', 'guion-missing']);
  assert.match(issues.find((i) => i.code === 'guion-missing').msg, /Y un gimnasio completo/);
});

test('reconciliation-made timing errors are errors; ASR words are not judged by it', () => {
  const bad = [{id: 'c0', startMs: 0, words: [{text: 'acomoda', wid: 'v:2', startMs: 500, endMs: 400, asr: 'acomodan'}, {text: 'a', wid: 'v:2', startMs: 300, endMs: 600, asr: 'acomodan'}]}];
  const errs = guionIssues('', bad);
  assert.equal(errs.length, 2);
  assert.ok(errs.every((i) => i.level === 'error' && i.code === 'guion-timing'));
  const asrOnly = [{id: 'c0', startMs: 0, words: [{text: 'hola', startMs: 500, endMs: 400}]}];
  assert.deepEqual(guionIssues('', asrOnly), []);
  // no guion, no reconciled word: validate says nothing about the guion
  assert.deepEqual(guionCodes(validateProject(projectOf(ACOMODAN, ''))), []);
});

test('words are never joined across a cut', () => {
  const words = [...W([['con', 0, 200], ['sky', 220, 500]], 'k1'), ...W([['pool', 0, 300], ['privado', 320, 800]], 'k2').map((w, i) => ({...w, wid: `v:${i + 2}`}))];
  const {words: out} = reconcileWords(words, 'con skypool privado');
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((w) => w.clipId), ['k1', 'k1', 'k2', 'k2']);
});

test('the pager keeps the ASR text of reconciled words, and the judge does not read a split piece as out of sync', () => {
  const {words} = reconcileWords(ACOMODAN, 'Aquí se acomoda a los invitados.');
  const pages = pageWords(words, presetOf('palabra'));
  const cw = pages.flatMap((c) => c.words);
  assert.deepEqual(cw.filter((w) => w.asr).map((w) => [w.text, w.asr]), [['acomoda', 'acomodan'], ['a', 'acomodan']]);
  const said = ACOMODAN.map((w) => ({wid: w.wid, clipId: 'k1', word: w.word, t0: w.startMs / 1000, t1: w.endMs / 1000}));
  const shown = pages.map((c) => ({...c, clipId: 'k1'}));
  assert.deepEqual(captionTextFindings(shown, said).filter((f) => f.check === 'sync'), []);
});

test('figures the ASR spelled out become digits (Deepgram writes words); a lone small number and a list stay words', () => {
  const ws = W([['Son', 0, 200], ['cincuenta', 220, 500], ['y', 500, 560], ['cuatro', 560, 820], ['departamentos,', 840, 1400], ['a', 1420, 1480], ['cinco', 1500, 1800], ['minutos', 1820, 2200], ['desde', 2220, 2500], ['un', 2520, 2600], ['millón', 2600, 2900], ['quinientos', 2900, 3300], ['mil.', 3300, 3500], ['Tres', 3600, 3800], ['cuatro', 3820, 4000], ['cinco', 4020, 4200], ['y', 4220, 4300], ['seis.', 4320, 4600]]);
  const out = joinFigures(ws);
  assert.equal(texts(out), 'Son 54 departamentos, a cinco minutos desde 1,500,000. Tres cuatro cinco y seis.');
  const n54 = out[1];
  assert.deepEqual([n54.wid, n54.startMs, n54.endMs, n54.asr], ['v:1', 220, 820, 'cincuenta y cuatro']); // first id, whole span, the words kept
});
