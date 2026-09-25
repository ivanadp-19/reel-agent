import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {blankLead, frameStats, isFlat, openingReport, parseStats, repairArgs} from '../scripts/first-frame.mjs';
import {codeVersion, createMasterCache, probeColor} from '../scripts/layers.mjs';
import {createRenderRunner} from '../scripts/render-runner.mjs';
import {linkPublic} from '../scripts/public-links.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'first-frame-'));
const ff = (args) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], {encoding: 'utf8'}); assert.equal(r.status, 0, r.stderr); };
const count = (f) => +spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', f], {encoding: 'utf8'}).stdout.trim().replace(/,$/, '');
const streams = (f) => spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,pix_fmt,color_range', '-of', 'csv=p=0', f], {encoding: 'utf8'}).stdout.trim().split('\n');
// a Remotion-like master (full-range yuvj420p, audio): `lead` flat frames of a dark neutral field (production: Y 25), then footage
function clip(file, {lead = 1, sec = 1} = {}) {
  const v = lead ? `color=c=0x191919:s=270x480:r=30:d=1,trim=end_frame=${lead}[z];testsrc2=s=270x480:r=30:d=${sec}[t];[z][t]concat=n=2:v=1:a=0` : `testsrc2=s=270x480:r=30:d=${sec}`;
  ff(['-f', 'lavfi', '-i', `sine=f=300:d=${sec + lead / 30}`, '-filter_complex', `${v},format=yuvj420p[v]`, '-map', '[v]', '-map', '0:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-color_range', 'pc', '-colorspace', 'bt470bg', '-c:a', 'aac', file]);
  return file;
}

test('flat = no luma spread and no chroma; only a flat frame 0 before footage is a blank lead', () => {
  const field = {ymin: 25, ymax: 25, yavg: 25, uavg: 127, vavg: 127.4}; // G1
  const g10 = {ymin: 8, ymax: 9, yavg: 8.4, uavg: 128, vavg: 128}; // G10
  const footage = {ymin: 3, ymax: 235, yavg: 128, uavg: 121, vavg: 133};
  assert.ok(isFlat(field) && isFlat(g10) && !isFlat(footage));
  assert.ok(!isFlat({...field, uavg: 110}), 'a flat COLOR (a title card in the accent) is not this');
  assert.equal(blankLead([field, footage, footage]), true);
  assert.equal(blankLead([g10, footage]), true);
  assert.equal(blankLead([field, field, footage]), false, 'a fade from black opens on several flat frames on purpose');
  assert.equal(blankLead([footage, footage]), false);
  assert.equal(blankLead([field]), false, 'nothing to compare with');
});

test('signalstats output parses into frame order', () => {
  const out = 'frame:0    pts:0       pts_time:0\nlavfi.signalstats.YMIN=25\nlavfi.signalstats.YAVG=25\nlavfi.signalstats.YMAX=25\nlavfi.signalstats.UAVG=127\nlavfi.signalstats.VAVG=127\nframe:1    pts:3000    pts_time:0.0333\nlavfi.signalstats.YMIN=4\nlavfi.signalstats.YAVG=140.5\nlavfi.signalstats.YMAX=231\nlavfi.signalstats.UAVG=121.2\nlavfi.signalstats.VAVG=133\n';
  assert.deepEqual(parseStats(out), [{n: 0, ymin: 25, yavg: 25, ymax: 25, uavg: 127, vavg: 127}, {n: 1, ymin: 4, yavg: 140.5, ymax: 231, uavg: 121.2, vavg: 133}]);
});

test('a file with a blank frame 0 is detected; the repair shows frame 1 there, keeps every frame, the audio and the range', () => {
  const d = tmp();
  const bad = clip(path.join(d, 'bad.mp4'));
  const before = frameStats(bad);
  assert.ok(blankLead(before), 'detected');
  const fixed = path.join(d, 'fixed.mp4');
  ff(repairArgs({file: bad, outFile: fixed, color: probeColor(bad), draft: true}).slice(4)); // ff adds -v error -y
  const after = frameStats(fixed);
  assert.ok(!isFlat(after[0]), `frame 0 is footage now (Y ${after[0].ymin}–${after[0].ymax})`);
  assert.ok(!blankLead(after));
  assert.equal(count(fixed), count(bad), 'same number of frames: timing and sync unchanged');
  assert.deepEqual(streams(fixed), streams(bad), 'same streams, pixel format and range');
  // clean files and deliberate black openings pass untouched
  assert.ok(!blankLead(frameStats(clip(path.join(d, 'ok.mp4'), {lead: 0}))));
  assert.ok(!blankLead(frameStats(clip(path.join(d, 'fade.mp4'), {lead: 6}))));
  fs.rmSync(d, {recursive: true, force: true});
});

