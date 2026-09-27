// Deterministic checks the agent runs before rendering. Pure: no fs, no DOM.
// Geometry is ESTIMATED from the presets/templates (real pixels come from
// caption_proof stills); the point is to catch the obvious before a render.

import {projectCaptions, type Caption} from './captions.ts';
import {FLOAT_SLOTS, pageScale, presetOf} from './captionPresets.ts';
import {CENTERED, DECOR_FULL, STAR_PX, TEMPLATES, isTextGraphic, oversizedPx, projectGraphics, spansWithoutMatte, type Graphic} from './graphicTemplates.ts';
import {isGlue} from './paging.ts';
import {guionIssues} from './guion.ts';
import {placeClips, type Clip} from './timeline.ts';
import {textWidthEm} from './textFit.ts';
import type {FontFamily} from './fonts.ts';

export type Issue = {level: 'error' | 'warn'; code: string; msg: string; ref?: string};

// Instagram Reels UI (1080×1920): username/audio at the top, caption + action
// strip at the bottom. Estimates from published safe-zone guides; calibrate
// with real screenshots (see PLAN.md open questions).
export const SAFE = {topPct: 13, bottomPct: 79, rightPct: 88};
const W = 1080, H = 1920;

type Band = {top: number; bottom: number}; // % of frame height

// rough on-screen band of a caption page for its preset; index = its place in
// the projected list (floating presets cycle their slots by it, like the renderer)
function captionBand(c: Caption, style: string | undefined, index: number): Band {
  const p = presetOf(style);
  const chars = c.words.reduce((n, w) => n + w.text.length + 1, -1);
  const lines = Math.max(1, Math.ceil(chars / p.layout.maxCharsLine));
  const scale = (c.scale ?? 1) * pageScale(p, c.words.length);
  const hPx = lines * p.font.sizePx * scale * p.font.lineHeight + (p.container !== 'none' ? p.font.sizePx * 0.5 : 0);
  const top = p.position === 'float' && !c.pin ? FLOAT_SLOTS[index % FLOAT_SLOTS.length].top : c.topPct;
  return {top, bottom: top + (hPx / H) * 100};
}

const SIZES: Record<string, number> = {sm: 60, md: 90, lg: 130, xl: 180};
const BIG: Record<string, number> = {lg: 150, xl: 210, xxl: 270};
// rough on-screen height of a graphic (px), null = covers the frame (layout / card)
function graphicHeightPx(g: Graphic): number | null {
  const p: any = g.props;
  switch (g.template) {
    case 'hook-stack': return p.lines.reduce((n: number, l: any) => n + (SIZES[l.size] ?? 130), 0) * 0.98;
    case 'label-2tone': return 72 * 1.05 * (p.bottom ? 2 : 1) + (p.plate === 'none' ? 0 : 36);
    case 'stat': return 170 + (p.label ? 54 : 0);
    case 'chapter': return 40 + 200;
    case 'big-word': return p.repeat ? 5 * (BIG[p.size] ?? 210) * 0.72 : (BIG[p.size] ?? 210);
    case 'fill-title': return 200;
    case 'script-title': return (p.tag ? 42 : 0) + 150 + (p.sub ? 44 : 0);
    case 'sticker': return ((p.widthPct ?? 28) / 100) * W; // square-ish
    case 'band-title': return 150;
    case 'neon-frame': return ((p.heightPct ?? 34) / 100) * H;
    case 'scribble': return ((p.heightPct ?? 16) / 100) * H;
    case 'outline-rect': case 'frame-light': case 'rules': case 'person-outline': return 1; // see-through decoration, no band of its own
    case 'ornament': return (p.size ?? 60) * 1.2;
    case 'oversized': return oversizedPx(p.text, p.font) * 0.9;
    case 'chapter-caps': return 60 + (p.sub ? 50 : 0);
    case 'starburst': return STAR_PX[p.size] ?? STAR_PX.md;
    case 'location-tag': return p.sub ? 120 : 84;
    case 'price': return (p.label ? 44 : 0) + 150 + (p.note ? 46 : 0);
    default: return null;
  }
}
function graphicBand(g: Graphic): Band | null {
  const h = graphicHeightPx(g);
  if (h == null) return null;
  const y = g.yPct ?? TEMPLATES[g.template]?.y ?? 50;
  const top = CENTERED.has(g.template) ? y - (h / H) * 50 : y;
  return {top, bottom: top + (h / H) * 100};
}
const overlap = (a: Band, b: Band) => a.top < b.bottom && b.top < a.bottom;

