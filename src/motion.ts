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
export type ArriveKind = 'cut' | 'fade' | 'ghost' | 'blur' | 'rgb' | 'pop' | 'drop' | 'slideBlur' | 'band' | 'slideDown' | 'wipe' | 'stomp' | 'ccSlideUp' | 'highlightRise' | 'trackingIn' | 'focusBlur' | 'appleMask';
export type Arrival = {opacity: number; scale: number; dx: number; dy: number; blur: number; rgb: number; shine: number; clip?: string}; // px; shine 0..1 = where the highlight is; clip = a clip-path while arriving
const THERE: Arrival = {opacity: 1, scale: 1, dx: 0, dy: 0, blur: 0, rgb: 0, shine: 1};

// frame is relative to the onset (negative = not yet)
export function arrive(kind: ArriveKind, frame: number, fps: number): Arrival {
  if (frame < 0) return {...THERE, opacity: 0, shine: 0};
  const t = (millis: number) => interpolate(frame, [0, ms(fps, millis)], [0, 1], {...CLAMP, easing: OUT});
  switch (kind) {
    case 'cut': return THERE;
    case 'highlightRise': return THERE; // rendered per-char in CaptionTrack (classifier highlights, César 9:27)
    case 'trackingIn': return THERE; // letter-spacing snap rendered in CaptionTrack (Remocn TrackingIn)
    case 'appleMask': return THERE; // masked rise + blur settle rendered in CaptionTrack (Apple-keynote kinetic type)
    case 'focusBlur': { // Remocn FocusBlurResolve: heavy blur pulls to crisp
      const a = t(420);
      return {...THERE, opacity: Math.min(1, a * 1.7), blur: (1 - a) * 14};
    }
    case 'fade': { const a = t(170); return {...THERE, opacity: a, dy: (1 - a) * 6}; }
    case 'ghost': { const a = t(250); return {...THERE, opacity: 0.4 + 0.6 * a, shine: a}; }
    case 'blur': { const a = t(100); return {...THERE, opacity: a, blur: (1 - a) * 15}; }
    case 'rgb': { const a = t(125); return {...THERE, opacity: Math.min(1, a * 1.5), blur: (1 - a) * 10, rgb: (1 - a) * 6}; }
    case 'pop': { const s = spring({frame, fps, config: {damping: 12, stiffness: 220, mass: 0.6}}); return {...THERE, scale: 0.7 + 0.3 * s}; }
    case 'ccSlideUp': { // César's Premiere "CC slide up" caption entry (his .prproj keyframes, ~0.77x per his 9:57
      // "aumenta la velocidad" + motion blur on entry): 91 px rise in 160 ms, cubic-bezier(0.1667,0.1667,0,1);
      // opacity 0->1 in 64 ms; blur settles with the rise; no exit (hard cut)
      const a = interpolate(frame, [0, ms(fps, 64)], [0, 1], CLAMP);
      const r = interpolate(frame, [0, ms(fps, 160)], [0, 1], {...CLAMP, easing: Easing.bezier(0.1667, 0.1667, 0, 1)});
      return {...THERE, opacity: a, dy: (1 - r) * 91, blur: (1 - r) * 8};
    }
    case 'stomp': { // WithSubtitles 'stomp': word punches in from ~2.2x down to 1 with a hard settle
      const s = spring({frame, fps, config: {damping: 11, stiffness: 260, mass: 0.7}});
      const a = t(80);
      return {...THERE, scale: 1 + 1.2 * (1 - s), opacity: a};
    }
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
export type TextReveal = 'letters' | 'typewriter' | 'shuffle' | 'tracking' | 'trackingSnap' | 'bounceChars' | 'bounceCharsBlue' | 'riseChars';
export const TEXT_REVEALS = new Set<string>(['letters', 'typewriter', 'shuffle', 'tracking', 'trackingSnap', 'bounceChars', 'bounceCharsBlue', 'riseChars']);

// per-character transform while a continuous reveal (bounceChars, riseChars) is running
export type CharFx = {opacity: number; dy: number; scale: number; blur: number; rotate: number};

// ---- César's .aegraphic text presets, measured from the .aep keyframes ----
// (FAST / CLEAN_BLUE / TRIPLE_ELEGANT_TEXT; expressions and keyframes pulled
// straight out of the projects). Two families:
//
// bounceChars = the "Rebote" / "Glass" / "blue" / "apple style" expression
// selector: amount = amp·cos(freq·2πt)/e^(decay·t) per character, delayed
// `delayPer` s per char. At t<0 the amount sits at 100 (char fully displaced:
// below, scale 0, rotated, blurred); it then oscillates past rest and settles
// — the damped spring of the originals. Rebote: dy 91, rot 65, blur 94,
// delay 0.05, amp 80, freq 2, decay 8. blue/apple: dy 310, blur 0/192,
// delay 0.1, amp 20, freq 3, decay 8.
export type BounceOpts = {delayPer: number; freq: number; amp: number; decay: number; dyPx: number; blurPx: number; rotateDeg: number};
export const BOUNCE_REBOTE: BounceOpts = {delayPer: 0.05, freq: 2, amp: 80, decay: 8, dyPx: 91, blurPx: 94, rotateDeg: 65};
// CLEAN BLUE / apple style: the big one — chars drop from 310px below with heavy blur, slower stagger
export const BOUNCE_BLUE: BounceOpts = {delayPer: 0.1, freq: 3, amp: 20, decay: 8, dyPx: 310, blurPx: 192, rotateDeg: 0};
export function bounceChar(i: number, frame: number, fps: number, o: BounceOpts = BOUNCE_REBOTE): CharFx {
  const t = frame / fps - i * o.delayPer;
  const amount = t < 0 ? 100 : o.amp * Math.cos(o.freq * t * 2 * Math.PI) / Math.exp(o.decay * t);
  return {
    opacity: 1,
    dy: (o.dyPx * amount) / 100,
    scale: Math.max(0, 1 - amount / 100),
    blur: Math.max(0, (o.blurPx * amount) / 100),
    rotate: (o.rotateDeg * amount) / 100,
  };
}

// riseChars = "Smooth up" / "Futurist" / "Gold text": a range-selector sweep
// (offset −100→100 in ~1.32 s) lifts each character from +100 px below with
// blur 100→0 and fade, ease-low 90 (fast settle). Approximated per char with
// a staggered ease-out; the sweep is continuous in AE, this is the frame
// equivalent.
export function riseChar(i: number, n: number, frame: number, fps: number): CharFx {
  const total = 1.32; // s, the AE offset sweep
  const stagger = total * 0.55;
  const dur = total * 0.45;
  const t = frame / fps - (n > 1 ? (i / (n - 1)) * stagger : 0);
  if (t <= 0) return {opacity: 0, dy: 100, scale: 1, blur: 100, rotate: 0};
  const a = interpolate(t, [0, dur], [0, 1], {...CLAMP, easing: Easing.out(Easing.cubic)});
  return {opacity: a, dy: (1 - a) * 100, scale: 1, blur: (1 - a) * 100, rotate: 0};
}

export function revealText(kind: TextReveal, frame: number, fps: number, n: number): {shown: number; blur: number; tracking: number; scramble: boolean; charFx?: (i: number) => CharFx} {
  const t = Math.max(0, frame) * (1000 / fps); // ms since the onset
  switch (kind) {
    case 'letters': { const shown = Math.min(n, t / 42); return {shown, blur: shown < n ? 10 : 0, tracking: 0, scramble: false}; }
    case 'typewriter': return {shown: Math.min(n, t / 30), blur: 0, tracking: 0, scramble: false};
    case 'shuffle': { const k = Math.min(1, t / 290); return {shown: n * k, blur: 0, tracking: 0, scramble: k < 1}; }
    case 'tracking': { const a = interpolate(t, [0, 375], [0, 1], {...CLAMP, easing: OUT}); return {shown: n, blur: 0, tracking: 0.7 - 0.32 * a, scramble: false}; }
    case 'trackingSnap': { // César's Apple-style pick 2 (9:51): letter-spacing collapses wide -> normal with a spring snap
      const s = spring({frame: Math.max(0, frame), fps, config: {damping: 14, stiffness: 180, mass: 0.7}});
      return {shown: n, blur: 0, tracking: (1 - s) * 0.35, scramble: false};
    }
    case 'bounceChars': return {shown: n, blur: 0, tracking: 0, scramble: false, charFx: (i) => bounceChar(i, frame, fps)};
    case 'bounceCharsBlue': return {shown: n, blur: 0, tracking: 0, scramble: false, charFx: (i) => bounceChar(i, frame, fps, BOUNCE_BLUE)};
    case 'riseChars': return {shown: n, blur: 0, tracking: 0, scramble: false, charFx: (i) => riseChar(i, n, frame, fps)};
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

// ---- layouts and B-roll (research/captions-ai-motion.md, Parte 2 D) ----
// how a layout (the presenter's frame) arrives: frameIn = the video shrinks into its frame (Evo 8–9 f,
// Stack 2–3 f); tile = it settles into a split tile over ~10 f (Align); capsule = a mask that scales
// down to size in 8 f (Bloom); inset = 0.85 in 6 f (Align); cut = it is simply there
export type LayoutIn = 'cut' | 'frameIn' | 'tile' | 'capsule' | 'inset' | 'slide'; // slide = the framed video slides in from the right edge (Y2K windows, 10 f)
export const LAYOUT_IN_MS: Record<LayoutIn, number> = {cut: 0, frameIn: 300, tile: 330, capsule: 330, inset: 200, slide: 420};
export const layoutIn = (kind: LayoutIn, frame: number, fps: number) => (kind === 'cut' ? 1 : interpolate(frame, [0, ms(fps, LAYOUT_IN_MS[kind])], [0, 1], {...CLAMP, easing: OUT}));
// …and leaves (1 = fully framed, 0 = back to full bleed): frameIn returns in 4 f, tile in 4 f, capsule expands in 6 f
const LAYOUT_OUT_MS: Record<LayoutIn, number> = {cut: 0, frameIn: 130, tile: 130, capsule: 200, inset: 130, slide: 250};
export const layoutOut = (kind: LayoutIn, framesLeft: number, fps: number) => (kind === 'cut' ? 1 : interpolate(framesLeft, [0, ms(fps, LAYOUT_OUT_MS[kind])], [0, 1], CLAMP));

// how a B-roll cue arrives: slideUp = rises from the bottom edge, 7–15 f with a strong ease-out (Elevate,
// Impact, Form, Focus); popFrom = scales from a point in 11 f (Evo); slideRight = in from the right edge
// in 10 f (Y2K windows, Chalk photo); fade = a crossfade in 5 f (Linen); cut = it is simply there
export type BrollIn = 'cut' | 'fade' | 'slideUp' | 'popFrom' | 'slideRight';
export const BROLL_IN_MS: Record<BrollIn, number> = {cut: 0, fade: 210, slideUp: 400, popFrom: 370, slideRight: 420};
export type BrollFx = {dx: number; dy: number; scale: number; blur: number; opacity?: number}; // dx/dy in % of the cue's own box
export function brollIn(kind: BrollIn, frame: number, fps: number): BrollFx {
  const a = kind === 'cut' ? 1 : interpolate(frame, [0, ms(fps, BROLL_IN_MS[kind])], [0, 1], {...CLAMP, easing: Easing.out(Easing.quad)});
  const strong = kind === 'cut' ? 1 : interpolate(frame, [0, ms(fps, BROLL_IN_MS[kind])], [0, 1], {...CLAMP, easing: OUT}); // 2/3 of the way in the first third
  switch (kind) {
    case 'slideUp': return {dx: 0, dy: (1 - strong) * 120, scale: 1, blur: 0};
    case 'popFrom': return {dx: 0, dy: 0, scale: a, blur: 0};
    case 'slideRight': return {dx: (1 - strong) * 120, dy: 0, scale: 1, blur: 0};
    case 'fade': return {dx: 0, dy: 0, scale: 1, blur: 0, opacity: interpolate(frame, [0, ms(fps, BROLL_IN_MS.fade)], [0, 1], CLAMP)};
    default: return {dx: 0, dy: 0, scale: 1, blur: 0};
  }
}
// …and leaves: slideDown = through the bottom edge with motion blur, 5 f (Impact, Elevate 13 f); shrink =
// to 0 in 9 f (Evo); fall = drops out with blur in 5 f (Chalk photo); fade = the reverse crossfade in 5 f (Linen); cut = it is simply gone
export type BrollOut = 'cut' | 'fade' | 'slideDown' | 'shrink' | 'fall';
const BROLL_OUT_MS: Record<BrollOut, number> = {cut: 0, fade: 210, slideDown: 210, shrink: 300, fall: 210};
export function brollOut(kind: BrollOut, framesLeft: number, fps: number): BrollFx {
  if (kind === 'cut') return {dx: 0, dy: 0, scale: 1, blur: 0};
  const k = 1 - interpolate(framesLeft, [0, ms(fps, BROLL_OUT_MS[kind])], [0, 1], CLAMP); // 0 = far from the end, 1 = gone
  const acc = k * k; // ease-in: it accelerates away
  switch (kind) {
    case 'slideDown': return {dx: 0, dy: acc * 120, scale: 1, blur: k * 12};
    case 'fall': return {dx: 0, dy: acc * 130, scale: 1, blur: k * 16};
    case 'shrink': return {dx: 0, dy: 0, scale: 1 - acc, blur: 0};
    case 'fade': return {dx: 0, dy: 0, scale: 1, blur: 0, opacity: 1 - k};
  }
}

// Paper II's stickers: a crumpled ball beside the head travels out (travel 0→1 of its distance) while it
// scales 0.15→1 and unfolds, 10–12 f ease-out; leaving, it shrinks back toward the head in 4 f
export function unfold(frame: number, fps: number, leaving: boolean): {travel: number; scale: number} {
  if (!leaving) { const a = interpolate(frame, [0, ms(fps, 400)], [0, 1], {...CLAMP, easing: OUT}); return {travel: a, scale: 0.15 + 0.85 * a}; }
  const k = interpolate(frame, [0, ms(fps, 170)], [1, 0], CLAMP); // frame = frames since the exit began
  return {travel: k, scale: 0.15 + 0.85 * k};
}

// Y2K's windows: while a window slides in (over `slideFrames`) it leaves 4 copies trailing behind it,
// each a step further back and fainter; they are gathered up over ~333 ms after it lands
export function windowTrail(frame: number, fps: number, slideFrames: number): {copies: {offset: number; opacity: number}[]} {
  const gather = interpolate(frame, [slideFrames, slideFrames + ms(fps, 333)], [1, 0], CLAMP); // 1 while sliding, 0 once gathered
  if (gather <= 0) return {copies: []};
  return {copies: [1, 2, 3, 4].map((i) => ({offset: i * 40 * gather, opacity: (1 - i * 0.18) * gather}))};
}
