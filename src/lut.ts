// 3D LUTs (.cube): read, sample, mix toward identity, and MAKE one — from
// reference photos, or by matching one clip to another. The reference transfer
// is a deterministic color-statistics match in Oklab (no model): lightness by
// quantiles (the tone curve of the references), chroma a/b by mean and spread
// (their palette), eased by a strength and bounded so it cannot wreck footage.
// The footage side comes from the frames the reel shows of the project's clips
// (lutSpans). The match (fitCube) fits pixel pairs of the same scene. Pure:
// pixels in, .cube text out; the ffmpeg decoding lives in scripts/lut.mjs.

import {cube} from './hdr.ts';
import {continuesPrev, type Clip} from './timeline.ts';
import {DEFAULTS, paramsFor, type ProjectGrade} from './grade.ts';

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


// ---- what a LUT is measured on: the ranges the reel shows (create_lut, the Color section) ----
export type Span = {id: string; src: string; inSec: number; outSec: number};
const span = (c: Clip): Span => ({id: c.id, src: c.src, inSec: c.inSec, outSec: c.outSec});
// every clip, or one clip (or the clips of one source): its range of the source, not the source from t = 0
export function lutSpans(clips: Clip[], target?: string): Span[] {
  const out = clips.filter((c) => !target || c.id === target || c.src === target).map(span);
  if (!out.length) throw new Error(target ? `no clip or source "${target}"` : 'the project has no clips to measure the footage from');
  return out;
}
// create_lut match: the clip to fix and the one it must look like — a clip it runs into in the same source, split
// where the look changes inside a shot: the clip that continues it (a head a pre-edit graded only from its second part
// on, then the rest) or the one it continues (a tail whose grade stops early or pops: the shot, then the tail) —
// wherever they sit on the timeline (matchCandidates). Without toClipId, the continuation; the clip it continues only
// when named (a tail names its shot — never by default: that would fit a graded rest to its ungraded head). Never
// another shot: fitted across two, least squares washes the clip out (the job refuses it). `to` carries the LUT it
// plays with (whole reel, source or its own): the clip's LUT replaces that one, so it is fitted to `to` as it shows.
export const matchCandidates = (clips: Clip[], from: Clip): Clip[] => [...clips.filter((c) => continuesPrev(from, c)), ...clips.filter((c) => continuesPrev(c, from))];
export function matchPair(clips: Clip[], clipId: string, toClipId?: string, grade?: ProjectGrade | null): {from: Span; to: Span & {lut?: string; mix?: number}} {
  const from = clips.find((c) => c.id === clipId);
  if (!from) throw new Error(`no clip ${clipId}`);
  const to = toClipId ? matchCandidates(clips, from).find((c) => c.id === toClipId) : clips.find((c) => continuesPrev(from, c));
  if (!to) throw new Error(toClipId ? `${toClipId} neither continues ${clipId} nor is continued by it in the same source: a match fits the same shot either side of a split` : `no clip continues ${clipId} in the same source: split_clip where the look changes inside the shot, then match the part before the split (a tail: to_clip_id its shot)`);
  const p: {lut?: string | null; lutMix?: number} = grade ? paramsFor(grade, to.src, to.id) : {};
  const mix = p.lutMix ?? DEFAULTS.lutMix;
  return {from: span(from), to: {...span(to), ...(p.lut && mix > 0 ? {lut: p.lut, mix} : {})}};
}