test('the render runner repairs a pass that comes out with a blank frame 0 and says so', async () => {
  const d = tmp();
  const pub = path.join(d, 'public'); fs.mkdirSync(pub);
  const src = clip(path.join(d, 'src.mp4'));
  const logs = [];
  const run = createRenderRunner({
    root: d, publicDir: pub, log: (m) => logs.push(m),
    // the "Remotion pass" writes the file with the blank lead frame
    commands: {render: ({outFile}) => ['cp', [src, outFile]]},
  });
  const props = {clips: [{id: 'c0', src: 'clips/a.mp4', inSec: 0, outSec: 1, sourceDurationSec: 2}], captions: [], grade: {look: 'clean', auto: true}, captionStyle: 'vibem'};
  const ctrl = new AbortController();
  const r = await run({id: 'j1', draft: true}, {props: JSON.stringify(props), signal: ctrl.signal, update: () => {}, setPid: () => {}});
  assert.deepEqual(r.firstFrame?.map((x) => [x.pass, x.repaired]), [['render', true]]);
  assert.ok(!blankLead(frameStats(r.path)), 'the export has footage on frame 0');
  assert.equal(count(r.path), count(src));
  assert.match(logs.join('\n'), /frame 0 of the render was a flat field .* At t = 0: .*"src":"clips\/a.mp4"/);
  // a clean pass is left alone (no re-encode, no note)
  const clean = clip(path.join(d, 'clean.mp4'), {lead: 0});
  const run2 = createRenderRunner({root: d, publicDir: pub, log: () => {}, commands: {render: ({outFile}) => ['cp', [clean, outFile]]}});
  const r2 = await run2({id: 'j2', draft: true}, {props: JSON.stringify(props), signal: ctrl.signal, update: () => {}, setPid: () => {}});
  assert.equal(r2.firstFrame, undefined);
  assert.equal(fs.readFileSync(r2.path).equals(fs.readFileSync(clean)), true, 'byte for byte the pass output');
  fs.rmSync(d, {recursive: true, force: true});
});

// layers mode over a master already in the cache (cached before the guard existed): the hit is
// checked and repaired in place, and what ships is checked too
async function layersRun({captions}) {
  const d = tmp();
  const pub = path.join(d, 'public'); fs.mkdirSync(pub);
  const cache = createMasterCache(path.join(d, 'masters'));
  const blank = clip(path.join(d, 'blank.mp4'));
  const part = path.join(cache.dir, 'k.part-seed.mp4');
  fs.copyFileSync(blank, part);
  cache.put('k', part); // the blank master production already has
  const logs = [];
  const run = createRenderRunner({
    root: d, publicDir: pub, masterCache: cache, log: (m) => logs.push(m),
    chooseMode: (requested) => ({mode: requested, reasons: [], captions}),
    keyOf: () => 'k',
    commands: {
      master: () => { throw new Error('the master must come from the cache'); },
      // a caption layer that is an empty folder, and a composite that lays nothing over the master
      captions: ({outFile}) => ['mkdir', ['-p', outFile]],
      composite: ({master, outFile}) => ['cp', [master, outFile]],
    },
  });
  const r = await run({id: `j-${captions ? 'c' : 'n'}`, draft: true, mode: 'layers'}, {props: JSON.stringify({clips: [{id: 'c0', src: 'clips/a.mp4', inSec: 0, outSec: 1}], captions: []}), signal: new AbortController().signal, update: () => {}, setPid: () => {}});
  return {d, r, cache, logs, blank};
}

test('layers, cache hit: a cached master with a blank frame 0 is repaired in the cache, and the export is footage (no captions: copy)', async () => {
  const {d, r, cache, logs, blank} = await layersRun({captions: false});
  assert.equal(r.master, 'cached');
  assert.deepEqual(r.firstFrame.map((x) => x.pass), ['cached master'], 'repaired once, at the source: the copy is already clean');
  assert.ok(!blankLead(frameStats(cache.get('k'))), 'the cache healed: the next hit is clean');
  assert.ok(!blankLead(frameStats(r.path)), 'the export has footage on frame 0');
  assert.equal(count(r.path), count(blank));
  assert.equal(fs.readdirSync(cache.dir).filter((f) => f.includes('.part-')).length, 0, 'no repair leftovers in the cache');
  assert.match(logs.join('\n'), /frame 0 of the cached master was a flat field/);
  fs.rmSync(d, {recursive: true, force: true});
});

test('layers, cache hit with captions: repaired before the composite, so a caption on frame 0 never ships over the field', async () => {
  const {d, r, cache} = await layersRun({captions: true});
  assert.deepEqual(r.firstFrame.map((x) => x.pass), ['cached master']);
  assert.ok(!blankLead(frameStats(cache.get('k'))));
  assert.ok(!blankLead(frameStats(r.path)));
  fs.rmSync(d, {recursive: true, force: true});
});

