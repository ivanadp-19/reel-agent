import {test} from 'node:test';
import assert from 'node:assert/strict';
import {flagOffMic, loudnessFromPcm, runsOf} from '../src/speech.ts';
import {paint, track} from './loud.mjs';

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

import {assignSpeakers, flagOffMicBySpeaker, offMicSpeakers} from '../src/speech.ts';

// two voices taking turns: the director (A) dictates, the presenter (B) repeats, louder
const turns = [[0.9, 2.5, 'SPEAKER_01'], [2.9, 4.5, 'SPEAKER_00'], [4.6, 6.0, 'SPEAKER_01'], [6.2, 7.8, 'SPEAKER_00']];
const dialogue = [W('Our', 1, 1.3), W('parents', 1.35, 1.9), W('lied.', 1.95, 2.4), W('Our', 3, 3.3), W('parents', 3.35, 3.9), W('lied.', 3.95, 4.4), W('They', 4.7, 5.0), W('told', 5.05, 5.4), W('us.', 5.45, 5.9), W('They', 6.3, 6.6), W('told', 6.65, 7.0), W('us.', 7.05, 7.5)];

test('assignSpeakers: each word takes the turn it overlaps most; labels are spk1, spk2… by first appearance', () => {
  const out = assignSpeakers(dialogue, turns);
  assert.deepEqual(out.map((w) => w.speaker), ['spk1', 'spk1', 'spk1', 'spk2', 'spk2', 'spk2', 'spk1', 'spk1', 'spk1', 'spk2', 'spk2', 'spk2']);
  assert.equal(assignSpeakers([W('lonely', 20, 20.5)], turns)[0].speaker, undefined); // no turn near it
});

test('the off-mic voice is the SPEAKER that sits dropDb under the loudest one, even if it says more words', () => {
  const t = track(9);
  paint(t, 0.9, 2.5, -36); paint(t, 4.6, 6.0, -35); // the director, quiet
  paint(t, 2.9, 4.5, -24); paint(t, 6.2, 7.8, -25); // the presenter, loud
  const words = assignSpeakers(dialogue, turns);
  assert.deepEqual(offMicSpeakers(words, t), ['spk1']);
  const flagged = flagOffMicBySpeaker(words, t);
  assert.deepEqual(flagged.map((w) => !!w.off), [true, true, true, false, false, false, true, true, true, false, false, false]);
});

test('one speaker, or two at the same level: nothing is off-mic by speaker; a soft on-camera sentence stays', () => {
  const t = track(9);
  paint(t, 0.9, 7.8, -26); paint(t, 4.6, 6.0, -30); // the same voice, one sentence 4 dB softer
  const words = assignSpeakers(dialogue, turns);
  assert.deepEqual(offMicSpeakers(words, t), []);
  assert.ok(flagOffMicBySpeaker(words, t).every((w) => !w.off));
  const mono = assignSpeakers(dialogue, [[0.9, 7.8, 'SPEAKER_00']]);
  assert.deepEqual(offMicSpeakers(mono, t), []);
});


import {longestSilenceMs, voiceSpans} from '../src/speech.ts';

test('voiceSpans: speech above the noise floor, silence skipped, short dips bridged', () => {
  const t = track(12); // 50 windows/s at -60
  paint(t, 1, 3, -25); // phrase
  paint(t, 5, 5.05, -20); // a 50 ms click: too short, dropped
  paint(t, 7, 7.5, -24); paint(t, 7.6, 8.2, -23); // two words with a 100 ms dip: one span
  const spans = voiceSpans(t);
  assert.deepEqual(spans, [[1, 3], [7, 8.2]]);
  assert.equal(longestSilenceMs(spans, 7000, 7400), 0); // inside a phrase
  assert.equal(longestSilenceMs(spans, 3000, 6900), 3900); // nothing in it
  assert.equal(longestSilenceMs(spans, 2000, 7200), 4000); // 3 → 7
});

test('voiceSpans: a voice still talking when the track ends is a span too', () => {
  const t = track(4);
  paint(t, 1, 4, -25);
  assert.deepEqual(voiceSpans(t), [[1, 4]]);
  paint(t, 3.9, 4, -60); // ends 100 ms before the track does: inside the dip
  assert.deepEqual(voiceSpans(t), [[1, 3.9]]);
});

test('voiceSpans: a flat track has no voice (nothing stands out from the floor)', () => {
  const t = track(4);
  paint(t, 0, 4, -30);
  assert.deepEqual(voiceSpans(t), []);
});

test('voiceSpans: quiet speech still counts when it clears the floor', () => {
  const t = track(6);
  paint(t, 2, 4, -44); // soft presenter, but the floor is -60
  assert.deepEqual(voiceSpans(t), [[2, 4]]);
});