// ---- match: a LUT fitted on pixel pairs ----
// x → y (RGB 0–1, interleaved): the same pixels of the same scene without and with the look (the head a pre-edit
// left ungraded against the graded frames right after it). Least squares per output channel on a second-order
// polynomial of luma and chroma (BT.709 Y, B − Y, R − Y, standardized): a tone curve (Y, Y²) and a chroma gain that
// may change with luma (Cb, Cr, Y·Cb, Y·Cr). No Cb², Cr², Cb·Cr: real pairs span a thin range of chroma, and those
// terms fit its noise — what blew up out of sample. BOUNDED: the polynomial is evaluated only inside the colors the
// pairs cover (their luma range and, per hue sector, their chroma radius plus one cube cell, so the nodes around the
// data carry its gain) and carried beyond at slope 1: a color the pairs never showed gets the correction of the
// nearest one they did, never an extrapolated one (the cyan / magenta blotches in a sky). Then each channel is made
// monotone along its own axis. Identity pairs give the identity.
function solve(A: number[][], v: number[]): number[] { // Gaussian elimination, partial pivoting
  const n = v.length, a = A.map((r, i) => [...r, v[i]]);
  for (let i = 0; i < n; i++) {
    let m = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(a[k][i]) > Math.abs(a[m][i])) m = k;
    [a[i], a[m]] = [a[m], a[i]];
    for (let k = i + 1; k < n; k++) { const t = a[k][i] / a[i][i]; for (let j = i; j <= n; j++) a[k][j] -= t * a[i][j]; }
  }
  const w = new Array<number>(n);
  for (let i = n - 1; i >= 0; i--) { let s = a[i][n]; for (let j = i + 1; j < n; j++) s -= a[i][j] * w[j]; w[i] = s / a[i][i]; }
  return w;
}
const KR = 0.2126, KB = 0.0722, KG = 1 - KR - KB;
const toYC = ([r, g, b]: RGB): RGB => { const y = KR * r + KG * g + KB * b; return [y, b - y, r - y]; };
const fromYC = ([y, cb, cr]: RGB): RGB => { const r = y + cr, b = y + cb; return [r, (y - KR * r - KB * b) / KG, b]; };
const SECTORS = 12;
const hue = (cb: number, cr: number) => ((Math.atan2(cr, cb) + Math.PI) / (2 * Math.PI)) * SECTORS; // 0…SECTORS

// How far the pairs are from being one color map at all (of 255): x binned 16 per channel, the mean distance of each
// pair's y from its bin's mean y (bins of ≥ 4 pairs). The same shot either side of a grade change makes y a function
// of x — whatever the grade, clipped or hue-selective, a polynomial cannot follow; another shot, or a jump cut
// between takes, does not (create_lut match's same-shot test, scripts/lut.mjs)
export function pairSpread(x: ArrayLike<number>, y: ArrayLike<number>, bins = 16): number {
  const at = new Map<number, number[]>();
  for (let i = 0; i + 2 < x.length; i += 3) {
    const k = [0, 1, 2].reduce((a, c) => a * bins + Math.min(bins - 1, Math.max(0, Math.floor(x[i + c] * bins))), 0);
    const e = at.get(k);
    if (e) e.push(i); else at.set(k, [i]);
  }
  let s = 0, n = 0;
  for (const idx of at.values()) {
    if (idx.length < 4) continue;
    const mu = [0, 1, 2].map((c) => idx.reduce((a, i) => a + y[i + c], 0) / idx.length);
    for (const i of idx) { s += (Math.abs(y[i] - mu[0]) + Math.abs(y[i + 1] - mu[1]) + Math.abs(y[i + 2] - mu[2])) / 3; n++; }
  }
  return n ? Math.round((s / n) * 2550) / 10 : Infinity;
}

