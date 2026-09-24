import test from 'node:test';
import assert from 'node:assert/strict';
import {isDegenerate} from '../scripts/lib-transcribe.mjs';

const w = (s) => s.split(' ').map((word, i) => ({word, startMs: i * 300, endMs: i * 300 + 250}));

test('a one-word loop is degenerate, real speech is not', () => {
  assert.equal(isDegenerate(w('Bueno, bueno, bueno, bueno, bueno, bueno, bueno, bueno, bueno, bueno,')), true);
  assert.equal(isDegenerate(w('Montealbán 326, 54 departamentos en preventa al norte de Mérida, escríbeme')), false);
  assert.equal(isDegenerate(w('sí sí sí sí')), false); // too short to judge
});
