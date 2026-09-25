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

// ---- client feedback (César): noise as candidates, new checks, profiles ----
import {offMicFindings, paginationFindings, accentSizeFindings, glossaryFindings, parseInserts, insertFindings, sentencesOf, parsePhone, phoneFindings, lookOf, colorRefFindings, parityFindings, pickProfile, reelOf, listProfiles} from '../.agents/skills/render-judge/judge.mjs';

test('candidates never count until the judge confirms them on the frame', () => {
  const cand = {check: 'split-name', severity: 'major', kind: 'candidate'};
  assert.equal(verdictOf([cand]).verdict, 'PASS');
  assert.equal(verdictOf([cand]).toConfirm, 1);
  assert.equal(verdictOf([{...cand, confirmed: 'frame 6.2 s: Montealbán | 326'}]).verdict, 'FAIL');
  assert.match(verdictOf([]).label, /^QC técnico superado$/);
  assert.match(verdictOf([], {reduced: true}).label, /evidencia reducida/);
  assert.ok(!/aprobado/i.test(verdictOf([{check: 'x', severity: 'major', kind: 'rule'}]).label));
});

test('a dramatic pause is a candidate; a reasonless one mid-sentence and dead air are rules', () => {
  const clips = [clip('a', 'a', 0, 20)];
  const tr = [{clipId: 'a', source: 'a', words: [TW(0, 'cuesta', 0, 300), TW(1, 'solo', 1100, 1300), TW(2, 'dos', 1320, 1500), TW(3, 'millones.', 1520, 1900), TW(4, 'Y', 3000, 3100), TW(5, 'hoy', 5300, 5500)]}];
  const f = pauseFindings(words(clips, tr), clips, new Set(['a:1'])); // "solo" is highlighted
  assert.deepEqual(f.map((x) => [x.evidence.from, x.severity, x.kind]), [['a:0', 'minor', 'candidate'], ['a:3', 'minor', 'candidate'], ['a:4', 'major', 'rule']]);
  assert.match(f[2].msg, /aire muerto/);
});

test('a capitalized pair split across pages is a candidate; a glossary term is a rule', () => {
  const pages = [
    page('c0', 'a', [CW('a:0', 'el', 0, 200), CW('a:1', 'Playa', 250, 500)]),
    page('c1', 'a', [CW('a:2', 'Del', 520, 700), CW('a:3', 'Carmen.', 720, 900)]),
    page('c2', 'a', [CW('a:4', 'con', 1000, 1200), CW('a:5', 'sky', 1250, 1400)]),
    page('c3', 'a', [CW('a:6', 'pool', 1420, 1700)]),
  ];
  const f = splitNameFindings(pages, [{term: 'skypool', variants: ['sky pool']}]);
  assert.deepEqual(f.map((x) => [x.evidence.pages.join('|'), x.kind]), [['c0|c1', 'candidate'], ['c2|c3', 'rule']]);
});

test('crew talk and a camera read are not off-mic', () => {
  const clips = [clip('a', 'a', 0, 30)];
  const W2 = (i, word, s, off = false) => ({i, word, startMs: s, endMs: s + 250, ...(off ? {off: true} : {})});
  const tr = [{clipId: 'a', source: 'a', words: [
    W2(0, 'tres', 0, true), W2(1, 'dos', 400, true), W2(2, 'uno', 800, true), W2(3, 'listo', 1200, true),
    W2(4, 'tiene', 4000, true), W2(5, 'noventa', 4300, true), W2(6, 'metros', 4600, true),
    W2(7, 'Tiene', 7000), W2(8, 'noventa', 7300), W2(9, 'metros.', 7600),
    W2(10, 'dile', 10000, true), W2(11, 'lo', 10300, true), W2(12, 'del', 10600, true), W2(13, 'precio', 10900, true),
  ]}];
  const f = offMicFindings(words(clips, tr));
  assert.deepEqual(f.map((x) => [x.check, x.severity]), [['crew-talk', 'major'], ['read-through', 'major'], ['off-mic', 'blocker']]);
  assert.deepEqual(f[0].fix[0].args.ranges, [{from_wid: 'a:0', to_wid: 'a:3'}]);
});

test('one page per sentence; accent at the plain size; the glossary wins', () => {
  const f = paginationFindings([page('c0', 'a', [CW('a:0', 'Tiene', 0, 300), CW('a:1', 'alberca.', 350, 800), CW('a:2', 'Y', 900, 1000), CW('a:3', 'gym', 1050, 1400)])]);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].fix.map((x) => x.tool), ['delete_captions', 'add_caption', 'add_caption']);
  assert.equal(f[0].fix[2].args.text, 'Y gym');
  assert.equal(accentSizeFindings('vibem').length, 1); // vibem ships tier 1/2 at 1.15× today
  const g = glossaryFindings([{text: 'con sky pool privado', ref: 'c4', at: 3}, {text: 'SKYPOOL', ref: 'g1', at: 0}], [{term: 'skypool', variants: ['sky pool', 'skypul']}]);
  assert.equal(g.length, 1); // "SKYPOOL" is the term (case is the style's)
  assert.equal(g[0].fix[0].args.text, 'con skypool privado');
});

