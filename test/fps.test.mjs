// The delivery fps: a project with an identity renders at 29.97 (30000/1001) end to end — the
// composition, the caption layer's encode, the composite, the first-frame repair, the master key,
// the pair's parity and QC's expected length; every other project stays at 30 with the same props.
import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DELIVERY_FPS, deliveryFps, placeClips, renderFps, renderSec, totalDurationFrames} from '../src/timeline.ts';
import {projectRenderProps, withDeliveryFps} from '../src/renderProps.ts';
import {alphaEncodeArgs, codeVersion, compositeArgs, masterKey, parityIssues, parityProbeArgs, parseParity, zipFrames, zipParity} from '../scripts/layers.mjs';
import {repairArgs} from '../scripts/first-frame.mjs';
import {planRender} from '../scripts/render-runner.mjs';
import {qc} from '../scripts/qc.mjs';

const IDENTITY = {client: 'acme', family: 'acme-G2', script: 2, variant: {hook: 1, cta: 1}};
const clip = (id, sec) => ({id, src: `clips/${id}.mp4`, inSec: 0, outSec: sec, sourceDurationSec: 60});
const project = (over = {}) => ({name: 'p', clips: [clip('a', 4), clip('b', 3.5)], captions: [], brolls: [], graphics: [], mattes: [], music: null, accentColor: '#FFB020', captionStyle: 'palabra', ...over});
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-fps-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, {recursive: true, force: true}); });
const ff = (args) => { const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], {encoding: 'utf8'}); assert.equal(r.status, 0, r.stderr); };
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9, `${what ?? ''} ${a} ≠ ${b}`);
const probe = (f) => parseParity(spawnSync('ffprobe', parityProbeArgs(f), {encoding: 'utf8'}).stdout);

test('delivery fps: 30000/1001 for a project with an identity, 30 for the rest; render props only ever carry those two', () => {
  assert.equal(DELIVERY_FPS, 30000 / 1001);
  for (const p of [null, undefined, {}, {identity: null}, {identity: {}}]) assert.equal(deliveryFps(p), 30);
  assert.equal(deliveryFps({identity: IDENTITY}), DELIVERY_FPS);
  assert.equal(renderFps({fps: DELIVERY_FPS}), DELIVERY_FPS);
  assert.equal(renderFps(JSON.parse(JSON.stringify({fps: DELIVERY_FPS}))), DELIVERY_FPS, 'the number survives the props file');
  for (const fps of [undefined, 30, 25, 60, 29.97, '30000/1001', '29.97002997002997']) assert.equal(renderFps({fps}), 30, String(fps));
  assert.equal(renderFps(null), 30);
});

test('R-2: without identity the render props are the ones of before (no fps key); a client\'s carry 30000/1001; the body\'s fps never wins', () => {
  const p = project();
  assert.deepEqual(projectRenderProps(p), {clips: p.clips, music: null, captions: [], brolls: [], graphics: [], mattes: [], accentColor: '#FFB020', captionStyle: 'palabra', brand: null, grade: null, audio: {clean: 'off'}, captionsOff: false});
  assert.equal(projectRenderProps({...p, identity: IDENTITY}).fps, DELIVERY_FPS);
  // POST /api/render: the editor's body, the saved project decides
  const body = {clips: p.clips, music: null, captions: [], captionsOff: false, draft: true, mode: 'layers'};
  assert.equal(JSON.stringify(withDeliveryFps(body, {})), JSON.stringify(body), 'the same props, key for key, in the same order');
  assert.equal(JSON.stringify(withDeliveryFps(body, null)), JSON.stringify(body), 'no saved project: 30');
  assert.ok(!('fps' in withDeliveryFps({...body, fps: DELIVERY_FPS}, {})), 'a body cannot ask for 29.97');
  assert.equal(withDeliveryFps({...body, fps: 60}, {identity: IDENTITY}).fps, DELIVERY_FPS, 'nor for another rate');
  assert.equal(withDeliveryFps(body, {identity: IDENTITY}).fps, DELIVERY_FPS, 'drafts of a deliverable too');
});

