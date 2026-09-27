// Captions never cover a face — César via Felipe: "si en un clip la ponemos en un lugar no quiero que se mueva, pero
// sí estar seguro que en todo ese clip no tapa una cara"; "que puedas más o menos decirle cuánto quiere que varíe";
// "que puedas decidir por toma o por video… que sea muy libre"; "hecho para todos los casos". Pure: the face scans
// come in (scripts/face-scan.mjs → public/clips/faces/<source>.json), placed pages and findings go out. One function
// for every pack — a pinned top (vibem), anchored, floating corners, footage in a layout frame — and every caller: the
// captions job, the MCP (set_captions, set_caption_style, set_brand, run_ai_step), the editor's Captions tab, and
// validate / the editor's Validate (caption-face).
//
// TAKE: what the viewer sees as one continuous shot. Consecutive timeline clips of one source are one take — jump cuts
// inside a recording and punch-alternate included (the union of both framings must be clear) — until the source
// itself changes shot (the face scan's cuts, the grade scan's structure-hash rule: César's finished exports are one
// file of many shots). A page belongs to the take it starts in.
// HOLD (faceHold): how long one position holds — 'toma' (a take), 'video' (the whole reel), 'pagina' (every page on
// its own: the text may move between pages). The span is the only thing that changes; a page shown twice (a source
// placed twice) holds one position across both.
// SHIFT (faceShift): how far, ± % of the frame's height, a position may move from the pack's to clear every face of
// its span; 0 = never (validate only reports). The pack's position is the base: its pinned top (vibem 53 %),
// DEFAULT_TOP, or a floating pack's corner by page (FLOAT_SLOTS) — which may also move to another corner.
// A page a person placed (pin) is never moved; validate still reports it.
// Defaults for every project: FACE_DEFAULTS; a client's style kit (brand.style.faceShift / faceHold, set_brand style)
// and then the project (set_captions face_shift / face_hold, the Captions tab) override them.
import {hideUnder, projectCaptions, shownUntilMs, type Caption} from './captions.ts';
import {FLOAT_SLOTS, floatSlot, presetOf, type Preset} from './captionPresets.ts';
import {FLOAT_MAX, PAGE_PAD_PX} from './captionLayout.ts';
import {DEFAULT_TOP} from './paging.ts';
import {SAFE, captionBand, captionBlock, type Issue} from './validate.ts';
import {PULL_ORIGIN_Y, captionLayout, pullAt} from './layers.ts';
import {placeClips, sampleTransform, type Clip} from './timeline.ts';
import {transitionFx} from './transitions.ts';
import {BROLL_BOX, projectBrolls, type BrollItem} from './brollModel.ts';
import {WINDOW_BAR, layoutBoxes, projectGraphics, type Box, type Graphic} from './graphicTemplates.ts';
import {brollMotion} from './motion.ts';
import {packOf} from './stylePacks.ts';

export const FACE_HOLDS = ['toma', 'video', 'pagina'] as const;
export type FaceHold = (typeof FACE_HOLDS)[number];
export const FACE_DEFAULTS: {shift: number; hold: FaceHold} = {shift: 15, hold: 'toma'};
export const FACE_MARGIN = 1.5; // % of the frame kept between a face and the captions when placing them
type Knobs = {faceShift?: number | null; faceHold?: string | null; brand?: {style?: {faceShift?: unknown; faceHold?: unknown}} | null};
const holdOf = (x: unknown): FaceHold | undefined => (FACE_HOLDS as readonly unknown[]).includes(x) ? (x as FaceHold) : undefined;
// the project's, else its kit's, else the defaults
export const faceKnobs = (p: Knobs): {shift: number; hold: FaceHold} => ({
  shift: p.faceShift ?? (typeof p.brand?.style?.faceShift === 'number' ? p.brand.style.faceShift : FACE_DEFAULTS.shift),
  hold: holdOf(p.faceHold) ?? holdOf(p.brand?.style?.faceHold) ?? FACE_DEFAULTS.hold,
});