// Captions step out of the way of a text graphic on screen at the same time
// (run 6: the hook sat on the first caption). The page moves just under the
// graphics it meets, or just above them, whichever stays inside the safe zone,
// and is pinned there so floating presets keep it. With no room it stays put
// and validate reports the overlap. caps/gfx: projected (timeline) items.
export function avoidGraphics(caps: Caption[], gfx: Graphic[], style?: string): Caption[] {
  const blockers = gfx.filter((g) => !g.behind && !CENTERED.has(g.template)).map((g) => ({g, band: graphicBand(g)})).filter((x): x is {g: Graphic; band: Band} => !!x.band);
  if (!blockers.length) return caps;
  return caps.map((c, i) => {
    const band = captionBand(c, style, i);
    const during = blockers.filter(({g}) => c.startMs < g.endMs && g.startMs < c.endMs);
    const hits = during.filter((x) => overlap(band, x.band));
    if (!hits.length) return c;
    const h = band.bottom - band.top;
    const free = (top: number) => top >= SAFE.topPct && top + h <= SAFE.bottomPct && !during.some((x) => overlap({top, bottom: top + h}, x.band));
    const below = Math.max(...hits.map((x) => x.band.bottom)) + 2;
    const above = Math.min(...hits.map((x) => x.band.top)) - 2 - h;
    const top = free(below) ? below : free(above) ? above : null;
    return top == null ? c : {...c, topPct: Math.round(top * 10) / 10, pin: true};
  });
}

// face box per source file, fractions of the frame (from the captions job's YuNet pass)
export type FaceBox = {found?: boolean; top: number; bottom: number; left?: number; right?: number};

// rough on-screen width of a text graphic, % of the frame width (centered blocks)
const FACE_FAMILY: Record<string, FontFamily> = {display: 'Montserrat', condensed: 'Anton', script: 'Caveat', serif: 'Playfair Display', 'serif-italic': 'Instrument Serif'};
function graphicWidthPct(g: Graphic): number {
  const p: any = g.props;
  const w = (text: string, px: number, family: FontFamily = 'Montserrat') => Math.min(960, textWidthEm(text, family) * px);
  switch (g.template) {
    case 'hook-stack': return (Math.max(...p.lines.map((l: any) => w(p.upper ? String(l.text).toUpperCase() : l.text, SIZES[l.size] ?? 130))) / W) * 100;
    case 'big-word': return (w(p.upper ? String(p.text).toUpperCase() : p.text, BIG[p.size] ?? 210, FACE_FAMILY[p.font]) / W) * 100;
    case 'oversized': return 100;
    case 'label-2tone': return (Math.max(w(p.top, 72), w(p.bottom ?? '', 72)) / W) * 100;
    default: return 80;
  }
}
// share of a behind graphic hidden by the presenter's head (face box grown by a quarter for hair, and to the neck)
function hiddenShare(band: Band, g: Graphic, face: FaceBox): number {
  if (face.left == null || face.right == null) return 0;
  const fh = face.bottom - face.top, fw = face.right - face.left;
  const head = {top: (face.top - 0.25 * fh) * 100, bottom: (face.bottom + 0.3 * fh) * 100, left: (face.left - 0.15 * fw) * 100, right: (face.right + 0.15 * fw) * 100};
  const width = graphicWidthPct(g);
  const text = {top: band.top, bottom: band.bottom, left: 50 - width / 2, right: 50 + width / 2};
  const ix = Math.max(0, Math.min(head.right, text.right) - Math.max(head.left, text.left));
  const iy = Math.max(0, Math.min(head.bottom, text.bottom) - Math.max(head.top, text.top));
  const area = (text.right - text.left) * (text.bottom - text.top);
  return area > 0 ? (ix * iy) / area : 0;
}
const SINGLE_WORD = new Set(['big-word', 'oversized', 'fill-title']); // what may sit behind the head

// the font FILES a render loads from public/: the caption pack's own when captions are on screen
// (src/projectFont.ts) and the brand kit's (src/fonts.ts). A missing one stops the render.
type FontsOf = {captions: Caption[]; captionStyle?: string; brand?: {fonts?: {files?: {file: string}[]}} | null};
export const fontFiles = (p: FontsOf): string[] =>
  [...new Set([...(p.captions.length && presetOf(p.captionStyle).font.custom ? [presetOf(p.captionStyle).font.custom!.file] : []), ...(p.brand?.fonts?.files ?? []).map((f) => f.file)])];

