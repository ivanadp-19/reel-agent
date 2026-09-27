import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {captionLayout, chooseRenderMode, layerBlockers, originalMaster, supersBlockers} from '../src/layers.ts';
import {PRESETS} from '../src/captionPresets.ts';
import {SOLID_DENSER, TEMPLATES, backing, fieldsOf, isTextGraphic} from '../src/graphicTemplates.ts';
import {projectRenderProps, withDeliveryFps} from '../src/renderProps.ts';
import {planRender} from '../scripts/render-runner.mjs';
import {validateProject} from '../src/validate.ts';
import {alphaEncodeArgs, canonical, captionArgs, codeVersion, compositeArgs, createMasterCache, masterArgs, masterInputs, masterKey, masterProps, mediaStamps, parityIssues, parityProbeArgs, parseParity, remuxArgs} from '../scripts/layers.mjs';

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
  const tagged = structuredClone(clips); tagged[0].graded = true; tagged[1].location = 'Rooftop'; tagged[1].piece = 'body';
  assert.equal(key(reel({clips: tagged})), k, 'set_clip graded / location / piece draws nothing');
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

test('layer args: master = h264 without captions at a lower crf; captions = PNG frames, muted, encoded by ffmpeg when asked', () => {
  const o = {outFile: 'o', propsFile: 'p', publicDir: 'pub', concurrency: 2, cacheBytes: 1, draft: false};
  const m = masterArgs(o);
  assert.ok(m.includes('--crf=16') && m.includes('--x264-preset=veryfast') && !m.includes('--scale=0.5'));
  const c = captionArgs(o);
  assert.ok(['--sequence', '--image-format=png', '--muted'].every((a) => c.includes(a)));
  assert.ok(captionArgs({...o, draft: true}).includes('--scale=0.5'));
  assert.equal(alphaEncodeArgs({frames: 'f', outFile: 'x', alpha: 'png', fps: 30}), null, 'png: the frames are the layer');
  const vp9 = alphaEncodeArgs({frames: 'f', outFile: 'c.webm', alpha: 'vp9', fps: 30});
  assert.ok(['libvpx-vp9', 'yuva420p', 'realtime'].every((a) => vp9.includes(a)) && vp9.includes(path.join('f', '*.png')));
  const prores = alphaEncodeArgs({frames: 'f', outFile: 'c.mov', alpha: 'prores', fps: 30});
  assert.ok(prores.includes('yuva444p10le') && /out_color_matrix=bt709.*setparams=.*colorspace=bt709/.test(prores.join(' ')), 'Rec.709, tagged');
});

