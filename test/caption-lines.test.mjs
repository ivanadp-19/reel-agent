// The captions-ws port (plan phases 22–23): sentence boundaries, orphans by clip, validate's band from
// the real lines, balanced lines and the short-page caps as opt-ins of the two-line packs only, the
// judge's split-name across lines, emoji width. vibem (the golden) takes none of the opt-ins.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pageWords, endsSentence} from '../src/paging.ts';
import {PRESETS, presetOf} from '../src/captionPresets.ts';
import {fitPage, pageUnits, wrapUnits, EMOJI_EM} from '../src/captionLayout.ts';
import {validateProject} from '../src/validate.ts';
import {overflowFindings} from '../.agents/skills/render-judge/judge.mjs';

const tw = (arr, clipOf = () => 'a') => arr.map((w, i) => ({wid: `a:${i}`, word: w, startMs: i * 400, endMs: i * 400 + 350, srcStartMs: i * 400, srcEndMs: i * 400 + 350, clipId: clipOf(i), src: 'clips/a.mp4'}));
const texts = (ps) => ps.map((p) => p.words.map((w) => w.text).join(' '));

test('sentence boundaries: titles never end one, the ambiguous ones ask the next word, "…" never, a bare number always', () => {
  assert.equal(endsSentence('Sr.', 'Pérez'), false);
  assert.equal(endsSentence('Lic.', 'Gómez'), false);
  assert.equal(endsSentence('etc.', 'y'), false);
  assert.equal(endsSentence('etc.', 'Luego'), true);
  assert.equal(endsSentence('U.S.', 'army'), false);
  assert.equal(endsSentence('A.', 'Después'), true); // "la torre A. Después…"
  assert.equal(endsSentence('J.', 'pérez'), false);
  assert.equal(endsSentence('esto…', 'Es'), false);
  assert.equal(endsSentence('326.', 'y'), true); // captions-ws merged '326.' with the next word
  assert.equal(endsSentence('dijo."', 'Luego'), true); // a closing quote after the period
  assert.equal(endsSentence('¿Vienes?', 'sí'), true);
  assert.equal(endsSentence('No.', '5'), false);
});

test('a 1-word page never joins the page before across a cut inside one source (clip, not source)', () => {
  const words = tw(['Vamos', 'a', 'la', 'playa', 'hoy'], (i) => (i < 4 ? 'a' : 'b')); // one source, two clips, 50 ms apart
  assert.deepEqual(texts(pageWords(words, presetOf('caja'))), ['Vamos a la playa', 'hoy']);
  assert.deepEqual(texts(pageWords(tw(['Vamos', 'a', 'la', 'playa', 'hoy']), presetOf('caja'))), ['Vamos a la playa hoy']); // one clip: joins
});

test('opt-ins: only the balanced two-line packs take them, never vibem', () => {
  const OPT = ['balance', 'silenceMs', 'maxChars', 'maxMs', 'minMs', 'minWords'];
  const takers = Object.values(PRESETS).filter((p) => OPT.some((k) => p.layout[k] != null)).map((p) => p.id).sort();
  assert.deepEqual(takers, ['lift', 'prism', 'sketch', 'stack', 'y2k']);
  assert.ok(OPT.every((k) => PRESETS.vibem.layout[k] == null));
});

test('minMs / minWords: a pack that sets them merges a flash page and evens an orphan out; one that does not keeps the pager as it was', () => {
  const at = (arr) => arr.map(([word, s, e], i) => ({wid: `a:${i}`, word, startMs: s, endMs: e, srcStartMs: s, srcEndMs: e, clipId: 'a', src: 'clips/a.mp4'}));
  const noCaps = {...PRESETS.lift, layout: {maxWords: 5, maxCharsLine: 18}};
  // a clause end makes "Oye tú" a page 450 ms on screen: under lift's 800 ms it joins the next one
  const flash = at([['Oye', 0, 200], ['tú,', 200, 400], ['mira', 450, 650], ['esto', 700, 900]]);
  assert.deepEqual(texts(pageWords(flash, noCaps)), ['Oye tú', 'mira esto']);
  assert.deepEqual(texts(pageWords(flash, PRESETS.lift)), ['Oye tú mira esto']);
  // a full page, then one word: the pager's own rule makes a 6-word page; minWords 2 moves a word over instead
  const orphan = at(['Sol', 'mar', 'luz', 'paz', 'sal', 'red'].map((w, i) => [w, i * 400, i * 400 + 350]));
  assert.deepEqual(texts(pageWords(orphan, noCaps)), ['Sol mar luz paz sal red']);
  assert.deepEqual(texts(pageWords(orphan, PRESETS.lift)), ['Sol mar luz paz', 'sal red']);
});