// ---- the scans ----
export const faceCacheName = (src: string) => `${src.split('/').pop()!.replace(/\.[^.]+$/, '')}.json`;
export type FaceBox = {left: number; top: number; right: number; bottom: number; score?: number}; // fractions of the source frame
export type FaceScan = {found?: boolean; left?: number; top?: number; right?: number; bottom?: number; width?: number; height?: number; rate?: number; samples?: {t: number; faces: FaceBox[]}[]; cuts?: number[]};
export type Scans = Record<string, FaceScan | null | undefined>;
// the faces a source shows at its second t: the nearest sample (the scan takes 2 a second), any time for a one-frame
// scan (an image); an older cache (one summary box, no samples) as that box all along
export function facesIn(scan: FaceScan | null | undefined, t: number): FaceBox[] {
  const s = scan?.samples;
  if (!s?.length) return scan?.found && scan.top != null && scan.bottom != null ? [{left: scan.left ?? 0, top: scan.top, right: scan.right ?? 1, bottom: scan.bottom}] : [];
  if (s.length === 1) return s[0].faces;
  let lo = 0, hi = s.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (s[m].t < t) lo = m + 1; else hi = m; }
  const near = lo > 0 && Math.abs(s[lo - 1].t - t) < Math.abs(s[lo].t - t) ? s[lo - 1] : s[lo];
  return Math.abs(near.t - t) <= 0.75 / (scan!.rate ?? 2) ? near.faces : [];
}

// ---- takes ----
export type Take = {startMs: number; endMs: number; ids: string[]};
export function takesOf(clips: Clip[], scans: Scans, fps: number): Take[] {
  const out: (Take & {src: string; shot: number})[] = [];
  for (const pc of placeClips(clips, fps)) {
    const c = pc.clip, cuts = scans[c.src]?.cuts ?? [];
    const tl = (s: number) => pc.startMs + ((s - c.inSec) / (c.speed ?? 1)) * 1000;
    const inner = cuts.filter((t) => t > c.inSec + 1e-3 && t < c.outSec - 1e-3);
    [c.inSec, ...inner].forEach((a, k) => {
      const shot = cuts.filter((t) => t <= a + 1e-3).length, last = out.at(-1), endMs = k === inner.length ? pc.endMs : tl(inner[k]);
      if (!k && last && last.src === c.src && last.shot === shot) { last.endMs = endMs; last.ids.push(c.id); }
      else out.push({startMs: k ? tl(a) : pc.startMs, endMs, ids: [c.id], src: c.src, shot});
    });
  }
  return out.map(({startMs, endMs, ids}) => ({startMs, endMs, ids: [...new Set(ids)]}));
}
const takeAt = (takes: Take[], ms: number) => Math.max(0, takes.findIndex((t) => ms < t.endMs));

// ---- what is on screen: every face at a timeline ms, % of the 1080×1920 frame ----
export type Rect = {left: number; top: number; right: number; bottom: number};
const FW = 1080, FH = 1920;
const FULL: Rect = {left: 0, top: 0, right: 100, bottom: 100};
const rectOf = (b: Box): Rect => ({left: b.left, top: b.top, right: b.left + b.width, bottom: b.top + b.height});
const clipTo = (a: Rect, b: Rect): Rect | null => { const r = {left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom)}; return r.right > r.left && r.bottom > r.top ? r : null; };
// a CSS transform step as the composition draws it: scale about (ox, oy) — fractions of ref — then a move of dx / dy % of ref
type Step = {s: number; dx?: number; dy?: number; ox?: number; oy?: number; ref: Rect};
const through = (r: Rect, steps: Step[]): Rect => steps.reduce((b, {s, dx = 0, dy = 0, ox = 0.5, oy = 0.5, ref}) => {
  const w = ref.right - ref.left, h = ref.bottom - ref.top, cx = ref.left + ox * w, cy = ref.top + oy * h;
  const X = (x: number) => cx + (x - cx) * s + (dx / 100) * w, Y = (y: number) => cy + (y - cy) * s + (dy / 100) * h;
  return {left: X(b.left), top: Y(b.top), right: X(b.right), bottom: Y(b.bottom)};
}, r);
// a face of a source of aspect w/h drawn object-fit: cover into r
function cover(f: FaceBox, aspect: number, r: Rect): Rect {
  const rw = ((r.right - r.left) / 100) * FW, rh = ((r.bottom - r.top) / 100) * FH;
  const k = Math.max(rw / aspect, rh), ox = (rw - aspect * k) / 2, oy = (rh - k) / 2;
  const X = (x: number) => r.left + ((ox + x * aspect * k) / FW) * 100, Y = (y: number) => r.top + ((oy + y * k) / FH) * 100;
  return {left: X(f.left), top: Y(f.top), right: X(f.right), bottom: Y(f.bottom)};
}
const aspectOf = (s: FaceScan | null | undefined) => (s?.width && s?.height ? s.width / s.height : FW / FH);

