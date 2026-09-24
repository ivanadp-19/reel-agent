// Motion-graphics templates: the agent picks a template and fills typed props;
// layout, timing and animation live in src/Graphics.tsx. Keeping the schemas
// here (no JSX) lets the MCP server validate props with the same rules.
//
// Anchoring works like captions: a graphic belongs to a SOURCE file and a
// source-relative time span, so cuts, splits and reorders carry it along.

import {z} from 'zod';
import {placeClips, type Clip} from './timeline.ts';

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
    desc: 'two-line label, white over accent — room names, locations, features',
    defaultMs: 2200,
    y: 62,
    schema: z.object({top: short(26), bottom: z.string().trim().max(26).default('')}),
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

// the source spans that need a person matte: every `behind` graphic, padded and merged per source
export function matteSpans(items: Graphic[], padMs = 300): {src: string; startMs: number; endMs: number}[] {
  const bySrc = new Map<string, {startMs: number; endMs: number}[]>();
  for (const g of items) {
    if (!g.behind) continue;
    const list = bySrc.get(g.src) ?? [];
    list.push({startMs: Math.max(0, g.startMs - padMs), endMs: g.endMs + padMs});
    bySrc.set(g.src, list);
  }
  const out: {src: string; startMs: number; endMs: number}[] = [];
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

// source-relative spans → absolute timeline spans, one per placement of the source
export function projectGraphics(items: Graphic[], clips: Clip[], fps: number): Graphic[] {
  const placed = placeClips(clips, fps);
  const out: Graphic[] = [];
  for (const g of items) {
    for (const pc of placed) {
      if (pc.clip.src !== g.src) continue;
      const inMs = pc.clip.inSec * 1000;
      const outMs = pc.clip.outSec * 1000;
      if (g.endMs <= inMs || g.startMs >= outMs) continue;
      const speed = pc.clip.speed ?? 1;
      const toAbs = (ms: number) => pc.startMs + (ms - inMs) / speed;
      out.push({...g, clipId: pc.clip.id, startMs: toAbs(Math.max(g.startMs, inMs)), endMs: toAbs(Math.min(g.endMs, outMs))});
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}
