// 3D LUTs (.cube): read, sample, mix toward identity, and MAKE one from
// reference photos. The reference transfer is a deterministic color-statistics
// match in Oklab (no model): lightness by quantiles (the tone curve of the
// references), chroma a/b by mean and spread (their palette), eased by a
// strength and bounded so it cannot wreck footage. The footage side comes from
// frames of the project's own clips. Pure: pixels in, .cube text out; the ffmpeg
// decoding lives in scripts/lut.mjs.

import {cube} from './hdr.ts';

type RGB = [number, number, number];
export type Cube = {size: number; data: Float32Array; title?: string}; // size³ × 3, red fastest
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function parseCube(text: string): Cube {
  let size = 0, title: string | undefined;
  let min = [0, 0, 0], max = [1, 1, 1];
  const vals: number[] = [];
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    if (/^TITLE/i.test(l)) { title = l.replace(/^TITLE\s*/i, '').replace(/^"|"$/g, ''); continue; }
    if (/^LUT_3D_SIZE/i.test(l)) { size = parseInt(l.split(/\s+/)[1], 10); continue; }
    if (/^LUT_1D_SIZE/i.test(l)) throw new Error('1D LUTs are not supported, only 3D (.cube with LUT_3D_SIZE)');
    if (/^DOMAIN_MIN/i.test(l)) { min = l.split(/\s+/).slice(1).map(Number); continue; }
    if (/^DOMAIN_MAX/i.test(l)) { max = l.split(/\s+/).slice(1).map(Number); continue; }
    if (/^[A-Z_]/i.test(l)) continue; // other keywords
    const p = l.split(/\s+/).map(Number);
    if (p.length === 3 && p.every(Number.isFinite)) vals.push(...p.map((v, c) => (v - min[c]) / (max[c] - min[c] || 1)));
  }
  if (size < 2 || size > 129) throw new Error(`bad LUT_3D_SIZE ${size}`);
  if (vals.length !== size ** 3 * 3) throw new Error(`the .cube has ${vals.length / 3} entries, LUT_3D_SIZE ${size} needs ${size ** 3}`);
  return {size, data: Float32Array.from(vals), title};
}

// trilinear sample
export function sampleCube(l: Cube, rgb: RGB): RGB {
  const n = l.size - 1;
  const p = rgb.map((v) => clamp01(v) * n);
  const i0 = p.map((v) => Math.min(n - 1, Math.floor(v)));
  const f = p.map((v, k) => v - i0[k]);
  const at = (r: number, g: number, b: number, c: number) => l.data[((b * l.size + g) * l.size + r) * 3 + c];
  const out: RGB = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let v = 0;
    for (let dr = 0; dr < 2; dr++) for (let dg = 0; dg < 2; dg++) for (let db = 0; db < 2; db++) {
      const w = (dr ? f[0] : 1 - f[0]) * (dg ? f[1] : 1 - f[1]) * (db ? f[2] : 1 - f[2]);
      v += w * at(i0[0] + dr, i0[1] + dg, i0[2] + db, c);
    }
    out[c] = v;
  }
  return out;
}

// a LUT at a strength (0 = identity, 1 = as is), as .cube text for ffmpeg lut3d
export const mixCube = (l: Cube, mix: number, size = l.size) =>
  cube((rgb) => { const o = sampleCube(l, rgb); return rgb.map((v, c) => v + (o[c] - v) * clamp01(mix)) as RGB; }, size, `${l.title ?? 'lut'} @ ${Math.round(clamp01(mix) * 100)}%`);

// ---- Oklab (Björn Ottosson, public domain math) on sRGB 0–1 ----
const toLin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export function rgbToOklab([r, g, b]: RGB): RGB {
  const [R, G, B] = [r, g, b].map(toLin);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
export function oklabToRgb([L, a, b]: RGB): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return lin.map((v) => clamp01(v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055)) as RGB;
}

// ---- statistics of a set of pixels (RGB 0–1, interleaved) ----
export type LabStats = {q: number[]; a: [number, number]; b: [number, number]; n: number}; // L quantiles; a, b: [mean, std]
export const QUANTILES = 21;
export function labStats(px: ArrayLike<number>): LabStats {
  const n = Math.floor(px.length / 3);
  if (n < 16) throw new Error('not enough pixels to measure');
  const L = new Float64Array(n);
  let sa = 0, sb = 0, sa2 = 0, sb2 = 0;
  for (let i = 0; i < n; i++) {
    const [l, a, b] = rgbToOklab([px[i * 3], px[i * 3 + 1], px[i * 3 + 2]]);
    L[i] = l; sa += a; sb += b; sa2 += a * a; sb2 += b * b;
  }
  L.sort();
  const q = Array.from({length: QUANTILES}, (_, k) => L[Math.min(n - 1, Math.round((k / (QUANTILES - 1)) * (n - 1)))]);
  const ma = sa / n, mb = sb / n;
  return {q, a: [ma, Math.sqrt(Math.max(1e-8, sa2 / n - ma * ma))], b: [mb, Math.sqrt(Math.max(1e-8, sb2 / n - mb * mb))], n};
}

// monotone piecewise-linear map through matched quantiles (the reference tone curve)
function quantileMap(from: number[], to: number[]): (x: number) => number {
  // strictly increasing knots; the ends pinned to black and white so the range survives
  const xs = [0], ys = [0];
  for (let k = 1; k < from.length - 1; k++) if (from[k] > xs.at(-1)! + 1e-4) { xs.push(from[k]); ys.push(Math.max(ys.at(-1)!, to[k])); }
  xs.push(1); ys.push(Math.max(ys.at(-1)!, 1));
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let k = 1;
    while (xs[k] < x) k++;
    const t = (x - xs[k - 1]) / (xs[k] - xs[k - 1]);
    return ys[k - 1] + t * (ys[k] - ys[k - 1]);
  };
}

export type TransferOpts = {strength?: number; maxShift?: number; maxScale?: number};
// the reference look as a color function: footage stats → reference stats
export function transferFn(footage: LabStats, ref: LabStats, {strength = 0.7, maxShift = 0.04, maxScale = 1.6}: TransferOpts = {}) {
  const k = clamp01(strength);
  const tone = quantileMap(footage.q, ref.q);
  const lim = (v: number, a: number) => Math.min(a, Math.max(-a, v));
  const scale = (s: number, r: number) => Math.min(maxScale, Math.max(1 / maxScale, r / s));
  const sa = scale(footage.a[1], ref.a[1]), sb = scale(footage.b[1], ref.b[1]);
  const da = lim(ref.a[0] - footage.a[0] * sa, maxShift), db = lim(ref.b[0] - footage.b[0] * sb, maxShift);
  // the palette shift fades out toward black and white: a warm reference must not tint the whites
  const mid = (L: number) => Math.max(0, 1 - ((L - 0.55) / 0.45) ** 4);
  return (rgb: RGB): RGB => {
    const [L, a, b] = rgbToOklab(rgb);
    const w = mid(L);
    const L2 = tone(L), a2 = a * sa + da * w, b2 = b * sb + db * w;
    return oklabToRgb([L + (L2 - L) * k, a + (a2 - a) * k, b + (b2 - b) * k]);
  };
}

// reference photos + footage frames → .cube text
export function cubeFromReferences(footage: LabStats, ref: LabStats, name: string, opts: TransferOpts = {}, size = 33): string {
  return cube(transferFn(footage, ref, opts), size, name);
}

