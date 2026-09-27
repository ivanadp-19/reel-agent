// Captions never cover a face — César via Felipe: "si en un clip la ponemos en un lugar no quiero que se mueva, pero
// sí estar seguro que en todo ese clip no tapa una cara"; "que puedas más o menos decirle cuánto quiere que varíe";
// "que puedas decidir por toma o por video… que sea muy libre"; "hecho para todos los casos". Pure: the face scans
// come in (scripts/face-scan.mjs → public/clips/faces/<its path>.json), placed pages and findings go out. One function
// for every pack — a pinned top (vibem), anchored, floating corners, footage in a layout frame — and every caller: the
// captions job, the MCP (set_captions, set_caption_style, set_brand, run_ai_step), the backend's place-captions (the
// reel CLI), the editor's Captions tab, and validate / the editor's Validate / the render judge (caption-face).
//
// TAKE: what the viewer sees as one continuous picture. Consecutive timeline clips of one source are one take — jump
// cuts inside a recording included — until the edit shows a cut (a transition in, or another framing: plainJoin, the
// render judge's shot rule) or the source itself changes shot (the face scan's cuts, the grade scan's structure-hash
// rule: César's finished exports are one file of many shots). A page belongs to the take it starts in, and must be
// clear for as long as it is up.
// HOLD (faceHold): how long one position holds — 'toma' (a take), 'video' (the whole reel), 'pagina' (every page on its
// own: the text may move between pages). The span is the only thing that changes; a page shown twice (a source placed
// twice) holds one position across both.
// SHIFT (faceShift): how far, ± % of the frame's height, a position may move from the pack's; 0 = never (validate only
// reports). The pack's position is the base: its pinned top (vibem 53 %), DEFAULT_TOP, or a floating pack's corner by
// page (FLOAT_SLOTS) — which may move to another corner within the reach.
// THE RULE (one, for placing, validate and the judge): a page's ink band (src/validate.ts captionBand) meets a face when
// it comes within FACE_MARGIN of its box — or, above it, within the head (HAIR). The text graphics a page would step
// around (avoidGraphics) are blocked space too, so the render moves nothing the placement settled.
// Each span takes the top in reach clear of every face at every moment it is up — the nearest to the pack's — and when
// none is, the one covered the least time (validate says so, with the reach that would clear it). A page a person
// placed (pin) is never moved; validate still reports it.
// Defaults for every project: FACE_DEFAULTS; a client's style kit (brand.style.faceShift / faceHold, set_brand style)
// and then the project (set_captions face_shift / face_hold, the Captions tab) override them.
import {hideUnder, projectCaptions, shownUntilMs, type Caption} from './captions.ts';
import {FLOAT_SLOTS, floatSlot, presetOf, type Preset} from './captionPresets.ts';
import {FLOAT_MAX, PAGE_PAD_PX} from './captionLayout.ts';
import {DEFAULT_TOP} from './paging.ts';
import {SAFE, captionBand, captionBlock, overlap, placeBand, textBlockers, type Band, type Issue} from './validate.ts';
import {PULL_ORIGIN_Y, captionLayout, pullAt} from './layers.ts';
import {placeClips, plainJoin, sampleTransform, type Clip} from './timeline.ts';
import {transitionFx} from './transitions.ts';
import {BROLL_BOX, projectBrolls, type BrollItem} from './brollModel.ts';
import {WINDOW_BAR, layoutBoxes, projectGraphics, type Box, type Graphic} from './graphicTemplates.ts';
import {brollMotion} from './motion.ts';
import {packOf} from './stylePacks.ts';