// Word times the ASR squeezed: WhisperX once packed a sentence with two figures and a date into
// 1.84 s, ~16 syllables/s where speech runs ~6, and the captions ran off the voice. A run above
// MAX_SYL_PER_S over at least a second is flagged with its word ids.
// ponytail: syllables = vowel groups, a non-zero digit 2 (ES/EN; the zeros of '1,500,000' are said as
// 'mil' / 'millón', next to nothing) — a hiatus or a silent e miscounts a word here and there, which the
// margin to 10/s absorbs; a real syllabifier to tighten the threshold.
const MAX_SYL_PER_S = 10;
export const syllables = (t: string) => (t.toLowerCase().match(/[aeiouyáéíóúü]+/g)?.length ?? 0) + 2 * (t.match(/[1-9]/g)?.length ?? 0);
// runs of words (in time order) whose shortest window of ≥ 1 s from any word is too fast; overlapping windows merge
export function fastRuns(words: {text: string; startMs: number; endMs: number}[]): {from: number; to: number}[] {
  const runs: {from: number; to: number}[] = [];
  for (let i = 0; i < words.length; i++) {
    let syl = 0;
    for (let j = i; j < words.length; j++) {
      syl += syllables(words[j].text);
      const ms = words[j].endMs - words[i].startMs;
      if (ms < 1000) continue;
      if ((syl * 1000) / ms > MAX_SYL_PER_S) { const r = runs.at(-1); if (r && i <= r.to) r.to = Math.max(r.to, j); else runs.push({from: i, to: j}); }
      break;
    }
  }
  return runs;
}
function fastWordIssues(p: {clips: Clip[]; captions: Caption[]}): Issue[] {
  const out: Issue[] = [];
  for (const src of new Set(p.captions.map((c) => c.src))) {
    const cut = p.clips.filter((c) => c.src === src); // the words still in the reel, in source ms
    const ws = p.captions.filter((c) => c.src === src).flatMap((c) => c.words.map((w) => ({...w, cap: c.id})))
      .filter((w) => w.wid && cut.some((c) => w.endMs > c.inSec * 1000 && w.startMs < c.outSec * 1000)).sort((a, b) => a.startMs - b.startMs);
    for (const {from, to} of fastRuns(ws)) {
      const run = ws.slice(from, to + 1), ms = run[run.length - 1].endMs - run[0].startMs;
      const rate = (run.reduce((n, w) => n + syllables(w.text), 0) * 1000) / ms;
      out.push({level: 'warn', code: 'fast-words', msg: `words ${run[0].wid}…${run[run.length - 1].wid} "${run.map((w) => w.text).join(' ').slice(0, 60)}" run at ${rate.toFixed(0)} syllables/s over ${(ms / 1000).toFixed(1)} s (speech is ~6/s): the transcript squeezed their times and the captions run off the voice — re-transcribe with Deepgram or fix the times`, ref: run[0].cap});
    }
  }
  return out;
}

