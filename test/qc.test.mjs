import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {normalizeLoudness, qc} from '../scripts/qc.mjs';

test('a hot 1080x1920 clip fails the loudness gate, passes after two-pass loudnorm', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-qc-'));
  const f = path.join(dir, 'final.mp4');
  // 3 s of a loud tone (≈ −6 LUFS, peaks near 0 dBFS) under a test pattern
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=440:d=3:sample_rate=48000', '-af', 'volume=6dB', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]);
  assert.equal(r.status, 0, String(r.stderr));
  const before = qc(f, {expectSec: 3});
  assert.equal(before.ok, false);
  assert.ok(before.checks.find((c) => c.name === 'loudness' && !c.ok));
  assert.ok(normalizeLoudness(f).ok);
  const after = qc(f, {expectSec: 3});
  assert.equal(after.ok, true, JSON.stringify(after.checks));
  fs.rmSync(dir, {recursive: true, force: true});
});
