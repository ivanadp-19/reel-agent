#!/usr/bin/env node
// Render judge — the deterministic half of the render-judge skill.
//   node .agents/skills/render-judge/judge.mjs <project_id> <render.mp4> [--prev report.json | --fresh] [--out dir] [--json]
//
// Everything a rule can decide is decided here, from evidence: the rendered mp4
// (ffprobe / ffmpeg: loudness, clipping, silences, black, per-frame luma/chroma,
// frame hashes), the project JSON and the aligned transcript (public/transcript.json,
// written by get_transcript). What needs eyes (hook strength, B-roll fit, look,
// spelling in context) is left to the judge agent, who gets contact sheets of the
// WHOLE reel and a list of moments to look at with frame_at.
//
// Findings: {check, severity: blocker|major|minor|nit, kind: rule|heuristic,
// at/end (timeline s), msg, evidence, fix: [{tool, args}]}. `rule` = certain;
// `heuristic` = counts toward the verdict unless the judge dismisses it with a
// frame as evidence. Verdict: PASS only with 0 blockers and 0 majors
// (checks.md has the thresholds). Nothing here edits the project.
//
// Shared rules are imported, never re-implemented: placement (src/timeline.ts),
// caption projection (src/captions.ts), validate + transcript issues
// (src/validate.ts), QC gate (scripts/qc.mjs), text widths (src/textFit.ts).
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const SKILL = import.meta.dirname;
const ROOT = path.resolve(SKILL, '..', '..', '..');
const src = (f) => path.join(ROOT, 'src', f);
const {placeClips} = await import(src('timeline.ts'));
const {normalizeCaption, projectCaptions} = await import(src('captions.ts'));
const {validateProject, transcriptIssues, SAFE} = await import(src('validate.ts'));
const {presetOf, pageScale} = await import(src('captionPresets.ts'));
const {textWidthEm} = await import(src('textFit.ts'));
const {projectBrolls} = await import(src('brollModel.ts'));
const {projectGraphics} = await import(src('graphicTemplates.ts'));
const {contentWords} = await import(src('brollMatch.ts'));
const {toDisplay} = await import(src('paging.ts'));
const {qc} = await import(path.join(ROOT, 'scripts', 'qc.mjs'));

const FPS = 30;
export const SEVERITIES = ['blocker', 'major', 'minor', 'nit'];
// thresholds (checks.md explains each; change them there too)
export const T = {
  pauseMidMs: 600, // a pause inside a sentence this long sounds like a mistake
  pauseMinorMs: 450,
  pauseAfterMs: 900, // after a full stop: breathing room, but not dead air
  pauseAfterMajorMs: 1300,
  tightMs: 40, // words glued across a cut: the breath / first consonant got eaten
  deadStartMs: 500, // first word later than this = the reel starts dead
  firstTextMs: 1000, // nothing written on screen in the first second = weak hook
  syncMajorMs: 250, syncBlockerMs: 500,
  cps: 22, // caption reading speed (characters per second)
  maxLines: 3,
  minFontPx: 40, // CaptionTrack never shrinks below this: a wider unit overflows
  flashMs: 500,
  staticSec: 7,
  voiceJumpLU: 4, // take-to-take voice level jump
  musicUnderVoiceLU: 12, musicUnderVoiceMajorLU: 8,
  expoJump: 18, wbJump: 5, burnt: 235, dark: 45, // 8-bit YUV
  hashDist: 6, // dHash bits (of 64) for "same shot"
  repeatWords: 5, // same n words said twice = a retake left in
};

