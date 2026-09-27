// How a caption page is laid out, shared by the renderer (CaptionTrack.tsx), validate (the band a
// page takes) and the render judge (.agents/skills/render-judge/judge.mjs) so all see the same
// page: which words are bonded into one unbreakable unit, how wide each unit is
// AS RENDERED (the pack's case, each word at its tier's scale, its emoji), the font size the
// page shrinks to so the widest unit fits, and where its lines start. Pure: no DOM.
// Widths come from the average-advance table in textFit.ts (an estimate, a little
// generous; tracking is not counted, the packs track tight so it only helps) — or, for a
// pack's own font file once read (realAdvances), its real advances plus the tracking.
//
// breakLines (layout.balance only) ports the balancing of tscaps @ 1d7da5337e13c3856334ca1ea1413e0ba323d3bf
// (packages/engine/src/modules/splitting/BalancedPixelWidthLineSplitter.ts, MIT, © 2026 Franco
// Zanardi; see NOTICE): prefix sums, a greedy count of the fewest lines, a recursive even split.
// Adapted: over our units (a bond never splits), and a line that ends on a function word or a break
// inside a name or a highlighted span costs extra. Every other pack wraps as flex-wrap does (wrapUnits).

import {pageScale, presetOf, type Preset} from './captionPresets.ts';
import {textWidthEm} from './textFit.ts';
import {isGlue} from './paging.ts';
import type {FontFamily} from './fonts.ts';

export const SANS = new Set<string>(['Inter', 'Montserrat', 'Poppins']);
export const PAGE_PAD_PX = 70; // side padding of a page (CaptionTrack's outer box) unless the pack sets layout.padPx
export const FLOAT_MAX = 0.68; // floating pages wrap inside 68 % of the padded width
export const MIN_FONT_PX = 40; // a page never shrinks below this; a wider unit overflows
export const EMOJI_EM = 1.2; // a color emoji beside its word (a little generous)
const GLUE_COST = 0.6; // breakLines: a line ending on a function word, as a share of an even line's width
const NAME_COST = 10; // breakLines: a break inside a name or a highlighted span, only when nothing else fits

// a brand kit overrides the pack's font — but only on sans packs: a pack whose
// identity is its face (condensed, serif, script) keeps it
export function captionPreset(style?: string, kitBody?: string): Preset {
  const base = presetOf(style);
  return kitBody && SANS.has(base.font.family) ? {...base, font: {...base.font, family: kitBody as FontFamily}} : base;
}
export const familyOf = (preset: Preset) => (preset.font.custom ? preset.font.custom.family : preset.font.family);

// A pack's font file read (src/sfnt.ts): its real advance widths replace the average table for its
// family — the renderer registers them as the file loads (src/projectFont.ts), the render judge and
// the golden check from public/. ~7 % narrower than the Inter stand-in for Helvetica Bold.
const REAL = new Map<string, (text: string) => number>();
export const realAdvances = (family: string, advance: (text: string) => number) => void REAL.set(family, advance);

type W = {text: string; tier?: number; br?: boolean; emoji?: string};
const CAP = /^[A-ZÁÉÍÓÚÑÜ]/;
const CONNECTORS = new Set(['de', 'del', 'la', 'las', 'los', 'el']); // inside a name: 'Playa del Carmen'

// Bonded pairs (layout.unbreakable): Capitalized + Capitalized/digit words never
// split across lines ('MONTEALBÁN 326'). Two passes: name + number first (the
// stronger bond), then name + name on the words left free. Pairs never chain.
// Returns the index of each pair's first word.
export function bondedPairs(words: W[], preset: Preset): Set<number> {
  const paired = new Set<number>();
  if (!preset.layout?.unbreakable) return paired;
  for (const bond of [(a: string, b: string) => CAP.test(a) && /^[0-9]/.test(b), (a: string, b: string) => CAP.test(a) && CAP.test(b)]) {
    for (let i = 0; i < words.length - 1; i++) {
      if (!paired.has(i) && !paired.has(i + 1) && !words[i + 1].br && bond(words[i].text, words[i + 1].text)) paired.add(i);
    }
  }
  return paired;
}

