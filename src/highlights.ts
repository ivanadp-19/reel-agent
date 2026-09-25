// Highlight classification (César 9:27): a classification pass over the transcript
// flags keywords, questions and CTAs ("comenta aquí abajo", "llena el formulario").
// Those words render as highlight captions: solid #FFE500 (the official color),
// Helvetica Bold, same soft shadow, slightly bigger, dynamic entry (highlightRise).
// Primary path: LLM pass (scripts/captions-multiclip.mjs, OPENAI_API_KEY).
// Fallback: the deterministic heuristic below. Both go through refineSpans (selectivity).
// The agent can still adjust tiers via MCP.

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

// Selectivity (César's review of G2_H1_C1): the auto pass had "preventa" and "completo" yellow;
// his reference leaves both white and marks the meaning of a sentence instead ("mudar",
// "necesidades"). So: at most MAX_PER_SENTENCE spans a sentence (numbers, names, claims, CTAs),
// never a function word on its own or at the edge of a span, never a promotional adjective or a
// generic real-estate noun. When unsure, white. refineSpans enforces the same rules on the LLM's
// spans, so both paths end up equally selective.
export const MAX_PER_SENTENCE = 2;
const MAX_KEYWORD_WORDS = 4; // "internet rápido y estable"; anything longer is a sentence, not a keyword

// lower case, no accents, no punctuation — what the word lists below are written in
export const fold = (w: AnyWord) => bare(w).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ%²]/g, '');

// Spanish imperative CTA openers (extendable; folded)
const CTA_VERBS = new Set(['comenta', 'comparte', 'llena', 'agenda', 'escribeme', 'escribenos', 'mandanos', 'mandame', 'visita', 'conoce', 'aprovecha', 'ponte', 'ven', 'llama', 'llamanos', 'registrate', 'descarga', 'unete', 'entra', 'checa', 'revisa', 'pide', 'solicita']);
const STOP = new Set(['y', 'e', 'o', 'pero', 'porque', 'cuando', 'si', 'que']);

// function words: articles, prepositions, pronouns, conjunctions, auxiliaries (ES + EN; folded)
export const FUNCTION_WORDS = new Set([
  'el', 'la', 'los', 'las', 'lo', 'un', 'una', 'uno', 'unos', 'unas', 'al', 'del', 'de', 'a', 'en', 'con', 'por', 'para', 'sin', 'sobre', 'entre', 'hasta', 'desde', 'hacia', 'tras', 'segun',
  'y', 'e', 'o', 'u', 'ni', 'pero', 'porque', 'pues', 'que', 'como', 'cuando', 'donde', 'si', 'ya', 'no', 'mas', 'muy', 'tan', 'tambien',
  'se', 'me', 'te', 'le', 'les', 'nos', 'os', 'mi', 'mis', 'tu', 'tus', 'su', 'sus', 'yo', 'ella', 'ellos', 'ellas', 'usted', 'ustedes', 'nosotros', 'nuestro', 'nuestra', 'nuestros', 'nuestras',
  'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas', 'eso', 'esto', 'aquel', 'aquella', 'todo', 'toda', 'todos', 'todas', 'algo', 'cada',
  'es', 'son', 'ser', 'estar', 'estan', 'estoy', 'fue', 'era', 'hay', 'ha', 'han', 'he', 'has', 'haber', 'tiene', 'tienen', 'tienes', 'tengo', 'va', 'van', 'voy', 'vas', 'puedes', 'puede', 'quieres', 'quiere',
  'the', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'it', 'this', 'that', 'i', 'you', 'we', 'they', 'my', 'your', 'our', 'his', 'her', 'its', 'their', 'us', 'them', 'not', 'so', 'as', 'if', 'than', 'then', 'just', 'also',
]);

// promotional adjectives and generic nouns: they sound like selling, they carry no meaning of
// their own — "preventa", "completo", "exclusivo", "proyecto", "departamentos" stay white
const PROMO_STEMS = ['complet', 'exclusiv', 'unic', 'nuev', 'modern', 'perfect', 'hermos', 'bonit', 'precios', 'lujos', 'privilegiad', 'ampli', 'increible', 'espectacular', 'impresionante', 'excelente', 'especial', 'ideal', 'mejor', 'grande'];
const PROMO_WORDS = new Set(['preventa', 'venta', 'oferta', 'promocion', 'gran', 'lujo', 'premium', 'top', 'calidad', 'oportunidad', 'oportunidades', 'proyecto', 'proyectos', 'departamento', 'departamentos', 'depa', 'depas', 'desarrollo', 'desarrollos', 'casa', 'casas', 'zona', 'zonas', 'ubicacion', 'precio', 'precios', 'amenidades', 'espacio', 'espacios']);
export const isPromo = (f: string) => PROMO_WORDS.has(f) || PROMO_STEMS.some((s) => f.startsWith(s) && /^(|[oa]s?|es|s)$/.test(f.slice(s.length)));

