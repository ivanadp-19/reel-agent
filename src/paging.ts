// Deterministic pager: transcript words → caption pages, per preset.
// Shared by the captions pipeline (scripts/captions-multiclip.mjs) and the MCP
// server, so re-styling re-pages exactly the same way.
//
// Ported in part from Fats403/remotion-captions-kit @ 97232270364bd6bba4ca8d11180c350409495e95
// (MIT, © 2026 Brayden Blackwell; see NOTICE): the sentence-boundary lists and rules
// (src/sentence-boundaries.ts), and — opt-in, only in a pack that sets the layout caps — clauseSplit,
// mergeShortPages and fixOrphans (src/create-caption-pages.ts), plus the endMs ≥ startMs clamp
// (src/normalize-captions.ts). Adapted: Spanish titles and address words ('ave' moved to MAYBE_ENDS: a
// bird in Spanish), ¿ ¡ open a sentence, "No. 5"; "…" is a pause, never an end; a lone initial lets the
// next word decide ("la torre A. Después"); a bare number ("326.") always ends one; pages never merge
// across a sentence end, a clip or a parenthesis, and never split a bond.

import {mergeCaptions, type Caption, type CaptionWord} from './captions.ts';
import {normKey, type GlossaryEntry} from './guion.ts';
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

const GAP_MS = 450; // break on natural pauses (sentence rhythm); a pack may set layout.silenceMs
const ORPHAN_GAP_MS = 350; // a 1-word page this close to the page before joins it (packs without minWords)
const PUNCT_ONLY = /^[.,!?;:()\-—¿¡]+$/;

