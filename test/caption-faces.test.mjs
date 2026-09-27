// Captions never cover a face (src/faces.ts): one position per hold span (a take, the reel, a page), clear of every
// face on screen through the composition's geometry, within ±faceShift of the pack's; validate's caption-face.
// Synthetic scans only — never a client's media or words.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {FACE_DEFAULTS, captionFaceIssues, faceKnobs, placeCaptions, screenFaces, takesOf} from '../src/faces.ts';
import {captionBlock} from '../src/validate.ts';
import {presetOf} from '../src/captionPresets.ts';
import {RULES, invalidate, stageFindings} from '../src/stages.ts';
import {projectIssues} from '../mcp/checks.mjs';

const FPS = 30;
const clip = (id, src, inSec, outSec, x = {}) => ({id, src, inSec, outSec, sourceDurationSec: 60, ...x});
// a page of n words over [a, b] s of its source (source ms = timeline ms for a clip that starts at 0)
const page = (id, src, a, b, n = 3, x = {}) => ({id, src, startMs: a * 1000, endMs: b * 1000, topPct: 58, ...x,
  words: Array.from({length: n}, (_, k) => ({wid: `${src}:${id}.${k}`, text: 'palabra', startMs: a * 1000 + (k * (b - a) * 1000) / n, endMs: a * 1000 + ((k + 1) * (b - a) * 1000) / n}))});
// a face box (fractions) at every half second of [from, to) s; faces(t) → the boxes at t
const scan = (dur, faces, extra = {}) => ({rate: 2, width: 1080, height: 1920, samples: Array.from({length: dur * 2}, (_, k) => ({t: k / 2, faces: faces(k / 2)})), ...extra});
const box = (top, bottom, left = 0.4, right = 0.6) => ({left, top, right, bottom, score: 0.9});
const ABOVE = box(0.2, 0.35); // a presenter's face well above the captions
const tops = (caps) => caps.map((c) => c.topPct);
const project = (x) => ({clips: [clip('a', 'clips/a.mp4', 0, 10)], captions: [0, 2, 4, 6, 8].map((s, k) => page(`c${k}`, 'clips/a.mp4', s, s + 1.5)), captionStyle: 'palabra', brolls: [], graphics: [], ...x});
const clearOf = (p, scans) => captionFaceIssues(p, scans, FPS).filter((i) => i.code === 'caption-face');

test('defaults every project gets, a kit overrides them, the project overrides the kit', () => {
  assert.deepEqual(faceKnobs({}), FACE_DEFAULTS);
  assert.deepEqual(FACE_DEFAULTS, {shift: 15, hold: 'toma'});
  const kit = {brand: {style: {faceShift: 12, faceHold: 'video'}}};
  assert.deepEqual(faceKnobs(kit), {shift: 12, hold: 'video'});
  assert.deepEqual(faceKnobs({...kit, faceShift: 0, faceHold: 'pagina'}), {shift: 0, hold: 'pagina'});
  assert.deepEqual(faceKnobs({...kit, faceShift: null, faceHold: null}), {shift: 12, hold: 'video'}, 'null = back to the kit');
});

test('pinned pack (vibem, the G1 case): the face above the band keeps 53 % on every take', () => {
  // G1's presenter: the face 43–50 % of the height, every take (shot changes at 3 and 6 s)
  const s = scan(10, () => [box(0.43, 0.5, 0.45, 0.55)], {cuts: [3, 6]});
  const p = project({captionStyle: 'vibem', captions: [0, 2, 4, 6, 8].map((t, k) => page(`c${k}`, 'clips/a.mp4', t, t + 1.5, 4, {topPct: 53}))});
  assert.equal(takesOf(p.clips, {'clips/a.mp4': s}, FPS).length, 3);
  for (const hold of ['toma', 'video', 'pagina']) assert.deepEqual(tops(placeCaptions({...p, faceShift: 12, faceHold: hold}, {'clips/a.mp4': s}, FPS)), [53, 53, 53, 53, 53]);
  assert.deepEqual(clearOf(p, {'clips/a.mp4': s}), []);
});

