import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pauseFindings, splitNameFindings, captionTextFindings, consistencyFindings, repeatFindings, repeatedFootageFindings, overflowFindings, verdictOf, diffWithPrev, dhash, hamming, timelineSpeech} from '../.agents/skills/render-judge/judge.mjs';

const clip = (id, src, inSec, outSec) => ({id, src: `clips/${src}.mp4`, inSec, outSec, sourceDurationSec: 30});
const TW = (i, word, s, e) => ({i, word, startMs: s, endMs: e});
const words = (clips, tr) => timelineSpeech(clips, tr).words;

test('timelineSpeech places transcript words on the timeline through the clips', () => {
  const clips = [clip('a', 'a', 1, 3), clip('b', 'a', 5, 6)];
  const tr = [{clipId: 'a', source: 'a', words: [TW(0, 'hola', 1200, 1500), TW(1, 'fuera', 4000, 4200)]}, {clipId: 'b', source: 'a', words: [TW(2, 'otra', 5100, 5400)]}];
  const {words: w, missing} = timelineSpeech(clips, tr);
  assert.deepEqual(missing, []);
  assert.deepEqual(w.map((x) => [x.wid, +x.t0.toFixed(2)]), [['a:0', 0.2], ['a:2', 2.1]]);
  assert.deepEqual(timelineSpeech(clips, []).missing, ['a', 'b']);
});

test('pauses: mid-sentence gap is major, after a full stop only past the longer threshold', () => {
  const clips = [clip('a', 'a', 0, 10)];
  const tr = [{clipId: 'a', source: 'a', words: [TW(0, 'tiene', 0, 300), TW(1, 'noventa', 1000, 1300), TW(2, 'metros.', 1320, 1600), TW(3, 'Y', 2300, 2400), TW(4, 'cuesta', 2420, 2800)]}];
  const f = pauseFindings(words(clips, tr), clips);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'major');
  assert.match(f[0].msg, /tiene.*noventa/);
  assert.deepEqual(f[0].fix.map((x) => x.tool), ['split_clip', 'trim_clip', 'trim_clip']); // seconds computed here, not by the agent
  assert.equal(f[0].fix[1].args.out_sec, 0.45);
});

const page = (id, clipId, ws) => ({id, clipId, src: 'clips/a.mp4', words: ws, startMs: ws[0].startMs, endMs: ws.at(-1).endMs, topPct: 58});
const CW = (wid, text, s, e, tier = 0) => ({wid, text, startMs: s, endMs: e, tier});

test('a compound name or name + number split across pages is flagged, unrelated neighbours are not', () => {
  const pages = [
    page('c0', 'a', [CW('a:0', 'en', 0, 200), CW('a:1', 'Playa', 250, 500)]),
    page('c1', 'a', [CW('a:2', 'Del', 520, 700), CW('a:3', 'Carmen.', 720, 900)]),
    page('c2', 'a', [CW('a:4', 'Montealbán', 1000, 1400)]),
    page('c3', 'a', [CW('a:5', '326.', 1420, 1800)]),
    page('c4', 'a', [CW('a:9', 'Juan', 2000, 2300)]), // not the word after 326 → a new sentence, not a split
  ];
  const f = splitNameFindings(pages);
  assert.deepEqual(f.map((x) => x.evidence.pages), [['c0', 'c1'], ['c2', 'c3']]);
  assert.match(f[1].msg, /nombre \+ número/);
  assert.equal(f[1].fix[1].tool, 'delete_captions'); // the one-word page goes away
});

test('caption sync is one finding per page, with the worst word', () => {
  const clips = [clip('a', 'a', 0, 10)];
  const tr = [{clipId: 'a', source: 'a', words: [TW(0, 'El', 1000, 1200), TW(1, 'precio', 1250, 1600)]}];
  const w = words(clips, tr);
  const shifted = [page('c0', 'a', [CW('a:0', 'El', 1300, 1500), CW('a:1', 'precio', 1850, 2200)])];
  const f = captionTextFindings(shifted, w).filter((x) => x.check === 'sync');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'blocker'); // 600 ms late
  assert.equal(f[0].evidence.deltaMs, 600);
  assert.deepEqual(captionTextFindings([page('c0', 'a', [CW('a:0', 'El', 1000, 1200), CW('a:1', 'precio', 1250, 1600)])], w), []);
});

