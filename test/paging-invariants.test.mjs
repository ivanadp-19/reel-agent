// Property tests for the pager (src/paging.ts): whatever the words and the pack, some things always
// hold. Seeded PRNG, so every run checks the same streams and a failure reproduces from its seed.
// The generator (mulberry32) and the first invariants are ported from Fats403/remotion-captions-kit
// @ 97232270364bd6bba4ca8d11180c350409495e95, src/create-caption-pages.invariants.test.ts (MIT,
// © 2026 Brayden Blackwell; see NOTICE), vitest → node:test. Ours on top: word ids by position (a guion
// split repeats one), one clip and one sentence per page (a page word shows its text without the period,
// so sentence ends are read from the transcript word), bonds and function words, no orphan or flash page
// that a merge could have fixed. Fats403's pager merges flash pages across a sentence end; ours never does.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pageWords, endsSentence, isGlue, toDisplay} from '../src/paging.ts';
import {PRESETS} from '../src/captionPresets.ts';
import {normKey} from '../src/guion.ts';

const mulberry32 = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const LETTERS = 'abcdefghijklmnopqrstuvwxyzáéñ';
const SUFFIXES = ['', '', '', '', '', '.', ',', '!', '?', '…', '."', ',”', ':', '—'];
const NAMES = ['Playa', 'Carmen', 'Montealbán', 'Mérida', 'Pérez', 'Tulum'];
const SPECIAL = ['de', 'la', 'y', 'en', 'que', 'del', 'the', 'to', 'Sr.', 'No.', 'Av.', 'etc.', '326', '5', '326.', '326,', 'U.S.', 'J.', 'mar.'];
const pick = (rand, xs) => xs[Math.floor(rand() * xs.length)];

// a transcript as assembleWords() + reconcileWords() leave it: one or more clips (k2 is another cut of
// k0's source), pauses, tier spans, capitalized names and numbers, stand-alone marks, a parenthesis now
// and then, a guion split (two pieces, one word id), and sometimes a word that ends before it starts.
// kept: the words the pager shows, in order; cut: a page must start at it (a parenthesis was skipped)
function stream(rand) {
  const words = [], kept = [];
  const n = 1 + Math.floor(rand() * 60);
  let t = Math.floor(rand() * 1000), clip = 'k0', clips = 0, idx = 0, tier = 0, cut = false;
  const push = (word, extra = {}) => {
    const d = 50 + Math.floor(rand() * 500);
    const w = {wid: `s${clip}:${idx++}`, word, src: `clips/${clip === 'k2' ? 'k0' : clip}.mp4`, clipId: clip, startMs: t, endMs: t + d, srcStartMs: t, srcEndMs: t + d, ...extra};
    if (rand() < 0.05) [w.startMs, w.endMs, w.srcStartMs, w.srcEndMs] = [w.endMs, w.startMs, w.srcEndMs, w.srcStartMs]; // ends before it starts
    t += d + (rand() < 0.3 ? Math.floor(rand() * 900) : 0);
    words.push(w);
    return w;
  };
  for (let i = 0; i < n; i++) {
    const r = rand();
    if (r < 0.04 && clips < 2) { clip = `k${++clips}`; t += 500; }
    if (r > 0.97) { push('('); push('risas'); push(')'); cut = true; continue; }
    if (r > 0.94) { push(pick(rand, ['—', ',', '...', '¿'])); continue; }
    if (rand() < 0.1) tier = tier ? 0 : 1;
    let word = '';
    const kind = rand();
    if (kind < 0.25) word = pick(rand, SPECIAL);
    else if (kind < 0.4) word = pick(rand, NAMES) + pick(rand, SUFFIXES);
    else {
      const len = 1 + Math.floor(rand() * 10);
      for (let j = 0; j < len; j++) word += LETTERS[Math.floor(rand() * LETTERS.length)];
      word += pick(rand, SUFFIXES);
    }
    if (rand() < 0.05) word = pick(rand, ['¿', '¡']) + word;
    const w = push(word, tier ? {tier} : {});
    kept.push({...w, cut});
    cut = false;
    if (rand() < 0.04) { idx--; kept.push({...push(pick(rand, ['a', 'lo', 'mismo']), tier ? {tier} : {}), cut: false}); } // a guion split: same wid
  }
  for (const k of kept) { k.endMs = Math.max(k.endMs, k.startMs); k.srcEndMs = Math.max(k.srcEndMs, k.srcStartMs); }
  return {words, kept};
}