// fonts: each of fontFiles(p) as the caller found it in public/: false = missing, its full name (name ID 4,
// src/sfnt.ts) or true = present; absent = not checked
export function validateProject(p: {clips: Clip[]; captions: Caption[]; graphics?: Graphic[]; mattes?: {src: string; startMs: number; endMs: number}[]; captionStyle?: string; captionsOff?: boolean; guion?: string; brand?: FontsOf['brand']; identity?: unknown}, fps = 30, faces: Record<string, FaceBox | undefined> = {}, fonts: Record<string, boolean | string> = {}): Issue[] {
  const issues: Issue[] = [];
  if (p.captionsOff) p = {...p, captions: []}; // captions switched off: nothing of them reaches the render
  const custom = presetOf(p.captionStyle).font.custom;
  for (const f of fontFiles(p)) {
    if (fonts[f] === false) issues.push({level: 'error', code: 'font-missing', msg: `public/${f} is missing and the render stops without it — copy the licensed file there (VIBEM's fonts/Helvetica-Bold.ttf: \`npm run setup\` extracts it on macOS)`});
    else if (typeof fonts[f] === 'string' && custom?.file === f && custom.name && fonts[f] !== custom.name) issues.push({level: 'error', code: 'font-wrong', msg: `public/${f} is "${fonts[f]}", not ${custom.name}, and the render stops on it — replace it with the licensed ${custom.name} (\`npm run setup\` extracts it on macOS)`});
  }
  const gfx = projectGraphics(p.graphics ?? [], p.clips, fps);
  const caps = avoidGraphics(projectCaptions(p.captions, p.clips, fps), gfx, p.captionStyle); // as rendered
  const totalMs = caps.length || gfx.length ? Math.max(...caps.map((c) => c.endMs), ...gfx.map((g) => g.endMs), 0) : 0;

  // --- captions ---
  const bands = caps.map((c, i) => captionBand(c, p.captionStyle, i));
  for (let i = 0; i < caps.length; i++) {
    const c = caps[i];
    const band = bands[i];
    if (band.top < SAFE.topPct) issues.push({level: 'warn', code: 'safe-top', msg: `caption ${c.id} starts at ${band.top.toFixed(0)}% — inside the top UI band (<${SAFE.topPct}%)`, ref: c.id});
    if (band.bottom > SAFE.bottomPct) issues.push({level: 'warn', code: 'safe-bottom', msg: `caption ${c.id} reaches ${band.bottom.toFixed(0)}% — under the Reels caption/actions strip (>${SAFE.bottomPct}%)`, ref: c.id});
    const last = c.words[c.words.length - 1];
    if (last && isGlue(last.text, presetOf(p.captionStyle).layout.glueExcept) && c.words.length > 1) issues.push({level: 'warn', code: 'glue', msg: `caption ${c.id} ends on "${last.text}" (function word)`, ref: c.id});
    const dur = c.endMs - c.startMs;
    if (dur < 250) issues.push({level: 'warn', code: 'short', msg: `caption ${c.id} lasts ${dur} ms`, ref: c.id});
    if (dur > 6000) issues.push({level: 'warn', code: 'long', msg: `caption ${c.id} lasts ${(dur / 1000).toFixed(1)} s — split it`, ref: c.id});
    for (let k = 1; k < c.words.length; k++) if (c.words[k].startMs < c.words[k - 1].startMs) { issues.push({level: 'error', code: 'timing', msg: `caption ${c.id}: word ${k} starts before word ${k - 1}`, ref: c.id}); break; }
    const next = caps[i + 1];
    if (next && next.startMs < c.endMs - 40 && next.clipId === c.clipId) issues.push({level: 'error', code: 'overlap-captions', msg: `captions ${c.id} and ${next.id} overlap in time`, ref: c.id});
  }
  issues.push(...fastWordIssues(p));
  // emphasis density
  const words = p.captions.flatMap((c) => c.words);
  const t2 = words.filter((w) => w.tier === 2).length;
  const t1 = words.filter((w) => w.tier === 1).length;
  if (totalMs && t2 > Math.max(1, totalMs / 10000)) issues.push({level: 'warn', code: 'tier2-density', msg: `${t2} tier-2 words in ${(totalMs / 1000).toFixed(0)} s — aim for ≤ 1 per 10 s`});
  const maxShare = presetOf(p.captionStyle).highlight?.maxShare ?? 0.2; // a pack may mark more (vibem: v11 is 27 %)
  if (words.length >= 20 && t1 / words.length > maxShare) issues.push({level: 'warn', code: 'tier1-density', msg: `${Math.round((t1 / words.length) * 100)}% of words are accented — keep it under ${Math.round(maxShare * 100)}%`});
  const emoji = words.filter((w) => w.emoji).length;
  if (totalMs && emoji > Math.max(2, totalMs / 5000)) issues.push({level: 'warn', code: 'emoji-density', msg: `${emoji} emoji in ${(totalMs / 1000).toFixed(0)} s — keep it to about one per 5 s`});

  // --- graphics ---
  for (const g of gfx) {
    const band = graphicBand(g);
    if (band) {
      if (band.top < SAFE.topPct && !g.behind) issues.push({level: 'warn', code: 'safe-top', msg: `graphic ${g.id} (${g.template}) starts at ${band.top.toFixed(0)}% — inside the top UI band`, ref: g.id});
      // text over the presenter's face (behind-graphics and stickers are fine there)
      const face = faces[g.src];
      if (face && face.found !== false && !g.behind && !CENTERED.has(g.template)) {
        const fb = {top: face.top * 100 - 2, bottom: face.bottom * 100 + 2};
        if (overlap(band, fb)) {
          const h = band.bottom - band.top;
          const below = Math.ceil(fb.bottom + 1), above = Math.floor(fb.top - 1 - h);
          // a single giant word may instead go behind the head (reference R1); stacked lines may not
          const move = below + h <= SAFE.bottomPct ? `y_pct ${below}–${Math.floor(SAFE.bottomPct - h)}` : above >= SAFE.topPct ? `y_pct ≤ ${above}` : 'shorter text';
          const hint = SINGLE_WORD.has(g.template) ? `${move}, or behind: true (the head covers part of the word)` : move;
          issues.push({level: 'warn', code: 'face', msg: `graphic ${g.id} (${g.template}, ${band.top.toFixed(0)}–${band.bottom.toFixed(0)}%) covers the presenter's face (${fb.top.toFixed(0)}–${fb.bottom.toFixed(0)}%) — move it: ${hint}`, ref: g.id});
        }
      }
      // behind the head: fine while most of the text still reads
      if (face && face.found !== false && g.behind) {
        const hidden = hiddenShare(band, g, face);
        if (hidden > 0.3) {
          const h = band.bottom - band.top;
          const headTop = (face.top - 0.25 * (face.bottom - face.top)) * 100;
          const above = Math.floor(headTop - h + 4); // the crown may cut into the last few %
          issues.push({level: 'warn', code: 'behind-hidden', msg: `about ${Math.round(hidden * 100)}% of graphic ${g.id} (${g.template}) is hidden behind the presenter's head — ${above >= SAFE.topPct ? `raise it (y_pct ≤ ${above}) or ` : ''}use one big word, or bring it in front`, ref: g.id});
        }
      }
      if (band.bottom > SAFE.bottomPct) issues.push({level: 'warn', code: 'safe-bottom', msg: `graphic ${g.id} (${g.template}) reaches ${band.bottom.toFixed(0)}% — under the bottom UI strip`, ref: g.id});
      for (const [ci, c] of caps.entries()) {
        if (c.startMs < g.endMs && g.startMs < c.endMs && overlap(bands[ci], band) && !CENTERED.has(g.template)) {
          issues.push({level: 'warn', code: 'overlap-graphic', msg: `caption ${c.id} overlaps graphic ${g.id} (${g.template}) at ${(Math.max(c.startMs, g.startMs) / 1000).toFixed(1)} s`, ref: g.id});
          break;
        }
      }
    }
    // one text graphic at a time (decor and layouts may coexist)
    for (const o of gfx) {
      if (o.id <= g.id || o.template === 'layout' || g.template === 'layout' || CENTERED.has(o.template) || CENTERED.has(g.template)) continue;
      if (o.startMs < g.endMs && g.startMs < o.endMs) issues.push({level: 'warn', code: 'overlap-graphics', msg: `graphics ${g.id} and ${o.id} are on screen at the same time`, ref: g.id});
    }
  }
  // a client's deliverables (an identity) keep decor in the master and the text graphics in the supers layer
  // above it: decor the one-pass render draws over a text graphic (it starts later, both in front) is under it
  // in the review and master_supers. Where on screen they meet is geometry this cannot tell — a warning, not
  // a blocker (edge-to-edge frames stay at the edges; layouts are drawn with the footage)
  if (validateIdentity(p.identity).identity) {
    const front = gfx.filter((g) => !g.behind && g.template !== 'layout' && !DECOR_FULL.has(g.template));
    front.forEach((d, i) => {
      if (isTextGraphic(d.template)) return;
      const t = front.slice(0, i).find((o) => isTextGraphic(o.template) && o.endMs > d.startMs);
      if (t) issues.push({level: 'warn', code: 'supers-order', msg: `graphic ${d.id} (${d.template}) is drawn over ${t.id} (${t.template}) here, but a client's master keeps decor under the supers: where they meet on screen the review and master_supers show it under — start it no later than ${t.id}, or keep them apart`, ref: d.id});
    });
  }
  // behind graphics need a matte
  for (const s of spansWithoutMatte([...(p.graphics ?? []), ...p.captions], p.mattes, p.clips)) issues.push({level: 'error', code: 'matte', msg: `behind graphics/captions on ${s.src} ${(s.startMs / 1000).toFixed(1)}–${(s.endMs / 1000).toFixed(1)} s have no person matte — run prepare_mattes`});
  // the guion's coverage (src/guion.ts): conflicts and missing / altered words are warnings for a
  // human (the audio stays on screen); reconciliation-made timing errors are errors
  if (p.guion?.trim() || p.captions.some((c) => c.words.some((w) => w.asr != null))) issues.push(...guionIssues(p.guion ?? '', caps, p.captions));
  // hook: something in the first 3 s
  if (totalMs > 5000 && !gfx.some((g) => g.startMs < 3000 && g.template !== 'layout') && !caps.some((c) => c.startMs < 1500)) issues.push({level: 'warn', code: 'hook', msg: 'nothing on screen in the first 3 s — reels need a hook'});
  return issues;
}

