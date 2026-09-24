// Transitions INTO a clip (the cut from the previous one). Pure: the renderer
// asks for the extra transform of a clip at a frame.
//   punch — the whole clip sits 12 % closer (hides a jump cut; alternate them)
//   zoom  — eases 1.04 → 1.12 over the first 8 frames with a short blur
//   whip  — the previous clip slides out left and this one slides in, motion-blurred (5 + 5 frames);
//           both scale up while they move so the frame edge never shows black
import type {Clip} from './timeline.ts';

export type Enter = NonNullable<Clip['enter']>;
export const ENTERS: Enter[] = ['cut', 'punch', 'zoom', 'whip'];
export type Fx = {scale: number; dx: number; blur: number}; // dx in % of the frame width, blur in px

const PUNCH = 1.12, ZOOM_F = 8, WHIP_F = 5, WHIP_DX = 18, WHIP_BLUR = 18;
const ease = (t: number) => 1 - (1 - t) ** 3;
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

// frame = frame inside this clip's Sequence; next = the clip after it (for a whip exit)
export function transitionFx(clip: Clip, frame: number, durFrames: number, next?: Clip): Fx {
  let scale = 1, dx = 0, blur = 0;
  if (clip.enter === 'punch') scale = PUNCH;
  if (clip.enter === 'zoom') { const t = ease(clamp01(frame / ZOOM_F)); scale = 1.04 + (PUNCH - 1.04) * t; blur = (1 - t) * 4; }
  if (clip.enter === 'whip' && frame < WHIP_F) { const t = ease(clamp01((frame + 1) / WHIP_F)); dx = WHIP_DX * (1 - t); blur = WHIP_BLUR * (1 - t); }
  if (next?.enter === 'whip' && frame >= durFrames - WHIP_F) { const t = clamp01((frame - (durFrames - WHIP_F) + 1) / WHIP_F); dx = -WHIP_DX * t * t; blur = Math.max(blur, WHIP_BLUR * t); }
  if (dx) scale = Math.max(scale, 1 + (2 * Math.abs(dx)) / 100); // cover the edge it moves away from
  if (blur) scale = Math.max(scale, 1 + blur * 0.012); // a blurred edge turns see-through: push it off frame
  return {scale, dx, blur};
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