// ---------- small helpers ----------
const tc = (s) => (s == null ? '—' : `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`);
const r2 = (n) => Math.round(n * 100) / 100;
const median = (xs) => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : NaN; };
const fold = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ$%]/g, '');
const clean = (s) => String(s).replace(/^[¿¡"'(]+|[.,;:!?"')]+$/g, '');
const CAP = /^[A-ZÁÉÍÓÚÑÜ]/;
const SENT_END = /[.!?…]["')\]]*$/;
const sourceOf = (s) => path.basename(s).replace(/\.[^.]+$/, '');
const ff = (args) => spawnSync('ffmpeg', ['-hide_banner', '-nostats', ...args], {encoding: 'utf8', maxBuffer: 1 << 28});

// ---------- evidence: timeline speech ----------
// transcript words of every placed clip on the timeline (seconds), in order
export function timelineSpeech(clips, tr, fps = FPS) {
  const out = [];
  const missing = [];
  for (const [k, pc] of placeClips(clips, fps).entries()) {
    const t = tr.find((x) => x.clipId === pc.clip.id);
    if (!t) { missing.push(pc.clip.id); continue; }
    const inMs = pc.clip.inSec * 1000, outMs = pc.clip.outSec * 1000, sp = pc.clip.speed ?? 1;
    const abs = (ms) => (pc.startMs + (ms - inMs) / sp) / 1000;
    for (const w of t.words) {
      if (w.endMs <= inMs || w.startMs >= outMs) continue;
      out.push({wid: `${t.source}:${w.i}`, word: w.word, t0: abs(Math.max(w.startMs, inMs)), t1: abs(Math.min(w.endMs, outMs)), srcStartMs: w.startMs, srcEndMs: w.endMs, clipId: pc.clip.id, clipIndex: k, off: !!w.off});
    }
  }
  return {words: out.sort((a, b) => a.t0 - b.t0), missing};
}

// ---------- rules (pure, exported for tests) ----------
// Cesar #1 — odd pauses in the narration: gaps between consecutive spoken words as the viewer hears them
export function pauseFindings(words, clips) {
  const out = [];
  const byId = new Map(clips.map((c) => [c.id, c]));
  for (let k = 1; k < words.length; k++) {
    const a = words[k - 1], b = words[k];
    if (a.off || b.off) continue; // off-mic is its own (blocker) check
    const gap = (b.t0 - a.t1) * 1000;
    const across = a.clipId !== b.clipId;
    const ended = SENT_END.test(a.word);
    const fix = pauseFix(a, b, byId);
    if (!ended && gap >= T.pauseMidMs) out.push(F('pause', 'major', 'rule', a.t1, b.t0, `pausa rara de ${(gap / 1000).toFixed(2)} s a mitad de frase entre "${a.word}" y "${b.word}"${across ? ' (en un corte)' : ''}`, {gapMs: Math.round(gap), from: a.wid, to: b.wid}, fix));
    else if (!ended && gap >= T.pauseMinorMs) out.push(F('pause', 'minor', 'rule', a.t1, b.t0, `pausa de ${(gap / 1000).toFixed(2)} s a mitad de frase entre "${a.word}" y "${b.word}"`, {gapMs: Math.round(gap), from: a.wid, to: b.wid}, fix));
    else if (ended && gap >= T.pauseAfterMs) out.push(F('pause', gap >= T.pauseAfterMajorMs ? 'major' : 'minor', 'rule', a.t1, b.t0, `aire muerto de ${(gap / 1000).toFixed(2)} s tras "${a.word}"`, {gapMs: Math.round(gap), from: a.wid, to: b.wid}, fix));
    if (across && gap < T.tightMs) out.push(F('cut-tight', 'minor', 'heuristic', a.t1, b.t0, `corte pegado: "${a.word}" → "${b.word}" con ${Math.max(0, Math.round(gap))} ms — respiración/consonante comida`, {gapMs: Math.round(gap)}, [{tool: 'trim_clip', args: {clip_id: b.clipId, in_sec: r2(Math.max(0, b.srcStartMs / 1000 - 0.1))}}]));
  }
  return out;
}
// seconds come from the transcript here, so the agent never computes them
function pauseFix(a, b, byId) {
  const aOut = r2(a.srcEndMs / 1000 + 0.15), bIn = r2(Math.max(0, b.srcStartMs / 1000 - 0.08));
  if (a.clipId !== b.clipId) {
    const fix = [];
    if (byId.get(a.clipId)?.outSec > aOut + 0.05) fix.push({tool: 'trim_clip', args: {clip_id: a.clipId, out_sec: aOut}});
    if (byId.get(b.clipId)?.inSec < bIn - 0.05) fix.push({tool: 'trim_clip', args: {clip_id: b.clipId, in_sec: bIn}});
    return fix.length ? fix : [{tool: 'set_audio_cut', note: 'the gap comes from a J/L-cut: shorten or clear it', args: {clip_id: b.clipId, j_sec: 0}}];
  }
  return [
    {tool: 'split_clip', note: `${a.clipId} keeps the first piece`, args: {before_wid: b.wid}},
    {tool: 'trim_clip', args: {clip_id: a.clipId, out_sec: aOut}},
    {tool: 'trim_clip', note: 'the new piece id comes back from split_clip', args: {clip_id: '<new piece>', in_sec: bIn}},
  ];
}

// Cesar #2 — compound names / highlight spans split across two caption pages
export function splitNameFindings(pages) {
  const out = [];
  for (let k = 1; k < pages.length; k++) {
    const A = pages[k - 1], B = pages[k];
    if (A.clipId !== B.clipId || B.startMs - A.endMs > 500) continue;
    const a = A.words.at(-1), b = B.words[0];
    if (!a?.wid || !b?.wid || SENT_END.test(a.text)) continue;
    const [sa, ia] = a.wid.split(':'), [sb, ib] = b.wid.split(':');
    if (sa !== sb || +ib !== +ia + 1) continue; // only two words said one after the other
    const at = clean(a.text), bt = clean(b.text);
    let why = null;
    if (CAP.test(at) && /^\d/.test(bt)) why = 'nombre + número';
    else if (CAP.test(at) && CAP.test(bt)) why = 'nombre compuesto';
    else if ((a.tier ?? 0) > 0 && (b.tier ?? 0) > 0) why = 'frase resaltada';
    if (!why) continue;
    out.push(F('split-name', 'major', 'rule', A.startMs / 1000, B.endMs / 1000, `${why} partido entre páginas: "${A.words.map((w) => w.text).join(' ')}" | "${B.words.map((w) => w.text).join(' ')}"`, {pages: [A.id, B.id], words: [a.wid, b.wid]},
      [{tool: 'edit_caption', note: `move "${b.text}" into ${A.id} (same word count per page keeps word timing; otherwise words are re-timed evenly — re-judge sync)`, args: {caption_id: A.id, text: `${A.words.map((w) => w.text).join(' ')} ${b.text}`}},
       B.words.length > 1 ? {tool: 'edit_caption', args: {caption_id: B.id, text: B.words.slice(1).map((w) => w.text).join(' ')}} : {tool: 'delete_captions', args: {caption_ids: [B.id]}}]));
  }
  return out;
}

// Cesar #3 — caption text that runs off the frame / pages too tall. Mirrors the
// unit bonding + shrink of CaptionTrack.tsx with the shared width table; an
// ESTIMATE (heuristic) — confirm the flagged pages with frame_at on the render.
export function overflowFindings(pages, style, brandFont) {
  const preset = presetOf(style);
  const family = brandFont ?? preset.font.custom?.family ?? preset.font.family;
  const upper = preset.font.case === 'upper';
  const out = [];
  pages.forEach((c) => {
    const n = c.words.length;
    if (!n) return;
    const base = Math.round(preset.font.sizePx * (c.scale ?? 1) * pageScale(preset, n));
    const avail = preset.position === 'float' && !c.pin ? 1080 * 0.68 : 1080 - 140;
    const txt = (w) => (upper ? w.text.toUpperCase() : w.text);
    const tier = (w) => preset.tiers[w.tier ?? 0]?.scale ?? 1;
    const unbreak = !!preset.layout.unbreakable;
    const paired = new Set();
    if (unbreak) for (const bond of [(a, b) => CAP.test(a) && /^\d/.test(b), (a, b) => CAP.test(a) && CAP.test(b)])
      for (let i = 0; i < n - 1; i++) if (!paired.has(i) && !paired.has(i + 1) && !c.words[i + 1].br && bond(c.words[i].text, c.words[i + 1].text)) paired.add(i);
    const units = [];
    for (let i = 0; i < n; i++) {
      const ws = paired.has(i) ? [c.words[i], c.words[++i]] : [c.words[i]];
      units.push({ws, em: ws.reduce((s, w, j) => s + textWidthEm(txt(w), family) * tier(w) + (j ? 0.3 : 0), 0), br: !!ws[0].br});
    }
    const widest = Math.max(...units.map((u) => u.em)) * base;
    const font = widest > avail ? Math.max(T.minFontPx, Math.floor((base * avail) / widest)) : base;
    const at = (c.startMs + (c.endMs - c.startMs) / 2) / 1000;
    const text = c.words.map((w) => w.text).join(' ');
    const fitScale = r2(Math.max(0.5, ((c.scale ?? 1) * avail) / widest - 0.02));
    if (Math.max(...units.map((u) => u.em)) * font > avail + 1) {
      out.push(F('overflow', 'blocker', 'heuristic', c.startMs / 1000, c.endMs / 1000, `"${text}" (${c.id}) se sale del cuadro: la palabra/unidad más ancha no cabe ni a ${T.minFontPx}px`, {page: c.id, lookAt: r2(at)}, [{tool: 'edit_caption', args: {caption_id: c.id, text: '<shorter wording>'}}]));
      return;
    }
    // greedy wrap, like flex-wrap
    const gap = (preset.font.wordGapEm ?? 0.3) * font;
    let lines = 1, x = 0, nameBreak = null;
    units.forEach((u, i) => {
      const w = u.em * font;
      if (i && (u.br || x + gap + w > avail)) {
        lines++;
        const prev = units[i - 1].ws.at(-1).text, cur = u.ws[0].text;
        if (!unbreak && CAP.test(prev) && (CAP.test(cur) || /^\d/.test(cur)) && !SENT_END.test(prev)) nameBreak ??= `${prev} / ${cur}`;
        x = w;
      } else x += (i ? gap : 0) + w;
    });
    if (lines > T.maxLines) out.push(F('overflow', 'major', 'heuristic', c.startMs / 1000, c.endMs / 1000, `"${text}" (${c.id}) ocupa ~${lines} líneas — bloque demasiado alto`, {page: c.id, lines, lookAt: r2(at)}, [{tool: 'edit_caption', args: {caption_id: c.id, scale: fitScale}}]));
    else if (font < base * 0.75) out.push(F('overflow', 'minor', 'heuristic', c.startMs / 1000, c.endMs / 1000, `"${text}" (${c.id}) se encoge a ${Math.round((font / base) * 100)}% para caber`, {page: c.id, lookAt: r2(at)}, []));
    if (nameBreak) out.push(F('split-name', 'minor', 'heuristic', c.startMs / 1000, c.endMs / 1000, `nombre que puede partirse en dos líneas: "${nameBreak}" (${c.id})`, {page: c.id, lookAt: r2(at)}, [{tool: 'edit_caption', args: {caption_id: c.id, text: '<break the page before the name>'}}]));
    const chars = text.length, dur = (c.endMs - c.startMs) / 1000;
    if (dur > 0 && chars / dur > T.cps) out.push(F('reading-speed', 'minor', 'rule', c.startMs / 1000, c.endMs / 1000, `"${text}" (${c.id}) — ${Math.round(chars / dur)} caracteres/s, ilegible (≤ ${T.cps})`, {page: c.id}, []));
  });
  return out;
}

// caption ↔ audio sync, coverage and spelling against the aligned transcript
export function captionTextFindings(pages, words, hidden = new Set()) {
  const out = [];
  const byWid = new Map(words.map((w) => [`${w.clipId}|${w.wid}`, w]));
  const covered = new Set();
  for (const c of pages) {
    const hand = c.words.filter((w) => !w.wid);
    let worst = null;
    for (const w of c.words) {
      if (!w.wid) continue;
      covered.add(w.wid);
      const s = byWid.get(`${c.clipId}|${w.wid}`);
      if (!s) continue;
      const d = w.startMs - s.t0 * 1000;
      if (Math.abs(d) >= T.syncMajorMs && (!worst || Math.abs(d) > Math.abs(worst.d))) worst = {w, s, d};
      const said = toDisplay(s.word);
      if (fold(said) === fold(w.text) && said.toLowerCase() !== w.text.toLowerCase() && /[áéíóúñü]/i.test(said) && !/[áéíóúñü]/i.test(w.text))
        out.push(F('spelling', 'major', 'rule', s.t0, s.t1, `"${w.text}" (${c.id}) sin tilde — el transcript dice "${said}"`, {page: c.id, wid: w.wid}, [{tool: 'edit_caption', args: {caption_id: c.id, text: c.words.map((x) => (x === w ? said : x.text)).join(' ')}}]));
    }
    if (worst) {
      const {w, d} = worst;
      out.push(F('sync', Math.abs(d) >= T.syncBlockerMs ? 'blocker' : 'major', 'rule', c.startMs / 1000, c.endMs / 1000, `${c.id} "${c.words.map((x) => x.text).join(' ')}": los subtítulos van hasta ${Math.round(Math.abs(d))} ms ${d > 0 ? 'tarde' : 'adelantados'} respecto a la voz (peor: "${w.text}")`, {page: c.id, wid: w.wid, deltaMs: Math.round(d)}, [{tool: 'run_ai_step', note: 'the page was timed on another transcript run: regenerate (hand-made pages are kept)', args: {step: 'captions'}}]));
    }
    for (const wid of c.covers ?? []) covered.add(wid);
    if (hand.length > 2 && c.words.length === hand.length) {
      const cov = words.filter((w) => w.clipId === c.clipId && (c.covers ?? []).includes(w.wid));
      const d = cov.length ? c.startMs - cov[0].t0 * 1000 : 0;
      out.push(F('sync', Math.abs(d) >= T.syncMajorMs ? 'major' : 'minor', 'rule', c.startMs / 1000, c.endMs / 1000, `${c.id} fue reescrita con otro número de palabras: el tiempo de cada palabra es repartido, no el del audio${cov.length ? ` (inicio ${Math.round(d)} ms vs voz)` : ''}`, {page: c.id}, [{tool: 'edit_caption', note: 'same word count as the spoken words keeps the real timing', args: {caption_id: c.id, text: '<same number of words as spoken>'}}]));
    }
  }
  // spoken words with no caption (runs of 3+)
  const inPage = (w) => pages.some((c) => c.clipId === w.clipId && w.t0 * 1000 >= c.startMs - 30 && w.t0 * 1000 < c.endMs + 30);
  let run = [];
  const flush = () => {
    if (run.length >= 3) out.push(F('coverage', 'major', 'rule', run[0].t0, run.at(-1).t1, `${run.length} palabras habladas sin subtítulo: "${run.map((w) => w.word).join(' ').slice(0, 60)}"`, {from: run[0].wid, to: run.at(-1).wid}, [{tool: 'run_ai_step', note: 'adds pages only where there are none', args: {step: 'captions'}}]));
    run = [];
  };
  for (const w of words) {
    if (w.off || hidden.has(w.wid) || covered.has(w.wid) || inPage(w)) flush(); else run.push(w);
  }
  flush();
  return out;
}

// the same word spelled two ways across captions and graphics ("Montealban" / "Montealbán")
export function consistencyFindings(items) {
  const seen = new Map();
  for (const it of items) for (const raw of String(it.text).split(/\s+/)) {
    const w = clean(raw);
    if (w.length < 3 || /^\d+$/.test(w)) continue;
    const k = fold(w);
    const m = seen.get(k) ?? new Map();
    const surf = w.toLowerCase();
    if (!m.has(surf)) m.set(surf, it);
    seen.set(k, m);
  }
  const out = [];
  for (const m of seen.values()) {
    if (m.size < 2) continue;
    const forms = [...m.entries()];
    const marks = (s) => (s.normalize('NFD').match(/[̀-ͯ]/g) ?? []).length;
    const [good] = [...forms].sort((x, y) => marks(y[0]) - marks(x[0]))[0];
    const at = Math.min(...forms.map(([, it]) => it.at));
    const fix = forms.filter(([s]) => s !== good).map(([s, it]) => {
      const text = it.text.replace(new RegExp(`(^|\\s)${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s.,;:!?])`, 'i'), (m0, pre) => pre + good);
      return /^g/.test(it.ref) ? {tool: 'edit_graphic', note: `"${s}" → "${good}" in its props`, args: {graphic_id: it.ref}} : {tool: 'edit_caption', args: {caption_id: it.ref, text}};
    });
    out.push(F('spelling', 'major', 'rule', at, null, `misma palabra escrita de ${forms.length} formas: ${forms.map(([s, it]) => `"${s}" (${it.ref} @${tc(it.at)})`).join(', ')} — la buena es "${good}"`, {forms: forms.map(([s, it]) => ({text: s, ref: it.ref}))}, fix));
  }
  return out;
}

// a line said twice (retake left in): the same n words, twice, on the timeline
export function repeatFindings(words, n = T.repeatWords) {
  const ws = words.filter((w) => !w.off && fold(w.word));
  const key = (i) => ws.slice(i, i + n).map((w) => fold(w.word)).join(' ');
  const first = new Map();
  const out = [];
  let last = -1;
  for (let i = 0; i + n <= ws.length; i++) {
    const k = key(i);
    const j = first.get(k);
    if (j == null) { first.set(k, i); continue; }
    if (i < j + n || i <= last) continue; // overlapping, or inside a run already reported
    let len = n;
    while (i + len < ws.length && j + len < i && fold(ws[j + len].word) === fold(ws[i + len].word)) len++;
    last = i + len - 1;
    out.push(F('repeat', 'major', 'heuristic', ws[j].t0, ws[i + len - 1].t1, `frase dicha dos veces (¿toma repetida?): "${ws.slice(j, j + len).map((w) => w.word).join(' ')}" @${tc(ws[j].t0)} y @${tc(ws[i].t0)}`, {first: [ws[j].wid, ws[j + len - 1].wid], second: [ws[i].wid, ws[i + len - 1].wid]},
      [{tool: 'cut_words', note: 'keep the LAST take (reel-edit step 3); only if the earlier one is on the same clip range', args: {ranges: [{from_wid: ws[j].wid, to_wid: ws[j + len - 1].wid}]}}]));
  }
  return out;
}

// Cesar #4 — the same footage twice: by source ranges (certain) and by frame hash (B-roll vs B-roll)
export function repeatedFootageFindings(clips, brolls, hashes = []) {
  const out = [];
  const placed = placeClips(clips, FPS);
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
    const a = placed[i].clip, b = placed[j].clip;
    if (a.src !== b.src) continue;
    const ov = Math.min(a.outSec, b.outSec) - Math.max(a.inSec, b.inSec);
    if (ov > 0.3) out.push(F('repeated-footage', 'blocker', 'rule', placed[j].startMs / 1000, placed[j].endMs / 1000, `el mismo tramo de ${sourceOf(a.src)} (${ov.toFixed(1)} s) sale dos veces: ${a.id} @${tc(placed[i].startMs / 1000)} y ${b.id} @${tc(placed[j].startMs / 1000)}`, {clips: [a.id, b.id]}, [{tool: 'delete_clips', args: {clip_ids: [b.id]}}]));
  }
  const cues = brolls.filter((b) => b.kind === 'video' || b.kind === 'image');
  const aSrc = new Set(clips.map((c) => sourceOf(c.src)));
  for (let i = 0; i < cues.length; i++) {
    if (aSrc.has(sourceOf(cues[i].src))) out.push(F('repeated-footage', 'major', 'rule', cues[i].startMs / 1000, cues[i].endMs / 1000, `B-roll ${cues[i].id} es el mismo archivo que el A-roll (${sourceOf(cues[i].src)})`, {broll: cues[i].id}, [{tool: 'suggest_broll', note: 'then edit_broll src / asset from the library', args: {}}]));
    for (let j = i + 1; j < cues.length; j++) if (sourceOf(cues[i].src) === sourceOf(cues[j].src))
      out.push(F('repeated-footage', 'major', 'rule', cues[j].startMs / 1000, cues[j].endMs / 1000, `el mismo B-roll (${sourceOf(cues[i].src)}) se usa dos veces: ${cues[i].id} @${tc(cues[i].startMs / 1000)} y ${cues[j].id} @${tc(cues[j].startMs / 1000)}`, {brolls: [cues[i].id, cues[j].id]}, [{tool: 'suggest_broll', note: 'pick another asset, then edit_broll src or delete_brolls', args: {}}]));
  }
  // frame hashes: B-roll spans compared with each other (the presenter always looks alike, so A-roll is compared by source above)
  const inCue = (t) => cues.find((c) => t >= c.startMs / 1000 + 0.2 && t < c.endMs / 1000 - 0.2);
  const samples = hashes.map((h) => ({...h, cue: inCue(h.t)})).filter((h) => h.cue);
  const pairs = new Map();
  for (const a of samples) for (const b of samples) {
    if (a.cue === b.cue || a.cue.id >= b.cue.id || sourceOf(a.cue.src) === sourceOf(b.cue.src)) continue;
    if (hamming(a.h, b.h) <= T.hashDist) { const k = `${a.cue.id}|${b.cue.id}`; pairs.set(k, [...(pairs.get(k) ?? []), [a.t, b.t]]); }
  }
  for (const [k, hits] of pairs) {
    if (hits.length < 2) continue; // one similar frame is chance; two is the same shot
    const [x, y] = k.split('|');
    out.push(F('repeated-footage', 'major', 'heuristic', hits[0][1], null, `B-roll ${x} y ${y} parecen el mismo plano (frames @${tc(hits[0][0])} ≈ @${tc(hits[0][1])})`, {brolls: [x, y], lookAt: [r2(hits[0][0]), r2(hits[0][1])]}, [{tool: 'edit_broll', note: 'swap one for a different asset', args: {broll_id: y}}]));
  }
  return out;
}

// 64-bit difference hash of a 9×8 grayscale frame
export function dhash(px) {
  let h = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) h = (h << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
  return h;
}
export function hamming(a, b) { let x = a ^ b, n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; }

// verdict: 0 blockers and 0 majors; 3+ minors of one check count as a major (a pattern, not a nit)
export function verdictOf(findings) {
  const live = findings.filter((f) => !f.dismissed);
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, live.filter((f) => f.severity === s).length]));
  const byCheck = {};
  for (const f of live) if (f.severity === 'minor') byCheck[f.check] = (byCheck[f.check] ?? 0) + 1;
  const patterns = Object.entries(byCheck).filter(([, n]) => n >= 3).map(([c]) => c);
  const pass = counts.blocker === 0 && counts.major === 0 && patterns.length === 0;
  return {verdict: pass ? 'PASS' : 'FAIL', counts, patterns};
}