type Proj = {clips: Clip[]; captions?: Caption[]; brolls?: BrollItem[]; graphics?: Graphic[]; captionStyle?: string};
// The faces on screen at timeline ms, through the same geometry the composition draws (MultiClipVideo, ClipMedia,
// Broll, LayoutStage): the clip's source object-fit into the frame — or into a layout's video box (its window bar
// off) —, its entry transition's punch / zoom / whip (transitionFx), its keyframes (set_keyframes), the focus pull,
// hero punch and a title's camera push (pullAt); every B-roll cue on screen through its box, its arrival and exit,
// its size and a card's rise (brollMotion), its own entry. A clip's face under an opaque B-roll box is not shown.
// ponytail: a layout's entry, a reveal's pre-roll, a carousel's side panels and a cue's opacity ramp are left out
// (fractions of a second at a cut); remote (stock) B-roll has no scan
export function screenFaces(p: Proj, scans: Scans, fps: number): (ms: number) => Rect[] {
  const placed = placeClips(p.clips, fps);
  const {preset, focus, punch, pulses, zooms, projectedGraphics} = captionLayout({...p, captionsOff: false}, fps);
  const pack = packOf(p.captionStyle);
  const brolls = projectBrolls(p.brolls ?? [], p.clips, fps);
  const cards = brolls.filter((b) => b.mode === 'card').map((b) => ({startMs: b.startMs, endMs: b.endMs}));
  const layouts = projectedGraphics.filter((g) => g.template === 'layout');
  const oy = PULL_ORIGIN_Y / 100;
  return (ms) => {
    const frame = Math.floor((ms / 1000) * fps + 1e-6);
    const lay = layouts.find((g) => ms >= g.startMs && ms < g.endMs);
    const boxes = lay ? layoutBoxes(lay.props) : null;
    let r = boxes ? rectOf(boxes.video) : FULL;
    if ((lay?.props as {shape?: string} | undefined)?.shape === 'window') r = {...r, top: r.top + (WINDOW_BAR / FH) * 100};
    const out: Rect[] = [], opaque: Rect[] = [];
    const bPull = pullAt(frame, fps, {spans: focus, blurPx: preset.focusPull}).scale;
    for (const b of brolls) {
      if (ms < b.startMs || ms >= b.endMs) continue;
      const panel = boxes?.panel ?? null, box = rectOf(panel ?? BROLL_BOX[b.mode] ?? BROLL_BOX.fullscreen), inset = b.mode === 'inset' && !panel;
      const f = frame - Math.round((b.startMs / 1000) * fps), dur = Math.max(1, Math.round(((b.endMs - b.startMs) / 1000) * fps));
      const mo = brollMotion({arrive: b.arrive ?? pack?.brollIn ?? 'cut', leave: b.leave ?? pack?.brollOut ?? 'cut', scale: b.scale ?? 1, card: b.mode === 'card' && !panel}, f, dur, fps);
      const outer: Step[] = [{s: 1, dy: (mo.cardY / (((box.bottom - box.top) / 100) * FH)) * 100, ref: box}, {s: mo.scale, ox: inset ? 1 : 0.5, oy: inset ? 0 : 0.5, ref: box}, {s: 1, dx: mo.dx, dy: mo.dy, ref: box}, {s: bPull, oy, ref: FULL}];
      const fx = b.enter && b.enter !== 'cut' ? transitionFx({id: b.id, src: b.src, inSec: 0, outSec: 0, sourceDurationSec: 0, enter: b.enter}, f, 1e6, undefined, fps) : null;
      const shown = clipTo(through(box, outer), FULL);
      if (!shown) continue;
      if (mo.opacity >= 0.999) opaque.push(shown);
      const scan = /^https?:/i.test(b.src) ? null : scans[b.src];
      for (const face of facesIn(scan, (ms - b.startMs) / 1000)) {
        const m = clipTo(through(cover(face, aspectOf(scan), box), [...(fx && (fx.scale !== 1 || fx.dx) ? [{s: fx.scale, dx: fx.dx, oy, ref: box}] : []), ...outer]), shown);
        if (m) out.push(m);
      }
    }
    const i = placed.findIndex((x) => ms >= x.startMs && ms < x.endMs);
    if (i >= 0) {
      const pc = placed[i], c = pc.clip, t = c.inSec + ((ms - pc.startMs) / 1000) * (c.speed ?? 1);
      const fx = transitionFx(c, frame - pc.fromFrame, pc.durFrames, placed[i + 1]?.clip, fps), kf = sampleTransform(c.transform, t);
      const pull = pullAt(frame, fps, {spans: [...focus, ...cards], blurPx: preset.focusPull || 18, opening: preset.opening, punch, pulses, zooms}).scale;
      const steps: Step[] = [...(fx.scale !== 1 || fx.dx ? [{s: fx.scale, dx: fx.dx, oy, ref: r}] : []), {s: kf.scale, dx: kf.x, dy: kf.y, ref: r}, {s: pull, oy, ref: r}];
      for (const face of facesIn(scans[c.src], t)) {
        const m = clipTo(through(cover(face, aspectOf(scans[c.src]), r), steps), r);
        if (m && !opaque.some((o) => m.left >= o.left && m.right <= o.right && m.top >= o.top && m.bottom <= o.bottom)) out.push(m);
      }
    }
    return out;
  };
}

