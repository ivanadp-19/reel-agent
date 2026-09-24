// Motion primitives measured on the Captions.ai previews
// (research/captions-ai-motion.md, Parte 2). Pure functions of the frame: the
// renderers only paint what they return. Reference values were counted in
// frames at 24 fps and are kept here in ms so any project fps works.
import {interpolate, spring, Easing} from 'remotion';

const CLAMP = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const OUT = Easing.out(Easing.cubic);
export const ms = (fps: number, millis: number) => Math.max(1, Math.round((fps * millis) / 1000));

// how a word or a title line arrives
//   cut      1 f (Align, Focus, the plain words of Prism)
//   fade     170 ms with a 6 px rise (Prism, Y2K, Prime, Chalk)
//   ghost    opacity 0.4→1 in 250 ms while a shine crosses the gradient, no scale (Prism key words)
//   blur     100 ms from 15 px (Evo, Bloom, Form pages, Impact hero words)
//   rgb      blur + chromatic split, 125 ms (Impact II)
//   pop      spring 0.7→1 (Stack's red pill, Pop's stickers)
//   drop     falls from above with scale 1.3→1 in 125 ms (Stack's title)
//   slideBlur in from the right with motion blur, 250 ms (Prime's GROWTH)
//   band     rises from below the frame in 170 ms (Focus's title band)
//   slideDown drops in from above the frame in 210 ms, no scale (Orbit's FRIENDS)
//   wipe     a slanted sweep from the left uncovers it in 210 ms (Lift's card title)
export type ArriveKind = 'cut' | 'fade' | 'ghost' | 'blur' | 'rgb' | 'pop' | 'drop' | 'slideBlur' | 'band' | 'slideDown' | 'wipe';
export type Arrival = {opacity: number; scale: number; dx: number; dy: number; blur: number; rgb: number; shine: number; clip?: string}; // px; shine 0..1 = where the highlight is; clip = a clip-path while arriving
const THERE: Arrival = {opacity: 1, scale: 1, dx: 0, dy: 0, blur: 0, rgb: 0, shine: 1};

// frame is relative to the onset (negative = not yet)
export function arrive(kind: ArriveKind, frame: number, fps: number): Arrival {
  if (frame < 0) return {...THERE, opacity: 0, shine: 0};
  const t = (millis: number) => interpolate(frame, [0, ms(fps, millis)], [0, 1], {...CLAMP, easing: OUT});
  switch (kind) {
    case 'cut': return THERE;
    case 'fade': { const a = t(170); return {...THERE, opacity: a, dy: (1 - a) * 6}; }
    case 'ghost': { const a = t(250); return {...THERE, opacity: 0.4 + 0.6 * a, shine: a}; }
    case 'blur': { const a = t(100); return {...THERE, opacity: a, blur: (1 - a) * 15}; }
    case 'rgb': { const a = t(125); return {...THERE, opacity: Math.min(1, a * 1.5), blur: (1 - a) * 10, rgb: (1 - a) * 6}; }
    case 'pop': { const s = spring({frame, fps, config: {damping: 12, stiffness: 220, mass: 0.6}}); return {...THERE, scale: 0.7 + 0.3 * s}; }
    case 'drop': { const a = t(125); return {...THERE, scale: 1.3 - 0.3 * a, dy: -(1 - a) * 40}; }
    case 'slideBlur': { const a = t(250); return {...THERE, dx: (1 - a) * 600, blur: (1 - a) * 30}; }
    case 'band': { const a = t(170); return {...THERE, dy: (1 - a) * 600}; }
    case 'slideDown': { const a = t(210); return {...THERE, dy: -(1 - a) * 400}; }
    case 'wipe': { const a = t(210); const x = 115 * a; return a >= 1 ? THERE : {...THERE, clip: `polygon(0 0, ${x.toFixed(1)}% 0, ${(x - 12).toFixed(1)}% 100%, 0 100%)`}; }
  }
}

