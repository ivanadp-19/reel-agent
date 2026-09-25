// Cut candidates: what an editor would trim from a talking-head take, found
// deterministically from the word-level transcript. The agent reviews them and
// approves each with cut_words; nothing is cut here.
//   filler   — hesitations (um, uh, eh, mmm; "you know", "o sea"; "este" only between pauses)
//   meta     — talk about the recording ("sorry", "say it again", "otra vez", "te lo repito", "a cuadro")
//   retake   — an attempt the speaker said again; the kept take is the LAST complete one (a
//              presenter reads the line to herself, then performs it: rehearsal first, take last —
//              the same prior Descript's Remove Retakes and TimeBolt use)
//   off-mic  — a second, quieter voice (see speech.ts) that is not part of a retake cluster
// An attempt is a sentence, not a breath: runs that pause without ending the sentence are joined
// (up to JOIN_MS), so a take said with a pause in it competes whole against a rehearsal read in
// one breath. Pure: no fs. Words carry source-relative ms and their index in the source transcript.

import {longestSilenceMs, voiceSpans, type Loudness} from './speech.ts';

export type TWord = {i: number; word: string; startMs: number; endMs: number; off?: boolean; speaker?: string};
export type TClip = {clipId: string; source: string; words: TWord[]};
export type Candidate = {kind: 'filler' | 'meta' | 'retake' | 'off-mic'; clipId: string; from: string; to: string; text: string; keep?: {from: string; text: string}; note?: string};