test('anchored pack: the base top kept when clear; one late sample on it moves the whole take', () => {
  const clear = {'clips/a.mp4': scan(10, () => [ABOVE])};
  assert.deepEqual(tops(placeCaptions(project(), clear, FPS)), [58, 58, 58, 58, 58]);
  // at 9 s the presenter leans in: the face reaches 55–66 % — the take's one position must clear it too
  const late = {'clips/a.mp4': scan(10, (t) => [t >= 9 ? box(0.55, 0.66) : ABOVE])};
  const out = placeCaptions(project(), late, FPS);
  assert.equal(new Set(tops(out)).size, 1, 'one top for the take');
  assert.notEqual(out[0].topPct, 58);
  assert.ok(Math.abs(out[0].topPct - 58) <= 15, `within ±15: ${out[0].topPct}`);
  assert.deepEqual(clearOf({...project(), captions: out}, late), [], 'and clear at every moment');
  assert.equal(clearOf(project(), late).length, 1, 'the base top is reported (one take)');
});

test('one top for all pages of a take, across a jump cut and a punch (the union of both framings)', () => {
  // the face sits 48–55 %: clear of 58 unpunched; the punch (1.12× about 50 % 38 %) brings it to 49–57 %, on the band
  const s = {'clips/a.mp4': scan(20, () => [box(0.48, 0.55)])};
  const clips = [clip('a1', 'clips/a.mp4', 0, 4), clip('a2', 'clips/a.mp4', 5, 9, {enter: 'punch'})];
  const caps = [page('c0', 'clips/a.mp4', 0.5, 2), page('c1', 'clips/a.mp4', 2.2, 3.5), page('c2', 'clips/a.mp4', 5.5, 7), page('c3', 'clips/a.mp4', 7.2, 8.5)];
  assert.equal(takesOf(clips, s, FPS).length, 1, 'a jump cut in one recording is one take');
  const face = (ms) => screenFaces({clips, captions: caps}, s, FPS)(ms)[0];
  assert.ok(Math.abs(face(1000).bottom - 55) < 0.01 && Math.abs(face(5000).bottom - (38 + 17 * 1.12)) < 0.01, 'the punch moves the box');
  const out = placeCaptions({clips, captions: caps, captionStyle: 'palabra'}, s, FPS);
  assert.equal(new Set(tops(out)).size, 1);
  assert.notEqual(out[0].topPct, 58, 'the punched half decides for the whole take');
  assert.deepEqual(clearOf({clips, captions: out, captionStyle: 'palabra'}, s), []);
});

test('a shot change inside one source splits takes: each holds its own position', () => {
  const s = {'clips/a.mp4': scan(10, (t) => [t >= 5 ? box(0.55, 0.66) : ABOVE], {cuts: [5]})};
  assert.deepEqual(takesOf(project().clips, s, FPS).map((t) => [t.startMs, t.endMs]), [[0, 5000], [5000, 10000]]);
  const caps = [[0, 1.2], [1.5, 2.7], [3, 4.2], [5.5, 7], [7.5, 9]].map(([a, b], k) => page(`c${k}`, 'clips/a.mp4', a, b));
  const out = tops(placeCaptions(project({captions: caps}), s, FPS));
  assert.deepEqual(out.slice(0, 3), [58, 58, 58], 'the first shot stays');
  assert.equal(new Set(out.slice(3)).size, 1);
  assert.notEqual(out[3], 58);
  // a page starting in the first shot and still up in the second holds the first shot's position — clear there too
  const straddle = project({captions: [page('c0', 'clips/a.mp4', 0, 1.5), page('c1', 'clips/a.mp4', 4.2, 4.9, 1), page('c2', 'clips/a.mp4', 5.5, 7)]});
  const t2 = tops(placeCaptions(straddle, s, FPS));
  assert.equal(t2[0], t2[1], 'the page that starts in take 1 holds take 1');
  assert.notEqual(t2[0], 58, 'its tail over the second shot moves take 1 too');
  assert.deepEqual(clearOf({...straddle, captions: placeCaptions(straddle, s, FPS)}, s), []);
});

test('the tallest page of the take decides where it goes', () => {
  const P = presetOf('palabra');
  const short = page('c0', 'clips/a.mp4', 0, 1.5, 1), tall = page('c1', 'clips/a.mp4', 3, 4.5, 6);
  const [h1, h6] = [short, tall].map((c) => captionBlock(c, P, false).h);
  const top = (58 + h1 + 58 + h6) / 2 / 100; // under the one-word block, inside the six-word one
  const s = {'clips/a.mp4': scan(10, () => [box(top, top + 0.06)])};
  assert.deepEqual(tops(placeCaptions(project({captions: [short]}), s, FPS)), [58], 'one short page: clear');
  const both = tops(placeCaptions(project({captions: [short, tall]}), s, FPS));
  assert.equal(both[0], both[1]);
  assert.notEqual(both[0], 58, 'the six-word page moves them both');
});

