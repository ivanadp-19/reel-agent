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
  const f = splitNameFindings(pages, [], 'vibem');
  assert.deepEqual(f.map((x) => x.evidence.pages), [['c0', 'c1'], ['c2', 'c3']]);
  assert.match(f[1].msg, /nombre \+ número/);
  // never delete / retype pages: highlight both words (a span the pager never splits), then re-page
  assert.deepEqual(f[1].fix.map((x) => x.tool), ['annotate_captions', 'set_caption_style']);
  assert.deepEqual(f[1].fix[0].args.items.map((x) => x.wid), ['a:4', 'a:5']);
  assert.equal(f[1].fix[1].args.style, 'vibem');
  assert.equal(f[1].fix[1].changesIds, true);
  assert.equal(splitNameFindings(pages, [], 'prism')[1].fix[0].tool, 'escalate'); // a pack that does not bond names
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
  const f = paginationFindings([page('c0', 'a', [CW('a:0', 'Tiene', 0, 300), CW('a:1', 'alberca.', 350, 800), CW('a:2', 'Y', 900, 1000), CW('a:3', 'gym', 1050, 1400)])], 'vibem');
  assert.equal(f.length, 1);
  // a generated page is re-paged by the shared pager (keeps word ids, accents, timing) — never deleted and retyped
  assert.deepEqual(f[0].fix.map((x) => [x.tool, x.args.style, x.changesIds]), [['set_caption_style', 'vibem', true]]);
  const hand = paginationFindings([{...page('c1', 'a', [CW(undefined, 'Tiene', 0, 300), CW(undefined, 'alberca.', 350, 800), CW(undefined, 'Y', 900, 1000)]), covers: ['a:0']}], 'vibem');
  assert.deepEqual(hand[0].fix.map((x) => [x.tool, x.args.text]), [['edit_caption', 'Tiene alberca.']]);
  assert.ok(!f.concat(hand).some((x) => x.fix.some((y) => y.tool === 'delete_captions' || y.tool === 'add_caption')));
  assert.deepEqual(accentSizeFindings('vibem'), []); // César: yellow at the same size as white — decided in the preset
  assert.equal(accentSizeFindings('prism').length, 1); // a pack with bigger key words is flagged
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

// ---- review of PR #15: J/L-cuts, spelling homographs, shared caption layout, inserts by token ----
import {consistencyFindings as consistency2, hasKeyword, textValues, DIACRITIC} from '../.agents/skills/render-judge/judge.mjs';
import {fitPage, pageUnits, captionPreset} from '../src/captionLayout.ts';
import {presetOf} from '../src/captionPresets.ts';
import {textWidthEm} from '../src/textFit.ts';

test('J/L-cuts: words are placed where the render plays their audio', () => {
  const clips = [clip('a', 'a', 0, 3), {...clip('b', 'b', 0, 3), jSec: 1}, {...clip('c', 'c', 0, 2), lSec: 1}, clip('d', 'd', 0, 2)];
  const tr = [
    {clipId: 'a', source: 'a', words: [TW(0, 'uno', 2000, 2400)]},
    {clipId: 'b', source: 'b', words: [TW(0, 'hola', 200, 500), TW(1, 'mundo.', 1200, 1600)]},
    {clipId: 'c', source: 'c', words: [TW(0, 'dos', 500, 800), TW(1, 'fin', 2200, 2500)]}, // "fin" is past outSec: heard in the L-cut
    {clipId: 'd', source: 'd', words: []},
  ];
  const w = words(clips, tr);
  const at = (wid) => +w.find((x) => x.wid === wid).t0.toFixed(2);
  assert.equal(at('b:0'), 2.2); // the J lead: 1 s before b starts at 3 s
  assert.equal(w.find((x) => x.wid === 'b:0').jl, 'lead');
  assert.equal(at('b:1'), 4.2); // after the lead, the clip's own audio
  assert.equal(at('c:1'), 8.2); // c ends at 8 s; its L-cut carries "fin" under d
  assert.equal(w.find((x) => x.wid === 'c:1').jl, 'trail');
  const f = pauseFindings(w, clips);
  assert.deepEqual(f.filter((x) => x.evidence.from === 'b:0').map((x) => x.check), ['jcut-gap']); // the render mutes b's first second after the cut (a named check, not a "pausa rara")
  assert.equal(f[0].fix[0].args.j_sec, 0);
  // no "cut-tight" for the J overlap, and a muted clip is not heard at all
  assert.ok(!f.some((x) => x.check === 'cut-tight'));
  assert.ok(!words([{...clips[0], muted: true}], tr).length);
});

