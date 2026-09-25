import {test} from 'node:test';
import assert from 'node:assert/strict';
import {findCutCandidates, similar} from '../src/cuts.ts';

// words from a phrase list: [text, off?]; 250 ms per word, pauseMs between phrases
function clip(phrases, pauseMs = 900) {
  const words = [];
  let t = 0, i = 0;
  for (const [p, off] of phrases) {
    for (const w of p.split(' ')) { words.push({i: i++, word: w, startMs: t, endMs: t + 250, ...(off ? {off: true} : {})}); t += 300; }
    t += pauseMs;
  }
  return {clipId: 'c', source: 'S', words};
}
const brief = (cs) => cs.map((c) => `${c.kind} ${c.text}${c.note ? ` (${c.note})` : ''}`);

test('similar: repeats and false starts, not shared short phrases', () => {
  const t = (s) => s.toLowerCase().split(' ');
  assert.ok(similar(t('they told us that debt is bad'), t('they told us debt is bad')));
  assert.ok(similar(t('debt is actually one of the what'), t('debt is actually one of the biggest creators in this country')));
  assert.ok(!similar(t('good debt'), t('that is considered good debt')));
});

test('retakes keep the last complete take; the off-mic line and the false start go', () => {
  const c = clip([['Our parents, the media and even Dave Ramsey.', true], ['Our parents, the media and even Dave Ramsey.'], ['Debt is actually one of the, what?'], ['Debt is actually one of the biggest creators in this country.']]);
  assert.deepEqual(brief(findCutCandidates([c])), [
    'retake Our parents, the media and even Dave Ramsey. (off-mic voice)',
    'retake Debt is actually one of the, what? (false start)',
  ]);
});

test('meta talk and fillers', () => {
  const c = clip([['So um debt is, you know, powerful.'], ['Debt is, oh my god, say it again. Sorry.']]);
  assert.deepEqual(brief(findCutCandidates([c])), ['filler um', 'filler you know,', 'meta Debt is, oh my god, say it again.', 'meta Sorry.']);
});

test('Spanish: eh, o sea, and "este" only between pauses', () => {
  const words = [['Eh', 0, 200], ['la', 700, 900], ['casa', 950, 1300], ['este', 1600, 1900], ['tiene', 2200, 2500], ['o', 2550, 2650], ['sea', 2700, 2900], ['este', 2950, 3200], ['jardín.', 3250, 3700]].map(([word, startMs, endMs], i) => ({i, word, startMs, endMs}));
  assert.deepEqual(brief(findCutCandidates([{clipId: 'c', source: 'S', words}])), ['filler Eh', 'filler este (between pauses)', 'filler o sea']);
});

import {AUTOCUT, speechSegments} from '../src/cuts.ts';

test('autocut plans a piece of a take from its own words only (run 6: 11 pieces → 143 clips)', () => {
  const words = [[1000, 1400], [1500, 1900], [5000, 5400], [9000, 9500], [9600, 9900]].map(([startMs, endMs]) => ({startMs, endMs}));
  assert.deepEqual(speechSegments(words, {inSec: 0, outSec: 12}).length, 3);
  const piece = speechSegments(words, {inSec: 8.5, outSec: 10.5});
  assert.equal(piece.length, 1);
  assert.ok(piece[0].inSec >= 8.5 && piece[0].outSec <= 10.5, JSON.stringify(piece));
  assert.deepEqual(speechSegments(words, {inSec: 2.5, outSec: 4.5}), []); // silence only
});

// words from [text, gapBeforeMs] pairs: 250 ms per word, 300 ms between words, the given gap before each phrase
function seq(phrases, off = () => false) {
  const words = [];
  let t = 0, i = 0;
  phrases.forEach(([p, gap], k) => {
    t += gap;
    for (const w of p.split(' ')) { words.push({i: i++, word: w, startMs: t, endMs: t + 250, ...(off(k) ? {off: true} : {})}); t += 300; }
  });
  return {clipId: 'c', source: 'S', words};
}

