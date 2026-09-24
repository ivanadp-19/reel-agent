// B-roll suggestions from the user's own library: which asset goes over which
// words, following the rules editors use (start on the mention, 0.5–8 s, one
// insert per ~9 s, never over the hook or the closing line) and covering
// footage that is black. Pure: the agent approves each suggestion with add_broll.

export type Mention = {wid: string; word: string; startMs: number; endMs: number}; // absolute timeline ms
export type Asset = {id: string; kind: 'video' | 'image'; durationSec?: number; tags: string[]; desc?: string; label?: string};
export type Span = {startMs: number; endMs: number};
export type Suggestion = {assetId: string | null; atWid?: string; startMs: number; endMs: number; score: number; why: string; cover: boolean; query?: string};

export const RULES = {hookMs: 3000, minMs: 500, maxMs: 8000, defaultMs: 4000, gapMs: 9000, leadMs: 300, windowMs: 1500};

const STOP = new Set(['the', 'and', 'that', 'this', 'with', 'for', 'you', 'your', 'are', 'was', 'have', 'has', 'not', 'but', 'from', 'they', 'them', 'our', 'all', 'can', 'will', 'just', 'here', 'there', 'when', 'what', 'una', 'uno', 'unos', 'unas', 'los', 'las', 'del', 'con', 'por', 'para', 'que', 'como', 'muy', 'mas', 'pero', 'este', 'esta', 'esto', 'estos', 'estas', 'ese', 'esa', 'eso', 'tu', 'tus', 'sus', 'sin', 'sobre', 'hasta', 'desde', 'donde', 'cuando', 'tambien', 'ahi', 'aqui', 'todo', 'toda', 'todos', 'todas', 'tiene', 'tienes', 'son', 'ser', 'esta', 'estan', 'porque', 'quiera', 'quieres', 'quieras', 'queda', 'quedar', 'quedarte', 'abrir', 'grande', 'verdaderamente', 'planeas', 'necesitas', 'salir', 'subes', 'despues', 'mismo', 'misma', 'tampoco', 'guardas', 'escribeme', 'enseno', 'completo', 'propia', 'propio', 'nombre', 'about', 'really', 'something', 'thing', 'things', 'actually', 'because', 'should', 'would', 'could', 'even']);
// content words, accent-free, lightly stemmed so "cavas" meets "cava" and "eventos" meets "evento"
export function contentWords(text: string): string[] {
  const raw = String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]{3,}/g) ?? [];
  return raw.filter((t) => !STOP.has(t)).map((t) => (t.length > 5 && t.endsWith('es') ? t.slice(0, -2) : t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t));
}

const merge = (spans: Span[]): Span[] => {
  const s = [...spans].sort((a, b) => a.startMs - b.startMs);
  const out: Span[] = [];
  for (const x of s) { const last = out[out.length - 1]; if (last && x.startMs <= last.endMs) last.endMs = Math.max(last.endMs, x.endMs); else out.push({...x}); }
  return out;
};
const overlaps = (a: Span, b: Span) => a.startMs < b.endMs && b.startMs < a.endMs;

