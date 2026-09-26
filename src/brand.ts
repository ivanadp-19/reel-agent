// Brand kit: a client's palette, fonts and logo. Stored on the project
// (`brand`), reusable across projects as public/brands/<slug>.json. Caption
// presets, graphics templates and layout canvases read it through
// BrandContext, so one kit restyles everything without touching the presets.

import {createContext, useContext} from 'react';
import {z} from 'zod';
import {FONT_FILE, isCatalog, type ClientFont} from './fonts.ts';
import {LOOKS, type GradeParams} from './grade.ts';
import type {GlossaryEntry} from './guion.ts';
import {PRESETS, type PresetId} from './captionPresets.ts';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'hex color like #FFB020');
const glossarySchema = z.array(z.object({term: z.string().trim().min(1).max(60), variants: z.array(z.string().trim().min(1).max(60)).max(20).default([]), note: z.string().max(200).optional()})).max(200);
const fontFile = z.object({
  family: z.string().trim().min(1).max(40),
  file: z.string().regex(FONT_FILE, 'a .ttf, .otf, .woff or .woff2 under public/').refine((f) => !f.startsWith('/') && !f.includes('..'), 'a path under public/, e.g. fonts/Helvetica-Bold.ttf'),
  weight: z.number().int().min(100).max(900),
  italic: z.boolean().optional(),
});

// How a client edits, written from their words ("sin subtítulos", "Helvetica
// Bold blanca, acento amarillo", "cortes secos, nada de zooms", "color natural,
// piel sin naranja"): a flexible spec, not a profile extracted from videos. Known
// keys are applied when the kit is loaded (captions, grade, audio) or read by the
// plan (pack, pace, transitions, music, broll); any other named preference is kept
// as is and read by the reel-plan skill. Reusable from public/brands/<slug>.json.
const adjust = z.object({exposure: z.number().min(-2).max(2), contrast: z.number().min(0.5).max(1.5), saturation: z.number().min(0).max(2), temperature: z.number().min(-1).max(1), tint: z.number().min(-1).max(1)}).partial();
export const styleSchema = z.object({
  notes: z.string().max(3000).optional().describe('how this client edits, in their words: what they like, what to avoid'),
  captions: z.enum(['on', 'off']).optional().describe('off = their reels go without subtitles by default'),
  pack: z.string().max(40).optional().describe('caption style pack by default'),
  grade: z.object({look: z.enum(Object.keys(LOOKS) as [string, ...string[]]), intensity: z.number().min(0).max(1), auto: z.boolean(), adjust, highlights: z.number().min(0).max(1), skin: z.number().min(0).max(1), lut: z.string().nullable(), lutMix: z.number().min(0).max(1)}).partial().optional().describe('color defaults (set_grade knobs)'),
  pace: z.string().max(200).optional(),
  transitions: z.string().max(200).optional(),
  music: z.string().max(200).optional(),
  broll: z.string().max(300).optional(),
  audio: z.object({clean: z.string().optional(), sfx: z.boolean().optional()}).optional(),
}).catchall(z.union([z.string().max(500), z.number(), z.boolean()]));
export type Style = z.infer<typeof styleSchema>;

// what loading a kit's style does to a project, without jobs: `pack` is a caption pack
// id (an unknown name is left out) that the caller applies as set_caption_style does
// (re-paging is a job). Shared by set_brand and the Styles tab.
export function styleEffects(st: Style | undefined): {captionsOff?: boolean; grade?: GradeParams; audio?: {clean?: string; sfx?: boolean}; pack?: PresetId} {
  if (!st) return {};
  return {
    ...(st.captions ? {captionsOff: st.captions === 'off'} : {}),
    ...(st.grade && Object.keys(st.grade).length ? {grade: st.grade as GradeParams} : {}),
    ...(st.audio ? {audio: st.audio} : {}),
    ...(st.pack && Object.hasOwn(PRESETS, st.pack) ? {pack: st.pack} : {}),
  };
}
// a partial style on top of a kit's: null removes a key, adjust / grade merge key by key
export function mergeStyle(prev: Style | undefined, patch: Record<string, unknown>): Style {
  const out: Record<string, unknown> = {...(prev ?? {})};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (k === 'grade' && v && typeof v === 'object') out.grade = {...(out.grade as object), ...(v as object), ...((v as {adjust?: object}).adjust ? {adjust: {...((out.grade as {adjust?: object})?.adjust), ...(v as {adjust: object}).adjust}} : {})};
    else out[k] = v;
  }
  return styleSchema.parse(out);
}

