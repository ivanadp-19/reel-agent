// Captions never cover a face (src/faces.ts): one position per hold span (a take, the reel, a page), clear of every
// face on screen through the composition's geometry, within ±faceShift of the pack's — else the least covered, reported
// with the reach that would clear it; validate's caption-face, the render judge's. Synthetic scans only — never a
// client's media or words.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {FACE_DEFAULTS, captionFaceIssues, faceCacheName, faceKnobs, facesIn, legacyFaceCacheName, placeCaptions, screenFaces, takesOf} from '../src/faces.ts';
import {captionBlock} from '../src/validate.ts';
import {presetOf} from '../src/captionPresets.ts';
import {captionLayout} from '../src/layers.ts';
import {RULES, invalidate, stageFindings} from '../src/stages.ts';
import {faceGaps, facesOf, projectIssues} from '../mcp/checks.mjs';

const FPS = 30;
const clip = (id, src, inSec, outSec, x = {}) => ({id, src, inSec, outSec, sourceDurationSec: 60, ...x});
// a page of n words over [a, b] s of its source (source ms = timeline ms for a clip that starts at 0)
const page = (id, src, a, b, n = 3, x = {}) => ({id, src, startMs: a * 1000, endMs: b * 1000, topPct: 58, ...x,
  words: Array.from({length: n}, (_, k) => ({wid: `${src}:${id}.${k}`, text: 'palabra', startMs: a * 1000 + (k * (b - a) * 1000) / n, endMs: a * 1000 + ((k + 1) * (b - a) * 1000) / n}))});
// a face box (fractions) at every half second of [0, dur) s; faces(t) → the boxes at t
const scan = (dur, faces, extra = {}) => ({rate: 2, width: 1080, height: 1920, samples: Array.from({length: dur * 2}, (_, k) => ({t: k / 2, faces: faces(k / 2)})), ...extra});
const box = (top, bottom, left = 0.4, right = 0.6, score = 0.93) => ({left, top, right, bottom, score});
const ABOVE = box(0.2, 0.35); // a presenter's face well above the captions
const tops = (caps) => caps.map((c) => c.topPct);
const project = (x) => ({clips: [clip('a', 'clips/a.mp4', 0, 10)], captions: [0, 2, 4, 6, 8].map((s, k) => page(`c${k}`, 'clips/a.mp4', s, s + 1.5)), captionStyle: 'palabra', brolls: [], graphics: [], ...x});
const issues = (p, scans) => captionFaceIssues(p, scans, FPS).filter((i) => i.code === 'caption-face');
const A = 'clips/a.mp4';

test('defaults every project gets, a kit overrides them, the project overrides the kit', () => {
  assert.deepEqual(faceKnobs({}), FACE_DEFAULTS);
  assert.deepEqual(FACE_DEFAULTS, {shift: 15, hold: 'toma'});
  const kit = {brand: {style: {faceShift: 12, faceHold: 'video'}}};
  assert.deepEqual(faceKnobs(kit), {shift: 12, hold: 'video'});
  assert.deepEqual(faceKnobs({...kit, faceShift: 0, faceHold: 'pagina'}), {shift: 0, hold: 'pagina'});
  assert.deepEqual(faceKnobs({...kit, faceShift: null, faceHold: null}), {shift: 12, hold: 'video'}, 'null = back to the kit');
});

test('pinned pack (vibem, the G1 case): the face above the band keeps 53 % on every take and hold', () => {
  const s = scan(10, () => [box(0.43, 0.5, 0.45, 0.55)], {cuts: [3, 6]}); // G1's presenter, shot changes at 3 and 6 s
  const p = project({captionStyle: 'vibem', captions: [0, 2, 4, 6, 8].map((t, k) => page(`c${k}`, A, t, t + 1.5, 4, {topPct: 53}))});
  assert.equal(takesOf(p.clips, {[A]: s}, FPS).length, 3);
  for (const hold of ['toma', 'video', 'pagina']) assert.deepEqual(tops(placeCaptions({...p, faceShift: 12, faceHold: hold}, {[A]: s}, FPS)), [53, 53, 53, 53, 53]);
  assert.deepEqual(issues(p, {[A]: s}), []);
});

