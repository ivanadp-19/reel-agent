// Color. Everything is opt-in and adjustable by parameters (set_grade / the
// Styles tab), for the whole reel or per source / clip:
//   - auto: a bounded correction measured on a source's lit frames (signalstats),
//     only for the sources that ask for it
//   - look: a named starting point at an intensity
//   - adjust: exposure, contrast, saturation, temperature, tint
//   - highlights: a soft shoulder instead of clipping what the grade pushes past white
//   - skin: skin tones keep their natural saturation and warmth when the rest is pushed
//   - lut: a .cube (the client's, or one made from reference photos, src/lut.ts),
//     baked into a graded copy of the source by ffmpeg before the parametric grade
// The parametric part reduces to per-channel tone tables + a saturation, which the
// renderer applies as an SVG filter (src/ClipMedia.tsx): preview = export.
// Pure: no fs, no DOM.

export type Stats = {yLow: number; yHigh: number; yAvg: number; uAvg: number; vAvg: number; satAvg: number}; // signalstats, 8-bit limited range
export type Grade = {slope: [number, number, number]; intercept: [number, number, number]; saturation: number};
export type Look = {id: string; desc: string; slope: number; offset: number; warmth: number; saturation: number};
// the knobs a prompt maps onto ("a bit warmer" → temperature 0.3, "less orange skin" → skin 0.8)
export type Adjust = {
  exposure?: number; // stops, −2…2 (a gain on the signal)
  contrast?: number; // 0.5…1.5 around mid-gray
  saturation?: number; // 0…2
  temperature?: number; // −1 cool … 1 warm
  tint?: number; // −1 green … 1 magenta
};
// what can be set for the whole reel and overridden per source (clip src) or per clip id
export type GradeParams = {
  look?: string;
  intensity?: number; // of the look, 0–1
  auto?: boolean; // the measured per-source correction
  adjust?: Adjust;
  highlights?: number; // 0 = hard clip … 1 = long soft shoulder (default 0.5)
  skin?: number; // skin protection 0 … 1 (default 0.5)
  lut?: string | null; // a .cube under public/, e.g. luts/cesar.cube
  lutMix?: number; // 0–1
};
export type ProjectGrade = GradeParams & {
  look: string;
  intensity: number;
  auto: boolean;
  bySrc: Record<string, Grade>; // measured corrections (scripts/grade.mjs)
  overrides?: Record<string, GradeParams>; // key: a clip src ("clips/a.mp4") or a clip id
  baked?: Record<string, string>; // bakeKey(src, lut, mix) → the LUT-graded copy under public/
};

export const IDENTITY: Grade = {slope: [1, 1, 1], intercept: [0, 0, 0], saturation: 1};
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

// bounds of the automatic correction: it may fix flat, dim or tinted footage,
// never restyle it (that is the look's job). Kept moderate: contrast 1.5× and
// saturation 1.4× on everything was what burnt the first G1 draft.
export const AUTO = {spread: 0.62, maxContrast: 1.35, mid: 0.46, deadZone: 0.08, maxShift: 0.06, maxCast: 0.02, sat: 8, maxSat: 1.25};
export const DEFAULTS = {highlights: 0.5, skin: 0.5, lutMix: 1};

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
  none: {id: 'none', desc: 'no look (default): only what you set', slope: 1, offset: 0, warmth: 0, saturation: 1},
  natural: {id: 'natural', desc: 'true to life: a touch of contrast, colors as shot', slope: 1.03, offset: 0, warmth: 0, saturation: 1.02},
  clean: {id: 'clean', desc: 'real estate limpio: bright, airy, crisp whites, a touch warm', slope: 1.06, offset: 0.015, warmth: 0.012, saturation: 1.08},
  warm: {id: 'warm', desc: 'golden, lived-in interiors and sunsets', slope: 1.04, offset: 0.005, warmth: 0.03, saturation: 1.1},
  crisp: {id: 'crisp', desc: 'high contrast, neutral, punchy color (city, tech, finance)', slope: 1.12, offset: -0.03, warmth: 0, saturation: 1.12},
  cool: {id: 'cool', desc: 'clean and slightly cool: bluer skies and shadows, neutral skin', slope: 1.05, offset: 0, warmth: -0.02, saturation: 1.05},
  moody: {id: 'moody', desc: 'darker, cooler, muted (luxury night, editorial)', slope: 1.1, offset: -0.06, warmth: -0.02, saturation: 0.88},
  mono: {id: 'mono', desc: 'black and white with contrast', slope: 1.1, offset: -0.03, warmth: 0, saturation: 0},
};
export const DEFAULT_LOOK = 'none';

