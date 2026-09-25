import test from 'node:test';
import assert from 'node:assert/strict';
import {whisperxCheck} from '../server/health.mjs';

test('whisperxCheck: installed venv is ok and names the device', () => {
  const c = whisperxCheck({venv: true, env: {}, device: 'cuda'});
  assert.equal(c.ok, true);
  assert.equal(c.label, 'WhisperX (cuda)');
});

test('whisperxCheck: no venv and no Deepgram is a blocking miss with the setup hint', () => {
  const c = whisperxCheck({venv: false, env: {}});
  assert.equal(c.ok, false);
  assert.ok(!c.optional);
  assert.match(c.hint, /npm run setup.*needed for captions, autocut, transcripts/);
});

test('whisperxCheck: no venv with Deepgram active is optional, not missing', () => {
  const c = whisperxCheck({venv: false, env: {DEEPGRAM_API_KEY: 'k'}});
  assert.equal(c.ok, true);
  assert.equal(c.optional, true);
  assert.equal(c.label, 'WhisperX (optional — Deepgram active)');
  assert.match(c.hint, /Deepgram handles transcription; WhisperX is only the local fallback/);
});

test('whisperxCheck: REEL_STT=whisperx pins WhisperX, so the key does not excuse a missing venv', () => {
  const c = whisperxCheck({venv: false, env: {DEEPGRAM_API_KEY: 'k', REEL_STT: 'whisperx'}});
  assert.equal(c.ok, false);
});
