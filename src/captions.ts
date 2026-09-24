// Captions are anchored to a SOURCE file: `src` + word times relative to that
// source (0 = start of the untrimmed file). projectCaptions maps every WORD
// onto the current timeline through whichever clip(s) contain it, so trims,
// splits, autocut segments, reorders, speed changes and duplicated takes all
// keep the right words on screen — and words inside a removed range disappear.

import {placeClips, type Clip} from './timeline.ts';

export type CaptionWord = {
  wid?: string; // `${source}:${index}` from the transcript; absent on hand-typed words
  text: string;
  startMs: number;
  endMs: number;
  tier?: number; // 0 plain · 1 accent color · 2 big emphasis (see captionPresets)
};
export type Caption = {
  id: string;
  src: string; // staticFile-relative source path, e.g. "clips/IMG_0227.mp4"
  words: CaptionWord[]; // source-relative ms
  startMs: number;
  endMs: number;
  topPct: number;
  scale?: number; // size multiplier (1 = default), set via the on-preview slider
  pin?: boolean; // explicit vertical position: float presets honor topPct instead of cycling
  covers?: string[]; // hand-edited page: the transcript word ids it stands in for (re-paging skips them)
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
      const toAbs = (srcMs: number) => pc.startMs + (srcMs - inMs) / speed;
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
  let n = kept.reduce((m, c) => Math.max(m, +(c.id.match(/^c(\d+)$/)?.[1] ?? -1) + 1), 0);
  return {captions: [...kept, ...added.map((c) => ({...c, id: `c${n++}`}))], added: added.length};
}