// a pack of the catalog, sometimes with bonding on and — never on vibem, whose look is the golden — Fats403's caps
function preset(rand) {
  const p = pick(rand, Object.values(PRESETS));
  const layout = {...p.layout};
  if (rand() < 0.3) layout.unbreakable = true;
  if (!layout.figurePages && rand() < 0.5) {
    for (const k of ['silenceMs', 'maxMs', 'maxChars', 'minMs', 'minWords']) delete layout[k];
    if (rand() < 0.7) layout.silenceMs = 100 + Math.floor(rand() * 800);
    if (rand() < 0.6) layout.maxMs = 500 + Math.floor(rand() * 3000);
    if (rand() < 0.6) layout.maxChars = 15 + Math.floor(rand() * 60);
    if (rand() < 0.6) layout.minMs = Math.floor(rand() * 500);
    if (rand() < 0.6) layout.minWords = 1 + Math.floor(rand() * 3);
    if (rand() < 0.5) { layout.maxCharsLine = 42; layout.maxWords = 12; }
  }
  return {...p, layout};
}

const plain = (t) => t.replace(/,$/, ''); // a kept comma (vibem) is not a character
const chars = (ws) => ws.reduce((n, w) => n + plain(w.text).length + 1, -1);

test('pager invariants hold across 2000 random streams and packs', () => {
  for (let seed = 1; seed <= 2000; seed++) {
    const rand = mulberry32(seed);
    const {words, kept} = stream(rand);
    const p = preset(rand);
    const L = p.layout;
    // a kit glossary of 2–4 consecutive words of the stream itself, taken anywhere (across a clip, a parenthesis
    // or a sentence end too): a term is bonded where it runs inside one clip with no parenthesis or sentence end
    const glossary = kept.length > 1 ? [2, 3, 4].map((n) => { const i = Math.floor(rand() * (kept.length - 1)); return {term: kept.slice(i, i + n).map((w) => w.word).join(' ')}; }) : [];
    const pages = pageWords(words, p, glossary);
    const label = `seed ${seed} ${p.id} ${JSON.stringify(L)} ${JSON.stringify(glossary.map((g) => g.term))}`;
    const out = pages.flatMap((c) => c.words);

    // every word in, every word out, once, in order — by position: the guion's split pieces share a wid
    assert.deepEqual(out.map((w) => w.wid), kept.map((k) => k.wid), label);
    out.forEach((w, i) => assert.equal(plain(w.text), toDisplay(kept[i].word), label));

    const bounds = [];
    let pos = 0;
    for (const c of pages) {
      // a page spans its words; a word never ends before it starts (Fats403 normalize-captions)
      assert.ok(c.words.length, label);
      assert.equal(c.startMs, c.words[0].startMs, label);
      assert.equal(c.endMs, c.words.at(-1).endMs, label);
      for (const w of c.words) assert.ok(w.endMs >= w.startMs, `${label}: ${w.wid} ends before it starts`);
      bounds.push([pos, pos + c.words.length - 1]);
      pos += c.words.length;
    }
    const k = (i) => kept[i];
    const glue = (i) => isGlue(out[i].text, L.glueExcept);
    const terms = glossary.map((g) => g.term.split(/\s+/).map(normKey).filter(Boolean)).filter((t) => t.length > 1).sort((a, b) => b.length - a.length);
    const run = [];
    for (let i = 0; i < kept.length; i++) {
      const t = terms.find((t) => t.every((key, n) => k(i + n) && normKey(k(i + n).word) === key && (!n || (k(i + n).clipId === k(i).clipId && !k(i + n).cut && !endsSentence(k(i + n - 1).word, k(i + n).word)))));
      if (t) { t.forEach((_, n) => (run[i + n] = i)); i += t.length - 1; }
    }
    const inTerm = (i, j) => run[i] != null && run[i] === run[j];
    const bond = (i, j) => inTerm(i, j) || !!L.unbreakable && (((k(i).tier ?? 0) > 0 && (k(j).tier ?? 0) > 0) || (/^[A-ZÁÉÍÓÚÑ]/.test(out[i].text) && /^[A-ZÁÉÍÓÚÑ0-9]/.test(k(j).word.replace(/^[.,;:¿¡]+/, ''))));
    const sentence = (i) => endsSentence(k(i).word, k(i + 1)?.word);
    const boundary = (i) => k(i + 1).clipId !== k(i).clipId || k(i + 1).cut; // a clip change or a parenthesis
    const joinable = (a, b, gap) => !boundary(a[1]) && !sentence(a[1]) && k(b[0]).startMs - k(a[1]).endMs < gap;
    const withinCaps = (i, j) => chars(out.slice(i, j + 1)) <= (L.maxChars ?? Infinity) && k(j).endMs - k(i).startMs <= (L.maxMs ?? Infinity);
    const fits = (a, b) => b[1] - a[0] + 1 <= L.maxWords && chars(out.slice(a[0], b[1] + 1)) <= L.maxCharsLine && withinCaps(a[0], b[1]);
    const shown = (n) => Math.min(bounds[n + 1] ? k(bounds[n + 1][0]).startMs : Infinity, k(bounds[n][1]).endMs + p.holdMs) - k(bounds[n][0]).startMs;
    const figure = (i) => L.figurePages && (k(i).tier ?? 0) > 0 && /^\d/.test(out[i].text); // v11: a highlighted figure stands alone

    bounds.forEach(([a, b], n) => {
      for (let i = a; i < b; i++) {
        // never two clips (a cut inside one source included), never across a parenthesis; one sentence per page
        assert.ok(!boundary(i), `${label}: page ${n} runs across a clip or a parenthesis`);
        assert.ok(!sentence(i), `${label}: page ${n} holds two sentences ("${k(i).word}" | "${k(i + 1).word}")`);
      }
      // a hard cap (maxChars / maxMs) is passed only by one word, or by a bond that must not split
      if (!withinCaps(a, b)) assert.ok(a === b || out.slice(a, b).some((_, i) => bond(a + i, a + i + 1)), `${label}: page ${n} passes a hard cap`);
      if (b === out.length - 1) return;
      // a glossary term is never split, in any pack
      assert.ok(!inTerm(b, b + 1), `${label}: glossary term split between "${out[b].text}" | "${out[b + 1].text}"`);
      // a bond is never split, except by a sentence end, a clip or a parenthesis (or a word-at-a-time pack)
      if (L.maxWords > 1 && !sentence(b) && !boundary(b)) assert.ok(!bond(b, b + 1), `${label}: bond split between "${out[b].text}" | "${out[b + 1].text}"`);
      // a page ends on a function word only where it must: its trailing function words could not open the
      // next page (a sentence end, a clip, a parenthesis, a bond, or with the next word they pass a hard cap)
      if (L.maxWords > 1 && glue(b)) {
        let g = b;
        while (g > a && glue(g - 1)) g--;
        assert.ok(sentence(b) || boundary(b) || g === a || !withinCaps(g, b + 1) || (b > a && bond(b - 1, b)), `${label}: page ${n} ends on "${out[b].text}"`);
      }
    });

    if (L.maxWords <= 1) continue;
    bounds.forEach((pg, n) => {
      const prev = bounds[n - 1], next = bounds[n + 1];
      const len = pg[1] - pg[0] + 1;
      // no orphan a merge could have fixed
      if (L.minWords == null && len === 1 && prev && !figure(pg[0])) assert.ok(!(joinable(prev, pg, 350) && prev[1] - prev[0] + 1 <= L.maxWords && withinCaps(prev[0], pg[1])), `${label}: 1-word page ${n} could join the page before`);
      if (L.minWords > 1 && len < L.minWords) {
        const gap = L.silenceMs ?? 450;
        assert.ok(!(prev && joinable(prev, pg, gap) && fits(prev, pg)), `${label}: orphan page ${n} could join the page before`);
        assert.ok(!(next && joinable(pg, next, gap) && fits(pg, next)), `${label}: orphan page ${n} could join the page after`);
      }
      // no flash page a merge could have fixed
      if (L.minMs > 0 && shown(n) < L.minMs) {
        const gap = L.silenceMs ?? 450;
        assert.ok(!(next && joinable(pg, next, gap) && fits(pg, next)), `${label}: flash page ${n} could join the page after`);
        assert.ok(!(prev && joinable(prev, pg, gap) && fits(prev, pg)), `${label}: flash page ${n} could join the page before`);
      }
    });
  }
});

test('malformed streams still come out with sane pages (shuffled, swapped times, blank words)', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const rand = mulberry32(seed * 7919);
    const {words} = stream(rand);
    for (let i = words.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [words[i], words[j]] = [words[j], words[i]]; }
    for (const w of words) if (rand() < 0.1) w.word = '   ';
    const p = preset(rand);
    const pages = pageWords(words, p);
    const label = `seed ${seed * 7919} ${p.id}`;
    for (const c of pages) {
      assert.ok(c.words.length && c.words.every((w) => w.text.trim()), label);
      for (const w of c.words) assert.ok(w.endMs >= w.startMs, label);
      assert.ok(Number.isFinite(c.startMs) && Number.isFinite(c.endMs), label);
    }
  }
});