test('anchored pack: the base top kept when clear; a face on it late in the take moves the whole take', () => {
  assert.deepEqual(tops(placeCaptions(project(), {[A]: scan(10, () => [ABOVE])}, FPS)), [58, 58, 58, 58, 58]);
  const late = {[A]: scan(10, (t) => [t >= 9 ? box(0.55, 0.62) : ABOVE])}; // the presenter leans in at 9 s
  const out = placeCaptions(project(), late, FPS);
  assert.equal(new Set(tops(out)).size, 1, 'one top for the take');
  assert.ok(out[0].topPct !== 58 && Math.abs(out[0].topPct - 58) <= 15, `moved within ±15: ${out[0].topPct}`);
  assert.deepEqual(issues({...project(), captions: out}, late), [], 'and clear at every moment');
  assert.equal(issues(project(), late).length, 1, 'the base top is reported (one take)');
});

test('what a take is: a jump cut stays one; a transition in (punch, whipDiag) or a new framing starts another', () => {
  const s = {[A]: scan(20, () => [ABOVE])};
  const two = (x) => takesOf([clip('a1', A, 0, 4), clip('a2', A, 5, 9, x)], s, FPS).length;
  assert.equal(two({}), 1, 'a plain jump cut in one recording');
  assert.equal(two({enter: 'punch'}), 2);
  assert.equal(two({enter: 'whipDiag'}), 2);
  assert.equal(two({transform: [{t: 5, scale: 1.3, x: 0, y: 0}]}), 2, 'another framing');
  // the punched half's face (48–55 % → 49–57 % at 1.12×) moves only its own take
  const f = {[A]: scan(20, () => [box(0.48, 0.555)])};
  const clips = [clip('a1', A, 0, 4), clip('a2', A, 5, 9, {enter: 'punch'})];
  const caps = [page('c0', A, 0.5, 2), page('c1', A, 2.2, 3.3), page('c2', A, 5.5, 7), page('c3', A, 7.2, 8.5)];
  const at = (ms) => screenFaces({clips, captions: caps}, f, FPS)(ms)[0];
  assert.ok(Math.abs(at(1000).bottom - 55.5) < 0.01 && Math.abs(at(5000).bottom - (38 + 17.5 * 1.12)) < 0.01, 'the punch moves the box');
  const out = tops(placeCaptions({clips, captions: caps, captionStyle: 'palabra'}, f, FPS));
  assert.deepEqual(out.slice(0, 2), [58, 58]);
  assert.equal(out[2], out[3]);
  assert.notEqual(out[2], 58);
});

test('a shot change inside one source splits takes: each holds its own position', () => {
  const s = {[A]: scan(10, (t) => [t >= 5 ? box(0.55, 0.62) : ABOVE], {cuts: [5]})};
  assert.deepEqual(takesOf(project().clips, s, FPS).map((t) => [t.startMs, t.endMs]), [[0, 5000], [5000, 10000]]);
  const caps = [[0, 1.2], [1.5, 2.7], [3, 4.2], [5.5, 7], [7.5, 9]].map(([a, b], k) => page(`c${k}`, A, a, b));
  const out = tops(placeCaptions(project({captions: caps}), s, FPS));
  assert.deepEqual(out.slice(0, 3), [58, 58, 58], 'the first shot stays');
  assert.equal(new Set(out.slice(3)).size, 1);
  assert.notEqual(out[3], 58);
  // a page starting in the first shot and still up in the second holds the first shot's position — clear there too
  const straddle = project({captions: [page('c0', A, 0, 1.5), page('c1', A, 4.2, 4.9, 1), page('c2', A, 5.5, 7)]});
  const t2 = tops(placeCaptions(straddle, s, FPS));
  assert.equal(t2[0], t2[1], 'the page that starts in take 1 holds take 1');
  assert.notEqual(t2[0], 58, 'its tail over the second shot moves take 1 too');
  assert.deepEqual(issues({...straddle, captions: placeCaptions(straddle, s, FPS)}, s), []);
});

test('the tallest page of the take decides where it goes', () => {
  const P = presetOf('palabra');
  const short = page('c0', A, 0, 1.5, 1), tall = page('c1', A, 3, 4.5, 6);
  const [h1, h6] = [short, tall].map((c) => captionBlock(c, P, false).h);
  const top = (58 + h1 + 58 + h6) / 2 / 100; // under the one-word block, inside the six-word one
  const s = {[A]: scan(10, () => [box(top, top + 0.04)])};
  assert.deepEqual(tops(placeCaptions(project({captions: [short]}), s, FPS)), [58], 'one short page: clear');
  const both = tops(placeCaptions(project({captions: [short, tall]}), s, FPS));
  assert.equal(both[0], both[1]);
  assert.notEqual(both[0], 58, 'the six-word page moves them both');
});