// look at an intensity (0 = off, 1 = full), as a grade; warmth scaled for the skin layer
export function lookGrade(id: string, intensity = 0.8, warmthScale = 1): Grade {
  const l = LOOKS[id] ?? LOOKS.none;
  const t = clamp(intensity, 0, 1);
  const k = 1 + (l.slope - 1) * t;
  const o = l.offset * t - (k - 1) * 0.5; // contrast pivots on mid-gray
  const w = l.warmth * t * warmthScale;
  return {slope: [r3(k), r3(k), r3(k)], intercept: [r3(o + w), r3(o), r3(o - w)], saturation: r3(1 + (l.saturation - 1) * t)};
}

// the manual knobs as a grade; temperature / tint scaled for the skin layer
export function adjustGrade(a: Adjust | undefined, warmthScale = 1): Grade {
  if (!a) return IDENTITY;
  const gain = 2 ** clamp(a.exposure ?? 0, -2, 2);
  const c = clamp(a.contrast ?? 1, 0.5, 1.5);
  const temp = clamp(a.temperature ?? 0, -1, 1) * 0.05 * warmthScale;
  const tint = clamp(a.tint ?? 0, -1, 1) * 0.035 * warmthScale;
  const k = gain * c;
  const o = 0.5 * (1 - c); // contrast around mid-gray after the gain
  return {slope: [r3(k), r3(k), r3(k)], intercept: [r3(o + temp + tint / 2), r3(o - tint), r3(o - temp + tint / 2)], saturation: r3(clamp(a.saturation ?? 1, 0, 2))};
}

// apply `a` then `b`
export function compose(a: Grade, b: Grade): Grade {
  return {
    slope: a.slope.map((s, c) => r3(s * b.slope[c])) as Grade['slope'],
    intercept: a.intercept.map((i, c) => r3(i * b.slope[c] + b.intercept[c])) as Grade['intercept'],
    saturation: r3(a.saturation * b.saturation),
  };
}

// what a channel value becomes under the affine part (hard clip; for tests and previews)
export const applyGrade = (g: Grade, rgb: [number, number, number]) => rgb.map((v, c) => clamp(v * g.slope[c] + g.intercept[c], 0, 1));

// Highlight shoulder: below the knee values pass untouched; between the knee and
// `top` (the brightest value the grade produces, at least white) they bend
// smoothly into white — slope 1 at the knee, 0 at the top — instead of clipping.
// highlights = 0 → plain clip. Strength > default also compresses real whites a
// little (recovery of footage that is already hot).
export function shoulder(v: number, highlights: number, top: number): number {
  if (v <= 0) return 0;
  const h = clamp(highlights, 0, 1);
  if (h === 0) return Math.min(1, v);
  const knee = 1 - 0.4 * h;
  const t0 = Math.max(top, 1 + 0.3 * Math.max(0, h - DEFAULTS.highlights));
  if (v <= knee || t0 <= 1) return Math.min(1, v); // nothing past white to bend
  const p = (t0 - knee) / (1 - knee); // ≥ 1: slope continuity at the knee
  const t = Math.min(1, (v - knee) / (t0 - knee));
  return knee + (1 - knee) * (1 - (1 - t) ** p);
}

export const TABLE_SIZE = 33;
// one channel as a feFuncX table: affine, then the shoulder
export function toneTable(slope: number, intercept: number, highlights: number, n = TABLE_SIZE): number[] {
  const top = Math.max(1, slope + intercept);
  return Array.from({length: n}, (_, i) => r4(shoulder((i / (n - 1)) * slope + intercept, highlights, top)));
}

// what the renderer applies to one clip
export type RenderGrade = {
  tables: [number[], number[], number[]];
  saturation: number;
  // skin protection: tables + saturation for skin-toned pixels (null = same as the rest)
  skin: {tables: [number[], number[], number[]]; saturation: number} | null;
  media?: string; // the LUT-baked copy of the source to play instead of clip.src
};

