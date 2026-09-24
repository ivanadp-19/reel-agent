// HDR → SDR for ingest, as a 3D LUT generated in code (this ffmpeg build has no
// zscale/libplacebo). Input: R'G'B' in BT.2020 primaries, HLG (iPhone) or PQ
// encoded, 0–1. Output: R'G'B' in BT.709 with the BT.1886 (2.4) display curve.
// Tone mapping works on luminance (hues kept) with a soft knee so highlights
// roll off instead of clipping; HDR reference white (203 nits) lands at 0.95.
// Math: ITU-R BT.2100 (HLG OETF⁻¹/OOTF, PQ EOTF), BT.2087 primaries matrix.

type RGB = [number, number, number];
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// --- HLG (BT.2100) ---
const A = 0.17883277, B = 1 - 4 * A, C = 0.5 - A * Math.log(4 * A);
export const hlgInvOetf = (e: number) => (e <= 0.5 ? (e * e) / 3 : (Math.exp((e - C) / A) + B) / 12); // → scene light 0–1
export const hlgOetf = (l: number) => (l <= 1 / 12 ? Math.sqrt(3 * l) : A * Math.log(12 * l - B) + C);
const Y2020 = (r: RGB) => 0.2627 * r[0] + 0.678 * r[1] + 0.0593 * r[2];
const HLG_PEAK = 1000; // nits, nominal HLG display; system gamma 1.2
// HLG signal → display light in nits (OOTF)
function hlgToNits(e: RGB): RGB {
  const s = e.map(hlgInvOetf) as RGB;
  const ys = Y2020(s);
  const k = HLG_PEAK * Math.pow(Math.max(ys, 1e-6), 0.2);
  return s.map((v) => v * k) as RGB;
}
// display light in nits → HLG signal (inverse OOTF, for tests)
function nitsToHlg(d: RGB): RGB {
  const yd = Y2020(d) / HLG_PEAK;
  const ys = Math.pow(Math.max(yd, 1e-9), 1 / 1.2);
  const k = ys > 0 ? ys / Math.max(yd, 1e-9) / HLG_PEAK : 0;
  return d.map((v) => hlgOetf(Math.max(0, v * k))) as RGB;
}

// --- PQ (SMPTE ST 2084) ---
const M1 = 2610 / 16384, M2 = (2523 / 4096) * 128, C1 = 3424 / 4096, C2 = (2413 / 4096) * 32, C3 = (2392 / 4096) * 32;
export const pqEotf = (e: number) => { const p = Math.pow(Math.max(e, 0), 1 / M2); return 10000 * Math.pow(Math.max(p - C1, 0) / (C2 - C3 * p), 1 / M1); };

// --- primaries (linear light) ---
const TO709 = [[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1187]];
const TO2020 = [[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0114], [0.0164, 0.088, 0.8956]];
const mul = (m: number[][], v: RGB) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]) as RGB;

// --- tone map: nits → SDR relative light, soft knee above 0.75 ---
const REF_WHITE = 203, SDR_WHITE = 0.95, KNEE = 0.75;
export function toneMap(y: number): number {
  const x = (y / REF_WHITE) * SDR_WHITE;
  if (x <= KNEE) return x;
  const room = 1 - KNEE;
  return KNEE + room * (1 - Math.exp(-(x - KNEE) / room));
}
const bt1886Inv = (l: number) => Math.pow(clamp01(l), 1 / 2.4);
const bt1886 = (v: number) => Math.pow(clamp01(v), 2.4);

// display nits (BT.2020) → SDR R'G'B' (BT.709)
function nitsToSdr(d: RGB): RGB {
  const y = Y2020(d);
  const scale = y > 0 ? toneMap(y) / y : 0;
  const lin = mul(TO709, d.map((v) => v * scale) as RGB);
  const peak = Math.max(...lin);
  const fit = peak > 1 ? 1 / peak : 1; // out-of-range saturated colors: scale down, keep the hue
  return lin.map((v) => bt1886Inv(Math.max(0, v * fit))) as RGB;
}
export const hlgToSdr = (e: RGB) => nitsToSdr(hlgToNits(e));
export const pqToSdr = (e: RGB) => nitsToSdr(e.map(pqEotf) as RGB);
// the reverse of hlgToSdr for in-range colors (used to fake HLG test footage)
export function sdrToHlg(v: RGB): RGB {
  const lin = mul(TO2020, v.map(bt1886) as RGB);
  const y = Y2020(lin);
  // invert the tone curve on luminance (below the knee it is linear)
  const x = y;
  const inv = x <= KNEE ? x : KNEE - (1 - KNEE) * Math.log(1 - Math.min(0.999999, (x - KNEE) / (1 - KNEE)));
  const nits = (inv / SDR_WHITE) * REF_WHITE;
  const k = y > 0 ? nits / y : 0;
  return nitsToHlg(lin.map((c) => c * k) as RGB);
}

// .cube text (size³ entries, red fastest) for ffmpeg lut3d
export function cube(fn: (rgb: RGB) => RGB, size = 33, title = 'reel-agent'): string {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const o = fn([r / (size - 1), g / (size - 1), b / (size - 1)]);
    lines.push(o.map((v) => clamp01(v).toFixed(6)).join(' '));
  }
  return lines.join('\n') + '\n';
}