test('two faces: the position clears both (and the hair over the lower one)', () => {
  const s = {[A]: scan(10, () => [box(0.56, 0.64, 0.2, 0.45), box(0.66, 0.75, 0.55, 0.8)])};
  const out = placeCaptions(project(), s, FPS);
  assert.equal(new Set(tops(out)).size, 1);
  assert.ok(out[0].topPct < 56, `above both: ${out[0].topPct}`);
  assert.deepEqual(issues({...project(), captions: out}, s), []);
});

test('no clear top in reach: the least covered one is kept and reported, with the reach the same search clears it at', () => {
  // 0–8 s the face sits on the band (50–60 %), then drops (62–72 %): nothing within ±15 clears both
  const s = {[A]: scan(10, (t) => [t < 8 ? box(0.5, 0.6) : box(0.62, 0.72)])};
  const p = project({faceHold: 'video'});
  const out = placeCaptions(p, s, FPS);
  assert.equal(new Set(tops(out)).size, 1);
  assert.ok(out[0].topPct > 60, `under the first face, covered only while the second is up: ${out[0].topPct}`);
  const [i] = issues({...p, captions: out}, s);
  const cov = +/cover a face for ([\d.]+) s/.exec(i.msg)[1], atBase = +/cover a face for ([\d.]+) s/.exec(issues(p, s)[0].msg)[1];
  assert.ok(cov > 0 && cov < atBase / 3, `least covered: ${cov} s vs ${atBase} s at the pack's top`);
  const need = +/±(\d+) % would: set_captions face_shift (\d+)/.exec(i.msg)[2];
  assert.ok(need > 15);
  // the advice is the placement's own search: taking it clears the reel, and validate goes quiet (no loop)
  const fixed = placeCaptions({...p, faceShift: need}, s, FPS);
  assert.deepEqual(issues({...p, faceShift: need, captions: fixed}, s), []);
});

test('a B-roll face counts only while on screen; the presenter under a fullscreen B-roll does not', () => {
  const caps = [page('c0', A, 0, 1.2), page('c1', A, 2.2, 3.3), page('c2', A, 5, 6)];
  const cue = (src) => ({id: 'b0', startMs: 1900, endMs: 4100, kind: 'video', mode: 'fullscreen', src});
  const s = {[A]: scan(10, () => [ABOVE]), 'broll/x.mp4': scan(5, () => [box(0.56, 0.63)])};
  const out = tops(placeCaptions(project({captions: caps, brolls: [cue('broll/x.mp4')], faceHold: 'pagina'}), s, FPS));
  assert.equal(out[0], 58); assert.equal(out[2], 58);
  assert.notEqual(out[1], 58, 'the page over the B-roll moves');
  const low = {[A]: scan(10, () => [box(0.56, 0.63)]), 'broll/empty.mp4': scan(5, () => [])};
  const q = tops(placeCaptions(project({captions: caps, brolls: [cue('broll/empty.mp4')], faceHold: 'pagina'}), low, FPS));
  assert.equal(q[1], 58, 'hidden by the B-roll: nothing to clear');
  assert.notEqual(q[0], 58); assert.notEqual(q[2], 58);
});