// Checks that need the project's words (mcp/checks.mjs projectWords: its sources' transcript caches):
// off-mic words still inside the cut, and clip edges that fall inside a word.
import type {TClip} from './cuts.ts';
const sourceOf = (src: string) => src.split('/').pop()!.replace(/\.[^.]+$/, '');
export function transcriptIssues(p: {clips: Clip[]; offMic?: string}, tr: TClip[]): Issue[] {
  // one entry per word index: a word on the edge of two pieces of one source is listed in both
  const byIdx = new Map<string, Map<number, TClip['words'][number]>>();
  for (const t of tr) { const m = byIdx.get(t.source) ?? new Map(); for (const w of t.words) m.set(w.i, w); byIdx.set(t.source, m); }
  const bySource = new Map([...byIdx].map(([k, m]) => [k, [...m.values()]]));
  const out: Issue[] = [];
  for (const c of p.clips) {
    const source = sourceOf(c.src);
    const words = bySource.get(source) ?? [];
    for (const [edge, ms] of [['starts', c.inSec * 1000], ['ends', c.outSec * 1000]] as const) {
      const w = words.find((x) => x.startMs + 60 < ms && ms < x.endMs - 60);
      if (w) out.push({level: 'warn', code: 'cut-word', msg: `${c.id} ${edge} in the middle of "${w.word}" (${(ms / 1000).toFixed(2)} s) — ${edge === 'starts' ? `trim_clip in_sec ${((w.startMs - 40) / 1000).toFixed(2)}` : `trim_clip out_sec ${((w.endMs + 40) / 1000).toFixed(2)}`} or cut_words the word`, ref: c.id});
    }
    if (p.offMic === 'off') continue;
    const off = words.filter((w) => w.off && w.endMs > c.inSec * 1000 && w.startMs < c.outSec * 1000).sort((a, b) => a.i - b.i);
    if (!off.length) continue;
    const runs: {from: number; to: number; text: string[]}[] = [];
    for (const w of off) { const r = runs[runs.length - 1]; if (r && w.i === r.to + 1) { r.to = w.i; r.text.push(w.word); } else runs.push({from: w.i, to: w.i, text: [w.word]}); }
    out.push({level: 'warn', code: 'off-mic', msg: `${c.id}: ${off.length} off-mic word(s) still in the cut: ${runs.slice(0, 4).map((r) => `cut_words ${source}:${r.from}${r.to !== r.from ? `…${source}:${r.to}` : ''} "${r.text.join(' ').slice(0, 40)}"`).join('; ')}${runs.length > 4 ? ` (+${runs.length - 4} more)` : ''} — or set_off_mic cut`, ref: c.id});
  }
  return out;
}