test('two faces: the position clears both', () => {
  // one on the band's left, one lower right: under the first is the second; over the first is free
  const s = {'clips/a.mp4': scan(10, () => [box(0.56, 0.64, 0.2, 0.45), box(0.66, 0.75, 0.55, 0.8)])};
  const out = placeCaptions(project(), s, FPS);
  assert.equal(new Set(tops(out)).size, 1);
  assert.ok(out[0].topPct < 56, `above both: ${out[0].topPct}`);
  assert.deepEqual(clearOf({...project(), captions: out}, s), []);
});

test('a B-roll face counts only while on screen; the presenter under a fullscreen B-roll does not', () => {
  const caps = [page('c0', 'clips/a.mp4', 0, 1.2), page('c1', 'clips/a.mp4', 2.2, 3.3), page('c2', 'clips/a.mp4', 5, 6)];
  const cue = (src) => ({id: 'b0', startMs: 1900, endMs: 4100, kind: 'video', mode: 'fullscreen', src});
  // the presenter is clear; the B-roll shows someone on the band
  const s = {'clips/a.mp4': scan(10, () => [ABOVE]), 'broll/x.mp4': scan(5, () => [box(0.56, 0.68)])};
  const p = project({captions: caps, brolls: [cue('broll/x.mp4')], faceHold: 'pagina'});
  const out = tops(placeCaptions(p, s, FPS));
  assert.equal(out[0], 58); assert.equal(out[2], 58);
  assert.notEqual(out[1], 58, 'the page over the B-roll moves');
  // the presenter's face on the band all along, a fullscreen B-roll with no one in it from 1.9 to 4.1 s
  const low = {'clips/a.mp4': scan(10, () => [box(0.56, 0.68)]), 'broll/empty.mp4': scan(5, () => [])};
  const q = tops(placeCaptions(project({captions: caps, brolls: [cue('broll/empty.mp4')], faceHold: 'pagina'}), low, FPS));
  assert.equal(q[1], 58, 'hidden by the B-roll: nothing to clear');
  assert.notEqual(q[0], 58); assert.notEqual(q[2], 58);
});

test('the framing moves the box: keyframes, a 16:9 source cropped into 9:16, a layout frame', () => {
  const at = (clips, s, graphics = []) => screenFaces({clips, captions: [], graphics}, s, FPS)(1000);
  const s = {'clips/a.mp4': scan(10, () => [box(0.4, 0.5)])};
  // zoom 2× about the centre: 40–50 % → 30–50 %
  const [z] = at([clip('a', 'clips/a.mp4', 0, 10, {transform: [{t: 0, scale: 2, x: 0, y: 0}]})], s);
  assert.ok(Math.abs(z.top - 30) < 0.01 && Math.abs(z.bottom - 50) < 0.01, JSON.stringify(z));
  // a landscape source: its sides are cropped away — a face at the far left is not on screen
  const wide = {'clips/a.mp4': scan(10, () => [box(0.4, 0.5, 0.02, 0.12), box(0.4, 0.5, 0.45, 0.55)], {width: 1920, height: 1080})};
  const shown = at([clip('a', 'clips/a.mp4', 0, 10)], wide);
  assert.equal(shown.length, 1);
  assert.ok(Math.abs(shown[0].left - (50 - (0.05 * 1920 * (1920 / 1080)) / 10.8)) < 0.01, JSON.stringify(shown[0]));
  // a layout frame (inset 12 %): the footage sits in 12–88 %
  const layout = {id: 'g0', template: 'layout', src: 'clips/a.mp4', startMs: 0, endMs: 10000, props: {shape: 'rounded', canvas: 'dark', inset: 12}};
  const [f] = at([clip('a', 'clips/a.mp4', 0, 10)], s, [layout]);
  assert.ok(Math.abs(f.top - (12 + 0.76 * 40)) < 0.01 && Math.abs(f.bottom - (12 + 0.76 * 50)) < 0.01, JSON.stringify(f));
});

