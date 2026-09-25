// Captions are anchored to a SOURCE file: `src` + word times relative to that
// source (0 = start of the untrimmed file). projectCaptions maps every WORD
// onto the current timeline through whichever clip(s) contain it, so trims,
// splits, autocut segments, reorders, speed changes and duplicated takes all
// keep the right words on screen — and words inside a removed range disappear.

import {nextId, placeClips, type Clip} from './timeline.ts';

export type CaptionWord = {
  wid?: string; // `${source}:${index}` from the transcript; absent on hand-typed words
  text: string;
  startMs: number;
  endMs: number;
  tier?: number; // 0 plain · 1 accent color · 2 big emphasis (see captionPresets)
  br?: boolean; // hard line break before this word (two-line phrase pages)
  emoji?: string; // one emoji that pops in right after the word
  speaker?: string; // spk1, spk2… who says it (diarization); presets may color or place pages per speaker later
};
export type Caption = {
  id: string;
  keyIn?: import('./motion.ts').ArriveKind; // per-page entry-animation override for tier words (demos, special moments)
  src: string; // staticFile-relative source path, e.g. "clips/IMG_0227.mp4"
  words: CaptionWord[]; // source-relative ms
  startMs: number;
  endMs: number;
  topPct: number;
  scale?: number; // size multiplier (1 = default), set via the on-preview slider
  pin?: boolean; // explicit vertical position: float presets honor topPct instead of cycling
  covers?: string[]; // hand-edited page: the transcript word ids it stands in for (re-paging skips them)
  behind?: boolean; // drawn behind the presenter (needs a person matte for its span, like behind graphics)
  shiftMs?: number; // shown this far off the time its words are said (edit_caption shift_ms): the text moves, the speech does not
  // projected only:
  clipId?: string; // the clip this projected page sits on
  holdMaxMs?: number; // clip's end — the visual hold must not bleed into the next clip
};

// older projects stored accent:boolean — map it onto tier 1
export function normalizeCaption(c: Caption): Caption {
  return {
    ...c,
    words: c.words.map((word) => {
      const {accent, ...w} = word as CaptionWord & {accent?: boolean};
      return {...w, tier: w.tier ?? (accent ? 1 : 0)};
    }),
  };
}

