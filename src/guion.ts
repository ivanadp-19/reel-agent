// The guion (the client's script) against what the ASR heard. Pure: no fs.
//
// align() pairs ASR words with guion tokens by sequence alignment over normalized text
// (lowercase, no accents, ñ → n, no punctuation; digits and Spanish number words compare
// by value). reconcileWords() then, in the captions pipeline:
//   - a word the guion spells differently (accents, case, number style) takes the guion's
//     spelling, keeping its ASR time;
//   - one ASR word that swallowed several guion tokens ("acomodan" = "acomoda" + "a") is split
//     into them, proportional timing inside its span; several ASR words that are one guion
//     token ("sky pool" → "skypool") become one word;
//   - a near-miss ("acomodan" vs "acomoda") is adopted only next to an exact match (anchor);
//     anything else is left as the ASR heard it and reported, never guessed.
// Content conflicts (70 vs 60, another name) keep the audio: the editor decides, so they
// are reported, never resolved. guionIssues() is the coverage check validate runs on the
// captions as they stand: guion words missing or altered, conflicts, reconciliation-made
// timing errors.

export type GuionToken = {text: string; core: string; key: string; sentStart: boolean; entity: boolean};

// what the ASR said, one word, as the aligner needs it
export type AsrToken = {text: string; unit?: string}; // unit: the clip it sits on (no join across a cut)

export type AlignOp =
  | {kind: 'pair'; asr: number[]; guion: number[]; class: 'exact' | 'fix' | 'conflict' | 'ambiguous'; conflict?: 'number' | 'entity'}
  | {kind: 'asr'; asr: number} // said, not in the guion
  | {kind: 'guion'; guion: number}; // in the guion, not said (or not heard)

// ---------- normalization ----------
const EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
export const coreOf = (s: string) => s.replace(EDGE, '');
// accents and ñ fold away for matching only; surface forms are kept apart
export const normKey = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// ---------- Spanish numbers ----------
const NUM: Record<string, number> = {
  cero: 0, uno: 1, un: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, veintiuno: 21, veintiun: 21, veintiuna: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25,
  veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60,
  setenta: 70, ochenta: 80, noventa: 90, cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300,
  trescientas: 300, cuatrocientos: 400, cuatrocientas: 400, quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600,
  setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900,
};
const ARTICLE = new Set(['un', 'una', 'uno']); // a number only against digits ("1 recámara" ↔ "una recámara")

// value of a run of keys ("70", "setenta", "treinta y dos", "dos mil quinientos"), or undefined
export function numberOf(keys: string[]): number | undefined {
  if (keys.length === 1 && /^\d+$/.test(keys[0])) return Number(keys[0]);
  if (!keys.length || keys[0] === 'y' || keys[keys.length - 1] === 'y') return undefined;
  let total = 0, cur = 0, any = false;
  for (const k of keys) {
    if (k === 'y') continue;
    if (k === 'mil') { total += (cur || 1) * 1000; cur = 0; any = true; continue; }
    if (!(k in NUM)) return undefined;
    cur += NUM[k]; any = true;
  }
  return any ? total + cur : undefined;
}
const isArticle = (keys: string[]) => keys.length === 1 && ARTICLE.has(keys[0]);
const isDigits = (keys: string[]) => keys.length === 1 && /^\d+$/.test(keys[0]);
function numbersOf(a: string[], g: string[]): [number, number] | undefined {
  const an = numberOf(a), gn = numberOf(g);
  if (an == null || gn == null) return undefined;
  if ((isArticle(a) && !isDigits(g)) || (isArticle(g) && !isDigits(a))) return undefined; // "un" vs "una" is wording
  return [an, gn];
}