// meaning words: verbs of change or decision and the concept nouns a pitch turns on ("mudar",
// "necesidades"). Deliberately short: a word missing here stays white, which is the safe side.
const CONCEPT = [
  /^mud(ar|arte|arse|arnos|arme|anza|anzas|aste|aron|ate|arias?|aras?)$/, /^necesidad(es)?$/, /^invert(ir|irte|imos)$/, /^inversion(es)?$/, /^plusvalia$/, /^patrimonio$/,
  /^rentabilidad$/, /^ahorr(ar|arte|as|os|o)$/, /^cambi(ar|arte)$/, /^transform(ar|arte|a)$/, /^estren(ar|arlo|arla|es)$/, /^suenos?$/, /^tranquilidad$/, /^privacidad$/, /^seguridad$/, /^libertad$/, /^futuro$/,
];
const isConcept = (f: string) => CONCEPT.some((r) => r.test(f));

const NUMBER_WORDS = new Set(['dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciseis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidos', 'veintitres', 'veinticuatro', 'veinticinco', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa', 'cien', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos', 'mil', 'millon', 'millones']);
const SMALL = new Set(['dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve']);
const UNITS = new Set(['metros', 'metro', 'm2', 'm²', 'mts', 'km', 'kilometros', 'hectareas', 'mil', 'millones', 'pesos', 'dolares', 'mxn', 'usd', '%', 'porciento', 'minutos', 'anos', 'meses', 'recamaras', 'banos', 'niveles', 'pisos', 'cajones']);
const isDigit = (f: string) => /^\d/.test(f);
const isNum = (f: string) => isDigit(f) || NUMBER_WORDS.has(f);
const isCap = (w: AnyWord) => /^[¿¡"'(]*[A-ZÁÉÍÓÚÑ]/.test(raw(w));

// sentence id of every word: a sentence ends at . ! ? … or at a pause of 0.7 s or more
export function sentenceIds(words: AnyWord[]): number[] {
  const ids: number[] = [];
  let id = 0;
  for (let i = 0; i < words.length; i++) {
    ids.push(id);
    const w = words[i] as AnyWord & {endMs?: number};
    const next = words[i + 1] as (AnyWord & {startMs?: number}) | undefined;
    if (/[.!?…]["')»]*$/.test(raw(w)) || (next && typeof w.endMs === 'number' && typeof next.startMs === 'number' && next.startMs - w.endMs >= 700)) id++;
  }
  return ids;
}

type Ranked = HighlightSpan & {rank?: number};
const RANK: Record<HighlightKind, number> = {cta: 0, question: 0, keyword: 1};

// the one gate every classifier's spans pass (heuristic and LLM alike): clamp, no overlaps, no
// function or promotional word at a span's edge (a span of nothing else is dropped), keywords of
// at most MAX_KEYWORD_WORDS words, and at most maxPerSentence spans a sentence — CTAs and
// questions first, then by rank (heuristic: number > name > concept) and position.
export function refineSpans(words: AnyWord[], spans: Ranked[], maxPerSentence = MAX_PER_SENTENCE): HighlightSpan[] {
  const weak = (i: number) => { const f = fold(words[i]); return !f || FUNCTION_WORDS.has(f) || isPromo(f); };
  const clean: Ranked[] = [];
  for (const s0 of [...spans].filter((s) => Number.isInteger(s?.start) && Number.isInteger(s?.end)).sort((a, b) => a.start - b.start)) {
    let start = Math.max(0, s0.start), end = Math.min(words.length - 1, s0.end);
    const kind: HighlightKind = s0.kind === 'question' || s0.kind === 'cta' ? s0.kind : 'keyword';
    if (kind !== 'question') {
      while (start <= end && weak(start)) start++;
      while (end >= start && weak(end)) end--;
    }
    if (start > end) continue;
    if (kind === 'keyword' && end - start + 1 > MAX_KEYWORD_WORDS) continue;
    if (clean.length && start <= clean[clean.length - 1].end) continue;
    clean.push({start, end, kind, rank: s0.rank ?? RANK[kind]});
  }
  const sid = sentenceIds(words);
  const bySentence = new Map<number, Ranked[]>();
  for (const s of clean) bySentence.set(sid[s.start], [...(bySentence.get(sid[s.start]) ?? []), s]);
  const kept = [...bySentence.values()].flatMap((ss) => ss.map((s, pos) => ({s, pos})).sort((a, b) => (a.s.rank! - b.s.rank!) || (a.pos - b.pos)).slice(0, maxPerSentence).map((x) => x.s));
  return kept.sort((a, b) => a.start - b.start).map(({start, end, kind}) => ({start, end, kind}));
}

export function heuristicClassify(words: AnyWord[]): HighlightSpan[] {
  const sid = sentenceIds(words);
  const spans: Ranked[] = [];
  for (let i = 0; i < words.length; i++) {
    const t = fold(words[i]);
    if (!t) continue;
    // the word after j-1 inside the run: same sentence, no comma / colon between them
    const next = (j: number) => (j < words.length && sid[j] === sid[i] && !/[,;:]["')»]*$/.test(raw(words[j - 1])) ? fold(words[j]) : '');
    // CTA: imperative verb + its object (up to 3 more words, stop at glue/verb/number/name/promo word;
    // refineSpans trims a dangling article: "aprovecha la preventa" → "aprovecha")
    if (CTA_VERBS.has(t)) {
      let end = i;
      while (end - i < 3) {
        const n = next(end + 1);
        if (!n || CTA_VERBS.has(n) || STOP.has(n) || isNum(n) || isPromo(n) || isCap(words[end + 1])) break; // a name is its own span
        end++;
      }
      spans.push({start: i, end, kind: 'cta', rank: 0});
      i = end;
      continue;
    }
    // numbers (prices, sizes, counts) with their unit: "90 metros", "noventa metros", "54"
    if (isNum(t)) {
      let end = i;
      while (isNum(next(end + 1))) end++;
      const numeric = words.slice(i, end + 1).map(fold);
      if (UNITS.has(next(end + 1))) end++;
      else if (numeric.length === 1 && SMALL.has(t)) continue; // a lone "dos" is speech, not a figure
      spans.push({start: i, end, kind: 'keyword', rank: 1});
      i = end;
      continue;
    }
    // proper-noun runs (names, places), "de"/"del" inside one: "Ciudad de México". A sentence's
    // first word is capitalized anyway, so alone it is not a name ("Preventa…", "Completo…").
    if (isCap(words[i]) && !FUNCTION_WORDS.has(t) && !isPromo(t)) {
      let end = i;
      for (;;) {
        const n = next(end + 1);
        if (n && (isCap(words[end + 1]) && !FUNCTION_WORDS.has(n) || isDigit(n))) { end++; continue; }
        if ((n === 'de' || n === 'del') && next(end + 2) && isCap(words[end + 2])) { end += 2; continue; }
        break;
      }
      const initial = i === 0 || sid[i - 1] !== sid[i];
      if (!initial || end > i) { spans.push({start: i, end, kind: 'keyword', rank: 2}); i = end; continue; }
    }
    if (isConcept(t)) spans.push({start: i, end: i, kind: 'keyword', rank: 3});
  }
  return refineSpans(words, spans);
}

// the classifier's result, whatever produced it, through the same gate
export const guardHighlights = (words: AnyWord[], res: HighlightResult): HighlightResult => ({spans: refineSpans(words, res.spans ?? []), fixes: res.fixes ?? []});

// LLM pass prompt. Input: numbered transcript words (+ optional guion text for spelling).
// Output: {"spans": [{start,end,kind}], "fixes": [{index,text}]} — indices into the input.
export const CLASSIFY_PROMPT = `You classify caption words for a Spanish real-estate reel (VIBEM).
You receive numbered transcript words, and optionally the GUION (the script the talent read).
Return ONLY JSON: {"spans": [{"start": int, "end": int, "kind": "keyword"|"question"|"cta"}], "fixes": [{"index": int, "text": string}]}.

A span turns yellow on screen. Be very selective: the client's reference edit marks only the words that carry the MEANING of a sentence, and most sentences keep everything white.

spans (word indices, inclusive) — mark at most 1–2 spans per sentence, often none:
- keyword: cifras y medidas ("326", "noventa metros", "54"), nombres propios y lugares ("Montealbán", "Mérida"), una amenidad concreta ("pet park", "sky bar", "realidad virtual"), o la palabra que es la idea o el remate de la frase: verbos de cambio o decisión y sustantivos de concepto (ej. "mudar" en "si te quieres mudar", "necesidades" en "pensado para tus necesidades").
- question: una pregunta completa dirigida al espectador.
- cta: llamados a la acción (ej. "comenta aquí abajo", "llena el formulario", "escríbeme hoy", "agenda tu cita") — el verbo y su objeto, nada más.

NEVER mark:
- function words on their own or at the edge of a span (el, la, de, en, que, y, tu, es, para…).
- promotional adjectives and generic nouns that only sound like selling: "preventa", "completo", "exclusivo", "increíble", "único", "nuevo", "moderno", "lujo", "ideal", "mejor", "gran", "proyecto", "departamentos", "desarrollo", "oportunidad", "ubicación", "precio", "amenidades". Ej. "54 departamentos en preventa" → only "54"; "te enseño el proyecto completo" → nothing; "aprovecha la preventa" → only "aprovecha".
- a whole sentence or clause as a keyword (a keyword is 1–4 words).
Rules: spans never overlap; prefer the number, the name or the meaning word over a longer phrase; when in doubt, leave it unmarked (white).

fixes (only when a GUION is given): the display text of the word at index, corrected to the guion's exact spelling and accents where the spoken word matches a guion word (ej. ASR "skybull" -> "skypool", "60" -> "sesenta" if the guion says "sesenta"). Never invent wording that was not said; only fix spelling, accents and number style. Omit fixes when no guion was provided.`;