test('length at 29.97: every clip whole frames at that rate, and QC expects the length it renders (not the 30 fps one)', () => {
  // one 60 s clip: 1798 frames (1798.2 rounded) = 59.993 s
  assert.equal(totalDurationFrames([clip('a', 60)], DELIVERY_FPS), 1798);
  near(renderSec([clip('a', 60)], DELIVERY_FPS), 1798 * 1001 / 30000);
  // eight 1.017 s clips round up at 30 (30.51 → 31) and down at 29.97 (30.48 → 30): 0.26 s apart, past QC's ±0.2
  const cut = Array.from({length: 8}, (_, i) => clip(`c${i}`, 1.017));
  assert.deepEqual([totalDurationFrames(cut, 30), totalDurationFrames(cut, DELIVERY_FPS)], [248, 240]);
  const want = renderSec(cut, DELIVERY_FPS);
  near(want, 240 * 1001 / 30000);
  near(placeClips(cut, DELIVERY_FPS).at(-1).endMs / 1000, want, 'the MCP\'s timeline math (totalSec) says the same');
  near(renderSec(cut, 30), 248 / 30, 'without identity: as before');
  // a 240-frame 29.97 file, like the render of that cut: QC passes at the delivery rate, fails at 30's
  const d = tmp();
  const f = path.join(d, 'r.mp4');
  ff(['-f', 'lavfi', '-i', `testsrc=size=108x192:rate=30000/1001`, '-frames:v', '240', '-c:v', 'libx264', '-r', String(DELIVERY_FPS), f]);
  const dur = (expectSec) => qc(f, {expectSec, draft: true}).checks.find((c) => c.name === 'duration');
  assert.equal(dur(want).ok, true, dur(want).value);
  assert.equal(dur(renderSec(cut, 30)).ok, false);
});