// ---- a page's block against the faces ----
const STEP_MS = 100;
// the times a page is on screen, every STEP_MS (the scan's samples are 500 ms apart: every one is seen)
const timesOf = (pages: Caption[], i: number, holdMs: number) => {
  const a = pages[i].startMs, b = Math.max(a + 1, shownUntilMs(pages, i, holdMs));
  const out: number[] = [];
  for (let t = a; t < b; t += STEP_MS) out.push(t);
  return [...out, b - 1];
};
// the page's horizontal span (% of the width) at an alignment: centered, or a floating corner's side
function spanOf(p: Preset, w: number, align: string, float: boolean): [number, number] {
  const pad = ((p.layout.padPx ?? PAGE_PAD_PX) / FW) * 100, room = (100 - 2 * pad) * (float ? FLOAT_MAX : 1), ww = float ? Math.min(w, room) : w;
  return align === 'flex-start' ? [pad, pad + ww] : align === 'flex-end' ? [100 - pad - ww, 100 - pad] : [Math.max(0, 50 - ww / 2), Math.min(100, 50 + ww / 2)];
}
const meets = (top: number, h: number, x: [number, number], f: Rect, m: number) => f.left - m < x[1] && x[0] < f.right + m && f.top - m < top + h && top < f.bottom + m;
// the clear top closest to `want` within [lo, hi] (just under or over a face), or null
function nearestClear(want: number, lo: number, hi: number, h: number, x: [number, number], faces: Rect[], m: number): number | null {
  const r = (t: number) => Math.round(t * 10) / 10;
  const cands = [want, lo, hi, ...faces.flatMap((f) => [Math.ceil((f.bottom + m) * 10) / 10, Math.floor((f.top - m - h) * 10) / 10])].map(r).filter((t) => t >= lo - 1e-9 && t <= hi + 1e-9);
  return cands.filter((t) => !faces.some((f) => meets(t, h, x, f, m))).sort((a, b) => Math.abs(a - want) - Math.abs(b - want))[0] ?? null;
}

