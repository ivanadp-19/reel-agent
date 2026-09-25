import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chooseRenderMode, layerBlockers} from '../src/layers.ts';
import {PRESETS} from '../src/captionPresets.ts';
import {canonical, captionArgs, codeVersion, compositeArgs, createMasterCache, masterArgs, masterInputs, masterKey, mediaStamps} from '../scripts/layers.mjs';

const FPS = 30;
const clips = [
  {id: 'a', src: 'clips/a.mp4', inSec: 0, outSec: 4, sourceDurationSec: 10},
  {id: 'b', src: 'clips/b.mp4', inSec: 1, outSec: 5, sourceDurationSec: 10, enter: 'whip'},
];
const page = (id, src, startMs, words, extra = {}) => ({id, src, startMs, endMs: startMs + words.length * 300, topPct: 60,
  words: words.map((w, i) => ({text: typeof w === 'string' ? w : w[0], tier: typeof w === 'string' ? 0 : w[1], startMs: startMs + i * 300, endMs: startMs + i * 300 + 250})), ...extra});
const captions = [page('p0', 'clips/a.mp4', 500, ['la', 'casa', ['bonita', 1]]), page('p1', 'clips/b.mp4', 1500, ['en', ['Montealbán', 2], '326'])];
const reel = (over = {}) => ({clips, captions, brolls: [], graphics: [], mattes: [], music: null, accentColor: '#FFB020', captionStyle: 'palabra', brand: null, grade: null, audio: null, ...over});

test('mode: full unless layers is asked; layers when nothing reaches into the footage', () => {
  assert.equal(chooseRenderMode(undefined, reel(), FPS).mode, 'full');
  assert.equal(chooseRenderMode('full', reel(), FPS).mode, 'full');
  const r = chooseRenderMode('layers', reel(), FPS);
  assert.deepEqual([r.mode, r.reasons, r.captions], ['layers', [], true]);
});

test('fallback: captions behind the presenter force the one-pass render', () => {
  const behind = [captions[0], {...captions[1], behind: true}];
  const r = chooseRenderMode('layers', reel({captions: behind}), FPS);
  assert.equal(r.mode, 'full');
  assert.match(r.reasons.join(), /behind the presenter/);
});

test('fallback: focus pull / hero punch / glitch pulse only when the words that trigger them are on screen', () => {
  // prism blurs the footage under tier-2 words
  assert.match(layerBlockers(reel({captionStyle: 'prism'}), FPS).join(), /focus pull/);
  const noHero = captions.map((c) => ({...c, words: c.words.map((w) => ({...w, tier: Math.min(w.tier, 1)}))}));
  assert.deepEqual(layerBlockers(reel({captionStyle: 'prism', captions: noHero}), FPS), [], 'no tier-2 word: no blur, layers fine');
  // impact punches on tier 2 and pulses on tier 1
  const impact = layerBlockers(reel({captionStyle: 'impact'}), FPS).join();
  assert.match(impact, /hero punch/); assert.match(impact, /glitch pulse/);
  // evo's glass pages blur whatever is behind them
  assert.match(layerBlockers(reel({captionStyle: 'evo'}), FPS).join(), /glass/);
});

test('captions off: no caption layer, no blocker (the master is the reel)', () => {
  const r = chooseRenderMode('layers', reel({captionStyle: 'prism', captionsOff: true}), FPS);
  assert.deepEqual([r.mode, r.captions], ['layers', false]);
});

test('every pack is either layer-safe or names why not', () => {
  const blocked = Object.keys(PRESETS).filter((id) => {
    const all = captions.map((c) => ({...c, words: c.words.map((w, i) => ({...w, tier: i % 3}))}));
    return layerBlockers(reel({captionStyle: id, captions: all}), FPS).length > 0;
  });
  assert.ok(blocked.includes('prism') && blocked.includes('impact') && blocked.includes('evo'));
  assert.ok(!blocked.includes('palabra') && !blocked.includes('vibem'));
});

test('canonical JSON: object keys sorted, arrays keep their order', () => {
  assert.equal(canonical({b: 1, a: [2, 1], c: undefined}), '{"a":[2,1],"b":1}');
  assert.notEqual(canonical({a: [1, 2]}), canonical({a: [2, 1]}));
});

const key = (props, over = {}) => masterKey(props, {code: 'c1', fps: FPS, ...over});
test('master key: a caption edit keeps the master', () => {
  const k = key(reel());
  const edited = structuredClone(captions);
  edited[0].words[1].text = 'CASA'; // spelling
  edited[1].words[0].tier = 1; // emphasis
  edited[1].topPct = 40; edited[1].pin = true; // position
  assert.equal(key(reel({captions: edited})), k);
  assert.equal(key(reel({captionsOff: true})), k, 'the switch is drawn by the caption layer');
  assert.equal(key(reel({audio: {clean: 'strong'}})), key(reel({audio: {}})), 'voice cleanup runs after the composite');
  assert.equal(key({...reel(), mode: 'layers', draft: false}), k, 'render options are not inputs');
  assert.equal(key(JSON.parse(JSON.stringify(reel()))), k, 'stable across serialization');
});