test('ffmpeg gets the rate as the Number it reads as 30000/1001, never the string that breaks the timebase; 30 exactly as before', () => {
  const fc = (fps) => { const a = compositeArgs({master: 'm.mp4', overlays: [{file: 'c.mov', alpha: 'prores'}], outFile: 'o.mp4', fps}); return a[a.indexOf('-filter_complex') + 1]; };
  assert.match(fc(DELIVERY_FPS), /\[0:v\]settb=1\/29\.97002997002997,setpts=N/);
  assert.ok(!fc(DELIVERY_FPS).includes('1/30000/1001'));
  assert.match(fc(30), /\[0:v\]settb=1\/30,setpts=N\[/);
  const enc = alphaEncodeArgs({frames: 'f', outFile: 'c.mov', alpha: 'prores', fps: DELIVERY_FPS});
  assert.equal(enc[enc.indexOf('-framerate') + 1], '29.97002997002997');
  assert.match(repairArgs({file: 'm.mp4', outFile: 'o.mp4', fps: DELIVERY_FPS}).join(' '), /settb=1\/29\.97002997002997,setpts=N/);
});

test('the pair at 29.97 with real ffmpeg: master, ProRes layer and PNG zip (from the same frames) and composite all 30000/1001, frame for frame', async () => {
  const d = tmp();
  const frames = path.join(d, 'frames');
  fs.mkdirSync(frames);
  ff(['-f', 'lavfi', '-i', 'testsrc=size=108x192:rate=30000/1001', '-frames:v', '30', '-pix_fmt', 'yuvj420p', '-c:v', 'libx264', '-r', String(DELIVERY_FPS), path.join(d, 'master.mp4')]); // like Remotion: -r String(fps)
  ff(['-f', 'lavfi', '-i', 'color=c=red@0.5:size=108x192:rate=30000/1001,format=rgba', '-frames:v', '30', path.join(frames, 'element-%03d.png')]);
  ff(alphaEncodeArgs({frames, outFile: path.join(d, 'captions.mov'), alpha: 'prores', fps: DELIVERY_FPS}).slice(3));
  ff(compositeArgs({master: path.join(d, 'master.mp4'), overlays: [{file: path.join(d, 'captions.mov'), alpha: 'prores'}], outFile: path.join(d, 'out.mp4'), fps: DELIVERY_FPS}).slice(3));
  const [m, c, o] = ['master.mp4', 'captions.mov', 'out.mp4'].map((f) => probe(path.join(d, f)));
  assert.deepEqual([m.frames, m.fps, m.sec], [30, '30000/1001', 1.001]);
  assert.deepEqual(parityIssues(m, c, {fps: DELIVERY_FPS}), []);
  assert.deepEqual(parityIssues(m, o, {fps: DELIVERY_FPS}), [], 'the composite keeps the rate and every frame');
  // the PNG sequence (CEO-14): every frame, stored, with fps.json — a zip any tool opens
  fs.writeFileSync(path.join(frames, 'notes.txt'), 'not a frame');
  await zipFrames(frames, path.join(d, 'captions.png.zip'), {fps: DELIVERY_FPS});
  const z = await zipParity(path.join(d, 'captions.png.zip'));
  assert.deepEqual([z.frames, z.fps, +z.sec.toFixed(6)], [30, '30000/1001', 1.001]);
  assert.deepEqual(parityIssues(m, z, {fps: DELIVERY_FPS, name: 'captions.png.zip'}), []);
  const py = spawnSync('python3', ['-c', 'import sys, zipfile, json; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; n = z.namelist(); print(len(n), n[0], n[-2], json.loads(z.read("fps.json"))["fps"])', path.join(d, 'captions.png.zip')], {encoding: 'utf8'});
  if (py.status !== null && !py.error) assert.equal(py.stdout.trim(), '31 captions_000000.png captions_000029.png 30000/1001', py.stderr);
  assert.ok(fs.readFileSync(path.join(d, 'captions.png.zip')).includes(fs.readFileSync(path.join(frames, 'element-030.png'))), 'the frames as they are, not re-encoded');
  // a zip at 30 or a frame short fails the delivery
  await zipFrames(frames, path.join(d, 'at30.png.zip'), {fps: 30});
  assert.match(parityIssues(m, await zipParity(path.join(d, 'at30.png.zip')), {fps: DELIVERY_FPS, name: 'captions.png.zip'}).join(), /fps: master 30000\/1001, captions.png.zip 30/);
  fs.rmSync(path.join(frames, 'element-030.png'));
  await zipFrames(frames, path.join(d, 'short.png.zip'), {fps: DELIVERY_FPS});
  assert.match(parityIssues(m, await zipParity(path.join(d, 'short.png.zip')), {name: 'captions.png.zip'}).join(), /frames: master 30, captions.png.zip 29/);
});

test('parity at the delivery fps: files at 30 fail a 29.97 delivery; rates compare as numbers; half a frame is 29.97\'s', () => {
  const m = {frames: 300, fps: '30000/1001', sec: 10.01};
  assert.deepEqual(parityIssues(m, m, {fps: DELIVERY_FPS}), []);
  assert.deepEqual(parityIssues(m, {...m, fps: '60000/2002'}, {fps: DELIVERY_FPS}), [], 'the same rate written otherwise');
  const at30 = {frames: 300, fps: '30/1', sec: 10};
  assert.deepEqual(parityIssues(at30, at30, {fps: DELIVERY_FPS}), ['fps: 30/1, want 30000/1001']);
  assert.deepEqual(parityIssues(at30, at30, {fps: 30}), [], 'R-2: a 30 fps pair at 30');
  assert.deepEqual(parityIssues(at30, at30), [], 'no rate asked: master and layer only');
  assert.match(parityIssues(m, {...m, fps: '2997/100'}).join(), /fps: master 30000\/1001, captions 2997\/100/);
  assert.deepEqual(parityIssues(m, {...m, sec: 10.026}), [], 'within half a frame (16.7 ms)');
  assert.match(parityIssues(m, {...m, sec: 10.027}).join(), /duration/);
});

test('master key: R-2 — a reel without identity keys its master as before; at 29.97 it is another master, and planRender looks for that one', () => {
  const code = 'c1';
  const old = projectRenderProps(project()); // no fps key, rendered at 30
  const key30 = masterKey(old, {code, fps: 30});
  assert.equal(masterKey(withDeliveryFps(old, {}), {code, fps: renderFps(withDeliveryFps(old, {}))}), key30);
  const client = withDeliveryFps(old, {identity: IDENTITY});
  assert.notEqual(masterKey(client, {code, fps: renderFps(client)}), key30);
  // the plan's default key is the runner's: at the props' rate
  const root = tmp();
  const seen = [];
  const masterCache = {file: (k) => { seen.push(k); return path.join(root, `${k}.mp4`); }};
  for (const p of [old, client]) planRender(p, {requested: 'layers', root, publicDir: root, masterCache});
  assert.deepEqual(seen, [masterKey(old, {code: codeVersion(root), fps: 30, draft: false, publicDir: root}), masterKey(client, {code: codeVersion(root), fps: DELIVERY_FPS, draft: false, publicDir: root})]);
});
