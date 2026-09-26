// Deterministic pager: transcript words → caption pages, per preset.
// Shared by the captions pipeline (scripts/captions-multiclip.mjs) and the MCP
// server, so re-styling re-pages exactly the same way.

import {mergeCaptions, type Caption, type CaptionWord} from './captions.ts';
import type {Clip} from './timeline.ts';
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
  tier?: number; // 1 = key word (the project's tier, else the proposer's: src/highlights.ts yellowWords)
  speaker?: string; // spk1, spk2… from diarization (who is talking)
  sentenceStart?: boolean; // a guion sentence begins on this word (v11.1) — break the page before it
  asr?: string; // the ASR's own text, when guion reconciliation changed it (src/guion.ts)
  proposed?: boolean; // the tier came from the pack's proposer (src/highlights.ts yellowWords)
  was?: string; // its id in the source's other engine's transcript (scripts/lib-transcribe.mjs)
};

const GAP_MS = 450; // break on natural pauses (sentence rhythm)
const PUNCT_ONLY = /^[.,!?;:()\-—¿¡]+$/;
const SENT_END = /[.!?]$/;
// abbreviations end in a period without ending the sentence ("Sr. Pérez", "Av. Reforma");
// "No." / "Núm." only before a number ("No. 5") — "Te dije que no." ends a sentence
const ABBR = /^(sr|sra|srta|dr|dra|lic|ing|arq|av|avda|blvd|col|mr|mrs|ms|st)\.$/i;
const NUMBER_ABBR = /^(no|núm|num|nro)\.$/i;
export const endsSentence = (word: string, next?: string) =>
  SENT_END.test(word) && !ABBR.test(word) && !(NUMBER_ABBR.test(word) && /^\d/.test(next ?? ''));
const CLAUSE_END = /[,;:]$/; // soft break after a clause
// keepComma (layout.keepCommas, v11): a trailing comma stays on screen; periods never do
export const toDisplay = (w: string, keepComma = false) => {
  const core = w.replace(/[.,;:]+$/g, '').replace(/^[.,;:¿¡]+/g, '');
  return keepComma && core && w.endsWith(',') ? core + ',' : core;
};
const noComma = (t: string) => t.replace(/,$/, '');

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
  // v11 (César 11:42): pages must not END on a dangling function word ('Y TU DEPARTAMENTO NO',
  // 'CON LA CORREA Y HASTA', 'NI BUSCAS ES') — these carry onto the next page instead
  'no', 'ni', 'hasta', 'desde', 'si', 'sí', 'cuando', 'donde', 'dónde', 'tan', 'cada', 'también', 'tampoco',
  'aunque', 'porque', 'pues', 'entre', 'hacia', 'tras', 'mientras', 'según',
]);
// except: the words a pack lets end a page (layout.glueExcept)
export const isGlue = (text: string, except?: string[]) => { const t = noComma(text).toLowerCase(); return GLUE.has(t) && !except?.includes(t); };

export const DEFAULT_TOP = 58;