// Every page's position, clear of the faces of its span: kept at the pack's when clear at every moment, else the clear
// top closest to it within ±shift (and inside validate's SAFE), else kept (validate: caption-face). Returns the
// project's captions: non-pinned pages on screen get their top (a floating page its corner too, `slot`, when moved);
// the words are never touched — changing faceShift / faceHold re-places without re-paging.
export function placeCaptions(p: Proj & Knobs, scans: Scans, fps: number): Caption[] {
  const caps = p.captions ?? [];
  if (!caps.length || !p.clips.length) return caps;
  const preset = presetOf(p.captionStyle), float = preset.position === 'float', n = FLOAT_SLOTS.length;
  const {shift, hold} = faceKnobs(p);
  // the pages as rendered (none under an end card), in the renderer's order: a floating page's corner is its index's
  const shown = hideUnder(projectCaptions(caps, p.clips, fps), projectGraphics(p.graphics ?? [], p.clips, fps).filter((g) => g.template === 'end-card'));
  const pinned = new Set(caps.filter((c) => c.pin).map((c) => c.id));
  const facesAt = screenFaces(p, scans, fps), takes = takesOf(p.clips, scans, fps);
  // spans: a page, a take or the reel — joined where one stored page shows in two
  const span = shown.map((c, i) => (hold === 'pagina' ? i : hold === 'video' ? 0 : takeAt(takes, c.startMs)));
  const root = new Map<number, number>();
  const find = (k: number): number => { const r = root.get(k) ?? k; return r === k ? k : find(r); };
  const firstOf = new Map<string, number>();
  shown.forEach((c, i) => { const j = firstOf.get(c.id); if (j == null) firstOf.set(c.id, i); else root.set(find(span[i]), find(span[j])); });
  const groups = new Map<string, number[]>();
  shown.forEach((c, i) => {
    if (pinned.has(c.id)) return;
    const k = `${find(span[i])}|${float ? firstOf.get(c.id)! % n : 'a'}`;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  });
  const at = new Map<string, {top: number; slot?: number}>();
  for (const [k, idx] of groups) {
    const blocks = idx.map((i) => captionBlock(shown[i], preset, float));
    const h = Math.max(...blocks.map((b) => b.h)), w = Math.max(...blocks.map((b) => b.w));
    const faces = idx.flatMap((i) => timesOf(shown, i, preset.holdMs).flatMap(facesAt));
    const home = float ? FLOAT_SLOTS[Number(k.split('|')[1])] : {top: preset.layout.topPct ?? DEFAULT_TOP, align: 'center'};
    const clear = (top: number, align: string) => !faces.some((f) => meets(top, h, spanOf(preset, w, align, float), f, FACE_MARGIN));
    let best: {top: number; slot?: number} | null = clear(home.top, home.align) ? {top: home.top} : null;
    if (!best && shift > 0) {
      const t = nearestClear(home.top, Math.max(SAFE.topPct, home.top - shift), Math.min(SAFE.bottomPct - h, home.top + shift), h, spanOf(preset, w, home.align, float), faces, FACE_MARGIN);
      const home0 = float ? FLOAT_SLOTS.findIndex((s) => s === home) : -1;
      const other = float ? FLOAT_SLOTS.map((s, j) => ({top: s.top, slot: j})).filter((s) => s.slot !== home0 && clear(s.top, FLOAT_SLOTS[s.slot].align)) : [];
      best = [...(t != null ? [{top: t, ...(float ? {slot: home0} : {})}] : []), ...other].sort((a, b) => Math.abs(a.top - home.top) - Math.abs(b.top - home.top))[0] ?? null;
    }
    for (const i of idx) at.set(shown[i].id, best ?? {top: home.top});
  }
  return caps.map((c) => {
    const a = at.get(c.id);
    if (!a) return c;
    if (!float) return c.topPct === a.top ? c : {...c, topPct: a.top};
    const {slot: _, ...rest} = c;
    return a.slot != null ? {...rest, slot: a.slot, topPct: a.top} : rest;
  });
}