export function suggestBroll(mentions: Mention[], assets: Asset[], opts: {totalMs: number; black?: Span[]; existing?: Span[]; lastSentenceStartMs?: number}): Suggestion[] {
  const existing = merge(opts.existing ?? []);
  const black = merge(opts.black ?? []);
  const lastStart = opts.lastSentenceStartMs ?? Infinity;
  const assetWords = assets.map((a) => ({a, set: new Set(contentWords([...a.tags, a.desc ?? '', a.label ?? ''].join(' ')))}));
  const inBlack = (ms: number) => black.some((b) => ms >= b.startMs && ms < b.endMs);

  // score of an asset at a mention: content words shared with the words spoken around it
  const around = (i: number) => new Set(mentions.filter((m) => Math.abs(m.startMs - mentions[i].startMs) <= RULES.windowMs).flatMap((m) => contentWords(m.word)));
  const hits = (set: Set<string>, ctx: Set<string>) => [...set].filter((t) => ctx.has(t));
  // every (asset, mention) pair that shares words, best first; an asset is used once
  const best: {asset: Asset; i: number; score: number; shared: string[]}[] = [];
  for (const {a, set} of assetWords) {
    mentions.forEach((m, i) => {
      if (!contentWords(m.word).some((t) => set.has(t))) return; // the mention itself must match
      const shared = hits(set, around(i));
      if (shared.length) best.push({asset: a, i, score: shared.length, shared});
    });
  }
  best.sort((x, y) => y.score - x.score || mentions[x.i].startMs - mentions[y.i].startMs);

  const out: Suggestion[] = [];
  const taken: Span[] = [...existing];
  const used = new Set<string>();
  for (const b of best) {
    if (used.has(b.asset.id)) continue;
    const m = mentions[b.i];
    let startMs = Math.max(0, m.startMs - RULES.leadMs);
    const dark = black.find((x) => startMs >= x.startMs && startMs < x.endMs);
    if (dark && startMs - dark.startMs < 2000 && !taken.some((t) => overlaps(t, {startMs: dark.startMs, endMs: startMs + 1}))) startMs = dark.startMs; // cover the black from its start
    if (!dark && (startMs < RULES.hookMs || startMs >= lastStart)) continue;
    if (out.some((o) => !o.cover && Math.abs(o.startMs - startMs) < RULES.gapMs)) continue;
    const assetMs = b.asset.durationSec ? b.asset.durationSec * 1000 : RULES.defaultMs;
    const len = Math.min(RULES.maxMs, Math.max(RULES.minMs, Math.min(dark ? RULES.maxMs : RULES.defaultMs, assetMs)));
    let endMs = Math.min(opts.totalMs, startMs + len);
    for (const t of taken) if (t.startMs > startMs && t.startMs < endMs) endMs = t.startMs; // stop at the next insert
    if (endMs - startMs < RULES.minMs || taken.some((t) => overlaps(t, {startMs, endMs}))) continue;
    out.push({assetId: b.asset.id, atWid: m.wid, startMs, endMs, score: b.score, why: `"${b.shared.join(', ')}" at ${(m.startMs / 1000).toFixed(1)} s`, cover: false});
    taken.push({startMs, endMs});
    used.add(b.asset.id);
  }

  // black footage must be covered: the best-matching asset for what is said there, or a stock query.
  // Long stretches are split at sentence ends into ≤ 8 s pieces; slivers extend a neighbour.
  const sentenceEnds = mentions.filter((m) => /[.!?]$/.test(m.word)).map((m) => m.endMs);
  for (const span of black) {
    let cursor = span.startMs;
    const covered = merge(taken.filter((t) => overlaps(t, span)));
    const pieces: Span[] = [];
    for (const c of covered) { if (c.startMs > cursor) pieces.push({startMs: cursor, endMs: c.startMs}); cursor = Math.max(cursor, c.endMs); }
    if (cursor < span.endMs) pieces.push({startMs: cursor, endMs: span.endMs});
    const chunks: Span[] = [];
    for (const piece of pieces) {
      let a = piece.startMs;
      while (piece.endMs - a > RULES.maxMs) {
        const cut = sentenceEnds.filter((e) => e > a + RULES.minMs * 2 && e <= a + RULES.maxMs).pop() ?? a + RULES.maxMs;
        chunks.push({startMs: a, endMs: cut}); a = cut;
      }
      chunks.push({startMs: a, endMs: piece.endMs});
    }
    for (const piece of chunks) {
      if (piece.endMs - piece.startMs < 1500) {
        // a sliver: stretch the insert that ends where it starts, if any
        const prev = out.find((o) => Math.abs(o.endMs - piece.startMs) < 40 && piece.endMs - o.startMs <= RULES.maxMs + 1500);
        if (prev) { prev.endMs = piece.endMs; taken.push(piece); continue; }
        if (piece.endMs - piece.startMs < RULES.minMs) continue;
      }
      const said = mentions.filter((m) => m.startMs < piece.endMs && m.endMs > piece.startMs);
      const ctx = new Set(said.flatMap((m) => contentWords(m.word)));
      const pick = assetWords.map(({a, set}) => ({a, shared: hits(set, ctx)})).filter((x) => x.shared.length).sort((x, y) => y.shared.length - x.shared.length || (used.has(x.a.id) ? 1 : 0) - (used.has(y.a.id) ? 1 : 0))[0];
      const first = said[0];
      if (pick) { out.push({assetId: pick.a.id, atWid: first?.wid, startMs: piece.startMs, endMs: piece.endMs, score: pick.shared.length, why: `black footage; "${pick.shared.join(', ')}"`, cover: true}); used.add(pick.a.id); }
      else out.push({assetId: null, atWid: first?.wid, startMs: piece.startMs, endMs: piece.endMs, score: 0, why: 'black footage, nothing in the library matches', cover: true, query: [...ctx].slice(0, 4).join(' ')});
      taken.push(piece);
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}
