// Off-mic voice: a second person away from the microphone (a director feeding
// lines from behind the camera) gets transcribed like the presenter, only
// 6–10 dB quieter. Pure loudness statistics — no ML, no fs — so it works on any
// clip with audio. Whole takes are flagged (runs split at pauses / sentence
// ends), and nothing is flagged when the clip has one voice at one level.
// With speaker diarization (scripts/diarize.py, pyannote, needs HF_TOKEN) the decision is made
// per SPEAKER instead of per take: the diarizer says who each stretch belongs to, the loudness says
// which of those voices is away from the mic — so a presenter's own soft sentence stays hers, and a
// director who says more words than the presenter is still the off-mic one. Loudness alone remains
// the fallback when there is no diarization.

export type Loudness = {fps: number; db: number[]}; // dBFS per window
export type SpokenWord = {word: string; startMs: number; endMs: number; off?: boolean; speaker?: string};
export type Turn = [startSec: number, endSec: number, label: string]; // a diarizer's speaker turn

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

// give every word the speaker whose turn it overlaps most; labels become spk1, spk2… in order of first
// appearance (stable across runs of the same audio). A word no turn touches keeps no speaker.
export function assignSpeakers<T extends SpokenWord>(words: T[], turns: Turn[]): T[] {
  if (!turns?.length) return words;
  const names = new Map<string, string>();
  return words.map((w) => {
    let best: string | null = null, bo = 0;
    for (const [s, e, label] of turns) {
      const o = Math.min(w.endMs, e * 1000) - Math.max(w.startMs, s * 1000);
      if (o > bo) { bo = o; best = label; }
    }
    if (best == null) return w;
    if (!names.has(best)) names.set(best, `spk${names.size + 1}`);
    return {...w, speaker: names.get(best)!};
  });
}

// the speakers whose median level sits dropDb under the loudest speaker (empty with one speaker, or
// when every voice is at the same level)
export function offMicSpeakers<T extends SpokenWord>(words: T[], loud: Loudness, dropDb = DROP_DB): string[] {
  if (!loud?.db?.length) return [];
  const by = new Map<string, number[]>();
  for (const w of words) {
    if (!w.speaker || w.endMs - w.startMs < MIN_WORD_MS) continue;
    const d = wordDb(w, loud);
    if (Number.isFinite(d)) by.set(w.speaker, [...(by.get(w.speaker) ?? []), d]);
  }
  if (by.size < 2) return [];
  const level = [...by].map(([spk, ds]) => [spk, median(ds)] as const);
  const top = Math.max(...level.map(([, d]) => d));
  return level.filter(([, d]) => top - d >= dropDb).map(([spk]) => spk);
}

// off-mic by speaker when the words carry speakers and one voice is clearly quieter; else by take
export function flagOffMicBySpeaker<T extends SpokenWord>(words: T[], loud: Loudness, dropDb = DROP_DB): T[] {
  const off = new Set(offMicSpeakers(words, loud, dropDb));
  if (!off.size) return words.some((w) => w.speaker) ? words : flagOffMic(words, loud, dropDb);
  return words.map((w) => (w.speaker && off.has(w.speaker) ? {...w, off: true} : w));
}


// Voice activity from the loudness track: the spans where the energy sits
// clearly above the clip's own noise floor. WhisperX drops words (a quiet
// presenter, fillers it does not align, overlap); the energy is still there,
// so autocut can tell "a pause where the person is still talking" from real
// silence instead of cutting through speech. Adaptive per source: the floor is
// a low percentile of the track itself, the threshold rides VOICE_DB over it
// (never below -45 dBFS). Dips up to dipMs are bridged (word gaps), blips
// under blipMs dropped (clicks, bumps). No ML, no fs — works on any clip.
export const VOICE_DB = 10; // how far above the noise floor a window must sit to count as voice
const VOICE_DIP_MS = 150; // word gaps inside a phrase: shorter dips do not end a span
const VOICE_BLIP_MS = 100; // an isolated bump shorter than this is not speech

export function voiceSpans(loud: Loudness, opts: {voiceDb?: number; dipMs?: number; blipMs?: number} = {}): [startSec: number, endSec: number][] {
  if (!loud?.db?.length) return [];
  const {fps, db} = loud;
  const voiceDb = opts.voiceDb ?? VOICE_DB;
  const sorted = [...db].sort((a, b) => a - b);
  const floor = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.15))];
  const peak = sorted[Math.floor(sorted.length * 0.99)];
  if (!Number.isFinite(floor) || peak - floor < voiceDb) return []; // one flat level: no voice stands out
  const thresh = Math.max(floor + voiceDb, -45);
  const dip = Math.max(1, Math.round(((opts.dipMs ?? VOICE_DIP_MS) / 1000) * fps));
  const blipMs = opts.blipMs ?? VOICE_BLIP_MS;
  const spans: [number, number][] = [];
  let open = -1, lastOn = -1;
  for (let i = 0; i <= db.length; i++) {
    const on = i < db.length && db[i] >= thresh;
    if (on) { if (open < 0) open = i; lastOn = i; }
    else if (open >= 0 && i - lastOn > dip) { spans.push([open / fps, (lastOn + 1) / fps]); open = -1; }
  }
  return spans.filter(([a, b]) => (b - a) * 1000 >= blipMs);
}

// does any voice span cover a real stretch of the (aMs, bMs) gap?
export function voiceInGap(spans: [number, number][], aMs: number, bMs: number, minMs = 120): boolean {
  return spans.some(([s, e]) => Math.min(e * 1000, bMs) - Math.max(s * 1000, aMs) >= minMs);
}
