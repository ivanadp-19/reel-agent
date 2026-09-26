// Yellow words (César 9:27: key words and CTAs render as highlight captions, #FFE500, with the
// pack's key-word entry). Deterministic, no hosted model (AGENTS.md): the project's own tiers win
// (yellowWords); for words the project does not show yet, the rule-based proposer below suggests
// them — figures and dates, proper names, the CTA, the pack's own word list — and the agent adjusts
// them with annotate_captions or the editor.
import {withTiers, wordKey} from './paging.ts';

export type HighlightKind = 'keyword' | 'cta';
export type HighlightSpan = {start: number; end: number; kind: HighlightKind}; // word indices, inclusive
// a pack's proposer rules (Preset.highlight). perSentence: spans a sentence may keep (MAX_PER_SENTENCE
// otherwise). words: nouns the client always marks (amenities, property nouns; accents and case do not
// matter), never trimmed as promotional. maxShare: the share of yellow words validate allows (0.2 otherwise)
export type HighlightRules = {perSentence?: number; words?: string[]; maxShare?: number};

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


// The one place the reel's yellow words are decided before paging: the captions job, which every
// re-page goes through (MCP set_caption_style / run_ai_step, the editor, the CLI). The project's own
// tiers (projectTiers: every word it already shows, 0 included) are authoritative — approved or
// hand-set, they apply exactly and are never re-derived; a word the project knows by its id in the
// source's other transcript (`was`: transcribed again) is the same word. Only words the project does
// not show yet (a new reel, a clip added later) take the proposer's suggestion, marked `proposed`
// (a new pack proposes them again). Returns how many it proposed.
export function yellowWords<T extends AnyWord & {wid?: string; was?: string; proposed?: boolean}>(words: T[], tiers: Record<string, number>, rules: HighlightRules = {}): number {
  const own = {...tiers};
  for (const w of words) if (w.was && !Object.hasOwn(own, wordKey(w)) && Object.hasOwn(tiers, wordKey({...w, wid: w.was}))) own[wordKey(w)] = tiers[wordKey({...w, wid: w.was})];
  const fresh = (w: T) => !w.wid || !Object.hasOwn(own, wordKey(w));
  let n = 0;
  if (words.some(fresh)) {
    for (const s of heuristicClassify(words, rules)) for (let i = s.start; i <= s.end; i++) if (fresh(words[i]) && !words[i].tier) { words[i].tier = 1; n++; }
    for (const w of words) if (fresh(w)) w.proposed = true;
  }
  withTiers(words, own);
  return n;
}

// Selectivity (César's review of G2_H1_C1): the auto pass had "preventa" and "completo" yellow;
// his reference leaves both white and marks the meaning of a sentence instead ("mudar",
// "necesidades"). So: at most MAX_PER_SENTENCE spans a sentence (numbers, names, claims, CTAs),
// never a function word on its own or at the edge of a span, never a promotional adjective or a
// generic real-estate noun. When unsure, white. A pack may set its own rules (HighlightRules):
// César's v11 marks every place, amenity and property noun ('54 DEPARTAMENTOS'), not 1–2 a sentence.
export const MAX_PER_SENTENCE = 2;
const MAX_KEYWORD_WORDS = 4; // "internet rápido y estable"; anything longer is a sentence, not a keyword

// lower case, no accents, no punctuation — what the word lists below are written in
export const fold = (w: AnyWord) => bare(w).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ%²]/g, '');

// Spanish imperative CTA openers, tú and usted forms (extendable; folded)
const CTA_VERBS = new Set(['comenta', 'comparte', 'llena', 'agenda', 'escribeme', 'escribenos', 'mandanos', 'mandame', 'visita', 'conoce', 'aprovecha', 'ponte', 'ven', 'llama', 'llamanos', 'registrate', 'descarga', 'unete', 'entra', 'checa', 'revisa', 'pide', 'solicita',
  'comente', 'llene', 'agende', 'escribanos', 'visite', 'conozca', 'aproveche', 'llamenos', 'registrese', 'descargue', 'solicite', 'pida']);
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

