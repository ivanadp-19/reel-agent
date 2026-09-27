import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {validateProject} from '../src/validate.ts';

const clip = {id: 'a', src: 'clips/a.mp4', inSec: 0, outSec: 20, sourceDurationSec: 20};
const W = (text, s, e, tier = 0) => ({wid: `a:${s}`, text, startMs: s, endMs: e, tier});
const page = (id, s, e, words, topPct = 58) => ({id, src: 'clips/a.mp4', words, startMs: s, endMs: e, topPct});
const codes = (issues) => issues.map((i) => i.code);

test('clean project → no issues', () => {
  const p = {clips: [clip], captions: [page('c0', 500, 1500, [W('Tu', 500, 800), W('cava', 900, 1500, 1)])], graphics: [], captionStyle: 'palabra'};
  assert.deepEqual(validateProject(p), []);
});

test('flags safe zones, glue endings, missing mattes and caption/graphic overlap', () => {
  const p = {
    clips: [clip], captionStyle: 'caja',
    captions: [page('c0', 500, 1500, [W('Todo', 500, 800), W('en', 900, 1500)], 5), page('c1', 4000, 5000, [W('ok', 4000, 5000)], 30)],
    graphics: [{id: 'g0', src: 'clips/a.mp4', startMs: 3900, endMs: 6000, template: 'stat', props: {value: '54', label: 'x'}, yPct: 28}, {id: 'g1', src: 'clips/a.mp4', startMs: 9000, endMs: 10000, template: 'big-word', props: {text: 'X'}, behind: true}],
    mattes: [],
  };
  const c = codes(validateProject(p));
  for (const want of ['safe-top', 'glue', 'matte']) assert.ok(c.includes(want), `missing ${want} in ${c}`); // c1 steps below the stat instead of overlapping it
});

test('too many tier-2 words is a warning', () => {
  const words = Array.from({length: 6}, (_, i) => W(`w${i}`, i * 2000, i * 2000 + 500, 2));
  const p = {clips: [clip], captions: words.map((w, i) => page(`c${i}`, w.startMs, w.endMs, [w])), graphics: []};
  assert.ok(codes(validateProject(p)).includes('tier2-density'));
});

test('a stacked hook behind the head is flagged when the head hides most of it; a word above the head is fine', async () => {
  const {validateProject: vp} = await import('../src/validate.ts');
  const clip = {id: 'a', src: 'clips/a.mp4', inSec: 0, outSec: 10, sourceDurationSec: 10};
  const face = {'clips/a.mp4': {found: true, left: 0.315, top: 0.2035, right: 0.585, bottom: 0.413}}; // IMG_1778
  const hook = {id: 'g0', src: 'clips/a.mp4', startMs: 0, endMs: 2500, template: 'hook-stack', behind: true, yPct: 16, props: {lines: [{text: 'THE BIGGEST', size: 'lg', accent: false}, {text: 'LIE ABOUT', size: 'lg', accent: false}, {text: 'MONEY', size: 'xl', accent: true}], upper: false}};
  const word = {id: 'g1', src: 'clips/a.mp4', startMs: 0, endMs: 2500, template: 'big-word', behind: true, yPct: 3, props: {text: 'DEBT', font: 'condensed', color: 'accent', size: 'xl', repeat: false, upper: true}};
  const codes = (g) => vp({clips: [clip], captions: [], graphics: [g], mattes: [{src: 'clips/a.mp4', startMs: 0, endMs: 10000}]}, 30, face).map((i) => i.code);
  assert.ok(codes(hook).includes('behind-hidden'));
  assert.ok(!codes(word).includes('behind-hidden'));
});

test('a caption under the hook moves just below it; with no room it stays and validate reports it', async () => {
  const {avoidGraphics, validateProject: vp} = await import('../src/validate.ts');
  const clip = {id: 'a', src: 'clips/a.mp4', inSec: 0, outSec: 10, sourceDurationSec: 10};
  const hook = {id: 'g0', src: 'clips/a.mp4', startMs: 0, endMs: 2500, template: 'hook-stack', yPct: 45, props: {lines: [{text: 'THE BIGGEST', size: 'lg', accent: false}, {text: 'LIE ABOUT MONEY', size: 'lg', accent: true}], upper: false}};
  const cap = (id, a, b, topPct = 50) => ({id, src: 'clips/a.mp4', words: [{text: 'the', startMs: a, endMs: a + 200}, {text: 'media', startMs: a + 250, endMs: b}], startMs: a, endMs: b, topPct});
  const [moved, later] = avoidGraphics([cap('c0', 500, 1500), cap('c1', 3000, 4000)], [hook], 'focus');
  assert.ok(moved.pin && moved.topPct > 58 && moved.topPct < 75, JSON.stringify(moved));
  assert.equal(later.topPct, 50);
  const codes = (h) => vp({clips: [clip], captions: [cap('c0', 500, 1500)], graphics: [h]}, 30).map((i) => i.code);
  assert.ok(!codes(hook).includes('overlap-graphic'));
  // a 4-line hook at 30–67 % and a huge caption (21 % tall): no room above or below
  const tall = {...hook, yPct: 30, props: {lines: ['A', 'B', 'C', 'D'].map((text) => ({text, size: 'xl', accent: false})), upper: false}};
  const huge = {...cap('c0', 500, 1500), scale: 4};
  assert.equal(avoidGraphics([huge], [tall]).at(0).topPct, 50);
  assert.ok(vp({clips: [clip], captions: [huge], graphics: [tall]}, 30).some((i) => i.code === 'overlap-graphic'));
});

