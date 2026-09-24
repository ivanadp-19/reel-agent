// Font catalog (all OFL, bundled through @remotion/google-fonts so preview and
// export use the same faces). A family is only downloaded when a preset asks
// for it. Add a family here and it becomes available to every preset.

import {loadFont as inter} from '@remotion/google-fonts/Inter';
import {loadFont as montserrat} from '@remotion/google-fonts/Montserrat';
import {loadFont as poppins} from '@remotion/google-fonts/Poppins';
import {loadFont as bebas} from '@remotion/google-fonts/BebasNeue';
import {loadFont as anton} from '@remotion/google-fonts/Anton';
import {loadFont as oswald} from '@remotion/google-fonts/Oswald';
import {loadFont as playfair} from '@remotion/google-fonts/PlayfairDisplay';
import {loadFont as instrument} from '@remotion/google-fonts/InstrumentSerif';
import {loadFont as caveat} from '@remotion/google-fonts/Caveat';
import {loadFont as marker} from '@remotion/google-fonts/PermanentMarker';
import {loadFont as kaushan} from '@remotion/google-fonts/KaushanScript';
import {loadFont as courier} from '@remotion/google-fonts/CourierPrime';
import {loadFont as spaceMono} from '@remotion/google-fonts/SpaceMono';
import {loadFont as unbounded} from '@remotion/google-fonts/Unbounded';
import {loadFont as notoEmoji} from '@remotion/google-fonts/NotoColorEmoji';

// 'latin' covers Spanish (accents, ñ); latin-ext is not in every family
const S = {subsets: ['latin'] as 'latin'[]};

// each loader returns the CSS font-family name; italic faces are loaded where the family has them
const LOADERS = {
  // geometric sans
  Inter: () => { inter('italic', {weights: ['700', '800'], ...S}); return inter('normal', {weights: ['300', '400', '500', '600', '700', '800'], ...S}).fontFamily; },
  Montserrat: () => montserrat('normal', {weights: ['400', '600', '700', '800'], ...S}).fontFamily,
  Poppins: () => { poppins('italic', {weights: ['600', '700'], ...S}); return poppins('normal', {weights: ['400', '600', '700'], ...S}).fontFamily; },
  // condensed / display
  'Bebas Neue': () => bebas('normal', {weights: ['400'], ...S}).fontFamily,
  Anton: () => anton('normal', {weights: ['400'], ...S}).fontFamily,
  Oswald: () => oswald('normal', {weights: ['400', '600', '700'], ...S}).fontFamily,
  Unbounded: () => unbounded('normal', {weights: ['400', '700', '900'], ...S}).fontFamily,
  // serif
  'Playfair Display': () => { playfair('italic', {weights: ['400', '500'], ...S}); return playfair('normal', {weights: ['400', '500', '700'], ...S}).fontFamily; },
  'Instrument Serif': () => { instrument('italic', {weights: ['400'], ...S}); return instrument('normal', {weights: ['400'], ...S}).fontFamily; },
  // handwriting
  Caveat: () => caveat('normal', {weights: ['400', '700'], ...S}).fontFamily,
  'Permanent Marker': () => marker('normal', {weights: ['400'], ...S}).fontFamily,
  // brush script (the cyan key words of Captions.ai Prime)
  'Kaushan Script': () => kaushan('normal', {weights: ['400'], ...S}).fontFamily,
  // mono
  'Courier Prime': () => { courier('italic', {weights: ['400', '700'], ...S}); return courier('normal', {weights: ['400', '700'], ...S}).fontFamily; },
  'Space Mono': () => spaceMono('normal', {weights: ['400', '700'], ...S}).fontFamily,
};

export type FontFamily = keyof typeof LOADERS;
// heaviest weight each loader brings (a brand font used where a template wants "bold")
export const HEAVIEST: Record<FontFamily, number> = {
  Inter: 800, Montserrat: 800, Poppins: 700, 'Bebas Neue': 400, Anton: 400, Oswald: 700, Unbounded: 900,
  'Playfair Display': 700, 'Instrument Serif': 400, Caveat: 700, 'Permanent Marker': 400, 'Kaushan Script': 400, 'Courier Prime': 700, 'Space Mono': 700,
};
export const FONT_FAMILIES = Object.keys(LOADERS) as FontFamily[];

// Noto Color Emoji (OFL) for per-word emoji: Google splits it into unicode-range
// chunks, so only the chunks holding the emoji actually used are downloaded.
// Kept out of FontFamily (it is not a text face a preset or brand may pick).
let emojiCss: string | null = null;
export function emojiFamily(): string {
  emojiCss ??= notoEmoji('normal', {weights: ['400'], subsets: ['[0]', '[1]', '[2]', '[3]', '[4]', '[5]', '[6]', '[7]', '[8]', '[9]'] as unknown as 'emoji'[]}).fontFamily; // the package types say 'emoji', its data is keyed [0]..[9]
  return emojiCss;
}

const loaded = new Map<FontFamily, string>();
// CSS font-family string for a catalog family (loads it on first use)
export function fontFamily(name: FontFamily): string {
  let css = loaded.get(name);
  if (!css) {
    css = LOADERS[name]();
    loaded.set(name, css);
  }
  return `${css}, system-ui, sans-serif`;
}
