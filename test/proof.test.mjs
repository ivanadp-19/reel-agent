import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {tileFilter} from '../mcp/proof.mjs';

// César read the black padding of a proof as letterboxing of the video: every still is labeled
test('proof tiles carry a STILL label strip and empty slots are gray, not black', () => {
  const f = tileFilter(5, 4, ['STILL 1.0 s - proof, not the render', 'a', 'b', 'c', 'd'], 16);
  assert.match(f, /drawtext=text='STILL 1\.0 s - proof\\, not the render'/);
  assert.match(f, /fill=0x303030/);
  assert.ok(!/fill=black/.test(f));
  assert.equal(tileFilter(2, 2), '[0][1]xstack=inputs=2:layout=0_0|w0_0');
});

test('the labeled filter runs in ffmpeg', {skip: spawnSync('ffmpeg', ['-version']).status !== 0}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-'));
  const ins = [0, 1, 2].map((i) => { const f = path.join(dir, `${i}.jpg`); spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=120x200', '-frames:v', '1', f]); return f; });
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...ins.flatMap((f) => ['-i', f]), '-filter_complex', tileFilter(3, 2, ['STILL 0.0 s', 'STILL 1.0 s', 'STILL 2.0 s'], 12), path.join(dir, 'sheet.jpg')]);
  // an ffmpeg without drawtext falls back to plain tiles in renderProof; here only report
  if (r.status !== 0 && /drawtext/.test(String(r.stderr))) return;
  assert.equal(r.status, 0, String(r.stderr));
});