export const FACE_HOLDS = ['toma', 'video', 'pagina'] as const;
export type FaceHold = (typeof FACE_HOLDS)[number];
export const FACE_DEFAULTS: {shift: number; hold: FaceHold} = {shift: 15, hold: 'toma'};
export const MAX_SHIFT = 66; // set_captions face_shift's ceiling: the whole safe zone
export const FACE_MARGIN = 1.5; // % of the frame kept between a face and the captions, below and beside it
export const HAIR = 0.25; // over a face box, the head: a quarter of the box's height (validate's behind-hidden head)
export const FACE_MIN_SCORE = 0.85; // YuNet's confidence a face needs at 640 px (César's presenters ≥ 0.89; chairs 0.6–0.8) — or FACE_LOOK_SCORE at full resolution
type Knobs = {faceShift?: number | null; faceHold?: string | null; brand?: {style?: {faceShift?: unknown; faceHold?: unknown}} | null};
const holdOf = (x: unknown): FaceHold | undefined => (FACE_HOLDS as readonly unknown[]).includes(x) ? (x as FaceHold) : undefined;
// the project's, else its kit's, else the defaults
export const faceKnobs = (p: Knobs): {shift: number; hold: FaceHold} => ({
  shift: p.faceShift ?? (typeof p.brand?.style?.faceShift === 'number' ? p.brand.style.faceShift : FACE_DEFAULTS.shift),
  hold: holdOf(p.faceHold) ?? holdOf(p.brand?.style?.faceHold) ?? FACE_DEFAULTS.hold,
});

// ---- the scans ----
// a source's scan file, by its path under public/ (clips/IMG_1778.mp4 and broll-assets/IMG_1778.mp4 are two), as the
// grade and wind scans name theirs; the basename is where the first scans went (read as a fallback)
export const faceCacheName = (src: string) => `${src.replace(/^\/+/, '').replace(/[^\w.-]+/g, '_')}.json`;
export const legacyFaceCacheName = (src: string) => `${src.split('/').pop()!.replace(/\.[^.]+$/, '')}.json`;
export type FaceBox = {left: number; top: number; right: number; bottom: number; score?: number; look?: number}; // fractions of the source frame; look: scripts/face.py's full-resolution score
export type Sample = {t: number; faces: FaceBox[]};
export type FaceScan = {found?: boolean; left?: number; top?: number; right?: number; bottom?: number; width?: number; height?: number; rate?: number; samples?: Sample[]; cuts?: number[]};
export type Scans = Record<string, FaceScan | null | undefined>;
const shotAt = (cuts: number[] | undefined, t: number) => (cuts ?? []).filter((c) => c <= t + 1e-3).length;
// The faces a scan trusts: FACE_MIN_SCORE or more at the scan's 640 px, or FACE_LOOK_SCORE when looked at again at full
// resolution (scripts/face.py `look`). A rooftop chair or a bottle YuNet takes for a face at 0.6–0.8 falls to 0–0.59
// there; a face on a phone, turned down or far off rises to 0.67–0.93 (César's 18 sources: every detection it drops is
// a chair, a bottle, a glass or the back of a head). Not persistence: in those sources the faces seen in one sample
// only were all real (a presenter in a one-second shot, a B-roll man turning)
export const FACE_LOOK_SCORE = 0.65;
const TRUSTED = new WeakMap<FaceScan, Sample[]>();
export const trusted = (f: FaceBox & {look?: number}) => (f.score ?? 1) >= FACE_MIN_SCORE || (f.look ?? 0) >= FACE_LOOK_SCORE;
export function trustedSamples(scan: FaceScan): Sample[] {
  const hit = TRUSTED.get(scan);
  if (hit) return hit;
  const out = (scan.samples ?? []).map((x) => ({t: x.t, faces: x.faces.filter(trusted)}));
  TRUSTED.set(scan, out);
  return out;
}
// the faces a source shows at its second t: both samples around it within its shot (a face one of them missed is still
// there, and it moved between them), a one-frame scan (an image) at any time; an older cache (one summary box, no
// samples) as that box all along
export function facesIn(scan: FaceScan | null | undefined, t: number): FaceBox[] {
  if (!scan?.samples?.length) return scan?.found && scan.top != null && scan.bottom != null ? [{left: scan.left ?? 0, top: scan.top, right: scan.right ?? 1, bottom: scan.bottom}] : [];
  const s = trustedSamples(scan);
  if (s.length === 1) return s[0].faces;
  let lo = 0, hi = s.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (s[m].t <= t) lo = m + 1; else hi = m; }
  const shot = shotAt(scan.cuts, t), around = [s[lo - 1], s[lo]].filter((x) => x && shotAt(scan.cuts, x.t) === shot);
  const faces = around.filter((x) => around.length === 2 || Math.abs(x.t - t) <= 0.75 / (scan.rate ?? 2)).flatMap((x) => x.faces);
  return faces.filter((f, k) => faces.findIndex((g) => g.left === f.left && g.top === f.top && g.right === f.right && g.bottom === f.bottom) === k);
}