test('balanced lines: a layout.balance pack evens its lines where flex-wrap leaves one word alone; vibem keeps flex-wrap', () => {
  const words = "What's slowing your team down today?".split(' ').map((text) => ({text}));
  const lift = PRESETS.lift;
  const fit = fitPage({words}, lift);
  const greedy = wrapUnits(fit.units, fit.fontSize, fit.wrapPx, lift.font.wordGapEm ?? 0.26);
  const line = (starts) => starts.map((s, i) => words.slice(fit.units[s].from, fit.units[starts[i + 1]]?.from).map((w) => w.text).join(' '));
  assert.deepEqual(line(greedy), ["What's slowing your", 'team down today?']);
  assert.deepEqual(line(fit.lines), ["What's slowing", 'your team down today?']); // the Lift preview: "What's slowing / your team down?"
  // vibem: its lines are flex-wrap's, whatever the page
  const v = fitPage({words: 'Y TODO ESTO LO VAS'.split(' ').map((text) => ({text}))}, PRESETS.vibem);
  assert.deepEqual(v.lines, wrapUnits(v.units, v.fontSize, v.wrapPx, PRESETS.vibem.font.wordGapEm));
});

test('balanced lines avoid ending a line on a function word or breaking a highlighted span when another break fits', () => {
  const page = (tiers = {}) => ({words: 'es la mejor vista de toda la ciudad hoy'.split(' ').map((text, i) => ({text, tier: tiers[i] ?? 0}))});
  const cutOf = (p) => { const f = fitPage(p, PRESETS.lift); return f.lines.slice(1).map((k) => f.units[k].from); };
  const [cut] = cutOf(page());
  assert.ok(!['de', 'la'].includes(page().words[cut - 1].text), `line ends on "${page().words[cut - 1].text}"`);
  const [moved] = cutOf(page({[cut - 1]: 1, [cut]: 1})); // highlight the two words either side: the break goes elsewhere
  assert.ok(moved !== cut && moved != null, `${cut} → ${moved}`);
});

test('an emoji counts in its word\'s width', () => {
  const [plain] = pageUnits([{text: 'playa'}], PRESETS.caja);
  const [withEmoji] = pageUnits([{text: 'playa', emoji: '🏖️'}], PRESETS.caja);
  assert.ok(Math.abs(withEmoji.em - plain.em - ((PRESETS.caja.font.wordGapEm ?? 0.26) + EMOJI_EM)) < 1e-9);
});

test('validate: the caption band is the page\'s real lines, not characters over maxCharsLine', () => {
  // 18 characters over impact's 16 used to count 2 lines (reaching 81 % from 72 %); Bebas fits them on one
  const W = (text, s) => ({wid: `a:${s}`, text, startMs: s, endMs: s + 300, tier: 0});
  const p = {clips: [{id: 'a', src: 'clips/a.mp4', inSec: 0, outSec: 5, sourceDurationSec: 5}], captionStyle: 'impact', graphics: [],
    captions: [{id: 'c0', src: 'clips/a.mp4', startMs: 0, endMs: 1300, topPct: 72, words: [W('Hola', 0), W('amigo', 330), W('mío', 660), W('hoy', 1000)]}]};
  assert.ok(!validateProject(p).some((i) => i.code === 'safe-bottom'));
});

test('judge: a glossary term split across two lines of a page is a rule; a plain pair of words is not', () => {
  const words = 'vivimos cerca del parque para perros de la ciudad con mucho gusto siempre'.split(' ').map((text, i) => ({wid: `a:${i}`, text, startMs: i * 300, endMs: i * 300 + 250, tier: 0}));
  const c = {id: 'c0', src: 'clips/a.mp4', clipId: 'a', words, startMs: 0, endMs: words.at(-1).endMs, topPct: 58};
  const fit = fitPage(c, presetOf('caja'));
  const cut = fit.units[fit.lines[1]].from;
  const term = `${words[cut - 1].text} ${words[cut].text}`;
  const f = overflowFindings([c], 'caja', undefined, [{term}]).filter((x) => x.check === 'split-name');
  assert.equal(f.length, 1);
  assert.deepEqual([f[0].severity, f[0].kind], ['major', 'rule']);
  assert.deepEqual(overflowFindings([c], 'caja').filter((x) => x.check === 'split-name'), []); // lowercase, no glossary: nothing
});
