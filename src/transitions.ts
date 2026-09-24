// Transitions INTO a clip (the cut from the previous one). Pure: the renderer
// asks for the extra transform of a clip at a frame.
//   punch — the whole clip sits 12 % closer (hides a jump cut; alternate them)
//   zoom  — eases 1.04 → 1.12 over the first 8 frames with a short blur
//   whip  — the previous clip slides out left and this one slides in, motion-blurred (5 + 5 frames);
//           both scale up while they move so the frame edge never shows black
//   whipDiag — Prism Pro's whip: the previous clip smears along a 60° diagonal for 5 frames (no slide),
//           this one lands from 1.3× with the same smear clearing over 8 frames
//   card  — the previous clip shrinks into a rounded card and slides off, revealing this one (8 frames)
//   split — the previous clip breaks into 2×2 tiles that fly to the corners, revealing this one (8 frames)
// card and split need the next clip under the outgoing one: the renderer
// starts it OVERLAP frames early (see MultiClipVideo).
import type {Clip} from './timeline.ts';

export type Enter = NonNullable<Clip['enter']>;
export const ENTERS: Enter[] = ['cut', 'punch', 'zoom', 'whip', 'whipDiag', 'card', 'split'];
export type Fx = {scale: number; dx: number; blur: number; angle?: number; exit?: {type: 'card' | 'split'; t: number}}; // dx in % of the frame width, blur in px, angle = degrees of a directional smear; exit t 0→1
export const OVERLAP = 8; // frames the next clip shows under a card / split exit
export const REVEALS = new Set<Enter>(['card', 'split']);
export const WHOOSH = new Set<Enter>(['whip', 'whipDiag', 'zoom', 'card', 'split']);

const PUNCH = 1.12, ZOOM_F = 8, WHIP_F = 5, WHIP_DX = 18, WHIP_BLUR = 18;
const WHIPD_OUT = 5, WHIPD_IN = 8, WHIPD_BLUR = 18, WHIPD_ANGLE = 60, WHIPD_SCALE = 1.3; // measured: 4 f out + 6 f in at 24 fps
const ease = (t: number) => 1 - (1 - t) ** 3;
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

// frame = frame inside this clip's Sequence; next = the clip after it (for a whip exit)
export function transitionFx(clip: Clip, frame: number, durFrames: number, next?: Clip): Fx {
  let scale = 1, dx = 0, blur = 0, angle: number | undefined;
  if (clip.enter === 'punch') scale = PUNCH;
  if (clip.enter === 'zoom') { const t = ease(clamp01(frame / ZOOM_F)); scale = 1.04 + (PUNCH - 1.04) * t; blur = (1 - t) * 4; }
  if (clip.enter === 'whip' && frame < WHIP_F) { const t = ease(clamp01((frame + 1) / WHIP_F)); dx = WHIP_DX * (1 - t); blur = WHIP_BLUR * (1 - t); }
  if (next?.enter === 'whip' && frame >= durFrames - WHIP_F) { const t = clamp01((frame - (durFrames - WHIP_F) + 1) / WHIP_F); dx = -WHIP_DX * t * t; blur = Math.max(blur, WHIP_BLUR * t); }
  // whipDiag: the smear grows linearly on the way out and clears linearly on the way in; only the landing scale eases
  if (clip.enter === 'whipDiag' && frame < WHIPD_IN) { const t = clamp01((frame + 1) / WHIPD_IN); blur = WHIPD_BLUR * (1 - t); scale = 1 + (WHIPD_SCALE - 1) * (1 - ease(t)); angle = WHIPD_ANGLE; }
  if (next?.enter === 'whipDiag' && frame >= durFrames - WHIPD_OUT) { const t = clamp01((frame - (durFrames - WHIPD_OUT) + 1) / WHIPD_OUT); blur = Math.max(blur, WHIPD_BLUR * t); angle = WHIPD_ANGLE; }
  if (dx) scale = Math.max(scale, 1 + (2 * Math.abs(dx)) / 100); // cover the edge it moves away from
  if (blur) scale = Math.max(scale, 1 + blur * 0.012); // a blurred edge turns see-through: push it off frame
  const fx: Fx = angle == null ? {scale, dx, blur} : {scale, dx, blur, angle};
  if (next && REVEALS.has(next.enter as Enter) && frame >= durFrames - OVERLAP) {
    return {...fx, exit: {type: next.enter as 'card' | 'split', t: clamp01((frame - (durFrames - OVERLAP) + 1) / OVERLAP)}}; // linear; the renderer eases each stage
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