// ---- takes ----
export type Take = {startMs: number; endMs: number; ids: string[]};
export function takesOf(clips: Clip[], scans: Scans, fps: number): Take[] {
  const out: (Take & {src: string; shot: number})[] = [];
  const placed = placeClips(clips, fps);
  placed.forEach((pc, i) => {
    const c = pc.clip, prev = placed[i - 1]?.clip, cuts = scans[c.src]?.cuts ?? [];
    const tl = (s: number) => pc.startMs + ((s - c.inSec) / (c.speed ?? 1)) * 1000;
    const inner = cuts.filter((t) => t > c.inSec + 1e-3 && t < c.outSec - 1e-3);
    [c.inSec, ...inner].forEach((a, k) => {
      const shot = shotAt(cuts, a), last = out.at(-1), endMs = k === inner.length ? pc.endMs : tl(inner[k]);
      if (!k && last && prev && last.src === c.src && last.shot === shot && plainJoin(prev, c)) { last.endMs = endMs; last.ids.push(c.id); }
      else out.push({startMs: k ? tl(a) : pc.startMs, endMs, ids: [c.id], src: c.src, shot});
    });
  });
  return out.map(({startMs, endMs, ids}) => ({startMs, endMs, ids: [...new Set(ids)]}));
}
const takeAt = (takes: Take[], ms: number) => Math.max(0, takes.findIndex((t) => ms < t.endMs));