// topBySrc: vertical position per source file (face-aware placement), % from top
export function pageWords(words: TimelineWord[], preset: Preset, topBySrc: Record<string, number> = {}): Caption[] {
  const {maxWords, maxCharsLine, unbreakable, topPct, keepCommas, figurePages, glueExcept} = preset.layout;
  const glue = (t: string) => isGlue(t, glueExcept);
  // layout.unbreakable: a highlight span or a proper name + number ('Montealbán 326') is ONE unit —
  // never let a page boundary fall inside it (3 lines or a smaller size instead). No pack bonds
  // since César's v11 (MONTEALBÁN | 326 are two pages there: v11 video wins, user decision 2026-09-26)
  const bonded = (a: {text: string; tier?: number}, b?: {text?: string; tier?: number; word?: string}) => {
    if (!unbreakable || !b) return false;
    if ((a.tier ?? 0) > 0 && (b.tier ?? 0) > 0) return true;
    const bn = (b.word ?? b.text ?? '').replace(/^[.,;:¿¡]+/, '');
    return /^[A-ZÁÉÍÓÚÑ]/.test(a.text) && (/^[A-ZÁÉÍÓÚÑ]/.test(bn) || /^\d/.test(bn));
  };
  const pages: {src: string; words: CaptionWord[]; start: number; end: number; sent?: boolean}[] = [];
  let cur: CaptionWord[] = [];
  let curSrc = '';
  let curClip = '';
  let skipParen = false;
  const chars = () => cur.reduce((n, w) => n + noComma(w.text).length + 1, -1); // a kept comma is not a character
  const flush = (sent = false) => {
    if (cur.length) pages.push({src: curSrc, words: cur, start: cur[0].startMs, end: cur[cur.length - 1].endMs, sent});
    cur = [];
  };
  words.forEach((w, i) => {
    if (w.word === '(') { skipParen = true; flush(); return; }
    if (w.word === ')') { skipParen = false; return; }
    if (skipParen || PUNCT_ONLY.test(w.word)) return;
    const display = toDisplay(w.word, keepCommas);
    if (!display) return;

    if (cur.length && w.clipId !== curClip) flush(); // never span two clips
    if (cur.length && w.sentenceStart && !bonded(cur[cur.length - 1], w)) flush(); // guion sentence boundary
    curSrc = w.src;
    curClip = w.clipId;
    cur.push({wid: w.wid, text: display, startMs: w.srcStartMs, endMs: w.srcEndMs, tier: w.tier ?? 0, ...(w.speaker ? {speaker: w.speaker} : {}), ...(w.sentenceStart ? {sentenceStart: true} : {}), ...(w.asr != null ? {asr: w.asr} : {}), ...(w.proposed ? {proposed: true} : {}), ...(w.was ? {was: w.was} : {})});
    if (maxWords <= 1) { flush(); return; } // word-at-a-time preset

    const next = words[i + 1];
    const sameClipNext = !!next && next.clipId === w.clipId;
    const gapAfter = sameClipNext && next.startMs - w.endMs > GAP_MS;
    const full = cur.length >= maxWords || chars() >= maxCharsLine;
    // a sentence end always ends the page, bond or not: a bonded pair is two capitalized words, and
    // every sentence starts with one ('…del Carmen. Está cerca' was one page); César: one page per sentence
    if (endsSentence(w.word, next?.word)) flush(true);
    else if (next && !sameClipNext) flush(); // clip boundary
    // v11 (keepCommas): a comma is text, not a page break
    else if (!glue(display) && !bonded(cur[cur.length - 1], next) && (full || gapAfter || (!keepCommas && CLAUSE_END.test(w.word)))) flush();
    else if (full && glue(display)) {
      // full on a function word: break BEFORE the trailing function words so
      // they open the next page ("They all lied to us / about this one thing")
      let k = cur.length;
      while (k > 0 && glue(cur[k - 1].text)) k--;
      // ...but never carry-split inside a bonded unit: a highlight span like
      // "salón para sesenta" has glue in the middle and must stay one page
      while (k > 0 && k < cur.length && bonded(cur[k - 1], cur[k])) k++;
      if (k === cur.length) {
        // the whole page is one bonded unit: let it grow past maxWords (3 lines
        // or a smaller size beat splitting it)
      } else if (k > 0) { const carry = cur.slice(k); cur = cur.slice(0, k); flush(); cur = carry; }
      else if (cur.length >= maxWords + 2) flush();
    }
  });
  flush();
  if (maxWords > 1) {
    // merge 1-word orphans into the previous line (same clip, tight in time)
    for (let k = pages.length - 1; k > 0; k--) {
      const p = pages[k];
      const prev = pages[k - 1];
      // ...unless that word starts a guion sentence: merging it back would glue the
      // new sentence's head onto the previous sentence's tail (the 'MINUTOS SALÓN' defect),
      // and never across a sentence end ("¿Vienes? | Sí." stays two pages: one page per sentence)
      // ...and in v11 (figurePages) a highlighted figure is its own page ('MONTEALBÁN' | '326')
      const figure = figurePages && (p.words[0].tier ?? 0) > 0 && /^\d/.test(p.words[0].text);
      if (p.words.length === 1 && !figure && !p.words[0].sentenceStart && p.src === prev.src && p.start - prev.end < 350 && prev.words.length <= maxWords && !prev.sent) {
        prev.words.push(...p.words);
        prev.end = p.end;
        prev.sent = p.sent;
        pages.splice(k, 1);
      }
    }
  }
  return pages.map((p, i) => ({
    id: `c${i}`,
    src: p.src,
    words: keepCommas ? p.words.map((w, k) => (k === p.words.length - 1 ? {...w, text: noComma(w.text)} : w)) : p.words, // a page-final comma goes
    startMs: p.start,
    endMs: p.end,
    topPct: topPct ?? topBySrc[p.src] ?? DEFAULT_TOP, // a pack's pinned top wins over face-aware placement
  }));
}

