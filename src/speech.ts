// Off-mic voice: a second person away from the microphone (a director feeding
// lines from behind the camera) gets transcribed like the presenter, only
// 6–10 dB quieter. Pure loudness statistics — no ML, no fs — so it works on any
// clip with audio. Whole takes are flagged (runs split at pauses / sentence
// ends), and nothing is flagged when the clip has one voice at one level.
// ponytail: loudness only; a lip-motion signal would rescue soft on-camera takes
// (MediaPipe FaceLandmarker crashes on macOS with mediapipe 1.0.1 — see PLAN.md).

export type Loudness = {fps: number; db: number[]}; // dBFS per window
export type SpokenWord = {word: string; startMs: number; endMs: number; off?: boolean};

export const DROP_DB = 6; // the two voices must sit at least this far apart
const MIN_SHARE = 0.15; // …and the quiet one must be a real share of the speech, not one soft aside
const GAP_MS = 350; // a pause longer than this starts a new take
const SENT_END = /[.!?]$/;
const MIN_WORD_MS = 120; // shorter words are too noisy to measure

// per-window RMS in dBFS from mono float samples
export function loudnessFromPcm(pcm: ArrayLike<number>, sampleRate: number, fps = 50): Loudness {
  const win = Math.round(sampleRate / fps);
  const db: number[] = [];
  for (let i = 0; i < pcm.length; i += win) {
    const n = Math.min(win, pcm.length - i);
    let s = 0;
    for (let k = 0; k < n; k++) s += pcm[i + k] * pcm[i + k];
    db.push(Math.round(20 * Math.log10(Math.sqrt(s / n) + 1e-9) * 10) / 10);
  }
  return {fps, db};
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

export function wordDb(w: {startMs: number; endMs: number}, loud: Loudness): number {
  const a = Math.floor((w.startMs / 1000) * loud.fps);
  const b = Math.max(a + 1, Math.ceil((w.endMs / 1000) * loud.fps));
  return median(loud.db.slice(a, b));
}

// takes: consecutive words with no long pause or sentence end between them
export function runsOf<T extends SpokenWord>(words: T[], gapMs = GAP_MS): T[][] {
  const runs: T[][] = [];
  let cur: T[] = [];
  words.forEach((w, i) => {
    const prev = words[i - 1];
    if (cur.length && prev && (w.startMs - prev.endMs > gapMs || SENT_END.test(prev.word))) {
      runs.push(cur);
      cur = [];
    }
    cur.push(w);
  });
  if (cur.length) runs.push(cur);
  return runs;
}

// mark every word of a take that sits dropDb under the presenter's level
export function flagOffMic<T extends SpokenWord>(words: T[], loud: Loudness, dropDb = DROP_DB): T[] {
  if (!loud?.db?.length || words.length < 2) return words;
  const runs = runsOf(words)
    .map((run) => {
      const measurable = run.filter((w) => w.endMs - w.startMs >= MIN_WORD_MS);
      const level = median((measurable.length ? measurable : run).map((w) => wordDb(w, loud)).filter((x) => Number.isFinite(x)));
      return {run, level, dur: run[run.length - 1].endMs - run[0].startMs};
    })
    .filter((r) => Number.isFinite(r.level));
  if (runs.length < 2) return words;
  // split the takes into a quiet and a loud group where it separates them best
  // (Otsu on take levels, weighted by duration); only a clear, sizeable quiet
  // group counts as a second voice — a presenter's own soft sentence does not
  const sorted = [...runs].sort((a, b) => a.level - b.level);
  const total = sorted.reduce((n, r) => n + r.dur, 0);
  let best = {score: -1, cut: 0, share: 0, gap: 0};
  let w0 = 0, s0 = 0;
  for (let k = 1; k < sorted.length; k++) {
    w0 += sorted[k - 1].dur; s0 += sorted[k - 1].dur * sorted[k - 1].level;
    const w1 = total - w0;
    if (!w0 || !w1) continue;
    const s1 = sorted.reduce((n, r) => n + r.dur * r.level, 0) - s0;
    const m0 = s0 / w0, m1 = s1 / w1;
    const score = w0 * w1 * (m1 - m0) ** 2;
    if (score > best.score) best = {score, cut: k, share: w0 / total, gap: m1 - m0};
  }
  if (best.gap < dropDb || best.share < MIN_SHARE) return words;
  const quiet = new Set(sorted.slice(0, best.cut));
  // a take under 300 ms ("They", "Or", "Sorry.") is too short to measure: it
  // goes with the take it continues — the next one when it opens a sentence,
  // otherwise whichever neighbour is closer in time
  const isOff = runs.map((r) => quiet.has(r));
  runs.forEach((r, i) => {
    if (r.dur >= 300) return;
    const prev = runs[i - 1], next = runs[i + 1];
    if (!prev && !next) return;
    const opens = !prev || SENT_END.test(prev.run[prev.run.length - 1].word);
    const gapPrev = prev ? r.run[0].startMs - prev.run[prev.run.length - 1].endMs : Infinity;
    const gapNext = next ? next.run[0].startMs - r.run[r.run.length - 1].endMs : Infinity;
    const follow = (opens && next) || (gapNext < gapPrev ? next : prev);
    isOff[i] = quiet.has(follow!);
  });
  const off = new Set<T>();
  runs.forEach((r, i) => { if (isOff[i]) for (const w of r.run) off.add(w); });
  return words.map((w) => (off.has(w) ? {...w, off: true} : w));
}
