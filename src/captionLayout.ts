// How a caption page is laid out, shared by the renderer (CaptionTrack.tsx) and
// the render judge (.agents/skills/render-judge/judge.mjs) so both see the same
// page: which words are bonded into one unbreakable unit, how wide each unit is
// AS RENDERED (the pack's case, each word at its tier's scale), the font size the
// page shrinks to so the widest unit fits, and how the units wrap. Pure: no DOM.
// Widths come from the average-advance table in textFit.ts (an estimate, a little
// generous); tracking is not counted (the packs track tight, so it only helps).

import {pageScale, presetOf, type Preset} from './captionPresets.ts';
import {textWidthEm} from './textFit.ts';
import type {FontFamily} from './fonts.ts';

export const SANS = new Set<string>(['Inter', 'Montserrat', 'Poppins']);
export const PAGE_PAD_PX = 70; // side padding of every page (CaptionTrack's outer box)
export const FLOAT_MAX = 0.68; // floating pages wrap inside 68 % of the padded width
export const MIN_FONT_PX = 40; // a page never shrinks below this; a wider unit overflows

// a brand kit overrides the pack's font — but only on sans packs: a pack whose
// identity is its face (condensed, serif, script) keeps it
export function captionPreset(style?: string, kitBody?: string): Preset {
  const base = presetOf(style);
  return kitBody && SANS.has(base.font.family) ? {...base, font: {...base.font, family: kitBody as FontFamily}} : base;
}
export const familyOf = (preset: Preset) => (preset.font.custom ? preset.font.custom.family : preset.font.family);

type W = {text: string; tier?: number; br?: boolean};
const CAP = /^[A-ZÁÉÍÓÚÑÜ]/;

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

export type Unit = {from: number; to: number; em: number; br: boolean};
// one unit per bonded pair or free word, in em of the page's font size, measured as rendered
export function pageUnits(words: W[], preset: Preset, paired = bondedPairs(words, preset)): Unit[] {
  const family = familyOf(preset);
  const upper = preset.font.case === 'upper';
  const gapEm = preset.font.wordGapEm ?? 0.26;
  const em = (w: W) => textWidthEm(upper ? w.text.toUpperCase() : w.text, family) * (preset.tiers[(w.tier ?? 0) as 0 | 1 | 2]?.scale ?? 1);
  const units: Unit[] = [];
  for (let i = 0; i < words.length; i++) {
    if (paired.has(i)) { units.push({from: i, to: i + 1, em: em(words[i]) + gapEm + em(words[i + 1]), br: !!words[i].br}); i++; }
    else units.push({from: i, to: i, em: em(words[i]), br: !!words[i].br});
  }
  return units;
}

export type PageFit = {paired: Set<number>; units: Unit[]; baseSize: number; fontSize: number; availPx: number; wrapPx: number; widestPx: number; overflows: boolean};
// the page's font size: the pack's size (× page scale, × short-page autoscale),
// shrunk so the widest unbreakable unit fits the padded width — never below MIN_FONT_PX
export function fitPage(page: {words: W[]; scale?: number}, preset: Preset, {compWidth = 1080, float = false}: {compWidth?: number; float?: boolean} = {}): PageFit {
  const paired = bondedPairs(page.words, preset);
  const units = pageUnits(page.words, preset, paired);
  const baseSize = Math.round(preset.font.sizePx * (page.scale ?? 1) * pageScale(preset, page.words.length));
  const availPx = compWidth - 2 * PAGE_PAD_PX;
  const wrapPx = float ? availPx * FLOAT_MAX : availPx;
  const widestEm = units.length ? Math.max(...units.map((u) => u.em)) : 0;
  const fontSize = widestEm * baseSize > availPx ? Math.max(MIN_FONT_PX, Math.floor((baseSize * availPx) / (widestEm * baseSize))) : baseSize;
  return {paired, units, baseSize, fontSize, availPx, wrapPx, widestPx: widestEm * fontSize, overflows: widestEm * fontSize > wrapPx + 1};
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
