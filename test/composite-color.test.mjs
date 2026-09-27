// The layers composite keeps colour on every ffmpeg: before 7.1 the overlay filter took no yuvj420p main,
// ffmpeg squeezed Remotion's full-range master into limited range for it, blended the full-range caption layer
// into that and stretched the lot back — an opaque #FFE500 box came out Y 225 instead of ~211 (ffmpeg 6.1.1, the VM).
// Imports scripts/layers.mjs only, so it runs on a box with ffmpeg and node alone (copy scripts/, src/, zod).
import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {alphaEncodeArgs, compositeArgs, probeColor} from '../scripts/layers.mjs';

const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-color-'));
after(() => fs.rmSync(d, {recursive: true, force: true}));
const ff = (args) => { const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], {encoding: 'utf8'}); assert.equal(r.status, 0, r.stderr); };
const W = 64, H = 128; // the layer's top half an opaque box, the bottom half transparent
// Y, U, V of pixel (x, y) of the first frame as stored (yuv 4:2:0, no conversion on the way out)
const yuv = (file) => {
  const b = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-'], {maxBuffer: 1 << 24}).stdout;
  return (x, y) => [b[y * W + x], b[W * H + (y >> 1) * (W >> 1) + (x >> 1)], b[W * H * 1.25 + (y >> 1) * (W >> 1) + (x >> 1)]];
};
const near = (got, want, what) => assert.ok(got.every((v, i) => Math.abs(v - want[i]) <= 3), `${what}: YUV ${got} ≠ ${want} ±3 (ffmpeg ${spawnSync('ffmpeg', ['-version'], {encoding: 'utf8'}).stdout.split(' ')[2]})`);

test('composite colour: an opaque #FFE500 layer (PNG frames and ProRes 4444) over a full-range master comes out #FFE500 (BT.601 full: Y 211, U 9, V 160); the master\'s own pixels unchanged', () => {
  const master = path.join(d, 'master.mp4'), frames = path.join(d, 'frames');
  fs.mkdirSync(frames);
  ff(['-f', 'lavfi', '-i', `color=c=0x404040:size=${W}x${H}:rate=30`, '-frames:v', '3', '-pix_fmt', 'yuvj420p', '-c:v', 'libx264', master]); // like Remotion's
  assert.equal(probeColor(master).range, 'pc');
  ff(['-f', 'lavfi', '-i', `color=c=0xFFE500:size=${W}x${H / 2}:rate=30,format=rgba,pad=${W}:${H}:0:0:color=black@0`, '-frames:v', '3', path.join(frames, 'element-%03d.png')]);
  const mov = path.join(d, 'captions.mov');
  ff(alphaEncodeArgs({frames, outFile: mov, alpha: 'prores', fps: 30}).slice(3));
  const m = yuv(master);
  for (const [name, layer] of [['png', {file: frames}], ['prores', {file: mov, alpha: 'prores'}]]) {
    const out = path.join(d, `out-${name}.mp4`);
    ff(compositeArgs({master, overlays: [layer], outFile: out, fps: 30, color: probeColor(master)}).slice(3));
    assert.equal(probeColor(out).range, 'pc', `${name}: the composite stays full range`);
    const o = yuv(out);
    near(o(W / 2, H / 4), [211, 9, 160], `${name}: the box`);
    near(o(W / 2, (3 * H) / 4), m(W / 2, (3 * H) / 4), `${name}: the master under a transparent layer`);
  }
});