// A word id is the n-th word of its source's transcript, and a new transcript (Deepgram after
// WhisperX, a refreshed cache) renumbers the source. So what the project says about a word is keyed
// by its id AND what it reads ('Guion1:19 altabrisa', case, accents and punctuation aside): it
// carries only onto the same word; a renumbered one is new to the project, not a stranger's tier —
// unless the source's two transcripts say which old id it was (`was`): then moveIds re-keys the project.
// ponytail: a cache the same engine refreshed has no `was` (one file) — keep the old file to align against if that happens.
export const wordKey = (w: {wid?: string; text?: string; word?: string}) => `${w.wid} ${(w.text ?? w.word ?? '').toLowerCase().normalize('NFD').replace(/[^\p{L}\p{N}]/gu, '')}`;

// The project's own emphasis as wordKey → tier, for EVERY word it shows (0 included): approved or
// hand-set (annotate_captions, the editor), it is authoritative, never re-derived (withTiers applies
// it exactly; the proposer only fills words not in it). Re-paging must see it BEFORE it pages, or a
// span the agent highlighted to keep a name together ('Playa del Carmen') is split again.
// approvedOnly (a new pack): leaves out the words whose tier is still only the old pack's proposal.
export function projectTiers(captions: Caption[], approvedOnly = false): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of captions) for (const w of c.words) if (w.wid && !(approvedOnly && w.proposed)) out[wordKey(w)] = Math.max(out[wordKey(w)] ?? 0, w.tier ?? 0);
  return out;
}
// the project's tiers onto words, exactly: a word the project shows takes its tier, lowered too
export function withTiers<T extends {wid?: string; text?: string; word?: string; tier?: number}>(words: T[], tiers: Record<string, number> = {}): T[] {
  for (const w of words) if (w.wid && Object.hasOwn(tiers, wordKey(w))) w.tier = tiers[wordKey(w)];
  return words;
}

// carry annotations from old pages onto freshly paged ones, by wordKey: word
// tiers (and whether they were only proposed), and page settings (pinned position,
// size, behind) from the old page that shares the most words with the new one
export function reapplyTiers(oldPages: Caption[], fresh: Caption[], approvedOnly = false): Caption[] {
  const tier = new Map(Object.entries(projectTiers(oldPages, approvedOnly))); // exact, as the captions job applied them
  const proposed = new Set(oldPages.flatMap((c) => c.words).filter((w) => w.wid && w.proposed).map(wordKey));
  const emoji = new Map<string, string>();
  const pageOf = new Map<string, Caption>();
  for (const c of oldPages) for (const w of c.words) if (w.wid) { if (w.emoji) emoji.set(wordKey(w), w.emoji); if (c.pin || c.scale || c.behind) pageOf.set(wordKey(w), c); }
  if (!tier.size && !emoji.size && !pageOf.size) return fresh;
  return fresh.map((c) => {
    const votes = new Map<Caption, number>();
    for (const w of c.words) { const o = w.wid && pageOf.get(wordKey(w)); if (o) votes.set(o, (votes.get(o) ?? 0) + 1); }
    const from = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
    const page = from ? {...c, ...(from.pin ? {pin: true, topPct: from.topPct} : {}), ...(from.scale ? {scale: from.scale} : {}), ...(from.behind ? {behind: true} : {})} : c;
    return {...page, words: c.words.map((w) => {
      const k = wordKey(w);
      if (!w.wid || !(tier.has(k) || emoji.has(k))) return w;
      const {proposed: _, ...rest} = w;
      return {...(tier.has(k) ? {...rest, tier: tier.get(k)!, ...(proposed.has(k) ? {proposed: true} : {})} : w), ...(emoji.has(k) ? {emoji: emoji.get(k)!} : {})};
    })};
  });
}

