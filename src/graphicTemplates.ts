// Motion-graphics templates: the agent picks a template and fills typed props;
// layout, timing and animation live in src/Graphics.tsx. Keeping the schemas
// here (no JSX) lets the MCP server validate props with the same rules.
//
// Anchoring works like captions: a graphic belongs to a SOURCE file and a
// source-relative time span, so cuts, splits and reorders carry it along.

import {z} from 'zod';
import {placeClips, type Clip} from './timeline.ts';
import {textWidthEm} from './textFit.ts';
import type {FontFamily} from './fonts.ts';

const short = (max: number) => z.string().trim().min(1).max(max);
// a line of a stack: {text, …} — a bare string is accepted too
const lineOf = <T extends z.ZodRawShape>(shape: T) => z.preprocess((v) => (typeof v === 'string' ? {text: v} : v), z.object(shape));

export const TEMPLATES = {
  // giant stacked headline for the hook: lines of mixed sizes, revealed one by one
  'hook-stack': {
    desc: 'stacked headline (1–4 lines of mixed size) revealed line by line — the 0–3 s hook',
    defaultMs: 2800,
    y: 16,
    schema: z.object({
      lines: z.array(lineOf({text: short(22), size: z.enum(['sm', 'md', 'lg', 'xl']).default('lg'), accent: z.boolean().default(false)})).min(1).max(4),
      upper: z.boolean().default(false),
    }),
  },
  // two-tone label: white line over an accent line ("Mérida / Yucatán", "Doble / lavabo")
  'label-2tone': {
    desc: 'two-line label, white over accent — room names, locations, features; plate glass (default, a soft dark backing that keeps it readable over busy footage) or none',
    defaultMs: 2200,
    y: 62,
    schema: z.object({top: short(26), bottom: z.string().trim().max(26).default(''), plate: z.enum(['glass', 'none']).default('glass')}),
  },
  // big figure with a caption: "104 m²", "+75%", "$2.5M"
  stat: {
    desc: 'big figure with a small label under it; numbers count up',
    defaultMs: 2400,
    y: 34,
    schema: z.object({value: short(14), label: z.string().trim().max(30).default(''), countUp: z.boolean().default(true)}),
  },
  // "CAPÍTULO 11", "NUMBER TWO"
  chapter: {
    desc: 'chapter marker: small label over a huge number',
    defaultMs: 1800,
    y: 18,
    schema: z.object({label: short(20), number: short(6)}),
  },
  // one giant word (the topic) at the top; repeat = a tiled word wall with one line filled
  'big-word': {
    desc: 'one giant word (the topic); font display|condensed|script|serif; color text|accent|outline; repeat=true tiles it as a word wall (Prime/Form/Chalk)',
    defaultMs: 2600,
    y: 8,
    schema: z.object({
      text: short(16),
      font: z.enum(['display', 'condensed', 'script', 'serif']).default('display'),
      color: z.enum(['text', 'accent', 'outline']).default('text'),
      size: z.enum(['lg', 'xl', 'xxl']).default('xl'),
      repeat: z.boolean().default(false),
      upper: z.boolean().default(true),
    }),
  },
  // full-frame solid card with staggered lines (Orbit blue cards, Impact grid cards)
  'kinetic-card': {
    desc: 'full-frame solid card that COVERS the video (cutaway) with 1–4 staggered lines; bg accent|dark|light; grid=true adds graph-paper lines (Impact II)',
    defaultMs: 2200,
    y: 0,
    schema: z.object({
      lines: z.array(lineOf({text: short(22), dim: z.boolean().default(false)})).min(1).max(4),
      bg: z.enum(['accent', 'dark', 'light']).default('accent'),
      font: z.enum(['condensed', 'display', 'serif']).default('condensed'),
      grid: z.boolean().default(false),
    }),
  },
  // outlined title that fills with the accent color left to right (Stack)
  'fill-title': {
    desc: 'outlined title that fills with the accent color from left to right (Stack)',
    defaultMs: 2400,
    y: 8,
    schema: z.object({text: short(16), font: z.enum(['condensed', 'display']).default('condensed')}),
  },
  // editorial title: small pill tag, script/serif-italic title, spaced-caps subtitle (Elevate, Bloom)
  'script-title': {
    desc: 'editorial title card: pill tag above, script or serif-italic title, spaced-caps subtitle (Elevate/Bloom)',
    defaultMs: 3000,
    y: 14,
    schema: z.object({
      title: short(22),
      sub: z.string().trim().max(40).default(''),
      tag: z.string().trim().max(16).default(''),
      font: z.enum(['script', 'serif-italic']).default('script'),
    }),
  },
  // presenter framing for a span: the base video goes into a shaped frame over a canvas,
  // optionally splitting the frame with the B-roll panel (Orbit, Focus, Lift, Evo, Bloom, Lens)
  layout: {
    desc: 'frame the presenter for a span: shape rounded|arch|circle|phone|none, canvas accent|dark|light|gradient, inset % margin, border none|thin|glass|accent, split none|broll-bottom|broll-top (B-roll cues in that span fill the other panel)',
    defaultMs: 4000,
    y: 0,
    schema: z.object({
      shape: z.enum(['rounded', 'arch', 'circle', 'phone', 'none']).default('rounded'),
      canvas: z.enum(['accent', 'dark', 'light', 'gradient']).default('accent'),
      inset: z.number().min(0).max(30).default(7),
      border: z.enum(['none', 'thin', 'glass', 'accent']).default('none'),
      split: z.enum(['none', 'broll-bottom', 'broll-top']).default('none'),
    }),
  },
  // one word far wider than the frame, cropped by both edges, drifting sideways
  oversized: {
    desc: 'one word so big the frame crops it on both sides, drifting slowly — best behind the presenter; font condensed|display|serif, color text|accent|outline',
    defaultMs: 2600,
    y: 10,
    schema: z.object({
      text: short(12),
      font: z.enum(['condensed', 'display', 'serif']).default('condensed'),
      color: z.enum(['text', 'accent', 'outline']).default('accent'),
      drift: z.boolean().default(true),
    }),
  },
  // small spaced capitals with thin rules: "CHAPTER ONE", "THE LIE"
  'chapter-caps': {
    desc: 'small widely spaced capitals between thin rules, optional accent line under it — section marker (Elevate/Bloom)',
    defaultMs: 2200,
    y: 14,
    schema: z.object({text: short(28), sub: z.string().trim().max(36).default(''), rules: z.boolean().default(true)}),
  },
  // comic starburst with a short shout: "NEW!", "-30%", "WOW"
  starburst: {
    desc: 'comic starburst bubble with a short shout ("NEW!", "-30%"); placed by its center (x_pct/y_pct), may sit next to other graphics',
    defaultMs: 1800,
    y: 30,
    schema: z.object({
      text: short(10),
      color: z.enum(['accent', 'light', 'dark']).default('accent'),
      size: z.enum(['sm', 'md', 'lg']).default('md'),
      xPct: z.number().min(0).max(100).default(72).describe('center x, % of frame width'),
      rotate: z.number().min(-30).max(30).default(-8),
    }),
  },
  // "📍 Mérida, Yucatán" — a pin and a place in a glass pill
  'location-tag': {
    desc: 'map pin + place name in a glass pill, optional second line (city, neighborhood, venue)',
    defaultMs: 2400,
    y: 66,
    // agents reach for text / label / title first (runs 7 and 8): any of them is the place
    schema: z.preprocess((v) => { if (!v || typeof v !== 'object' || 'place' in v) return v; const o = v as any; const alt = ['text', 'label', 'title', 'name'].find((k) => typeof o[k] === 'string'); return alt ? {...o, place: o[alt]} : v; }, z.object({place: short(28), sub: z.string().trim().max(28).default('')})),
  },
  // price with its label: "DESDE / $2.5M / MXN · preventa"
  price: {
    desc: 'price block: small label above ("FROM", "DESDE"), the value on an accent bar (counts up), a note under it',
    defaultMs: 2600,
    y: 30,
    schema: z.object({value: short(14), label: z.string().trim().max(20).default(''), note: z.string().trim().max(32).default(''), countUp: z.boolean().default(true)}),
  },
  // closing card over the last line: brand logo, a title, a call-to-action pill, the handle
  'end-card': {
    desc: 'full-frame closing card (covers the video) with the brand logo (set_brand), a title, a CTA pill and the handle — over the last sentence; bg dark|accent|light',
    defaultMs: 2600,
    y: 0,
    schema: z.object({
      title: short(40),
      cta: z.string().trim().max(36).default('Follow for more'),
      handle: z.string().trim().max(30).default(''),
      bg: z.enum(['dark', 'accent', 'light']).default('dark'),
    }),
  },
  // a PNG/SVG asset (from search_asset / generate_asset) with a simple motion
  sticker: {
    desc: 'image asset (sticker, emoji, doodle, icon) placed at x/y with a pop/wiggle/float/spin motion',
    defaultMs: 2000,
    y: 50,
    schema: z.object({
      src: short(200).describe('path under public/, e.g. assets/gen/sticker-ab12.png'),
      anim: z.enum(['pop', 'wiggle', 'float', 'spin', 'none']).default('pop'),
      widthPct: z.number().min(5).max(90).default(28).describe('width as % of frame width'),
      xPct: z.number().min(0).max(100).default(50).describe('center x, % of frame width'),
      rotate: z.number().min(-45).max(45).default(0),
    }),
  },
} as const;