// ---------- half-graded sources (scripts/grade-scan.mjs) ----------
// A pre-edit graded only in part: inside one shot the look changes. scans: src → its scan's steps (source
// seconds: at = the first frame of the new look, from / to = the shot around it; the ungraded part is the
// head [from, at) when the grade switches on late — César's G10 —, the tail [at, to) when it stops early,
// `off`) — undefined = not scanned yet. Each clip that shows an ungraded part is warned with the fix: a
// head (#47) — split_clip where the look changes (and at the cut, when the clip also holds the shot before),
// create_lut match on it, set_clip graded: true; a tail — split it off, set_grade it like the shot before.
// A clip that shows only that part, carries its own grade and is marked graded is fixed: nothing — a flag
// inherited through a split is not a fix.
export type GradeStep = {at: number; from: number; to?: number; off?: boolean; frames: number; dY: number; sat: [number, number]};
export function halfGradedIssues(p: {clips: Clip[]; grade?: {overrides?: Record<string, unknown>} | null}, scans: Record<string, {steps: GradeStep[]} | null | undefined>, fps = 30): Issue[] {
  const out: Issue[] = [];
  const EPS = 0.02, SPLIT = 0.2; // EPS under a frame: a split lands on the change within the printed millisecond
  for (const pc of placeClips(p.clips, fps)) {
    const c = pc.clip;
    const tl = (s: number) => +((pc.startMs + ((s - c.inSec) / (c.speed ?? 1)) * 1000) / 1000).toFixed(3); // source → timeline s
    for (const st of scans[c.src]?.steps ?? []) {
      const [u0, u1] = st.off ? [st.at, st.to ?? c.outSec] : [st.from, st.at]; // the ungraded part
      if (c.outSec <= u0 + EPS || c.inSec >= u1 - EPS) continue; // shows none of it
      const before = c.inSec < u0 - EPS, own = !before && c.outSec <= u1 + EPS && !!p.grade?.overrides?.[c.id];
      if (own && c.graded === true) continue; // fixed
      // split_clip keeps ≥ 0.2 s a side: under that, the shot before is trimmed off (after the splits: a trim moves
      // the timeline), and a head too short to be a clip is trimmed away.
      // ponytail: a clip ending < 0.2 s after the change (or a tail's split that close to an edge) gets a split that split_clip refuses (and says why)
      const pre = before && u0 - c.inSec >= SPLIT, piece = pre ? `the new piece at ${tl(u0)} s` : c.id;
      const at = [...(pre || (st.off && before) ? [tl(u0)] : []), ...(c.outSec > u1 + EPS ? [tl(u1)] : [])];
      const splits = at.length ? `split_clip at_sec ${at.join(' and at_sec ')} (timeline), then ` : '';
      const fix = own ? `it is its own clip with its own grade: once the join looks right (caption_proof), set_clip graded: true on ${c.id}`
        : st.off ? `${splits}set_grade target ${before ? `the new piece at ${tl(u0)} s` : c.id} like the shot before it (compare the join with caption_proof), then set_clip graded: true on it`
        : c.outSec < st.at - EPS ? `the clip ends inside the head: trim it off (trim_clip) or grade it (set_grade target ${c.id})`
        : st.at - st.from < SPLIT ? `${pre ? `split_clip at_sec ${tl(u0)} (timeline), then ` : ''}trim_clip in_sec ${st.at} on ${piece} (${st.frames} frames are too short for a clip of their own)`
        : `${splits}${before && !pre ? `trim_clip ${c.id} in_sec ${u0} (the shot before goes), then ` : ''}create_lut match on the head (clip_id ${pre ? `of ${piece}` : c.id}), then set_clip graded: true on it`;
      const what = st.off ? `the client's grade stops at ${st.at} s: the ${st.frames} frames to ${u1} s are ungraded` : `the client's grade only starts at ${st.at} s (${st.frames} ungraded frames`;
      out.push({level: 'warn', code: 'half-graded', msg: `${c.id}: ${c.src} is half-graded — in the shot from ${st.from} s of the source ${what}${st.off ? ' (' : '; '}ΔY ${st.dY > 0 ? '+' : ''}${st.dY}, saturation ${st.sat[0]} → ${st.sat[1]}). Fix: ${fix}`, ref: c.id});
    }
  }
  return out;
}

