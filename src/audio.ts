// Voice cleanup options for the final render (scripts/qc.mjs applies `af`
// before loudness normalization; drafts are untouched), and the music bed's
// level and fades. Data and pure functions only, so the editor and the MCP
// tool can use them without importing ffmpeg code.
import type {Music} from './timeline.ts';

export const CLEAN = {
  off: {desc: 'nothing', af: ''},
  light: {desc: 'low cut at 80 Hz + gentle spectral denoise (room hiss, hum)', af: 'highpass=f=80,afftdn=nf=-25:nr=10:nt=w'},
  strong: {desc: 'low cut at 100 Hz + heavier denoise + de-esser', af: 'highpass=f=100,afftdn=nf=-30:nr=18:nt=w,deesser=i=0.35'},
  // T16 / OQ4: ffmpeg only. The whole mix, the music's bass too (per-clip baking only if a reel mixes windy and clean takes)
  wind: {desc: 'wind: low cut at 130 Hz + spectral denoise (outdoor takes; the whole mix, music bass included)', af: 'highpass=f=130:p=2,afftdn=nf=-25:nr=12:nt=w'},
} as const;
export type CleanId = keyof typeof CLEAN;
export type AudioOptions = {clean?: CleanId | string; sfx?: boolean} | null;

// ---------- the music bed: level in dB, fades, ducking ----------
// One set of rules for set_music (MCP), the editor's Settings and MusicTrack (the render). The project
// keeps the level as a linear gain (Music.volume, 0–1); people speak in dB (−30 dB = a quiet bed).
export const dbToGain = (db: number) => 10 ** (db / 20);
export const gainToDb = (g: number) => (g > 0 ? 20 * Math.log10(g) : -Infinity);
export const fmtDb = (g: number) => (g > 0 ? `${gainToDb(g).toFixed(1)} dB` : '-∞ dB');

// set_music's level and fades → the project's music (all but src and credit). volume (0–1) or volume_db,
// never both; neither = 0.25 (≈ −12 dB, plenty under speech). fadeInSec is only written when there is one.
export function musicOf({volume, volume_db, fade_in_sec = 0, fade_out_sec = 1.5, duck = true}: {volume?: number; volume_db?: number; fade_in_sec?: number; fade_out_sec?: number; duck?: boolean}): Omit<NonNullable<Music>, 'src' | 'credit'> {
  if (volume != null && volume_db != null) throw new Error('give volume (0–1) or volume_db, not both');
  if (!(fade_in_sec >= 0 && fade_in_sec <= 10)) throw new Error('fade_in_sec: 0–10 s');
  const gain = volume ?? (volume_db != null ? dbToGain(volume_db) : 0.25);
  if (!(gain >= 0 && gain <= 1)) throw new Error('volume: 0–1 (volume_db ≤ 0)');
  return {volume: gain, startSec: 0, ...(fade_in_sec > 0 ? {fadeInSec: fade_in_sec} : {}), fadeOutSec: fade_out_sec, duck, duckLevel: 0.25};
}

// The music's gain at frame f of the reel (the timeline frame: a looping track keeps counting across its
// passes, MusicTrack's loopVolumeCurveBehavior "extend"): volume × fade-in × fade-out × duck. The factors multiply, so the music
// still dips under speech during a fade. speech = [startMs, endMs] runs of spoken words (src/layers.ts).
const DUCK_RAMP_MS = 250; // ease the dip in/out
export function musicGain(music: NonNullable<Music>, f: number, fps: number, totalFrames: number, speech: Array<[number, number]>): number {
  const inFrames = Math.round((music.fadeInSec ?? 0) * fps), outFrames = Math.round((music.fadeOutSec ?? 0) * fps);
  let v = music.volume;
  if (inFrames > 0) v *= Math.min(1, Math.max(0, f / inFrames));
  if (outFrames > 0) v *= Math.min(1, Math.max(0, (totalFrames - f) / outFrames));
  if (music.duck && speech.length) {
    const ms = (f / fps) * 1000;
    let dist = Infinity; // distance to the nearest speech span (0 = inside)
    for (const [a, b] of speech) {
      if (ms >= a && ms <= b) { dist = 0; break; }
      dist = Math.min(dist, ms < a ? a - ms : ms - b);
    }
    const k = Math.min(1, dist / DUCK_RAMP_MS); // 0 in speech → ducked, 1 far away
    const duckLevel = music.duckLevel ?? 0.25;
    v *= duckLevel + (1 - duckLevel) * k;
  }
  return v;
}