test('a rehearsal read in one breath loses to the real take said with a pause inside it (VIBEM 02 hook)', () => {
  // she reads the line quietly first, then performs it with a 1.9 s pause after "cava,"
  const c = seq([['¿Cuántos edificios en Mérida te dan tu propia cava?', 0], ['Tu propia cava, un salón para eventos privados y un skywalk.', 900], ['Tu propia cava,', 1300], ['Un salón de eventos privados y un sky bar.', 1900]]);
  const out = findCutCandidates([c]);
  assert.deepEqual(brief(out), ['retake Tu propia cava, un salón para eventos privados y un skywalk.']);
  assert.equal(out[0].keep.text, 'Tu propia cava, Un salón de eventos privados y un sky bar.');
});

test('a fragment that only repeats the END of an earlier sentence is not its retake', () => {
  const c = seq([['¿Cuántos edificios en Mérida te dan tu propia cava?', 0], ['Tu propia cava.', 1300]]);
  assert.deepEqual(brief(findCutCandidates([c])), []);
});

test('a two-word false start before the full line goes; the full line stays (VIBEM 02 close)', () => {
  const c = seq([['Montalban 326.', 0], ['Montalban 326, 54 departamentos en preventa al norte de Mérida.', 400], ['Escríbeme y te enseño el proyecto completo.', 400]]);
  assert.deepEqual(brief(findCutCandidates([c])), ['retake Montalban 326. (false start)']);
});

test('Spanish direction talk is meta: te lo repito, vamos a grabar, a cuadro, no leí, dos veces', () => {
  const c = seq([['No leí que decía que decía.', 0], ['Ahorita te lo repito.', 400], ['Este sí te vamos a grabar a cuadro.', 400], ['Aquí vamos a grabar dos veces este', 400]]);
  assert.deepEqual(brief(findCutCandidates([c])).filter((x) => x.startsWith('meta')), ['meta No leí que decía que decía.', 'meta Ahorita te lo repito.', 'meta Este sí te vamos a grabar a cuadro.', 'meta Aquí vamos a grabar dos veces este']);
});

test('a take split by a short pause is one attempt: "Y" + "si necesitas…" beats the quiet read of the same line', () => {
  const c = seq([['Contra, barra, cocina', 0], ['y despensa.', 1000], ['Y si necesitas chef o mesero, aquí mismo te los conseguimos.', 100], ['Tiene barra, contra, barra,', 900], ['cocina y despensa.', 300], ['Y', 0], ['si necesitas chef o mesero, aquí mismo te los conseguimos.', 500]]);
  const out = brief(findCutCandidates([c]));
  assert.deepEqual(out, ['retake Contra, barra, cocina y despensa.', 'retake Y si necesitas chef o mesero, aquí mismo te los conseguimos.']);
});


import {paint, track} from './loud.mjs';
const W2 = (a, b, off) => ({startMs: a * 1000, endMs: b * 1000, ...(off ? {off: true} : {})});
const CLIP = {inSec: 0, outSec: 20};

test('autocut without loudness keeps the old behavior: words only', () => {
  const words = [W2(1, 1.5), W2(2.4, 2.9)]; // 900 ms gap
  const segs = speechSegments(words, CLIP);
  assert.equal(segs.length, 2);
});

test('a pause with a voice still in it is not a cut point (WhisperX dropped the words)', () => {
  const t = track(20);
  paint(t, 0.8, 3.1, -25); // the presenter talks straight through; the transcript has a hole
  const words = [W2(1, 1.5), W2(2.4, 2.9)]; // 900 ms transcript gap
  const segs = speechSegments(words, CLIP, {...AUTOCUT, loud: t});
  assert.equal(segs.length, 1, JSON.stringify(segs));
  assert.ok(segs[0].outSec > 2.9, JSON.stringify(segs));
});

test('a silent pause is still cut, even with a loudness track', () => {
  const t = track(20);
  paint(t, 0.9, 1.6, -25); paint(t, 2.3, 3.0, -25); // two phrases, real silence between
  const words = [W2(1, 1.5), W2(2.4, 2.9)];
  const segs = speechSegments(words, CLIP, {...AUTOCUT, loud: t});
  assert.equal(segs.length, 2, JSON.stringify(segs));
});