// Source-relative captions → absolute timeline pages. A page whose words span a
// cut becomes one page per clip; a source placed twice shows its captions twice.
export function projectCaptions(captions: Caption[], clips: Clip[], fps: number): Caption[] {
  const placed = placeClips(clips, fps);
  const out: Caption[] = [];
  for (const cap of captions) {
    for (const pc of placed) {
      if (pc.clip.src !== cap.src) continue;
      const inMs = pc.clip.inSec * 1000;
      const outMs = pc.clip.outSec * 1000;
      // honoring playback speed (slow-mo stretches the words with the speech)
      const speed = pc.clip.speed ?? 1;
      const sh = cap.shiftMs ?? 0; // a nudged page moves on the timeline, never out of its clip
      const toAbs = (srcMs: number) => { const t = pc.startMs + (srcMs - inMs) / speed; return sh ? Math.min(pc.endMs, Math.max(pc.startMs, t + sh)) : t; };
      const words = cap.words
        .filter((w) => w.endMs > inMs && w.startMs < outMs)
        .map((w) => ({...w, startMs: toAbs(Math.max(w.startMs, inMs)), endMs: toAbs(Math.min(w.endMs, outMs))}));
      if (!words.length) continue;
      out.push({
        ...cap,
        clipId: pc.clip.id,
        words,
        startMs: words[0].startMs,
        endMs: Math.min(words[words.length - 1].endMs, pc.endMs),
        holdMaxMs: pc.endMs,
      });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

// Pages under a closing card (projected, timeline ms spans): pages that start
// under it are not shown, a page running into it ends where the card starts,
// and no earlier page may hold into it (the hidden pages no longer end the
// hold of the one before them).
export function hideUnder(pages: Caption[], spans: {startMs: number; endMs: number}[]): Caption[] {
  if (!spans.length) return pages;
  return pages
    .filter((c) => !spans.some((s) => c.startMs >= s.startMs && c.startMs < s.endMs))
    .map((c) => {
      const s = spans.find((x) => c.startMs < x.startMs && (c.holdMaxMs ?? Infinity) > x.startMs);
      return s ? {...c, endMs: Math.min(c.endMs, s.startMs), holdMaxMs: Math.min(c.holdMaxMs ?? Infinity, s.startMs)} : c;
    });
}

// Merge freshly generated pages into the existing ones. Kept: every existing
// page (replace=false, "generate captions") or only the hand-made ones — typed
// at a time, or retexted (`covers`) — (replace=true, "re-page for a new style").
// Fresh pages lose the words a kept page already shows, the words in `covers`,
// and `hidden` words (pages the user deleted); a fresh page overlapping a kept
// page in time is dropped. Ids stay stable, new pages continue the numbering.
export function mergeCaptions(existing: Caption[], fresh: Caption[], clips: Clip[], opts: {hidden?: Iterable<string>; replace?: boolean} = {}): {captions: Caption[]; added: number} {
  const sources = new Set(clips.map((c) => c.src));
  const hand = (c: Caption) => !!c.covers || !c.words.some((w) => w.wid);
  const kept = existing.filter((c) => sources.has(c.src) && (!opts.replace || hand(c)));
  const blocked = new Set<string>([...(opts.hidden ?? []), ...kept.flatMap((c) => [...(c.covers ?? []), ...c.words.map((w) => w.wid).filter((x): x is string => !!x)])]);
  const overlaps = (a: Caption, b: Caption) => a.src === b.src && a.startMs < b.endMs && a.endMs > b.startMs;
  const added = fresh
    .map((f) => ({...f, words: f.words.filter((w) => !w.wid || !blocked.has(w.wid))}))
    .filter((f) => f.words.length)
    .map((f) => ({...f, startMs: f.words[0].startMs, endMs: f.words[f.words.length - 1].endMs}))
    .filter((f) => !kept.some((k) => overlaps(k, f)));
  // numbered past every existing page, dropped ones included: a re-paged page never inherits an old id
  return {captions: [...kept, ...added.map((c, k) => ({...c, id: nextId(existing, 'c', k)}))], added: added.length};
}

// ---- hand corrections (edit_caption, the editor's Captions tab) ----
// A corrected page spans its words and is hand-edited from then on: `covers` = the transcript
// words it stands for (minus the ones another page shows now), so re-paging keeps it as it is.
function handPage(c: Caption, words: CaptionWord[], elsewhere: CaptionWord[] = []): Caption {
  const out = new Set(elsewhere.map((w) => w.wid));
  const covers = [...(c.covers ?? []), ...c.words.map((w) => w.wid), ...words.map((w) => w.wid)].filter((x): x is string => !!x && !out.has(x));
  return {...c, words, startMs: words[0].startMs, endMs: words[words.length - 1].endMs, covers: [...new Set(covers)]};
}

// The time of a page that plays: its span cut to the clips of its source (a trim or a cut word hides
// the rest; a source placed twice counts once), source ms, in order
export function playedSpans(cap: Caption, clips: Clip[]): [number, number][] {
  const spans = clips.filter((c) => c.src === cap.src).map((c): [number, number] => [Math.max(cap.startMs, c.inSec * 1000), Math.min(cap.endMs, c.outSec * 1000)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  return spans.reduce<[number, number][]>((out, [a, b]) => { const last = out[out.length - 1]; if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]); return out; }, []);
}

// New text for the words the reader sees (`spans` = playedSpans; the whole page by default), what
// get_project and the editor show. Same word count → each word keeps its id, time and tier (a spelling
// fix stays anchored); otherwise the new words are spread evenly over the time that plays — never into a
// gap a cut left — and a word that was there keeps its tier. Words a cut hides stay as they are.
export function retext(cap: Caption, text: string, spans: [number, number][] = []): Caption {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error('empty caption text');
  const play = spans.length ? spans : [[cap.startMs, cap.endMs]];
  const plays = (w: CaptionWord) => play.some(([a, b]) => w.endMs > a && w.startMs < b);
  const shown = cap.words.filter(plays);
  if (words.length === shown.length) return handPage(cap, cap.words.map((w) => (plays(w) ? {...w, text: words[shown.indexOf(w)]} : w)));
  const tiers = new Map(shown.filter((w) => w.tier).map((w) => [w.text.toLowerCase(), w.tier]));
  const step = play.reduce((n, [a, b]) => n + b - a, 0) / words.length;
  // a point of the played time → [source ms, end of its span]
  const at = (pos: number) => { for (const [a, b] of play) { if (pos < b - a) return [a + pos, b]; pos -= b - a; } const end = play[play.length - 1][1]; return [end, end]; };
  const typed = words.map((t, j) => { const [s, end] = at(j * step); return {text: t, startMs: Math.round(s), endMs: Math.round(Math.min(end, s + step)), tier: tiers.get(t.toLowerCase()) ?? 0}; });
  return handPage(cap, [...cap.words.filter((w) => !plays(w)), ...typed].sort((a, b) => a.startMs - b.startMs));
}

// the page before `cap` on its source: the one whose break with `cap` setPageStart moves
export const pageBefore = (captions: Caption[], cap: Caption) =>
  captions.filter((c) => c.src === cap.src && c !== cap && c.startMs < cap.startMs).sort((a, b) => b.startMs - a.startMs)[0];

// Move the page break before page `id`: it now starts at transcript word `wid` — a word of the
// page before it (whose tail joins this page) or of this page (whose head joins the page before).
// Words keep their ids, times and emphasis. Errors are worded for the agent.
export function setPageStart(captions: Caption[], id: string, wid: string): Caption[] {
  const cap = captions.find((c) => c.id === id);
  if (!cap) throw new Error(`no caption ${id}`);
  const prev = pageBefore(captions, cap);
  const inCap = cap.words.findIndex((w) => w.wid === wid);
  const inPrev = prev ? prev.words.findIndex((w) => w.wid === wid) : -1;
  if (inCap < 0 && inPrev < 0) throw new Error(`${wid} is not in ${id} or the page before it${prev ? ` (${prev.id})` : ''} — the break moves between neighbors; a retyped page has no word ids (use text on both pages)`);
  if (inCap === 0) return captions;
  if (!prev) throw new Error(`${id} is the first page of its source: no page before it to hand words to`);
  if (inPrev === 0) throw new Error(`that would leave ${prev.id} empty — delete_captions ${prev.id} instead`);
  const all = [...prev.words, ...cap.words];
  const k = inCap >= 0 ? prev.words.length + inCap : inPrev;
  const [a, b] = [all.slice(0, k), all.slice(k)];
  return captions.map((c) => (c === prev ? handPage(prev, a, b) : c === cap ? handPage(cap, b, a) : c));
}

// Nudge when a page is shown (ms): its words keep the time they are said — the speech the music
// ducks under, and with it the master of a layered render, stay as they were.
export const shiftPage = (cap: Caption, ms: number): Caption => ({...handPage(cap, cap.words), shiftMs: (cap.shiftMs ?? 0) + ms});

// Focus pull (Prism): while a tier-2 word is on screen the footage blurs. Spans
// in the pages' own time base, from just before the word's onset to the end of
// its page (the page holds until the next one, at most holdMs after its last word).
export function focusSpans(pages: Caption[], holdMs: number, leadMs = 120): {startMs: number; endMs: number}[] {
  const out: {startMs: number; endMs: number}[] = [];
  pages.forEach((c, i) => {
    const visEnd = Math.min(pages[i + 1]?.startMs ?? Infinity, c.endMs + holdMs, c.holdMaxMs ?? Infinity);
    for (const w of c.words) if (w.tier === 2) out.push({startMs: w.startMs - leadMs, endMs: visEnd});
  });
  return out;
}

// Impact II: the footage punches in on the hero word and pulses on each key word (timeline ms)
export function tierSpans(pages: Caption[], tier: number, holdMs: number, maxMs = Infinity): {startMs: number; endMs: number}[] {
  const out: {startMs: number; endMs: number}[] = [];
  pages.forEach((c, i) => {
    const visEnd = Math.min(pages[i + 1]?.startMs ?? Infinity, c.endMs + holdMs, c.holdMaxMs ?? Infinity);
    for (const w of c.words) if (w.tier === tier) out.push({startMs: w.startMs, endMs: Math.min(visEnd, w.startMs + maxMs)});
  });
  return out;
}
