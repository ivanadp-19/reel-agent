// Font catalog (all OFL, bundled through @remotion/google-fonts so preview and
// export use the same faces). A family is only downloaded when a preset asks
// for it. Add a family here and it becomes available to every preset.
// Client fonts (a brand's own Helvetica Bold…) are files the user brings: they
// live under public/fonts/ (never in the repo) and a brand kit lists them
// (`fonts.files`); registerClientFonts makes fontFamily() load them.

import {cancelRender, continueRender, delayRender, staticFile} from 'remotion';
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
import {loadFont as pinyon} from '@remotion/google-fonts/PinyonScript';
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
  // calligraphic script (the "Momentum" / "Routine" titles of Elevate and Bloom)
  'Pinyon Script': () => pinyon('normal', {weights: ['400'], ...S}).fontFamily,
  // mono
  'Courier Prime': () => { courier('italic', {weights: ['400', '700'], ...S}); return courier('normal', {weights: ['400', '700'], ...S}).fontFamily; },
  'Space Mono': () => spaceMono('normal', {weights: ['400', '700'], ...S}).fontFamily,
};

export type FontFamily = keyof typeof LOADERS;
// heaviest weight each loader brings (a brand font used where a template wants "bold")
export const HEAVIEST: Record<FontFamily, number> = {
  Inter: 800, Montserrat: 800, Poppins: 700, 'Bebas Neue': 400, Anton: 400, Oswald: 700, Unbounded: 900,
  'Playfair Display': 700, 'Instrument Serif': 400, Caveat: 700, 'Permanent Marker': 400, 'Kaushan Script': 400, 'Pinyon Script': 400, 'Courier Prime': 700, 'Space Mono': 700,
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

// ---- client fonts ----
export type ClientFont = {family: string; file: string; weight: number; italic?: boolean}; // file under public/, e.g. fonts/Helvetica-Bold.ttf
export const FONT_FILE = /\.(ttf|otf|woff2?)$/i;
export const isCatalog = (name: string): name is FontFamily => name in LOADERS;
// a font file → its entry: family from the name ("Helvetica-Bold.ttf" → Helvetica), weight and italic from the style words
export function clientFont(file: string, family?: string, weight?: number, italic?: boolean): ClientFont {
  const base = file.split('/').pop()!.replace(FONT_FILE, '');
  const style = base.split(/[-_ ]+/).slice(1).join(' ').toLowerCase();
  const guess = /black|heavy/.test(style) ? 900 : /extra ?bold|ultra ?bold/.test(style) ? 800 : /semi ?bold|demi/.test(style) ? 600 : /bold/.test(style) ? 700 : /medium/.test(style) ? 500 : /light|thin/.test(style) ? 300 : 400;
  const fam = (family ?? base.split(/[-_]/)[0].replace(/([a-z])([A-Z])/g, '$1 $2')).trim().slice(0, 40);
  return {family: fam, file, weight: weight ?? guess, ...(italic ?? /italic|oblique/.test(style) ? {italic: true} : {})};
}
// a family as the user typed it ("DejaVu Sans", "helvetica") → the catalog name or
// the kit's registered family, ignoring case, spaces, - and _; unknown names pass through
const squash = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');
export function resolveFamily(name: string, files: ClientFont[] = []): string {
  if (isCatalog(name)) return name;
  const k = squash(name);
  return files.find((f) => squash(f.family) === k)?.family ?? (Object.keys(LOADERS) as string[]).find((c) => squash(c) === k) ?? name;
}
// heaviest weight a family has, catalog or client
export const heaviest = (name: string, files: ClientFont[] = []): number =>
  isCatalog(name) ? HEAVIEST[name] : Math.max(400, ...files.filter((f) => f.family === name).map((f) => f.weight));

const client = new Map<string, ClientFont[]>(); // family → faces registered by the brand kit
const faces = new Set<string>(); // files already requested
// make a kit's client fonts known (the composition calls it with brand.fonts.files)
export function registerClientFonts(files: ClientFont[] | undefined): void {
  for (const f of files ?? []) {
    const list = client.get(f.family) ?? [];
    if (!list.some((x) => x.file === f.file)) client.set(f.family, [...list, f]);
  }
}
// load a client family's files with the FontFace API; the render waits for them
// (delayRender) and fails loudly when a file is missing — never a silent fallback face
function loadClient(name: string): void {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return; // node (tests, the MCP)
  for (const f of client.get(name) ?? []) {
    if (faces.has(f.file)) continue;
    faces.add(f.file);
    const handle = delayRender(`client font ${f.family} (${f.file})`);
    new FontFace(f.family, `url("${staticFile(f.file)}")`, {weight: String(f.weight), style: f.italic ? 'italic' : 'normal'}).load()
      .then((face) => { (document.fonts as unknown as {add: (f: FontFace) => void}).add(face); continueRender(handle); })
      .catch((e) => cancelRender(new Error(`client font ${f.family}: public/${f.file} did not load (${e}) — bring the file back or pick another font with set_brand`)));
  }
}

const loaded = new Map<FontFamily, string>();
// CSS font-family string for a catalog family (loads it on first use) or a
// registered client font; an unknown name falls back to the system sans
export function fontFamily(name: FontFamily | string): string {
  if (!isCatalog(name)) {
    loadClient(name);
    return `"${name.replace(/"/g, '')}", system-ui, sans-serif`;
  }
  let css = loaded.get(name);
  if (!css) {
    css = LOADERS[name]();
    loaded.set(name, css);
  }
  return `${css}, system-ui, sans-serif`;
}
