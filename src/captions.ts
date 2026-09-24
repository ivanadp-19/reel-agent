// Captions are anchored to a SOURCE file: `src` + word times relative to that
// source (0 = start of the untrimmed file). projectCaptions maps every WORD
// onto the current timeline through whichever clip(s) contain it, so trims,
// splits, autocut segments, reorders, speed changes and duplicated takes all
// keep the right words on screen — and words inside a removed range disappear.

import {placeClips, type Clip} from './timeline.ts';

export type CaptionWord = {text: string; startMs: number; endMs: number; accent: boolean};
export type Caption = {
  id: string;
  src: string; // staticFile-relative source path, e.g. "clips/IMG_0227.mp4"
  words: CaptionWord[]; // source-relative ms
  startMs: number;
  endMs: number;
  topPct: number;
  scale?: number; // size multiplier (1 = default), set via the on-preview slider
  // projected only:
  clipId?: string; // the clip this projected page sits on
  holdMaxMs?: number; // clip's end — the visual hold must not bleed into the next clip
};

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

// Merge freshly generated pages into the existing ones: keep everything the
// user already has (incl. manual edits, stable ids) and add a fresh page only
// where no kept page of the same source overlaps it in time.
export function mergeCaptions(existing: Caption[], fresh: Caption[], clips: Clip[]): {captions: Caption[]; added: number} {
  const sources = new Set(clips.map((c) => c.src));
  const kept = existing.filter((c) => sources.has(c.src));
  const overlaps = (a: Caption, b: Caption) => a.src === b.src && a.startMs < b.endMs && a.endMs > b.startMs;
  const added = fresh.filter((f) => !kept.some((k) => overlaps(k, f)));
  let n = kept.reduce((m, c) => Math.max(m, +(c.id.match(/^c(\d+)$/)?.[1] ?? -1) + 1), 0);
  return {captions: [...kept, ...added.map((c) => ({...c, id: `c${n++}`}))], added: added.length};
}
