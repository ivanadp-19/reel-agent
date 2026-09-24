// Text never runs off the frame: shrink the font so a line fits `maxWidth` px.
// Widths are estimated from average glyph advances per family (em, capitals /
// lowercase), a little generous on purpose.
// ponytail: a table, not measurement — tune a family here if it overflows.
import type {FontFamily} from './fonts.ts';

const ADVANCE: Record<FontFamily, [number, number]> = {
  Inter: [0.72, 0.56], Montserrat: [0.8, 0.62], Poppins: [0.78, 0.6],
  'Bebas Neue': [0.45, 0.45], Anton: [0.47, 0.42], Oswald: [0.55, 0.45], Unbounded: [0.98, 0.78],
  'Playfair Display': [0.78, 0.58], 'Instrument Serif': [0.55, 0.44],
  Caveat: [0.58, 0.47], 'Permanent Marker': [0.72, 0.62], 'Kaushan Script': [0.7, 0.5], 'Pinyon Script': [0.75, 0.42],
  'Courier Prime': [0.6, 0.6], 'Space Mono': [0.62, 0.62],
};

export function textWidthEm(text: string, family: FontFamily = 'Montserrat'): number {
  const [up, lo] = ADVANCE[family] ?? ADVANCE.Montserrat;
  return [...String(text)].reduce((n, ch) => n + (ch === ' ' ? 0.3 : /[.,:;'|!]/.test(ch) ? 0.3 : /[IJLijl1]/.test(ch) ? up * 0.5 : /\d/.test(ch) ? 0.62 : ch === ch.toUpperCase() && ch !== ch.toLowerCase() ? up : lo), 0);
}

export function fitSize(text: string, base: number, family: FontFamily = 'Montserrat', maxWidth = 960, minSize = 0): number {
  const width = textWidthEm(text, family) * base;
  return width <= maxWidth ? base : Math.max(minSize, Math.floor((base * maxWidth) / width));
}