test('uncaptioned speech and a lost accent are flagged', () => {
  const clips = [clip('a', 'a', 0, 10)];
  const tr = [{clipId: 'a', source: 'a', words: [TW(0, 'Está', 0, 300), TW(1, 'en', 350, 450), TW(2, 'uno', 2000, 2200), TW(3, 'dos', 2250, 2400), TW(4, 'tres', 2450, 2700)]}];
  const f = captionTextFindings([page('c0', 'a', [CW('a:0', 'Esta', 0, 300), CW('a:1', 'en', 350, 450)])], words(clips, tr));
  assert.deepEqual(f.map((x) => x.check).sort(), ['coverage', 'spelling']);
  assert.equal(f.find((x) => x.check === 'spelling').fix[0].args.text, 'Está en');
});

test('the same word spelled two ways across captions and graphics — the accented one wins', () => {
  const f = consistencyFindings([{text: 'Está en Montealbán', ref: 'c2', at: 5}, {text: 'Montealban 326', ref: 'g0', at: 1}]);
  assert.equal(f.length, 1);
  assert.match(f[0].msg, /la buena es "montealbán"/);
  assert.deepEqual(f[0].fix.map((x) => x.tool), ['edit_graphic']);
});

test('a line said twice is flagged with the earlier take to cut', () => {
  const clips = [clip('a', 'a', 0, 30)];
  const line = ['este', 'departamento', 'tiene', 'noventa', 'metros'];
  const ws = [...line, 'y', ...line].map((w, i) => TW(i, w, i * 400, i * 400 + 300));
  const f = repeatFindings(words(clips, [{clipId: 'a', source: 'a', words: ws}]));
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].fix[0].args.ranges, [{from_wid: 'a:0', to_wid: 'a:4'}]);
});

test('repeated footage: overlapping source ranges and the same B-roll twice', () => {
  const clips = [clip('a', 'a', 0, 5), clip('b', 'b', 0, 3), clip('c', 'a', 2, 4)];
  const brolls = [{id: 'b0', src: 'broll/pool.mp4', kind: 'video', mode: 'fullscreen', startMs: 1000, endMs: 2000}, {id: 'b1', src: 'broll/pool.mp4', kind: 'video', mode: 'fullscreen', startMs: 6000, endMs: 7000}];
  const f = repeatedFootageFindings(clips, brolls);
  assert.deepEqual(f.map((x) => x.severity), ['blocker', 'major']);
});

test('dhash + hamming: the same frame is 0 apart, an inverted one far', () => {
  const px = Uint8Array.from({length: 72}, (_, i) => (i * 37) % 251);
  const inv = px.map((x) => 255 - x);
  assert.equal(hamming(dhash(px), dhash(px)), 0);
  assert.ok(hamming(dhash(px), dhash(inv)) > 40);
});

test('overflow: a word too wide even at the minimum size is a blocker', () => {
  const f = overflowFindings([page('c0', 'a', [CW(undefined, 'INCREÍBLEMENTEESPECTACULARÍSIMO', 0, 1000, 2)])].map((c) => ({...c, scale: 1.6})), 'palabra');
  assert.equal(f[0].severity, 'blocker');
  assert.deepEqual(overflowFindings([page('c0', 'a', [CW('a:0', 'Tu', 0, 300), CW('a:1', 'cava', 350, 900)])], 'palabra'), []);
});

test('verdict: PASS only with no blocker, no major and no minor pattern', () => {
  const m = (check, severity, extra = {}) => ({check, severity, ...extra});
  assert.equal(verdictOf([m('glue', 'minor'), m('x', 'nit')]).verdict, 'PASS');
  assert.equal(verdictOf([m('pause', 'major')]).verdict, 'FAIL');
  assert.equal(verdictOf([m('pause', 'major', {dismissed: 'frame shows it is fine'})]).verdict, 'PASS');
  const three = verdictOf([m('glue', 'minor'), m('glue', 'minor'), m('glue', 'minor')]);
  assert.equal(three.verdict, 'FAIL');
  assert.deepEqual(three.patterns, ['glue']);
});

test('diff with the previous iteration: fixed, regressions and findings that survive', () => {
  const prev = {findings: [{id: 'pause@2.5', check: 'pause', at: 2.5, msg: 'a', seen: 2}, {id: 'sync@8.8', check: 'sync', at: 8.8, ref: 'c4', msg: 'b'}]};
  const now = [{id: 'pause@2.6', check: 'pause', at: 2.6, severity: 'major'}, {id: 'overflow@1.0', check: 'overflow', at: 1, severity: 'blocker'}];
  const d = diffWithPrev(now, prev);
  assert.equal(d.fixed.length, 1);
  assert.deepEqual(d.regressions, ['overflow@1.0']);
  assert.deepEqual(d.stuck, ['pause@2.6']);
});