test('spelling: diacritic pairs are different words; only names are a rule', () => {
  assert.ok(DIACRITIC.has('esta') && DIACRITIC.has('que') && DIACRITIC.has('como'));
  assert.deepEqual(consistency2([{text: 'Esta casa tiene alberca', ref: 'c0', at: 0}, {text: 'Aquí está la alberca', ref: 'c1', at: 2}, {text: 'qué vista y que bien', ref: 'c2', at: 3}]), []);
  const f = consistency2([{text: 'Vive en Montealbán', ref: 'c0', at: 0}, {text: 'en Montealban 326', ref: 'c1', at: 2}, {text: 'un balcon', ref: 'c2', at: 3}, {text: 'el balcón', ref: 'c3', at: 4}]);
  assert.deepEqual(f.map((x) => [x.kind, x.severity]), [['rule', 'major'], ['candidate', 'minor']]);
  assert.equal(f[0].fix[0].args.text, 'en Montealbán 326'); // the fix keeps the capital
  // the per-word accent check against the transcript: "Esta" for "Está" is only a candidate
  const clips = [clip('a', 'a', 0, 10)];
  const g = captionTextFindings([page('c0', 'a', [CW('a:0', 'Esta', 0, 300), CW('a:1', 'aquí', 350, 600)])], words(clips, [{clipId: 'a', source: 'a', words: [TW(0, 'Está', 0, 300), TW(1, 'aquí', 350, 600)]}]));
  assert.deepEqual(g.map((x) => x.kind), ['candidate']);
});

test('inserts match whole tokens of text values only', () => {
  assert.equal(hasKeyword('llave maestra', 'av'), false);
  assert.equal(hasKeyword('Av. Reforma 222', 'av'), true);
  assert.equal(hasKeyword('hospital-angeles', 'hospitales'), true); // singular / plural
  assert.equal(hasKeyword('comercial centro', 'centro comercial'), false);
  assert.deepEqual(textValues({place: 'Calle 5', lines: [{text: 'x'}]}), ['Calle 5', 'x']);
  const ins = parseInserts('INSERTS:\n- super de calle → super: av, calle');
  const clips = [clip('a', 'a', 0, 10)];
  const w = words(clips, [{clipId: 'a', source: 'a', words: [TW(0, 'hola', 0, 300)]}]);
  const keyOnly = [{id: 'g0', template: 'label-2tone', props: {top: 'la llave', bottom: 'de la casa'}, startMs: 0, endMs: 2000}];
  assert.equal(insertFindings(ins, w, [], keyOnly).length, 1); // "llave" is not "av"; the key "place" is not a value
  assert.equal(insertFindings(ins, w, [], [{id: 'g1', template: 'location-tag', props: {place: 'Av. Reforma'}, startMs: 0, endMs: 2000}]).length, 0);
});

test('caption layout is one function: measured as rendered (case, tier scale), shared with the renderer', () => {
  const vibem = presetOf('vibem');
  const word = {text: 'departamentales', tier: 1}; // 15 caps at 100 px: ~1080 px measured as rendered, ~840 px in lowercase
  const [u] = pageUnits([word], vibem);
  const lowercase = textWidthEm('departamentales', vibem.font.custom.family); // what the old shrink measured
  assert.ok(u.em > lowercase * 1.2); // vibem renders caps: far wider
  const [big] = pageUnits([word], presetOf('prism'));
  assert.ok(big.em > pageUnits([{text: 'universidades'}], presetOf('prism'))[0].em * 1.4); // and a tier's scale counts
  const fit = fitPage({words: [word]}, vibem);
  assert.ok(fit.fontSize < fit.baseSize); // so the page shrinks to keep it inside the frame
  assert.ok(!fit.overflows);
  // a brand body font replaces only a sans pack's face
  assert.equal(captionPreset('prism', 'Poppins').font.family, 'Poppins');
  assert.equal(captionPreset('vibem', 'Poppins').font.family, presetOf('vibem').font.family);
});

// ---- re-review of PR #15: the split-name recipe really re-pages; "no." ends a sentence ----
import {pageWords, projectTiers, withTiers, endsSentence} from '../src/paging.ts';