// ---------- the guion ----------
// Stage directions are not said: [bracketed] and (parenthesized) text, and lines that open with a
// direction label (INSERTO: plazas, SUPER: …, B-ROLL: …).
const DIRECTION = /^\s*(inserto|insert|super|b-?roll|escena|toma|corte|nota|texto en pantalla|gr[aá]fico|m[uú]sica|sfx|vo|off)\s*:/i;
export function tokenizeGuion(text: string): GuionToken[] {
  const said = text.split(/\r?\n/).filter((l) => !DIRECTION.test(l)).join('\n').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');
  const out: GuionToken[] = [];
  let sentStart = true;
  for (const raw of said.split(/[\s—–]+|(?<=\p{L})\/(?=\p{L})/u)) {
    const core = coreOf(raw), key = normKey(raw);
    if (!key) { if (/[.!?…]/.test(raw)) sentStart = true; continue; }
    const start = sentStart || /^[¿¡]/.test(raw);
    out.push({text: raw, core, key, sentStart: start, entity: (!start && /^\p{Lu}/u.test(core)) || /\d/.test(core) || (numberOf([key]) != null && !ARTICLE.has(key))});
    sentStart = /[.!?…]["»”']?$/.test(raw);
  }
  return out;
}

// ---------- alignment ----------
function lev(a: string, b: string): number {
  if (a === b) return 0;
  const row = Array.from({length: b.length + 1}, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return row[b.length];
}
export const similarity = (a: string, b: string) => (a || b ? 1 - lev(a, b) / Math.max(a.length, b.length) : 1);

const GAP = 1;
const SIMILAR = 0.7; // a 1:1 pair this close is a spelling difference, not other wording
const GROUP_MIN = 0.75; // a split / join must read almost the same once glued
// (asr words, guion tokens) per step
const STEPS: [number, number][] = [[1, 1], [1, 0], [0, 1], [1, 2], [1, 3], [2, 1], [3, 1]];

const NUMERIC = (k: string) => /^\d+$/.test(k) || k in NUM || k === 'y' || k === 'mil';
const lenOf = (ks: string[]) => ks.reduce((n, k) => n + k.length, 0);

function pairCost(a: string[], g: string[], numeric = a.every(NUMERIC) && g.every(NUMERIC)): number {
  if (numeric) {
    const nums = numbersOf(a, g);
    if (nums) return nums[0] === nums[1] ? (a.length + g.length > 2 ? 0.05 : 0) : 0.8; // a different number still pairs: it is the conflict
  }
  if (a.length === 1 && g.length === 1) return a[0] === g[0] ? 0 : Math.min(1.9, 2 * (1 - similarity(a[0], g[0])));
  const la = lenOf(a), lg = lenOf(g);
  if (Math.abs(la - lg) > (1 - GROUP_MIN) * Math.max(la, lg)) return Infinity; // cannot read almost the same
  if (a.some((k) => g.includes(k))) return Infinity; // one piece matches exactly: that is a 1:1 plus a gap
  const s = similarity(a.join(''), g.join(''));
  return s < GROUP_MIN ? Infinity : 2 * (1 - s) + 0.15 * (a.length + g.length - 2);
}

export function align(asr: AsrToken[], guion: GuionToken[]): AlignOp[] {
  const ak = asr.map((w) => normKey(w.text));
  const gk = guion.map((t) => t.key);
  const n = ak.length, m = gk.length;
  const W = m + 1;
  const cost = new Float64Array((n + 1) * W).fill(Infinity);
  const back = new Int8Array((n + 1) * W).fill(-1);
  // 1:1 similarity per pair of distinct words (a script repeats its words): interned, computed once
  const intern = (ks: string[]) => { const ids = new Map<string, number>(); return {ids: ks.map((k) => (ids.has(k) ? ids.get(k)! : (ids.set(k, ids.size), ids.size - 1))), size: () => ids.size}; };
  const ai = intern(ak), gi = intern(gk);
  const G = gi.size();
  const simTable = new Float32Array(ai.size() * G).fill(-1);
  const sim1 = (i: number, j: number) => {
    const at = ai.ids[i] * G + gi.ids[j];
    if (simTable[at] < 0) simTable[at] = similarity(ak[i], gk[j]);
    return simTable[at];
  };
  // prefix sums: numeric tokens and key lengths
  const pre = (ks: string[], f: (k: string) => number) => ks.reduce((acc, k) => (acc.push(acc[acc.length - 1] + f(k)), acc), [0]);
  const aNum = pre(ak, (k) => +NUMERIC(k)), gNum = pre(gk, (k) => +NUMERIC(k));
  const aLen = pre(ak, (k) => k.length), gLen = pre(gk, (k) => k.length);
  cost[0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (!i && !j) continue;
      let best = Infinity, arg = -1;
      for (let s = 0; s < STEPS.length; s++) {
        const [da, dg] = STEPS[s];
        if (i < da || j < dg) continue;
        const prev = cost[(i - da) * W + (j - dg)];
        if (prev >= best) continue; // no step costs less than 0
        let c: number;
        if (!dg || !da) c = GAP;
        else {
          const numeric = aNum[i] - aNum[i - da] === da && gNum[j] - gNum[j - dg] === dg;
          // a split / join: cheap rejections before any string is built — never across a cut
          if (da + dg > 2 && !numeric) {
            const la = aLen[i] - aLen[i - da], lg = gLen[j] - gLen[j - dg];
            if (Math.abs(la - lg) > (1 - GROUP_MIN) * Math.max(la, lg)) continue;
          }
          let same = true;
          for (let k = i - da + 1; k < i; k++) if (asr[k].unit !== asr[i - da].unit) same = false;
          if (!same) continue;
          c = da === 1 && dg === 1 && !numeric
            ? (ak[i - 1] === gk[j - 1] ? 0 : Math.min(1.9, 2 * (1 - sim1(i - 1, j - 1))))
            : pairCost(ak.slice(i - da, i), gk.slice(j - dg, j), numeric);
        }
        if (prev + c < best) { best = prev + c; arg = s; }
      }
      cost[i * W + j] = best;
      back[i * W + j] = arg;
    }
  }
  const ops: AlignOp[] = [];
  for (let i = n, j = m; i || j;) {
    const [da, dg] = STEPS[back[i * W + j]];
    if (!dg) ops.push({kind: 'asr', asr: i - 1});
    else if (!da) ops.push({kind: 'guion', guion: j - 1});
    else ops.push({kind: 'pair', asr: range(i - da, i), guion: range(j - dg, j), class: 'exact'});
    i -= da; j -= dg;
  }
  ops.reverse();
  for (const op of ops) if (op.kind === 'pair') Object.assign(op, classify(op.asr.map((k) => ak[k]), op.guion.map((k) => guion[k]), asr.slice(op.asr[0], op.asr[op.asr.length - 1] + 1)));
  return ops;
}
const range = (a: number, b: number) => Array.from({length: b - a}, (_, k) => a + k);

function classify(a: string[], g: GuionToken[], words: AsrToken[]): Pick<Extract<AlignOp, {kind: 'pair'}>, 'class' | 'conflict'> {
  const gk = g.map((t) => t.key);
  const nums = numbersOf(a, gk);
  if (nums) return nums[0] === nums[1] ? {class: 'exact'} : {class: 'conflict', conflict: 'number'};
  if (a.join('') === gk.join('')) return {class: 'exact'};
  if (a.length > 1 || g.length > 1) return {class: 'fix'}; // align() only groups what reads almost the same
  if (similarity(a[0], gk[0]) >= SIMILAR) return {class: 'fix'};
  // other wording: a name or a figure in either side is content — the audio says one thing, the guion another
  if (g[0].entity || /\d/.test(a[0]) || (numberOf(a) != null && !ARTICLE.has(a[0])) || words.some((w) => /^\p{Lu}/u.test(coreOf(w.text)) && !g[0].sentStart)) return {class: 'conflict', conflict: 'entity'};
  return {class: 'ambiguous'};
}

// a near-miss is adopted only next to an exact match: without that anchor the pairing itself may be wrong
const anchored = (ops: AlignOp[], k: number) => [ops[k - 1], ops[k + 1]].some((o) => o?.kind === 'pair' && o.class === 'exact');

// ---------- reconciliation (captions pipeline) ----------
export type ReconcilableWord = {word: string; startMs: number; endMs: number; srcStartMs?: number; srcEndMs?: number; wid?: string; clipId?: string; src?: string; asr?: string};
export type Reconciliation = {
  adopted: {wid?: string; asr: string; text: string; how: 'spelling' | 'split' | 'join'}[];
  conflicts: {wid?: string; asr: string; guion: string; what: 'number' | 'entity'}[];
  ambiguous: {wid?: string; asr: string; guion: string}[];
  missing: {guion: string; afterWid?: string}[];
  extra: {wid?: string; asr: string}[]; // one ASR word the guion does not have, between two matches (the spurious "de")
  aligned: number; // guion tokens paired with an exact match
};

const NOT_SPOKEN = /^[.,!?;:()\-—¿¡]*$/; // pause / parenthesis tokens the transcript carries: kept, never aligned
const lead = (s: string) => s.match(/^[^\p{L}\p{N}]*/u)![0];
const trail = (s: string) => s.match(/[^\p{L}\p{N}]*$/u)![0];

// the guion's spelling, with the first letter's case from the ASR where either side starts a sentence
// (the guion's capital "Acomoda" opens its sentence, not necessarily the reel's)
function surface(g: GuionToken, asrCore: string, asrStartsSentence: boolean): string {
  if (!(g.sentStart || asrStartsSentence) || !asrCore) return g.core;
  const up = /^\p{Lu}/u.test(asrCore);
  return (up ? g.core[0].toUpperCase() : g.core[0].toLowerCase()) + g.core.slice(1);
}

export function reconcileWords<T extends ReconcilableWord>(words: T[], guionText: string): {words: T[]; report: Reconciliation} {
  const report: Reconciliation = {adopted: [], conflicts: [], ambiguous: [], missing: [], extra: [], aligned: 0};
  const guion = tokenizeGuion(guionText ?? '');
  if (!guion.length || !words.length) return {words, report};
  const idx = words.map((w, i) => (NOT_SPOKEN.test(w.word) || !normKey(w.word) ? -1 : i)).filter((i) => i >= 0);
  const asr = idx.map((i) => ({text: words[i].word, unit: words[i].clipId ?? words[i].src}));
  const ops = align(asr, guion);
  const replace = new Map<number, T[]>(); // word index → what stands in its place ([] = joined into the word before)
  const startsSentence = (i: number) => { for (let k = i - 1; k >= 0; k--) if (normKey(words[k].word)) return /[.!?…]$/.test(words[k].word); return true; };
  let lastWid: string | undefined;
  ops.forEach((op, k) => {
    if (op.kind === 'guion') {
      const prev = report.missing[report.missing.length - 1];
      if (prev && ops[k - 1]?.kind === 'guion') prev.guion += ' ' + guion[op.guion].core;
      else report.missing.push({guion: guion[op.guion].core, afterWid: lastWid});
      return;
    }
    if (op.kind === 'asr') {
      const w = words[idx[op.asr]];
      lastWid = w.wid ?? lastWid;
      const isPair = (o?: AlignOp) => o?.kind === 'pair' && o.class === 'exact';
      if (isPair(ops[k - 1]) && isPair(ops[k + 1])) report.extra.push({wid: w.wid, asr: w.word});
      return;
    }
    const ws = op.asr.map((a) => idx[a]);
    const first = words[ws[0]], last = words[ws[ws.length - 1]];
    lastWid = last.wid ?? lastWid;
    const gs = op.guion.map((j) => guion[j]);
    const asrText = ws.map((i) => words[i].word).join(' ');
    const guionText = gs.map((t) => t.core).join(' ');
    if (op.class === 'exact') report.aligned += gs.length;
    if (op.class === 'conflict') return void report.conflicts.push({wid: first.wid, asr: asrText, guion: guionText, what: op.conflict!});
    if (op.class === 'ambiguous' || (op.class === 'fix' && !anchored(ops, k))) return void report.ambiguous.push({wid: first.wid, asr: asrText, guion: guionText});
    const cores = gs.map((t, n) => surface(t, n === 0 ? coreOf(first.word) : '', n === 0 && startsSentence(ws[0])));
    const pre = lead(first.word), post = trail(last.word);
    if (ws.length === 1 && gs.length === 1) {
      const text = pre + cores[0] + post;
      if (text === first.word) return;
      replace.set(ws[0], [{...first, word: text, asr: first.asr ?? first.word}]);
      report.adopted.push({wid: first.wid, asr: first.word, text, how: 'spelling'});
    } else if (ws.length === 1) {
      // one ASR word, several guion tokens: pieces share its id and split its span by length
      const weights = gs.map((t) => Math.max(1, t.key.length));
      const total = weights.reduce((s, x) => s + x, 0);
      const cut = (a: number, b: number) => { let acc = 0; return [a, ...weights.map((x) => a + Math.round(((b - a) * (acc += x)) / total))]; };
      const t = cut(first.startMs, first.endMs);
      const st = first.srcStartMs != null && first.srcEndMs != null ? cut(first.srcStartMs, first.srcEndMs) : null;
      replace.set(ws[0], gs.map((_, n) => ({
        ...first,
        word: (n === 0 ? pre : '') + cores[n] + (n === gs.length - 1 ? post : ''),
        startMs: t[n], endMs: t[n + 1],
        ...(st ? {srcStartMs: st[n], srcEndMs: st[n + 1]} : {}),
        asr: first.asr ?? first.word,
      })));
      report.adopted.push({wid: first.wid, asr: first.word, text: cores.join(' '), how: 'split'});
    } else {
      // several ASR words, one guion token: one word over their span, the first one's id
      const text = pre + cores[0] + post;
      replace.set(ws[0], [{...first, word: text, endMs: last.endMs, ...(last.srcEndMs != null ? {srcEndMs: last.srcEndMs} : {}), asr: asrText}]);
      for (const i of ws.slice(1)) replace.set(i, []);
      report.adopted.push({wid: first.wid, asr: asrText, text, how: 'join'});
    }
  });
  return {words: words.flatMap((w, i) => replace.get(i) ?? [w]), report};
}

export const reconciliationLine = (r: Reconciliation) =>
  `guion: ${r.aligned} words matched, ${r.adopted.length} adopted (${['spelling', 'split', 'join'].map((h) => `${r.adopted.filter((a) => a.how === h).length} ${h}`).join(', ')}), ${r.conflicts.length} conflicts kept as said, ${r.ambiguous.length} left as heard, ${r.missing.length} missing runs, ${r.extra.length} extra`;

// ---------- coverage check (validate) ----------
type Issue = {level: 'error' | 'warn'; code: string; msg: string; ref?: string};
type Page = {id: string; startMs: number; endMs?: number; words: {text: string; wid?: string; startMs: number; endMs: number; asr?: string}[]; clipId?: string};
const MAX_LISTED = 8;
const q = (s: string) => `"${s.length > 60 ? s.slice(0, 57) + '…' : s}"`;

// shown: the caption pages as they play (timeline order). raw: the stored pages, for the timing of
// reconciled words. The audio wins every conflict; these only say where a human should look.
export function guionIssues(guionText: string, shown: Page[], raw: Page[] = shown): Issue[] {
  const out: Issue[] = [];
  // reconciliation-made words (asr set) must keep a sane time: positive, ordered, inside what was said
  for (const c of raw) {
    c.words.forEach((w, k) => {
      if (w.asr == null) return;
      const prev = c.words[k - 1];
      const bad = w.startMs < 0 ? 'starts before 0' : w.endMs <= w.startMs ? `ends at ${w.endMs} ms, before it starts (${w.startMs} ms)` : prev && w.startMs < prev.endMs - 1 ? `overlaps "${prev.text}" (${w.startMs} < ${prev.endMs} ms)` : null;
      if (bad) out.push({level: 'error', code: 'guion-timing', msg: `caption ${c.id}: "${w.text}" (from the guion, ASR "${w.asr}") ${bad} — regenerate captions (run_ai_step captions)`, ref: c.id});
    });
  }
  const guion = tokenizeGuion(guionText ?? '');
  if (!guion.length) return out;
  const words = [...shown].sort((a, b) => a.startMs - b.startMs).flatMap((c) => c.words.map((w) => ({...w, page: c.id, unit: c.clipId ?? c.id})));
  const spoken = words.filter((w) => normKey(w.text));
  const ops = align(spoken.map((w) => ({text: w.text, unit: w.unit})), guion);
  const listed = new Map<string, number>();
  const push = (i: Issue) => { const n = (listed.get(i.code) ?? 0) + 1; listed.set(i.code, n); if (n <= MAX_LISTED) out.push(i); };
  let lastPage: string | undefined;
  ops.forEach((op, k) => {
    if (op.kind === 'guion') {
      if (ops[k - 1]?.kind === 'guion') return;
      let e = k;
      while (ops[e + 1]?.kind === 'guion') e++;
      const run = ops.slice(k, e + 1).map((o) => guion[(o as {guion: number}).guion].core).join(' ');
      push({level: 'warn', code: 'guion-missing', msg: `guion ${q(run)} is not in the captions${lastPage ? ` (after ${lastPage})` : ' (before the first page)'} — cut on purpose, or not heard? Check the take`, ref: lastPage});
      return;
    }
    if (op.kind === 'asr') {
      const w = spoken[op.asr];
      lastPage = w.page;
      const exact = (o?: AlignOp) => o?.kind === 'pair' && o.class === 'exact';
      if (exact(ops[k - 1]) && exact(ops[k + 1])) push({level: 'warn', code: 'guion-extra', msg: `caption ${w.page}: "${w.text}" is not in the guion (between two words that are) — said, or an ASR artifact? Listen; edit_caption if it was never said`, ref: w.page});
      return;
    }
    const ws = op.asr.map((a) => spoken[a]);
    lastPage = ws[ws.length - 1].page;
    const said = ws.map((w) => w.text).join(' '), script = op.guion.map((j) => guion[j].core).join(' ');
    if (op.class === 'conflict') push({level: 'warn', code: 'guion-conflict', msg: `caption ${ws[0].page}: the audio says ${q(said)}, the guion says ${q(script)} — the audio stays on screen; a human confirms which is right`, ref: ws[0].page});
    else if (op.class !== 'exact') push({level: 'warn', code: 'guion-altered', msg: `caption ${ws[0].page}: ${q(said)} where the guion has ${q(script)} — left as heard; edit_caption if the guion is what was said`, ref: ws[0].page});
  });
  for (const [code, n] of listed) if (n > MAX_LISTED) out.push({level: 'warn', code, msg: `${n - MAX_LISTED} more ${code} like the above`});
  return out;
}
