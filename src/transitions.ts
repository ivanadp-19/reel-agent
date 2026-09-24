// Transitions INTO a clip (the cut from the previous one). Pure: the renderer
// asks for the extra transform of a clip at a frame, the cover shapes drawn
// over the cut, or the mask the outgoing clip keeps.
//   punch — the whole clip sits 12 % closer (hides a jump cut; alternate them)
//   zoom  — eases 1.04 → 1.12 over the first 8 frames with a short blur
//   whip  — the previous clip slides out left and this one slides in, motion-blurred (5 + 5 frames);
//           both scale up while they move so the frame edge never shows black
//   whipDiag — Prism Pro's whip: the previous clip smears along a 60° diagonal for 5 frames (no slide),
//           this one lands from 1.3× with the same smear clearing over 8 frames
//   card  — the previous clip shrinks into a rounded card and slides off, revealing this one (8 frames)
//   split — the previous clip breaks into 2×2 tiles that fly to the corners, revealing this one (8 frames)
// The Captions.ai pack (research/captions-ai-motion.md, Parte 2 C), timed in ms from the previews:
//   cover kinds draw shapes over the cut (COVER): flash, spin (+ flash), rgbFlash (+ flash), bands, clock,
//     mosaic, disc, blinds, lightLeak
//   reveal kinds mask the outgoing clip away over the incoming one (REVEALS): crossBlur, polyWipe,
//     diagWipe, particles, blocks — plus card and split
//   cardDrop lands the incoming clip on top, falling and rotating (OVER)
import type {Clip} from './timeline.ts';

export type Enter = 'cut' | 'punch' | 'zoom' | 'whip' | 'whipDiag' | 'card' | 'split'
  | 'flash' | 'crossBlur' | 'spin' | 'rgbFlash' | 'bands' | 'polyWipe' | 'clock' | 'mosaic' | 'disc' | 'blinds' | 'particles' | 'diagWipe' | 'blocks' | 'cardDrop' | 'lightLeak';
export const ENTERS: Enter[] = ['cut', 'punch', 'zoom', 'whip', 'whipDiag', 'card', 'split', 'flash', 'crossBlur', 'spin', 'rgbFlash', 'bands', 'polyWipe', 'clock', 'mosaic', 'disc', 'blinds', 'particles', 'diagWipe', 'blocks', 'cardDrop', 'lightLeak'];
export type Exit = {type: 'card' | 'split' | 'fade' | 'shrink' | 'mask'; t: number; clipPath?: string}; // t 0→1 over the overlap
export type Fx = {scale: number; dx: number; blur: number; angle?: number; spin?: number; rgb?: number; drop?: number; exit?: Exit}; // dx % of width, blur px, angle deg of a smear, spin deg, rgb px of channel split, drop 0→1 of a card landing
export const OVERLAP = 8; // frames the next clip shows under a card / split exit (30 fps)
export const REVEALS = new Set<Enter>(['card', 'split', 'crossBlur', 'polyWipe', 'diagWipe', 'particles', 'blocks']);
export const OVER = new Set<Enter>(['cardDrop']);
export const COVER = new Set<Enter>(['flash', 'spin', 'rgbFlash', 'bands', 'polyWipe', 'clock', 'mosaic', 'disc', 'blinds', 'lightLeak']);
export const WHOOSH = new Set<Enter>(['whip', 'whipDiag', 'zoom', 'card', 'split', 'spin', 'blinds', 'polyWipe', 'diagWipe']);
// whole transition in ms, centred on the cut (measured on the previews; card/split keep their 8 frames)
export const DUR_MS: Partial<Record<Enter, number>> = {card: 267, split: 267, flash: 250, crossBlur: 210, spin: 333, rgbFlash: 333, bands: 667, polyWipe: 290, clock: 833, mosaic: 667, disc: 500, blinds: 625, particles: 290, diagWipe: 583, blocks: 500, cardDrop: 210, lightLeak: 400};
export const overlapOf = (kind: Enter | undefined, fps: number) => (kind && (REVEALS.has(kind) || OVER.has(kind)) ? (kind === 'card' || kind === 'split' ? OVERLAP : Math.max(2, Math.round((fps * (DUR_MS[kind] ?? 267)) / 1000))) : 0);

const PUNCH = 1.12, ZOOM_F = 8, WHIP_F = 5, WHIP_DX = 18, WHIP_BLUR = 18;
const WHIPD_OUT = 5, WHIPD_IN = 8, WHIPD_BLUR = 18, WHIPD_ANGLE = 60, WHIPD_SCALE = 1.3; // measured: 4 f out + 6 f in at 24 fps
const ease = (t: number) => 1 - (1 - t) ** 3;
const easeIn = (t: number) => t * t * t;
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const fr = (fps: number, ms: number) => Math.max(1, Math.round((fps * ms) / 1000));