test('framed layout pack: faces mapped through the frame decide, not the raw source', () => {
  // 71–78 % of the source: clear of a two-line palabra page at 58 % full-bleed; inside a 12 % frame it lands at 66–71 %, on it
  const s = {'clips/a.mp4': scan(10, () => [box(0.71, 0.78)])};
  const caps = [page('c0', 'clips/a.mp4', 0, 2), page('c1', 'clips/a.mp4', 3, 5)];
  const layout = {id: 'g0', template: 'layout', src: 'clips/a.mp4', startMs: 0, endMs: 10000, props: {shape: 'rounded', canvas: 'dark', inset: 12}};
  assert.deepEqual(tops(placeCaptions(project({captions: caps}), s, FPS)), [58, 58]);
  const framed = placeCaptions(project({captions: caps, graphics: [layout]}), s, FPS);
  assert.notEqual(framed[0].topPct, 58);
  assert.deepEqual(clearOf(project({captions: framed, graphics: [layout]}), s), []);
});

test('floating pack (prism): a blocked corner moves to the nearest clear one; the others keep cycling', () => {
  // a face in the top-left corner: the first slot (15 %, left) is blocked, the right one (18 %) is not
  const s = {'clips/a.mp4': scan(10, () => [box(0.1, 0.3, 0.05, 0.4)])};
  const caps = [page('c0', 'clips/a.mp4', 0, 1.5, 2), page('c1', 'clips/a.mp4', 2, 3.5, 2), page('c2', 'clips/a.mp4', 4, 5.5, 2)];
  const p = project({captionStyle: 'prism', captions: caps, faceHold: 'pagina'});
  const out = placeCaptions(p, s, FPS);
  assert.deepEqual([out[0].slot, out[0].topPct], [1, 18], 'the left corner moves right');
  assert.equal(out[1].slot, undefined, 'a clear corner is left to the cycle');
  assert.equal(out[2].slot, undefined);
  assert.equal(clearOf(p, s).length, 1, 'before: the first page over the face');
  assert.deepEqual(clearOf({...p, captions: out}, s), []);
});

test('faceShift 0: never moves, only reports; faceShift limits the move — out of range the base stays and is reported', () => {
  const s = {'clips/a.mp4': scan(10, () => [box(0.55, 0.7)])};
  assert.deepEqual(tops(placeCaptions(project({faceShift: 0}), s, FPS)), [58, 58, 58, 58, 58]);
  const r0 = clearOf(project({faceShift: 0}), s);
  assert.equal(r0.length, 1);
  assert.match(r0[0].msg, /take a \(0\.0–10\.0 s\).*raise the reach to ±\d+ % \(set_captions face_shift \d+; now ±0\)/);
  // ±5 cannot clear a face 55–70 %: kept at 58 and reported; ±20 can
  assert.deepEqual(tops(placeCaptions(project({faceShift: 5}), s, FPS)), [58, 58, 58, 58, 58]);
  assert.equal(clearOf(project({faceShift: 5}), s).length, 1);
  const far = placeCaptions(project({faceShift: 20}), s, FPS);
  assert.ok(Math.abs(far[0].topPct - 58) <= 20 && far[0].topPct !== 58, String(far[0].topPct));
  assert.deepEqual(clearOf(project({faceShift: 20, captions: far}), s), []);
});

test('hand-placed pages are never moved, and still reported', () => {
  const s = {'clips/a.mp4': scan(10, () => [box(0.55, 0.7)])};
  const p = project({captions: [page('c0', 'clips/a.mp4', 0, 1.5, 3, {pin: true, topPct: 60})], faceShift: 30});
  assert.deepEqual(placeCaptions(p, s, FPS), p.captions);
  const [i] = clearOf(p, s);
  assert.match(i.msg, /c0 was placed by hand: move it \(edit_caption top_pct\)/);
});