test('the framing moves the box: keyframes, a 16:9 source cropped into 9:16, a layout frame, a whipDiag smear', () => {
  const at = (clips, s, graphics = [], ms = 1000) => screenFaces({clips, captions: [], graphics}, s, FPS)(ms);
  const s = {[A]: scan(10, () => [box(0.4, 0.5)])};
  const [z] = at([clip('a', A, 0, 10, {transform: [{t: 0, scale: 2, x: 0, y: 0}]})], s); // 2× about the centre
  assert.ok(Math.abs(z.top - 30) < 0.01 && Math.abs(z.bottom - 50) < 0.01, JSON.stringify(z));
  const wide = {[A]: scan(10, () => [box(0.4, 0.5, 0.02, 0.12), box(0.4, 0.5, 0.45, 0.55)], {width: 1920, height: 1080})};
  const shown = at([clip('a', A, 0, 10)], wide);
  assert.equal(shown.length, 1, 'the far-left face of a landscape source is cropped away');
  assert.ok(Math.abs(shown[0].left - (50 - (0.05 * 1920 * (1920 / 1080)) / 10.8)) < 0.01, JSON.stringify(shown[0]));
  const layout = {id: 'g0', template: 'layout', src: A, startMs: 0, endMs: 10000, props: {shape: 'rounded', canvas: 'dark', inset: 12}};
  const [f] = at([clip('a', A, 0, 10)], s, [layout]);
  assert.ok(Math.abs(f.top - (12 + 0.76 * 40)) < 0.01 && Math.abs(f.bottom - (12 + 0.76 * 50)) < 0.01, JSON.stringify(f));
  // a whipDiag in: its first frames smear along 60° — the face's box grows with the stretch, then settles
  const two = [clip('a0', 'clips/b.mp4', 0, 3), clip('a', A, 0, 10, {enter: 'whipDiag'})];
  const s2 = {...s, 'clips/b.mp4': scan(10, () => [])};
  const [w0] = at(two, s2, [], 3000 + 1000 / FPS), [w9] = at(two, s2, [], 3000 + 9000 / FPS);
  assert.ok(w0.right - w0.left > (w9.right - w9.left) * 1.2 && w0.bottom - w0.top > (w9.bottom - w9.top) * 1.2, `${JSON.stringify(w0)} vs ${JSON.stringify(w9)}`);
});

test('framed layout pack: faces mapped through the frame decide, not the raw source', () => {
  const s = {[A]: scan(10, () => [box(0.71, 0.78)])}; // clear of a two-line page at 58 % full-bleed; in a 12 % frame, on it
  const caps = [page('c0', A, 0, 2), page('c1', A, 3, 5)];
  const layout = {id: 'g0', template: 'layout', src: A, startMs: 0, endMs: 10000, props: {shape: 'rounded', canvas: 'dark', inset: 12}};
  assert.deepEqual(tops(placeCaptions(project({captions: caps}), s, FPS)), [58, 58]);
  const framed = placeCaptions(project({captions: caps, graphics: [layout]}), s, FPS);
  assert.notEqual(framed[0].topPct, 58);
  assert.deepEqual(issues(project({captions: framed, graphics: [layout]}), s), []);
});

test('floating pack (prism): a blocked corner moves to the nearest clear one within the reach; never past it', () => {
  const s = {[A]: scan(10, () => [box(0.1, 0.3, 0.05, 0.3)])}; // a face in the top-left corner
  const caps = [page('c0', A, 0, 1.5, 2), page('c1', A, 2, 3.5, 2), page('c2', A, 4, 5.5, 2)];
  const p = project({captionStyle: 'prism', captions: caps, faceHold: 'pagina'});
  const out = placeCaptions(p, s, FPS);
  assert.deepEqual([out[0].slot, out[0].topPct], [1, 18], 'the left corner moves right (3 % away)');
  assert.equal(out[1].slot, undefined, 'a clear corner is left to the cycle');
  assert.equal(issues(p, s).length, 1, 'before: the first page over the face');
  assert.deepEqual(issues({...p, captions: out}, s), []);
  // ±1: no corner is that close — it stays (the least covered in reach) and is reported
  const tight = placeCaptions({...p, faceShift: 1}, s, FPS);
  assert.ok(tight[0].slot == null || tight[0].slot === 0, JSON.stringify(tight[0]));
  assert.equal(issues({...p, faceShift: 1, captions: tight}, s).length, 1);
});

test('a text graphic is blocked space: the placement steps around it, and the render (avoidGraphics) moves nothing', () => {
  const s = {[A]: scan(10, () => [ABOVE])};
  const label = {id: 'g0', template: 'label-2tone', src: A, startMs: 0, endMs: 3000, yPct: 58, props: {top: 'CAVA', bottom: 'PRIVADA'}};
  const p = project({graphics: [label]});
  const out = placeCaptions(p, s, FPS);
  assert.notEqual(out[0].topPct, 58, 'off the label');
  const shown = captionLayout({...p, captions: out}, FPS).shownCaptions;
  assert.deepEqual(shown.map((c) => [c.topPct, !!c.pin]), out.map((c) => [c.topPct, false]), 'the render draws the stored tops');
});