export type TemplateId = keyof typeof TEMPLATES;

// decor sits by its center (x/y) and may share the screen with a text graphic
export const CENTERED = new Set<string>(['sticker', 'starburst']);
// cards that cover the whole frame (cutaways, closing card)
export const FULL_FRAME = new Set<string>(['kinetic-card', 'end-card']);
export const STAR_PX: Record<string, number> = {sm: 230, md: 310, lg: 400}; // starburst diameter
// oversized: the font size that makes the word ~1.3× the 1080 px frame width
export const OVERSIZED_FAMILY: Record<string, FontFamily> = {condensed: 'Anton', display: 'Montserrat', serif: 'Playfair Display'};
export const oversizedPx = (text: string, font = 'condensed', family?: FontFamily) =>
  Math.round((1080 * 1.3) / Math.max(1, textWidthEm(String(text).toUpperCase(), family ?? OVERSIZED_FAMILY[font] ?? 'Anton')));
export const isTemplate = (id: string): id is TemplateId => id in TEMPLATES;

export type Graphic = {
  id: string;
  src: string; // source file it belongs to
  startMs: number; // source-relative
  endMs: number;
  template: TemplateId;
  props: Record<string, unknown>; // validated by TEMPLATES[template].schema
  yPct?: number; // block top, % of frame height (template default when absent)
  behind?: boolean; // drawn behind the presenter (needs a matte for its span)
  // projected only:
  clipId?: string;
};