const tw = (arr) => arr.map((w, i) => ({wid: `a:${i}`, word: w, startMs: i * 400, endMs: i * 400 + 350, srcStartMs: i * 400, srcEndMs: i * 400 + 350, clipId: 'a', src: 'clips/a.mp4'}));
const pagesText = (ps) => ps.map((p) => p.words.map((w) => w.text).join(' '));

test('split-name recipe end to end: the judge flags "Playa | del Carmen", its annotation reaches the pager, re-paging joins the name', () => {
  const words = tw(['Vivir', 'junto', 'al', 'mar', 'en', 'Playa', 'del', 'Carmen', 'es', 'fácil.']);
  const before = pageWords(words, presetOf('vibem'));
  assert.deepEqual(pagesText(before), ['Vivir junto al mar en Playa', 'del Carmen es fácil']);
  const pages = before.map((c) => ({...c, clipId: 'a'}));
  const [f] = splitNameFindings(pages, [], 'vibem');
  assert.equal(f.kind, 'candidate');
  assert.deepEqual(f.fix.map((x) => x.tool), ['annotate_captions', 'set_caption_style']);
  assert.deepEqual(f.fix[0].args.items.map((x) => x.wid), ['a:5', 'a:6', 'a:7']); // the whole name, connector included
  // apply the recipe: annotate (project tiers) → set_caption_style passes them to the pager
  const tiers = Object.fromEntries(f.fix[0].args.items.map((x) => [x.wid, x.tier]));
  const annotated = pages.map((c) => ({...c, words: c.words.map((w) => (tiers[w.wid] ? {...w, tier: tiers[w.wid]} : w))}));
  const after = pageWords(withTiers(tw(['Vivir', 'junto', 'al', 'mar', 'en', 'Playa', 'del', 'Carmen', 'es', 'fácil.']), projectTiers(annotated)), presetOf('vibem'));
  assert.deepEqual(pagesText(after), ['Vivir junto al mar en Playa del Carmen', 'es fácil']);
  assert.deepEqual(splitNameFindings(after.map((c) => ({...c, clipId: 'a'})), [], 'vibem'), []); // fixed: no longer repeats until "stuck"
});

test('a glossary term of any length split across pages is found as a whole', () => {
  const pages = [page('c0', 'a', [CW('a:0', 'en', 0, 200), CW('a:1', 'Playa', 250, 500)]), page('c1', 'a', [CW('a:2', 'del', 520, 700), CW('a:3', 'Carmen', 720, 900), CW('a:4', 'hoy', 950, 1100)])];
  const [f] = splitNameFindings(pages, [{term: 'Playa del Carmen'}], 'vibem');
  assert.equal(f.kind, 'rule');
  assert.deepEqual(f.evidence.words, ['a:1', 'a:2', 'a:3']);
});

test('"no." ends a sentence; "No. 5" does not; a one-word page never rejoins across a sentence end', () => {
  assert.equal(endsSentence('no.'), true);
  assert.equal(endsSentence('no.', 'Vamos'), true);
  assert.equal(endsSentence('No.', '5'), false);
  assert.equal(endsSentence('Sr.', 'Pérez'), false);
  assert.deepEqual(pagesText(pageWords(tw(['Te', 'dije', 'que', 'no.', 'Vamos', 'ya.']), presetOf('vibem'))), ['Te dije que no', 'Vamos ya']);
  assert.deepEqual(pagesText(pageWords(tw(['Es', 'el', 'No.', '5', 'de', 'la', 'calle.']), presetOf('vibem'))), ['Es el No 5', 'de la calle']);
  assert.deepEqual(pagesText(pageWords(tw(['¿Vienes?', 'Sí.']), presetOf('vibem'))), ['Vienes?', 'Sí']);
});

test('the judge reads sentence ends from the transcript (captions lose their periods)', () => {
  const c = page('c0', 'a', [CW('a:0', 'Tiene', 0, 300), CW('a:1', 'alberca', 350, 800), CW('a:2', 'Y', 900, 1000), CW('a:3', 'gym', 1050, 1400)]); // "alberca." shown without its period
  const raw = {'a:1': 'alberca.'};
  assert.deepEqual(paginationFindings([c], 'vibem'), []); // from the caption text alone the period is gone
  assert.equal(paginationFindings([c], 'vibem', (w) => raw[w.wid] ?? w.text).length, 1);
  // and a boundary after a full stop is not a split name ("Carmen. | Está")
  const pages = [page('c1', 'a', [CW('a:0', 'en', 0, 200), CW('a:1', 'Carmen', 250, 500)]), page('c2', 'a', [CW('a:2', 'Está', 520, 700), CW('a:3', 'cerca', 720, 900)])];
  assert.equal(splitNameFindings(pages, [], 'vibem', (w) => ({'a:1': 'Carmen.'})[w.wid] ?? w.text).length, 0);
});