export function fitCube(x: ArrayLike<number>, y: ArrayLike<number>, {size = 33, title = 'match'} = {}): string {
  const n = Math.floor(x.length / 3);
  if (n < 64 || y.length !== x.length) throw new Error('not enough pixel pairs to fit a LUT');
  const yc = Array.from({length: n}, (_, i) => toYC([x[i * 3], x[i * 3 + 1], x[i * 3 + 2]]));
  const mean = [0, 1, 2].map((c) => yc.reduce((s, p) => s + p[c], 0) / n);
  const sd = [0, 1, 2].map((c) => Math.sqrt(yc.reduce((s, p) => s + (p[c] - mean[c]) ** 2, 0) / n) || 1);
  const feat = (p: RGB) => { const [l, u, v] = p.map((w, c) => (w - mean[c]) / sd[c]); return [1, l, u, v, l * l, l * u, l * v]; };
  const K = 7, A = Array.from({length: K}, () => new Array<number>(K).fill(0)), B = [0, 1, 2].map(() => new Array<number>(K).fill(0));
  for (let i = 0; i < n; i++) {
    const f = feat(yc[i]);
    for (let a = 0; a < K; a++) { for (let b = 0; b < K; b++) A[a][b] += f[a] * f[b]; for (let c = 0; c < 3; c++) B[c][a] += f[a] * y[i * 3 + c]; }
  }
  for (let a = 0; a < K; a++) A[a][a] += 1e-6 * n; // a whisker of ridge: flat footage stays solvable
  const W = B.map((v) => solve(A, v));
  if (!W.flat().every(Number.isFinite)) throw new Error('the pixel pairs do not determine a color map');
  // the colors the pairs cover: luma 1–99 %; per hue sector with data (≥ 0.2 % of the pairs) its 99 % chroma radius
  const at = (s: ArrayLike<number>, t: number) => s[Math.round(t * (s.length - 1))];
  const L = Float64Array.from(yc, (p) => p[0]).sort(), rad: number[][] = Array.from({length: SECTORS}, () => []);
  for (const [, u, v] of yc) rad[Math.floor(hue(u, v)) % SECTORS].push(Math.hypot(u, v));
  const lo = at(L, 0.01), hi = at(L, 0.99);
  const lim = rad.map((r) => (r.length < n * 0.002 ? 0 : at(r.sort((a, b) => a - b), 0.99)) + 1 / (size - 1));
  const fit = (p: RGB): RGB => {
    const [l, u, v] = toYC(p);
    const t = hue(u, v) - 0.5, k = Math.floor(t), f = t - k; // between the two nearest sector centers
    const r = lim[(k + SECTORS) % SECTORS] * (1 - f) + lim[(k + 1) % SECTORS] * f, rho = Math.hypot(u, v);
    const s = rho > r ? r / rho : 1;
    const q = [Math.min(hi, Math.max(lo, l)), u * s, v * s] as RGB, o = feat(q), qr = fromYC(q);
    return [0, 1, 2].map((c) => W[c].reduce((acc, w, j) => acc + w * o[j], 0) + p[c] - qr[c]) as RGB;
  };
  // least squares shrinks chroma where the pairs scatter: a pop that clipped half the picture (Morantes 10's 3-frame
  // tails) came out ×0.89 as saturated as its shot, a residual grade-coverage blocks — the fit keeps the target's mean
  // saturation over the pairs (a gain on its chroma, 0.8–1.25) and its mean tint (an offset after the gain: the bounded
  // fit leaves the pairs' mean off by a unit or two where it clamps); a clean fit is left alone
  const T = [0, 0, 0], F = [0, 0, 0], fx = Array.from({length: n}, (_, i) => toYC(fit([x[i * 3], x[i * 3 + 1], x[i * 3 + 2]])));
  for (let i = 0; i < n; i++) { const t = toYC([y[i * 3], y[i * 3 + 1], y[i * 3 + 2]]), f = fx[i]; T[0] += Math.hypot(t[1], t[2]); F[0] += Math.hypot(f[1], f[2]); T[1] += t[1]; T[2] += t[2]; }
  const g = F[0] > 0 ? Math.min(1.25, Math.max(0.8, T[0] / F[0])) : 1;
  for (const f of fx) { F[1] += f[1] * g; F[2] += f[2] * g; }
  const du = (T[1] - F[1]) / n, dv = (T[2] - F[2]) / n;
  const sat = (o: RGB): RGB => { if (Math.abs(g - 1) < 0.01 && Math.abs(du) + Math.abs(dv) < 0.002) return o; const [l, u, v] = toYC(o); return fromYC([l, u * g + du, v * g + dv]); };
  const m = size, data = new Float64Array(m ** 3 * 3), step = [1, m, m * m];
  for (let i = 0; i < m ** 3; i++) data.set(sat(fit([(i % m) / (m - 1), (Math.floor(i / m) % m) / (m - 1), Math.floor(i / (m * m)) / (m - 1)])), i * 3);
  // monotone: a channel never falls while its own input rises. Per line of the cube, the least-squares monotone
  // values (pool adjacent violators) weighted by the pairs nearest each node: where the fit dips, the nodes the pairs
  // cover keep their value and the others follow them. A running max lifted a gray node to its off-axis neighbour
  // instead — G10 s3's blacks came out green.
  const node = (v: number) => Math.round(v * (m - 1)), wt = new Float64Array(m ** 3).fill(0.01);
  for (let i = 0; i < n; i++) wt[(node(x[i * 3 + 2]) * m + node(x[i * 3 + 1])) * m + node(x[i * 3])]++;
  for (let c = 0; c < 3; c++) for (let i = 0; i < m ** 3; i++) if (Math.floor(i / step[c]) % m === 0) {
    const pools: {v: number; w: number; k: number}[] = [];
    for (let k = 0; k < m; k++) {
      const j = i + k * step[c];
      let p = {v: data[j * 3 + c], w: wt[j], k: 1};
      while (pools.length && pools[pools.length - 1].v > p.v) { const q = pools.pop()!; p = {v: (q.v * q.w + p.v * p.w) / (q.w + p.w), w: q.w + p.w, k: q.k + p.k}; }
      pools.push(p);
    }
    let k = 0;
    for (const p of pools) for (let t = 0; t < p.k; t++) data[(i + k++ * step[c]) * 3 + c] = p.v;
  }
  return cube(([r, g, b]) => { const i = ((node(b) * m + node(g)) * m + node(r)) * 3; return [data[i], data[i + 1], data[i + 2]]; }, m, title);
}