// compact, human-readable shape of a props schema for the tool help:
// "{text: string ≤16 chars, size: lg|xl|xxl (default "xl"), …}"
export function describeSchema(schema: z.ZodType): string {
  const d: any = (schema as any).def;
  const note = schema.description ? ` — ${schema.description}` : '';
  const check = (name: string, key: string) => d.checks?.find((c: any) => c._zod.def.check === name)?._zod.def[key];
  switch (d.type) {
    case 'default': return `${describeSchema(d.innerType)} (default ${JSON.stringify(d.defaultValue)})${note}`;
    case 'optional': return `${describeSchema(d.innerType)}?${note}`;
    case 'pipe': return describeSchema(d.out) + note;
    case 'string': { const max = check('max_length', 'maximum'); return `string${max ? ` ≤${max} chars` : ''}${note}`; }
    case 'enum': return Object.keys(d.entries).join('|') + note;
    case 'number': { const min = check('greater_than', 'value'), max = check('less_than', 'value'); return `number${min != null || max != null ? ` ${min ?? ''}–${max ?? ''}` : ''}${note}`; }
    case 'boolean': return 'true|false' + note;
    case 'array': { const min = check('min_length', 'minimum'), max = check('max_length', 'maximum'); return `[${describeSchema(d.element)}]${min != null || max != null ? ` ×${min ?? ''}–${max ?? ''}` : ''}${note}`; }
    case 'object': return `{${Object.entries(d.shape).map(([k, v]) => `${k}: ${describeSchema(v as z.ZodType)}`).join(', ')}}${note}`;
    default: return String(d.type) + note;
  }
}

