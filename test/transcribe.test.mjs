import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isDegenerate} from '../scripts/lib-transcribe.mjs';
import {monotonic, projectTranscript} from '../scripts/transcript-cache.mjs';
import {pageWords} from '../src/paging.ts';
import {PRESETS} from '../src/captionPresets.ts';

const w = (s) => s.split(' ').map((word, i) => ({word, startMs: i * 300, endMs: i * 300 + 250}));

test('a one-word loop is degenerate, real speech is not', () => {
  assert.equal(isDegenerate(w('Bueno, bueno, bueno, bueno, bueno, bueno, bueno, bueno, bueno, bueno,')), true);
  assert.equal(isDegenerate(w('Montealbán 326, 54 departamentos en preventa al norte de Mérida, escríbeme')), false);
  assert.equal(isDegenerate(w('sí sí sí sí')), false); // too short to judge
});

// Deepgram on Morantes4.1: "rápido" 13.52–14.88 s over "y" at 14.03 s — one word per page, the pages overlapped
// (validate overlap-captions). The cache reader every consumer goes through makes the times monotonic, once.
const MORANTES = [['es', 13100, 13400], ['rápido', 13520, 14880], ['y', 14025, 14345], ['estable,', 14345, 14985], ['todo', 15200, 15500]].map(([word, startMs, endMs]) => ({word, startMs, endMs}));
const timeline = (ws) => ws.map((x, i) => ({wid: `a:${i}`, word: x.word, src: 'clips/a.mp4', clipId: 'a', startMs: x.startMs, endMs: x.endMs, srcStartMs: x.startMs, srcEndMs: x.endMs}));
const overlaps = (ws) => ws.filter((x, i) => ws[i + 1] && ws[i + 1].startMs < x.endMs).length;

test('word times: each word ends by the time the next starts, starts never go back; the rest untouched, ids kept', () => {
  const m = monotonic(MORANTES);
  assert.deepEqual(m.map((x) => [x.word, x.startMs, x.endMs]), [['es', 13100, 13400], ['rápido', 13520, 14025], ['y', 14025, 14345], ['estable,', 14345, 14985], ['todo', 15200, 15500]]);
  assert.equal(m[0], MORANTES[0], 'a word that did not overlap is the same object');
  assert.deepEqual(monotonic([{word: 'a', startMs: 500, endMs: 900}, {word: 'b', startMs: 400, endMs: 450}, {word: 'c', startMs: 1000, endMs: 1200}]).map((x) => [x.startMs, x.endMs]), [[500, 500], [500, 500], [1000, 1200]], 'a start before the previous one is moved up to it');
  assert.deepEqual(monotonic([]), []);
});

test('word times: the cache reader (projectTranscript, the checks and the judge; transcribeClip goes through the same voices()) serves monotonic words, and the pager makes no overlapping pages', async () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-words-'));
  try {
    fs.mkdirSync(path.join(pub, 'clips', 'transcripts'), {recursive: true});
    fs.writeFileSync(path.join(pub, 'clips', 'transcripts', 'm41.es.dg.json'), JSON.stringify(MORANTES));
    const [t] = projectTranscript({lang: 'es', offMic: 'off', clips: [{id: 'c1', src: 'clips/m41.mp4', inSec: 0, outSec: 20}]}, pub, {DEEPGRAM_API_KEY: 'x'});
    assert.deepEqual([t.words.length, overlaps(t.words), t.words.map((x) => x.i)], [5, 0, [0, 1, 2, 3, 4]]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(pub, 'clips', 'transcripts', 'm41.es.dg.json'), 'utf8'))[1].endMs, 14880, 'the cache keeps what the engine said');
    assert.equal(overlaps(pageWords(timeline(MORANTES), PRESETS.palabra)), 1, 'the bug: one word per page, "rápido" over "y"');
    assert.equal(overlaps(pageWords(timeline(t.words), PRESETS.palabra)), 0);
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});