test('a pause longer than bridgeMaxMs is cut even if something rustles in it', () => {
  const t = track(20);
  paint(t, 0.9, 1.6, -25); paint(t, 2.0, 2.5, -30); paint(t, 4.4, 5.1, -25); // 2.9 s gap with noise
  const words = [W2(1, 1.5), W2(4.5, 5)];
  const segs = speechSegments(words, CLIP, {...AUTOCUT, loud: t});
  assert.equal(segs.length, 2, JSON.stringify(segs));
});

test('dropOff: the off-mic voice explains its energy — its gap is never bridged back', () => {
  const t = track(20);
  paint(t, 0.9, 2.9, -25); // presenter, then the director inside the same loud stretch
  const words = [W2(1, 1.5), W2(1.7, 2.6, true), W2(2.7, 2.9)]; // off-mic line in the middle
  const segs = speechSegments(words, CLIP, {...AUTOCUT, loud: t, dropOff: true});
  assert.equal(segs.length, 2, JSON.stringify(segs)); // cut around the off-mic line
  // the take grows to the voice edge but stops at the dropped line (+ inner pad)
  assert.ok(segs[0].outSec <= 1.7 + AUTOCUT.innerPad && segs[1].inSec >= 2.6 - AUTOCUT.innerPad, JSON.stringify(segs));
});

test('dropOff: an off-mic word over the take edge still stops the growth (no overlapping segments)', () => {
  const t = track(20);
  paint(t, 0.9, 2.9, -25);
  const words = [W2(1, 1.5), W2(1.4, 2.6, true), W2(2.7, 2.9)]; // the director starts over her last word
  const segs = speechSegments(words, CLIP, {...AUTOCUT, loud: t, dropOff: true});
  assert.equal(segs.length, 2, JSON.stringify(segs));
  assert.ok(segs[0].outSec <= 1.5 + AUTOCUT.innerPad, JSON.stringify(segs));
  assert.ok(segs[1].inSec >= segs[0].outSec, JSON.stringify(segs));
});

test('dropOff: a short off-mic word between two close words still splits the take', () => {
  const t = track(20);
  paint(t, 0.9, 2.4, -25);
  const words = [W2(1, 1.5), W2(1.55, 1.9, true), W2(1.95, 2.3)]; // gaps under gapMs on both sides
  const segs = speechSegments(words, CLIP, {...AUTOCUT, loud: t, dropOff: true});
  assert.equal(segs.length, 2, JSON.stringify(segs));
  assert.ok(segs[0].outSec <= 1.55 + AUTOCUT.innerPad && segs[1].inSec >= 1.9 - AUTOCUT.innerPad, JSON.stringify(segs));
});

test('a blip in a long pause does not bridge it: every silence inside the gap must be under gapMs', () => {
  const t = track(20);
  paint(t, 0.9, 1.6, -25); paint(t, 2.14, 2.26, -30); paint(t, 2.9, 3.6, -25); // a 120 ms click in a 1.4 s pause
  const words = [W2(1, 1.5), W2(3, 3.5)];
  const segs = speechSegments(words, CLIP, {...AUTOCUT, loud: t});
  assert.equal(segs.length, 2, JSON.stringify(segs));
});

test('a swallowed word at the take edge: the segment grows to the voice span', () => {
  const t = track(20);
  paint(t, 0.6, 2.4, -25); // "…eh, esta casa" — WhisperX only aligned from 1.0
  const words = [W2(1, 1.5), W2(1.55, 1.9)];
  const segs = speechSegments(words, CLIP, {...AUTOCUT, loud: t});
  assert.equal(segs.length, 1);
  assert.ok(segs[0].inSec <= 0.6, JSON.stringify(segs)); // 0.6 span start - 0.1 lead pad, clamped at 0
  assert.ok(segs[0].outSec >= 2.6, JSON.stringify(segs)); // 2.4 span end + 0.3 trail pad
});