// A source transcribed again (Deepgram after WhisperX) renumbers its words; the new ones say which old id
// they were (`was`, scripts/lib-transcribe.mjs). When most of the project's words of a source are the old
// ids, the project moves to the new ones — its pages, hand-page covers and deleted words (an old id with no
// new word goes). Unchanged otherwise. The captions job's pages and get_transcript's words both carry `was`.
export function moveIds(existing: Caption[], words: {wid?: string; text?: string; word?: string; was?: string}[], hidden: string[] = []): {captions: Caption[]; hidden: string[]} {
  const fw = words.filter((w) => w.wid);
  const now = new Set(fw.map(wordKey)), was = new Set(fw.filter((w) => w.was).map((w) => wordKey({...w, wid: w.was})));
  const srcOf = (wid: string) => wid.slice(0, wid.lastIndexOf(':'));
  const vote = new Map<string, number>(); // per source: its words known by an old id, minus those known by a current one
  for (const c of existing) for (const w of c.words) if (w.wid) vote.set(srcOf(w.wid), (vote.get(srcOf(w.wid)) ?? 0) + Number(was.has(wordKey(w))) - Number(now.has(wordKey(w))));
  const moved = (wid: string) => (vote.get(srcOf(wid)) ?? 0) > 0;
  const next = new Map(fw.filter((w) => w.was && moved(w.was)).map((w) => [w.was!, w.wid!]));
  if (!next.size) return {captions: existing, hidden};
  const to = (wid: string) => (moved(wid) ? next.get(wid) : wid);
  const captions = existing.map((c) => ({
    ...c,
    words: c.words.map(({wid, ...w}): CaptionWord => (wid && to(wid) ? {...w, wid: to(wid)} : w)),
    ...(c.covers ? {covers: c.covers.map(to).filter((x): x is string => !!x)} : {}),
  }));
  return {captions, hidden: hidden.map(to).filter((x): x is string => !!x)};
}

// Fresh pages from the captions job onto the project's — every re-page and every "generate captions"
// (MCP set_caption_style / set_brand / run_ai_step, the editor, the CLI): the project first moves to a
// re-transcribed source's ids (moveIds), hand-made pages and deleted words stay (mergeCaptions),
// annotations carry (reapplyTiers). repropose (a new pack): the words whose tier was only proposed take
// the new pack's proposal. Returns the deleted words to store too.
export function repage(existing: Caption[], fresh: Caption[], clips: Clip[], {hidden = [], replace = false, repropose = false}: {hidden?: string[]; replace?: boolean; repropose?: boolean} = {}): {captions: Caption[]; added: number; hidden: string[]} {
  const {captions: ex, hidden: hid} = moveIds(existing, fresh.flatMap((c) => c.words), hidden);
  const clean = fresh.map((c) => ({...c, words: c.words.map(({was: _, ...w}) => w)}));
  const legacy = replace && !ex.some((c) => c.words.some((w) => w.wid)); // before word ids: no way to tell, all re-paged
  const merged = mergeCaptions(legacy ? [] : ex, clean, clips, {hidden: hid, replace});
  return {captions: reapplyTiers(ex, merged.captions, repropose), added: merged.added, hidden: hid};
}