test('faceHold: video = one top for the whole reel; pagina = each page on its own, each clear', () => {
  // two sources, two takes: only the second has a face on the band, and only during its second page
  const s = {'clips/a.mp4': scan(10, () => [ABOVE]), 'clips/b.mp4': scan(10, (t) => [t >= 2 && t < 4 ? box(0.55, 0.66) : ABOVE])};
  const clips = [clip('a', 'clips/a.mp4', 0, 5), clip('b', 'clips/b.mp4', 0, 6)];
  const caps = [page('c0', 'clips/a.mp4', 0, 1.5), page('c1', 'clips/a.mp4', 2.5, 4), page('c2', 'clips/b.mp4', 0.2, 1.5), page('c3', 'clips/b.mp4', 2.2, 3.5), page('c4', 'clips/b.mp4', 4.5, 5.5)];
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
  for (const caps2 of [pagina, placeCaptions({...p, faceHold: 'video'}, s, FPS)]) assert.deepEqual(clearOf({...p, captions: caps2}, s), []);
});

test('switching faceHold / faceShift re-places without re-paging: same pages, same words, only the position', () => {
  const s = {'clips/a.mp4': scan(10, (t) => [t >= 4 && t < 6 ? box(0.55, 0.66) : ABOVE])};
  const p = project();
  const strip = (caps) => caps.map(({topPct: _, slot: __, ...c}) => c);
  for (const hold of ['toma', 'video', 'pagina']) for (const faceShift of [0, 12, 40]) {
    const out = placeCaptions({...p, faceHold: hold, faceShift}, s, FPS);
    assert.deepEqual(strip(out), strip(p.captions), `${hold} ±${faceShift}`);
  }
  // and back: the same knobs give the same positions (placement starts from the pack's, never from the last one)
  const a = placeCaptions({...p, faceHold: 'pagina'}, s, FPS);
  const b = placeCaptions({...p, faceHold: 'pagina', captions: placeCaptions({...p, faceHold: 'video'}, s, FPS)}, s, FPS);
  assert.deepEqual(tops(a), tops(b));
});

test('validate: caption-face through projectIssues (the MCP validate, GET /api/validate, the editor), filed under captions', async () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'faces-'));
  try {
    fs.mkdirSync(path.join(pub, 'clips', 'faces'), {recursive: true});
    fs.writeFileSync(path.join(pub, 'clips', 'faces', 'a.json'), JSON.stringify(scan(10, () => [box(0.55, 0.7)])));
    const issues = await projectIssues(project({faceShift: 0}), pub, {});
    const faces = issues.filter((i) => i.code === 'caption-face');
    assert.equal(faces.length, 1);
    assert.equal(faces[0].level, 'warn');
    assert.equal(faces[0].ref, 'c0');
    assert.match(faces[0].msg, /worst at \d+\.\d s: face 55–70 %, captions 58–\d+ %/);
    assert.ok(RULES.captions.includes('caption-face'));
    const r = stageFindings({p: project(), fps: FPS, issues: faces});
    assert.deepEqual(r.captions.map((i) => i.code), ['caption-face']);
    assert.deepEqual(invalidate({faceShift: 12}, {faceShift: 20}).stale, ['captions', 'broll', 'entregables']);
    assert.deepEqual(invalidate({faceHold: 'toma'}, {faceHold: 'video'}).stale, ['captions', 'broll', 'entregables']);
    // captions off: nothing on screen to cover a face
    assert.deepEqual((await projectIssues(project({faceShift: 0, captionsOff: true}), pub, {})).filter((i) => i.code === 'caption-face'), []);
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
    const p = project({captionStyle: 'vibem', captions: [page('c0', 'clips/a.mp4', 0, 1.2, 3, {topPct: 53}), page('c1', 'clips/a.mp4', 3, 4.5, 3, {topPct: 53})]});
    const skipped = [];
    const f = await captionFaceFindings({p, rate: FPS, file: path.join(dir, 'captioned.mp4'), role: null, pair: null, snapshot: path.join(dir, 'project.json'), publicDir: pub, skipped});
    if (!canScanFaces()) { assert.match(skipped.join(), /caption-face: no YuNet/); return; } // the VM without the venv: listed, never a crash
    assert.deepEqual(skipped, []);
    assert.deepEqual(f.map((x) => [x.check, x.severity, x.kind, x.evidence.page]), [['caption-face', 'major', 'rule', 'c1']], 'only the page up while the face is there');
    assert.match(f[0].msg, /tapa una cara a los 3(\.\d+)? s: cara 50–62 %.*master limpio/);
  } finally { fs.rmSync(pub, {recursive: true, force: true}); fs.rmSync(cache, {force: true}); }
});