test('composite: frame-exact (renumbered by frame index), libvpx decodes the alpha, audio copied, layers stack', () => {
  const png = compositeArgs({master: 'm.mp4', overlays: [{file: 'frames'}], outFile: 'o.mp4', fps: 30});
  assert.ok(png.includes(path.join('frames', '*.png')) && png.includes('glob'), 'the PNG frames by default');
  const a = compositeArgs({master: 'm.mp4', overlays: [{file: 'c.webm', alpha: 'vp9'}], outFile: 'o.mp4', fps: 30});
  const fc = a[a.indexOf('-filter_complex') + 1];
  assert.match(fc, /\[0:v\]settb=1\/30,setpts=N\[/);
  assert.match(fc, /\[1:v\]settb=1\/30,setpts=N,/);
  assert.match(fc, /ts_sync_mode=nearest/, 'equal timestamps pair, never the previous frame');
  assert.ok(a.indexOf('libvpx-vp9') < a.indexOf('c.webm'), 'the decoder is named before its input');
  assert.deepEqual(a.slice(a.indexOf('-c:a'), a.indexOf('-c:a') + 2), ['-c:a', 'copy']);
  // a full-range master (what Remotion writes) stays full range, its layers converted into it, its tags kept
  const pc = compositeArgs({master: 'm.mp4', overlays: [{file: 'frames'}], outFile: 'o.mp4', fps: 30, color: {range: 'pc', space: 'bt470bg', trc: 'unknown'}});
  const pfc = pc[pc.indexOf('-filter_complex') + 1];
  assert.match(pfc, /scale=out_color_matrix=bt601:out_range=pc,format=yuva420p/, 'into the master\'s matrix, named (the ProRes layers are 709)');
  const hd = compositeArgs({master: 'm.mp4', overlays: [{file: 'x.mov', alpha: 'prores'}], outFile: 'o.mp4', fps: 30, color: {space: 'bt709'}});
  assert.match(hd[hd.indexOf('-filter_complex') + 1], /scale=out_color_matrix=bt709:out_range=tv,/);
  assert.match(pfc, /format=yuvj420p\[v\]/);
  assert.ok(pc.includes('bt470bg') && !pc.includes('-color_trc'));
  assert.match(fc, /format=yuv420p\[v\]/, 'limited range stays limited');
  const two = compositeArgs({master: 'm.mp4', overlays: [{file: 'frames'}, {file: 'x.mov', alpha: 'prores'}], outFile: 'o.mp4', fps: 30});
  assert.match(two[two.indexOf('-filter_complex') + 1], /\[l1\]\[o1\]overlay/);
});

test('the pair: the master remuxed without re-encoding (its picture, the final audio), parity by header frames / rate / length', () => {
  const r = remuxArgs({video: 'm.part-pair-1.mp4', audio: 'edited-1.mp4', outFile: 'master.mp4'});
  assert.deepEqual(r.slice(r.indexOf('-map'), r.indexOf('-map') + 4), ['-map', '0:v:0', '-map', '1:a:0'], 'picture from the master, audio from the finalized composite');
  assert.deepEqual(r.slice(r.indexOf('-c'), r.indexOf('-c') + 2), ['-c', 'copy']);
  assert.ok(!r.includes('libx264') && r.includes('+faststart') && r.at(-1) === 'master.mp4');
  assert.ok(r.indexOf('m.part-pair-1.mp4') < r.indexOf('edited-1.mp4'));
  const p = parityProbeArgs('c.mov');
  assert.ok(p.includes('stream=nb_frames,r_frame_rate,duration') && p.includes('v:0') && p.at(-1) === 'c.mov' && !p.includes('-count_frames'), 'header only, no decode');
  const m = parseParity(JSON.stringify({streams: [{nb_frames: '300', r_frame_rate: '30/1', duration: '10.000000'}]}));
  assert.deepEqual(m, {frames: 300, fps: '30/1', sec: 10});
  assert.deepEqual(parityIssues(m, {frames: 300, fps: '30/1', sec: 10.01}), [], 'a length within half a frame (other timescale) is the same');
  assert.match(parityIssues(m, {...m, frames: 299}).join(), /frames: master 300, captions 299/);
  assert.match(parityIssues(m, {...m, fps: '25/1'}).join(), /fps/);
  assert.match(parityIssues(m, {...m, sec: 10.02}).join(), /duration/);
  assert.equal(parityIssues(parseParity('{"streams":[{}]}'), parseParity('{"streams":[{}]}')).length, 3, 'nothing read is never a match');
});

// ---- the supers: a client's text graphics as their own layer ----
test('supers: every template is text (a super) or not (stays in the master) — read from the components, checked against the schemas', () => {
  // what each component draws (src/Graphics.tsx): its words, or none (decor, frames, layouts, the person outline)
  const TEXT = {
    'hook-stack': true, 'label-2tone': true, stat: true, chapter: true, 'big-word': true, 'kinetic-card': true, 'fill-title': true, 'script-title': true,
    oversized: true, 'chapter-caps': true, starburst: true, 'location-tag': true, price: true, 'end-card': true, 'band-title': true, 'clean-blue': true,
    layout: false, sticker: false, ornament: false, rules: false, 'person-outline': false, 'neon-frame': false, scribble: false, 'outline-rect': false, 'frame-light': false,
  };
  assert.deepEqual(Object.keys(TEXT).sort(), Object.keys(TEMPLATES).sort(), 'every template is classified — a new one needs a line here');
  for (const [id, text] of Object.entries(TEXT)) assert.equal(isTextGraphic(id), text, id);
  // the second source: a template takes free text exactly when it is a super (a string prop other than an image path, or a list of lines)
  const freeText = (fields) => fields.some((f) => (f.kind === 'string' && f.key !== 'src') || (f.kind === 'array' && freeText(f.item ?? [])));
  for (const id of Object.keys(TEMPLATES)) assert.equal(freeText(fieldsOf(TEMPLATES[id].schema)), TEXT[id], id);
  assert.equal(isTextGraphic('a-template-added-later'), true, 'unknown until listed: never leaks text into a master');
});

const gfx = (id, template, props, over = {}) => ({id, src: 'clips/a.mp4', startMs: 500, endMs: 1500, template, props, ...over});
const titled = [gfx('g1', 'stat', {value: '3', label: 'rooms'}, {camera: 'punch'}), gfx('g2', 'sticker', {src: 'assets/x.png'}), gfx('g3', 'neon-frame', {})];

test('supers: a client\'s master (textOff) draws the decor and keeps every camera push; the supers layer draws only the text graphics', () => {
  const all = captionLayout(reel({graphics: titled}), FPS);
  const off = captionLayout(reel({graphics: titled, textOff: true}), FPS);
  assert.deepEqual(all.drawnGraphics.map((g) => g.id), ['g1', 'g2', 'g3'], 'without textOff: every graphic, as always');
  assert.deepEqual(off.drawnGraphics.map((g) => g.id), ['g2', 'g3'], 'the master keeps the sticker and the frame');
  assert.deepEqual(off.supers.map((g) => g.id), ['g1']);
  assert.deepEqual(off.zooms, all.zooms, 'the stat\'s punch still moves the footage of the master');
  assert.deepEqual(off.zooms.map((z) => [z.startMs, z.scale]), [[400, 0.4]]);
  assert.deepEqual(off.projectedGraphics, all.projectedGraphics, 'the captions still step around every graphic');
});

test('supers: a text graphic behind the presenter cannot be its own layer — a blocker only for a client\'s deliverables; decor behind is not', () => {
  const behind = [gfx('g1', 'stat', {value: '3'}, {behind: true}), gfx('g2', 'sticker', {src: 'assets/x.png'}, {behind: true})];
  assert.deepEqual(supersBlockers(reel({graphics: behind}), FPS), ['text graphic behind the presenter: stat g1 (drawn under the person matte, it cannot be its own supers layer)']);
  const r = chooseRenderMode('layers', reel({graphics: behind}), FPS, {supers: true});
  assert.deepEqual([r.mode, r.reasons.length], ['full', 1]);
  assert.deepEqual(chooseRenderMode('layers', reel({graphics: behind}), FPS), {mode: 'layers', reasons: [], captions: true}, 'R-2: without identity it layers as always');
  assert.deepEqual(chooseRenderMode('layers', reel({graphics: titled}), FPS, {supers: true}).reasons, [], 'front text graphics split fine');
});

test('supers: a glass plate is no blocker — a client\'s deliverables draw it solid; behind the presenter still is', () => {
  const glass = [gfx('g1', 'label-2tone', {top: 'Cocina'}), gfx('g2', 'location-tag', {place: 'Tulum'}, {startMs: 2000, endMs: 3000})];
  assert.deepEqual(supersBlockers(reel({graphics: glass}), FPS), [], 'label-2tone\'s plate and location-tag\'s pill split fine');
  assert.deepEqual(chooseRenderMode('layers', reel({graphics: glass}), FPS, {supers: true}), {mode: 'layers', reasons: [], captions: true});
  assert.deepEqual(supersBlockers(reel({graphics: [gfx('g1', 'label-2tone', {top: 'Cocina', plate: 'glass'}, {behind: true})]}), FPS),
    ['text graphic behind the presenter: label-2tone g1 (drawn under the person matte, it cannot be its own supers layer)']);
  assert.deepEqual(chooseRenderMode('layers', reel({graphics: glass}), FPS).reasons, [], 'R-2: without identity it layers as always');
});

test('solid plates: with an identity the plate and the pill have no backdrop blur and a denser tint; without, glass as before (R-2)', () => {
  assert.deepEqual(backing('plate'), {background: 'rgba(8,10,14,0.42)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)'}, 'the glass of before, exactly');
  assert.deepEqual(backing('pill'), {background: 'rgba(0,0,0,0.38)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)'});
  assert.deepEqual(backing('plate', true), {background: `rgba(8,10,14,${0.42 + SOLID_DENSER})`});
  assert.deepEqual(backing('pill', true), {background: `rgba(0,0,0,${0.38 + SOLID_DENSER})`});
  // Graphics.tsx: both templates take their backing from there, and nothing else in it blurs what is behind
  const src = fs.readFileSync(new URL('../src/Graphics.tsx', import.meta.url), 'utf8');
  assert.match(src, /\.\.\.backing\('plate', solid\), borderRadius: 26, padding: '16px 36px 20px'/);
  assert.match(src, /padding: '18px 36px 18px 26px', borderRadius: 999, \.\.\.backing\('pill', solid\)/);
  assert.doesNotMatch(src, /backdropFilter/);
  // every pass of a client's reel (master, supers, composite, draft) gets it from the saved project; the editor too
  const IDENTITY = {client: 'acme', family: 'acme-G2', script: 2, variant: {hook: 1, cta: 1}};
  const p = reel({graphics: [gfx('g1', 'label-2tone', {top: 'Cocina'})]});
  assert.equal(projectRenderProps({...p, identity: IDENTITY}).solidPlates, true);
  assert.ok(!('solidPlates' in projectRenderProps(p)), 'R-2: no identity, no key');
  assert.ok(!('solidPlates' in withDeliveryFps({...p, solidPlates: true}, {})), 'a body cannot ask for them');
  assert.equal(withDeliveryFps(p, {identity: IDENTITY}).solidPlates, true, 'drafts too');
  const editor = fs.readFileSync(new URL('../editor/Editor.tsx', import.meta.url), 'utf8');
  assert.match(editor, /const inputProps = useMemo\(\s*\(\) => withDeliveryFps\(\{[^}]*\}, \{identity\}\)/, 'the preview is what the render draws');
  const video = fs.readFileSync(new URL('../src/MultiClipVideo.tsx', import.meta.url), 'utf8');
  assert.equal(video.match(/<GraphicsLayer [^>]*solidPlates=\{solidPlates\}/g)?.length, 3, 'supers, behind and front graphics');
  // the text-free master keys as before (it draws no plate); a master that draws text keys its plates
  const client = withDeliveryFps(p, {identity: IDENTITY});
  const {solidPlates: _, ...glassOnly} = client;
  assert.equal(key(masterProps(client, {text: false})), key(masterProps(glassOnly, {text: false})));
  assert.notEqual(key(masterProps(client)), key(masterProps(glassOnly)));
});

test('planRender: a client\'s final with glass plates no longer fails — it layers (supers carry the solid plate)', () => {
  const IDENTITY = {client: 'acme', family: 'acme-G2', script: 2, variant: {hook: 1, cta: 1}};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-plates-'));
  try {
    const props = projectRenderProps({...reel({graphics: [gfx('g1', 'label-2tone', {top: 'Cocina'}), gfx('g2', 'location-tag', {place: 'Tulum'}, {startMs: 2000, endMs: 3000})]}), identity: IDENTITY});
    const plan = planRender(props, {requested: 'layers', pair: true, root, publicDir: root, masterCache: {file: (k) => path.join(root, `${k}.mp4`)}});
    assert.ok(!plan.fails, plan.reasons.join('; '));
    assert.equal(plan.mode, 'layers');
    const behind = projectRenderProps({...reel({graphics: [gfx('g1', 'label-2tone', {top: 'Cocina'}, {behind: true})]}), identity: IDENTITY});
    assert.equal(planRender(behind, {requested: 'layers', pair: true, root, publicDir: root, masterCache: {file: (k) => path.join(root, `${k}.mp4`)}}).fails, true, 'behind still fails');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('supers: decor the one-pass render draws over a text graphic is under it in a client\'s deliverables — validate warns (supers-order), only with an identity', () => {
  const order = (graphics, identity = {client: 'acme', script: 2}) => validateProject({clips, captions: [], graphics, identity}, FPS).filter((i) => i.code === 'supers-order');
  const later = [gfx('g1', 'stat', {value: '3'}), gfx('g2', 'scribble', {}, {startMs: 900, endMs: 1400})];
  assert.deepEqual(order(later).map((i) => [i.ref, /over g1 \(stat\)/.test(i.msg)]), [['g2', true]]);
  assert.deepEqual(order(later, null), [], 'no identity: one pass, nothing differs');
  assert.deepEqual(order([gfx('g2', 'sticker', {src: 'assets/x.png'}, {startMs: 400}), gfx('g1', 'stat', {value: '3'})]), [], 'decor first: under the text in both');
  assert.deepEqual(order([gfx('g1', 'stat', {value: '3'}), gfx('g2', 'sticker', {src: 'assets/x.png'}, {startMs: 1600, endMs: 2200})]), [], 'apart in time');
  assert.deepEqual(order([gfx('g1', 'stat', {value: '3'}), gfx('g2', 'sticker', {src: 'assets/x.png'}, {startMs: 900, behind: true}), gfx('g3', 'frame-light', {}, {startMs: 900})]), [], 'behind and edge-to-edge decor never cover a text graphic in front');
});

test('supers: the text-free master has a key of its own; a master without identity keeps the key it had', () => {
  const r = reel({graphics: titled});
  assert.equal(key(masterProps(r)), key(r), 'captionsOff alone is not an input: the same master as before');
  assert.notEqual(key(masterProps(r, {text: false})), key(r), 'a master without text never reuses one with text');
  assert.equal(masterProps(r, {text: false}).textOff, true);
  assert.ok(!('textOff' in masterProps(r)));
});

test('supers: parity names the file; the composite stacks supers under captions (the names: test/identity.test.mjs)', () => {
  const m = {frames: 300, fps: '30000/1001', sec: 10.01};
  assert.deepEqual(parityIssues(m, {...m, frames: 299}, {name: 'supers'}), ['frames: master 300, supers 299']);
  assert.match(parityIssues(m, {...m, sec: 11}, {name: 'master_supers'}).join(), /duration: master 10.01s, master_supers 11s/);
  const a = compositeArgs({master: 'm.mp4', overlays: [{file: 'supers.mov', alpha: 'prores'}, {file: 'frames'}], outFile: 'o.mp4', fps: 30000 / 1001});
  assert.ok(a.indexOf('supers.mov') < a.indexOf(path.join('frames', '*.png')), 'supers is input 1, the captions input 2');
  assert.match(a[a.indexOf('-filter_complex') + 1], /\[l0\]\[o0\]overlay.*\[l1\]\[o1\]overlay/, 'the captions over the supers over the master');
});

test('originalMaster: captions only over one whole untouched clip — its file is the master; anything else the master would draw or play says why not', () => {
  const clip = {id: 'c0', src: 'clips/Morantes2_1.mp4', inSec: 0, outSec: 43.221333, sourceDurationSec: 43.221333};
  const base = {clips: [clip], captions: [], captionStyle: 'vibem', graphics: [], brolls: [], mattes: [], music: null, grade: null, audio: {clean: 'off'}};
  const fps = 30000 / 1001;
  assert.deepEqual(originalMaster(base, ['captions'], fps), {src: 'clips/Morantes2_1.mp4', reasons: []});
  const why = (props, scope = ['captions']) => originalMaster({...base, ...props}, scope, fps).reasons.join('; ');
  assert.match(why({}, null), /does not ask for captions only/);
  assert.match(why({}, ['captions', 'corte']), /does not ask for captions only/);
  assert.match(why({clips: [{...clip, inSec: 1}]}), /c0 is trimmed/);
  assert.equal(why({clips: [{...clip, outSec: 43.221333 - 0.01}]}), '', 'within half a frame: whole');
  assert.match(why({clips: [clip, {...clip, id: 'c1'}]}), /2 clips/);
  assert.match(why({clips: [{...clip, speed: 1.2}]}), /speed, volume/);
  assert.match(why({clips: [{...clip, transform: [{t: 0, scale: 1.1, x: 0, y: 0}]}]}), /keyframes/);
  assert.match(why({graphics: [{id: 'g', template: 'sticker'}]}), /graphics on the reel/);
  assert.match(why({brolls: [{id: 'b'}]}), /B-roll/);
  assert.match(why({music: {src: 'music/x.mp3'}}), /music/);
  assert.match(why({grade: {look: 'warm', intensity: 0.8}}), /a grade on the clip/);
  assert.equal(why({grade: {look: 'none'}}), '', 'a grade that changes nothing is none');
  assert.match(why({audio: {clean: 'light'}}), /audio cleanup/);
  assert.match(why({audio: {sfx: true}}), /SFX/);
  assert.match(why({captionStyle: 'stack'}), /the stack pack opens on the footage \(zoomBlur\)/);
});