export const brandSchema = z.object({
  name: z.string().trim().max(40).optional(),
  colors: z.object({
    accent: hex.describe('highlight color: caption emphasis, accent lines, accent canvases'),
    dark: hex.optional().describe('dark canvas / card background (default #0b0b0d)'),
    light: hex.optional().describe('light canvas / card background (default #f3f3f0)'),
  }),
  fonts: z.object({
    display: z.string().optional().describe('headline font (graphics templates): a catalog family or a client font of files'),
    body: z.string().optional().describe('caption font (overrides the preset family): a catalog family or a client font of files'),
    files: z.array(fontFile).max(12).optional().describe('client font files under public/fonts/ (the client\'s own faces, never in the repo)'),
  }).default({}).superRefine((f, ctx) => {
    for (const k of ['display', 'body'] as const) {
      const name = f[k];
      if (name && !isCatalog(name) && !f.files?.some((x) => x.family === name)) ctx.addIssue({code: 'custom', path: [k], message: `"${name}" is neither a catalog font nor one of the kit's font files`});
    }
  }),
  logo: z.string().optional().describe('image under public/, e.g. brands/acme.png'),
  style: styleSchema.optional(),
  glossary: glossarySchema.optional().describe("the client's spellings: the captions pipeline respells every variant as the term (src/guion.ts applyGlossary); the render judge checks the same list"),
});
// display / body: a catalog family (src/fonts.ts) or the family of one of `files`
export type Brand = {name?: string; colors: {accent: string; dark?: string; light?: string}; fonts: {display?: string; body?: string; files?: ClientFont[]}; logo?: string; style?: Style; glossary?: GlossaryEntry[]};

// the glossary as the Styles tab edits it, one term a line: "Altabrisa: Alta Brisa, Altabriza" (a term's note is kept)
export const glossaryText = (g: GlossaryEntry[] = []) => g.map((e) => [e.term, (e.variants ?? []).join(', ')].filter(Boolean).join(': ')).join('\n');
export const parseGlossary = (text: string, prev: GlossaryEntry[] = []): GlossaryEntry[] => text.split('\n').map((l) => l.split(':')).filter(([t]) => t.trim()).map(([t, v = '']) => {
  const note = prev.find((e) => e.term === t.trim())?.note;
  return {term: t.trim(), variants: v.split(',').map((x) => x.trim()).filter(Boolean), ...(note ? {note} : {})};
});

// what the renderer uses: every value resolved, `branded` = a kit is active
export type Kit = {branded: boolean; accent: string; dark: string; light: string; display?: string; body?: string; script?: string; logo?: string; fontFiles: ClientFont[]};
// what a style pack brings when the project has no brand kit (src/stylePacks.ts)
export type PackKit = {accent: string; dark: string; light: string; display?: string; script?: string};

export const DEFAULT_ACCENT = '#FFB020';
// a brand kit wins; else the project's own accent when it was set (not the default); else the pack's palette
export function resolveBrand(brand: Brand | null | undefined, accentColor?: string, pack?: PackKit): Kit {
  const projectAccent = accentColor && accentColor !== DEFAULT_ACCENT ? accentColor : undefined;
  return {
    branded: !!brand,
    accent: brand?.colors.accent ?? projectAccent ?? pack?.accent ?? accentColor ?? DEFAULT_ACCENT,
    dark: brand?.colors.dark ?? pack?.dark ?? '#0b0b0d',
    light: brand?.colors.light ?? pack?.light ?? '#f3f3f0',
    display: brand?.fonts?.display ?? pack?.display,
    body: brand?.fonts?.body,
    script: pack?.script,
    logo: brand?.logo,
    fontFiles: brand?.fonts?.files ?? [],
  };
}

// relative luminance (WCAG) of a #rrggbb color; null when it is not one
export function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return null;
  const lin = (h: string) => { const c = parseInt(h, 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(m[1]) + 0.7152 * lin(m[2]) + 0.0722 * lin(m[3]);
}
// readable text color on a background: near-black on light colors, white on dark
export function ink(bg: string): string {
  const L = luminance(bg);
  return L != null && L > 0.4 ? '#111111' : '#ffffff';
}
// the accent as TEXT over footage: a dark brand color (navy, deep blue) is mixed
// toward white just enough to read (luminance ≥ 0.3); fills keep the exact color
export function legible(accent: string): string {
  const L = luminance(accent);
  if (L == null || L >= 0.3) return accent;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(accent.replace('#', '').slice(i - 1, i + 1), 16));
  for (let t = 0.1; t <= 0.8; t += 0.1) {
    const mix = [r, g, b].map((c) => Math.round(c + (255 - c) * t).toString(16).padStart(2, '0')).join('');
    if ((luminance(`#${mix}`) ?? 0) >= 0.3) return `#${mix}`;
  }
  return '#ffffff';
}

export const BrandContext = createContext<Kit>(resolveBrand(null));
export const useBrand = () => useContext(BrandContext);
