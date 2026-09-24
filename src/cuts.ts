// Cut candidates: what an editor would trim from a talking-head take, found
// deterministically from the word-level transcript. The agent reviews them and
// approves each with cut_words; nothing is cut here.
//   filler   — hesitations (um, uh, eh, mmm; "you know", "o sea"; "este" only between pauses)
//   meta     — talk about the recording ("sorry", "say it again", "otra vez", "corta")
//   retake   — an attempt the speaker said again; the kept take is the last complete one
//   off-mic  — a second, quieter voice (see speech.ts) that is not part of a retake cluster
// Pure: no fs. Words carry source-relative ms and their index in the source transcript.

export type TWord = {i: number; word: string; startMs: number; endMs: number; off?: boolean};
export type TClip = {clipId: string; source: string; words: TWord[]};
export type Candidate = {kind: 'filler' | 'meta' | 'retake' | 'off-mic'; clipId: string; from: string; to: string; text: string; keep?: {from: string; text: string}; note?: string};

const norm = (w: string) => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ$%']/g, '');
const SENT_END = /[.!?]["')\]]*$/;

const FILLERS = new Set(['um', 'umm', 'uh', 'uhm', 'uhh', 'er', 'erm', 'ah', 'ahh', 'hmm', 'hm', 'mm', 'mmm', 'mhm', 'eh', 'ehh', 'em', 'emm', 'eeh', 'mmmm']);
const FILLER_PAIRS = new Set(['you know', 'i mean', 'o sea', 'es decir', 'o sease']);
const PAUSED_FILLERS = new Set(['este', 'pues', 'like', 'so', 'okay', 'ok', 'bueno']); // only when isolated by pauses
const META = [/\bsorry\b/, /\bsay it again\b/, /\bone more time\b/, /\blet me (start|try) (over|again)\b/, /\b(start|try) (over|again)\b/, /\bwait\b/, /\boh my god\b/, /\bclose\b$/, /\bperdon\b/, /\botra vez\b/, /\bde nuevo\b/, /\bcorta\b/, /\bespera\b/, /\bme equivoque\b/, /\bno me sale\b/];

// longest common subsequence length of two token lists
function lcs(a: string[], b: string[]): number {
  const dp = new Array(b.length + 1).fill(0);
  for (let x = 1; x <= a.length; x++) {
    let prev = 0;
    for (let y = 1; y <= b.length; y++) {
      const tmp = dp[y];
      dp[y] = a[x - 1] === b[y - 1] ? prev + 1 : Math.max(dp[y], dp[y - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}
// same attempt said twice: most of the longer one, or nearly all of a shorter (≥ 3 words) false start
export function similar(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  const l = lcs(a, b);
  const short = Math.min(a.length, b.length);
  return l / Math.max(a.length, b.length) >= 0.6 || (short >= 3 && l / short >= 0.75);
}

type Run = {clip: TClip; words: TWord[]; tokens: string[]; off: boolean; complete: boolean};
// attempts: words between sentence ends or pauses longer than gapMs
function runsOf(clip: TClip, gapMs: number): Run[] {
  const runs: Run[] = [];
  let cur: TWord[] = [];
  const push = () => {
    if (!cur.length) return;
    const offShare = cur.filter((w) => w.off).length / cur.length;
    runs.push({clip, words: cur, tokens: cur.map((w) => norm(w.word)).filter(Boolean), off: offShare > 0.5, complete: SENT_END.test(cur[cur.length - 1].word)});
    cur = [];
  };
  clip.words.forEach((w, k) => {
    const prev = clip.words[k - 1];
    if (prev && (w.startMs - prev.endMs > gapMs || SENT_END.test(prev.word) || !!w.off !== !!prev.off)) push();
    cur.push(w);
  });
  push();
  return runs;
}

const wid = (r: Run, w: TWord) => `${r.clip.source}:${w.i}`;
const text = (ws: TWord[]) => ws.map((w) => w.word).join(' ');

export function findCutCandidates(clips: TClip[], opts: {gapMs?: number; windowMs?: number} = {}): Candidate[] {
  const gapMs = opts.gapMs ?? 700;
  const windowMs = opts.windowMs ?? 30000;
  const out: Candidate[] = [];
  const runs = clips.flatMap((c) => runsOf(c, gapMs));
  const cut = new Set<Run>();

  // meta talk: a short attempt about the recording itself
  for (const r of runs) {
    const t = r.tokens.join(' ');
    if (r.tokens.length <= 8 && META.some((re) => re.test(t))) {
      out.push({kind: 'meta', clipId: r.clip.clipId, from: wid(r, r.words[0]), to: wid(r, r.words[r.words.length - 1]), text: text(r.words)});
      cut.add(r);
    }
  }

  // retakes: cluster attempts of the same source that repeat each other within the window
  const clusters: Run[][] = [];
  for (const r of runs) {
    if (cut.has(r) || r.tokens.length < 2) continue;
    const home = clusters.find((cl) => cl.some((o) => o.clip.source === r.clip.source && r.words[0].startMs - o.words[o.words.length - 1].endMs < windowMs && similar(o.tokens, r.tokens)));
    if (home) home.push(r); else clusters.push([r]);
  }
  for (const cl of clusters) {
    if (cl.length < 2) continue;
    // keep: the last complete take by the on-mic voice that is close to the longest one
    const own = cl.filter((r) => !r.off);
    const pool = own.length ? own : cl;
    const longest = Math.max(...pool.map((r) => r.tokens.length));
    const good = pool.filter((r) => r.complete && r.tokens.length >= 0.8 * longest);
    const keep = (good.length ? good : pool.filter((r) => r.tokens.length === longest)).at(-1)!;
    for (const r of cl) {
      if (r === keep) continue;
      out.push({kind: 'retake', clipId: r.clip.clipId, from: wid(r, r.words[0]), to: wid(r, r.words[r.words.length - 1]), text: text(r.words), keep: {from: wid(keep, keep.words[0]), text: text(keep.words)}, note: r.off ? 'off-mic voice' : r.tokens.length < keep.tokens.length ? 'false start' : undefined});
      cut.add(r);
    }
  }

  // off-mic attempts that did not fall into a retake cluster
  for (const r of runs) if (r.off && !cut.has(r)) {
    out.push({kind: 'off-mic', clipId: r.clip.clipId, from: wid(r, r.words[0]), to: wid(r, r.words[r.words.length - 1]), text: text(r.words)});
    cut.add(r);
  }

  // fillers inside what stays
  for (const r of runs) {
    if (cut.has(r)) continue;
    r.words.forEach((w, k) => {
      const t = norm(w.word);
      const next = r.words[k + 1];
      const pair = next ? `${t} ${norm(next.word)}` : '';
      const before = k ? w.startMs - r.words[k - 1].endMs : Infinity;
      const after = next ? next.startMs - w.endMs : Infinity;
      if (FILLERS.has(t)) out.push({kind: 'filler', clipId: r.clip.clipId, from: wid(r, w), to: wid(r, w), text: w.word});
      else if (FILLER_PAIRS.has(pair)) out.push({kind: 'filler', clipId: r.clip.clipId, from: wid(r, w), to: wid(r, next!), text: `${w.word} ${next!.word}`});
      else if (PAUSED_FILLERS.has(t) && before > 200 && after > 200 && r.words.length > 1) out.push({kind: 'filler', clipId: r.clip.clipId, from: wid(r, w), to: wid(r, w), text: w.word, note: 'between pauses'});
    });
  }
  const order = (c: Candidate) => +c.from.split(':').pop()!;
  return out.sort((a, b) => order(a) - order(b));
}

// Autocut plan for ONE clip: its speech runs (split at pauses > gapMs), padded,
// inside the clip's own trim window. Words are the source's (source ms); only
// those under the clip count — a piece of a take must never grow back into the
// rest of the source.
export const AUTOCUT = {gapMs: 600, leadPad: 0.1, trailPad: 0.3, innerPad: 0.08, minLen: 0.35};
export function speechSegments(words: {startMs: number; endMs: number}[], clip: {inSec: number; outSec: number}, o = AUTOCUT): {inSec: number; outSec: number}[] {
  const inMs = clip.inSec * 1000, outMs = clip.outSec * 1000;
  const ws = words.filter((w) => w.endMs > inMs && w.startMs < outMs);
  if (!ws.length) return [];
  const runs: [number, number][] = [];
  let start = ws[0].startMs;
  ws.forEach((w, k) => {
    const next = ws[k + 1];
    if (!next || next.startMs - w.endMs > o.gapMs) { runs.push([start, w.endMs]); if (next) start = next.startMs; }
  });
  return runs
    .map(([a, b], i) => ({
      inSec: Math.max(clip.inSec, a / 1000 - (i === 0 ? o.leadPad : o.innerPad)),
      outSec: Math.min(clip.outSec, b / 1000 + (i === runs.length - 1 ? o.trailPad : o.innerPad)),
    }))
    .filter((s) => s.outSec - s.inSec >= o.minLen);
}