// frame = frame inside this clip's Sequence (negative while it pre-rolls under or over the outgoing one);
// next = the clip after it (for its exit)
export function transitionFx(clip: Clip, frame: number, durFrames: number, next?: Clip, fps = 30): Fx {
  let scale = 1, dx = 0, blur = 0, angle: number | undefined, spin: number | undefined, rgb: number | undefined, drop: number | undefined;
  const k = clip.enter;
  if (k === 'punch') scale = PUNCH;
  if (k === 'zoom') { const t = ease(clamp01(frame / ZOOM_F)); scale = 1.04 + (PUNCH - 1.04) * t; blur = (1 - t) * 4; }
  if (k === 'whip' && frame < WHIP_F) { const t = ease(clamp01((frame + 1) / WHIP_F)); dx = WHIP_DX * (1 - t); blur = WHIP_BLUR * (1 - t); }
  if (next?.enter === 'whip' && frame >= durFrames - WHIP_F) { const t = clamp01((frame - (durFrames - WHIP_F) + 1) / WHIP_F); dx = -WHIP_DX * t * t; blur = Math.max(blur, WHIP_BLUR * t); }
  // whipDiag: the smear grows linearly on the way out and clears linearly on the way in; only the landing scale eases
  if (k === 'whipDiag' && frame < WHIPD_IN) { const t = clamp01((frame + 1) / WHIPD_IN); blur = WHIPD_BLUR * (1 - t); scale = 1 + (WHIPD_SCALE - 1) * (1 - ease(t)); angle = WHIPD_ANGLE; }
  if (next?.enter === 'whipDiag' && frame >= durFrames - WHIPD_OUT) { const t = clamp01((frame - (durFrames - WHIPD_OUT) + 1) / WHIPD_OUT); blur = Math.max(blur, WHIPD_BLUR * t); angle = WHIPD_ANGLE; }
  // the pack: incoming side. Reveal / over kinds run during the pre-roll (negative frames) and are done at the cut.
  if (k === 'crossBlur') { const n = overlapOf(k, fps); const t = clamp01((frame + n) / n); blur = 30 * (1 - t); }
  if (k === 'spin') { const n = fr(fps, 167); const t = ease(clamp01((frame + 1) / n)); spin = 8 * (1 - t); blur = 20 * (1 - t); }
  if (k === 'rgbFlash') { const n = fr(fps, 167); const t = ease(clamp01((frame + 1) / n)); rgb = 6 * (1 - t); blur = 20 * (1 - t); }
  if (k === 'blinds') { const n = fr(fps, 210); const t = ease(clamp01((frame + 1) / n)); blur = 18 * (1 - t); angle = 0; }
  if (k === 'cardDrop') { const n = overlapOf(k, fps); drop = ease(clamp01((frame + n) / n)); }
  if (dx) scale = Math.max(scale, 1 + (2 * Math.abs(dx)) / 100); // cover the edge it moves away from
  if (blur && angle == null && k !== 'crossBlur' && k !== 'spin' && k !== 'rgbFlash') scale = Math.max(scale, 1 + blur * 0.012); // a blurred edge turns see-through: push it off frame
  // outgoing side of the pack: spin / rgbFlash smear the last frames before the flash
  if (next?.enter === 'spin') { const n = fr(fps, 167); if (frame >= durFrames - n) { const t = clamp01((frame - (durFrames - n) + 1) / n); spin = -8 * t; blur = Math.max(blur, 20 * t); } }
  if (next?.enter === 'rgbFlash') { const n = fr(fps, 125); if (frame >= durFrames - n) { const t = clamp01((frame - (durFrames - n) + 1) / n); rgb = 6 * t; blur = Math.max(blur, 20 * t); } }
  const fx: Fx = {scale, dx, blur};
  if (angle != null) fx.angle = angle;
  if (spin != null) fx.spin = spin;
  if (rgb != null) fx.rgb = rgb;
  if (drop != null) fx.drop = drop;
  const nk = next?.enter as Enter | undefined;
  const n = overlapOf(nk, fps);
  if (nk && n && frame >= durFrames - n) {
    const t = clamp01((frame - (durFrames - n) + 1) / n); // linear; the renderer eases each stage
    if (nk === 'card' || nk === 'split') fx.exit = {type: nk, t};
    else if (nk === 'crossBlur') fx.exit = {type: 'fade', t};
    else if (nk === 'cardDrop') fx.exit = {type: 'shrink', t};
    else fx.exit = {type: 'mask', t, clipPath: exitMask(nk, t, seedOf(next!.id)) ?? 'polygon(0 0, 0 0, 0 0)'};
  }
  return fx;
}

