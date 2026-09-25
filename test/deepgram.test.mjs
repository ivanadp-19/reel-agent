import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDeepgramJson, useDeepgram} from '../scripts/lib-transcribe.mjs';

test('parseDeepgramJson: words map to the cached {word,startMs,endMs} format', () => {
  const data = {results: {channels: [{alternatives: [{words: [
    {word: 'hola', punctuated_word: 'Hola,', start: 0.24, end: 0.56},
    {word: 'estamos', start: 0.56, end: 0.98},
    {word: '', start: 1, end: 1.2}, // empty tokens go
  ]}]}]}};
  assert.deepEqual(parseDeepgramJson(data), [
    {word: 'Hola,', startMs: 240, endMs: 560},
    {word: 'estamos', startMs: 560, endMs: 980},
  ]);
});

test('parseDeepgramJson: a failed/empty response is an empty list, not a crash', () => {
  assert.deepEqual(parseDeepgramJson({}), []);
  assert.deepEqual(parseDeepgramJson({results: {channels: [{alternatives: [{}]}]}}), []);
});

test('useDeepgram: key present unless REEL_STT pins whisperx', () => {
  const k = process.env.DEEPGRAM_API_KEY, s = process.env.REEL_STT;
  try {
    process.env.DEEPGRAM_API_KEY = 'x'; delete process.env.REEL_STT;
    assert.equal(useDeepgram(), true);
    process.env.REEL_STT = 'whisperx';
    assert.equal(useDeepgram(), false);
    delete process.env.REEL_STT; delete process.env.DEEPGRAM_API_KEY;
    assert.equal(useDeepgram(), false);
  } finally {
    if (k === undefined) delete process.env.DEEPGRAM_API_KEY; else process.env.DEEPGRAM_API_KEY = k;
    if (s === undefined) delete process.env.REEL_STT; else process.env.REEL_STT = s;
  }
});