test('the scan: trusted faces (score, or the full-resolution look), the samples around a moment, the band as rendered, the cache name', () => {
  // a chair at 0.7 that the full-resolution look drops is no face; a phone-call face at 0.7 that it confirms is, and so is
  // a face seen once (a one-second shot); a missed frame keeps the face from its neighbours
  const s = scan(4, (t) => [...(t === 1 ? [{...box(0.1, 0.2, 0.1, 0.2, 0.7), look: 0.2}, {...box(0.6, 0.7, 0.7, 0.8, 0.7), look: 0.88}] : []), ...(t === 2 ? [box(0.6, 0.7, 0.1, 0.2, 0.9)] : []), ...(t !== 1.5 ? [box(0.3, 0.4)] : [])]);
  assert.deepEqual(facesIn(s, 1).map((f) => f.top), [0.6, 0.3], 'the chair is dropped, the phone-call face kept');
  assert.deepEqual(facesIn(s, 2).map((f) => f.top).sort(), [0.3, 0.6], 'a face seen once is a face');
  assert.deepEqual(facesIn(s, 1.5).map((f) => f.top).sort(), [0.3, 0.6], 'a missed detection at 1.5 s: its neighbours hold the face');
  assert.deepEqual(facesIn(s, 1.25).map((f) => f.top).sort(), [0.3, 0.6], 'between 1 s and the miss: the 1 s faces');
  assert.deepEqual(facesIn({...s, cuts: [1.5]}, 1.6).map((f) => f.top).sort(), [0.3, 0.6], 'across a cut only its own shot');
  // a key word's scale grows its line (prism 1.45×); a line at the wrap width counts as the flex-wrap break it can be
  const P = presetOf('prism');
  const plain = page('c0', A, 0, 1, 3), keyed = {...plain, words: plain.words.map((w, k) => (k === 1 ? {...w, tier: 1} : w))};
  assert.ok(captionBlock(keyed, P, false).h > captionBlock(plain, P, false).h);
  const V = presetOf('vibem');
  const edge = {...plain, words: ['HOY', 'ESTO', 'ESTÁ', 'EN', 'CONSTRUCCIÓN'].map((text, k) => ({text, startMs: k, endMs: k + 1}))};
  assert.ok(captionBlock(edge, V, false).up > 0, 'an accented capital on the first line rises over it');
  // the cache: by the path under public/ (two files of one name are two scans); the first scans' basename file read as a fallback
  assert.notEqual(faceCacheName('clips/IMG_1778.mp4'), faceCacheName('broll-assets/IMG_1778.mp4'));
  assert.equal(legacyFaceCacheName('clips/IMG_1778.mp4'), 'IMG_1778.json');
});

test('faceShift 0: never moves, only reports; hand-placed pages are never moved, and still reported', () => {
  const s = {[A]: scan(10, () => [box(0.55, 0.7)])};
  assert.deepEqual(tops(placeCaptions(project({faceShift: 0}), s, FPS)), [58, 58, 58, 58, 58]);
  const [r0] = issues(project({faceShift: 0}), s);
  assert.match(r0.msg, /take a \(0\.0–10\.0 s\) cover a face for [\d.]+ s.*no position within ±0 %.*±\d+ % would: set_captions face_shift \d+/);
  const p = project({captions: [page('c0', A, 0, 1.5, 3, {pin: true, topPct: 60})], faceShift: 30});
  assert.deepEqual(placeCaptions(p, s, FPS), p.captions);
  assert.match(issues(p, s)[0].msg, /c0 was placed by hand: move it \(edit_caption top_pct\)/);
});

test('faceHold: video = one top for the whole reel; pagina = each page on its own, each clear', () => {
  const s = {[A]: scan(10, () => [ABOVE]), 'clips/b.mp4': scan(10, (t) => [t >= 2 && t < 4 ? box(0.55, 0.62) : ABOVE])};
  const clips = [clip('a', A, 0, 5), clip('b', 'clips/b.mp4', 0, 6)];
  const caps = [page('c0', A, 0, 1.5), page('c1', A, 2.5, 4), page('c2', 'clips/b.mp4', 0.2, 1.2), page('c3', 'clips/b.mp4', 2.2, 3.5), page('c4', 'clips/b.mp4', 4.5, 5.5)];
  const p = {clips, captions: caps, captionStyle: 'palabra'};
  const toma = tops(placeCaptions({...p, faceHold: 'toma'}, s, FPS));
  assert.deepEqual(toma.slice(0, 2), [58, 58]);
  assert.equal(new Set(toma.slice(2)).size, 1); assert.notEqual(toma[2], 58);
  const video = tops(placeCaptions({...p, faceHold: 'video'}, s, FPS));
  assert.equal(new Set(video).size, 1, 'one position for the reel');
  assert.notEqual(video[0], 58);
  const pagina = placeCaptions({...p, faceHold: 'pagina'}, s, FPS);
  assert.deepEqual(tops(pagina).filter((t, k) => k !== 3), [58, 58, 58, 58], 'only the page over the face moves');
  assert.notEqual(pagina[3].topPct, 58);
  for (const c2 of [pagina, placeCaptions({...p, faceHold: 'video'}, s, FPS)]) assert.deepEqual(issues({...p, captions: c2}, s), []);
});