// ---- what is on screen: every face at a timeline ms, % of the 1080×1920 frame ----
export type Rect = {left: number; top: number; right: number; bottom: number};
const FW = 1080, FH = 1920;
const FULL: Rect = {left: 0, top: 0, right: 100, bottom: 100};
const rectOf = (b: Box): Rect => ({left: b.left, top: b.top, right: b.left + b.width, bottom: b.top + b.height});
const clipTo = (a: Rect, b: Rect): Rect | null => { const r = {left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom)}; return r.right > r.left && r.bottom > r.top ? r : null; };
// A CSS transform as the composition draws it, in frame px: p' = o + M·(p − o) + t, o an origin as fractions of ref
type M2 = [number, number, number, number]; // [a, b, c, d]: x' = a x + b y, y' = c x + d y
type Aff = {m: M2; tx: number; ty: number};
const W_ = (r: Rect) => ((r.right - r.left) / 100) * FW, H_ = (r: Rect) => ((r.bottom - r.top) / 100) * FH;
const about = (m: M2, ox: number, oy: number, ref: Rect, t: [number, number] = [0, 0]): Aff => {
  const cx = (ref.left / 100) * FW + ox * W_(ref), cy = (ref.top / 100) * FH + oy * H_(ref);
  return {m, tx: cx - m[0] * cx - m[1] * cy + t[0], ty: cy - m[2] * cx - m[3] * cy + t[1]};
};
const scaleAt = (s: number, ox: number, oy: number, ref: Rect) => about([s, 0, 0, s], ox, oy, ref);
const moveBy = (dx: number, dy: number, ref: Rect) => about([1, 0, 0, 1], 0, 0, ref, [(dx / 100) * W_(ref), (dy / 100) * H_(ref)]);
const rot = (deg: number): M2 => { const r = (deg * Math.PI) / 180; return [Math.cos(r), -Math.sin(r), Math.sin(r), Math.cos(r)]; };
const mul = (A: M2, B: M2): M2 => [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3]];
// a box through the steps (innermost first): the box around its four corners
const through = (r: Rect, steps: Aff[]): Rect => {
  const pts = [[r.left, r.top], [r.right, r.top], [r.left, r.bottom], [r.right, r.bottom]].map(([x, y]) => steps.reduce(([px, py], s) => [s.m[0] * px + s.m[1] * py + s.tx, s.m[2] * px + s.m[3] * py + s.ty], [(x / 100) * FW, (y / 100) * FH]));
  const xs = pts.map((p) => (p[0] / FW) * 100), ys = pts.map((p) => (p[1] / FH) * 100);
  return {left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys)};
};
// a face of a source of aspect w/h drawn object-fit: cover into r
function cover(f: FaceBox, aspect: number, r: Rect): Rect {
  const rw = W_(r), rh = H_(r), k = Math.max(rw / aspect, rh), ox = (rw - aspect * k) / 2, oy = (rh - k) / 2;
  const X = (x: number) => r.left + ((ox + x * aspect * k) / FW) * 100, Y = (y: number) => r.top + ((oy + y * k) / FH) * 100;
  return {left: X(f.left), top: Y(f.top), right: X(f.right), bottom: Y(f.bottom)};
}
const aspectOf = (s: FaceScan | null | undefined) => (s?.width && s?.height ? s.width / s.height : FW / FH);
const PULL_Y = PULL_ORIGIN_Y / 100;
// a clip's transition into its own frame (ClipMedia): `spin smear translateX(dx) scale(s)` about 50 % 38 % — the
// whipDiag's smear is a stretch along its angle (rotate θ, scaleX 1 + blur/36, rotate −θ)
const enterSteps = (fx: ReturnType<typeof transitionFx>, r: Rect, full = true): Aff[] => {
  const moving = fx.scale !== 1 || fx.dx !== 0 || fx.blur > 0 || !!fx.spin;
  if (!moving) return [];
  const smear = full && fx.angle != null && fx.blur > 0.2 ? [about(mul(mul(rot(fx.angle), [1 + fx.blur / 36, 0, 0, 1]), rot(-fx.angle)), 0.5, PULL_Y, r)] : [];
  return [scaleAt(fx.scale, 0.5, PULL_Y, r), moveBy(fx.dx, 0, r), ...smear, ...(full && fx.spin ? [about(rot(fx.spin), 0.5, PULL_Y, r)] : [])];
};

