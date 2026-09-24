import {test} from 'node:test';
import assert from 'node:assert/strict';
import {contentWords, suggestBroll} from '../src/brollMatch.ts';

const M = (text, startSec) => text.split(' ').map((word, i) => ({wid: `s:${startSec * 10 + i}`, word, startMs: startSec * 1000 + i * 400, endMs: startSec * 1000 + i * 400 + 300}));
const speech = [...M('Tu propia cava, un salón para eventos privado y un sky bar.', 0), ...M('Porque no es una cava del edificio, es tu cava con tu nombre.', 6), ...M('También está el salón para cuando planeas un festejo.', 16), ...M('Y el sky bar para las nueve de la noche.', 28), ...M('Escríbeme y te enseño el proyecto completo.', 44)];
const assets = [
  {id: 'cava', kind: 'video', durationSec: 12, tags: ['cava', 'vino', 'botellas'], desc: 'cava de vinos con racks de madera'},
  {id: 'salon', kind: 'video', durationSec: 6, tags: ['salón', 'eventos', 'mesas'], desc: 'salón de eventos montado con mesas redondas'},
  {id: 'alberca', kind: 'image', tags: ['alberca', 'piscina'], desc: ''},
];

test('content words drop stopwords and light plurals, accents ignored', () => {
  assert.deepEqual(contentWords('Tu salón para eventos privados y las cavas'), ['salon', 'evento', 'privado', 'cava']);
});

test('suggestions land on the mention, skip the hook, keep 9 s apart, never over the closing line', () => {
  const s = suggestBroll(speech, assets, {totalMs: 48000, lastSentenceStartMs: 44000});
  const ids = s.map((x) => x.assetId);
  assert.ok(ids.includes('cava') && ids.includes('salon') && !ids.includes('alberca'), JSON.stringify(s));
  for (const x of s) assert.ok(x.startMs >= 3000 && x.startMs < 44000, `at ${x.startMs}`);
  assert.ok(s.every((x) => x.endMs - x.startMs >= 500 && x.endMs - x.startMs <= 8000));
  for (let i = 1; i < s.length; i++) assert.ok(s[i].startMs - s[i - 1].startMs >= 9000, 'spacing');
  const cava = s.find((x) => x.assetId === 'cava');
  assert.ok(cava.atWid && cava.why.includes('cava'));
});

test('black footage is covered even at the start; with no matching asset it becomes a stock query', () => {
  const s = suggestBroll(speech, assets, {totalMs: 48000, black: [{startMs: 700, endMs: 4000}, {startMs: 28000, endMs: 34000}]});
  const first = s.find((x) => x.startMs === 700); // the salón insert snaps to the black start
  assert.ok(first, JSON.stringify(s));
  const bar = s.find((x) => x.cover && x.startMs >= 28000);
  assert.equal(bar.assetId, null);
  assert.ok(bar.query.includes('sky') || bar.query.includes('bar'), bar.query);
});

test('existing inserts are respected: nothing overlaps them and a new insert stops where one begins', () => {
  const s = suggestBroll(speech, assets, {totalMs: 48000, existing: [{startMs: 9000, endMs: 14000}]});
  for (const x of s) assert.ok(x.endMs <= 9000 || x.startMs >= 14000, JSON.stringify(x));
});

test('an insert that starts inside black footage covers it from its start; long black is split by sentences into ≤ 8 s pieces', () => {
  const s = suggestBroll(speech, assets, {totalMs: 48000, black: [{startMs: 5500, endMs: 40000}]});
  const cava = s.find((x) => x.assetId === 'cava');
  assert.equal(cava.startMs, 5500);
  assert.ok(s.every((x) => x.endMs - x.startMs <= 9500), JSON.stringify(s.map((x) => [x.startMs, x.endMs]))); // ≤ 8 s, or 8 s plus a folded sliver
  let cursor = 5500;
  for (const x of s.filter((x) => x.startMs >= 5500 && x.startMs < 40000).sort((a, b) => a.startMs - b.startMs)) { assert.ok(x.startMs <= cursor + 1, `gap before ${x.startMs}`); cursor = x.endMs; }
  assert.ok(cursor >= 40000, 'covered to the end');
});