const NUMBER_WORDS = new Set(['dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciseis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidos', 'veintitres', 'veinticuatro', 'veinticinco', 'veintiseis', 'veintisiete', 'veintiocho', 'veintinueve', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa', 'cien', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos', 'mil', 'millon', 'millones']);
const SMALL = new Set(['dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve']);
const UNITS = new Set(['metros', 'metro', 'm2', 'm²', 'mts', 'km', 'kilometros', 'hectareas', 'mil', 'millones', 'pesos', 'dolares', 'mxn', 'usd', '%', 'porciento', 'minutos', 'anos', 'meses', 'recamaras', 'banos', 'niveles', 'pisos', 'cajones']);
const MONTHS = new Set(['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'setiembre', 'octubre', 'noviembre', 'diciembre']);
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
const RANK: Record<HighlightKind, number> = {cta: 0, keyword: 1};
const ownWords = (rules: HighlightRules) => new Set((rules.words ?? []).map((word) => fold({word})));

// the gate the proposer's spans pass: clamp, no overlaps, no function or promotional word at a
// span's edge (a span of nothing else is dropped; the pack's own words are never promotional),
// keywords of at most MAX_KEYWORD_WORDS words, and at most rules.perSentence spans a sentence —
// CTAs first, then by rank (number > name or the pack's word > concept) and position.
export function refineSpans(words: AnyWord[], spans: Ranked[], rules: HighlightRules = {}): HighlightSpan[] {
  const own = ownWords(rules);
  const weak = (i: number) => { const f = fold(words[i]); return !f || FUNCTION_WORDS.has(f) || (isPromo(f) && !own.has(f)); };
  const clean: Ranked[] = [];
  for (const s0 of [...spans].sort((a, b) => a.start - b.start)) {
    let start = Math.max(0, s0.start), end = Math.min(words.length - 1, s0.end);
    const kind: HighlightKind = s0.kind === 'cta' ? 'cta' : 'keyword';
    while (start <= end && weak(start)) start++;
    while (end >= start && weak(end)) end--;
    if (start > end) continue;
    if (kind === 'keyword' && end - start + 1 > MAX_KEYWORD_WORDS) continue;
    if (clean.length && start <= clean[clean.length - 1].end) continue;
    clean.push({start, end, kind, rank: s0.rank ?? RANK[kind]});
  }
  const sid = sentenceIds(words);
  const bySentence = new Map<number, Ranked[]>();
  for (const s of clean) bySentence.set(sid[s.start], [...(bySentence.get(sid[s.start]) ?? []), s]);
  const kept = [...bySentence.values()].flatMap((ss) => ss.map((s, pos) => ({s, pos})).sort((a, b) => (a.s.rank! - b.s.rank!) || (a.pos - b.pos)).slice(0, rules.perSentence ?? MAX_PER_SENTENCE).map((x) => x.s));
  return kept.sort((a, b) => a.start - b.start).map(({start, end, kind}) => ({start, end, kind}));
}

export function heuristicClassify(words: AnyWord[], rules: HighlightRules = {}): HighlightSpan[] {
  const sid = sentenceIds(words);
  const own = ownWords(rules);
  const spans: Ranked[] = [];
  for (let i = 0; i < words.length; i++) {
    const t = fold(words[i]);
    if (!t) continue;
    // the word after j-1 inside the run: same sentence, no comma / colon between them
    const next = (j: number) => (j < words.length && sid[j] === sid[i] && !/[,;:]["')»]*$/.test(raw(words[j - 1])) ? fold(words[j]) : '');
    // CTA: imperative verb + its object (up to 3 more words, stop at glue/verb/number/name/promo word;
    // refineSpans trims a dangling article: "aprovecha la preventa" → "aprovecha")
    if (CTA_VERBS.has(t) && (i === 0 || fold(words[i - 1]) !== 'que')) { // '…que conozca' is a subjunctive, not an ask
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
    // numbers (prices, sizes, counts) with their unit: "90 metros", "noventa metros", "54"; dates: "agosto 2027"
    if (isNum(t) || (MONTHS.has(t) && isNum(next(i + 1)))) {
      let end = i;
      while (isNum(next(end + 1)) || (next(end + 1) === 'y' && isNum(next(end + 2)))) end += isNum(next(end + 1)) ? 1 : 2; // 'cincuenta y cuatro'
      const numeric = words.slice(i, end + 1).map(fold);
      if (UNITS.has(next(end + 1))) end++;
      else if (numeric.length === 1 && SMALL.has(t)) continue; // a lone "dos" is speech, not a figure
      spans.push({start: i, end, kind: 'keyword', rank: 1});
      i = end;
      continue;
    }
    // proper-noun runs (names, places), "de"/"del" inside one: "Ciudad de México". A sentence's
    // first word is capitalized anyway, so alone it is not a name ("Preventa…", "Completo…"), nor does
    // it take a figure that counts the word after it ("Tenemos 54 departamentos", "Solo 5 minutos": the
    // number rule marks the figure and its unit); a figure that stands on its own does ("Montealbán 326,").
    if (isCap(words[i]) && !FUNCTION_WORDS.has(t) && !isPromo(t)) {
      const initial = i === 0 || sid[i - 1] !== sid[i];
      const counts = (j: number) => { const m = next(j + 1); return !!m && !FUNCTION_WORDS.has(m) && !isCap(words[j + 1]); };
      let end = i;
      for (;;) {
        const n = next(end + 1);
        if (n && (isCap(words[end + 1]) && !FUNCTION_WORDS.has(n) || (isDigit(n) && (!initial || end > i || !counts(end + 1))))) { end++; continue; }
        if ((n === 'de' || n === 'del') && next(end + 2) && isCap(words[end + 2])) { end += 2; continue; }
        break;
      }
      if (!initial || end > i) { spans.push({start: i, end, kind: 'keyword', rank: 2}); i = end; continue; }
    }
    if (own.has(t)) { spans.push({start: i, end: i, kind: 'keyword', rank: 2}); continue; } // the pack's amenity / property nouns
    if (isConcept(t)) spans.push({start: i, end: i, kind: 'keyword', rank: 3});
  }
  return refineSpans(words, spans, rules);
}