test('project tiers: only raised, by word id', () => {
  assert.deepEqual(projectTiers([{words: [{wid: 'a:1', tier: 1}, {wid: 'a:2', tier: 0}, {text: 'x', tier: 2}]}]), {'a:1': 1});
  const w = withTiers([{wid: 'a:1', tier: 2}, {wid: 'a:2'}], {'a:1': 1, 'a:2': 1});
  assert.deepEqual(w.map((x) => x.tier), [2, 1]); // never lowers the classifier's tier
});

// ---- César, G10 V2: black flashes from one frame, cuts inside a source clip, VO promises ----
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {placeClips} from '../src/timeline.ts';
import {blackRuns, blackFlashFindings, usedRanges, sourceCutFindings, mergeRanges, missingRanges, claimEvidence, analyzeVideo, sentencesOf as sentences3} from '../.agents/skills/render-judge/judge.mjs';

test('black runs: open runs end at the file end', () => {
  assert.deepEqual(blackRuns([{t: 1, black_start: 1}, {t: 1.1, black_end: 1.1}, {t: 5, black_start: 5}]), [{start: 1, end: 1.1}, {start: 5, end: null}]);
});

test('black flashes: 3 and 5 frames are blockers at 30 and 25 fps; allowed fades are nits; long blacks belong to the QC gate', () => {
  const clips = [clip('a', 'a', 0, 12)];
  const placed = placeClips(clips, 30);
  const f30 = blackFlashFindings([{start: 7.5, end: 7.6}, {start: 38.3333, end: 38.5}], {fps: 30, duration: 60, placed});
  assert.deepEqual(f30.map((f) => [f.severity, f.kind, f.evidence.frames]), [['blocker', 'rule', 3], ['blocker', 'rule', 5]]);
  assert.match(f30[0].msg, /3 frames \(7\.50–7\.60 s, 30 fps\)/);
  const f25 = blackFlashFindings([{start: 7.52, end: 7.64}], {fps: 25, duration: 60, placed});
  assert.equal(f25[0].evidence.frames, 3); // 0.12 s = 3 frames at 25 fps (would be ~4 at 30)
  const one = blackFlashFindings([{start: 2, end: 2 + 1 / 30}], {fps: 30, duration: 60, placed});
  assert.equal(one[0].evidence.frames, 1); // from ONE frame
  // fades allowed by the client profile, with a 1.5-frame margin; nothing is allowed without it
  const fades = {startSec: 0.5, endSec: 1};
  const head = [{start: 0, end: 0.3}], tail = [{start: 59.6, end: null}]; // a run still black at the file end
  assert.deepEqual(blackFlashFindings([...head, ...tail], {fps: 30, duration: 60, fades, placed}).map((f) => f.severity), ['nit', 'nit']);
  assert.deepEqual(blackFlashFindings(head, {fps: 30, duration: 60, placed}).map((f) => f.severity), ['blocker']);
  assert.deepEqual(blackFlashFindings([{start: 20, end: 21}], {fps: 30, duration: 60, placed}), []); // ≥ 0.5 s: the QC gate's `black`
  // on a fullscreen B-roll cue the finding names the cue and its source time
  const cue = {id: 'b0', src: 'broll/cochera.mp4', kind: 'video', mode: 'fullscreen', startMs: 900, endMs: 4400};
  const onCue = blackFlashFindings([{start: 3.5, end: 3.6}], {fps: 30, duration: 60, placed, brolls: [cue]});
  assert.match(onCue[0].msg, /B-roll b0 \(fuente cochera @2\.6 s\)/);
  assert.ok(!onCue[0].fix.some((x) => x.tool !== 'frame_at')); // inspection only, never an automatic edit
});

test('black flash detection on a real file: one black frame at 25 fps is caught', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-'));
  const f = path.join(dir, 'm.mp4');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x568:r=25:d=3', '-vf', "drawbox=c=black:t=fill:enable='between(t,1.2,1.239)'", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f]);
  if (r.status !== 0) return; // no ffmpeg with libx264 here
  const {black} = analyzeVideo(f, {hashes: false, blackFps: 25});
  fs.rmSync(dir, {recursive: true, force: true});
  assert.equal(black.length, 1);
  assert.equal(Math.round((black[0].end - black[0].start) * 25), 1);
  assert.equal(black[0].start, 1.2);
});