test('the export itself is checked: a composite that comes out with a blank frame 0 is repaired', async () => {
  const d = tmp();
  const pub = path.join(d, 'public'); fs.mkdirSync(pub);
  const cache = createMasterCache(path.join(d, 'masters'));
  const good = clip(path.join(d, 'good.mp4'), {lead: 0});
  const part = path.join(cache.dir, 'k.part-seed.mp4'); fs.copyFileSync(good, part); cache.put('k', part);
  const blank = clip(path.join(d, 'blank.mp4'));
  const run = createRenderRunner({
    root: d, publicDir: pub, masterCache: cache, log: () => {},
    chooseMode: (requested) => ({mode: requested, reasons: [], captions: true}), keyOf: () => 'k',
    commands: {captions: ({outFile}) => ['mkdir', ['-p', outFile]], composite: ({outFile}) => ['cp', [blank, outFile]]},
  });
  const r = await run({id: 'j3', draft: true, mode: 'layers'}, {props: JSON.stringify({clips: [{id: 'c0', src: 'clips/a.mp4', inSec: 0, outSec: 1}]}), signal: new AbortController().signal, update: () => {}, setPid: () => {}});
  assert.deepEqual(r.firstFrame.map((x) => x.pass), ['composite']);
  assert.ok(!blankLead(frameStats(r.path)));
  fs.rmSync(d, {recursive: true, force: true});
});

test('the master key covers the guard: a change to scripts/first-frame.mjs is a new code version (old cached masters are not reused)', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'scripts'));
  fs.writeFileSync(path.join(d, 'scripts', 'first-frame.mjs'), 'a');
  const v = codeVersion(d);
  fs.writeFileSync(path.join(d, 'scripts', 'first-frame.mjs'), 'b');
  assert.notEqual(codeVersion(d), v);
  fs.rmSync(d, {recursive: true, force: true});
});

test('the opening report names what the reel has at t = 0', () => {
  const r = openingReport({
    clips: [{id: 'c0', src: 'clips/a.mp4', inSec: 0, outSec: 3, enter: 'zoom'}],
    grade: {look: 'clean', auto: true, baked: {'clips/a.mp4|luts/x.cube': 'clips/lut/a.mp4'}},
    brolls: [{id: 'b0', clipId: 'c0', startMs: 0, endMs: 900, mode: 'fullscreen'}, {id: 'b1', clipId: 'c0', startMs: 2000, endMs: 2500, mode: 'inset'}],
    graphics: [{id: 'g0', src: 'clips/a.mp4', startMs: 0, endMs: 1000, template: 'layout', props: {canvas: 'dark'}}],
    captionStyle: 'vibem',
  });
  assert.deepEqual(r.clip, {id: 'c0', src: 'clips/a.mp4', inSec: 0, speed: 1, enter: 'zoom', transform: false, jSec: 0});
  assert.deepEqual(r.brolls, ['b0:fullscreen']);
  assert.deepEqual(r.graphics, ['g0:layout/dark']);
  assert.equal(r.grade.auto, true);
  assert.deepEqual(r.grade.media, ['clips/a.mp4|luts/x.cube']);
});

// A real Remotion render (Chrome, ~30 s): 1 s of a synthetic clip from inSec 0, then frame 0
// must be footage. Opt-in: REEL_RENDER_TESTS=1 node --test test/first-frame.test.mjs
test('Remotion: frame 0 of a render is the first clip, not a flat field', {skip: process.env.REEL_RENDER_TESTS !== '1' && 'set REEL_RENDER_TESTS=1 (needs Chrome, ~30 s)'}, () => {
  const d = tmp();
  const pub = path.join(d, 'public'); fs.mkdirSync(path.join(pub, 'clips'), {recursive: true});
  clip(path.join(pub, 'clips', 'a.mp4'), {lead: 0, sec: 2});
  const links = linkPublic(pub, path.join(d, 'links'));
  const propsFile = path.join(d, 'props.json');
  fs.writeFileSync(propsFile, JSON.stringify({clips: [{id: 'a', src: 'clips/a.mp4', inSec: 0, outSec: 1, sourceDurationSec: 2}], captions: [], brolls: [], graphics: [], mattes: [], music: null, captionStyle: 'palabra', captionsOff: true, grade: {look: 'clean', intensity: 0.8, auto: false, bySrc: {}}}));
  const out = path.join(d, 'out.mp4');
  const r = spawnSync('npx', ['remotion', 'render', 'MultiClip', out, `--props=${propsFile}`, `--public-dir=${links}`, '--concurrency=2', '--scale=0.5'], {cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26});
  assert.equal(r.status, 0, r.stderr.slice(-800));
  const s = frameStats(out);
  assert.ok(!isFlat(s[0]), `frame 0 is a flat field: Y ${s[0]?.ymin}–${s[0]?.ymax}, U ${s[0]?.uavg}, V ${s[0]?.vavg}`);
  fs.rmSync(d, {recursive: true, force: true});
});
