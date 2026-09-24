// Motion-graphics templates: the agent picks a template and fills typed props;
// layout, timing and animation live in src/Graphics.tsx. Keeping the schemas
// here (no JSX) lets the MCP server validate props with the same rules.
//
// Anchoring works like captions: a graphic belongs to a SOURCE file and a
// source-relative time span, so cuts, splits and reorders carry it along.

import {z} from 'zod';
import {placeClips, type Clip} from './timeline.ts';

const short = (max: number) => z.string().trim().min(1).max(max);

export const TEMPLATES = {
  // giant stacked headline for the hook: lines of mixed sizes, revealed one by one
  'hook-stack': {
    desc: 'stacked headline (1–4 lines of mixed size) revealed line by line — the 0–3 s hook',
    defaultMs: 2800,
    y: 16,
    schema: z.object({
      lines: z.array(z.object({text: short(22), size: z.enum(['sm', 'md', 'lg', 'xl']).default('lg'), accent: z.boolean().default(false)})).min(1).max(4),
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
  // projected only:
  clipId?: string;
};

// validate + fill defaults; throws a readable message on bad props
export function parseProps(template: TemplateId, props: unknown): Record<string, unknown> {
  const r = TEMPLATES[template].schema.safeParse(props);
  if (!r.success) throw new Error(`${template}: ${r.error.issues.map((i) => `${i.path.join('.') || 'props'} ${i.message}`).join('; ')}`);
  return r.data as Record<string, unknown>;
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
