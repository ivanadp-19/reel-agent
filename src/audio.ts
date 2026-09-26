// Voice cleanup options for the final render (scripts/qc.mjs applies `af`
// before loudness normalization; drafts are untouched), and the music bed's
// level and fades. Data and pure functions only, so the editor and the MCP
// tool can use them without importing ffmpeg code.
import type {Music} from './timeline.ts';

export const CLEAN = {
  off: {desc: 'nothing', af: ''},
  light: {desc: 'low cut at 80 Hz + gentle spectral denoise (room hiss, hum)', af: 'highpass=f=80,afftdn=nf=-25:nr=10:nt=w'},
  strong: {desc: 'low cut at 100 Hz + heavier denoise + de-esser', af: 'highpass=f=100,afftdn=nf=-30:nr=18:nt=w,deesser=i=0.35'},
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
