import {test} from 'node:test';
import assert from 'node:assert/strict';
import {flagOffMic, loudnessFromPcm, runsOf} from '../src/speech.ts';

// loudness track at 50 windows/s; paint(a, b, db) sets a span in seconds
const track = (sec) => ({fps: 50, db: new Array(Math.round(sec * 50)).fill(-60)});
const paint = (t, a, b, db) => { for (let i = Math.round(a * 50); i < Math.round(b * 50); i++) t.db[i] = db; };
const W = (word, a, b) => ({word, startMs: a * 1000, endMs: b * 1000});

test('a quieter take before the loud repeat is flagged off-mic', () => {
  const t = track(10);
  const words = [W('Our', 1, 1.3), W('parents', 1.35, 1.9), W('lied.', 1.95, 2.4), W('Our', 3, 3.3), W('parents', 3.35, 3.9), W('lied.', 3.95, 4.4), W('They', 4.6, 4.9), W('told', 4.95, 5.3), W('us.', 5.35, 5.8)];
  paint(t, 1, 2.4, -36); paint(t, 3, 5.8, -24);
  assert.deepEqual(flagOffMic(words, t).map((w) => !!w.off), [true, true, true, false, false, false, false, false, false]);
});

test('one voice at one level: nothing flagged, even a sentence 4 dB softer', () => {
  const t = track(6);
  const words = [W('one', 1, 1.4), W('two.', 1.5, 1.9), W('three', 3, 3.4), W('four.', 3.5, 3.9)];
  paint(t, 1, 1.9, -24); paint(t, 3, 3.9, -28);
  assert.ok(flagOffMic(words, t).every((w) => !w.off));
});

test('takes split at sentence ends and long pauses', () => {
  const words = [W('a', 0, 0.2), W('b.', 0.25, 0.4), W('c', 0.5, 0.7), W('d', 1.5, 1.7)];
  assert.deepEqual(runsOf(words).map((r) => r.map((w) => w.word)), [['a', 'b.'], ['c'], ['d']]);
});

test('loudnessFromPcm: silence is very quiet, full-scale is 0 dB', () => {
  const pcm = new Float32Array(16000); pcm.fill(1, 8000);
  const {db} = loudnessFromPcm(pcm, 16000, 2);
  assert.ok(db[0] < -100 && Math.abs(db[1]) < 0.1, JSON.stringify(db));
});