test('switching faceHold / faceShift re-places without re-paging: same pages, same words, only the position', () => {
  const s = {[A]: scan(10, (t) => [t >= 4 && t < 6 ? box(0.55, 0.62) : ABOVE])};
  const p = project();
  const strip = (caps) => caps.map(({topPct: _, slot: __, ...c}) => c);
  for (const hold of ['toma', 'video', 'pagina']) for (const faceShift of [0, 12, 40]) assert.deepEqual(strip(placeCaptions({...p, faceHold: hold, faceShift}, s, FPS)), strip(p.captions), `${hold} ±${faceShift}`);
  const a = placeCaptions({...p, faceHold: 'pagina'}, s, FPS);
  const b = placeCaptions({...p, faceHold: 'pagina', captions: placeCaptions({...p, faceHold: 'video'}, s, FPS)}, s, FPS);
  assert.deepEqual(tops(a), tops(b), 'placement starts from the pack\'s top, never from the last one');
});

test('validate: caption-face and what it could not see (pending, unavailable, switched off), filed under captions', async () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'faces-'));
  const was = process.env.REEL_FACE_AWARE;
  try {
    fs.mkdirSync(path.join(pub, 'clips', 'faces'), {recursive: true});
    // the first scans' basename file: read as a fallback
    fs.writeFileSync(path.join(pub, 'clips', 'faces', 'a.json'), JSON.stringify(scan(10, () => [box(0.55, 0.7)])));
    assert.ok(facesOf(project(), pub)[A].samples.length);
    const faces = (await projectIssues(project({faceShift: 0}), pub, {})).filter((i) => i.code === 'caption-face');
    assert.equal(faces.length, 1);
    assert.equal(faces[0].level, 'warn');
    assert.match(faces[0].msg, /worst at \d+\.\d s: face 55–70 %, captions 58–\d+ %/);
    // the clip on disk and no current scan: pending, queued; switched off: nothing at all
    fs.writeFileSync(path.join(pub, A), 'bytes');
    const kicked = [];
    const gaps = faceGaps(project(), pub, {kick: (s) => kicked.push(...s)});
    assert.deepEqual(gaps.map((g) => g.code), [gaps[0].code === 'caption-face-unavailable' ? 'caption-face-unavailable' : 'caption-face-pending']);
    if (gaps[0].code === 'caption-face-pending') assert.deepEqual(kicked, [A]);
    process.env.REEL_FACE_AWARE = '0';
    assert.deepEqual(faceGaps(project(), pub), []);
    assert.deepEqual((await projectIssues(project({faceShift: 0}), pub, {})).filter((i) => i.code.startsWith('caption-face')), []);
    delete process.env.REEL_FACE_AWARE;
    assert.deepEqual((await projectIssues(project({faceShift: 0, captionsOff: true}), pub, {})).filter((i) => i.code === 'caption-face'), [], 'captions off: nothing on screen');
    for (const code of ['caption-face', 'caption-face-pending', 'caption-face-unavailable']) assert.ok(RULES.captions.includes(code), code);
    assert.deepEqual(stageFindings({p: project(), fps: FPS, issues: faces}).captions.map((i) => i.code), ['caption-face']);
    assert.deepEqual(invalidate({faceShift: 12}, {faceShift: 20}).stale, ['captions', 'broll', 'entregables']);
    assert.deepEqual(invalidate({faceHold: 'toma'}, {faceHold: 'video'}).stale, ['captions', 'broll', 'entregables']);
  } finally { if (was == null) delete process.env.REEL_FACE_AWARE; else process.env.REEL_FACE_AWARE = was; fs.rmSync(pub, {recursive: true, force: true}); }
});

