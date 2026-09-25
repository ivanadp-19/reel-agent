import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {deepgramAll, parseDeepgramJson, useDeepgram} from '../scripts/lib-transcribe.mjs';

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

// A Deepgram stub: each fake wav's content is its key; `answers[key]` lists what the API
// says per call (a status number = that error, a word list = a 200 with those words).
const reply = (words) => new Response(JSON.stringify({results: {channels: [{alternatives: [{words}]}]}}), {status: 200});
const words = (text) => text.split(' ').map((w, i) => ({word: w.replace(/[.,]/g, ''), punctuated_word: w, start: i * 0.3, end: i * 0.3 + 0.25}));
const withStub = async (answers, fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-dg-'));
  const wavs = new Map(Object.keys(answers).map((k) => { const f = path.join(dir, `${k}.16k.wav`); fs.writeFileSync(f, k); return [k, f]; }));
  const calls = [];
  const orig = globalThis.fetch, key = process.env.DEEPGRAM_API_KEY;
  process.env.DEEPGRAM_API_KEY = 'k';
  globalThis.fetch = async (url, init) => {
    const k = Buffer.from(init.body).toString();
    calls.push({key: k, params: new URL(url).searchParams, auth: init.headers.Authorization});
    const next = answers[k].shift();
    return typeof next === 'number' ? new Response('nope', {status: next}) : reply(next);
  };
  try { return await fn({dir, wavs, calls}); } finally {
    globalThis.fetch = orig;
    if (key === undefined) delete process.env.DEEPGRAM_API_KEY; else process.env.DEEPGRAM_API_KEY = key;
    fs.rmSync(dir, {recursive: true, force: true});
  }
};

test('deepgramAll: good transcripts are cached (punctuated); failures and loops go to WhisperX; one retry on 5xx', async () => {
  await withStub({
    ok: [words('Hola, estamos en Mérida.')],
    flaky: [503, words('Segunda va.')],
    down: [500, 500],
    loop: [words('bueno bueno bueno bueno bueno bueno bueno bueno bueno bueno')],
  }, async ({dir, wavs, calls}) => {
    const {left, lastError} = await deepgramAll(wavs, 'es', dir);
    assert.deepEqual([...left.keys()].sort(), ['down', 'loop']);
    assert.match(String(lastError), /deepgram 500|degenerate/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'ok.es.json'), 'utf8')), [
      {word: 'Hola,', startMs: 0, endMs: 250}, {word: 'estamos', startMs: 300, endMs: 550}, {word: 'en', startMs: 600, endMs: 850}, {word: 'Mérida.', startMs: 900, endMs: 1150},
    ]);
    assert.ok(fs.existsSync(path.join(dir, 'flaky.es.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'down.es.json')) && !fs.existsSync(path.join(dir, 'loop.es.json')));
    assert.equal(calls.filter((c) => c.key === 'flaky').length, 2); // one retry, then it worked
    assert.equal(calls.filter((c) => c.key === 'down').length, 2); // one retry, then WhisperX
    const p = calls.find((c) => c.key === 'ok').params;
    assert.equal(p.get('model'), 'nova-3');
    assert.equal(p.get('punctuate'), 'true'); // sentence ends: retakes, caption pages, off-mic takes
    assert.equal(p.get('language'), 'es');
    assert.equal(p.get('detect_language'), null);
    assert.equal(calls[0].auth, 'Token k');
  });
});

test('deepgramAll: lang auto asks Deepgram to detect the language', async () => {
  await withStub({a: [words('Hi there.')]}, async ({dir, wavs, calls}) => {
    await deepgramAll(wavs, 'auto', dir);
    assert.equal(calls[0].params.get('detect_language'), 'true');
    assert.equal(calls[0].params.get('language'), null);
    assert.ok(fs.existsSync(path.join(dir, 'a.auto.json')));
  });
});

test('deepgramAll: a bad key ends the batch instead of failing every clip', async () => {
  await withStub(Object.fromEntries('abcdefgh'.split('').map((k) => [k, [401, 401]])), async ({dir, wavs, calls}) => {
    const {left, lastError} = await deepgramAll(wavs, 'es', dir);
    assert.equal(left.size, 8);
    assert.equal(lastError.status, 401);
    assert.ok(calls.length < 8, `${calls.length} calls`); // the first batch only, no retries
  });
});