// ---------- identity (set_identity): whose reel this is and which cut of it ----------
// {client, family, script, variant}: the client's slug, the script number (G2) and the variant of
// that script — its hook and/or CTA (H1_C2) or a plain version (V2); family groups the variants of
// one script (default <client>-G<script>). The delivered files are named from it (deliverableName).
// One set of rules for the MCP (set_identity), the backend (POST /api/projects answers 400; the
// uniqueness against the saved projects is claimIdentity in mcp/checks.mjs) and the editor (Settings).
// development: the building / project the reel sells ("Montealbán 326", "Thula", "marca") — the render
// judge's color-ref compares with that development's approved references only
export type Identity = {client: string; family: string; script: number; variant: null | {hook?: number; cta?: number} | {v: number}; development?: string};
// safe integers only: past 2^53 (1e21…) a number prints as 1e+21 and would put a '+' in a file name
const posInt = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 1;
const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

// the identity normalized (default family, variant keys in order, unknown keys dropped), or why not;
// null / absent = no identity: the project renders as before
export function validateIdentity(x: unknown): {identity: Identity | null; error?: string} {
  if (x == null) return {identity: null};
  const no = (error: string) => ({identity: null, error: `identity${error}`});
  if (!plain(x)) return no(': an object {client, script, variant?, family?}');
  const {client, script, variant, family, development} = x;
  if (typeof client !== 'string' || !/^[a-z0-9-]{1,32}$/.test(client)) return no('.client: a slug of a-z, 0-9 and "-", 1–32 characters (e.g. "vibem")');
  if (!posInt(script) || script > 99) return no('.script: a whole number 1–99 (the G of the script)');
  const vr = plain(variant) ? variant : null, keys = vr ? Object.keys(vr) : [];
  if (variant != null && !(vr && keys.length && keys.every((k) => posInt(vr[k]) && (vr[k] as number) <= 999) && (keys.join() === 'v' || keys.every((k) => k === 'hook' || k === 'cta')))) return no('.variant: null, {hook, cta} (one or both) or {v} — whole numbers 1–999');
  const fam = family ?? `${client}-G${script}`;
  if (typeof fam !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(fam)) return no('.family: letters, digits and "-", 1–64 characters');
  const dev = typeof development === 'string' ? development.trim() : development;
  if (dev != null && dev !== '' && (typeof dev !== 'string' || dev.length > 60 || /[\u0000-\u001f]/.test(dev))) return no('.development: a name up to 60 characters (e.g. "Montealbán 326")');
  return {identity: {client, family: fam, script, variant: vr ? Object.fromEntries(['v', 'hook', 'cta'].filter((k) => k in vr).map((k) => [k, vr[k]])) as Identity['variant'] : null, ...(dev ? {development: dev} : {})}};
}

// set_identity's arguments and the editor's form (flat numbers) → an identity to validate, its variant from the numbers given
export const identityOf = ({client, script, family, hook, cta, v, development}: {client?: string; script?: number; family?: string; hook?: number; cta?: number; v?: number; development?: string}) => {
  const variant = Object.fromEntries(Object.entries({v, hook, cta}).filter(([, n]) => n != null));
  return {client, script, family, variant: Object.keys(variant).length ? variant : null, development};
};

// VIBEM_G2_H1_C1: client, script and variant (C for the CTA, the client's own H1_C1) — the key of one project
// each (identityTaken) and the stem of its file names
const identityStem = ({client, script, variant}: Identity) =>
  [client.toUpperCase(), `G${script}`, ...(!variant ? [] : 'v' in variant ? [`V${variant.v}`] : [variant.hook && `H${variant.hook}`, variant.cta && `C${variant.cta}`])].filter(Boolean).join('_');

// another project (rows: {id, identity}) already holding this client + script + variant → why, else null
export function identityTaken(rows: {id: string; identity?: unknown}[], id: string, identity: Identity): string | null {
  const stem = identityStem(identity);
  const other = rows.find((r) => { const o = r.id !== id && validateIdentity(r.identity).identity; return !!o && identityStem(o) === stem; });
  return other ? `identity ${stem} is already project ${other.id} — one project per client, script and variant (clear it there or pick another variant)` : null;
}

