// Highlight classification (César 9:27): a classification pass over the transcript
// flags keywords, questions and CTAs ("comenta aquí abajo", "llena el formulario").
// Those words render as highlight captions: solid #FFE500 (the official color),
// Helvetica Bold, same soft shadow, slightly bigger, dynamic entry (highlightRise).
// Primary path: LLM pass (scripts/captions-multiclip.mjs, OPENAI_API_KEY).
// Fallback: the deterministic heuristic below. The agent can still adjust tiers via MCP.

export type HighlightKind = 'keyword' | 'question' | 'cta';
export type HighlightSpan = {start: number; end: number; kind: HighlightKind}; // word indices, inclusive
export type TextFix = {index: number; text: string}; // display-text correction (guion spelling/accents)
export type HighlightResult = {spans: HighlightSpan[]; fixes?: TextFix[]};

type AnyWord = {tier?: number; word?: string; text?: string};
const raw = (w: AnyWord) => w.word ?? w.text ?? '';
const bare = (w: AnyWord) => raw(w).toLowerCase().replace(/[.,!?;:¿¡"'()-]/g, '');

export function applyHighlights(words: AnyWord[], res: HighlightResult): number {
  let n = 0;
  for (const s of res.spans) {
    for (let i = Math.max(0, s.start); i <= Math.min(words.length - 1, s.end); i++) {
      if (!words[i].tier) { words[i].tier = 1; n++; }
    }
  }
  for (const f of res.fixes ?? []) {
    const w = words[f.index];
    if (!w || !f.text) continue;
    if (typeof w.word === 'string') w.word = f.text;
    else if (typeof w.text === 'string') w.text = f.text;
  }
  return n;
}

// Spanish imperative CTA openers (extendable)
const CTA_VERBS = new Set(['comenta', 'comparte', 'llena', 'agenda', 'escríbeme', 'escribeme', 'escríbenos', 'escribenos', 'mándanos', 'mandanos', 'mándame', 'mandame', 'visita', 'conoce', 'aprovecha', 'ponte', 'ven', 'llama', 'llámanos', 'llamanos', 'regístrate', 'registrate', 'descarga', 'únete', 'unete', 'entra', 'checa', 'revisa', 'pide', 'solicita']);
const STOP = new Set(['y', 'e', 'o', 'pero', 'porque', 'cuando', 'si', 'que']);

export function heuristicClassify(words: AnyWord[]): HighlightSpan[] {
  const spans: HighlightSpan[] = [];
  for (let i = 0; i < words.length; i++) {
    const t = bare(words[i]);
    if (!t) continue;
    // CTA: imperative verb + its object (up to 3 more words, stop at glue/verb/digit)
    if (CTA_VERBS.has(t)) {
      let end = i;
      while (end + 1 < words.length && end - i < 3 && !CTA_VERBS.has(bare(words[end + 1])) && !STOP.has(bare(words[end + 1])) && !/^\d/.test(bare(words[end + 1]))) end++;
      spans.push({start: i, end, kind: 'cta'});
      i = end;
      continue;
    }
    // keyword: digits (prices, sizes, counts) and proper-noun runs (names, places)
    if (/^\d/.test(t)) { spans.push({start: i, end: i, kind: 'keyword'}); continue; }
    if (/^[A-ZÁÉÍÓÚÑ]/.test(raw(words[i]))) {
      let end = i;
      while (end + 1 < words.length && (/^[A-ZÁÉÍÓÚÑ]/.test(raw(words[end + 1])) || /^\d/.test(bare(words[end + 1])))) end++;
      spans.push({start: i, end, kind: 'keyword'});
      i = end;
    }
  }
  return spans;
}

// LLM pass prompt. Input: numbered transcript words (+ optional guion text for spelling).
// Output: {"spans": [{start,end,kind}], "fixes": [{index,text}]} — indices into the input.
export const CLASSIFY_PROMPT = `You classify caption words for a Spanish real-estate reel (VIBEM).
You receive numbered transcript words, and optionally the GUION (the script the talent read).
Return ONLY JSON: {"spans": [{"start": int, "end": int, "kind": "keyword"|"question"|"cta"}], "fixes": [{"index": int, "text": string}]}.

spans (word indices, inclusive) — mark:
- keyword: amenidades, nombres propios, lugares, cifras y medidas (ej. "Montealbán 326", "pet park", "noventa metros", "realidad virtual", "internet rápido y estable").
- question: cualquier pregunta completa al espectador.
- cta: llamados a la acción (ej. "comenta aquí abajo", "llena el formulario", "escríbeme hoy", "agenda tu cita") — la frase completa del llamado.
Rules: spans never overlap; prefer the amenity/name itself over whole sentences; a page should keep at most one highlight span plus its CTA; when in doubt, leave unmarked.

fixes (only when a GUION is given): the display text of the word at index, corrected to the guion's exact spelling and accents where the spoken word matches a guion word (ej. ASR "skybull" -> "skypool", "60" -> "sesenta" if the guion says "sesenta"). Never invent wording that was not said; only fix spelling, accents and number style. Omit fixes when no guion was provided.`;