// Names a line should not split, [first, last] word: Capitalized + digit first ('MONTEALBÁN 326'), then
// Capitalized + one or two connectors + Capitalized ('PLAYA DEL CARMEN'), then Capitalized + Capitalized
// ('Temozón Norte'), each on the words left free — runs never chain, and a comma ends one ('Mayab, Alta').
// ponytail: capitals, not a gazetteer — a sentence's first word can open a false name ('Todo el Caribe').
export function nameRuns(words: W[]): [number, number][] {
  const L = words.map((w) => w.text.replace(/^[¿¡"“]+/, ''));
  const open = (i: number) => CAP.test(L[i]) && !/,$/.test(L[i]);
  const runs: [number, number][] = [];
  const taken = new Set<number>();
  const free = (i: number, j: number) => { for (let k = i; k <= j; k++) if (taken.has(k)) return false; return true; };
  const take = (i: number, j: number) => { for (let k = i; k <= j; k++) taken.add(k); runs.push([i, j]); };
  for (let i = 0; i + 1 < words.length; i++) if (free(i, i + 1) && open(i) && /^[0-9]/.test(L[i + 1])) take(i, i + 1);
  for (let i = 0; i + 2 < words.length; i++) {
    let j = i + 1;
    while (j < words.length && j <= i + 2 && CONNECTORS.has(L[j].toLowerCase())) j++;
    if (j > i + 1 && j < words.length && open(i) && CAP.test(L[j]) && free(i, j)) take(i, j);
  }
  for (let i = 0; i + 1 < words.length; i++) if (free(i, i + 1) && open(i) && CAP.test(L[i + 1])) take(i, i + 1);
  return runs.sort((a, b) => a[0] - b[0]);
}

// glue: the unit ends on a function word; name: a break before it splits a name (nameRuns) or a
// highlighted span (two tier words in a row) — how a lowercase glossary term is kept on one line
export type Unit = {from: number; to: number; em: number; br: boolean; glue: boolean; name: boolean};
// one unit per bonded pair or free word, in em of the page's font size, measured as rendered (its emoji included)
export function pageUnits(words: W[], preset: Preset, paired = bondedPairs(words, preset)): Unit[] {
  const family = familyOf(preset);
  const upper = preset.font.case === 'upper';
  const gapEm = preset.font.wordGapEm ?? 0.26;
  const real = REAL.get(family);
  const em = (w: W) => {
    const t = upper ? w.text.toUpperCase() : w.text, scale = preset.tiers[(w.tier ?? 0) as 0 | 1 | 2]?.scale ?? 1;
    return (real ? real(t) * scale + (preset.font.trackingPx * [...t].length) / preset.font.sizePx : textWidthEm(t, family) * scale) + (w.emoji ? gapEm + EMOJI_EM : 0);
  };
  const names = nameRuns(words);
  const unit = (from: number, to: number, em: number): Unit => ({from, to, em, br: !!words[from].br, glue: isGlue(words[to].text),
    name: names.some(([a, b]) => a < from && from <= b) || (from > 0 && (words[from - 1].tier ?? 0) > 0 && (words[from].tier ?? 0) > 0)});
  const units: Unit[] = [];
  for (let i = 0; i < words.length; i++) {
    if (paired.has(i)) { units.push(unit(i, i + 1, em(words[i]) + gapEm + em(words[i + 1]))); i++; }
    else units.push(unit(i, i, em(words[i])));
  }
  return units;
}

export type PageFit = {paired: Set<number>; units: Unit[]; lines: number[]; baseSize: number; fontSize: number; availPx: number; wrapPx: number; widestPx: number; overflows: boolean};
// the page's font size: the pack's size (× page scale, × short-page autoscale),
// shrunk so the widest unbreakable unit fits availPx — the padded width, or the whole
// frame in a pack whose words may run into the padding (layout.overflowPad, v11) —
// never below MIN_FONT_PX. Lines wrap at wrapPx, the padded width (× FLOAT_MAX afloat): lines = the
// index of each line's first unit — balanced in a layout.balance pack whose page has no hand break,
// flex-wrap's greedy fill otherwise (vibem, the golden).
export function fitPage(page: {words: W[]; scale?: number}, preset: Preset, {compWidth = 1080, float = false}: {compWidth?: number; float?: boolean} = {}): PageFit {
  const paired = bondedPairs(page.words, preset);
  const units = pageUnits(page.words, preset, paired);
  const baseSize = Math.round(preset.font.sizePx * (page.scale ?? 1) * pageScale(preset, page.words.length));
  const padded = compWidth - 2 * (preset.layout.padPx ?? PAGE_PAD_PX);
  const availPx = preset.layout.overflowPad ? compWidth : padded;
  const wrapPx = float ? padded * FLOAT_MAX : padded;
  const widestEm = units.length ? Math.max(...units.map((u) => u.em)) : 0;
  const fontSize = widestEm * baseSize > availPx ? Math.max(MIN_FONT_PX, Math.floor((baseSize * availPx) / (widestEm * baseSize))) : baseSize;
  const gapEm = preset.font.wordGapEm ?? 0.26;
  const lines = preset.layout.balance && !units.some((u) => u.br) ? breakLines(units, fontSize, wrapPx, gapEm) : wrapUnits(units, fontSize, wrapPx, gapEm);
  return {paired, units, lines, baseSize, fontSize, availPx, wrapPx, widestPx: widestEm * fontSize, overflows: widestEm * fontSize > (float ? wrapPx : availPx) + 1};
}

// how the units wrap at a font size (flex-wrap: a unit goes to the next line when
// it does not fit, or on a hard break): the index of the first unit of each line
export function wrapUnits(units: Unit[], fontSize: number, wrapPx: number, gapEm: number): number[] {
  const starts: number[] = [];
  let x = 0;
  units.forEach((u, i) => {
    const w = u.em * fontSize;
    if (i === 0 || u.br || x + gapEm * fontSize + w > wrapPx) { starts.push(i); x = w; }
    else x += gapEm * fontSize + w;
  });
  return starts;
}

// Balanced lines (layout.balance): the fewest lines the units fit in at fontSize (greedy count, as
// flex-wrap would need), their widths evened out (tscaps splitRecursive) among the breaks that leave the
// rest room to fit; a line ending on a function word or a break inside a name or a highlighted span costs
// extra. A unit wider than the line stands on its own line, as in flex-wrap. Returns each line's first unit.
export function breakLines(units: Unit[], fontSize: number, wrapPx: number, gapEm: number): number[] {
  const n = units.length;
  if (!n) return [];
  const pre = [0];
  units.forEach((u, i) => pre.push(pre[i] + u.em));
  const width = (a: number, b: number) => (pre[b] - pre[a] + gapEm * (b - a - 1)) * fontSize; // units [a, b) on one line, px
  const fitsLine = (a: number, b: number) => b - a <= 1 || width(a, b) <= wrapPx;
  const count = (a: number) => {
    let lines = 1;
    for (let s = a, i = a + 1; i < n; i++) if (!fitsLine(s, i + 1)) { lines++; s = i; }
    return lines;
  };
  const split = (a: number, left: number): number[] => {
    if (left <= 1 || n - a <= 1) return [a];
    const target = width(a, n) / left;
    let best = -1, bestCost = Infinity;
    for (let i = a + 1; i < n; i++) {
      if (!fitsLine(a, i) || count(i) > left - 1) continue;
      const cost = Math.abs(width(a, i) - target) + target * ((units[i - 1].glue ? GLUE_COST : 0) + (units[i].name ? NAME_COST : 0));
      if (cost < bestCost) { bestCost = cost; best = i; }
    }
    return best < 0 ? [a] : [a, ...split(best, left - 1)];
  };
  return split(0, count(0));
}
