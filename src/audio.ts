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
// The floor of a take: its quietest QUIET_SHARE of 100 ms windows between the first and the last word (the whole
// source — a cut reel keeps next to no pause, and the wind is the take's, not the edit's), found by the audio's own
// energy, never by word bounds: Deepgram's words touch end to end (no gap between them to measure), WhisperX's
// leave the pauses out — the same take reads the same either way. There: the noise floor (median whole-band dB)
// and how far the band under 150 Hz sits under it (median of low − full): wind is a loud floor that lives under
// 150 Hz. It only warns and names the preset — never applies it.
// Calibrated (floor dB / low − full dB): César's raw takes G1 −30 / −16, G2 hook −35 / −12, body −39 / −11, close
// −29 / −12, G10 −39 / −17; his finished exports (voice over a music bed) Morantes1 −33 / −4.7, 2.x −33 / −6.5,
// 4.x −36 / −7.4, 3.x −36 / −14 — the negatives next to the line; an indoor take with HVAC rumble −50 / −0.7 (a
// quiet floor: not wind); G1 with brown noise under 100 Hz mixed in −21 / −1.0 and a synthetic voice over it
// −25 / −0.3 (wind).
// ponytail: a loud floor with half its energy under 150 Hz (a music bed heavy on bass, traffic) also gets the
// "wind?" question — a spectral-slope test if that turns out noisy
export const WIND = {fps: 10, quietShare: 0.15, minSec: 1, floorDb: -45, lowDb: -3};
export type WindScan = {fps: number; full: number[]; low: number[]; error?: string};
type Span = {startMs: number; endMs: number};
const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : NaN; };
// words: everything said in the source (any voice) — only its first and last word are read: before and after them
// is a slate, handling, silence
export function windOf(scan: WindScan, words: Span[]): {floorDb: number; lowDb: number; quietSec: number} | null {
  if (!words.length) return null;
  const a = Math.max(0, Math.floor((Math.min(...words.map((w) => w.startMs)) / 1000) * scan.fps));
  const b = Math.min(scan.full.length, Math.ceil((Math.max(...words.map((w) => w.endMs)) / 1000) * scan.fps));
  const span = Array.from({length: Math.max(0, b - a)}, (_, k) => a + k);
  const quiet = span.sort((x, y) => scan.full[x] - scan.full[y]).slice(0, Math.ceil(span.length * WIND.quietShare));
  if (quiet.length < WIND.minSec * scan.fps) return null; // too short a take to tell
  return {floorDb: median(quiet.map((k) => scan.full[k])), lowDb: median(quiet.map((k) => scan.low[k] - scan.full[k])), quietSec: quiet.length / scan.fps};
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
    out.push({level: 'warn', code: 'wind', ref: ids[0], msg: `${src} (${ids.join(', ')}): wind? In the quietest moments of the take the noise floor is ${w!.floorDb.toFixed(0)} dB and ${Math.round(10 ** (w!.lowDb / 10) * 100)} % of it is under 150 Hz — set_audio clean: wind (low cut at 130 Hz + denoise on the final mix, music bass too; listen before and after), or leave it`});
  }
  return out;
}