// compare with the previous iteration's report: new / still open / fixed / regressions
export function diffWithPrev(findings, prev) {
  if (!prev?.findings) return null;
  const same = (a, b) => a.check === b.check && ((a.ref && a.ref === b.ref) || (a.at != null && b.at != null && Math.abs(a.at - b.at) < 1));
  for (const f of findings) {
    const p = prev.findings.find((x) => same(f, x));
    f.seen = p ? (p.seen ?? 1) + 1 : 1;
  }
  const fixed = prev.findings.filter((p) => !p.dismissed && !findings.some((f) => same(f, p)));
  const regressions = findings.filter((f) => f.seen === 1 && (f.severity === 'blocker' || f.severity === 'major'));
  return {fixed: fixed.map((f) => `${f.check} @${tc(f.at)}: ${f.msg}`), regressions: regressions.map((f) => f.id), stuck: findings.filter((f) => f.seen >= 3).map((f) => f.id)};
}

function F(check, severity, kind, at, end, msg, evidence = {}, fix = []) {
  const ref = evidence.page ?? evidence.broll ?? evidence.clip ?? evidence.wid ?? evidence.from ?? null;
  return {id: `${check}@${at == null ? '-' : at.toFixed(1)}`, check, severity, kind, at: at == null ? null : r2(at), end: end == null ? null : r2(end), msg, ref, evidence, fix};
}