// One edit on several projects (set_music targets, the editor's "apply to the family"): a family or a list
// of ids (rows: {id, identity} of every saved project), minus except (ids or families) → the ids, or why
// not. Never crosses clients: every project picked has the same identity.client (no identity counts as
// its own). An except that matches nothing picked is an error, so a typo never widens the change.
export function projectTargets(rows: {id: string; identity?: unknown}[], {family, project_ids}: {family?: string; project_ids?: string[]}, except: string[] = []): {ids: string[]; error?: string} {
  const fail = (error: string) => ({ids: [], error});
  if ((family == null) === (project_ids == null)) return fail('targets: give family or project_ids, not both');
  const idOf = new Map(rows.map((r) => [r.id, validateIdentity(r.identity).identity]));
  const unknown = (project_ids ?? []).filter((id) => !idOf.has(id));
  if (unknown.length) return fail(`targets: no project ${unknown.join(', ')}`);
  const picked = project_ids ? [...new Set(project_ids)] : rows.filter((r) => idOf.get(r.id)?.family === family).map((r) => r.id);
  if (!picked.length) return fail(`targets: no project${project_ids ? '' : ` in family ${family}`}`);
  const hit = (id: string, x: string) => id === x || idOf.get(id)?.family === x;
  const unused = except.filter((x) => !picked.some((id) => hit(id, x)));
  if (unused.length) return fail(`except: ${unused.join(', ')} is none of the targets (${picked.join(', ')})`);
  const ids = picked.filter((id) => !except.some((x) => hit(id, x)));
  if (!ids.length) return fail('targets: except leaves no project');
  const byClient = new Map<string, string[]>();
  for (const id of ids) { const c = idOf.get(id)?.client ?? '(no identity)'; byClient.set(c, [...(byClient.get(c) ?? []), id]); }
  if (byClient.size > 1) return fail(`targets cross clients (${[...byClient].map(([c, l]) => `${c}: ${l.join(', ')}`).join('; ')}) — one client per call`);
  return {ids};
}

// the write of each target in turn; one failing never stops the others → a line per project (ok / error and why)
export async function eachTarget(ids: string[], write: (id: string) => Promise<unknown>): Promise<{failed: number; lines: string[]}> {
  const lines: string[] = [];
  let failed = 0;
  for (const id of ids) {
    try { await write(id); lines.push(`${id}: ok`); } catch (e) { failed++; lines.push(`${id}: error — ${(e as Error).message}`); }
  }
  return {failed, lines};
}

// What a version of a project with an identity delivers, frame for frame over each other (scripts/render-runner.mjs):
// key in version.deliverables → the kind in its system name, the extension. The master carries no text; the
// captions come twice (CEO-14): a ProRes 4444 layer with alpha and its PNG sequence zipped with fps.json; the
// supers (the text graphics) are a ProRes 4444 layer; master_supers = the master with the supers burnt in.
// The runner, the reviews store, the MCP and the editor all list them from here
export const DELIVERABLES = [
  {key: 'master', kind: 'master', ext: 'mp4'},
  {key: 'captions', kind: 'captions', ext: 'mov'},
  {key: 'captionsPng', kind: 'captions', ext: 'png.zip'},
  {key: 'supers', kind: 'supers', ext: 'mov'},
  {key: 'masterSupers', kind: 'master_supers', ext: 'mp4'},
] as const;

// the system name of a delivered file, {CLIENT}_G{s}[_H{h}][_C{c}][_V{k}]_v{n}_{kind}.{ext}:
// VIBEM_G2_H1_C1_v3_master.mp4, VIBEM_G10_V2_v1_captions.png.zip. Only [A-Za-z0-9_.-], an extension of
// one or two parts — never a path.
export function deliverableName({identity, v, kind, ext}: {identity: unknown; v: number; kind: string; ext: string}): string {
  const r = validateIdentity(identity);
  if (!r.identity) throw new Error(r.error ?? 'a deliverable needs an identity (set_identity)');
  const part = (s: unknown, re: RegExp) => typeof s === 'string' && re.test(s);
  if (!posInt(v) || !part(kind, /^[A-Za-z0-9_]{1,16}$/) || !part(ext, /^[A-Za-z0-9]{1,16}(\.[A-Za-z0-9]{1,16})?$/)) throw new Error(`bad deliverable name parts: v${v} ${kind}.${ext}`);
  const name = `${identityStem(r.identity)}_v${v}_${kind}.${ext}`;
  if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9]+){1,2}$/.test(name)) throw new Error(`bad deliverable name: ${name}`); // the guarantee, whatever built it
  return name;
}