test('the scan caches a file that does not decode (never decoded again), one scan of a file at a time', async () => {
  const {scanFaces, readFaces, canScanFaces} = await import('../scripts/face-scan.mjs');
  if (!canScanFaces()) return; // the VM without the venv: faceGaps says caption-face-unavailable (above)
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'faces-bad-'));
  try {
    fs.mkdirSync(path.join(pub, 'clips'), {recursive: true});
    fs.writeFileSync(path.join(pub, 'clips', 'bad.mp4'), 'not a video');
    const [a, b] = [scanFaces(pub, 'clips/bad.mp4'), scanFaces(pub, 'clips/bad.mp4')];
    assert.equal(a, b, 'the same scan');
    await assert.rejects(a);
    assert.match(readFaces(pub, 'clips/bad.mp4')?.error ?? '', /face scan of clips\/bad\.mp4/, 'cached with its error');
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

test('the render judge: caption-face on what was rendered — the faces of the clean master next to the version\'s snapshot', async () => {
  const {captionFaceFindings} = await import('../.agents/skills/render-judge/judge.mjs');
  const {FACE_VERSION, canScanFaces} = await import('../scripts/face-scan.mjs');
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-faces-'));
  const name = `T_${path.basename(pub)}_v1_master.mp4`, dir = path.join(pub, 'reviews', 'p', 'v1'), master = path.join(dir, name);
  const cache = path.join(import.meta.dirname, '..', '.captions-tmp', 'judge', 'faces', `${name}.json`);
  try {
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(master, 'the master (bytes only: its scan is cached below)');
    fs.writeFileSync(path.join(dir, 'project.json'), '{}');
    const st = fs.statSync(master);
    fs.mkdirSync(path.dirname(cache), {recursive: true});
    // the master's own frames: a face at 50–62 % from 2 s on
    fs.writeFileSync(cache, JSON.stringify({version: FACE_VERSION, src: path.relative(pub, master), size: st.size, mtimeMs: Math.round(st.mtimeMs), rate: 2, samples: scan(10, (t) => (t >= 2 ? [box(0.5, 0.62)] : [])).samples}));
    const p = project({captionStyle: 'vibem', captions: [page('c0', A, 0, 0.7, 3, {topPct: 53}), page('c1', A, 3, 4.5, 3, {topPct: 53})]});
    const skipped = [];
    const f = await captionFaceFindings({p, rate: FPS, file: path.join(dir, 'captioned.mp4'), role: null, pair: null, snapshot: path.join(dir, 'project.json'), publicDir: pub, skipped});
    if (!canScanFaces()) { assert.match(skipped.join(), /caption-face: no YuNet/); return; } // the VM without the venv: listed, never a crash
    assert.deepEqual(skipped, []);
    assert.deepEqual(f.map((x) => [x.check, x.severity, x.kind, x.evidence.page]), [['caption-face', 'major', 'rule', 'c1']], 'only the page up while the face is there');
    assert.match(f[0].msg, /tapa una cara a los 3(\.\d+)? s: cara 50–62 %.*master limpio/);
  } finally { fs.rmSync(pub, {recursive: true, force: true}); fs.rmSync(cache, {force: true}); }
});

test('each moment by the page on screen then: a short page is not judged by the tall one, and the span stays in the safe zone', async () => {
  const {validateProject, captionBlock: block} = await import('../src/validate.ts');
  const V = presetOf('vibem');
  const words = (id, a, b, texts) => ({id, src: A, startMs: a * 1000, endMs: b * 1000, topPct: 53, words: texts.map((text, k) => ({wid: `${A}:${id}.${k}`, text, startMs: a * 1000 + k * 200, endMs: a * 1000 + k * 200 + 180}))});
  const tall = words('c0', 0, 2, ['DEPARTAMENTOS', 'CON', 'ROOF', 'GARDEN', 'Y', 'ALBERCA', 'PRIVADA']), short = words('c1', 3, 4.5, ['ÁREA']);
  const [ht, hs] = [tall, short].map((c) => block(c, V, false));
  // a face just under the short page, up only while the short page is: the tall page's band would reach it, the short one's does not
  const y = (53 - hs.up + hs.h + 2.5) / 100;
  assert.ok(y * 100 < 53 + ht.h - ht.up, 'inside the tall page\'s band');
  const s = {[A]: scan(10, (t) => (t >= 3 && t < 5 ? [box(y, y + 0.05)] : []))};
  const p = project({captionStyle: 'vibem', captions: [tall, short]});
  assert.deepEqual(tops(placeCaptions(p, s, FPS)), [53, 53]);
  // pushed down to the bottom of the reach, every page's ink stays over the Reels strip (no safe-bottom)
  const low = {[A]: scan(10, () => [box(0.4, 0.62)])};
  const q = {...p, faceShift: 40};
  const placed = placeCaptions(q, low, FPS);
  assert.notEqual(placed[0].topPct, 53);
  assert.deepEqual(validateProject({...q, captions: placed}, FPS).filter((i) => i.code === 'safe-bottom'), []);
});

test('a graphic is blocked space by the page\'s ink, not only by the render\'s estimate: no overlap-graphic', async () => {
  const {validateProject, placeBand, captionBand} = await import('../src/validate.ts');
  const page = {id: 'c0', src: A, startMs: 0, endMs: 2000, topPct: 53, words: ['HOY', 'ESTO', 'ESTÁ', 'EN', 'CONSTRUCCIÓN'].map((text, k) => ({wid: `${A}:c0.${k}`, text, startMs: k * 300, endMs: k * 300 + 250}))};
  const est = placeBand(page, 'vibem', 0), ink = captionBand(page, 'vibem', 0);
  assert.ok(ink.bottom > est.bottom + 1, 'the ink runs past the estimate (a line at the wrap width)');
  // a label just under where the render's estimate ends — inside the ink
  const label = {id: 'g0', template: 'label-2tone', src: A, startMs: 0, endMs: 3000, yPct: Math.round((est.bottom + 0.5) * 10) / 10, props: {top: 'CAVA', bottom: 'PRIVADA'}};
  const p = project({captionStyle: 'vibem', captions: [page], graphics: [label]});
  assert.equal(validateProject(p, FPS).filter((i) => i.code === 'overlap-graphic').length, 1, 'at the pack\'s top: the ink on the label');
  const placed = placeCaptions(p, {[A]: scan(10, () => [ABOVE])}, FPS);
  assert.deepEqual(validateProject({...p, captions: placed}, FPS).filter((i) => i.code === 'overlap-graphic'), []);
});

test('a take holding more than one position (the takes changed after placing) is reported, and a re-place mends it', () => {
  const s = {[A]: scan(20, () => [box(0.48, 0.555)])}; // clear unpunched, on the band punched in
  const clips = [clip('a1', A, 0, 4), clip('a2', A, 5, 9, {enter: 'punch'})];
  const caps = [page('c0', A, 0.5, 2), page('c1', A, 2.2, 3.3), page('c2', A, 5.5, 7), page('c3', A, 7.2, 8.5)];
  const p = {clips, captions: caps, captionStyle: 'palabra'};
  const placed = placeCaptions(p, s, FPS);
  assert.notEqual(placed[0].topPct, placed[2].topPct, 'two takes, two positions');
  // set_transitions: the punch becomes a plain cut — one take now, at two positions
  const plain = {...p, clips: [clips[0], {...clips[1], enter: 'cut'}], captions: placed};
  const [mixed] = captionFaceIssues(plain, s, FPS).filter((i) => i.code === 'caption-face-mixed');
  assert.match(mixed.msg, /captions c0, c1, c2, c3 on the take a1 \+ a2 .* sit at 2 positions .* re-place them \(set_captions face_shift 15\)/);
  const again = placeCaptions(plain, s, FPS);
  assert.equal(new Set(tops(again)).size, 1);
  assert.deepEqual(captionFaceIssues({...plain, captions: again}, s, FPS).filter((i) => i.code === 'caption-face-mixed'), []);
  assert.ok(RULES.captions.includes('caption-face-mixed'));
});

test('the advice says where the page is and the reach of the least covered top when nothing clears', () => {
  // the face covers the band for good, and a second one the top of the safe zone: nothing in the safe zone is clear
  const s = {[A]: scan(10, (t) => [box(0.1, 0.35), box(0.45, t < 5 ? 0.9 : 0.62)])};
  const p = project({faceShift: 5, faceHold: 'video'});
  const out = placeCaptions(p, s, FPS);
  const [i] = issues({...p, captions: out}, s);
  assert.match(i.msg, new RegExp(`no position inside the safe zone clears it \\(kept at ${out[0].topPct} %, covering for [\\d.]+ s\\); the least covered, at [\\d.]+ % \\([\\d.]+ s\\), is ±(\\d+) % away: set_captions face_shift \\1`));
});