// ---------- wind (T16): scripts/wind-scan.mjs measures a source, this decides ----------
// In the pauses of a take (windows between its first and last word, at least padMs from every word — the whole
// source: a cut reel keeps next to no pause, and the wind is the take's, not the edit's), the noise floor (median
// whole-band dB of the quieter half) and how far the band under 150 Hz sits under it (median of low − full there):
// wind is a loud floor that lives under 150 Hz. It only warns and names the preset — never applies it.
// Calibrated (floor dB / share under 150 Hz dB): César's takes G1 −27 / −18, G2 hook −30 / −12, body −35 / −10,
// close −23 / −12 (G10 and his finished exports have < 1 s of pause: nothing to tell); an indoor take with HVAC
// rumble −50 / −0.5 (a quiet floor: not wind); synthetic brown noise under 100 Hz beneath a voice −25 / −0.3
// (wind; −42 / −1.3 after the preset), pink room tone −66 / −3.
// ponytail: a loud pinkish floor (traffic, −40 dB) passes the share too and gets the "wind?" question — the preset
// helps there as well; a spectral-slope test if that turns out noisy
export const WIND = {fps: 10, padMs: 250, minGapSec: 1, floorDb: -45, lowDb: -5};
export type WindScan = {fps: number; full: number[]; low: number[]; error?: string};
type Span = {startMs: number; endMs: number};
const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : NaN; };
// words: everything said in the source (any voice)
export function windOf(scan: WindScan, words: Span[]): {floorDb: number; lowDb: number; gapSec: number} | null {
  if (!words.length) return null;
  const first = Math.min(...words.map((w) => w.startMs)), last = Math.max(...words.map((w) => w.endMs));
  const gap: number[] = [];
  for (let k = 0; k < scan.full.length; k++) {
    const t = ((k + 0.5) / scan.fps) * 1000;
    if (t > first && t < last && !words.some((w) => t > w.startMs - WIND.padMs && t < w.endMs + WIND.padMs)) gap.push(k);
  }
  if (gap.length < WIND.minGapSec * scan.fps) return null; // too little pause to tell
  // the quieter half of the pauses: a breath, a word the ASR missed or a door is louder than the floor it sits on
  const quiet = [...gap].sort((a, b) => scan.full[a] - scan.full[b]).slice(0, Math.ceil(gap.length / 2));
  return {floorDb: median(quiet.map((k) => scan.full[k])), lowDb: median(quiet.map((k) => scan.low[k] - scan.full[k])), gapSec: gap.length / scan.fps};
}
export const windy = (w: ReturnType<typeof windOf>) => !!w && w.floorDb > WIND.floorDb && w.lowDb >= WIND.lowDb;

// one warning per windy source the reel uses (validate: mcp/checks.mjs projectIssues; the editor's Validate).
// scans: src → its wind scan (undefined / null = not scanned yet: skipped); words: src → what is said in the whole source
type WindIssue = {level: 'warn'; code: 'wind'; msg: string; ref: string};
export function windIssues(p: {clips: {id: string; src: string}[]; audio?: AudioOptions}, scans: Record<string, WindScan | null | undefined>, words: Record<string, Span[]>): WindIssue[] {
  if (p.audio?.clean === 'wind') return [];
  const out: WindIssue[] = [];
  for (const src of new Set(p.clips.map((c) => c.src))) {
    const scan = scans[src];
    const w = scan && !scan.error ? windOf(scan, words[src] ?? []) : null;
    if (!windy(w)) continue;
    const ids = p.clips.filter((c) => c.src === src).map((c) => c.id);
    out.push({level: 'warn', code: 'wind', ref: ids[0], msg: `${src} (${ids.join(', ')}): wind? In the pauses of the take the noise floor is ${w!.floorDb.toFixed(0)} dB and ${Math.round(10 ** (w!.lowDb / 10) * 100)} % of it is under 150 Hz — set_audio clean: wind (low cut at 130 Hz + denoise on the final mix, music bass too; listen before and after), or leave it`});
  }
  return out;
}
