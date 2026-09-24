// Deterministic checks the agent runs before rendering. Pure: no fs, no DOM.
// Geometry is ESTIMATED from the presets/templates (real pixels come from
// caption_proof stills); the point is to catch the obvious before a render.

import {projectCaptions, type Caption} from './captions.ts';
import {presetOf} from './captionPresets.ts';
import {projectGraphics, matteSpans, type Graphic} from './graphicTemplates.ts';
import {isGlue} from './paging.ts';
import type {Clip} from './timeline.ts';

export type Issue = {level: 'error' | 'warn'; code: string; msg: string; ref?: string};

// Instagram Reels UI (1080×1920): username/audio at the top, caption + action
// strip at the bottom. Estimates from published safe-zone guides; calibrate
// with real screenshots (see PLAN.md open questions).
export const SAFE = {topPct: 13, bottomPct: 79, rightPct: 88};
const W = 1080, H = 1920;

type Band = {top: number; bottom: number}; // % of frame height

// rough on-screen height of a caption page for its preset
function captionBand(c: Caption, style?: string): Band {
  const p = presetOf(style);
  const chars = c.words.reduce((n, w) => n + w.text.length + 1, -1);
  const lines = Math.max(1, Math.ceil(chars / p.layout.maxCharsLine));
  const scale = c.scale ?? 1;
  const hPx = lines * p.font.sizePx * scale * p.font.lineHeight + (p.container !== 'none' ? p.font.sizePx * 0.5 : 0);
  const top = p.position === 'float' ? 12 : c.topPct;
  return {top, bottom: top + (hPx / H) * 100};
}

const SIZES: Record<string, number> = {sm: 60, md: 90, lg: 130, xl: 180};
const BIG: Record<string, number> = {lg: 150, xl: 210, xxl: 270};
// rough on-screen height of a graphic (px), null = covers the frame (layout / card)
function graphicHeightPx(g: Graphic): number | null {
  const p: any = g.props;
  switch (g.template) {
    case 'hook-stack': return p.lines.reduce((n: number, l: any) => n + (SIZES[l.size] ?? 130), 0) * 0.98;
    case 'label-2tone': return 72 * 1.05 * (p.bottom ? 2 : 1);
    case 'stat': return 170 + (p.label ? 54 : 0);
    case 'chapter': return 40 + 200;
    case 'big-word': return p.repeat ? 5 * (BIG[p.size] ?? 210) * 0.72 : (BIG[p.size] ?? 210);
    case 'fill-title': return 200;
    case 'script-title': return (p.tag ? 42 : 0) + 150 + (p.sub ? 44 : 0);
    case 'sticker': return ((p.widthPct ?? 28) / 100) * W; // square-ish
    default: return null;
  }
}
function graphicBand(g: Graphic): Band | null {
  const h = graphicHeightPx(g);
  if (h == null) return null;
  const defaultY: Record<string, number> = {'hook-stack': 16, 'label-2tone': 62, stat: 34, chapter: 18, 'big-word': 8, 'fill-title': 8, 'script-title': 14, sticker: 50};
  const y = g.yPct ?? defaultY[g.template] ?? 50;
  const top = g.template === 'sticker' ? y - (h / H) * 50 : y;
  return {top, bottom: top + (h / H) * 100};
}
const overlap = (a: Band, b: Band) => a.top < b.bottom && b.top < a.bottom;

