// Style packs: one id per Captions.ai AI Edit style. A pack = its caption preset (same id in
// src/captionPresets.ts, which also holds the title defaults, the opening and the focus / punch
// behaviours) + what the rest of the composition takes from it when the project has no brand kit:
// the palette and faces, the transition family, how B-roll cues arrive and leave, and the layout
// the style lives in. The agent picks a pack with set_caption_style; the renderers read the rest.
// Values come from research/captions-ai-motion.md (Parte 1 per style, Parte 2 C/D).
import type {PackKit} from './brand.ts';
import type {BrollIn, BrollOut} from './motion.ts';
import type {Enter} from './transitions.ts';
import {PRESETS} from './captionPresets.ts';

export type StylePack = PackKit & {
  id: string;
  desc: string; // one line: the look, for the agent
  transition: Enter; // the family of cut this style uses between shots
  brollIn: BrollIn; // how a B-roll cue's box arrives when the cue does not say
  brollOut: BrollOut;
  brollMode?: 'fullscreen' | 'top' | 'inset' | 'card' | 'carousel'; // the mode the style favours over the presenter
  layout?: {shape: string; canvas: string; enter: string; border?: string; inset?: number}; // the frame the style lives in, when it has one
  note?: string; // what the pack still approximates
};

export const PACKS: Record<string, StylePack> = {
  prism: {id: 'prism', desc: 'cinematic real estate: clean sans, metallic key words, focus pull, diagonal whips, B-roll in a square card', accent: '#9FD9DC', dark: '#0b0b0d', light: '#f3f3f0', transition: 'whipDiag', brollIn: 'cut', brollOut: 'cut', brollMode: 'card'},
  focus: {id: 'focus', desc: 'Swiss blue: bold sans with a sliding highlight box, stacked blue bands between shots, a title band from the bottom', accent: '#3B5BFF', dark: '#0f1a4a', light: '#EAEFFF', transition: 'bands', brollIn: 'slideUp', brollOut: 'slideDown', brollMode: 'top', layout: {shape: 'none', canvas: 'accent', enter: 'inset', border: 'accent', inset: 4}},
  stack: {id: 'stack', desc: 'tech review red: bold rounded sans with a red pill, white flashes between shots, titles that drop in, the presenter cut out on red', accent: '#E63312', dark: '#111111', light: '#E9E8E2', display: 'Anton', transition: 'flash', brollIn: 'slideUp', brollOut: 'slideDown', layout: {shape: 'rounded', canvas: 'light', enter: 'frameIn', inset: 4}},
  lift: {id: 'lift', desc: 'SaaS mint: large sans with a mint box that jumps word to word, faceted polygons that wipe in, serif titles', accent: '#6FD3A5', dark: '#1F3A2E', light: '#F2F4F1', display: 'Playfair Display', transition: 'polyWipe', brollIn: 'slideUp', brollOut: 'slideDown', brollMode: 'top'},
  evo: {id: 'evo', desc: 'fintech iOS: bold italic in frosted glass, the video in a rounded frame on a blue-pink gradient, B-roll that pops from a point, cross-blurs', accent: '#4C6FFF', dark: '#0e1230', light: '#F4F5FA', transition: 'crossBlur', brollIn: 'popFrom', brollOut: 'shrink', brollMode: 'top', layout: {shape: 'rounded', canvas: 'gradient', enter: 'frameIn', border: 'glass', inset: 6}},
  prime: {id: 'prime', desc: 'dark motivational neon: extra-bold sans with glowing cyan script key words, a neon frame around the head, spin flashes, a three-panel carousel', accent: '#7CEFF5', dark: '#0d1717', light: '#E8F6F5', script: 'Kaushan Script', transition: 'spin', brollIn: 'slideUp', brollOut: 'slideDown', brollMode: 'carousel'},
  orbit: {id: 'orbit', desc: 'clean brand blue: serif in a blue pill, discs from the corners between shots, B-roll inside a circle with an orbiting ring, a condensed title that drops with a camera push', accent: '#2456C7', dark: '#12244f', light: '#E7E7E7', display: 'Anton', transition: 'disc', brollIn: 'popFrom', brollOut: 'shrink'},
  impact: {id: 'impact', desc: 'hype glitch: condensed cyan capitals, white impact words with a camera punch, blur + RGB split everywhere, a black grid card', accent: '#38C8F4', dark: '#0a0a0a', light: '#d9d9d9', display: 'Anton', transition: 'rgbFlash', brollIn: 'slideUp', brollOut: 'slideDown', brollMode: 'top', layout: {shape: 'none', canvas: 'dark', enter: 'cut'}},
  paper: {id: 'paper', desc: 'paper collage: bold sans in a white paper box with grey-to-black karaoke, typewriter labels, stickers that unfold from the head', accent: '#2F6BFF', dark: '#1a1a1a', light: '#F6F2EA', display: 'Poppins', transition: 'particles', brollIn: 'cut', brollOut: 'cut', note: 'the torn-newspaper transition needs a paper texture from the asset library; particles stands in'},
  elevate: {id: 'elevate', desc: 'editorial film poster: serif captions with italic key words, a calligraphic title that writes itself letter by letter, an ornament star, a split that rises', accent: '#E8DCC8', dark: '#141210', light: '#F5F0E6', display: 'Playfair Display', script: 'Pinyon Script', transition: 'crossBlur', brollIn: 'slideUp', brollOut: 'slideDown', brollMode: 'top'},
  sketch: {id: 'sketch', desc: 'notebook doodle: handwritten captions, a heavy title uncovered by a marker mask with a scribbled ellipse, hard cuts, a circular inset', accent: '#E9DCC5', dark: '#1b1b1b', light: '#F4EFE4', transition: 'cut', brollIn: 'slideUp', brollOut: 'cut', layout: {shape: 'circle', canvas: 'dark', enter: 'frameIn', inset: 8}},
  lens: {id: 'lens', desc: 'camera viewfinder: monospace capitals in a black bar, the video inset with viewfinder corners on navy, light leaks over every change, a typewriter title', accent: '#F2A33A', dark: '#2E3A5C', light: '#E8E4D8', transition: 'lightLeak', brollIn: 'slideUp', brollOut: 'slideDown', brollMode: 'top', layout: {shape: 'rounded', canvas: 'dark', enter: 'frameIn', border: 'thin', inset: 6}},
  vista: {id: 'vista', desc: 'light editorial realty: serif captions with a fade per word, block wipes like a skyline, a giant condensed word behind, a white card at the end', accent: '#BFC3C7', dark: '#111111', light: '#F2F2F2', display: 'Anton', transition: 'blocks', brollIn: 'slideUp', brollOut: 'slideDown', brollMode: 'top'},
  pop: {id: 'pop', desc: 'Gen-Z comic: italic sans in a white comic pill, a starburst label that lands like a stamp, stickers that pop in staggered, cards that fall in over graph paper', accent: '#E9A6D9', dark: '#1a1a1a', light: '#FAF7F2', transition: 'cardDrop', brollIn: 'cut', brollOut: 'cut', layout: {shape: 'rounded', canvas: 'grid', enter: 'frameIn', border: 'thin', inset: 10}},
  y2k: {id: 'y2k', desc: 'retro desktop: yellow sans, Mac OS windows that drag in leaving a trail, clock wipes and cream mosaics between shots', accent: '#EEFF3A', dark: '#1a1a1a', light: '#F4F5D2', script: 'Kaushan Script', transition: 'clock', brollIn: 'slideRight', brollOut: 'cut', layout: {shape: 'window', canvas: 'light', enter: 'slide', inset: 12}},
  form: {id: 'form', desc: 'sportswear orange: light sans pages with bold italic key words, orange blinds and particle dissolves between shots, a title that dismantles letter by letter', accent: '#D9502E', dark: '#1a1a1a', light: '#F4F1EC', transition: 'blinds', brollIn: 'slideUp', brollOut: 'slideDown', brollMode: 'top'},
  bloom: {id: 'bloom', desc: 'warm skincare: thin sans with big key words, an arch that breathes around the presenter, a product card that rises, a soft-focus close', accent: '#C8785A', dark: '#3a2a24', light: '#F4EFE9', display: 'Unbounded', script: 'Pinyon Script', transition: 'crossBlur', brollIn: 'slideUp', brollOut: 'slideDown', brollMode: 'inset', layout: {shape: 'arch', canvas: 'light', enter: 'capsule', inset: 5}},
  chalk: {id: 'chalk', desc: 'chalkboard: handwritten captions with yellow key words on black tags, a scribbled yellow outline around the presenter, a chalk title that writes and erases, photos with torn edges that fall away', accent: '#FFE600', dark: '#2b2b2b', light: '#F1E9D8', display: 'Permanent Marker', transition: 'crossBlur', brollIn: 'slideRight', brollOut: 'fall', layout: {shape: 'none', canvas: 'paper', enter: 'cut'}},
  linen: {id: 'linen', desc: 'fashion lookbook: small serif italic in a peach box, serif titles that only fade, beige and sage diagonal bands that sweep between shots', accent: '#6E3B4E', dark: '#2a1f22', light: '#E8E3D1', display: 'Playfair Display', transition: 'diagWipe', brollIn: 'fade', brollOut: 'fade', layout: {shape: 'none', canvas: 'light', enter: 'cut'}},
  align: {id: 'align', desc: 'documentary archive on white: monospace captions in a white box, the video that shrinks to tiles by scale, tiny spaced labels that type or decode', accent: '#111111', dark: '#111111', light: '#FFFFFF', transition: 'cut', brollIn: 'cut', brollOut: 'cut', brollMode: 'top', layout: {shape: 'none', canvas: 'light', enter: 'tile', inset: 6}},
};

export const packOf = (id?: string): StylePack | undefined => PACKS[id ?? ''];
// every pack must sit on a caption preset of the same id
for (const id of Object.keys(PACKS)) if (!PRESETS[id]) throw new Error(`style pack ${id} has no caption preset`);
