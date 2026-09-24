import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cube, hlgInvOetf, hlgOetf, hlgToSdr, pqToSdr, sdrToHlg, toneMap} from '../src/hdr.ts';

test('HLG OETF round-trips and hits the BT.2100 reference points', () => {
  for (const l of [0, 0.01, 1 / 12, 0.3, 1]) assert.ok(Math.abs(hlgInvOetf(hlgOetf(l)) - l) < 1e-9);
  assert.ok(Math.abs(hlgOetf(1) - 1) < 1e-6);
  assert.ok(Math.abs(hlgOetf(1 / 12) - 0.5) < 1e-9);
});

test('HLG reference white (75 %) lands near SDR white, highlights roll off, blacks stay black', () => {
  const [w] = hlgToSdr([0.75, 0.75, 0.75]);
  assert.ok(w > 0.93 && w < 1, String(w));
  const [peak] = hlgToSdr([1, 1, 1]);
  assert.ok(peak <= 1 && peak > w);
  assert.equal(hlgToSdr([0, 0, 0])[0], 0);
  assert.ok(toneMap(10000) <= 1);
});

test('SDR → fake HLG → our tonemap comes back close for mid tones and skin', () => {
  for (const c of [[0.5, 0.5, 0.5], [0.8, 0.6, 0.5], [0.2, 0.3, 0.6], [0.35, 0.35, 0.35]]) {
    const back = hlgToSdr(sdrToHlg(c));
    back.forEach((v, i) => assert.ok(Math.abs(v - c[i]) < 0.03, `${c} → ${back}`));
  }
});

test('PQ 203 nits (≈ 0.58 signal) is SDR white-ish; the cube has size³ rows', () => {
  const [w] = pqToSdr([0.5807, 0.5807, 0.5807]);
  assert.ok(w > 0.93 && w < 1, String(w));
  assert.equal(cube((x) => x, 5).trim().split('\n').length, 4 + 125);
});