export function validateProject(p: {clips: Clip[]; captions: Caption[]; graphics?: Graphic[]; mattes?: {src: string; startMs: number; endMs: number}[]; captionStyle?: string}, fps = 30): Issue[] {
  const issues: Issue[] = [];
  const caps = projectCaptions(p.captions, p.clips, fps);
  const gfx = projectGraphics(p.graphics ?? [], p.clips, fps);
  const totalMs = caps.length || gfx.length ? Math.max(...caps.map((c) => c.endMs), ...gfx.map((g) => g.endMs), 0) : 0;

  // --- captions ---
  for (let i = 0; i < caps.length; i++) {
    const c = caps[i];
    const band = captionBand(c, p.captionStyle);
    if (band.top < SAFE.topPct) issues.push({level: 'warn', code: 'safe-top', msg: `caption ${c.id} starts at ${band.top.toFixed(0)}% — inside the top UI band (<${SAFE.topPct}%)`, ref: c.id});
    if (band.bottom > SAFE.bottomPct) issues.push({level: 'warn', code: 'safe-bottom', msg: `caption ${c.id} reaches ${band.bottom.toFixed(0)}% — under the Reels caption/actions strip (>${SAFE.bottomPct}%)`, ref: c.id});
    const last = c.words[c.words.length - 1];
    if (last && isGlue(last.text) && c.words.length > 1) issues.push({level: 'warn', code: 'glue', msg: `caption ${c.id} ends on "${last.text}" (function word)`, ref: c.id});
    const dur = c.endMs - c.startMs;
    if (dur < 250) issues.push({level: 'warn', code: 'short', msg: `caption ${c.id} lasts ${dur} ms`, ref: c.id});
    if (dur > 6000) issues.push({level: 'warn', code: 'long', msg: `caption ${c.id} lasts ${(dur / 1000).toFixed(1)} s — split it`, ref: c.id});
    for (let k = 1; k < c.words.length; k++) if (c.words[k].startMs < c.words[k - 1].startMs) { issues.push({level: 'error', code: 'timing', msg: `caption ${c.id}: word ${k} starts before word ${k - 1}`, ref: c.id}); break; }
    const next = caps[i + 1];
    if (next && next.startMs < c.endMs - 40 && next.clipId === c.clipId) issues.push({level: 'error', code: 'overlap-captions', msg: `captions ${c.id} and ${next.id} overlap in time`, ref: c.id});
  }
  // emphasis density
  const words = p.captions.flatMap((c) => c.words);
  const t2 = words.filter((w) => w.tier === 2).length;
  const t1 = words.filter((w) => w.tier === 1).length;
  if (totalMs && t2 > Math.max(1, totalMs / 10000)) issues.push({level: 'warn', code: 'tier2-density', msg: `${t2} tier-2 words in ${(totalMs / 1000).toFixed(0)} s — aim for ≤ 1 per 10 s`});
  if (words.length >= 20 && t1 / words.length > 0.2) issues.push({level: 'warn', code: 'tier1-density', msg: `${Math.round((t1 / words.length) * 100)}% of words are accented — keep it under 20%`});

  // --- graphics ---
  for (const g of gfx) {
    const band = graphicBand(g);
    if (band) {
      if (band.top < SAFE.topPct && !g.behind) issues.push({level: 'warn', code: 'safe-top', msg: `graphic ${g.id} (${g.template}) starts at ${band.top.toFixed(0)}% — inside the top UI band`, ref: g.id});
      if (band.bottom > SAFE.bottomPct) issues.push({level: 'warn', code: 'safe-bottom', msg: `graphic ${g.id} (${g.template}) reaches ${band.bottom.toFixed(0)}% — under the bottom UI strip`, ref: g.id});
      for (const c of caps) {
        if (c.startMs < g.endMs && g.startMs < c.endMs && overlap(captionBand(c, p.captionStyle), band) && g.template !== 'sticker') {
          issues.push({level: 'warn', code: 'overlap-graphic', msg: `caption ${c.id} overlaps graphic ${g.id} (${g.template}) at ${(Math.max(c.startMs, g.startMs) / 1000).toFixed(1)} s`, ref: g.id});
          break;
        }
      }
    }
    // one text graphic at a time (stickers and layouts may coexist)
    for (const o of gfx) {
      if (o.id <= g.id || o.template === 'layout' || g.template === 'layout' || o.template === 'sticker' || g.template === 'sticker') continue;
      if (o.startMs < g.endMs && g.startMs < o.endMs) issues.push({level: 'warn', code: 'overlap-graphics', msg: `graphics ${g.id} and ${o.id} are on screen at the same time`, ref: g.id});
    }
  }
  // behind graphics need a matte
  const missing = matteSpans(p.graphics ?? []).filter((s) => !(p.mattes ?? []).some((m) => m.src === s.src && m.startMs <= s.startMs && m.endMs >= s.endMs));
  for (const s of missing) issues.push({level: 'error', code: 'matte', msg: `behind graphics on ${s.src} ${(s.startMs / 1000).toFixed(1)}–${(s.endMs / 1000).toFixed(1)} s have no person matte — run prepare_mattes`});
  // hook: something in the first 3 s
  if (totalMs > 5000 && !gfx.some((g) => g.startMs < 3000 && g.template !== 'layout') && !caps.some((c) => c.startMs < 1500)) issues.push({level: 'warn', code: 'hook', msg: 'nothing on screen in the first 3 s — reels need a hook'});
  return issues;
}