// ---------- evidence from the mp4 ----------
function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt,sample_rate,channels:format=duration,bit_rate', '-of', 'json', file], {encoding: 'utf8'});
  return r.status === 0 ? JSON.parse(r.stdout) : null;
}
function momentary(file) {
  const out = [];
  for (const m of ff(['-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-']).stderr.matchAll(/t:\s*([\d.]+)\s+TARGET:\S+ LUFS\s+M:\s*(-?[\d.]+|-inf)/g)) out.push({t: +m[1], M: m[2] === '-inf' ? -Infinity : +m[2]});
  return out;
}
function peaks(file) {
  const s = ff(['-i', file, '-vn', '-af', 'astats=metadata=0', '-f', 'null', '-']).stderr;
  const o = s.slice(s.lastIndexOf('Overall'));
  const num = (re) => { const m = o.match(re); return m ? +m[1] : NaN; };
  return {peakDb: num(/Peak level dB:\s*(-?[\d.]+|-inf)/), peakCount: num(/Peak count:\s*([\d.]+)/), flat: num(/Flat factor:\s*([\d.]+)/)};
}
function lumaStats(file) {
  const r = ff(['-v', 'error', '-i', file, '-an', '-vf', 'fps=2,signalstats,metadata=print:file=-', '-f', 'null', '-']);
  const out = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    const f = line.match(/pts_time:([\d.]+)/);
    if (f) { cur = {t: +f[1]}; out.push(cur); continue; }
    const m = line.match(/lavfi\.signalstats\.(YAVG|YHIGH|UAVG|VAVG|SATAVG)=([\d.]+)/);
    if (m && cur) cur[m[1]] = +m[2];
  }
  return out;
}
function frameHashes(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-an', '-vf', 'fps=2,scale=9:8:flags=area,format=gray', '-f', 'rawvideo', '-'], {maxBuffer: 1 << 26});
  const buf = r.stdout ?? Buffer.alloc(0);
  const out = [];
  for (let i = 0; i + 72 <= buf.length; i += 72) out.push({t: out.length / 2 + 0.25, h: dhash(buf.subarray(i, i + 72))});
  return out;
}
// labeled frames tiled into one sheet (drawtext needs freetype: unlabeled otherwise)
function sheet(file, times, cols, out, width = 270) {
  const dir = fs.mkdtempSync(path.join(path.dirname(out), '.f-'));
  try {
    times.forEach((t, i) => {
      const f = path.join(dir, `${String(i).padStart(2, '0')}.jpg`);
      const base = ['-v', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1'];
      const lab = `scale=${width}:-2,pad=iw:ih+26:0:0:color=0xFFE500,drawtext=text='${tc(t).replace(/:/g, '\\:')}':fontcolor=black:fontsize=18:x=6:y=h-22`;
      if (spawnSync('ffmpeg', [...base, '-vf', lab, '-q:v', '4', f]).status !== 0) spawnSync('ffmpeg', [...base, '-vf', `scale=${width}:-2`, '-q:v', '4', f]);
    });
    const rows = Math.ceil(times.length / cols);
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-framerate', '1', '-i', path.join(dir, '%02d.jpg'), '-vf', `tile=${cols}x${rows}:padding=4:color=0x303030`, '-frames:v', '1', '-q:v', '4', out]);
    return r.status === 0 ? out : null;
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

// ---------- the pass ----------
export async function judge({projectId, render, publicDir = path.join(ROOT, 'public'), outDir, prev, sheets = true}) {
  const findings = [];
  const skipped = [];
  const p = JSON.parse(fs.readFileSync(path.join(publicDir, 'projects', `${projectId}.json`), 'utf8'));
  p.clips ??= []; p.captions = (p.captions ?? []).map(normalizeCaption); p.brolls ??= []; p.graphics ??= []; p.mattes ??= []; p.captionStyle ??= 'palabra';
  const file = path.isAbsolute(render) ? render : fs.existsSync(render) ? path.resolve(render) : path.join(publicDir, render.replace(/^\//, ''));
  if (!fs.existsSync(file)) throw new Error(`render not found: ${file}`);
  const draft = /-draft\.mp4$/.test(file);
  const placed = placeClips(p.clips, FPS);
  const total = (placed.at(-1)?.endMs ?? 0) / 1000;

  // transcript: the last get_transcript run must be this project's (every clip id present)
  let tr = [];
  try { tr = JSON.parse(fs.readFileSync(path.join(publicDir, 'transcript.json'), 'utf8')); } catch {}
  const {words, missing} = timelineSpeech(p.clips, tr);
  const haveTr = missing.length === 0 && p.clips.length > 0;
  if (!haveTr) findings.push(F('evidence', 'blocker', 'rule', null, null, `transcript de otro proyecto o desactualizado (faltan ${missing.length} clips): los checks de pausas, sync, cobertura y repeticiones no corrieron`, {missing: missing.slice(0, 6)}, [{tool: 'get_transcript', note: 'then run the judge again', args: {project_id: projectId}}]));

  // --- tech + QC gate (scripts/qc.mjs) ---
  const info = probe(file);
  const v = info?.streams.find((s) => s.codec_type === 'video');
  const a = info?.streams.find((s) => s.codec_type === 'audio');
  const q = qc(file, {expectSec: total, draft});
  for (const c of q.checks) {
    if (c.ok) continue;
    if (c.name === 'silence') { findings.push(F('audio-silence', 'major', 'rule', null, null, `silencio en el render: ${c.value}`, {qc: c.value}, [{tool: 'run_ai_step', args: {step: 'autocut'}}])); continue; }
    if (c.name === 'black') { for (const m of String(c.value).matchAll(/([\d.]+)–([\d.]+) s/g)) findings.push(F('black', +m[1] < 0.1 ? 'blocker' : 'major', 'heuristic', +m[1], +m[2], `negro en pantalla ${m[1]}–${m[2]} s${+m[1] < 0.1 ? ' (el primer frame / miniatura es negro)' : ''}`, {}, [{tool: 'suggest_broll', note: 'black footage must be covered', args: {}}])); continue; }
    const sev = c.blocking ? 'blocker' : draft && /loudness|true peak/.test(c.name) ? 'nit' : 'minor';
    findings.push(F(`tech-${c.name.replace(/\s+/g, '-')}`, sev, 'rule', null, null, `${c.name}: ${c.value} (want ${c.want})${sev === 'nit' ? ' — draft sin normalizar; el final lo normaliza' : ''}`, {}, c.name === 'duration' ? [{tool: 'render', args: {draft}}] : []));
  }
  const fps = v?.r_frame_rate ? v.r_frame_rate.split('/').reduce((n, d) => n / +d) : null; // "30/1"
  if (fps && Math.abs(fps - FPS) > 0.5) findings.push(F('tech-fps', 'major', 'rule', null, null, `${fps.toFixed(2)} fps (want ${FPS})`, {}, []));

  // --- audio ---
  let audio = null;
  if (a) {
    const pk = peaks(file);
    if (pk.peakDb >= -0.1 && (pk.flat > 0 || pk.peakCount > 8)) findings.push(F('clipping', 'major', 'rule', null, null, `clipping: pico ${pk.peakDb.toFixed(2)} dBFS, ${pk.peakCount} muestras en el pico`, pk, [{tool: 'set_clip', note: 'lower the hot clip (volume 0.8) or the music (set_music volume)', args: {}}]));
    const M = momentary(file).filter((m) => Number.isFinite(m.M) && m.M > -70);
    const inWord = (t) => words.some((w) => !w.off && t >= w.t0 && t <= w.t1);
    const speechM = M.filter((m) => inWord(m.t - 0.2));
    const voice = median(speechM.map((m) => m.M));
    // voice level take to take
    const perClip = placed.map((pc) => ({pc, lv: median(speechM.filter((m) => m.t - 0.2 >= pc.startMs / 1000 && m.t - 0.2 < pc.endMs / 1000).map((m) => m.M)), n: speechM.filter((m) => m.t - 0.2 >= pc.startMs / 1000 && m.t - 0.2 < pc.endMs / 1000).length}));
    for (const {pc, lv, n} of perClip) {
      if (n < 5 || !Number.isFinite(voice) || Math.abs(lv - voice) < T.voiceJumpLU) continue;
      const vol = r2(Math.min(2, Math.max(0.1, (pc.clip.volume ?? 1) * 10 ** ((voice - lv) / 20))));
      findings.push(F('voice-level', 'major', 'rule', pc.startMs / 1000, pc.endMs / 1000, `la voz en ${pc.clip.id} está ${Math.abs(lv - voice).toFixed(1)} LU ${lv > voice ? 'más fuerte' : 'más baja'} que el resto`, {clip: pc.clip.id, lufs: r2(lv), reel: r2(voice)}, [{tool: 'set_clip', args: {clip_id: pc.clip.id, volume: vol}}]));
    }
    // music vs voice: the music alone (gaps ≥ 0.8 s) ducked by duckLevel = the bed under the voice
    if (p.music?.src) {
      const gaps = [];
      for (let k = 1; k < words.length; k++) if (words[k].t0 - words[k - 1].t1 >= 0.8) gaps.push([words[k - 1].t1 + 0.4, words[k].t0]);
      if (words.length && total - words.at(-1).t1 >= 1.2) gaps.push([words.at(-1).t1 + 0.4, total - (p.music.fadeOutSec ?? 0)]);
      const bedM = M.filter((m) => gaps.some(([s, e]) => m.t - 0.4 >= s && m.t <= e));
      const bed = median(bedM.map((m) => m.M));
      if (bedM.length >= 3 && Number.isFinite(voice)) {
        const under = bed + (p.music.duck ? 20 * Math.log10(p.music.duckLevel ?? 0.25) : 0);
        const margin = voice - under;
        audio = {voiceLufs: r2(voice), musicAloneLufs: r2(bed), musicUnderVoiceLufs: r2(under), marginLU: r2(margin)};
        if (margin < T.musicUnderVoiceLU) {
          const target = r2(Math.max(0.05, (p.music.volume ?? 0.25) * 10 ** ((margin - T.musicUnderVoiceLU - 2) / 20)));
          findings.push(F('music-vs-voice', margin < T.musicUnderVoiceMajorLU ? 'major' : 'minor', 'rule', null, null, `la música queda solo ${margin.toFixed(1)} LU bajo la voz (quiero ≥ ${T.musicUnderVoiceLU})${p.music.duck ? '' : ' y no se agacha bajo la voz'}`, audio, [{tool: 'set_music', args: {file: p.music.src, volume: target, duck: true}}]));
        }
      } else skipped.push('music vs voice: no music-only stretch ≥ 0.8 s to measure the bed');
    }
    audio ??= {voiceLufs: Number.isFinite(voice) ? r2(voice) : null};
  } else findings.push(F('tech-audio', 'blocker', 'rule', null, null, 'el render no tiene audio', {}, []));

  // --- transcript-based: pauses, repeats, hook start ---
  if (haveTr) {
    findings.push(...pauseFindings(words, p.clips), ...repeatFindings(words));
    const first = words.find((w) => !w.off);
    if (first && first.t0 * 1000 > T.deadStartMs) {
      const fix = first.clipIndex === 0 ? [{tool: 'trim_clip', args: {clip_id: first.clipId, in_sec: r2(Math.max(0, first.srcStartMs / 1000 - 0.1))}}] : [{tool: 'delete_clips', note: 'clips before the first word carry no speech', args: {clip_ids: placed.slice(0, first.clipIndex).map((x) => x.clip.id)}}];
      findings.push(F('hook-dead-start', 'major', 'rule', 0, first.t0, `la primera palabra llega a los ${first.t0.toFixed(2)} s — el reel arranca muerto`, {wid: first.wid}, fix));
    }
    for (const i of transcriptIssues(p, tr)) {
      const pc = placed.find((x) => x.clip.id === i.ref);
      findings.push(F(i.code, i.code === 'off-mic' ? 'blocker' : 'major', 'rule', pc ? pc.startMs / 1000 : null, pc ? pc.endMs / 1000 : null, i.msg, {clip: i.ref}, i.code === 'off-mic' ? [{tool: 'cut_words', note: 'the ranges named in the message', args: {}}, {tool: 'set_off_mic', args: {mode: 'cut'}}] : [{tool: 'cut_words', note: 'or the trim_clip value in the message', args: {}}]));
    }
  } else skipped.push('pauses, repeats, dead start, off-mic, cut-in-word (no transcript for this project)');

  // --- captions ---
  const pages = p.captionsOff ? [] : projectCaptions(p.captions, p.clips, FPS);
  const gfx = projectGraphics(p.graphics, p.clips, FPS);
  if (p.captionsOff) skipped.push('captions (switched off with set_captions — check the brief wants that)');
  else {
    findings.push(...splitNameFindings(pages), ...overflowFindings(pages, p.captionStyle, p.brand?.fonts?.body));
    if (haveTr) findings.push(...captionTextFindings(pages, words, new Set(p.hiddenWids ?? [])));
  }
  const texts = [
    ...pages.map((c) => ({text: c.words.map((w) => w.text).join(' '), ref: c.id, at: c.startMs / 1000})),
    ...gfx.map((g) => ({text: Object.values(g.props ?? {}).flatMap((x) => (typeof x === 'string' ? [x] : Array.isArray(x) ? x.map((l) => l?.text ?? '').filter(Boolean) : [])).join(' '), ref: g.id, at: g.startMs / 1000})),
  ];
  findings.push(...consistencyFindings(texts));

  // --- hook: something written in the first second ---
  const firstText = Math.min(...pages.map((c) => c.startMs), ...gfx.filter((g) => g.template !== 'layout').map((g) => g.startMs), Infinity) / 1000;
  if (firstText * 1000 > T.firstTextMs && total > 5) findings.push(F('hook-text', 'major', 'rule', 0, Number.isFinite(firstText) ? firstText : null, `nada escrito en pantalla hasta ${Number.isFinite(firstText) ? `${firstText.toFixed(1)} s` : 'el final'} — el hook no se lee sin audio`, {}, [{tool: 'add_graphic', note: 'hook-stack / big-word at the first word (reel-edit step 5)', args: {template: 'hook-stack', at_wid: words[0]?.wid}}]));

  // --- validate (src/validate.ts) — estimated geometry: heuristic ---
  const sevOf = {matte: 'blocker', timing: 'major', 'overlap-captions': 'major', 'safe-top': 'major', 'safe-bottom': 'major', face: 'major', 'behind-hidden': 'major', 'overlap-graphic': 'major', hook: 'major', glue: 'minor', short: 'minor', long: 'minor', 'overlap-graphics': 'minor', 'tier2-density': 'minor', 'tier1-density': 'minor', 'emoji-density': 'minor'};
  const whenOf = (ref) => { const c = pages.find((x) => x.id === ref); if (c) return [c.startMs / 1000, c.endMs / 1000]; const g = gfx.find((x) => x.id === ref); return g ? [g.startMs / 1000, g.endMs / 1000] : [null, null]; };
  for (const i of validateProject(p, FPS)) {
    if (i.code === 'hook' && findings.some((f) => f.check === 'hook-text')) continue;
    const [s, e] = whenOf(i.ref);
    findings.push(F(`validate-${i.code}`, sevOf[i.code] ?? (i.level === 'error' ? 'major' : 'minor'), ['matte', 'timing', 'overlap-captions', 'glue', 'short', 'long'].includes(i.code) ? 'rule' : 'heuristic', s, e, i.msg, {page: i.ref, lookAt: s != null ? r2((s + e) / 2) : undefined}, []));
  }

  // --- cuts ---
  const jumps = [];
  placed.forEach((pc, k) => {
    const c = pc.clip, dur = (pc.endMs - pc.startMs) / 1000;
    if (dur * 1000 < T.flashMs && (c.speed ?? 1) === 1 && placed.length > 1) findings.push(F('flash-cut', 'major', 'rule', pc.startMs / 1000, pc.endMs / 1000, `${c.id} dura ${dur.toFixed(2)} s — un parpadeo`, {clip: c.id}, [{tool: 'delete_clips', args: {clip_ids: [c.id]}}]));
    const prev = placed[k - 1]?.clip;
    if (prev && prev.src === c.src && (!c.enter || c.enter === 'cut') && !c.transform?.length && Math.abs(c.inSec - prev.outSec) < 4) jumps.push(pc);
  });
  if (jumps.length) findings.push(F('jump-cut', jumps.length >= 3 ? 'major' : 'minor', 'rule', jumps[0].startMs / 1000, null, `${jumps.length} jump cut(s) del mismo plano sin punch/transición: ${jumps.slice(0, 5).map((x) => `${x.clip.id} @${tc(x.startMs / 1000)}`).join(', ')}`, {clips: jumps.map((x) => x.clip.id)}, [{tool: 'set_transitions', args: {pattern: 'punch-alternate'}}]));
  // nothing changes on screen for a long stretch
  const brolls = projectBrolls(p.brolls, p.clips, FPS);
  const changes = [0, ...placed.map((x) => x.startMs / 1000), ...brolls.flatMap((b) => [b.startMs / 1000, b.endMs / 1000]), ...gfx.map((g) => g.startMs / 1000), total].sort((x, y) => x - y);
  for (let k = 1; k < changes.length; k++) if (changes[k] - changes[k - 1] > T.staticSec) findings.push(F('static', 'minor', 'heuristic', changes[k - 1], changes[k], `${(changes[k] - changes[k - 1]).toFixed(1)} s sin cambio de plano, B-roll ni gráfico`, {lookAt: r2((changes[k - 1] + changes[k]) / 2)}, [{tool: 'set_transitions', note: 'a punch inside the take, or suggest_broll for a cue', args: {pattern: 'punch-alternate'}}]));

  // --- B-roll: repeats, length, what is said under it ---
  const hashes = frameHashes(file);
  findings.push(...repeatedFootageFindings(p.clips, brolls, hashes));
  let lib = [];
  try { lib = JSON.parse(fs.readFileSync(path.join(publicDir, 'broll-assets', 'library.json'), 'utf8')); } catch {}
  const brollEvidence = brolls.map((b) => {
    const said = words.filter((w) => w.t1 >= b.startMs / 1000 - 1.5 && w.t0 <= b.endMs / 1000 + 0.5).map((w) => w.word).join(' ');
    const asset = lib.find((e) => sourceOf(e.src ?? '') === sourceOf(b.src) || e.id === b.assetId);
    const tags = asset ? [...(asset.tags ?? []), asset.desc ?? ''].join(' ') : b.query ?? '';
    const hit = contentWords(tags).some((t) => new Set(contentWords(said)).has(t));
    const at = b.startMs / 1000, end = b.endMs / 1000;
    if (end - at < 0.8) findings.push(F('broll-length', 'minor', 'rule', at, end, `B-roll ${b.id} dura ${(end - at).toFixed(1)} s — no se alcanza a ver`, {broll: b.id}, [{tool: 'edit_broll', args: {broll_id: b.id}}]));
    if (end - at > 8) findings.push(F('broll-length', 'minor', 'rule', at, end, `B-roll ${b.id} dura ${(end - at).toFixed(1)} s — tapa al presentador demasiado`, {broll: b.id}, [{tool: 'edit_broll', args: {broll_id: b.id}}]));
    if (at < 2 && b.mode === 'fullscreen') findings.push(F('broll-hook', 'minor', 'rule', at, end, `B-roll ${b.id} a pantalla completa sobre el hook`, {broll: b.id}, [{tool: 'edit_broll', args: {broll_id: b.id}}]));
    if (tags && said && !hit) findings.push(F('broll-fit', 'minor', 'heuristic', at, end, `B-roll ${b.id} (${tags.slice(0, 50)}) no coincide con lo que se dice: "${said.slice(0, 70)}"`, {broll: b.id, lookAt: r2((at + end) / 2)}, [{tool: 'suggest_broll', args: {}}]));
    return {id: b.id, at: r2(at), end: r2(end), mode: b.mode, src: sourceOf(b.src), tags: tags.slice(0, 80), said: said.slice(0, 140)};
  });

  // --- color: per A-roll clip (B-roll spans left out), rendered frames ---
  const stats = lumaStats(file);
  const isBroll = (t) => brolls.some((b) => b.mode !== 'inset' && t >= b.startMs / 1000 && t < b.endMs / 1000);
  const clipLooks = placed.map((pc) => {
    const s = stats.filter((x) => x.t >= pc.startMs / 1000 + 0.1 && x.t < pc.endMs / 1000 - 0.1 && !isBroll(x.t));
    return {pc, n: s.length, Y: median(s.map((x) => x.YAVG)), YH: median(s.map((x) => x.YHIGH)), U: median(s.map((x) => x.UAVG)), V: median(s.map((x) => x.VAVG))};
  }).filter((x) => x.n >= 1);
  const src0 = (x) => sourceOf(x.pc.clip.src);
  // the reel's look = duration-weighted median of the A-roll clips; the clip that departs from it is the one to fix
  const wmed = (key) => {
    const xs = clipLooks.map((x) => ({v: x[key], w: x.n})).filter((x) => Number.isFinite(x.v)).sort((p1, p2) => p1.v - p2.v);
    const half = xs.reduce((n, x) => n + x.w, 0) / 2;
    let acc = 0;
    for (const x of xs) if ((acc += x.w) >= half) return x.v;
    return NaN;
  };
  const ref = {Y: wmed('Y'), U: wmed('U'), V: wmed('V')};
  const cutAt = (x) => { const k = placed.indexOf(x.pc); return [k > 0 ? r2(x.pc.startMs / 1000 - 0.3) : null, r2(x.pc.startMs / 1000 + 0.3)].filter((t) => t != null); };
  if (clipLooks.length >= 2) for (const x of clipLooks) {
    const dY = x.Y - ref.Y, dU = x.U - ref.U, dV = x.V - ref.V;
    if (Math.abs(dY) >= T.expoJump) findings.push(F('color-jump', 'major', 'heuristic', x.pc.startMs / 1000, x.pc.endMs / 1000, `${x.pc.clip.id} (${src0(x)}) ${dY > 0 ? 'más claro' : 'más oscuro'} que el resto del reel (luma ${x.Y.toFixed(0)} vs ${ref.Y.toFixed(0)}) — salta en el corte`, {clip: x.pc.clip.id, lookAt: cutAt(x)}, [{tool: 'set_grade', args: {target: src0(x), exposure: r2(Math.max(-1, Math.min(1, Math.log2(ref.Y / x.Y))))}}]));
    if (Math.abs(dU) >= T.wbJump || Math.abs(dV) >= T.wbJump) findings.push(F('color-jump', 'major', 'heuristic', x.pc.startMs / 1000, x.pc.endMs / 1000, `${x.pc.clip.id} (${src0(x)}) con otro balance de blancos (${dV > 0 ? 'más cálido' : dV < 0 ? 'más frío' : 'otro tinte'}: ΔU ${dU.toFixed(1)}, ΔV ${dV.toFixed(1)})`, {clip: x.pc.clip.id, lookAt: cutAt(x)}, [{tool: 'set_grade', args: {target: src0(x), temperature: r2(Math.max(-0.5, Math.min(0.5, -dV / 25)))}}]));
  }
  for (const x of clipLooks) {
    if (x.YH >= T.burnt) findings.push(F('color-burnt', 'major', 'heuristic', x.pc.startMs / 1000, x.pc.endMs / 1000, `${x.pc.clip.id}: altas luces quemadas (10% más claro en ${x.YH.toFixed(0)}/235) — "quemado"`, {clip: x.pc.clip.id, lookAt: r2((x.pc.startMs + x.pc.endMs) / 2000)}, [{tool: 'set_grade', args: {target: src0(x), highlights: 0.8, exposure: -0.3}}]));
    if (x.Y <= T.dark) findings.push(F('color-dark', 'minor', 'heuristic', x.pc.startMs / 1000, x.pc.endMs / 1000, `${x.pc.clip.id}: subexpuesto (luma media ${x.Y.toFixed(0)})`, {clip: x.pc.clip.id, lookAt: r2((x.pc.startMs + x.pc.endMs) / 2000)}, [{tool: 'set_grade', args: {target: src0(x), auto: true}}]));
  }

  // --- evidence for the judge's eyes ---
  const evidence = {sheets: {}, lookAt: []};
  if (sheets && outDir) {
    try {
      fs.mkdirSync(outDir, {recursive: true});
      const dur = +info?.format?.duration || total;
      evidence.sheets.overview = sheet(file, Array.from({length: 16}, (_, k) => r2(((k + 0.5) * dur) / 16)), 4, path.join(outDir, 'overview.jpg'));
      evidence.sheets.hook = sheet(file, Array.from({length: 9}, (_, k) => r2(Math.min(dur - 0.05, k * 0.25))), 3, path.join(outDir, 'hook.jpg'));
      const cutTimes = placed.slice(1).map((x) => r2(x.startMs / 1000 + 0.1)).slice(0, 16);
      if (cutTimes.length) evidence.sheets.cuts = sheet(file, cutTimes, 4, path.join(outDir, 'cuts.jpg'));
    } catch (e) { skipped.push(`contact sheets (${String(e.message ?? e).slice(0, 80)}) — use frame_at video=<render> at the times below`); }
  }
  evidence.lookAt = [...new Set(findings.flatMap((f) => [].concat(f.evidence?.lookAt ?? (f.at != null ? r2(f.at + 0.1) : []))))].sort((x, y) => x - y).slice(0, 24);
  evidence.captions = pages.map((c) => `${c.id} @${tc(c.startMs / 1000)} "${c.words.map((w) => (w.tier === 2 ? `**${w.text}**` : w.tier ? `*${w.text}*` : w.text)).join(' ')}"`);
  evidence.broll = brollEvidence;
  evidence.graphics = gfx.map((g) => `${g.id} @${tc(g.startMs / 1000)}–${tc(g.endMs / 1000)} ${g.template} ${JSON.stringify(g.props).slice(0, 100)}`);
  evidence.audio = audio;
  evidence.tech = {size: v ? `${v.width}x${v.height}` : null, fps, vcodec: v?.codec_name, pix_fmt: v?.pix_fmt, acodec: a?.codec_name, sampleRate: a?.sample_rate, channels: a?.channels, durationSec: r2(+info?.format?.duration), expectedSec: r2(total)};

  const order = (f) => SEVERITIES.indexOf(f.severity) * 1e6 + (f.at ?? -1);
  const uniq = [...new Map(findings.map((f) => [`${f.id}|${f.msg}`, f])).values()];
  findings.length = 0; findings.push(...uniq);
  findings.sort((x, y) => order(x) - order(y));
  const diff = diffWithPrev(findings, prev);
  return {project: projectId, render: file, draft, iteration: (prev?.iteration ?? 0) + 1, at: new Date().toISOString(), durationSec: r2(total), ...verdictOf(findings), findings, diff, skipped, evidence, plan: p.plan ?? null};
}

// ---------- report ----------
export function reportText(r) {
  const L = [];
  L.push(`RULE VERDICT: ${r.verdict}  (iteration ${r.iteration}, ${r.draft ? 'draft' : 'final'}, ${r.durationSec} s) — blockers ${r.counts.blocker}, majors ${r.counts.major}, minors ${r.counts.minor}, nits ${r.counts.nit}${r.patterns.length ? `; minor patterns counted as major: ${r.patterns.join(', ')}` : ''}`);
  L.push(`render: ${r.render}`);
  if (r.diff) L.push(`vs previous: fixed ${r.diff.fixed.length}, regressions ${r.diff.regressions.length ? r.diff.regressions.join(', ') : 'none'}, stuck (3+ iterations) ${r.diff.stuck.length ? r.diff.stuck.join(', ') : 'none'}`);
  L.push('');
  for (const f of r.findings) {
    L.push(`[${f.severity.toUpperCase()}] ${f.kind === 'heuristic' ? '(heuristic) ' : ''}${f.check} @${tc(f.at)}${f.end != null ? `–${tc(f.end)}` : ''}${f.seen > 1 ? ` (seen ${f.seen}×)` : ''} — ${f.msg}`);
    for (const x of f.fix) L.push(`    fix: ${x.tool} ${JSON.stringify(x.args)}${x.note ? `  // ${x.note}` : ''}`);
  }
  if (!r.findings.length) L.push('no rule findings');
  if (r.skipped.length) L.push('', 'SKIPPED (no evidence — the judge may not PASS what was not checked):', ...r.skipped.map((s) => `  - ${s}`));
  L.push('', 'EVIDENCE FOR THE JUDGE');
  for (const [k, f] of Object.entries(r.evidence.sheets)) if (f) L.push(`  sheet ${k}: ${f}`);
  L.push(`  look at (frame_at video=<render>): ${r.evidence.lookAt.map((t) => `${t}s`).join(', ') || '—'}`);
  L.push(`  tech: ${JSON.stringify(r.evidence.tech)}`, `  audio: ${JSON.stringify(r.evidence.audio)}`);
  L.push('  captions (proofread every one):', ...r.evidence.captions.map((c) => `    ${c}`));
  if (r.evidence.graphics.length) L.push('  graphics:', ...r.evidence.graphics.map((g) => `    ${g}`));
  if (r.evidence.broll.length) L.push('  B-roll (what is said under each cue):', ...r.evidence.broll.map((b) => `    ${b.id} @${tc(b.at)}–${tc(b.end)} ${b.mode} ${b.src} [${b.tags}] ← "${b.said}"`));
  return L.join('\n');
}

// ---------- CLI ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const bool = (n) => { const i = args.indexOf(n); if (i >= 0) args.splice(i, 1); return i >= 0; };
  const prevPath = flag('--prev'), outArg = flag('--out'), publicDir = flag('--public');
  const asJson = bool('--json'), fresh = bool('--fresh');
  const [projectId, render] = args;
  if (!projectId || !render) { console.error('usage: judge.mjs <project_id> <render.mp4> [--prev report.json | --fresh] [--out dir] [--json]'); process.exit(2); }
  if (!/^[\w-]+$/.test(projectId)) { console.error(`bad project id: ${projectId}`); process.exit(2); }
  const base = path.join(ROOT, '.captions-tmp', 'judge', projectId);
  const latest = path.join(base, 'latest.json');
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(prevPath ?? latest, 'utf8')); } catch {}
  if (fresh || (!prevPath && prev && Date.now() - Date.parse(prev.at) > 12 * 3600e3)) prev = null; // a new loop, not the next iteration
  const outDir = outArg ?? path.join(base, `${path.basename(render, '.mp4')}-${Date.now()}`);
  const r = await judge({projectId, render, publicDir: publicDir ?? undefined, outDir, prev});
  const txt = reportText(r);
  try {
    fs.mkdirSync(outDir, {recursive: true}); fs.mkdirSync(base, {recursive: true});
    const json = JSON.stringify(r, (k, x) => (typeof x === 'bigint' ? x.toString(16) : x), 2);
    fs.writeFileSync(path.join(outDir, 'report.json'), json);
    fs.writeFileSync(path.join(outDir, 'report.md'), txt);
    fs.writeFileSync(latest, json);
  } catch (e) { console.error(`(report not saved: ${e.message}; read-only sandbox?)`); }
  console.log(asJson ? JSON.stringify(r, (k, x) => (typeof x === 'bigint' ? x.toString(16) : x), 2) : `${txt}\n\nreport: ${path.join(outDir, 'report.json')}`);
  process.exit(0);
}
