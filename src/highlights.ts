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

// v11.1 (César 11:58): whisper words carry no punctuation, so pageWords could not see sentence
// boundaries and merged phrases ('...minutos' + 'salón para sesenta invitados' on one page).
// Walk the guion's punctuated script and attach each sentence/clause mark to the matched word —
// paging tests SENT_END/CLAUSE_END on the raw word, display still strips the marks via toDisplay.
export function applyGuionPunctuation(words: AnyWord[], guion: string): {marks: number; starts: number} {
  const bareTok = (s: string) => s.toLowerCase().replace(/[.,!?;:¿¡"'()-]/g, '');
  const tokens = guion.split(/\s+/).filter((t) => bareTok(t));
  let wi = 0;
  let marks = 0;
  let starts = 0;
  let prevSentEnd = false;
  let skips = 0; // guion tokens without a stream match since the last match
  const WALK_GLUE = new Set(['a', 'de', 'en', 'con', 'por', 'para', 'y', 'o', 'ni', 'al', 'del']);
  for (const tok of tokens) {
    const b = bareTok(tok);
    let j = -1;
    for (let k = wi; k < Math.min(words.length, wi + 6); k++) {
      if (bareTok(raw(words[k])) === b) { j = k; break; }
    }
    // sentence state comes from the GUION's own sequence, so it advances even on skipped
    // tokens — drift in the previous sentence's tail can't hide the boundary that follows
    const endsSent = /[.!?]$/.test(tok);
    if (j < 0) { skips++; prevSentEnd = prevSentEnd || endsSent; continue; } // ASR drift: skip this guion token
    wi = j + 1;
    // a guion sentence's FIRST word marks a break-before in the stream ('…regresas a las
    // nueve. / Aquí está el salón…' vs recorded '…regresar tan tarde aquí está…': 'Aquí' matches)
    if (prevSentEnd && skips <= 12) {
      // …but cap the carry: a whole unsaid sentence (20+ skipped tokens) must not flag
      // whatever word happens to match next. And when the sentence's recorded head is a
      // function word the script says differently ('De este lado' → 'en este lado'), walk
      // the flag back over the glue words so the page never ends on a dangling 'en'
      let s = j;
      while (s - 1 >= 0) {
        const prevRaw = raw(words[s - 1]);
        if (/[.,!?;:]$/.test(prevRaw) || (words[s - 1] as {sentenceStart?: boolean}).sentenceStart) break;
        if (!WALK_GLUE.has(bareTok(prevRaw))) break;
        s--;
      }
      (words[s] as {sentenceStart?: boolean}).sentenceStart = true;
      starts++;
    }
    skips = 0;
    prevSentEnd = endsSent;
    const m = tok.match(/[.,!?;:]$/);
    if (m && !/[.,!?;:]$/.test(raw(words[j]))) {
      const w = words[j] as {word?: string; text?: string};
      if (typeof w.word === 'string') w.word += m[0];
      else if (typeof w.text === 'string') w.text += m[0];
      marks++;
    }
  }
  return {marks, starts};
}


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
