// Deterministic pager: transcript words → caption pages, per preset.
// Shared by the captions pipeline (scripts/captions-multiclip.mjs) and the MCP
// server, so re-styling re-pages exactly the same way.

import type {Caption, CaptionWord} from './captions.ts';
import type {Preset} from './captionPresets.ts';

// a transcript word as assembleWords() emits it (absolute + source-relative times)
export type TimelineWord = {
  wid: string; // `${source}:${index}` — stable across splits and autocuts
  word: string;
  src: string;
  clipId: string;
  startMs: number; // absolute (current cut) — used for gap detection
  endMs: number;
  srcStartMs: number; // source-relative — what gets stored
  srcEndMs: number;
  tier?: number; // 1 = classifier highlight (keyword/question/CTA)
  speaker?: string; // spk1, spk2… from diarization (who is talking)
};

const GAP_MS = 450; // break on natural pauses (sentence rhythm)
const PUNCT_ONLY = /^[.,!?;:()\-—¿¡]+$/;
const SENT_END = /[.!?]$/;
const CLAUSE_END = /[,;:]$/; // soft break after a clause
export const toDisplay = (w: string) => w.replace(/[.,;:]+$/g, '').replace(/^[.,;:¿¡]+/g, '');

// function/glue words we should never leave dangling at the end of a line
export const GLUE = new Set([
  // en
  'a', 'an', 'the', 'of', 'to', 'and', 'or', 'but', 'in', 'on', 'at', 'for', 'with', 'from', 'by',
  'is', 'was', 'are', 'were', 'be', 'been', 'that', 'this', 'it', 'its', 'as', 'so', 'my', 'your',
  'i', 'we', 'you', 'they', 'he', 'she', 'has', 'have', 'had', 'will', "it's", 'about', 'into',
  // es
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'al', 'y', 'e', 'o', 'u', 'pero',
  'en', 'con', 'por', 'para', 'sin', 'sobre', 'que', 'qué', 'es', 'son', 'está', 'están', 'ser', 'se',
  'mi', 'tu', 'su', 'mis', 'tus', 'sus', 'lo', 'le', 'les', 'me', 'te', 'nos', 'como', 'muy', 'más', 'ya',
]);
export const isGlue = (text: string) => GLUE.has(text.toLowerCase());

export const DEFAULT_TOP = 58;

// topBySrc: vertical position per source file (face-aware placement), % from top
export function pageWords(words: TimelineWord[], preset: Preset, topBySrc: Record<string, number> = {}): Caption[] {
  const {maxWords, maxCharsLine} = preset.layout;
  const pages: {src: string; words: CaptionWord[]; start: number; end: number}[] = [];
  let cur: CaptionWord[] = [];
  let curSrc = '';
  let curClip = '';
  let skipParen = false;
  const chars = () => cur.reduce((n, w) => n + w.text.length + 1, -1);
  const flush = () => {
    if (cur.length) pages.push({src: curSrc, words: cur, start: cur[0].startMs, end: cur[cur.length - 1].endMs});
    cur = [];
  };
  words.forEach((w, i) => {
    if (w.word === '(') { skipParen = true; flush(); return; }
    if (w.word === ')') { skipParen = false; return; }
    if (skipParen || PUNCT_ONLY.test(w.word)) return;
    const display = toDisplay(w.word);
    if (!display) return;

    if (cur.length && w.clipId !== curClip) flush(); // never span two clips
    curSrc = w.src;
    curClip = w.clipId;
    cur.push({wid: w.wid, text: display, startMs: w.srcStartMs, endMs: w.srcEndMs, tier: w.tier ?? 0, ...(w.speaker ? {speaker: w.speaker} : {})});
    if (maxWords <= 1) { flush(); return; } // word-at-a-time preset

    const next = words[i + 1];
    const sameClipNext = !!next && next.clipId === w.clipId;
    const gapAfter = sameClipNext && next.startMs - w.endMs > GAP_MS;
    const full = cur.length >= maxWords || chars() >= maxCharsLine;
    if (SENT_END.test(w.word)) flush();
    else if (next && !sameClipNext) flush(); // clip boundary
    else if (!isGlue(display) && (full || gapAfter || CLAUSE_END.test(w.word))) flush();
    else if (full && isGlue(display)) {
      // full on a function word: break BEFORE the trailing function words so
      // they open the next page ("They all lied to us / about this one thing")
      let k = cur.length;
      while (k > 0 && isGlue(cur[k - 1].text)) k--;
      if (k > 0) { const carry = cur.slice(k); cur = cur.slice(0, k); flush(); cur = carry; }
      else if (cur.length >= maxWords + 2) flush();
    }
  });
  flush();
  if (maxWords > 1) {
    // merge 1-word orphans into the previous line (same clip, tight in time)
    for (let k = pages.length - 1; k > 0; k--) {
      const p = pages[k];
      const prev = pages[k - 1];
      if (p.words.length === 1 && p.src === prev.src && p.start - prev.end < 350 && prev.words.length <= maxWords) {
        prev.words.push(...p.words);
        prev.end = p.end;
        pages.splice(k, 1);
      }
    }
  }
  return pages.map((p, i) => ({id: `c${i}`, src: p.src, words: p.words, startMs: p.start, endMs: p.end, topPct: topBySrc[p.src] ?? DEFAULT_TOP}));
}

// carry annotations from old pages onto freshly paged ones, by word id: word
// tiers, and page settings (pinned position, size, behind) from the old page
// that shares the most words with the new one
export function reapplyTiers(oldPages: Caption[], fresh: Caption[]): Caption[] {
  const tier = new Map<string, number>();
  const emoji = new Map<string, string>();
  const pageOf = new Map<string, Caption>();
  for (const c of oldPages) for (const w of c.words) if (w.wid) { if (w.tier) tier.set(w.wid, w.tier); if (w.emoji) emoji.set(w.wid, w.emoji); if (c.pin || c.scale || c.behind) pageOf.set(w.wid, c); }
  if (!tier.size && !emoji.size && !pageOf.size) return fresh;
  return fresh.map((c) => {
    const votes = new Map<Caption, number>();
    for (const w of c.words) { const o = w.wid && pageOf.get(w.wid); if (o) votes.set(o, (votes.get(o) ?? 0) + 1); }
    const from = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
    const page = from ? {...c, ...(from.pin ? {pin: true, topPct: from.topPct} : {}), ...(from.scale ? {scale: from.scale} : {}), ...(from.behind ? {behind: true} : {})} : c;
    return {...page, words: c.words.map((w) => (w.wid && (tier.has(w.wid) || emoji.has(w.wid)) ? {...w, ...(tier.has(w.wid) ? {tier: tier.get(w.wid)!} : {}), ...(emoji.has(w.wid) ? {emoji: emoji.get(w.wid)!} : {})} : w))};
  });
}