test('master key: what the master draws makes a new one', () => {
  const k = key(reel());
  const trimmed = structuredClone(clips); trimmed[1].outSec = 4.5;
  assert.notEqual(key(reel({clips: trimmed})), k, 'a cut');
  assert.notEqual(key(reel({clips: [clips[1], clips[0]]})), k, 'the order of the takes');
  assert.notEqual(key(reel({captionStyle: 'focus'})), k, 'the pack styles titles, B-roll motion and the accent too');
  assert.notEqual(key(reel({grade: {look: 'warm', intensity: 1, auto: false, bySrc: {}}})), k, 'color');
  assert.notEqual(key(reel({audio: {sfx: true}})), k, 'sound effects');
  const g = [{id: 'g1', src: 'clips/a.mp4', startMs: 0, endMs: 900, template: 'stat', props: {value: '1'}}, {id: 'g2', src: 'clips/a.mp4', startMs: 0, endMs: 900, template: 'stat', props: {value: '2'}}];
  assert.notEqual(key(reel({graphics: g})), key(reel({graphics: [g[1], g[0]]})), 'z-order of the graphics');
  assert.notEqual(key(reel(), {code: 'c2'}), k, 'the code');
  assert.notEqual(key(reel(), {draft: true}), k, 'draft scale');
  assert.notEqual(key(reel(), {width: 720, height: 1280}), k, 'frame size');
  assert.notEqual(key(reel(), {fps: 25}), k, 'fps');
});

test('master key: with ducked music the speech spans are inputs, without it they are not', () => {
  const music = {src: 'music/m.mp3', volume: 0.25, duck: true};
  const retimed = structuredClone(captions); retimed[0].startMs += 400; retimed[0].words.forEach((w) => { w.startMs += 400; w.endMs += 400; }); retimed[0].endMs += 400;
  assert.notEqual(key(reel({music, captions: retimed})), key(reel({music})), 'the music ducks somewhere else');
  assert.equal(key(reel({music: {...music, duck: false}, captions: retimed})), key(reel({music: {...music, duck: false}})));
  assert.ok(masterInputs(reel({music}), FPS).duckSpeech.length === 2);
});

test('master key: a media file replaced under the same name is a new master', () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'layers-pub-'));
  fs.mkdirSync(path.join(pub, 'clips'));
  fs.writeFileSync(path.join(pub, 'clips/a.mp4'), 'one');
  fs.writeFileSync(path.join(pub, 'clips/b.mp4'), 'two');
  const k = key(reel(), {publicDir: pub});
  assert.deepEqual(mediaStamps(reel(), pub).map(([f]) => f), ['clips/a.mp4', 'clips/b.mp4']);
  fs.writeFileSync(path.join(pub, 'clips/a.mp4'), 'one, re-exported');
  assert.notEqual(key(reel(), {publicDir: pub}), k);
  fs.rmSync(pub, {recursive: true, force: true});
});

test('code version: content of the drawing code, not its mtimes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'layers-code-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/A.tsx'), 'a');
  const v = codeVersion(root);
  fs.utimesSync(path.join(root, 'src/A.tsx'), new Date(1), new Date(1));
  assert.equal(codeVersion(root), v);
  fs.writeFileSync(path.join(root, 'src/A.tsx'), 'b');
  assert.notEqual(codeVersion(root), v);
  fs.rmSync(root, {recursive: true, force: true});
});

test('master cache: hit, miss, least recently used dropped past the budget', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layers-cache-'));
  const cache = createMasterCache(dir, 25);
  const put = (k, t) => { const f = path.join(dir, `${k}.part-1.mp4`); fs.writeFileSync(f, 'x'.repeat(10)); cache.put(k, f); fs.utimesSync(cache.file(k), new Date(t), new Date(t)); };
  assert.equal(cache.get('k1'), null);
  put('k1', 1000); put('k2', 2000);
  assert.ok(cache.get('k1')); // touched: now the newest
  put('k3', Date.now() + 1000); // 30 bytes > 25: the oldest (k2) goes
  assert.equal(cache.get('k2'), null);
  assert.ok(cache.get('k1') && cache.get('k3'));
  fs.rmSync(dir, {recursive: true, force: true});
});

test('layer args: master = h264 without captions at a lower crf; captions = PNG frames into an alpha codec, muted', () => {
  const o = {outFile: 'o', propsFile: 'p', publicDir: 'pub', concurrency: 2, cacheBytes: 1, draft: false};
  const m = masterArgs(o);
  assert.ok(m.includes('--crf=16') && m.includes('--x264-preset=veryfast') && !m.includes('--scale=0.5'));
  const c = captionArgs(o);
  assert.ok(['--image-format=png', '--codec=vp9', '--pixel-format=yuva420p', '--muted'].every((a) => c.includes(a)));
  assert.ok(captionArgs({...o, alpha: 'prores'}).includes('--prores-profile=4444'));
  assert.ok(captionArgs({...o, draft: true}).includes('--scale=0.5'));
});

test('composite: frame-exact (renumbered by frame index), libvpx decodes the alpha, audio copied, layers stack', () => {
  const a = compositeArgs({master: 'm.mp4', overlays: [{file: 'c.webm'}], outFile: 'o.mp4', fps: 30});
  const fc = a[a.indexOf('-filter_complex') + 1];
  assert.match(fc, /\[0:v\]setpts=N\/\(30\*TB\)/);
  assert.match(fc, /\[1:v\]setpts=N\/\(30\*TB\)/);
  assert.ok(a.indexOf('libvpx-vp9') < a.indexOf('c.webm'), 'the decoder is named before its input');
  assert.deepEqual(a.slice(a.indexOf('-c:a'), a.indexOf('-c:a') + 2), ['-c:a', 'copy']);
  const two = compositeArgs({master: 'm.mp4', overlays: [{file: 'c.webm'}, {file: 'x.mov', alpha: 'prores'}], outFile: 'o.mp4', fps: 30});
  assert.match(two[two.indexOf('-filter_complex') + 1], /\[l1\]\[o1\]overlay/);
});
