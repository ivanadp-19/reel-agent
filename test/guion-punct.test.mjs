// Unit examples for applyGuionPunctuation (v11.1): whisper streams carry no
// punctuation, so sentence boundaries are transferred from the punctuated guion
// script. (a) Punctuation marks land on matched words. (b) A guion sentence's
// first word flags sentenceStart in the stream even when the previous
// sentence's tail was recorded with different words ('regresas a las nueve de
// la noche. / Aquí…' vs 'regresar tan tarde aquí…'). (c) The flag walks back
// over glue words so a page never ends on a dangling 'en' ('De este lado' →
// 'en este lado'). (d) A whole unsaid sentence (20+ skipped tokens) flags
// nothing. (e) pageWords breaks before sentenceStart words and the 1-word
// orphan merge never glues a new sentence's head back onto the previous tail.
// Run: node --test test/guion-punct.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pageWords} from '../src/paging.ts';
import {applyGuionPunctuation} from '../src/highlights.ts';

const W = (word, i) => ({
  wid: `s:${i}`, word, src: 's', clipId: 'clip1',
  startMs: i * 400, endMs: i * 400 + 300,
  srcStartMs: i * 400, srcEndMs: i * 400 + 300, tier: 0,
});
const stream = (text) => text.split(' ').map(W);
const texts = (pages) => pages.map((p) => p.words.map((w) => w.text).join(' '));
const V11 = {layout: {maxWords: 8, maxCharsLine: 18, unbreakable: true}};

test('punctuation marks transfer onto matched words', () => {
  const ws = stream('mira aquí tienes el coworking sala de juntas');
  const r = applyGuionPunctuation(ws, 'Mira, aquí tienes el coworking. Sala de juntas.');
  assert.ok(r.marks >= 2);
  assert.equal(ws[0].word, 'mira,');
  assert.equal(ws[4].word, 'coworking.');
});

test('sentence start survives wording drift at the previous tail', () => {
  // recorded: '…ni tienes que regresar tan tarde aquí está el salón…'
  // script:   '…ni regresas a las nueve de la noche. Aquí está el salón…'
  const ws = stream('ya no manejas ni tienes que regresar tan tarde aquí está el salón para sesenta invitados');
  applyGuionPunctuation(ws, 'Ya no manejas, ni regresas a las nueve de la noche. Aquí está el salón para sesenta invitados.');
  assert.equal(ws[9].sentenceStart, true); // 'aquí' flags even though 'noche.' never matched
  const pages = texts(pageWords(ws, V11));
  const salon = pages.findIndex((p) => /salón/.test(p));
  assert.ok(salon > 0 && pages[salon].startsWith('aquí está el salón'), JSON.stringify(pages));
  assert.ok(!/tarde aquí|aquí está$/.test(pages[salon - 1]), JSON.stringify(pages));
});

test('flag walks back over glue words (De este lado → en este lado)', () => {
  const ws = stream('y city center en este lado están los hospitales');
  applyGuionPunctuation(ws, 'City Center a nueve. De este lado están los hospitales.');
  const flagged = ws.findIndex((w) => w.sentenceStart);
  assert.equal(ws[flagged].word, 'en'); // flag on 'en', not 'este'
  const pages = texts(pageWords(ws, V11));
  assert.ok(!pages.some((p) => / en$/.test(p)), JSON.stringify(pages)); // no page ends dangling on 'en'
});

test('a whole unsaid sentence flags no mid-phrase word (skip cap)', () => {
  const unsaid = '¿Tienes hijos en la universidad? La Marista, la Modelo y la UVM están a once minutos. La Anáhuac Mayab a veintiuno.';
  const ws = stream('sin salir del rumbo y todo esto lo vas a poder ver desde tu departamento');
  applyGuionPunctuation(ws, `Sin salir del rumbo. ${unsaid} Y todo esto lo vas a ver desde tu departamento, porque es la vista.`);
  // the skip cap stops the carry before it can land on 'a poder' mid-phrase
  assert.ok(!ws[9].sentenceStart, "'a' must not flag"); // 'a' in 'lo vas a poder ver'
  assert.ok(!ws[11].sentenceStart, "'ver' must not flag");
  const pages = texts(pageWords(ws, V11));
  assert.ok(pages.some((p) => /a poder ver/.test(p)), JSON.stringify(pages)); // 'a poder ver' holds together
  assert.ok(!pages.some((p) => / (a|de|en|y|lo)$/.test(p)), JSON.stringify(pages)); // no dangling glue tail
});

test('1-word orphan merge never glues a sentence head back (MINUTOS SALÓN)', () => {
  const ws = stream('en unos meses mira aquí tienes el coworking');
  applyGuionPunctuation(ws, 'Así se verá en unos meses. Mira, aquí tienes el coworking.');
  assert.equal(ws[3].sentenceStart, true);
  const pages = texts(pageWords(ws, V11));
  assert.ok(pages.includes('mira'), JSON.stringify(pages)); // 'mira' stays its own page
  assert.ok(!pages.includes('en unos meses mira'), JSON.stringify(pages));
});