// ---- sentence boundaries (Fats403 src/sentence-boundaries.ts, + Spanish) ----
// A terminator, then closing quotes or brackets. "…" is a dramatic pause mid-sentence, never an end
const SENT_END = /[.!?]+[)\]}"'”’»›]*$/u;
const SENT_START = /^[("'“‘«‹¿¡]*[\p{Lu}\p{N}]/u;
// never end a sentence: a title is followed by a name ("Sr. Pérez", "Av. Reforma")
const NEVER_ENDS = new Set([
  'mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'rev', 'hon', 'sr', 'jr', 'st', 'mt', 'ft', 'capt', 'sgt', 'lt', 'col', 'gen', 'gov', 'sen', 'rep',
  'vs', 'cf', 'viz', 'eg', 'ie', 'vol', 'fig', 'figs', 'pp', 'ca', 'approx', 'dept', 'est', 'univ', 'apt', 'ste', 'blvd', 'rd',
  'sra', 'srta', 'dra', 'lic', 'ing', 'arq', 'mtro', 'mtra', 'profa', 'gral', 'ud', 'uds', 'sto', 'sta',
  'av', 'avda', 'calz', 'carr', 'fracc', 'priv', 'depto', 'dpto', 'cd', 'edo',
]);
// usually mid-sentence but can end one ("…y demás, etc."): the next word decides
const MAYBE_ENDS = new Set([
  'etc', 'al', 'inc', 'ltd', 'co', 'corp', 'llc', 'am', 'pm', 'ed', 'eds', 'esp', 'min', 'max', 'sec', 'ref', 'ave',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);
const DOTTED_ACRONYM = /^(?:\p{L}{1,2}\.){2,}$/u; // "U.S.", "p.m."
const SINGLE_INITIAL = /^\p{L}\.$/u; // "J. Pérez", but also "la torre A. Después": the next word decides
// "No." / "Núm." only before a number ("No. 5") — "Te dije que no." ends a sentence
const NUMBER_ABBR = /^(no|núm|num|nro)\.$/i;
const stem = (w: string) => w.replace(/[)\]}"'”’»›]+$/u, '').replace(/[.!?]+$/u, '').replace(/^[("'“‘«‹¿¡]+/u, '').toLowerCase();
// A bare number ("…Montealbán 326.") always ends one: Fats403 lets the next word decide, and an ASR's
// lowercase after a figure then glued two sentences onto one page (captions-ws c847c98)
export const endsSentence = (word: string, next?: string): boolean => {
  const w = word.trim();
  if (!SENT_END.test(w)) return false;
  if (/[!?]/.test(w)) return true; // never an abbreviation mark
  if (NUMBER_ABBR.test(w) && /^\d/.test(next ?? '')) return false;
  const b = stem(w);
  if (NEVER_ENDS.has(b)) return false;
  if (!(MAYBE_ENDS.has(b) || SINGLE_INITIAL.test(w) || DOTTED_ACRONYM.test(w)) || next === undefined) return true;
  return SENT_START.test(next.trim());
};
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

// one kept transcript word: word = as said (trimmed), text = as shown. cut: a page starts here (a
// parenthesis was skipped before it). term: the index of the glossary term run it belongs to.
// Pages are runs of these by position, never looked up by word id
type Item = {w: TimelineWord; word: string; text: string; cut: boolean; term?: number};
type Page = Item[];

// every page at the pack's top (layout.topPct, else DEFAULT_TOP); src/faces.ts placeCaptions then moves them off the faces.
// glossary: the brand kit's (the captions job's, after applyGlossary respelled the words) — its multi-word terms stay on one page
export function pageWords(words: TimelineWord[], preset: Preset, glossary: GlossaryEntry[] = []): Caption[] {
  const {maxWords, maxCharsLine, unbreakable, topPct, keepCommas, figurePages, glueExcept, silenceMs = GAP_MS, maxChars = Infinity, maxMs = Infinity, minMs = 0, minWords} = preset.layout;
  const glue = (t: string) => isGlue(t, glueExcept);

  // the words to page: a parenthesis is skipped whole (and breaks the page), stand-alone marks and blanks
  // go, and a word never ends before it starts (Fats403 normalizeCaptions)
  const items: Item[] = [];
  let skipParen = false, cut = false;
  for (const w0 of words) {
    const word = w0.word.trim();
    if (word === '(') { skipParen = true; cut = true; continue; }
    if (word === ')') { skipParen = false; continue; }
    if (skipParen || PUNCT_ONLY.test(word)) continue;
    const text = toDisplay(word, keepCommas);
    if (!text) continue;
    items.push({w: {...w0, endMs: Math.max(w0.endMs, w0.startMs), srcEndMs: Math.max(w0.srcEndMs, w0.srcStartMs)}, word, text, cut});
    cut = false;
  }

  // The kit's multi-word glossary terms ('Pet Park', 'Star Médica') are one unit in EVERY pack: a page never
  // breaks inside one (the render judge's split-name rule). Read on the words as applyGlossary left them,
  // longest first; inside one clip, never across a parenthesis or a sentence end (which always ends the
  // page) — a guion sentence start inside a name is an alignment slip: the name wins, as a bond does.
  // Not the pack's name bonds: vibem still pages MONTEALBÁN | 326 (a term and a figure, not one term)
  const terms = glossary.map((g) => g.term.split(/\s+/).map(normKey).filter(Boolean)).filter((t) => t.length > 1).sort((a, b) => b.length - a.length);
  for (let i = 0; i < items.length; i++) {
    const t = terms.find((t) => t.every((k, n) => {
      const x = items[i + n];
      return x && normKey(x.word) === k && (!n || (x.w.clipId === items[i].w.clipId && !x.cut && !endsSentence(items[i + n - 1].word, x.word)));
    }));
    if (t) { for (let n = 0; n < t.length; n++) items[i + n].term = i; i += t.length - 1; }
  }

  // layout.unbreakable: a highlight span or a proper name + number ('Montealbán 326') is ONE unit —
  // never let a page boundary fall inside it (3 lines or a smaller size instead). No pack bonds
  // since César's v11 (MONTEALBÁN | 326 are two pages there: v11 video wins, user decision 2026-09-26)
  const inTerm = (a: Item, b?: Item) => a.term != null && a.term === b?.term;
  const bonded = (a: Item, b?: Item) => {
    if (!b) return false;
    if (inTerm(a, b)) return true;
    if (!unbreakable) return false;
    if ((a.w.tier ?? 0) > 0 && (b.w.tier ?? 0) > 0) return true;
    const bn = b.word.replace(/^[.,;:¿¡]+/, '');
    return /^[A-ZÁÉÍÓÚÑ]/.test(a.text) && (/^[A-ZÁÉÍÓÚÑ]/.test(bn) || /^\d/.test(bn));
  };
  const chars = (p: Page) => p.reduce((n, it) => n + noComma(it.text).length + 1, -1); // a kept comma is not a character
  // Fats403's hard caps, only in a pack that sets them (layout.maxChars / maxMs): characters shown, speech
  const capped = maxChars < Infinity || maxMs < Infinity;
  const withinLimits = (p: Page) => chars(p) <= maxChars && p[p.length - 1].w.endMs - p[0].w.startMs <= maxMs;
  const fits = (p: Page) => p.length <= maxWords && chars(p) <= maxCharsLine && withinLimits(p); // a merged page
  // two neighbor pages that may become one: same clip, no parenthesis, no sentence end (nor a guion one)
  // and no pause between them (in the source: one clip)
  const joinable = (a: Page, b: Page, gapMs: number) => {
    const x = a[a.length - 1], y = b[0];
    return x.w.clipId === y.w.clipId && !y.cut && !y.w.sentenceStart && !endsSentence(x.word, y.word) && y.w.srcStartMs - x.w.srcEndMs < gapMs;
  };

  const pages: Page[] = [];
  let cur: Page = [];
  const flush = () => { if (cur.length) pages.push(cur); cur = []; };
  const breakAt = (k: number) => { const carry = cur.slice(k); cur = cur.slice(0, k); flush(); cur = carry; };
  // a break forced by a cap (the incoming word would pass it): back at a clause end when the words carried
  // with it still fit (Fats403 clauseSplit), else before the trailing function words when they fit with it;
  // never inside a bond
  const forcedBreak = (incoming: Item) => {
    for (let i = cur.length - 2; i >= 1; i--) {
      if (CLAUSE_END.test(cur[i].word) && !glue(cur[i].text) && !bonded(cur[i], cur[i + 1]) && withinLimits([...cur.slice(i + 1), incoming])) return breakAt(i + 1);
    }
    let k = cur.length;
    while (k > 0 && glue(cur[k - 1].text)) k--;
    while (k > 0 && k < cur.length && bonded(cur[k - 1], cur[k])) k++;
    breakAt(k > 0 && withinLimits([...cur.slice(k), incoming]) ? k : cur.length);
  };

  items.forEach((it, i) => {
    if (cur.length && (it.w.clipId !== cur[0].w.clipId || it.cut)) flush(); // never span two clips or a parenthesis
    if (cur.length && it.w.sentenceStart && !bonded(cur[cur.length - 1], it)) flush(); // guion sentence boundary
    // ponytail: a bond (a glossary term too) is checked against the caps a word at a time, so a page may pass them by the
    // rest of its term — measure the whole term at its first word if a capped pack ever shows that
    if (capped && cur.length && !bonded(cur[cur.length - 1], it) && !withinLimits([...cur, it])) forcedBreak(it);
    cur.push(it);
    if (maxWords <= 1) { if (!inTerm(it, items[i + 1])) flush(); return; } // word-at-a-time preset: a glossary term is one page

    const next = items[i + 1];
    const sameClipNext = !!next && next.w.clipId === it.w.clipId && !next.cut;
    const gapAfter = sameClipNext && next.w.startMs - it.w.endMs > silenceMs;
    const full = cur.length >= maxWords || chars(cur) >= maxCharsLine;
    // a sentence end always ends the page, bond or not: a bonded pair is two capitalized words, and
    // every sentence starts with one ('…del Carmen. Está cerca' was one page); César: one page per sentence
    if (endsSentence(it.word, next?.word)) flush();
    else if (next && !sameClipNext) flush(); // clip boundary or parenthesis
    // v11 (figurePages): a highlighted figure followed by a comma ends its page — '326,' stands alone,
    // '54 departamentos' opens the next (Deepgram writes 'tres veintiséis, 54' where WhisperX put a period)
    else if (figurePages && (it.w.tier ?? 0) > 0 && /^\d[\d.]*,$/.test(it.word) && !bonded(it, next)) flush();
    // v11 (keepCommas): a comma is text, not a page break; with caps a clause end is only where a forced
    // break goes back to (Fats403)
    else if (!glue(it.text) && !bonded(it, next) && (full || gapAfter || (!keepCommas && !capped && CLAUSE_END.test(it.word)))) flush();
    else if (full && (glue(it.text) || bonded(it, next))) {
      // full on a function word, or inside a glossary term: break BEFORE the trailing function words and
      // the term so they open the next page ("They all lied to us / about this one thing", "Aquí está / el
      // Pet Park" — where the judge's split-name fix used to move the break by hand)
      let k = cur.length;
      while (k > 0 && (inTerm(cur[k - 1], cur[k] ?? next) || (cur[k - 1].term == null && glue(cur[k - 1].text)))) k--; // a finished term stays
      // ...but never carry-split inside a bonded unit: a highlight span like
      // "salón para sesenta" has glue in the middle and must stay one page
      while (k > 0 && k < cur.length && bonded(cur[k - 1], cur[k])) k++;
      if (k === 1 && inTerm(it, next)) k = cur.length; // one word left behind: the page takes the term (a word over beats an orphan)
      if (k === cur.length) {
        // the whole page is one bonded unit: let it grow past maxWords (3 lines
        // or a smaller size beat splitting it) — unless a term just ended on its function word ('Hotel de la')
        if (it.term != null && !bonded(it, next)) flush();
      } else if (k > 0) breakAt(k); // a term longer than the page opens its own page and grows past maxWords
      else if (cur.length >= maxWords + 2 && !bonded(it, next)) flush();
    }
  });
  flush();

  // how long page k of ps is on screen, with the pack's hold (timeline ms)
  const shown = (ps: Page[], k: number) => Math.min(ps[k + 1]?.[0].w.startMs ?? Infinity, ps[k][ps[k].length - 1].w.endMs + preset.holdMs) - ps[k][0].w.startMs;

  // Flash pages (Fats403 mergeShortPages, only where the pack sets minMs): a page on screen for less
  // merges into a neighbor — forward by preference — when they are joinable and the result fits. Run
  // again after the orphans: a word moved to an orphan can leave a flash page a merge now fixes
  const mergeFlash = () => {
    if (!(minMs > 0 && maxWords > 1)) return;
    let k = 0;
    while (k < pages.length) {
      const p = pages[k], next = pages[k + 1], prev = pages[k - 1];
      if (shown(pages, k) >= minMs) k++;
      else if (next && joinable(p, next, silenceMs) && fits([...p, ...next])) pages.splice(k, 2, [...p, ...next]); // look at it again
      else if (prev && joinable(prev, p, silenceMs) && fits([...prev, ...p])) { pages.splice(k - 1, 2, [...prev, ...p]); k--; }
      else k++; // merging either way would overfill: a short page beats a broken one
    }
  };
  mergeFlash();

  // Orphans. The pager's own rule: a 1-word page joins the page before it when that one ends < 350 ms
  // earlier in the same CLIP (not source: a cut inside one source is a boundary) and holds at most
  // maxWords words — unless the word starts a guion sentence (the 'MINUTOS SALÓN' defect), or a sentence
  // ends between them ("¿Vienes? | Sí." stays two pages), or in v11 (figurePages) it is a highlighted figure
  // ('MONTEALBÁN' | '326'). A pack that sets minWords (Fats403 fixOrphans): a page under it merges into a
  // neighbor that it fits with, or takes a word across the break when both pages then last minMs; else the
  // pager's own rule (one page a word over the budget beats an orphan), and only then a word that leaves it
  // short. A highlighted span is never split by it (two tier words in a row). Walked from the end.
  const own = (a: Page, b: Page) => b.length === 1 && joinable(a, b, ORPHAN_GAP_MS) && a.length <= maxWords && withinLimits([...a, ...b]);
  const min = minWords ?? 2;
  if (maxWords > 1 && min > 1) {
    const both = minWords != null;
    const gap = silenceMs;
    const figure = (p: Page) => figurePages && (p[0].w.tier ?? 0) > 0 && /^\d/.test(p[0].text);
    // two highlighted words in a row: one span (captionLayout's unit.name, the judge's 'frase resaltada partida')
    const span = (a: Item, b: Item) => (a.w.tier ?? 0) > 0 && (b.w.tier ?? 0) > 0;
    // one word from the donor page d to the orphan o, when both pages stay legal and no highlighted span
    // splits; strict: the grown orphan is on screen minMs too (else the pager's own merge is tried first)
    const shift = (d: number, o: number, strict: boolean) => {
      const donor = pages[d], orphan = pages[o], leads = d < o;
      if (donor.length <= min || !joinable(leads ? donor : orphan, leads ? orphan : donor, gap)) return false;
      const moved = leads ? donor[donor.length - 1] : donor[0];
      const kept = leads ? donor.slice(0, -1) : donor.slice(1);
      const grown = leads ? [moved, ...orphan] : [...orphan, moved];
      const left = leads ? kept : grown;
      const [a, b] = leads ? [kept[kept.length - 1], moved] : [moved, kept[0]];
      if (moved.w.sentenceStart || bonded(a, b) || span(a, b) || glue(left[left.length - 1].text) || !fits(grown)) return false;
      const after = pages.map((p, k) => (k === d ? kept : k === o ? grown : p));
      if (minMs > 0 && (shown(after, d) < minMs || (strict && shown(after, o) < minMs))) return false; // no flash page left
      pages[d] = kept;
      pages[o] = grown;
      return true;
    };
    // with minWords, walked again until nothing moves: a word taken from the page after an orphan can let
    // a later orphan join it (each pass merges pages or shrinks what the orphans lack, so it ends)
    let moved = true;
    while (moved) {
      moved = false;
      for (let k = pages.length - 1; k >= 0; k--) {
        const p = pages[k], prev = pages[k - 1], next = pages[k + 1];
        if (p.length >= min || figure(p)) continue;
        // a highlighted span split before the orphan ('Plaza* | Altabrisa*') heals by the own rule first
        if (prev && (both ? (span(prev[prev.length - 1], p[0]) && own(prev, p)) || (joinable(prev, p, gap) && fits([...prev, ...p])) : own(prev, p))) { pages.splice(k - 1, 2, [...prev, ...p]); moved = both; }
        else if (!both) continue;
        else if (next && joinable(p, next, gap) && fits([...p, ...next])) { pages.splice(k, 2, [...p, ...next]); k++; moved = true; }
        else if ((prev && shift(k - 1, k, true)) || (next && shift(k + 1, k, true))) { k++; moved = true; } // look at it again
        else if (prev && own(prev, p)) { pages.splice(k - 1, 2, [...prev, ...p]); moved = true; }
        else if ((prev && shift(k - 1, k, false)) || (next && shift(k + 1, k, false))) { k++; moved = true; } // 'Yes,' → 'Yes, that's'
      }
    }
  }
  mergeFlash();

  return pages.map((p, i) => {
    const ws: CaptionWord[] = p.map(({w, text}) => ({wid: w.wid, text, startMs: w.srcStartMs, endMs: w.srcEndMs, tier: w.tier ?? 0, ...(w.speaker ? {speaker: w.speaker} : {}), ...(w.sentenceStart ? {sentenceStart: true} : {}), ...(w.asr != null ? {asr: w.asr} : {}), ...(w.proposed ? {proposed: true} : {}), ...(w.was ? {was: w.was} : {})}));
    const src = p[0].w.src;
    return {
      id: `c${i}`,
      src,
      words: keepCommas ? ws.map((w, k) => (k === ws.length - 1 ? {...w, text: noComma(w.text)} : w)) : ws, // a page-final comma goes
      startMs: ws[0].startMs,
      endMs: ws[ws.length - 1].endMs,
      topPct: topPct ?? DEFAULT_TOP,
    };
  });
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