test('script inserts: parsed from the plan, covered by a matching cue or super near the mention', () => {
  const plan = 'IDEA: x\nINSERTS:\n- hospitales → broll: hospital, clinica\n- super de calle → super: calle, avenida\n- universidades → broll: universidad\nMUSIC: none';
  const ins = parseInserts(plan);
  assert.deepEqual(ins.map((x) => [x.what, x.need]), [['hospitales', 'broll'], ['super de calle', 'super'], ['universidades', 'broll']]);
  const clips = [clip('a', 'a', 0, 30)];
  const w = words(clips, [{clipId: 'a', source: 'a', words: [TW(0, 'cerca', 9000, 9300), TW(1, 'hospitales', 9350, 9900), TW(2, 'universidades', 20000, 20800)]}]);
  const brolls = [{id: 'b0', src: 'broll/hospital-angeles.mp4', kind: 'video', mode: 'fullscreen', startMs: 9300, endMs: 11500}];
  const gfx = [{id: 'g0', template: 'location-tag', props: {place: 'Av. Reforma', sub: 'Avenida principal'}, startMs: 0, endMs: 2000}];
  const f = insertFindings(ins, w, brolls, gfx);
  assert.deepEqual(f.map((x) => x.evidence.insert), ['universidades']);
  assert.equal(f[0].severity, 'blocker');
  assert.equal(f[0].fix.at(-1).args.at_wid, 'a:2');
});

test('phone filter only on the interviewer\'s questions', () => {
  const clips = [clip('a', 'a', 0, 30)];
  const S = (i, word, s, speaker) => ({i, word, startMs: s, endMs: s + 400, speaker});
  const w = words(clips, [{clipId: 'a', source: 'a', words: [S(0, '¿Cuánto', 0, 'spk2'), S(1, 'cuesta?', 500, 'spk2'), S(2, 'Dos', 1500, 'spk1'), S(3, 'millones.', 2000, 'spk1'), S(4, 'Y', 3000, 'spk1'), S(5, 'más.', 3500, 'spk1')]}]);
  const band = (t0, t1, phone) => Array.from({length: Math.round((t1 - t0) * 10)}, (_, k) => ({t: t0 + k / 10 + 0.3, full: -20, low: phone ? -50 : -26, high: phone ? -48 : -30}));
  const bands = [...band(0, 0.9, true), ...band(1.5, 2.4, true), ...band(3.0, 3.9, false)];
  const f = phoneFindings(sentencesOf(w), bands, parsePhone('PHONE: questions'));
  assert.deepEqual(f.map((x) => [x.evidence.from, x.check]), [['a:2', 'phone-filter']]); // the answer is filtered: wrong
  assert.match(f[0].msg, /donde no va/);
  assert.equal(parsePhone('PHONE: none').none, true);
});

test('color against the approved reference, parity between clean master and captioned', () => {
  const s = (Y, sat) => ({YAVG: Y, YHIGH: Y + 60, YLOW: Y - 60, SATAVG: sat, UAVG: 128, VAVG: 130});
  const f = colorRefFindings(lookOf([s(150, 40), s(152, 42)]), lookOf([s(120, 60), s(122, 58)]), 'G1 v2 aprobado');
  assert.equal(f.length, 1);
  assert.match(f[0].msg, /más claro.*menos saturado/);
  assert.ok(f[0].fix[0].args.exposure < 0 && f[0].fix[0].args.saturation > 1);
  const M = Array.from({length: 50}, (_, k) => ({t: k / 10, M: -20}));
  assert.deepEqual(parityFindings({duration: 5, cuts: [1, 2.5], M}, {duration: 5, cuts: [1.02, 2.5], M}), []);
  const bad = parityFindings({duration: 5, cuts: [1, 2.5], M}, {duration: 5.2, cuts: [1], M: M.map((m) => ({...m, M: -25}))});
  assert.deepEqual(bad.map((x) => x.severity), ['blocker', 'major', 'major']);
});

test('the César profile is picked by caption style or brand, and knows G1 / G7', () => {
  const cesar = listProfiles().find((x) => x.id === 'cesar');
  assert.ok(cesar);
  assert.equal(pickProfile({captionStyle: 'vibem'})?.id, 'cesar');
  assert.equal(pickProfile({captionStyle: 'prism', brand: {name: 'VIBEM'}})?.id, 'cesar');
  assert.equal(pickProfile({captionStyle: 'prism'}), null);
  assert.throws(() => pickProfile({}, 'nobody'), /no judge profile/);
  assert.ok(reelOf(cesar, 'Depto G1 v2')?.inserts?.length >= 4);
  assert.equal(reelOf(cesar, 'Torre G12'), null);
  assert.ok(reelOf(cesar, 'G7 entrevista')?.phone);
});