// ---- validate: caption-face ----
// every moment a page as rendered (around the graphics, none under an end card: src/layers.ts) meets a face — the
// judge feeds the faces it sees on the rendered master, validate the scans mapped through the composition
export type Hit = {i: number; ms: number; face: Rect; top: number; bottom: number; x: [number, number]; area: number};
export function captionHits(pages: Caption[], style: string | undefined, facesAt: (ms: number) => Rect[]): Hit[] {
  const preset = presetOf(style), out: Hit[] = [];
  pages.forEach((c, i) => {
    const float = preset.position === 'float' && !c.pin, band = captionBand(c, style, i);
    const x = spanOf(preset, captionBlock(c, preset, float).w, float ? floatSlot(c, i).align : 'center', float);
    for (const ms of timesOf(pages, i, preset.holdMs)) for (const f of facesAt(ms)) {
      if (!meets(band.top, band.bottom - band.top, x, f, 0)) continue;
      out.push({i, ms, face: f, top: band.top, bottom: band.bottom, x, area: (Math.min(x[1], f.right) - Math.max(x[0], f.left)) * (Math.min(band.bottom, f.bottom) - Math.max(band.top, f.top))});
    }
  });
  return out;
}
const pct = (x: number) => Math.round(x);
// One warning per take whose captions meet a face at some moment: its clips, its pages, the worst moment and the fix
export function captionFaceIssues(p: Proj & Knobs & {captionsOff?: boolean}, scans: Scans, fps: number): Issue[] {
  if (p.captionsOff || !p.captions?.length) return [];
  const {shownCaptions: pages, preset} = captionLayout(p, fps);
  const facesAt = screenFaces(p, scans, fps), takes = takesOf(p.clips, scans, fps), {shift} = faceKnobs(p);
  const byTake = new Map<number, Hit[]>();
  for (const h of captionHits(pages, p.captionStyle, facesAt)) { const k = takeAt(takes, pages[h.i].startMs); byTake.set(k, [...(byTake.get(k) ?? []), h]); }
  const s1 = (ms: number) => (ms / 1000).toFixed(1);
  return [...byTake].map(([k, hits]) => {
    const take = takes[k], worst = hits.reduce((a, b) => (b.area > a.area ? b : a)), ids = [...new Set(hits.map((h) => pages[h.i].id))];
    const byHand = ids.filter((id) => p.captions!.find((c) => c.id === id)?.pin);
    // how far the pack's position would have to move to clear this take's faces (the same search as the placement)
    const home = preset.position === 'float' ? floatSlot({topPct: 0}, worst.i).top : preset.layout.topPct ?? DEFAULT_TOP;
    const faces = [...new Set(hits.map((h) => h.i))].flatMap((i) => timesOf(pages, i, preset.holdMs).flatMap(facesAt));
    const h = Math.max(...hits.map((x) => x.bottom - x.top));
    const t = nearestClear(home, SAFE.topPct, SAFE.bottomPct - h, h, worst.x, faces, FACE_MARGIN), need = t == null ? null : Math.ceil(Math.abs(t - home));
    const reach = byHand.length === ids.length ? `${byHand.join(', ')} ${byHand.length > 1 ? 'were' : 'was'} placed by hand: move ${byHand.length > 1 ? 'them' : 'it'} (edit_caption top_pct) or leave ${byHand.length > 1 ? 'them' : 'it'}`
      : need == null ? 'no clear band inside the safe zone'
      : need <= shift ? `a clear top (${t} %) is within reach: re-place the captions (set_captions face_shift ${shift})`
      : `raise the reach to ±${need} % (set_captions face_shift ${need}; now ±${shift})`;
    return {level: 'warn' as const, code: 'caption-face', ref: ids[0],
      msg: `captions ${ids.join(', ')} on the take ${take?.ids.join(' + ') ?? '?'} (${s1(take?.startMs ?? 0)}–${s1(take?.endMs ?? 0)} s) cover a face — worst at ${s1(worst.ms)} s: face ${pct(worst.face.top)}–${pct(worst.face.bottom)} %, captions ${pct(worst.top)}–${pct(worst.bottom)} % of the height. Fix: ${reach}; or fewer lines (edit_caption starts_at_wid), a smaller size (edit_caption scale), a B-roll over the face (add_broll), or a position by hand (edit_caption top_pct)`};
  });
}
