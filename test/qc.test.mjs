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

test('--json: the qc() report of a file, as the MCP qc tool reads it from a child process', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-qc-'));
  const f = path.join(dir, 'x-draft.mp4');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=540x960:r=30:d=2', '-f', 'lavfi', '-i', 'sine=f=440:d=2:sample_rate=48000', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]);
  assert.equal(r.status, 0, String(r.stderr));
  const out = spawnSync(process.execPath, ['scripts/qc.mjs', '--json', f, '2', '--draft'], {encoding: 'utf8'});
  assert.equal(out.status, 0, out.stderr);
  const report = JSON.parse(out.stdout);
  assert.deepEqual(report, qc(f, {expectSec: 2, draft: true}));
  assert.equal(report.checks.find((c) => c.name === 'frame').ok, true, 'the draft size, because --draft was passed');
  fs.rmSync(dir, {recursive: true, force: true});
});