// a stepped speed ramp: the clip becomes `steps` pieces whose speeds ease from
// `from` to `to` (Remotion cannot change a video's rate inside one sequence)
export function speedRamp(from: number, to: number, steps: number): number[] {
  const n = Math.max(2, Math.min(6, Math.round(steps)));
  return Array.from({length: n}, (_, i) => +(from + (to - from) * ease((i + 1) / n)).toFixed(2));
}

// punch in on every other jump cut inside the same take (a new source resets it)
export function punchAlternate(clips: Clip[]): Clip[] {
  let on = false;
  return clips.map((c, i) => {
    const prev = clips[i - 1];
    if (!prev || prev.src !== c.src) { on = false; return {...c, enter: undefined}; }
    on = !on;
    return {...c, enter: on ? 'punch' : 'cut'};
  });
}

// ---- geometry (all in % of the frame) ----
export type P = [number, number];
const SQUARE: P[] = [[0, 0], [100, 0], [100, 100], [0, 100]];
// Sutherland–Hodgman against one half-plane: keeps a·x + b·y ≤ c
export function clipPoly(polyPts: P[], a: number, b: number, c: number): P[] {
  const out: P[] = [];
  const f = (p: P) => a * p[0] + b * p[1] - c;
  for (let i = 0; i < polyPts.length; i++) {
    const p = polyPts[i], q = polyPts[(i + 1) % polyPts.length];
    const fp = f(p), fq = f(q);
    if (fp <= 1e-9) out.push(p);
    if ((fp <= 1e-9) !== (fq <= 1e-9)) { const t = fp / (fp - fq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
  }
  // drop the duplicate a vertex on the line produces
  return out.filter((p, i) => { const q = out[(i + 1) % out.length]; return Math.abs(p[0] - q[0]) > 1e-6 || Math.abs(p[1] - q[1]) > 1e-6; });
}
const poly = (pts: P[]) => (pts.length < 3 ? null : `polygon(${pts.map(([x, y]) => `${x.toFixed(2)}% ${y.toFixed(2)}%`).join(', ')})`);
const rect = (top: number, left = 0, w = 100, h = 100) => poly([[left, top], [left + w, top], [left + w, top + h], [left, top + h]])!;
// deterministic noise: same seed + index → same number, in any renderer
export const seedOf = (s: string) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return (h >>> 0) % 100000; };
const rand = (seed: number, i: number) => { const x = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453; return x - Math.floor(x); };
const bump = (t: number, c: number, w: number) => Math.max(0, 1 - Math.abs(t - c) / w);

// ---- cover shapes: drawn above footage and B-roll, below captions, around the cut (t 0→1 over DUR_MS) ----
export type Tone = 'accent' | 'deep' | 'dark' | 'white' | 'light';
export type Shape = {clip?: string; tone?: Tone; gradient?: string; opacity?: number; screen?: boolean};
export function coverShapes(kind: Enter, t: number, seed: number): Shape[] {
  switch (kind) {
    case 'flash': return [{tone: 'white', opacity: t < 0.3 ? t / 0.3 : Math.max(0, 1 - (t - 0.3) / 0.7)}];
    case 'spin': return [{tone: 'white', opacity: bump(t, 0.5, 0.2)}];
    case 'rgbFlash': return [{tone: 'white', opacity: bump(t, 0.5, 0.12)}];
    case 'bands': { // three full-height bands stacked, sliding through the frame (up, or down on odd seeds)
      const down = seed % 2 === 1;
      const tones: Tone[] = ['accent', 'deep', 'dark'];
      return tones.map((tone, k) => ({tone, clip: rect(down ? 200 * t - 100 - k * 34 : 100 * (1 - 2 * t) + k * 34)}));
    }
    case 'polyWipe': { // the accent band leading the diagonal edge (the reveal itself is the exit mask)
      const c = 200 * (1 - ease(t));
      const band = clipPoly(clipPoly(SQUARE, 1, 1, c + 4), -1, -1, -(c - 4));
      const p = poly(band); return p ? [{tone: 'accent', clip: p}] : [];
    }
    case 'clock': { // a pie sweeping clockwise from 12: covers over the first half, then uncovers from where it started
      const from = t < 0.5 ? 0 : 720 * (t - 0.5), to = t < 0.5 ? 720 * t : 360;
      if (to - from <= 0.5) return [];
      const pts: P[] = [[50, 50]];
      for (let a = from; a <= to + 1e-6; a += 6) { const r = (a * Math.PI) / 180; pts.push([50 + 160 * Math.sin(r), 50 - 160 * Math.cos(r)]); }
      const r2 = (to * Math.PI) / 180; pts.push([50 + 160 * Math.sin(r2), 50 - 160 * Math.cos(r2)]);
      return [{tone: 'light', clip: poly(pts)!}];
    }
    case 'mosaic': { // 6 × 11 squares that grow from their centres, then shrink, each a touch late
      const out: Shape[] = [];
      for (let i = 0; i < 6; i++) for (let j = 0; j < 11; j++) {
        const d = rand(seed, i * 11 + j) * 0.15;
        const s = t < 0.5 ? clamp01((t - d) / 0.33) : clamp01((1 - t - d) / 0.33);
        if (s <= 0.01) continue;
        const cx = ((i + 0.5) * 100) / 6, cy = ((j + 0.5) * 100) / 11, hw = (s * 50) / 6, hh = (s * 50) / 11;
        out.push({tone: 'light', clip: `inset(${(cy - hh).toFixed(2)}% ${(100 - cx - hw).toFixed(2)}% ${(100 - cy - hh).toFixed(2)}% ${(cx - hw).toFixed(2)}%)`});
      }
      return out;
    }
    case 'disc': { // a disc from outside a corner covers the frame, holds, then retires to the opposite corner
      const tone: Tone = seed % 2 ? 'accent' : 'light';
      if (t < 0.4) return [{tone, clip: `circle(${(200 * ease(t / 0.4)).toFixed(1)}% at 108% 108%)`}];
      if (t <= 0.6) return [{tone, clip: 'circle(200% at 50% 50%)'}];
      const r = 200 * (1 - easeIn((t - 0.6) / 0.4));
      return r < 0.5 ? [] : [{tone, clip: `circle(${r.toFixed(1)}% at -8% -8%)`}];
    }
    case 'blinds': { // five vertical bars of different widths widen to close, hold, then retract
      const ws = Array.from({length: 5}, (_, k) => 0.6 + rand(seed, k) * 0.8);
      const sum = ws.reduce((a, b) => a + b, 0);
      const open = t < 0.4 ? 0.25 + 0.75 * ease(t / 0.4) : t <= 0.6 ? 1 : 1 - ease((t - 0.6) / 0.4);
      if (open <= 0.01) return [];
      let x = 0; const out: Shape[] = [];
      for (const w of ws) { const slot = (w / sum) * 100; out.push({tone: 'accent', clip: rect(0, x, slot * open, 100)}); x += slot; }
      return out;
    }
    case 'lightLeak': return [
      {gradient: 'radial-gradient(60% 45% at 70% 20%, rgba(255,190,80,0.95), rgba(255,120,40,0.4) 40%, transparent 70%)', screen: true, opacity: bump(t, 0.5, 0.35)},
      {gradient: 'radial-gradient(45% 35% at 25% 80%, rgba(255,110,170,0.85), transparent 65%)', screen: true, opacity: bump(t, 0.55, 0.3)},
    ];
    default: return [];
  }
}

// ---- exit masks: what the outgoing clip still shows while the incoming one waits underneath (t 0→1) ----
export function exitMask(kind: Enter, t: number, seed: number): string | null {
  switch (kind) {
    case 'polyWipe': return poly(clipPoly(SQUARE, 1, 1, 200 * (1 - ease(t)) - 4)); // diagonal from bottom-right to top-left
    case 'diagWipe': { const k = -40 + 140 * (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)); return poly(clipPoly(SQUARE, 0.36, -1, -k)); } // a ~20° edge coming down from the top-left
    case 'particles': { // a jagged frontier eating the clip from the left
      const X = 112 * t - 6;
      const pts: P[] = [[100, 0], [100, 100]];
      for (let m = 24; m >= 0; m--) pts.push([X + (rand(seed, m) - 0.5) * 12, (m * 100) / 24]);
      return poly(clipPoly(pts, -1, 0, 0).length ? pts : pts);
    }
    case 'blocks': { // the incoming rises from the bottom with a stepped top edge that re-rolls every few frames
      const step = Math.floor(t * 8);
      const pts: P[] = [[0, 0], [100, 0]];
      for (let k = 5; k >= 0; k--) { const h = Math.max(0, 100 * t + (rand(seed, k * 13 + step) - 0.5) * 18); pts.push([((k + 1) * 100) / 6, 100 - h], [(k * 100) / 6, 100 - h]); }
      return poly(pts);
    }
    default: return null;
  }
}