test('a cut or a whip inside a source clip is a candidate; the edit\'s own edges and long camera moves are not', () => {
  const clips = [clip('a', 'take', 10, 20)];
  const brolls = [{id: 'b0', src: 'broll/cochera.mp4', kind: 'video', mode: 'fullscreen', startMs: 2000, endMs: 6000}, {id: 'b1', src: 'broll/foto.jpg', kind: 'image', startMs: 7000, endMs: 8000}];
  const ranges = usedRanges(clips, brolls);
  assert.deepEqual(ranges.map((r) => [r.id, r.from, r.to, r.t0]), [['a', 10, 20, 0], ['b0', 0, 4, 2]]); // images are not scanned; a cue plays its file from 0
  const flat = (a, b, v = 0.01) => Array.from({length: Math.round((b - a) * 30)}, (_, k) => [a + k / 30, v]);
  const take = [...flat(9.8, 15), [15, 22], ...flat(15.0333, 20.2)]; // a hard cut at 15 s in the take
  const garage = [...flat(0, 2.5), [2.5333, 3.1], [2.5667, 3.4], [2.6, 2.8], [2.6333, 2.2], ...flat(2.6667, 4.2)]; // a 4-frame whip
  const f = sourceCutFindings(ranges, new Map([['clips/take.mp4', take], ['broll/cochera.mp4', garage]]));
  assert.deepEqual(f.map((x) => [x.check, x.kind, x.severity, x.at]), [['source-cut', 'candidate', 'major', 5], ['source-cut', 'candidate', 'major', 4.53]]);
  assert.match(f[0].msg, /corte aparente/);
  assert.match(f[1].msg, /whip/);
  assert.equal(verdictOf(f).verdict, 'PASS'); // candidates never auto-fail
  // a cut right at the edit's own edge, and a slow 3-second camera move, are not flagged
  const edges = [[10.05, 30], ...flat(10.1, 20.2)];
  const pan = [...flat(9.8, 12), ...Array.from({length: 90}, (_, k) => [12 + k / 30, 2.5]), ...flat(15, 20.2)];
  assert.deepEqual(sourceCutFindings([ranges[0]], new Map([['clips/take.mp4', edges]])), []);
  assert.deepEqual(sourceCutFindings([ranges[0]], new Map([['clips/take.mp4', pan]])), []);
});

test('incremental scan: only what is not decoded yet', () => {
  assert.deepEqual(mergeRanges([[5, 7], [0, 2], [1.5, 3]]), [[0, 3], [5, 7]]);
  assert.deepEqual(missingRanges([[0, 10]], [[2, 4], [6, 12]]), [[0, 2], [4, 6]]);
  assert.deepEqual(missingRanges([[2, 3]], [[0, 10]]), []);
});

test('VO promises: evidence for the judge\'s eyes, proof cues first, the inserts on screen and the frames to look at', () => {
  const clips = [clip('a', 'a', 0, 20)];
  const ws = 'La cochera es amplia. Las puertas tienen tope magnético y acabado en roble.'.split(' ').map((w, i) => TW(i, w, i * 500, i * 500 + 400));
  const s = sentences3(words(clips, [{clipId: 'a', source: 'a', words: ws}]));
  const brolls = [{id: 'b1', src: 'broll/puertas.mp4', startMs: 3000, endMs: 5000}];
  const ev = claimEvidence(s, brolls, [{id: 'g0', template: 'layout', startMs: 0, endMs: 9000}]);
  assert.equal(ev[0].text, 'Las puertas tienen tope magnético y acabado en roble.');
  assert.deepEqual(ev[0].cues, ['tope', 'magnetico', 'acabado', 'roble']);
  assert.deepEqual(ev[0].inserts, ['b1 puertas']); // a layout frame is not an insert
  assert.deepEqual(ev[0].lookAt, [4]); // the middle of b1 (3–5 s), which is on screen while the promise is said
  assert.equal(ev.length, 1); // "La cochera es amplia." has no proof cue and no insert on screen: nothing to verify
  assert.ok(claimEvidence(s, [], [], ['amplia'])[0].cues.includes('amplia')); // a client's own proof cues (profile proofCues)
});