// validate + fill defaults; throws a readable message on bad props
export function parseProps(template: TemplateId, props: unknown): Record<string, unknown> {
  const r = TEMPLATES[template].schema.safeParse(props);
  if (!r.success) throw new Error(`${template}: ${r.error.issues.map((i) => `${i.path.join('.') || 'props'} ${i.message}`).join('; ')}`);
  return r.data as Record<string, unknown>;
}

// anything drawn behind the presenter: graphics and caption pages with behind=true
export type Behind = {src: string; startMs: number; endMs: number; behind?: boolean};
export type Span = {src: string; startMs: number; endMs: number};

// the behind-spans no matte covers yet (what prepare_mattes must compute)
export const spansWithoutMatte = (items: Behind[], mattes: Span[] = [], clips?: Clip[]): Span[] =>
  matteSpans(items, {clips}).filter((s) => !mattes.some((m) => m.src === s.src && m.startMs <= s.startMs && m.endMs >= s.endMs));

// The source spans that need a person matte, padded and merged per source. A
// caption page needs its own words; a graphic runs across cuts (see
// projectGraphics), so with `clips` it needs every piece of footage under it.
export function matteSpans(items: Behind[], {clips, padMs = 300, fps = 30}: {clips?: Clip[]; padMs?: number; fps?: number} = {}): Span[] {
  const raw: Span[] = [];
  for (const it of items) {
    if (!it.behind) continue;
    if (!clips || !('template' in it)) { raw.push({src: it.src, startMs: it.startMs, endMs: it.endMs}); continue; }
    const [pg] = projectGraphics([it as Graphic], clips, fps);
    if (!pg) continue;
    for (const pc of placeClips(clips, fps)) {
      const a = Math.max(pg.startMs, pc.startMs), b = Math.min(pg.endMs, pc.endMs);
      if (b <= a) continue;
      const speed = pc.clip.speed ?? 1, inMs = pc.clip.inSec * 1000;
      raw.push({src: pc.clip.src, startMs: inMs + (a - pc.startMs) * speed, endMs: inMs + (b - pc.startMs) * speed});
    }
  }
  const bySrc = new Map<string, {startMs: number; endMs: number}[]>();
  for (const s of raw) {
    const list = bySrc.get(s.src) ?? [];
    list.push({startMs: Math.max(0, Math.round(s.startMs - padMs)), endMs: Math.round(s.endMs + padMs)});
    bySrc.set(s.src, list);
  }
  const out: Span[] = [];
  for (const [src, list] of bySrc) {
    list.sort((a, b) => a.startMs - b.startMs);
    let cur = {...list[0]};
    for (const s of list.slice(1)) {
      if (s.startMs <= cur.endMs) cur.endMs = Math.max(cur.endMs, s.endMs);
      else { out.push({src, ...cur}); cur = {...s}; }
    }
    out.push({src, ...cur});
  }
  return out;
}

// source-relative spans → absolute timeline spans. A graphic starts where its
// anchor word lands and stays on screen for its whole duration ACROSS cuts (an
// autocut split under a label must not make it vanish). Behind-graphics too:
// matteSpans() cuts the presenter out of every piece of footage under them.
export function projectGraphics(items: Graphic[], clips: Clip[], fps: number): Graphic[] {
  const placed = placeClips(clips, fps);
  const totalMs = placed.length ? placed[placed.length - 1].endMs : 0;
  const out: Graphic[] = [];
  for (const g of items) {
    const hits = placed.filter((pc) => pc.clip.src === g.src && g.endMs > pc.clip.inSec * 1000 && g.startMs < pc.clip.outSec * 1000);
    const anchor = hits.find((pc) => g.startMs >= pc.clip.inSec * 1000) ?? hits[0];
    if (!anchor) continue;
    const inMs = anchor.clip.inSec * 1000;
    const speed = anchor.clip.speed ?? 1;
    const from = Math.max(g.startMs, inMs);
    const startMs = anchor.startMs + (from - inMs) / speed;
    out.push({...g, clipId: anchor.clip.id, startMs, endMs: Math.min(totalMs, startMs + (g.endMs - from) / speed)});
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}