export const bakeKey = (src: string, lut: string, mix: number) => `${src}|${lut}|${Math.round(clamp(mix, 0, 1) * 100)}`;

// the parameters that apply to one clip: whole reel ← its source ← the clip itself
export function paramsFor(pg: ProjectGrade, src: string, clipId?: string): GradeParams {
  const layers = [pg.overrides?.[src], clipId ? pg.overrides?.[clipId] : undefined].filter(Boolean) as GradeParams[];
  let out: GradeParams = {look: pg.look, intensity: pg.intensity, auto: pg.auto, adjust: pg.adjust, highlights: pg.highlights, skin: pg.skin, lut: pg.lut, lutMix: pg.lutMix};
  for (const o of layers) {
    const {adjust, ...rest} = o;
    out = {...out, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)), adjust: adjust ? {...out.adjust, ...adjust} : out.adjust};
  }
  return out;
}

const same = (a: number[][], b: number[][]) => a.every((t, c) => t.every((v, i) => v === b[c][i]));
const identityTables = (() => { const t = toneTable(1, 0, 0); return [t, t, t]; })();

// the full grade of one clip (null = untouched); file = what is actually played
// when it is not the source itself (a person matte cut from it)
export function gradeFor(pg: ProjectGrade | null | undefined, src: string, clipId?: string, file = src): RenderGrade | null {
  if (!pg) return null;
  const p = paramsFor(pg, src, clipId);
  const auto = p.auto ? pg.bySrc?.[src] ?? IDENTITY : IDENTITY;
  const hl = p.highlights ?? DEFAULTS.highlights;
  const skinK = clamp(p.skin ?? DEFAULTS.skin, 0, 1);
  const build = (warmth: number) => compose(compose(auto, lookGrade(p.look ?? 'none', p.intensity ?? 0.8, warmth)), adjustGrade(p.adjust, warmth));
  const g = build(1);
  const tables = [0, 1, 2].map((c) => toneTable(g.slope[c], g.intercept[c], hl)) as RenderGrade['tables'];
  // skin: the warmth of looks and temperature/tint fade out, the saturation boost too
  let skin: RenderGrade['skin'] = null;
  if (skinK > 0) {
    const s = build(1 - skinK);
    const sat = g.saturation > 1 ? r3(1 + (g.saturation - 1) * (1 - skinK)) : g.saturation;
    const st = [0, 1, 2].map((c) => toneTable(s.slope[c], s.intercept[c], hl)) as RenderGrade['tables'];
    if (sat !== g.saturation || !same(st, tables)) skin = {tables: st, saturation: sat};
  }
  const mix = p.lutMix ?? DEFAULTS.lutMix;
  const media = p.lut && mix > 0 ? pg.baked?.[bakeKey(file, p.lut, mix)] : undefined;
  if (!media && g.saturation === 1 && !skin && same(tables, identityTables)) return null;
  return {tables, saturation: g.saturation, skin, ...(media ? {media} : {})};
}

// every (file, lut, mix) the project needs baked, from the same resolution as the
// render: the sources, and the person mattes cut from them (they must match)
export type Bake = {key: string; src: string; lut: string; mix: number};
export function lutBakes(pg: ProjectGrade | null | undefined, clips: {id: string; src: string}[], mattes: {src: string; file: string}[] = []): Bake[] {
  if (!pg) return [];
  const out = new Map<string, Bake>();
  for (const c of clips) {
    const p = paramsFor(pg, c.src, c.id);
    const mix = p.lutMix ?? DEFAULTS.lutMix;
    if (!p.lut || mix <= 0) continue;
    for (const file of [c.src, ...mattes.filter((m) => m.src === c.src).map((m) => m.file)]) {
      const key = bakeKey(file, p.lut, mix);
      out.set(key, {key, src: file, lut: p.lut, mix});
    }
  }
  return [...out.values()];
}

// the sources whose automatic correction is on (to measure)
export const autoSources = (pg: ProjectGrade | null | undefined, clips: {id: string; src: string}[]) =>
  pg ? [...new Set(clips.filter((c) => paramsFor(pg, c.src, c.id).auto).map((c) => c.src))] : [];
