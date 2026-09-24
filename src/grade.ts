// Color: a bounded automatic correction per source (from ffmpeg signalstats of
// its lit frames) plus a named look for the whole reel. Both reduce to one
// per-channel affine map (slope, intercept on 0–1 RGB) and a saturation factor,
// which the renderer applies as an SVG filter (preview = export, no re-encode).
// Pure: no fs, no DOM.

export type Stats = {yLow: number; yHigh: number; yAvg: number; uAvg: number; vAvg: number; satAvg: number}; // signalstats, 8-bit limited range
export type Grade = {slope: [number, number, number]; intercept: [number, number, number]; saturation: number};
export type Look = {id: string; desc: string; slope: number; offset: number; warmth: number; saturation: number};

export const IDENTITY: Grade = {slope: [1, 1, 1], intercept: [0, 0, 0], saturation: 1};
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const r3 = (v: number) => Math.round(v * 1000) / 1000;

// bounds of the automatic correction: it may fix flat, dim or tinted footage,
// never restyle it (that is the look's job)
export const AUTO = {spread: 0.62, maxContrast: 1.5, mid: 0.46, deadZone: 0.08, maxShift: 0.06, maxCast: 0.02, sat: 8, maxSat: 1.4};

export function autoGrade(s: Stats): Grade {
  const y = (v: number) => (v - 16) / 219; // limited-range luma → 0–1
  const lo = y(s.yLow), hi = y(s.yHigh);
  const mid = (lo + hi) / 2;
  // contrast: stretch the middle 80 % of the tones toward a normal spread (never flatten)
  const k = clamp(AUTO.spread / Math.max(0.05, hi - lo), 1, AUTO.maxContrast);
  // exposure: keep the mid-tone where it is unless it is clearly off, then move part way
  const off = mid - AUTO.mid;
  const target = Math.abs(off) <= AUTO.deadZone ? mid : mid - Math.sign(off) * Math.min(AUTO.maxShift, Math.abs(off) - AUTO.deadZone);
  const b = target - k * mid; // y' = k·y + b maps mid → target
  // white balance (gray world, damped): the average chroma offset as an RGB cast
  const du = (s.uAvg - 128) / 224, dv = (s.vAvg - 128) / 224;
  const cast = [1.5748 * dv, -0.1873 * du - 0.4681 * dv, 1.8556 * du].map((c) => clamp(-0.7 * c, -AUTO.maxCast, AUTO.maxCast));
  return {slope: [r3(k), r3(k), r3(k)], intercept: [r3(b + cast[0]), r3(b + cast[1]), r3(b + cast[2])], saturation: r3(clamp(AUTO.sat / Math.max(1, s.satAvg), 1, AUTO.maxSat))};
}

export const LOOKS: Record<string, Look> = {
  none: {id: 'none', desc: 'no look, only the automatic correction', slope: 1, offset: 0, warmth: 0, saturation: 1},
  clean: {id: 'clean', desc: 'real estate limpio: bright, airy, crisp whites, a touch warm (default)', slope: 1.06, offset: 0.015, warmth: 0.012, saturation: 1.08},
  warm: {id: 'warm', desc: 'golden, lived-in interiors and sunsets', slope: 1.04, offset: 0.005, warmth: 0.03, saturation: 1.1},
  crisp: {id: 'crisp', desc: 'high contrast, neutral, punchy color (city, tech, finance)', slope: 1.12, offset: -0.03, warmth: 0, saturation: 1.12},
  moody: {id: 'moody', desc: 'darker, cooler, muted (luxury night, editorial)', slope: 1.1, offset: -0.06, warmth: -0.02, saturation: 0.88},
  mono: {id: 'mono', desc: 'black and white with contrast', slope: 1.1, offset: -0.03, warmth: 0, saturation: 0},
};
export const DEFAULT_LOOK = 'clean';

// look at an intensity (0 = off, 1 = full), as a grade
export function lookGrade(id: string, intensity = 0.8): Grade {
  const l = LOOKS[id] ?? LOOKS.none;
  const t = clamp(intensity, 0, 1);
  const k = 1 + (l.slope - 1) * t;
  const o = l.offset * t - (k - 1) * 0.5; // contrast pivots on mid-gray
  const w = l.warmth * t;
  return {slope: [r3(k), r3(k), r3(k)], intercept: [r3(o + w), r3(o), r3(o - w)], saturation: r3(1 + (l.saturation - 1) * t)};
}

// apply `a` then `b`
export function compose(a: Grade, b: Grade): Grade {
  return {
    slope: a.slope.map((s, c) => r3(s * b.slope[c])) as Grade['slope'],
    intercept: a.intercept.map((i, c) => r3(i * b.slope[c] + b.intercept[c])) as Grade['intercept'],
    saturation: r3(a.saturation * b.saturation),
  };
}

// what a channel value becomes (for tests and previews)
export const applyGrade = (g: Grade, rgb: [number, number, number]) => rgb.map((v, c) => clamp(v * g.slope[c] + g.intercept[c], 0, 1));

export type ProjectGrade = {look: string; intensity: number; auto: boolean; bySrc: Record<string, Grade>};
// the full grade for one source of a project
export function gradeFor(pg: ProjectGrade | null | undefined, src: string): Grade | null {
  if (!pg) return null;
  const auto = pg.auto ? pg.bySrc?.[src] ?? IDENTITY : IDENTITY;
  const g = compose(auto, lookGrade(pg.look, pg.intensity));
  const same = g.saturation === 1 && g.slope.every((s) => s === 1) && g.intercept.every((i) => i === 0);
  return same ? null : g;
}