// how a page or a title leaves; framesLeft = frames until it is gone
export type LeaveKind = 'cut' | 'fade' | 'blur' | 'letters' | 'slideUp' | 'slideDown';
export type Exit = {opacity: number; blur: number; dy: number; letterCut: number}; // letterCut = letters already gone, counted from the end
export function leave(kind: LeaveKind, framesLeft: number, fps: number): Exit {
  const k = (millis: number) => interpolate(framesLeft, [0, ms(fps, millis)], [0, 1], CLAMP); // 1 = far from the end
  switch (kind) {
    case 'cut': return {opacity: 1, blur: 0, dy: 0, letterCut: 0};
    case 'fade': return {opacity: k(120), blur: 0, dy: 0, letterCut: 0};
    case 'blur': { const a = k(200); return {opacity: a, blur: (1 - a) * 12, dy: 0, letterCut: 0}; }
    case 'slideUp': return {opacity: 1, blur: 0, dy: -(1 - k(290)) * 600, letterCut: 0};
    case 'slideDown': return {opacity: 1, blur: 0, dy: (1 - k(170)) * 600, letterCut: 0};
    case 'letters': { // Form: the last letter first, one every 1.5 f at 24 fps, 11 f for 7 letters
      const per = (fps * 62) / 1000;
      return {opacity: 1, blur: 0, dy: 0, letterCut: Math.max(0, Math.ceil((ms(fps, 460) - framesLeft) / per))};
    }
  }
}

// the karaoke box travelling from the previous word to the spoken one (Focus: 2 f)
export const boxTravel = (from: number, to: number, frame: number, fps: number) => interpolate(frame, [0, ms(fps, 80)], [from, to], {...CLAMP, easing: OUT});

// Prism's B-roll card: 70 % of the way up in 330 ms (ease-out), then drifting the rest over 700 ms
export function cardLanding(frame: number, fps: number): number {
  const fast = ms(fps, 330), slow = ms(fps, 700);
  if (frame <= fast) return 0.7 * interpolate(frame, [0, fast], [0, 1], {...CLAMP, easing: OUT});
  return 0.7 + 0.3 * interpolate(frame, [fast, fast + slow], [0, 1], CLAMP);
}

// ---- titles (research/captions-ai-motion.md, Parte 2 A/B) ----
// how a title's characters arrive: letters (Elevate, Prime: one every ~42 ms, the leading one blurred),
// typewriter (Paper II, Lens, Align: ~30 ms per char, no blur), shuffle (Align: random glyphs that resolve
// left → right in 290 ms), tracking (Align, Elevate: all shown, letter-spacing settles 0.7 → 0.38 em in 375 ms)
export type TextReveal = 'letters' | 'typewriter' | 'shuffle' | 'tracking';
export const TEXT_REVEALS = new Set<string>(['letters', 'typewriter', 'shuffle', 'tracking']);
export function revealText(kind: TextReveal, frame: number, fps: number, n: number): {shown: number; blur: number; tracking: number; scramble: boolean} {
  const t = Math.max(0, frame) * (1000 / fps); // ms since the onset
  switch (kind) {
    case 'letters': { const shown = Math.min(n, t / 42); return {shown, blur: shown < n ? 10 : 0, tracking: 0, scramble: false}; }
    case 'typewriter': return {shown: Math.min(n, t / 30), blur: 0, tracking: 0, scramble: false};
    case 'shuffle': { const k = Math.min(1, t / 290); return {shown: n * k, blur: 0, tracking: 0, scramble: k < 1}; }
    case 'tracking': { const a = interpolate(t, [0, 375], [0, 1], {...CLAMP, easing: OUT}); return {shown: n, blur: 0, tracking: 0.7 - 0.32 * a, scramble: false}; }
  }
}
// a deterministic random glyph for the shuffle (same seed, index and frame → same glyph in every renderer)
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export function scrambleChar(seed: number, i: number, frame: number): string {
  const x = Math.sin(seed * 12.9898 + i * 78.233 + frame * 37.719) * 43758.5453;
  return GLYPHS[Math.floor((x - Math.floor(x)) * GLYPHS.length)];
}

// what a title does while it lives: grow (Prime's script swells 1 → 1.3× over 1.2 s), marquee (Stack's
// outline letters slide ~17 px per frame at 24 fps), drift (Form's word wall, ~65 px/s), oscillate (Prime's
// neon frame, ±3° every 2.5 s)
export type LifeKind = 'none' | 'grow' | 'marquee' | 'drift' | 'oscillate';
export function lifeFx(kind: LifeKind, frame: number, fps: number): {scale: number; dx: number; rotate: number} {
  const t = frame / fps;
  switch (kind) {
    case 'grow': return {scale: 1 + 0.3 * Math.min(1, t / 1.2), dx: 0, rotate: 0};
    case 'marquee': return {scale: 1, dx: -408 * t, rotate: 0};
    case 'drift': return {scale: 1, dx: -65 * t, rotate: 0};
    case 'oscillate': return {scale: 1, dx: 0, rotate: 3 * Math.sin((2 * Math.PI * t) / 2.5)};
    default: return {scale: 1, dx: 0, rotate: 0};
  }
}