const norm = (w: string) => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ$%']/g, '');
const SENT_END = /[.!?]["')\]]*$/;

const FILLERS = new Set(['um', 'umm', 'uh', 'uhm', 'uhh', 'er', 'erm', 'ah', 'ahh', 'hmm', 'hm', 'mm', 'mmm', 'mhm', 'eh', 'ehh', 'em', 'emm', 'eeh', 'mmmm']);
const FILLER_PAIRS = new Set(['you know', 'i mean', 'o sea', 'es decir', 'o sease']);
const PAUSED_FILLERS = new Set(['este', 'pues', 'like', 'so', 'okay', 'ok', 'bueno']); // only when isolated by pauses
const META = [/\bsorry\b/, /\bsay it again\b/, /\bone more time\b/, /\blet me (start|try) (over|again)\b/, /\b(start|try) (over|again)\b/, /\bwait\b/, /\boh my god\b/, /\bclose\b$/, /\bfrom the top\b/, /\btake two\b/, /\brolling\b/,
  /\bperdon\b/, /\botra vez\b/, /\bde nuevo\b/, /\bcorta\b/, /\bespera\b/, /\bme equivoque\b/, /\bno me sale\b/, /\brepito\b/, /\bvamos a grabar\b/, /\ba cuadro\b/, /\bno lei\b/, /\bdos veces\b/, /\bdesde el principio\b/, /\bla ultima\b/];
const META_MAX = 10; // tokens: direction talk is short
const JOIN_MS = 2500; // a pause up to this long inside a sentence does not end the attempt

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
// the same attempt said twice: most of the longer one repeats — or `a`, said EARLIER, is a false start
// of `b`: at least two words, shorter, and nearly all of it opens `b` (a suffix or a phrase merely
// contained in an earlier sentence is not a retake: "…tu propia cava?" / "Tu propia cava, …")
export function similar(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  if (lcs(a, b) / Math.max(a.length, b.length) >= 0.6) return true;
  return a.length >= 2 && a.length < b.length && lcs(a, b.slice(0, a.length + 2)) / a.length >= 0.75;
}

type Run = {clip: TClip; words: TWord[]; tokens: string[]; off: boolean; complete: boolean};
const isMeta = (r: Run) => r.tokens.length <= META_MAX && META.some((re) => re.test(r.tokens.join(' ')));
// attempts: words between sentence ends or pauses longer than gapMs…
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
// …joined into sentences: a run that pauses without ending its sentence continues into the next one
// (same voice, gap ≤ JOIN_MS, neither is direction talk)
function attemptsOf(clip: TClip, gapMs: number): Run[] {
  const out: Run[] = [];
  for (const r of runsOf(clip, gapMs)) {
    const last = out[out.length - 1];
    const gap = last ? r.words[0].startMs - last.words[last.words.length - 1].endMs : Infinity;
    if (last && !last.complete && last.off === r.off && gap <= JOIN_MS && !isMeta(last) && !isMeta(r)) {
      last.words = [...last.words, ...r.words];
      last.tokens = [...last.tokens, ...r.tokens];
      last.complete = r.complete;
    } else out.push({...r});
  }
  return out;
}

const wid = (r: Run, w: TWord) => `${r.clip.source}:${w.i}`;
const text = (ws: TWord[]) => ws.map((w) => w.word).join(' ');

export function findCutCandidates(clips: TClip[], opts: {gapMs?: number; windowMs?: number} = {}): Candidate[] {
  const gapMs = opts.gapMs ?? 700;
  const windowMs = opts.windowMs ?? 30000;
  const out: Candidate[] = [];
  const runs = clips.flatMap((c) => attemptsOf(c, gapMs));
  const cut = new Set<Run>();

  // meta talk: a short attempt about the recording itself
  for (const r of runs) {
    if (isMeta(r)) {
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
    // keep: the LAST take by the on-mic voice that says the whole line — complete and close to the
    // longest; failing that, the last one that says most of it; failing that, the last one. Never the
    // longest for its own sake: a rehearsal read in one breath is often the longest run
    const own = cl.filter((r) => !r.off);
    const pool = own.length ? own : cl;
    const longest = Math.max(...pool.map((r) => r.tokens.length));
    const good = pool.filter((r) => r.complete && r.tokens.length >= 0.8 * longest);
    const most = pool.filter((r) => r.tokens.length >= 0.6 * longest);
    const keep = (good.length ? good : most.length ? most : pool).at(-1)!;
    for (const r of cl) {
      if (r === keep) continue;
      out.push({kind: 'retake', clipId: r.clip.clipId, from: wid(r, r.words[0]), to: wid(r, r.words[r.words.length - 1]), text: text(r.words), keep: {from: wid(keep, keep.words[0]), text: text(keep.words)}, note: r.off ? 'off-mic voice' : r.tokens.length < 0.7 * keep.tokens.length ? 'false start' : undefined}); // a near-full repeat is just a retake
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
//
// Words come from WhisperX, and WhisperX drops words it cannot align (a quiet
// presenter, fillers, overlap): a transcript gap is not always silence. With
// `loud` (the per-source loudness track, see speech.ts) a pause of up to
// bridgeMaxMs whose silences are all shorter than gapMs (a voice fills the
// hole) is NOT a cut point, and each run
// grows to the edges of the voice span it lives in, so a swallowed "eh…" or a
// clipped last word stays in the take. Gaps without energy keep the old
// behavior: they are cut. With `dropOff`, off-mic words (a second voice away
// from the mic) count as silence — and since they explain the energy in their
// gap, that gap is never bridged back into the take.
export const AUTOCUT = {gapMs: 600, leadPad: 0.1, trailPad: 0.3, innerPad: 0.08, minLen: 0.35, bridgeMaxMs: 1500};
export function speechSegments(
  words: {startMs: number; endMs: number; off?: boolean}[],
  clip: {inSec: number; outSec: number},
  o: typeof AUTOCUT & {loud?: Loudness; dropOff?: boolean} = AUTOCUT,
): {inSec: number; outSec: number}[] {
  const inMs = clip.inSec * 1000, outMs = clip.outSec * 1000;
  const all = words.filter((w) => w.endMs > inMs && w.startMs < outMs);
  const off = o.dropOff ? all.filter((w) => w.off) : [];
  const ws = o.dropOff ? all.filter((w) => !w.off) : all;
  if (!ws.length) return [];
  const spans = o.loud ? voiceSpans(o.loud) : [];
  const bridgeMax = o.bridgeMaxMs;
  const offIn = (aMs: number, bMs: number) => off.some((w) => w.startMs < bMs && w.endMs > aMs);
  // a pause worth keeping: short enough, no silence longer than gapMs inside it
  // (the voice fills the hole), and not explained by an off-mic word we drop
  const bridgeable = (aMs: number, bMs: number) => bMs - aMs <= bridgeMax && !offIn(aMs, bMs) && longestSilenceMs(spans, aMs, bMs) <= o.gapMs;
  const runs: [number, number][] = [];
  let start = ws[0].startMs;
  ws.forEach((w, k) => {
    const next = ws[k + 1];
    // a dropped off-mic word splits the take however short the gaps around it are
    if (!next || offIn(w.endMs, next.startMs) || (next.startMs - w.endMs > o.gapMs && !bridgeable(w.endMs, next.startMs))) {
      runs.push([start, w.endMs]);
      if (next) start = next.startMs;
    }
  });
  // grow each run to the edges of the voice span it lives in (never more than
  // bridgeMax past its words, never into an off-mic word we are dropping)
  const grown = runs.map(([a, b]): [number, number] => {
    const head = spans.find(([s, e]) => s * 1000 <= a && e * 1000 >= a);
    const tail = spans.find(([s, e]) => s * 1000 <= b && e * 1000 >= b);
    let lo = head && a - head[0] * 1000 <= bridgeMax ? head[0] * 1000 : a;
    let hi = tail && tail[1] * 1000 - b <= bridgeMax ? tail[1] * 1000 : b;
    for (const w of off) {
      if (w.startMs < a && w.endMs > lo) lo = Math.min(a, Math.max(lo, w.endMs));
      if (w.endMs > b && w.startMs < hi) hi = Math.max(b, Math.min(hi, w.startMs));
    }
    return [lo, hi];
  });
  return grown
    .map(([a, b], i) => ({
      inSec: Math.max(clip.inSec, a / 1000 - (i === 0 ? o.leadPad : o.innerPad)),
      outSec: Math.min(clip.outSec, b / 1000 + (i === grown.length - 1 ? o.trailPad : o.innerPad)),
    }))
    .filter((s) => s.outSec - s.inSec >= o.minLen);
}

// ---- word cuts: what cut_words and the editor's Transcript panel do with approved ranges ----
// A range is "<source>:<i>" … "<source>:<i>" on one clip. The cut points snap into the pauses
// around the words (SNAP_MS into the pause, never closer than 40 ms to a neighbour), so no
// syllable is clipped; overlapping ranges become one span. Pure: no fs.
import {cutRange, reanchor, type Clip} from './timeline.ts';
export type CutRange = {from_wid: string; to_wid?: string};
export type CutSpan = {src: string; startMs: number; endMs: number; text: string};
export const SNAP_MS = 150;
const sourceOf = (src: string) => src.split('/').pop()!.replace(/\.[^.]+$/, '');

type Hit = {ok: false; error: string} | {ok: true; entry: TClip; clip: Clip; word: TWord; k: number; prev?: TWord; next?: TWord};
function wordAt(tr: TClip[], clips: Clip[], wid: string): Hit {
  const k = wid.lastIndexOf(':');
  const source = wid.slice(0, k), i = wid.slice(k + 1);
  const entry = tr.filter((t) => t.source === source).find((t) => t.words.some((w) => String(w.i) === i));
  if (!entry) return {ok: false, error: `no word ${wid} on the timeline (see the transcript)`};
  const clip = clips.find((c) => c.id === entry.clipId);
  if (!clip) return {ok: false, error: `clip ${entry.clipId} of ${wid} is not on the timeline any more — transcribe again`};
  const j = entry.words.findIndex((w) => String(w.i) === i);
  return {ok: true, entry, clip, word: entry.words[j], k: j, prev: entry.words[j - 1], next: entry.words[j + 1]};
}

export function planWordCuts(tr: TClip[], clips: Clip[], ranges: CutRange[]): {spans: CutSpan[]; errors: string[]} {
  const errors: string[] = [];
  const plans: CutSpan[] = [];
  for (const r of ranges) {
    const a = wordAt(tr, clips, r.from_wid);
    if (!a.ok) { errors.push(a.error); continue; }
    const b = r.to_wid ? wordAt(tr, clips, r.to_wid) : a;
    if (!b.ok) { errors.push(b.error); continue; }
    if (a.entry.clipId !== b.entry.clipId) { errors.push(`${r.from_wid} and ${r.to_wid} sit on different clips (${a.entry.clipId}, ${b.entry.clipId}) — give them as two ranges`); continue; }
    if (b.k < a.k) { errors.push(`${r.to_wid} comes before ${r.from_wid}`); continue; }
    const inMs = a.clip.inSec * 1000, outMs = a.clip.outSec * 1000;
    const startMs = a.prev ? Math.min(a.word.startMs, Math.max(a.prev.endMs + 40, a.word.startMs - SNAP_MS)) : inMs;
    const endMs = b.next ? Math.max(b.word.endMs, Math.min(b.next.startMs - 40, b.word.endMs + SNAP_MS)) : outMs;
    plans.push({src: a.clip.src, startMs, endMs, text: a.entry.words.slice(a.k, b.k + 1).map((w) => w.word).join(' ')});
  }
  plans.sort((x, y) => (x.src === y.src ? x.startMs - y.startMs : x.src < y.src ? -1 : 1));
  const spans: CutSpan[] = [];
  for (const c of plans) {
    const last = spans[spans.length - 1];
    if (last && last.src === c.src && c.startMs <= last.endMs) { last.endMs = Math.max(last.endMs, c.endMs); last.text += ` ${c.text}`; }
    else spans.push({...c});
  }
  return {spans, errors};
}

// Apply the spans (each inside one clip, found again by source time since earlier cuts only
// removed other spans); B-roll follows its footage; a piece left between two cuts that holds
// no word at all is dead air and is dropped.
export function applyWordCuts<B extends {clipId?: string; startMs: number}>(clips: Clip[], brolls: B[], spans: CutSpan[], tr: TClip[]): {clips: Clip[]; brolls: B[]; lines: string[]} {
  const lines: string[] = [];
  const pieces = new Set<string>();
  const f1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
  for (const c of spans) {
    const clip = clips.find((k) => k.src === c.src && k.inSec * 1000 <= c.startMs + 1 && k.outSec * 1000 >= c.endMs - 1);
    const r = clip && cutRange(clips, clip.id, c.startMs / 1000, c.endMs / 1000);
    if (!r) { lines.push(`skipped "${c.text}" (not on the timeline any more)`); continue; }
    clips = r.clips; brolls = reanchor(brolls, r.remap);
    for (const s of r.remap) pieces.add(s.segId);
    lines.push(`cut "${c.text}" — ${f1((c.endMs - c.startMs) / 1000)}s of ${sourceOf(c.src)} (${f1(c.startMs / 1000)}–${f1(c.endMs / 1000)})`);
  }
  const words = new Map<string, TWord[]>();
  for (const t of tr) words.set(t.source, [...(words.get(t.source) ?? []), ...t.words]);
  const silent = clips.filter((k) => pieces.has(k.id) && k.outSec - k.inSec < 4 && !(words.get(sourceOf(k.src)) ?? []).some((w) => w.endMs > k.inSec * 1000 && w.startMs < k.outSec * 1000));
  if (silent.length) {
    clips = clips.filter((k) => !silent.includes(k));
    lines.push(`dropped ${silent.length} silent piece(s) left between cuts (${f1(silent.reduce((n, k) => n + k.outSec - k.inSec, 0))}s)`);
  }
  return {clips, brolls, lines};
}