type Proj = {clips: Clip[]; captions?: Caption[]; brolls?: BrollItem[]; graphics?: Graphic[]; captionStyle?: string};
// The faces on screen at timeline ms, through the same geometry the composition draws (MultiClipVideo, ClipMedia,
// Broll, LayoutStage): the clip's source object-fit into the frame — or into a layout's video box (its window bar
// off) —, its entry transition's punch / zoom / whip / smear / spin (transitionFx), its keyframes (set_keyframes), the
// focus pull, hero punch and a title's camera push (pullAt); every B-roll cue on screen through its box, its arrival
// and exit, its size and a card's rise (brollMotion), its own entry. A clip's face under an opaque B-roll box is not
// shown. ponytail: a layout's entry, a reveal's pre-roll, a carousel's side panels and a cue's opacity ramp are left
// out (fractions of a second at a cut); remote (stock) B-roll has no scan
export function screenFaces(p: Proj, scans: Scans, fps: number): (ms: number) => Rect[] {
  const placed = placeClips(p.clips, fps);
  const {preset, focus, punch, pulses, zooms, projectedGraphics} = captionLayout({...p, captionsOff: false}, fps);
  const pack = packOf(p.captionStyle);
  const brolls = projectBrolls(p.brolls ?? [], p.clips, fps);
  const cards = brolls.filter((b) => b.mode === 'card').map((b) => ({startMs: b.startMs, endMs: b.endMs}));
  const layouts = projectedGraphics.filter((g) => g.template === 'layout');
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
      // Broll.tsx: the box `translate(dx, dy) scale(S) translateY(cardY)` (about its centre, an inset its top right corner), in the B-roll's focus pull
      const outer = [moveBy(0, (mo.cardY / H_(box)) * 100, box), scaleAt(mo.scale, inset ? 1 : 0.5, inset ? 0 : 0.5, box), moveBy(mo.dx, mo.dy, box), scaleAt(bPull, 0.5, PULL_Y, FULL)];
      const fx = b.enter && b.enter !== 'cut' ? transitionFx({id: b.id, src: b.src, inSec: 0, outSec: 0, sourceDurationSec: 0, enter: b.enter}, f, 1e6, undefined, fps) : null;
      const shown = clipTo(through(box, outer), FULL);
      if (!shown) continue;
      if (mo.opacity >= 0.999) opaque.push(shown);
      const scan = /^https?:/i.test(b.src) ? null : scans[b.src];
      for (const face of facesIn(scan, (ms - b.startMs) / 1000)) {
        const m = clipTo(through(cover(face, aspectOf(scan), box), [...(fx ? enterSteps(fx, box, false) : []), ...outer]), shown);
        if (m) out.push(m);
      }
    }
    const i = placed.findIndex((x) => ms >= x.startMs && ms < x.endMs);
    if (i >= 0) {
      const pc = placed[i], c = pc.clip, t = c.inSec + ((ms - pc.startMs) / 1000) * (c.speed ?? 1);
      const fx = transitionFx(c, frame - pc.fromFrame, pc.durFrames, placed[i + 1]?.clip, fps), kf = sampleTransform(c.transform, t);
      const pull = pullAt(frame, fps, {spans: [...focus, ...cards], blurPx: preset.focusPull || 18, opening: preset.opening, punch, pulses, zooms}).scale;
      // ClipMedia: the transition's div inside the keyframes' `translate(x, y) scale(s)` (about its centre), in the focus pull
      const steps = [...enterSteps(fx, r), scaleAt(kf.scale, 0.5, 0.5, r), moveBy(kf.x, kf.y, r), scaleAt(pull, 0.5, PULL_Y, r)];
      for (const face of facesIn(scans[c.src], t)) {
        const m = clipTo(through(cover(face, aspectOf(scans[c.src]), r), steps), r);
        if (m && !opaque.some((o) => m.left >= o.left && m.right <= o.right && m.top >= o.top && m.bottom <= o.bottom)) out.push(m);
      }
    }
    return out;
  };
}

// ---- the rule: a page's ink band against a face ----
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
// the ink band [top, top + h] × x meets face f: within FACE_MARGIN of its box, or of its head above it
export const meets = (top: number, h: number, x: [number, number], f: Rect) =>
  f.left - FACE_MARGIN < x[1] && x[0] < f.right + FACE_MARGIN && f.top - Math.max(FACE_MARGIN, HAIR * (f.bottom - f.top)) < top + h && top < f.bottom + FACE_MARGIN;