test('transcriptIssues: an off-mic word listed on two pieces of one source counts once, in one run', async () => {
  const {transcriptIssues} = await import('../src/validate.ts');
  const w = (i, s, e, off) => ({i, word: `w${i}`, startMs: s, endMs: e, ...(off ? {off: true} : {})});
  // w1 straddles the split at 1.5 s, so the transcript lists it on both pieces
  const tr = [{clipId: 'a', source: 'S', words: [w(0, 0, 900), w(1, 1000, 2000, true)]}, {clipId: 'b', source: 'S', words: [w(1, 1000, 2000, true), w(2, 2100, 2600, true)]}];
  const clips = [{id: 'a', src: 'clips/S.mp4', inSec: 0, outSec: 1.5, sourceDurationSec: 5}, {id: 'b', src: 'clips/S.mp4', inSec: 1.5, outSec: 3, sourceDurationSec: 5}];
  const off = transcriptIssues({clips}, tr).filter((x) => x.code === 'off-mic');
  assert.match(off.find((x) => x.ref === 'b').msg, /^b: 2 off-mic word\(s\) still in the cut: cut_words S:1…S:2 "w1 w2"/);
});

// two projects, each on its own source: the checks read each one's transcript cache (both engines' names),
// never public/transcript.json — the last transcription run on the machine, here the other project's
test('projectIssues: off-mic and cut-word come from the project\'s own sources, whatever project transcribed last', async () => {
  const {projectIssues, projectWords} = await import('../mcp/checks.mjs');
  const {paint, track} = await import('./loud.mjs');
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-checks-'));
  const dir = path.join(pub, 'clips', 'transcripts');
  fs.mkdirSync(dir, {recursive: true});
  const Wd = (word, a, b) => ({word, startMs: a * 1000, endMs: b * 1000});
  // source A: a quiet take (the voice off the mic), then the loud one; cached under WhisperX's name
  const a = [Wd('one', 1, 1.3), Wd('two', 1.35, 1.9), Wd('three.', 1.95, 2.4), Wd('one', 3, 3.3), Wd('two', 3.35, 3.9), Wd('three.', 3.95, 4.4), Wd('four', 4.6, 4.9), Wd('five', 4.95, 5.3), Wd('six.', 5.35, 5.8)];
  const loud = track(10); paint(loud, 1, 2.4, -36); paint(loud, 3, 5.8, -24);
  fs.writeFileSync(path.join(dir, 'A.auto.json'), JSON.stringify(a));
  fs.writeFileSync(path.join(dir, 'A.loud.json'), JSON.stringify(loud));
  // source B: one clean take, cached under Deepgram's name; B's run is the machine's last transcript.json
  const b = [Wd('seven', 0.5, 0.9), Wd('eight.', 1, 1.4)];
  fs.writeFileSync(path.join(dir, 'B.auto.dg.json'), JSON.stringify(b));
  fs.writeFileSync(path.join(pub, 'transcript.json'), JSON.stringify([{clipId: 'k0', source: 'B', words: b.map((w, i) => ({i, ...w}))}]));
  const project = (src, outSec, x = {}) => ({clips: [{id: 'k0', src, inSec: 0, outSec, sourceDurationSec: 6}], captions: [], graphics: [], mattes: [], lang: 'auto', ...x});
  try {
    const A = await projectIssues(project('clips/A.mp4', 5.1), pub); // ends inside "five"
    assert.match(A.find((i) => i.code === 'off-mic')?.msg ?? '', /^k0: 3 off-mic word\(s\) still in the cut: cut_words A:0…A:2 "one two three\."/);
    assert.match(A.find((i) => i.code === 'cut-word')?.msg ?? '', /k0 ends in the middle of "five"/);
    const B = await projectIssues(project('clips/B.mp4', 2), pub);
    assert.deepEqual(B.filter((i) => ['off-mic', 'cut-word'].includes(i.code)), []);
    // off-mic switched off: the words carry no flag; a source never transcribed: no words, no issue
    assert.ok((await projectWords(project('clips/A.mp4', 5.1, {offMic: 'off'}), pub))[0].words.every((w) => !w.off));
    assert.deepEqual((await projectWords(project('clips/C.mp4', 2), pub))[0].words, []);
    // a source cached by both engines: the caller's env picks, never the cwd's .env (nor is it loaded):
    // a child in a temp cwd whose .env would say WhisperX
    fs.writeFileSync(path.join(dir, 'D.auto.json'), JSON.stringify([Wd('heard-by-whisperx', 0, 1)]));
    fs.writeFileSync(path.join(dir, 'D.auto.dg.json'), JSON.stringify([Wd('heard-by-deepgram', 0, 1)]));
    fs.writeFileSync(path.join(pub, '.env'), 'REEL_STT=whisperx\nREEL_SENTINEL=1\n');
    const code = `const {projectWords} = await import(${JSON.stringify(new URL('../mcp/checks.mjs', import.meta.url).href)});
      const p = {clips: [{id: 'k0', src: 'clips/D.mp4', inSec: 0, outSec: 2}], lang: 'auto'};
      const w = (env) => projectWords(p, ${JSON.stringify(pub)}, env)[0].words.map((x) => x.word).join();
      console.log(JSON.stringify([w({DEEPGRAM_API_KEY: 'k'}), w({}), w({DEEPGRAM_API_KEY: 'k', REEL_STT: 'whisperx'}), process.env.REEL_SENTINEL ?? null]));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {cwd: pub, encoding: 'utf8', env: {PATH: process.env.PATH}});
    assert.deepEqual(JSON.parse(r.stdout || 'null'), ['heard-by-deepgram', 'heard-by-whisperx', 'heard-by-whisperx', null], r.stderr);
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

test('captions switched off (set_captions): their pages are not checked', () => {
  const p = {clips: [clip], captionStyle: 'caja', captions: [page('c0', 500, 1500, [W('Todo', 500, 800), W('en', 900, 1500)], 5)], graphics: []};
  assert.ok(codes(validateProject(p)).includes('glue'));
  const off = codes(validateProject({...p, captionsOff: true}));
  assert.ok(!off.includes('glue') && !off.includes('safe-top'), String(off));
});

test('word times squeezed by the ASR are flagged with their ids (16 syllables/s); normal speech and prices in digits are not', async () => {
  const {syllables} = await import('../src/validate.ts');
  const g1 = {id: 'g', src: 'clips/a.mp4', inSec: 0, outSec: 40, sourceDurationSec: 40};
  const cap = (words) => [{id: 'c0', src: g1.src, words, startMs: words[0].startMs, endMs: words.at(-1).endMs, topPct: 53}];
  // a made-up sentence with the syllables and the squeezed times WhisperX once gave a real one: 30 syllables in 1.84 s
  const squeezed = [['412', 29539, 29739], ['37', 29759, 29799], ['habitaciones', 29839, 30339], ['que', 30359, 30419], ['se', 30439, 30499], ['terminan', 30539, 30899], ['en', 30919, 30959], ['octubre', 30979, 31239], ['2031', 31259, 31379], ['Visita', 34861, 35124]]
    .map(([text, s, e], k) => ({wid: `a:${86 + k}`, text, startMs: s, endMs: e}));
  const fast = validateProject({clips: [g1], captions: cap(squeezed)}).filter((i) => i.code === 'fast-words');
  assert.equal(fast.length, 1);
  assert.match(fast[0].msg, /a:86…a:94 .* 16 syllables\/s .*re-transcribe with Deepgram or fix the times/);
  // cut out of the reel: not on screen, not flagged
  assert.deepEqual(validateProject({clips: [{...g1, inSec: 32}], captions: cap(squeezed)}).filter((i) => i.code === 'fast-words'), []);
  // the same kind of sentence said at ~6 syllables/s
  let t = 0;
  const normal = 'Hola te estoy enseñando 37 habitaciones que se terminan en octubre 2031 frente al parque'.split(' ')
    .map((text, k) => { const w = {wid: `a:${k}`, text, startMs: t, endMs: t + syllables(text) * 160}; t = w.endMs + 60; return w; });
  assert.deepEqual(validateProject({clips: [g1], captions: cap(normal)}).filter((i) => i.code === 'fast-words'), []);
  assert.deepEqual([syllables('habitaciones'), syllables('que'), syllables('2031.')], [5, 1, 6]);
  // a price in digits at an ordinary pace ('un millón quinientos mil': the zeros are next to nothing said)
  const price = [['Departamentos', 0, 850], ['desde', 850, 1180], ['1,500,000', 1180, 2350], ['pesos.', 2350, 2700]].map(([text, s, e], k) => ({wid: `a:${k}`, text, startMs: s, endMs: e}));
  assert.deepEqual(validateProject({clips: [g1], captions: cap(price)}).filter((i) => i.code === 'fast-words'), []);
});

// ---- half-graded sources: the scan's steps (scripts/grade-scan.mjs) → a warning per clip that shows a head, with the fix ----
import {halfGradedIssues, transcriptIssues} from '../src/validate.ts';
import {clipTags, locateSec, splitClip} from '../src/timeline.ts';

test('half-graded: a clip over the head gets split + match; the fixed head (own clip, own grade, graded) is quiet', () => {
  const scans = {'clips/g.mp4': {steps: [{at: 9.209, from: 8.876, frames: 10, dY: 36.3, sat: [1.8, 7.8]}]}};
  const c = (id, inSec, outSec, x = {}) => ({id, src: 'clips/g.mp4', inSec, outSec, sourceDurationSec: 45, ...x});
  const whole = halfGradedIssues({clips: [c('g', 2, 20)]}, scans);
  assert.deepEqual(whole.map((i) => [i.level, i.code, i.ref]), [['warn', 'half-graded', 'g']]);
  assert.match(whole[0].msg, /from 8\.876 s of the source the client's grade only starts at 9\.209 s \(10 ungraded frames/);
  assert.match(whole[0].msg, /split_clip at_sec 7\.209, then at_sec 6\.876 \(timeline\), then create_lut match on the head \(clip_id of the new piece at 6\.876 s\)/);
  // split at the cut and the change: only the head piece is named, until it has its own grade and is marked graded
  const clips = [c('g', 2, 8.876), c('g-s1', 8.876, 9.209), c('g-s2', 9.209, 20)];
  assert.match(halfGradedIssues({clips}, scans).map((i) => i.msg).join(), /^g-s1: .*create_lut match on the head \(clip_id g-s1\)/);
  const graded = clips.map((x) => (x.id === 'g-s1' ? clipTags(x, {graded: true}) : x));
  assert.equal(halfGradedIssues({clips: graded}, scans).length, 1, 'a flag alone is not a fix');
  const matched = {lut: 'luts/g-s1-match.cube'};
  assert.match(halfGradedIssues({clips, grade: {overrides: {'g-s1': matched}}}, scans)[0].msg, /own grade: .* set_clip graded: true on g-s1/);
  assert.deepEqual(halfGradedIssues({clips: graded, grade: {overrides: {'g-s1': matched}}}, scans), []);
  assert.deepEqual(halfGradedIssues({clips}, {'clips/g.mp4': null}), []); // not scanned yet: validate says so apart
  // only what split_clip accepts (0.2 s a side): 0.1 s of the shot before is trimmed off, after the split; a 5-frame head is trimmed away
  assert.match(halfGradedIssues({clips: [c('g', 8.776, 20)]}, scans)[0].msg, /Fix: split_clip at_sec 0\.433 \(timeline\), then trim_clip g in_sec 8\.876 \(the shot before goes\), then create_lut match on the head \(clip_id g\)/);
  const short = {'clips/g.mp4': {steps: [{at: 9.043, from: 8.876, frames: 5, dY: 30, sat: [1.8, 7.8]}]}};
  assert.match(halfGradedIssues({clips: [c('g', 2, 20)]}, short)[0].msg, /Fix: split_clip at_sec 6\.876 \(timeline\), then trim_clip in_sec 9\.043 on the new piece at 6\.876 s \(5 frames are too short/);
  // the grade stops early (the shorter side comes after the change): the TAIL is the odd part — split it off and match IT to
  // the shot it ends (to_clip_id: never the shot to it, never the next shot by default)
  const tail = {'clips/g.mp4': {steps: [{at: 12.212, from: 10, to: 12.446, off: true, frames: 7, dY: -7.7, sat: [8, 4]}]}};
  assert.match(halfGradedIssues({clips: [c('g', 5, 20)]}, tail)[0].msg, /grade stops at 12\.212 s: the 7 frames to 12\.446 s are ungraded \(ΔY -7\.7, saturation 8 → 4\)\. Fix: split_clip at_sec 7\.446, then at_sec 7\.212 \(timeline\), then create_lut match on the tail \(clip_id of the new piece at 7\.212 s, to_clip_id g: it takes the shot's grade\), then set_clip graded: true on it$/);
  assert.deepEqual(halfGradedIssues({clips: [c('g', 5, 12.212)]}, tail), [], 'a clip that ends where the tail starts shows none of it');
  // a tail that pops MORE saturated (Morantes 10's last frames): the same fix, never called ungraded
  const pop = {'clips/g.mp4': {steps: [{...tail['clips/g.mp4'].steps[0], dY: 7.7, sat: [8.3, 16.9]}]}};
  assert.match(halfGradedIssues({clips: [c('g', 5, 20)]}, pop)[0].msg, /the shot's look stops at 12\.212 s: the 7 frames to 12\.446 s are in another grade .*create_lut match on the tail \(clip_id of the new piece at 7\.212 s, to_clip_id g/);
  // split already: the tail clip is matched to the clip it continues; with no clip of the shot in the project, set_grade like it
  const pieces = [c('g', 5, 12.212), c('g-s1', 12.212, 12.446), c('g-s2', 12.446, 20)];
  assert.match(halfGradedIssues({clips: pieces}, pop)[0].msg, /^g-s1: .*Fix: create_lut match on the tail \(clip_id g-s1, to_clip_id g: /);
  assert.match(halfGradedIssues({clips: pieces.slice(1)}, pop)[0].msg, /Fix: set_grade target g-s1 like the shot before it/);
  // a tail under 0.2 s (Morantes 10's 3-frame pops) is too short for a clip: split at the cut, trim it off
  const short3 = {'clips/g.mp4': {steps: [{at: 8.742, from: 5.9, to: 8.842, off: true, frames: 3, dY: 10.4, sat: [10, 19.2]}]}};
  assert.match(halfGradedIssues({clips: [c('g', 5, 20)]}, short3)[0].msg, /Fix: split_clip at_sec 3\.842 \(timeline\), then trim_clip out_sec 8\.742 on g \(3 frames are too short for a clip of their own: the trim drops them with the voice under them — if cut-word then flags a word, leave them and tell the client instead\)$/);
  const tailFixed = [clipTags(c('g-s1', 12.212, 12.446), {graded: true})];
  assert.deepEqual(halfGradedIssues({clips: tailFixed, grade: {overrides: {'g-s1': {adjust: {saturation: 2}}}}}, tail), []);
});

test('half-graded: the fixes followed in the order validate gives land every split on its source time (the latest first)', () => {
  // three 10-frame heads in one 29.97 fps source (G10's times) on a 30 fps timeline: each clip is whole frames there,
  // so a split moves what follows it — the first-to-last order put 24.992 at 25.010
  const scans = {'clips/g.mp4': {steps: [[8.876, 9.209], [24.992, 25.325], [37.638, 37.971]].map(([from, at]) => ({at, from, frames: 10, dY: 33, sat: [1.5, 7.5]}))}};
  let clips = [{id: 'g', src: 'clips/g.mp4', inSec: 0, outSec: 45.12, sourceDurationSec: 45.12}];
  for (const i of halfGradedIssues({clips}, scans)) {
    for (const t of i.msg.match(/split_clip at_sec [^(]*/)[0].match(/\d+\.\d+/g).map(Number)) {
      const {clip, sourceSec} = locateSec(clips, 30, t);
      clips = splitClip(clips, clip.id, sourceSec).clips;
    }
  }
  assert.deepEqual(clips.slice(1).map((c) => +c.inSec.toFixed(3)), [8.876, 9.209, 24.992, 25.325, 37.638, 37.971]);
});

test('half-graded: three tails in one export (Morantes 10\'s times) followed latest first land every cut on its source time', () => {
  const steps = [[5.9, 8.742, 8.842, 3], [8.842, 12.212, 12.446, 7], [12.446, 24.591, 24.691, 3]].map(([from, at, to, frames]) => ({at, from, to, off: true, frames, dY: 8, sat: [8, 16]}));
  let clips = [{id: 'k', src: 'clips/m.mp4', inSec: 0, outSec: 44.778, sourceDurationSec: 44.778}];
  for (const i of halfGradedIssues({clips}, {'clips/m.mp4': {steps}}, 30000 / 1001)) {
    for (const t of (i.msg.match(/split_clip at_sec [^(]*/)?.[0] ?? '').match(/\d+\.\d+/g) ?? []) {
      const {clip, sourceSec} = locateSec(clips, 30000 / 1001, +t);
      clips = splitClip(clips, clip.id, sourceSec).clips;
    }
    const trim = i.msg.match(/trim_clip out_sec ([\d.]+) on (\S+)/);
    if (trim) clips = clips.map((c) => (c.id === trim[2] ? {...c, outSec: +trim[1]} : c));
  }
  assert.deepEqual(clips.map((c) => [+c.inSec.toFixed(3), +c.outSec.toFixed(3)]), [[0, 8.742], [8.842, 12.212], [12.212, 12.446], [12.446, 24.591], [24.691, 44.778]]);
});

test('projectIssues: a stage the job did not ask for is advisory — a captions-only job reports the half-graded export, never fixes it', async () => {
  const {projectIssues} = await import('../mcp/checks.mjs');
  const {cacheFile, SCAN_VERSION} = await import('../scripts/grade-scan.mjs');
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-scope-'));
  try {
    fs.mkdirSync(path.join(pub, 'clips'), {recursive: true});
    fs.writeFileSync(path.join(pub, 'clips', 'm.mp4'), 'x');
    const st = fs.statSync(path.join(pub, 'clips', 'm.mp4'));
    fs.mkdirSync(path.dirname(cacheFile(pub, 'clips/m.mp4')), {recursive: true});
    fs.writeFileSync(cacheFile(pub, 'clips/m.mp4'), JSON.stringify({version: SCAN_VERSION, src: 'clips/m.mp4', size: st.size, mtimeMs: Math.round(st.mtimeMs), fps: 29.97, frames: 1342, steps: [{frame: 366, at: 12.212, from: 8.842, to: 12.446, off: true, frames: 7, dY: 7.7, sat: [8.3, 16.3]}]}));
    const p = (scope) => ({clips: [{id: 'k0', src: 'clips/m.mp4', inSec: 0, outSec: 44.778, sourceDurationSec: 44.778}], captions: [], graphics: [], mattes: [], lang: 'es', scope});
    const all = (await projectIssues(p(null), pub)).find((i) => i.code === 'half-graded');
    assert.match(all.msg, /Fix: split_clip .*create_lut match on the tail/);
    assert.equal(all.omitted, undefined);
    const captions = (await projectIssues(p(['captions']), pub)).find((i) => i.code === 'half-graded');
    assert.deepEqual([captions.level, captions.omitted], ['warn', 'color']);
    assert.match(captions.msg, /— color omitida \(the job did not ask for it\): advisory, report it, do not fix it$/);
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

test('clipTags (set_clip and the editor\'s Clip tab): graded / location set, trimmed and cleared', () => {
  const c = {id: 'a', src: 'clips/a.mp4', inSec: 0, outSec: 2, sourceDurationSec: 2};
  const t = clipTags(c, {graded: false, location: '  Rooftop  '});
  assert.deepEqual([t.graded, t.location], [false, 'Rooftop']);
  assert.deepEqual(clipTags(t, {graded: null, location: ''}), c);
  assert.equal(clipTags(t, {}).location, 'Rooftop');
});

test('cut-word: an edge inside a word that the next piece continues (a split, nothing cut: a half-graded head) is no cut', () => {
  const tr = [{clipId: 'a', source: 'a', words: [{i: 0, word: 'five', startMs: 4950, endMs: 5300}]}];
  const c = (id, inSec, outSec) => ({id, src: 'clips/a.mp4', inSec, outSec, sourceDurationSec: 9});
  assert.deepEqual(transcriptIssues({clips: [c('a', 0, 5.1), c('b', 5.1, 9)]}, tr), []);
  assert.deepEqual(transcriptIssues({clips: [c('a', 0, 5.1), c('b', 6, 9)]}, tr).map((i) => [i.code, i.ref]), [['cut-word', 'a']]);
});

test('transcriptIssues: a split that removed nothing (continuesPrev) cuts no word; a real cut inside a word still does', () => {
  const tr = [{clipId: 'k0', source: 'a', words: [{i: 0, word: 'mundo', startMs: 800, endMs: 1100}]}];
  const pieces = (...ranges) => ({clips: ranges.map(([inSec, outSec], k) => ({id: `k${k}`, src: 'clips/a.mp4', inSec, outSec, sourceDurationSec: 2}))});
  assert.deepEqual(transcriptIssues(pieces([0, 0.95], [0.95, 2]), tr), [], 'the take runs on through "mundo"');
  assert.deepEqual(transcriptIssues(pieces([0, 0.95], [1, 2]), tr).map((i) => i.msg.split(' (')[0]), ['k0 ends in the middle of "mundo"', 'k1 starts in the middle of "mundo"']);
});

// ---- data on screen backed by this reel's audio (CEO-21): unbackedData, reported by transcriptIssues ----
import {unbackedData} from '../src/validate.ts';

// words said one after another from startMs, 400 ms each ('|' = a sentence end after the word before)
const said = (source, text, startMs = 0, clipId = source) => {
  let t = startMs;
  return {clipId, source, words: text.split(' ').map((word, i) => ({i, word, startMs: (t += 400) - 400, endMs: t - 50}))};
};
const reel = (src, graphics, over = {}) => ({clips: [{id: src, src: `clips/${src}.mp4`, inSec: 0, outSec: 30, sourceDurationSec: 30}], captions: [], graphics, ...over});
const gfx = (id, src, startMs, template, props) => ({id, src: `clips/${src}.mp4`, startMs, endMs: startMs + 2000, template, props});
const datos = (p, tr) => unbackedData(p, tr).map((d) => d.dato);

test('data-from-audio: a figure said near the graphic passes (digits or words); one not said is a warning', () => {
  const tr = [said('s', 'El jardín recibe hasta cuarenta personas y tiene 2 asadores.')];
  const ok = reel('s', [gfx('g0', 's', 1200, 'label-2tone', {top: 'JARDÍN', bottom: 'Hasta 40 personas'}), gfx('g1', 's', 2000, 'stat', {value: '2', label: 'asadores'})]);
  assert.deepEqual(unbackedData(ok, tr), []);
  const bad = reel('s', [gfx('g0', 's', 1200, 'label-2tone', {top: 'JARDÍN', bottom: 'Hasta 45 personas'})]);
  const i = transcriptIssues(bad, tr).filter((x) => x.code === 'data-from-audio');
  assert.deepEqual(i.map((x) => [x.level, x.ref]), [['warn', 'g0']]); // a question for the client (datosPorConfirmar), never a stop
  assert.match(i[0].msg, /"45" — dato sin respaldo en el audio de este reel/);
});

test('data-from-audio: only this reel\'s own audio backs it — the same fact with another value in another reel is never unified', () => {
  const trA = said('a', 'Caben treinta personas en el patio.'), trB = said('b', 'Caben veinte personas en el patio.');
  const g = (src) => gfx('g0', src, 400, 'label-2tone', {top: 'PATIO', bottom: 'Para 30 personas'});
  assert.deepEqual(datos(reel('a', [g('a')]), [trA, trB]), []);
  assert.deepEqual(datos(reel('b', [g('b')]), [trA, trB]), ['30']); // reel b says 20; reel a's 30 does not count
});

test('data-from-audio: far from the graphic, cut out of the reel, or under a chapter number does not count — by time, never by the ASR\'s punctuation', () => {
  const tr = [said('s', 'Son 12 lofts. Y ahora hablemos de otra cosa muy distinta con calma y sin prisa ninguna hoy.')];
  const late = gfx('g0', 's', 6000, 'stat', {value: '12', label: 'lofts'}); // 12 is said at 0.4 s: over 3 s away
  assert.deepEqual(datos(reel('s', [late]), tr), ['12']);
  const edge = gfx('g0', 's', 3700, 'stat', {value: '12', label: 'lofts'}); // "12" ends 2.95 s before it
  assert.deepEqual(datos(reel('s', [edge]), tr), []);
  const reach = gfx('g0', 's', 3900, 'stat', {value: '12', label: 'lofts'}); // 3.15 s: out, even though "lofts." reaches the window
  assert.deepEqual(datos(reel('s', [reach]), tr), ['12']);
  assert.deepEqual(datos(reel('s', [reach]), [said('s', 'Son 12 lofts y ahora hablemos de otra cosa muy distinta con calma y sin prisa ninguna hoy.')]), ['12']); // the same without the period
  const cut = reel('s', [gfx('g0', 's', 1200, 'stat', {value: '12', label: 'lofts'})], {clips: [{id: 's', src: 'clips/s.mp4', inSec: 0.9, outSec: 30, sourceDurationSec: 30}]});
  assert.deepEqual(datos(cut, tr), ['12']); // "12" (0.4–0.75 s) is cut out of the reel
  assert.deepEqual(datos(reel('s', [gfx('g0', 's', 1200, 'chapter', {label: 'Parte', number: '07'})]), tr), []);
});

test('data-from-audio: an end card restates the reel — backed by any word the reel keeps, a period between the title figure and the CTA or not', () => {
  const card = gfx('g0', 's', 9000, 'end-card', {title: 'Casa Brisa 418', cta: 'Agenda por WhatsApp', handle: '@casa_326'});
  for (const text of ['Esto es Casa Brisa 418. Te espero para que la conozcas, escríbeme hoy.', 'Esto es Casa Brisa 418, te espero para que la conozcas, escríbeme hoy.']) {
    assert.deepEqual(datos(reel('s', [card]), [said('s', text)]), [], text); // 418 said 7 s before the card
  }
  assert.deepEqual(datos(reel('s', [card]), [said('s', 'Esto es Casa Brisa. Te espero para que la conozcas, escríbeme hoy.')]), ['418']); // the CTA and the handle are the brief's
  // a reel of two takes: the title said in the other one
  const two = {...reel('a', [{...card, src: 'clips/b.mp4', startMs: 1000}]), clips: [{id: 'a', src: 'clips/a.mp4', inSec: 0, outSec: 30, sourceDurationSec: 30}, {id: 'b', src: 'clips/b.mp4', inSec: 0, outSec: 30, sourceDurationSec: 30}]};
  assert.deepEqual(datos(two, [said('a', 'Esto es Casa Brisa 418.'), said('b', 'Te espero, escríbeme hoy.')]), []);
});

test('data-from-audio: prices and ordinals in the templates\' own formats match the words said', () => {
  const at = (props, text, template = 'price') => datos(reel('s', [gfx('g0', 's', 400, template, props)]), [said('s', text)]);
  assert.deepEqual(at({label: 'DESDE', value: '$2.5M'}, 'El precio es de dos millones y medio de pesos'), []);
  assert.deepEqual(at({label: 'DESDE', value: '$2.5M'}, 'Cuesta dos punto cinco millones'), []);
  assert.deepEqual(at({label: 'DESDE', value: '$2.5 MDP'}, 'Cuesta 2.5 millones'), []);
  assert.deepEqual(at({label: 'DESDE', value: '$1.1M'}, 'Cuesta un millón cien mil pesos'), []);
  assert.deepEqual(at({label: 'DESDE', value: '$3.5M'}, 'El precio es de dos millones y medio de pesos'), ['3.5M']);
  assert.deepEqual(at({value: '800K', label: ''}, 'Son ochocientos mil'), []);
  assert.deepEqual(at({top: 'Terraza en el 3er piso', bottom: ''}, 'La terraza está en el tercer piso', 'label-2tone'), []);
  assert.deepEqual(at({top: 'Terraza en el 3er piso', bottom: ''}, 'La terraza está en el piso tres', 'label-2tone'), []);
  assert.deepEqual(at({top: 'Terraza en el 4to piso', bottom: ''}, 'La terraza está en el tercer piso', 'label-2tone'), ['4to']);
  assert.deepEqual(at({top: 'A 500 M DE LA PLAYA', bottom: ''}, 'Estás a quinientos metros de la playa', 'label-2tone'), []); // M: millions, or the figure itself
});

test('data-from-audio: names — glossary terms (folded both ways), a location tag\'s place, and as a guess capitalized words past the start of sentence-case text', () => {
  const glossary = [{term: 'Solmar', variants: ['Sol Mar']}];
  const tr = [said('s', 'Vive en Sol Mar, al norte de Valtierra.')];
  const p = (props, template = 'label-2tone') => ({...reel('s', [gfx('g0', 's', 800, template, props)]), brand: {glossary}});
  assert.deepEqual(datos(p({top: 'SOLMAR', bottom: 'Al norte de Valtierra'}), tr), []); // "Sol Mar" said = the term Solmar
  assert.deepEqual(datos(p({top: 'Vive en Solmar', bottom: 'Cerca de la playa de Puerto Azul'}), tr), ['Puerto', 'Azul']);
  assert.deepEqual(unbackedData(p({top: 'Cerca de la playa de Puerto Azul', bottom: 'Solmar'}), [said('s', 'Vive cerca de la playa.')]).map((d) => [d.dato, !!d.guess]), [['Puerto', true], ['Azul', true], ['Solmar', false]]);
  // Title Case and ALL CAPS are styling: no word of theirs is taken for a name (a glossary term still is)
  for (const top of ['Terraza Privada', 'Salón de Eventos', 'The Biggest Lie About Money', '¿Cansado Del Garrafón?', 'Cerca de Puerto Azul']) assert.deepEqual(datos(p({top, bottom: ''}), tr), [], top);
  assert.deepEqual(datos(p({top: 'Vive En Solmar Norte', bottom: ''}), [said('s', 'Vive al norte.')]), ['Solmar']);
  // one word said for two shown, or two for one (the ASR's segmentation)
  const q = (top, text) => datos({...reel('s', [gfx('g0', 's', 400, 'label-2tone', {top, bottom: ''})]), brand: {glossary: [{term: 'Pet Park'}, {term: 'Solmar'}]}}, [said('s', text)]);
  assert.deepEqual(q('PET PARK', 'Ahora ves el PetPark, para tu perro.'), []);
  assert.deepEqual(q('SOLMAR', 'Vive en Sol Mar hoy.'), []);
  assert.deepEqual(q('SOLMAR', 'Vive en el mar hoy.'), ['Solmar']);
  assert.deepEqual(datos(p({top: 'Terraza', bottom: 'Con vista'}), tr), []); // a capital that opens a text is not a name
  assert.deepEqual(datos(p({place: 'Montecielo', sub: ''}, 'location-tag'), tr), ['Montecielo']);
  assert.deepEqual(datos({...p({top: 'SOLMAR', bottom: ''}), brand: null}, tr), []); // all caps, no glossary: not taken as a name
  assert.deepEqual(datos({...p({top: 'SKYPOOL', bottom: ''}), brand: {glossary: [{term: 'skypool', variants: ['sky pool']}]}}, tr), []); // an amenity's spelling is no name
});

test('data-from-audio: a figure said in words by pairs ("cuatro dieciocho" = 418), by the kit\'s glossary or by itself', () => {
  const tr = [said('s', 'Te espero en Solmar cuatro dieciocho.')];
  const p = {...reel('s', [gfx('g0', 's', 1200, 'end-card', {title: 'Solmar 418', cta: 'Escríbeme'})]), brand: {glossary: [{term: '418', variants: ['cuatro dieciocho']}]}};
  assert.deepEqual(datos(p, tr), []);
  assert.deepEqual(datos({...p, brand: null}, tr), []); // a number read in pairs is the number (WhisperX writes 418, Deepgram the words)
  assert.deepEqual(datos({...p, brand: null}, [said('s', 'Te espero en Solmar cuatro diez.')]), ['418']);
  // the kit's own name on its end card is the client, not a fact — even when the glossary spells it
  const brand = {name: 'Solmar', glossary: [{term: 'Solmar', variants: ['Sol Mar']}]};
  assert.deepEqual(datos({...reel('s', [gfx('g0', 's', 1200, 'end-card', {title: 'Solmar', cta: 'Escríbeme'})]), brand}, [said('s', 'Te espero, escríbeme.')]), []);
  assert.deepEqual(datos({...reel('s', [gfx('g0', 's', 1200, 'end-card', {title: 'Solmar', cta: 'Escríbeme'})]), brand: {...brand, name: 'Otra'}}, [said('s', 'Te espero, escríbeme.')]), ['Solmar']);
});

// ---- script-coverage: the guion against the cut, before there are captions ----
test('script-coverage: a guion line the cut does not keep is a warning while there are no captions; then the captions check takes over', () => {
  const tr = [said('s', 'Mi casa tiene jardín. Y también tiene alberca.')];
  const guion = 'Mi casa tiene jardín. Y también tiene alberca. Escríbeme hoy mismo.';
  const p = {...reel('s', []), guion};
  const cov = transcriptIssues(p, tr).filter((x) => x.code === 'script-coverage');
  assert.deepEqual(cov.map((x) => [x.level, x.ref]), [['warn', 's']]);
  assert.match(cov[0].msg, /guion "Escríbeme hoy mismo" is not in the cut \(after s\)/);
  assert.deepEqual(codes(transcriptIssues({...p, guion: guion.replace(' Escríbeme hoy mismo.', '')}, tr)), []);
  assert.deepEqual(codes(validateProject(p)).filter((c) => c.startsWith('guion')), []); // no pages: not "missing from the captions"
  const captioned = {...p, captions: [page('c0', 0, 3000, [W('Mi', 0, 350)])]};
  assert.deepEqual(codes(transcriptIssues(captioned, tr)).filter((c) => c === 'script-coverage'), []);
  assert.deepEqual(codes(transcriptIssues({...captioned, captionsOff: true}, tr)), ['script-coverage']);
});