// ---- the search: one position for one span ----
// a moment of a span: the faces then, and the ink of the page up then (its own lines: a short page is not the tallest)
type Block = {h: number; w: number; up: number};
type Moment = {ms: number; faces: Rect[]; b: Block};
// the span: its pages, the pack's position, the ink of all of them over one top (the largest rise over it + the largest
// drop under it), every moment, and per page what avoidGraphics measures against the text graphics up with it
type Group = {idx: number[]; home: {top: number; align: string; slot: number | null}; h: number; w: number; up: number; moments: Moment[]; gfx: {up: number; below: number; blocks: {band: Band}[]}[]};
type Choice = {top: number; slot?: number; cost: number; dist: number; gfx: boolean};
const r1 = (t: number) => Math.round(t * 10) / 10;
function search(g: Group, shift: number, preset: Preset, float: boolean): Choice {
  const {home, h, up} = g;
  // each moment by the page on screen then; the graphics by each page's ink and avoidGraphics' estimate, whichever is larger
  const costOf = (top: number, align: string) => g.moments.filter((m) => { const x = spanOf(preset, m.b.w, align, float); return m.faces.some((f) => meets(top - m.b.up, m.b.h, x, f)); }).length;
  const gfxOk = (top: number) => g.gfx.every((p) => !p.blocks.some((b) => overlap({top: top - p.up, bottom: top + p.below}, b.band)));
  const safe = (top: number) => top >= SAFE.topPct - 1e-9 && top - up + h <= SAFE.bottomPct + 1e-9;
  // every top where the cost or the graphics can change: the pack's, the reach's ends, a face's edges against the page
  // up then, a graphic's edges (avoidGraphics' own 2 % steps and flush) — rounded outwards, so rounding never eats the margin
  const edges = [home.top, home.top - shift, home.top + shift, SAFE.topPct, SAFE.bottomPct - h + up,
    ...g.moments.flatMap((m) => m.faces.flatMap((f) => [Math.ceil((f.bottom + FACE_MARGIN + m.b.up) * 10) / 10, Math.floor((f.top - Math.max(FACE_MARGIN, HAIR * (f.bottom - f.top)) - m.b.h + m.b.up) * 10) / 10])),
    ...g.gfx.flatMap((p) => p.blocks.flatMap((b) => [b.band.bottom + 2 + p.up, b.band.bottom + p.up, b.band.top - 2 - p.below, b.band.top - p.below]))].map(r1);
  const tops = [...new Set(edges)];
  const choice = (top: number, align: string, slot?: number): Choice => ({top, ...(slot != null ? {slot} : {}), cost: costOf(top, align), dist: Math.abs(top - home.top), gfx: gfxOk(top)});
  const own = tops.filter((t) => t === home.top || (Math.abs(t - home.top) <= shift + 1e-9 && safe(t))).map((t) => choice(t, home.align, home.slot ?? undefined));
  // a floating page may take another corner within the reach
  const corners = float && shift > 0 ? FLOAT_SLOTS.map((s, j) => ({s, j})).filter(({s, j}) => j !== home.slot && Math.abs(s.top - home.top) <= shift + 1e-9).map(({s, j}) => choice(s.top, s.align, j)) : [];
  const best = (xs: Choice[]) => xs.sort((a, b) => a.cost - b.cost || a.dist - b.dist)[0];
  const inReach = [...own, ...corners];
  // the graphics first (the render would move a page off one anyway): in reach, else where avoidGraphics would take it
  return best(inReach.filter((c) => c.gfx)) ?? best(tops.filter(safe).map((t) => choice(t, home.align, home.slot ?? undefined)).filter((c) => c.gfx)) ?? best(inReach);
}

// Every page as the renderer lists it (none under an end card), grouped into the spans that hold one position — by
// page, take or reel, joined where one stored page shows twice — and, in a floating pack, by the corner it cycles to
function plan(p: Proj & Knobs, scans: Scans, fps: number, hold: FaceHold) {
  const preset = presetOf(p.captionStyle), float = preset.position === 'float', n = FLOAT_SLOTS.length;
  const gfx = projectGraphics(p.graphics ?? [], p.clips, fps);
  const shown = hideUnder(projectCaptions(p.captions ?? [], p.clips, fps), gfx.filter((g) => g.template === 'end-card'));
  const pinned = new Set((p.captions ?? []).filter((c) => c.pin).map((c) => c.id));
  const facesAt = screenFaces(p, scans, fps), takes = takesOf(p.clips, scans, fps), blockers = textBlockers(gfx);
  const span = shown.map((c, i) => (hold === 'pagina' ? i : hold === 'video' ? 0 : takeAt(takes, c.startMs)));
  const root = new Map<number, number>();
  const find = (k: number): number => { const r = root.get(k) ?? k; return r === k ? k : find(r); };
  const firstOf = new Map<string, number>();
  shown.forEach((c, i) => { const j = firstOf.get(c.id); if (j == null) firstOf.set(c.id, i); else if (find(span[i]) !== find(span[j])) root.set(find(span[i]), find(span[j])); });
  const keyed = new Map<string, number[]>();
  shown.forEach((c, i) => {
    if (pinned.has(c.id)) return;
    const k = `${find(span[i])}|${float ? firstOf.get(c.id)! % n : 'a'}`;
    keyed.set(k, [...(keyed.get(k) ?? []), i]);
  });
  const groups: Group[] = [...keyed].map(([k, idx]) => {
    const slot = float ? Number(k.split('|')[1]) : null;
    const blocks = idx.map((i) => captionBlock(shown[i], preset, float));
    const up = Math.max(...blocks.map((b) => b.up)), below = Math.max(...blocks.map((b) => b.h - b.up));
    return {idx, home: slot != null ? {...FLOAT_SLOTS[slot], slot} : {top: preset.layout.topPct ?? DEFAULT_TOP, align: 'center', slot: null},
      h: up + below, w: Math.max(...blocks.map((b) => b.w)), up,
      moments: idx.flatMap((i, k) => timesOf(shown, i, preset.holdMs).map((ms) => ({ms, faces: facesAt(ms), b: blocks[k]}))),
      // a page against the text graphics up with it: its ink, and what avoidGraphics measures it by (placeBand:
      // characters, never a font) — clear of both, the render moves nothing
      gfx: idx.map((i, k) => { const c = shown[i], b = placeBand(c, p.captionStyle, i); return {up: blocks[k].up, below: Math.max(b.bottom - b.top, blocks[k].h - blocks[k].up), blocks: blockers.filter(({g}) => c.startMs < g.endMs && g.startMs < c.endMs)}; })};
  });
  return {preset, float, shown, groups, facesAt, takes, pinned};
}

// Every page's position clear of the faces of its span (see the head of this file). Returns the project's captions:
// non-pinned pages on screen get their top (a floating page its corner too, `slot`, when moved); the words are never
// touched — changing faceShift / faceHold re-places without re-paging.
export function placeCaptions(p: Proj & Knobs, scans: Scans, fps: number): Caption[] {
  const caps = p.captions ?? [];
  if (!caps.length || !p.clips.length) return caps;
  const {shift, hold} = faceKnobs(p);
  const {preset, float, shown, groups} = plan(p, scans, fps, hold);
  const at = new Map<string, {top: number; slot?: number}>();
  for (const g of groups) { const c = search(g, shift, preset, float); for (const i of g.idx) at.set(shown[i].id, {top: c.top, ...(c.slot != null && c.slot !== g.home.slot || (c.slot != null && c.top !== g.home.top) ? {slot: c.slot} : {})}); }
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
      if (!meets(band.top, band.bottom - band.top, x, f)) continue;
      out.push({i, ms, face: f, top: band.top, bottom: band.bottom, x, area: Math.max(0, Math.min(x[1], f.right) - Math.max(x[0], f.left)) * Math.max(0, Math.min(band.bottom, f.bottom) - Math.max(band.top, f.top))});
    }
  });
  return out;
}
const pct = (x: number) => Math.round(x);
const s1 = (ms: number) => (ms / 1000).toFixed(1);
// One warning per take whose captions meet a face at some moment: its clips, its pages, the worst moment, and the fix
// the placement's own search finds for the spans those pages hold with — where the pages are now and for how long they
// cover, the reach that clears them, or, when nothing in the safe zone does, the reach of the least covered top. And one
// per span whose pages sit at more than one position (the take changed after they were placed: a sync, a cut, a
// transition): a span holds one, so they are re-placed
export function captionFaceIssues(p: Proj & Knobs & {captionsOff?: boolean}, scans: Scans, fps: number): Issue[] {
  if (p.captionsOff || !p.captions?.length) return [];
  const {shownCaptions: pages} = captionLayout(p, fps);
  const {shift, hold} = faceKnobs(p);
  const {preset, float, shown, groups, facesAt, takes, pinned} = plan(p, scans, fps, hold);
  const where = (i: number) => (float ? floatSlot(shown[i], i) : {top: shown[i].topPct, align: 'center'});
  const span = hold === 'toma' ? 'take' : hold === 'video' ? 'reel' : 'page';
  const byTake = new Map<number, Hit[]>();
  for (const h of captionHits(pages, p.captionStyle, facesAt)) { const k = takeAt(takes, pages[h.i].startMs); byTake.set(k, [...(byTake.get(k) ?? []), h]); }
  const covering = [...byTake].map(([k, hits]) => {
    const take = takes[k], worst = hits.reduce((a, b) => (b.area > a.area ? b : a)), ids = [...new Set(hits.map((h) => pages[h.i].id))];
    const covered = new Set(hits.map((h) => `${h.i}:${h.ms}`)).size * STEP_MS;
    const byHand = ids.filter((id) => pinned.has(id));
    const mine = groups.filter((g) => g.idx.some((i) => hits.some((h) => h.i === i)));
    const now = mine.map((g) => search(g, shift, preset, float)), all = mine.map((g) => search(g, MAX_SHIFT, preset, float));
    const reachOf = (cs: Choice[]) => Math.ceil(Math.max(0, ...cs.map((c) => c.dist)) - 1e-9);
    const kept = `kept at ${[...new Set(mine.map((g) => `${where(g.idx[0]).top} %`))].join(' / ')}, covering for ${s1(covered)} s`;
    const better = all.filter((c, j) => c.cost < now[j].cost);
    const it = (n: number) => `${n > 1 ? 'them' : 'it'}`;
    const reach = byHand.length === ids.length ? `${byHand.join(', ')} ${byHand.length > 1 ? 'were' : 'was'} placed by hand: move ${it(byHand.length)} (edit_caption top_pct) or leave ${it(byHand.length)}`
      : now.length && now.every((c) => c.cost === 0) ? `the ${span}'s placement is out of date — a clear position is within ±${shift} %: re-place the captions (set_captions face_shift ${shift})`
      : all.every((c) => c.cost === 0) ? `no position within ±${shift} % clears it (${kept}); ±${reachOf(all)} % would: set_captions face_shift ${reachOf(all)}`
      : `no position inside the safe zone clears it (${kept})${better.length ? `; the least covered, at ${[...new Set(better.map((c) => `${c.top} %`))].join(' / ')} (${better.some((c) => c.cost) ? `${s1(better.reduce((n, c) => n + c.cost, 0) * STEP_MS)} s` : 'clear'}), is ±${reachOf(better)} % away: set_captions face_shift ${reachOf(better)}` : ''}`;
    return {level: 'warn' as const, code: 'caption-face', ref: ids[0],
      msg: `captions ${ids.join(', ')} on the take ${take?.ids.join(' + ') ?? '?'} (${s1(take?.startMs ?? 0)}–${s1(take?.endMs ?? 0)} s) cover a face for ${s1(covered)} s — worst at ${s1(worst.ms)} s: face ${pct(worst.face.top)}–${pct(worst.face.bottom)} %, captions ${pct(worst.top)}–${pct(worst.bottom)} % of the height. Fix: ${reach}; or fewer lines (edit_caption starts_at_wid), a smaller size (edit_caption scale), a B-roll over the face (add_broll), or a position by hand (edit_caption top_pct)`};
  });
  const mixed = groups.flatMap((g) => {
    const at = [...new Set(g.idx.map((i) => { const w = where(i); return `${w.top} %${float ? ` ${w.align}` : ''}`; }))];
    if (at.length < 2) return [];
    const ids = [...new Set(g.idx.map((i) => shown[i].id))], take = takes[takeAt(takes, shown[g.idx[0]].startMs)];
    return [{level: 'warn' as const, code: 'caption-face-mixed', ref: ids[0],
      msg: `captions ${ids.join(', ')} ${span === 'take' ? `on the take ${take?.ids.join(' + ') ?? '?'} (${s1(take?.startMs ?? 0)}–${s1(take?.endMs ?? 0)} s)` : span === 'reel' ? 'of the reel' : ''} sit at ${at.length} positions (${at.join(', ')}) where the ${span} holds one — the ${span}s changed after they were placed (a sync, a cut, a transition): re-place them (set_captions face_shift ${shift})`}];
  });
  return [...covering, ...mixed];
}
