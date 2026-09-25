#!/usr/bin/env node
// Render judge — the deterministic half of the render-judge skill.
//   node .agents/skills/render-judge/judge.mjs <project_id> <render.mp4> [--role master|captioned|extra]
//        [--pair <other.mp4>] [--profile <client>] [--prev report.json | --fresh] [--out dir] [--json] [--no-source-scan]
//   Niced (REEL_JUDGE_NICE, default 15) with one decoder thread for the source scans (REEL_JUDGE_THREADS).
//
// Everything a rule can decide is decided here, from evidence: the rendered mp4
// (ffprobe / ffmpeg: loudness, clipping, silences, black, per-frame luma/chroma,
// frame hashes), the project JSON and the aligned transcript (public/transcript.json,
// written by get_transcript). What needs eyes (hook strength, B-roll fit, look,
// spelling in context) is left to the judge agent, who gets contact sheets of the
// WHOLE reel and a list of moments to look at with frame_at.
//
// Findings: {check, severity: blocker|major|minor|nit, kind: rule|heuristic|candidate,
// at/end (timeline s), msg, evidence, fix: [{tool, args}]}. `rule` = certain;
// `heuristic` = counts toward the verdict unless the judge dismisses it with a
// frame as evidence; `candidate` = known to be noisy (a long take, a bright sky,
// a dramatic pause, a capitalized "name"): it does NOT count until the judge
// confirms it on the real frame. Verdict: PASS only with 0 blockers and 0 majors
// (checks.md has the thresholds). PASS is labeled "QC técnico superado" —
// never "aprobado": only the client approves. Nothing here edits the project.
//
// Generic judge + client profiles: profiles/<client>.json turns on and tunes the
// client's own checks (glossary, sentence paging, accent size, color references,
// crew words, script inserts, known reels); profiles/<client>.md holds the rules
// for the judge's eyes. Chosen by --profile, the kit's style.judgeProfile, or the
// profile's `match` (caption style / brand name).
//
// Shared rules are imported, never re-implemented: placement (src/timeline.ts),
// caption projection (src/captions.ts), validate + transcript issues
// (src/validate.ts), QC gate (scripts/qc.mjs), text widths (src/textFit.ts).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';

const SKILL = import.meta.dirname;
const ROOT = path.resolve(SKILL, '..', '..', '..');
const src = (f) => path.join(ROOT, 'src', f);
const {placeClips} = await import(src('timeline.ts'));
const {normalizeCaption, projectCaptions} = await import(src('captions.ts'));
const {validateProject, transcriptIssues, SAFE} = await import(src('validate.ts'));
const {presetOf} = await import(src('captionPresets.ts'));
const {captionPreset, fitPage, wrapUnits, MIN_FONT_PX} = await import(src('captionLayout.ts'));
const {projectBrolls} = await import(src('brollModel.ts'));
const {projectGraphics} = await import(src('graphicTemplates.ts'));
const {contentWords} = await import(src('brollMatch.ts'));
const {toDisplay, endsSentence} = await import(src('paging.ts'));
const {qc} = await import(path.join(ROOT, 'scripts', 'qc.mjs'));

const FPS = 30;
export const SEVERITIES = ['blocker', 'major', 'minor', 'nit'];
// thresholds (checks.md explains each; change them there too)
export const T = {
  pauseMidMs: 600, // a pause inside a sentence this long sounds like a mistake (unless it is dramatic: candidate)
  pauseMinorMs: 450,
  pauseAfterMs: 900, // after a full stop: a breath or a dramatic beat — candidate only
  deadAirMs: 2000, // after a full stop, this long is dead air whatever the intent
  tightMs: 40, // words glued across a cut: the breath / first consonant got eaten
  deadStartMs: 500, // first word later than this = the reel starts dead
  firstTextMs: 1000, // nothing written on screen in the first second = weak hook
  syncMajorMs: 250, syncBlockerMs: 500,
  cps: 22, // caption reading speed (characters per second)
  maxLines: 3,
  flashMs: 500,
  staticSec: 7,
  voiceJumpLU: 4, // take-to-take voice level jump
  musicUnderVoiceLU: 12, musicUnderVoiceMajorLU: 8,
  expoJump: 18, wbJump: 5, burnt: 235, dark: 45, // 8-bit YUV
  hashDist: 6, // dHash bits (of 64) for "same shot"
  repeatWords: 5, // same n words said twice = a retake left in
  refY: 20, refSat: 12, refContrast: 25, refWB: 6, // render vs the client's approved color references
  phoneDb: 8, // band-limited speech: ≥ this many dB more loss under 300 Hz (and half of it over 3.4 kHz) than the reel's full-band sentences
  parityCutSec: 0.07, parityLU: 1.5, // clean master vs captioned version
  blackLongSec: 0.5, // black runs from this long on are the QC gate's `black` stretches; shorter ones are flashes
  frame0Flat: 2, frame0Dark: 30, // frame 0 black: luma flat (YMAX − YMIN < 2) and dark (YAVG < 30), 8-bit
  srcCutScore: 10, // scdet score (0–100) of one frame: a hard cut inside a source clip
  whipScore: 1.5, whipRatio: 20, whipFrames: 3, whipMaxSec: 1.5, // a whip / snap pan: 3+ frames far above the clip's own median, but short (a long move is a camera move)
  srcEdgeSec: 0.15, // the first / last frames of a used range are the edit's own cut
};
const DEFAULT_T = {...T};
// a black frame: ≥ 98 % of its pixels under 10 % luma (the catalog's definition, scripts/catalog.mjs)
export const BLACK = {pix: 0.10, pic: 0.98};

// ---------- client profiles ----------
const PROFILES = path.join(SKILL, 'profiles');
export function listProfiles() {
  try { return fs.readdirSync(PROFILES).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(PROFILES, f), 'utf8'))); } catch { return []; }
}
// explicit name > the brand kit's style.judgeProfile > a profile whose `match` names the caption style or the brand
export function pickProfile(p, name, all = listProfiles()) {
  const want = name ?? p.brand?.style?.judgeProfile;
  if (want) { const hit = all.find((x) => x.id === want); if (!hit) throw new Error(`no judge profile "${want}" (have: ${all.map((x) => x.id).join(', ') || 'none'})`); return hit; }
  const brand = fold(p.brand?.name ?? '');
  return all.find((x) => (x.match?.captionStyle ?? []).includes(p.captionStyle) || (brand && (x.match?.brand ?? []).some((b) => brand.includes(fold(b))))) ?? null;
}
// the known reel of a profile this project is (by project name), e.g. César's G1 / G7
export const reelOf = (profile, name = '') => Object.entries(profile?.reels ?? {}).find(([k, r]) => new RegExp(r.name ?? `\\b${k}\\b`, 'i').test(name))?.[1] ?? null;

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
// transcript words of every placed clip at the time the viewer HEARS them (seconds), in order.
// Audio follows MultiClipVideo: a J-cut plays the clip's first j seconds of source under the
// previous clip's tail (and mutes them after the cut), an L-cut plays the source past outSec
// under the next clip's head; the frames come from placeClips, like the render's. A muted clip
// is not heard at all. Words in a lead / trail carry `jl` ('lead' | 'trail').
export function timelineSpeech(clips, tr, fps = FPS) {
  const out = [];
  const missing = [];
  for (const [k, pc] of placeClips(clips, fps).entries()) {
    const t = tr.find((x) => x.clipId === pc.clip.id);
    if (!t) { missing.push(pc.clip.id); continue; }
    if (pc.clip.muted || pc.clip.volume === 0) continue;
    const sp = pc.clip.speed ?? 1;
    const inMs = pc.clip.inSec * 1000, outMs = pc.clip.outSec * 1000;
    const jMs = (pc.jFrames / fps) * 1000, lMs = (pc.lFrames / fps) * 1000; // timeline ms
    const leadEnd = inMs + jMs * sp, trailEnd = outMs + lMs * sp; // source ms
    const part = (ms) => (ms < leadEnd ? 'lead' : ms < outMs ? 'main' : 'trail');
    const heard = (ms) => {
      const w = part(ms);
      return (w === 'lead' ? pc.startMs - jMs + (ms - inMs) / sp : w === 'main' ? pc.startMs + (ms - inMs) / sp : pc.endMs + (ms - outMs) / sp) / 1000;
    };
    for (const w of t.words) {
      if (w.endMs <= inMs || w.startMs >= trailEnd) continue;
      const s0 = Math.max(w.startMs, inMs), s1 = Math.min(w.endMs, trailEnd);
      const where = part(s0);
      out.push({wid: `${t.source}:${w.i}`, word: w.word, t0: heard(s0), t1: Math.max(heard(s0), heard(Math.max(s0, s1 - 1))), srcStartMs: w.startMs, srcEndMs: w.endMs, clipId: pc.clip.id, clipIndex: k, off: !!w.off, ...(where !== 'main' ? {jl: where} : {}), ...(w.speaker ? {speaker: w.speaker} : {})});
    }
  }
  return {words: out.sort((a, b) => a.t0 - b.t0), missing};
}

// ---------- rules (pure, exported for tests) ----------
// odd pauses in the narration: gaps between consecutive spoken words as the viewer hears them.
// A pause that reads as dramatic — after a full stop, after "…" / "," / ":", or right before an
// emphasized word — is a candidate (the judge listens with the frame, it never auto-fails);
// a long gap mid-sentence is a rule, and so is dead air past T.deadAirMs.
const DRAMATIC_BEFORE = /[,;:…—–-]["')\]]*$/;
export function pauseFindings(words, clips, emphasized = new Set()) {
  const out = [];
  const byId = new Map(clips.map((c) => [c.id, c]));
  const jSec = new Map(placeClips(clips, FPS).map((pc) => [pc.clip.id, pc.jFrames / FPS]));
  for (let k = 1; k < words.length; k++) {
    const a = words[k - 1], b = words[k];
    if (a.off || b.off) continue; // off-mic / crew talk is its own check
    // the renderer plays a J-cut's lead before the cut and then MUTES the clip's first j seconds
    // (MultiClipVideo + ClipMedia): speech that runs through the lead has a j-second hole after
    // the cut. Verified on a real render (1 s J-cut → 1 s of silence). A product bug, named here.
    if (a.clipId === b.clipId && a.jl === 'lead' && !b.jl && b.t0 - a.t1 > 0.25) {
      out.push(F('jcut-gap', 'major', 'rule', a.t1, b.t0, `el J-cut de ${a.clipId} deja ${(b.t0 - a.t1).toFixed(2)} s de silencio tras el corte, entre "${a.word}" y "${b.word}": el render silencia los primeros ${jSec.get(a.clipId).toFixed(1)} s del clip y no los retoma`, {clip: a.clipId, from: a.wid, to: b.wid},
        [{tool: 'set_audio_cut', note: 'clear the J-cut until the renderer plays the lead through the cut', args: {clip_id: a.clipId, j_sec: 0}}, {tool: 'escalate', note: 'renderer: MultiClipVideo J-cut lead + ClipMedia jMuteFrames leave a hole', args: {}}]));
      continue;
    }
    const gap = (b.t0 - a.t1) * 1000;
    const across = a.clipId !== b.clipId;
    const ended = SENT_END.test(a.word);
    const dramatic = ended || DRAMATIC_BEFORE.test(a.word) || emphasized.has(b.wid);
    const fix = pauseFix(a, b, byId);
    const ev = {gapMs: Math.round(gap), from: a.wid, to: b.wid};
    const s1 = (gap / 1000).toFixed(2);
    if (gap >= T.deadAirMs) out.push(F('pause', 'major', 'rule', a.t1, b.t0, `aire muerto de ${s1} s entre "${a.word}" y "${b.word}"${across ? ' (en un corte)' : ''}`, ev, fix));
    else if (!dramatic && gap >= T.pauseMidMs) out.push(F('pause', 'major', 'rule', a.t1, b.t0, `pausa rara de ${s1} s a mitad de frase entre "${a.word}" y "${b.word}"${across ? ' (en un corte)' : ''}`, ev, fix));
    else if (dramatic && gap >= (ended ? T.pauseAfterMs : T.pauseMidMs)) out.push(F('pause', 'minor', 'candidate', a.t1, b.t0, `pausa de ${s1} s entre "${a.word}" y "${b.word}" — ¿dramática? ${ended ? '(tras punto)' : emphasized.has(b.wid) ? '(antes de la palabra resaltada)' : '(tras coma / puntos suspensivos)'}; cuenta solo si suena a error`, ev, fix));
    else if (!ended && gap >= T.pauseMinorMs) out.push(F('pause', 'minor', 'candidate', a.t1, b.t0, `pausa de ${s1} s a mitad de frase entre "${a.word}" y "${b.word}"`, ev, fix));
    if (across && !a.jl && !b.jl && gap < T.tightMs) out.push(F('cut-tight', 'minor', 'heuristic', a.t1, b.t0, `corte pegado: "${a.word}" → "${b.word}" con ${Math.max(0, Math.round(gap))} ms — respiración/consonante comida`, {gapMs: Math.round(gap)}, [{tool: 'trim_clip', args: {clip_id: b.clipId, in_sec: r2(Math.max(0, b.srcStartMs / 1000 - 0.1))}}]));
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

// compound names / highlight spans split across two caption pages. Two words said one
// after the other and cut apart by a page boundary: a glossary term (or a highlight span)
// is a rule; a capitalized pair is only a candidate — capitals are a poor signal for
// compounds (sentence starts, "pet park" in lowercase), so the judge confirms on the frame.
const phraseKey = (s) => String(s).split(/\s+/).map(fold).filter(Boolean).join(' ');
// rawOf(word) → the transcript word with its punctuation (a caption's text has lost its periods)
const rawText = (w) => w.text;
const CONNECTORS = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y']);
export function splitNameFindings(pages, glossary = [], style, rawOf = rawText) {
  const out = [];
  const preset = presetOf(style);
  const terms = glossary.flatMap((g) => [g.term, ...(g.variants ?? [])]).map((t) => String(t).split(/\s+/).map(fold).filter(Boolean)).filter((t) => t.length > 1);
  const consecutive = (ws) => ws.every((w, i) => i === 0 || (w.wid && ws[i - 1].wid && w.wid.split(':')[0] === ws[i - 1].wid.split(':')[0] && +w.wid.split(':')[1] === +ws[i - 1].wid.split(':')[1] + 1));
  for (let k = 1; k < pages.length; k++) {
    const A = pages[k - 1], B = pages[k];
    if (A.clipId !== B.clipId || B.startMs - A.endMs > 500) continue;
    const a = A.words.at(-1), b = B.words[0];
    if (!a?.wid || !b?.wid || !consecutive([a, b]) || endsSentence(rawOf(a), rawOf(b))) continue;
    const at = clean(a.text), bt = clean(b.text);
    let why = null, kind = 'rule', span = [a, b];
    // a glossary term that runs across the page change, whatever its length
    for (const t of terms) for (let cut = 1; cut < t.length && !why; cut++) {
      const left = A.words.slice(-cut), right = B.words.slice(0, t.length - cut);
      if (left.length !== cut || right.length !== t.length - cut) continue;
      const ws = [...left, ...right];
      if (consecutive(ws) && ws.every((w, i) => fold(w.text) === t[i])) { why = `término del glosario "${ws.map((w) => clean(w.text)).join(' ')}" partido`; span = ws; }
    }
    if (why) { /* glossary term found above */ } else if ((a.tier ?? 0) > 0 && (b.tier ?? 0) > 0) why = 'frase resaltada partida';
    else if (CAP.test(at) && /^\d/.test(bt)) { why = 'nombre + número partido'; kind = 'candidate'; }
    else if (CAP.test(at) && CAP.test(bt)) { why = 'posible nombre compuesto partido'; kind = 'candidate'; }
    else if (CONNECTORS.has(fold(at)) && CAP.test(bt) && A.words.length > 1 && CAP.test(clean(A.words.at(-2).text)) && consecutive([A.words.at(-2), a, b])) { why = 'posible nombre compuesto partido'; kind = 'candidate'; span = [A.words.at(-2), a, b]; } // "Playa del | Carmen"
    else if (CAP.test(at) && CONNECTORS.has(fold(bt)) && B.words.length > 1 && CAP.test(clean(B.words[1].text)) && consecutive([a, b, B.words[1]])) { why = 'posible nombre compuesto partido'; kind = 'candidate'; span = [a, b, B.words[1]]; } // "Playa | del Carmen"
    if (!why) continue;
    // Never delete_captions / add_caption to reshape pages: a deleted page hides its words for
    // good and a typed page loses word ids, accents and real timing. In an unbreakable pack a
    // highlighted span is one unit for the pager, and re-paging hands the pager the project's
    // tiers (projectTiers → captions job) BEFORE it pages: highlight the whole name, re-page.
    const fix = preset.layout.unbreakable
      ? [{tool: 'annotate_captions', note: 'the whole name as one highlighted span (names are key words anyway)', args: {items: span.map((w) => ({wid: w.wid, tier: Math.max(1, w.tier ?? 0)}))}},
         {tool: 'set_caption_style', note: 're-pages with the shared pager, which now sees those tiers; keeps word ids, emoji, real timing and hand-made pages', args: {style: preset.id}}]
      : [{tool: 'escalate', note: `pack "${preset.id}" does not bond names across pages and no tool moves a word between pages without re-timing; last resort: edit_caption both pages (re-times them evenly, drops their word ids — re-judge sync)`, args: {}}];
    out.push(F('split-name', 'major', kind, A.startMs / 1000, B.endMs / 1000, `${why} entre páginas: "${A.words.map((w) => w.text).join(' ')}" | "${B.words.map((w) => w.text).join(' ')}"${kind === 'candidate' ? ' — confirmar en el frame del cambio de página' : ''}`, {pages: [A.id, B.id], words: span.map((w) => w.wid), lookAt: [r2(A.endMs / 1000 - 0.1), r2(B.startMs / 1000 + 0.1)]}, fix));
  }
  return out;
}

// caption text that runs off the frame / pages too tall (a failure César reported). The page
// layout is src/captionLayout.ts — the SAME function CaptionTrack renders with (bonded pairs,
// widths as rendered, the shrink to fit, the wrap) — so this only adds the verdict. Widths
// are still a table estimate (heuristic): confirm flagged pages with frame_at on the render.
export function overflowFindings(pages, style, brandFont) {
  const preset = captionPreset(style, brandFont);
  const gapEm = preset.font.wordGapEm ?? 0.26;
  const out = [];
  pages.forEach((c) => {
    if (!c.words.length) return;
    const fit = fitPage(c, preset, {float: preset.position === 'float' && !c.pin});
    const at = (c.startMs + (c.endMs - c.startMs) / 2) / 1000;
    const text = c.words.map((w) => w.text).join(' ');
    const widestEm = Math.max(...fit.units.map((u) => u.em));
    const fitScale = r2(Math.max(0.5, ((c.scale ?? 1) * fit.wrapPx) / (widestEm * fit.baseSize) - 0.02));
    if (fit.overflows) {
      const blocker = fit.widestPx > fit.availPx + 1; // wider than the frame even at the floor size
      out.push(F('overflow', blocker ? 'blocker' : 'major', 'heuristic', c.startMs / 1000, c.endMs / 1000, blocker ? `"${text}" (${c.id}) se sale del cuadro: la palabra/unidad más ancha no cabe ni a ${MIN_FONT_PX}px` : `"${text}" (${c.id}) — una palabra/unidad es más ancha que la caja flotante`, {page: c.id, lookAt: r2(at)}, blocker ? [{tool: 'edit_caption', args: {caption_id: c.id, text: '<shorter wording>'}}] : [{tool: 'edit_caption', args: {caption_id: c.id, scale: fitScale}}]));
      return;
    }
    const starts = wrapUnits(fit.units, fit.fontSize, fit.wrapPx, gapEm);
    if (starts.length > T.maxLines) out.push(F('overflow', 'major', 'heuristic', c.startMs / 1000, c.endMs / 1000, `"${text}" (${c.id}) ocupa ~${starts.length} líneas — bloque demasiado alto`, {page: c.id, lines: starts.length, lookAt: r2(at)}, [{tool: 'edit_caption', args: {caption_id: c.id, scale: r2(Math.max(0.5, (c.scale ?? 1) * 0.85))}}]));
    else if (fit.fontSize < fit.baseSize * 0.75) out.push(F('overflow', 'minor', 'heuristic', c.startMs / 1000, c.endMs / 1000, `"${text}" (${c.id}) se encoge a ${Math.round((fit.fontSize / fit.baseSize) * 100)}% para caber`, {page: c.id, lookAt: r2(at)}, []));
    // a capitalized pair the wrap breaks across lines (packs without bonding)
    for (const k of starts.slice(1)) {
      const prev = c.words[fit.units[k - 1].to].text, cur = c.words[fit.units[k].from].text;
      if (!fit.paired.size && CAP.test(prev) && (CAP.test(cur) || /^\d/.test(cur)) && !SENT_END.test(prev)) {
        out.push(F('split-name', 'minor', 'candidate', c.startMs / 1000, c.endMs / 1000, `nombre que puede partirse en dos líneas: "${prev} / ${cur}" (${c.id})`, {page: c.id, lookAt: r2(at)}, [{tool: 'edit_caption', args: {caption_id: c.id, text: '<break the page before the name>'}}]));
        break;
      }
    }
    const dur = (c.endMs - c.startMs) / 1000;
    if (dur > 0 && text.length / dur > T.cps) out.push(F('reading-speed', 'minor', 'rule', c.startMs / 1000, c.endMs / 1000, `"${text}" (${c.id}) — ${Math.round(text.length / dur)} caracteres/s, ilegible (≤ ${T.cps})`, {page: c.id}, []));
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
      // a diacritic pair (esta/está) is grammar the ASR also gets wrong: the judge reads it in context
      if (fold(said) === fold(w.text) && said.toLowerCase() !== w.text.toLowerCase() && /[áéíóúñü]/i.test(said) && !/[áéíóúñü]/i.test(w.text))
        out.push(F('spelling', DIACRITIC.has(fold(said)) ? 'minor' : 'major', DIACRITIC.has(fold(said)) ? 'candidate' : 'rule', s.t0, s.t1, `"${w.text}" (${c.id}) sin tilde — el transcript dice "${said}"`, {page: c.id, wid: w.wid}, [{tool: 'edit_caption', args: {caption_id: c.id, text: c.words.map((x) => (x === w ? said : x.text)).join(' ')}}]));
    }
    if (worst) {
      const {w, s: sw, d} = worst;
      // captions follow the picture; a J/L-cut moves the voice: regenerating would not help
      const jl = sw.jl ? ` — la voz va ${sw.jl === 'lead' ? 'adelantada por el J-cut' : 'extendida por el L-cut'} de ${sw.clipId}; los subtítulos siguen al video` : '';
      out.push(F('sync', Math.abs(d) >= T.syncBlockerMs ? 'blocker' : 'major', 'rule', c.startMs / 1000, c.endMs / 1000, `${c.id} "${c.words.map((x) => x.text).join(' ')}": los subtítulos van hasta ${Math.round(Math.abs(d))} ms ${d > 0 ? 'tarde' : 'adelantados'} respecto a la voz (peor: "${w.text}")${jl}`, {page: c.id, wid: w.wid, deltaMs: Math.round(d)},
        sw.jl ? [{tool: 'set_audio_cut', note: 'shorten or clear the J/L-cut over speech', args: {clip_id: sw.clipId, [sw.jl === 'lead' ? 'j_sec' : 'l_sec']: 0}}] : [{tool: 'run_ai_step', note: 'the page was timed on another transcript run: regenerate (hand-made pages are kept)', args: {step: 'captions'}}]));
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
    const jl = run.find((w) => w.jl);
    if (run.length >= 3) out.push(F('coverage', 'major', 'rule', run[0].t0, run.at(-1).t1, `${run.length} palabras habladas sin subtítulo: "${run.map((w) => w.word).join(' ').slice(0, 60)}"${jl ? ` (voz del ${jl.jl === 'trail' ? 'L' : 'J'}-cut de ${jl.clipId}: los subtítulos solo cubren el tramo con imagen)` : ''}`, {from: run[0].wid, to: run.at(-1).wid},
      jl ? [{tool: 'set_audio_cut', args: {clip_id: jl.clipId, [jl.jl === 'trail' ? 'l_sec' : 'j_sec']: 0}}] : [{tool: 'run_ai_step', note: 'adds pages only where there are none', args: {step: 'captions'}}]));
    run = [];
  };
  for (const w of words) {
    if (w.off || hidden.has(w.wid) || covered.has(w.wid) || inPage(w)) flush(); else run.push(w);
  }
  flush();
  return out;
}

// Spanish words told apart only by the diacritic accent: two different words, never a misspelling
// of each other ("esta casa" / "está aquí"), so accent checks never compare them
export const DIACRITIC = new Set(['esta', 'este', 'eso', 'que', 'como', 'cuando', 'donde', 'adonde', 'quien', 'quienes', 'cual', 'cuales', 'cuanto', 'cuanta', 'cuantos', 'cuantas', 'mas', 'si', 'se', 'te', 'de', 'el', 'tu', 'mi', 'solo', 'aun', 'porque', 'esto', 'estas', 'estos', 'ese', 'esa', 'esos', 'esas', 'aquel', 'aquella', 'hacia', 'sabana', 'publico', 'practico', 'termino', 'ultimo', 'callo', 'hablo', 'llego', 'paso', 'tomo', 'dejo', 'quedo', 'entro', 'mando', 'amo'].map((x) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '')));
// the same word spelled two ways across captions and graphics ("Montealban" / "Montealbán"). Only a
// proper name (capitalized mid-sentence in text that is not all caps) or a glossary term is a rule:
// accents on common words are grammar, not spelling ("esta" and "está" are both right) — those
// are candidates for the judge to read in context, and diacritic pairs are never compared.
export function consistencyFindings(items, glossary = []) {
  const terms = new Set(glossary.map((g) => fold(g.term)));
  const seen = new Map();
  for (const it of items) {
    const toks = String(it.text).split(/\s+/).filter(Boolean);
    const shouting = toks.every((t) => t === t.toUpperCase());
    toks.forEach((raw, i) => {
      const w = clean(raw);
      if (w.length < 3 || /^\d+$/.test(w)) return;
      const k = fold(w);
      if (DIACRITIC.has(k)) return;
      const g = seen.get(k) ?? {forms: new Map(), name: terms.has(k)};
      if (!shouting && CAP.test(w) && i > 0 && !SENT_END.test(toks[i - 1])) g.name = true; // capitalized mid-sentence
      const surf = w.toLowerCase();
      if (!g.forms.has(surf)) g.forms.set(surf, it);
      seen.set(k, g);
    });
  }
  const out = [];
  for (const {forms: m, name} of seen.values()) {
    if (m.size < 2) continue;
    const forms = [...m.entries()];
    const marks = (s) => (s.normalize('NFD').match(/[\u0300-\u036f]/g) ?? []).length;
    const [good] = [...forms].sort((x, y) => marks(y[0]) - marks(x[0]))[0];
    const at = Math.min(...forms.map(([, it]) => it.at));
    const fix = forms.filter(([s]) => s !== good).map(([s, it]) => {
      const text = it.text.replace(new RegExp(`(^|\\s)${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s.,;:!?])`, 'i'), (m0, pre) => pre + (CAP.test(m0.trim()) ? good[0].toUpperCase() + good.slice(1) : good));
      return /^g/.test(it.ref) ? {tool: 'edit_graphic', note: `"${s}" → "${good}" in its props`, args: {graphic_id: it.ref}} : {tool: 'edit_caption', args: {caption_id: it.ref, text}};
    });
    out.push(F('spelling', name ? 'major' : 'minor', name ? 'rule' : 'candidate', at, null, `${name ? 'nombre escrito' : 'palabra escrita'} de ${forms.length} formas: ${forms.map(([s, it]) => `"${s}" (${it.ref} @${tc(it.at)})`).join(', ')}${name ? ` — la buena es "${good}"` : ' — leer en contexto: ¿es la misma palabra?'}`, {forms: forms.map(([s, it]) => ({text: s, ref: it.ref}))}, fix));
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

// the same footage twice: by source ranges (certain) and by frame hash (B-roll vs B-roll)
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

// ---------- off-mic vs crew talk vs a read-through ----------
// words flagged `off` (a quieter voice, src/speech.ts) are NOT all an off-mic director:
// a countdown, "listo", "acción", crew chatter is crew talk (a meta cut, not a second
// presenter), and the presenter reading the line to camera before performing it is a
// read-through (a retake). Only what is neither stays off-mic (blocker).
export const CREW_WORDS = ['tres', 'dos', 'uno', 'cuatro', 'cinco', 'listo', 'listos', 'lista', 'accion', 'grabando', 'corre', 'corriendo', 'rodando', 'va', 'ya', 'corte', 'corta', 'cuadro', 'otra', 'vez', 'vamos', 'ok', 'okay', 'sale', 'queda', 'bien', 'perfecto', 'rolling', 'action', 'ready', 'speed', 'cut', 'three', 'two', 'one', 'go', '3', '2', '1'];
export function offMicFindings(words, crewWords = CREW_WORDS) {
  const crew = new Set(crewWords.map(fold));
  const runs = [];
  for (const w of words) {
    const r = runs.at(-1);
    if (w.off && r && r.at(-1).clipId === w.clipId && w.t0 - r.at(-1).t1 < 1.5) r.push(w);
    else if (w.off) runs.push([w]);
  }
  const spoken = words.filter((w) => !w.off);
  const grams = (ws, n = 3) => new Set(ws.map((_, i) => ws.slice(i, i + n).map((x) => fold(x.word)).join(' ')).filter((g, i) => i + n <= ws.length));
  const mainGrams = grams(spoken);
  return runs.map((r) => {
    const text = r.map((w) => w.word).join(' ');
    const toks = r.map((w) => fold(w.word)).filter(Boolean);
    const crewShare = toks.filter((t) => crew.has(t)).length / Math.max(1, toks.length);
    const echoed = r.length >= 3 && [...grams(r)].some((g) => mainGrams.has(g));
    const cut = [{tool: 'cut_words', args: {ranges: [{from_wid: r[0].wid, to_wid: r.at(-1).wid}]}}];
    const ev = {from: r[0].wid, to: r.at(-1).wid, clip: r[0].clipId};
    if (crewShare >= 0.6) return F('crew-talk', 'major', 'rule', r[0].t0, r.at(-1).t1, `plática de crew / cuenta regresiva en el corte (no es off-mic): "${text.slice(0, 60)}"`, ev, cut);
    if (echoed) return F('read-through', 'major', 'rule', r[0].t0, r.at(-1).t1, `lectura previa de la línea (no es off-mic): "${text.slice(0, 60)}" — la toma buena viene después`, ev, cut);
    return F('off-mic', 'blocker', 'rule', r[0].t0, r.at(-1).t1, `voz fuera de micro en el corte: "${text.slice(0, 60)}"`, ev, [...cut, {tool: 'set_off_mic', args: {mode: 'cut'}}]);
  });
}

// ---------- client caption rules (profile) ----------
// one page = one sentence at most: a page that ends a sentence before its last word mixes two.
// The shared pager (src/paging.ts) ends a page at every sentence, so re-paging fixes a generated
// page without losing anything; a hand-typed page is rewritten by hand.
export function paginationFindings(pages, style, rawOf = rawText) {
  const out = [];
  for (const c of pages) {
    const k = c.words.findIndex((w, i) => i < c.words.length - 1 && endsSentence(rawOf(w), rawOf(c.words[i + 1])));
    if (k < 0) continue;
    const A = c.words.slice(0, k + 1), B = c.words.slice(k + 1);
    const generated = c.words.every((w) => w.wid) && !c.covers;
    out.push(F('pagination', 'major', 'rule', c.startMs / 1000, c.endMs / 1000, `${c.id} junta dos oraciones: "${A.map((w) => w.text).join(' ')}" + "${B.map((w) => w.text).join(' ')}" — una página por oración`, {page: c.id, lookAt: r2(B[0].startMs / 1000 + 0.05)},
      generated
        ? [{tool: 'set_caption_style', note: 'the shared pager ends a page at every sentence; re-paging keeps word ids, tiers, emoji, real timing and hand-made pages', args: {style: presetOf(style).id}}]
        : [{tool: 'edit_caption', note: 'a hand-typed page: keep one sentence on it (never delete_captions: it hides the words for good; never add_caption: it renumbers every page)', args: {caption_id: c.id, text: A.map((w) => w.text).join(' ')}}]));
  }
  return out;
}
// highlighted (accent) words at the same size as plain ones: preset data, so the fix is code, not a tool
export function accentSizeFindings(style) {
  const preset = presetOf(style);
  const plain = preset.tiers[0]?.scale ?? 1;
  const bigger = [1, 2].filter((t) => (preset.tiers[t]?.scale ?? 1) !== plain);
  if (!bigger.length) return [];
  return [F('accent-size', 'major', 'rule', null, null, `el acento (tier ${bigger.join('/')}) sale a ${bigger.map((t) => `${preset.tiers[t].scale}×`).join('/')} del texto blanco en el preset "${preset.id}" — debe ir al MISMO tamaño`, {preset: preset.id},
    [{tool: 'escalate', note: `preset data (src/captionPresets.ts ${preset.id}.tiers scale → ${plain}): a code change, not an agent edit`, args: {}}])];
}
// the client's glossary wins over the transcript: "sky pool" / "skypul" on screen when the term is "skypool"
export function glossaryFindings(items, glossary = []) {
  const out = [];
  for (const g of glossary) {
    const forms = [g.term, ...(g.variants ?? [])].map((x) => ({key: phraseKey(x), n: x.trim().split(/\s+/).length}));
    for (const it of items) {
      const toks = String(it.text).split(/\s+/).filter(Boolean);
      for (let i = 0; i < toks.length; i++) for (const f of forms) {
        const span = toks.slice(i, i + f.n);
        if (span.length < f.n || phraseKey(span.join(' ')) !== f.key) continue;
        const shown = span.map(clean).join(' ');
        if (shown.toLowerCase() === g.term.toLowerCase()) continue;
        const text = [...toks.slice(0, i), g.term + (span.at(-1).match(/[.,;:!?]+$/)?.[0] ?? ''), ...toks.slice(i + f.n)].join(' ');
        out.push(F('glossary', 'major', 'rule', it.at, null, `"${shown}" en ${it.ref} debe decir "${g.term}" (glosario del cliente${g.note ? `; ${g.note}` : ''})`, {page: it.ref, lookAt: r2(it.at + 0.2)},
          [/^g/.test(it.ref) ? {tool: 'edit_graphic', note: `"${shown}" → "${g.term}" in its props`, args: {graphic_id: it.ref}} : {tool: 'edit_caption', note: f.n > 1 ? 'fewer words → the page is re-timed evenly; re-judge sync' : undefined, args: {caption_id: it.ref, text}}]));
      }
    }
  }
  return out;
}

// ---------- scene / insert coverage from the script ----------
// the plan lists what the script (guion) asks to see, one per line under INSERTS:
//   - plazas comerciales @ take1:12 → broll: plaza, centro comercial
//   - super de calle → super: calle, avenida
export function parseInserts(plan = '') {
  const lines = String(plan).split('\n');
  const at = lines.findIndex((l) => /^\s*INSERTS\s*:/i.test(l));
  if (at < 0) return null;
  const out = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.trim()) continue;
    if (!/^\s*-/.test(l)) break;
    const m = l.trim().match(/^-\s*(.+?)\s*(?:@\s*([\w.-]+:\d+))?\s*(?:→|->)\s*(b-?roll|super|graphic)\s*:\s*(.+)$/i);
    if (m) out.push({what: m[1], anchor: m[2] ?? null, need: /super|graphic/i.test(m[3]) ? 'super' : 'broll', keywords: m[4].split(',').map((x) => x.trim()).filter(Boolean)});
  }
  return out;
}
// the words of a text as folded tokens ("Av. Reforma" → av, reforma)
const tokensOf = (s) => String(s).split(/[^\p{L}\p{N}]+/u).map(fold).filter(Boolean);
// the text VALUES of graphic props (never the key names: "place", "size"…), recursively
export const textValues = (x) => (typeof x === 'string' ? [x] : Array.isArray(x) ? x.flatMap(textValues) : x && typeof x === 'object' ? Object.values(x).flatMap(textValues) : []);
// a keyword (one or more words) found as whole tokens in a text; singular / plural count as the same
const sameTok = (a, b) => a === b || a === `${b}s` || b === `${a}s` || a === `${b}es` || b === `${a}es`;
export function hasKeyword(text, keyword) {
  const hay = tokensOf(text), k = tokensOf(keyword);
  if (!k.length) return false;
  for (let i = 0; i + k.length <= hay.length; i++) if (k.every((t, j) => sameTok(hay[i + j], t))) return true;
  return false;
}
export function insertFindings(inserts, words, brolls, gfx, lib = []) {
  const out = [];
  const has = (hay, kws) => kws.some((k) => hasKeyword(hay, k));
  const cueText = (b) => { const e = lib.find((x) => sourceOf(x.src ?? '') === sourceOf(b.src)); return [...(e?.tags ?? []), e?.desc, e?.label, b.query, sourceOf(b.src)].filter(Boolean).join(' '); };
  const gText = (g) => textValues(g.props ?? {}).join(' ');
  for (const ins of inserts) {
    // the mention: the anchor id, else the first spoken word that shares a stem with a keyword or the insert's name (plaza ~ plazas)
    const stems = [...ins.keywords, ...ins.what.split(/\s+/)].filter((k) => !k.includes(' ')).map(fold).filter((k) => k.length >= 4);
    const stem = (w) => { const x = fold(w.word); return x.length >= 4 && stems.some((k) => x.startsWith(k) || k.startsWith(x)); };
    const anchorWord = ins.anchor ? words.find((w) => w.wid === ins.anchor) : words.find(stem);
    const t = anchorWord?.t0;
    const near = (x) => t == null || (x.startMs / 1000 <= t + 4 && x.endMs / 1000 >= t - 2);
    const ok = ins.need === 'super' ? gfx.some((g) => has(gText(g), ins.keywords) && near(g)) : brolls.some((b) => has(cueText(b), ins.keywords) && near(b));
    if (ok) continue;
    out.push(F('insert-missing', 'blocker', 'rule', t ?? null, null, `falta el inserto del guion "${ins.what}" (${ins.need === 'super' ? 'super' : 'B-roll'}: ${ins.keywords.join(', ')})${t != null ? ` donde se dice "${anchorWord.word}"` : ''}`, {wid: anchorWord?.wid, insert: ins.what},
      ins.need === 'super'
        ? [{tool: 'add_graphic', note: 'location-tag / label-2tone with the text the script gives — never invented', args: {template: 'location-tag', at_wid: anchorWord?.wid, props: {place: '<from the script>'}}}]
        : [{tool: 'suggest_broll', args: {}}, {tool: 'search_stock', note: 'only if the library has nothing', args: {query: ins.keywords.join(' ')}}, {tool: 'add_broll', args: {at_wid: anchorWord?.wid, duration_sec: 2.5, mode: 'fullscreen'}}]));
  }
  return out;
}

// ---------- phone filter (band-limited voice) ----------
// sentences of the timeline speech, with who says them and whether they are questions
export function sentencesOf(words) {
  const out = [];
  let cur = [];
  for (const w of words.filter((x) => !x.off)) {
    cur.push(w);
    if (SENT_END.test(w.word)) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out.map((ws) => {
    const votes = {};
    for (const w of ws) if (w.speaker) votes[w.speaker] = (votes[w.speaker] ?? 0) + 1;
    return {ws, t0: ws[0].t0, t1: ws.at(-1).t1, text: ws.map((w) => w.word).join(' '), speaker: Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null, question: /\?["')\]]*$/.test(ws.at(-1).word) || /^¿/.test(ws[0].word)};
  });
}
// PHONE: none | questions | spk2 questions | spk2 — from the plan, or the profile's known reel
export function parsePhone(plan = '') {
  const m = String(plan).match(/^\s*PHONE\s*:\s*(.+)$/im);
  if (!m) return null;
  const v = m[1].trim().toLowerCase();
  if (/^none|^no\b|^ningun/.test(v)) return {none: true};
  return {speaker: v.match(/spk\d+/)?.[0] ?? null, questions: /question|pregunta/.test(v)};
}
// bands: [{t, full, low, high}] momentary loudness (LUFS) per 100 ms of the full band, < 300 Hz and > 3.4 kHz
export function phoneFindings(sentences, bands, expect) {
  const counts = {};
  for (const s of sentences) if (s.speaker) counts[s.speaker] = (counts[s.speaker] ?? 0) + s.ws.length;
  const main = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  // band loss of each sentence (dB below the full band), against the reel's own full-band sentences
  // (its 20th percentile): absolute numbers mean little — real voice has little over 3.4 kHz anyway
  const measured = sentences.map((s) => {
    const b = bands.filter((x) => x.t - 0.2 >= s.t0 && x.t - 0.2 <= s.t1 && Number.isFinite(x.full) && x.full > -60);
    return {s, n: b.length, low: median(b.map((x) => x.full - x.low)), high: median(b.map((x) => x.full - x.high))};
  });
  const pct = (xs) => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) * 0.2)] : NaN; };
  const base = {low: pct(measured.filter((x) => x.n >= 3).map((x) => x.low)), high: pct(measured.filter((x) => x.n >= 3).map((x) => x.high))};
  const rows = measured.map(({s, n, low: lowGap, high: highGap}) => {
    const phone = n >= 3 && ((lowGap - base.low >= T.phoneDb && highGap - base.high >= T.phoneDb / 2) || (lowGap >= 25 && highGap >= 30));
    const b = {length: n};
    const wanted = !expect || expect.none ? false : (expect.speaker ? s.speaker === expect.speaker : !main || s.speaker !== main) && (!expect.questions || s.question);
    return {...s, phone, wanted, measured: b.length >= 3};
  });
  const out = [];
  for (const r of rows) {
    if (!r.measured) continue;
    const ev = {from: r.ws[0].wid, to: r.ws.at(-1).wid, speaker: r.speaker, question: r.question};
    const fix = [{tool: 'escalate', note: 'reel-agent has no phone-filter tool: a human (or a product change) applies or removes it', args: {}}];
    if (!expect && r.phone) out.push(F('phone-filter', 'minor', 'candidate', r.t0, r.t1, `voz con filtro de teléfono: "${r.text.slice(0, 60)}" — ¿intencional? el plan no declara PHONE`, ev, fix));
    else if (expect && r.phone && !r.wanted) out.push(F('phone-filter', 'major', 'heuristic', r.t0, r.t1, `filtro de teléfono donde no va: "${r.text.slice(0, 60)}" (${r.speaker ?? 'sin hablante'}${r.question ? ', pregunta' : ''})`, ev, fix));
    else if (expect && !r.phone && r.wanted) out.push(F('phone-filter', 'major', 'heuristic', r.t0, r.t1, `falta el filtro de teléfono en: "${r.text.slice(0, 60)}" (${r.speaker ?? 'sin hablante'}, pregunta)`, ev, fix));
  }
  return out;
}

// ---------- color against the client's approved references ----------
// look = medians of luma, contrast (YHIGH − YLOW), saturation and chroma over A-roll frames
export function lookOf(samples) {
  return {Y: median(samples.map((x) => x.YAVG)), C: median(samples.map((x) => x.YHIGH - x.YLOW)), S: median(samples.map((x) => x.SATAVG)), U: median(samples.map((x) => x.UAVG)), V: median(samples.map((x) => x.VAVG)), n: samples.length};
}
export function colorRefFindings(render, ref, label) {
  if (!render.n || !ref.n) return [];
  const d = {Y: render.Y - ref.Y, C: render.C - ref.C, S: render.S - ref.S, U: render.U - ref.U, V: render.V - ref.V};
  const off = [];
  if (Math.abs(d.Y) >= T.refY) off.push(`${d.Y > 0 ? 'más claro' : 'más oscuro'} (luma ${render.Y.toFixed(0)} vs ${ref.Y.toFixed(0)})`);
  if (Math.abs(d.C) >= T.refContrast) off.push(`${d.C > 0 ? 'más' : 'menos'} contraste (${render.C.toFixed(0)} vs ${ref.C.toFixed(0)})`);
  if (Math.abs(d.S) >= T.refSat) off.push(`${d.S > 0 ? 'más' : 'menos'} saturado (${render.S.toFixed(0)} vs ${ref.S.toFixed(0)})`);
  if (Math.abs(d.U) >= T.refWB || Math.abs(d.V) >= T.refWB) off.push(`${d.V > 0 ? 'más cálido' : d.V < 0 ? 'más frío' : 'otro tinte'} (ΔU ${d.U.toFixed(1)}, ΔV ${d.V.toFixed(1)})`);
  if (!off.length) return [];
  const clamp = (x, a, b) => r2(Math.max(a, Math.min(b, x)));
  return [F('color-ref', 'major', 'heuristic', null, null, `el color no coincide con la referencia aprobada (${label}): ${off.join(', ')}`, {render, ref, lookAt: []},
    [{tool: 'set_grade', note: 'whole reel toward the approved look; confirm on the color-ref sheet', args: {exposure: clamp(Math.log2(ref.Y / render.Y), -1, 1), contrast: clamp(ref.C / render.C, 0.7, 1.3), saturation: clamp(ref.S / render.S, 0.7, 1.3), temperature: clamp(-d.V / 25, -0.5, 0.5)}},
     {tool: 'create_lut', note: 'or: a LUT from stills of the approved references (the profile lists them)', args: {name: 'ref-look', reference_images: ['<stills of the references>']}}])];
}

// ---------- clean master vs the captioned version ----------
// same edit, same sound: only the captions may differ
export function parityFindings(a, b) {
  const out = [];
  if (Math.abs(a.duration - b.duration) > 1 / 30 + 0.001) out.push(F('parity', 'blocker', 'rule', null, null, `master limpio y versión con captions no duran lo mismo (${a.duration.toFixed(2)} s vs ${b.duration.toFixed(2)} s)`, {}, [{tool: 'render', note: 'render both from the same edit: set_captions off → render, set_captions on → render, nothing in between', args: {}}]));
  const missA = a.cuts.filter((t) => !b.cuts.some((u) => Math.abs(u - t) <= T.parityCutSec));
  const missB = b.cuts.filter((t) => !a.cuts.some((u) => Math.abs(u - t) <= T.parityCutSec));
  if (missA.length || missB.length) out.push(F('parity', 'major', 'rule', Math.min(...missA, ...missB), null, `los cortes no coinciden entre master y versión con captions: solo en uno ${[...missA, ...missB].slice(0, 6).map(tc).join(', ')}`, {}, [{tool: 'render', note: 'the edit changed between the two renders: re-render the other one', args: {}}]));
  const byT = new Map(b.M.map((m) => [Math.round(m.t * 10), m.M]));
  const diffs = a.M.filter((m) => m.M > -60 && byT.has(Math.round(m.t * 10)) && Math.abs(m.M - byT.get(Math.round(m.t * 10))) > T.parityLU);
  if (diffs.length > Math.max(3, a.M.length * 0.01)) out.push(F('parity', 'major', 'rule', diffs[0].t, null, `el audio difiere entre master y versión con captions (${diffs.length} ventanas > ${T.parityLU} LU, desde ${tc(diffs[0].t)})`, {}, [{tool: 'render', note: 'same edit, same audio settings (set_audio clean / music) for both', args: {}}]));
  return out;
}

// ---------- black flashes (fps-aware) ----------
// blackdetect metadata ({t, black_start | black_end}) → runs [{start, end}]; a run still open at
// the end of the file ends there (end = null → the caller's duration)
export function blackRuns(events) {
  const out = [];
  let open = null;
  for (const e of events) {
    if (e.black_start != null) open = e.black_start;
    if (e.black_end != null && open != null) { out.push({start: open, end: e.black_end}); open = null; }
  }
  if (open != null) out.push({start: open, end: null});
  return out;
}
// A black flash inside the reel — from ONE frame — is a blocker: César found 3–5-frame blacks that a
// 0.4 s blackdetect missed. Frames come from the file's own fps (1 frame = 1/fps). The client
// profile may allow a fade to / from black at the head or tail (`blackFades: {startSec, endSec}`);
// a run inside that window, with a 1.5-frame margin, is a nit. Runs from T.blackLongSec on are the
// QC gate's `black` check. A run on a clip edge names the clip and its source time, so a human can
// tell a black frame in the source from a gap in the edit.
export function blackFlashFindings(runs, {fps = FPS, duration, fades = {}, placed = [], brolls = [], video = null} = {}) {
  const out = [];
  const frame = 1 / fps, margin = 1.5 * frame;
  for (const r0 of runs) {
    const r = {start: r0.start, end: r0.end ?? duration};
    const len = r.end - r.start;
    if (!(len > 0) || len >= T.blackLongSec) continue;
    const frames = Math.max(1, Math.round(len * fps));
    const at = `${r.start.toFixed(2)}–${r.end.toFixed(2)} s`;
    if (fades.startSec && r.start <= margin && r.end <= fades.startSec + margin) { out.push(F('black-flash', 'nit', 'rule', r.start, r.end, `fundido desde negro al inicio (${frames} frames, ${at}) — permitido por el perfil`, {frames}, [])); continue; }
    if (fades.endSec && duration != null && r.end >= duration - margin && r.start >= duration - fades.endSec - margin) { out.push(F('black-flash', 'nit', 'rule', r.start, r.end, `fundido a negro al final (${frames} frames, ${at}) — permitido por el perfil`, {frames}, [])); continue; }
    // what is on screen there: a fullscreen B-roll cue over the take, else the take; the source time
    // tells whether the black is in the footage itself or a gap in the edit
    const cue = brolls.find((b) => b.kind === 'video' && b.mode !== 'inset' && r.start * 1000 >= b.startMs && r.start * 1000 < b.endMs);
    const pc = placed.find((x) => r.start * 1000 < x.endMs && r.end * 1000 > x.startMs);
    const edge = placed.find((x) => x.startMs > 0 && (Math.abs(x.startMs / 1000 - r.start) <= margin || Math.abs(x.startMs / 1000 - r.end) <= margin));
    const srcAt = cue ? r2(r.start - cue.startMs / 1000) : pc ? r2(pc.clip.inSec + (r.start - pc.startMs / 1000) * (pc.clip.speed ?? 1)) : null;
    const where = cue ? ` sobre el B-roll ${cue.id} (fuente ${sourceOf(cue.src)} @${srcAt} s)` : edge ? ` en el corte hacia ${edge.clip.id}` : pc ? ` dentro de ${pc.clip.id} (fuente ${sourceOf(pc.clip.src)} @${srcAt} s)` : '';
    out.push(F('black-flash', 'blocker', 'rule', r.start, r.end, `negro de ${frames} frame${frames > 1 ? 's' : ''} (${at}, ${fps.toFixed(2).replace(/\.00$/, '')} fps)${where} — un flash negro inesperado`, {frames, ...(cue ? {broll: cue.id} : {clip: pc?.clip.id}), sourceSec: srcAt, lookAt: [r2(Math.max(0, r.start - frame)), r2(r.start + len / 2), r2(r.end + frame)]},
      [{tool: 'frame_at', note: 'look at the frames on both sides; if the black is in the source, trim it out of the clip (trim_clip), if it is a gap in the edit, close it — never automatically', args: {at_sec: r2(r.start + len / 2), ...(video ? {video} : {})}}]));
  }
  return out;
}

// ---------- frame 0 black ----------
// Seen in production: 14 of 18 real masters open on ONE solid black frame (t = 0: YMIN ≈ YMAX, U = V
// flat at 127/128; frame 1 normal). It is the thumbnail and the first thing the viewer sees, and a
// 0.4 s blackdetect never sees a single frame. Measured directly: signalstats of frames 0 and 1
// (a two-frame decode). Flat and dark luma on frame 0 = blocker, with the numbers as evidence. A fade
// from black the client profile allows (blackFades.startSec) makes it a nit. The root cause is in
// the renderer (investigated apart); this is the safety net.
export function frameZeroFindings(frames, {fades = {}, video = null} = {}) {
  const f0 = frames.find((f) => f.n === 0) ?? frames[0], f1 = frames.find((f) => f.n === 1);
  if (!f0 || f0.YMAX == null) return [];
  const flat = f0.YMAX - f0.YMIN < T.frame0Flat, dark = f0.YAVG < T.frame0Dark;
  if (!flat || !dark) return [];
  const ev = {frame0: {YAVG: f0.YAVG, YMIN: f0.YMIN, YMAX: f0.YMAX, UMIN: f0.UMIN, UMAX: f0.UMAX, VMIN: f0.VMIN, VMAX: f0.VMAX}, ...(f1 ? {frame1: {YAVG: f1.YAVG, YMIN: f1.YMIN, YMAX: f1.YMAX}} : {}), lookAt: [0, f1?.t ?? 0.04]};
  const nums = `YAVG ${f0.YAVG}, YMIN ${f0.YMIN}, YMAX ${f0.YMAX}, U ${f0.UMIN}–${f0.UMAX}, V ${f0.VMIN}–${f0.VMAX}${f1 ? `; frame 1: YAVG ${f1.YAVG}, YMIN ${f1.YMIN}, YMAX ${f1.YMAX}` : ''}`;
  if (fades.startSec > 0) return [F('frame0-black', 'nit', 'rule', 0, null, `frame 0 negro (${nums}) — el perfil permite un fundido desde negro al inicio`, ev, [])];
  const opens = f1 && !(f1.YMAX - f1.YMIN < T.frame0Flat && f1.YAVG < T.frame0Dark) ? ' y el frame 1 ya es imagen normal' : '';
  return [F('frame0-black', 'blocker', 'rule', 0, null, `el frame 0 (t = 0, la miniatura) es negro sólido: luma plana y oscura (${nums})${opens}`, ev,
    [{tool: 'frame_at', note: 'look at t = 0 and the next frame; the fix is in the renderer (a separate PR) — until then re-render or trim the first frame by hand, never automatically', args: {at_sec: 0, ...(video ? {video} : {})}}])];
}

// ---------- a cut or a whip INSIDE a source clip ----------
// Every used range of every source (clips: inSec→outSec; B-roll video cues: the first seconds
// of their file, which is where the render plays them from) is scanned for scene changes
// (ffmpeg scdet, 0–100 per frame). One frame ≥ T.srcCutScore is a hard cut inside the take; a
// short run of frames far above the range's own median is a whip / snap pan / blur. Either reads
// as a cut the plan never made — a candidate for human eyes, never an auto-fail.
export function usedRanges(clips, brolls, fps = FPS) {
  const out = [];
  for (const pc of placeClips(clips, fps)) out.push({kind: 'clip', id: pc.clip.id, src: pc.clip.src, from: pc.clip.inSec, to: pc.clip.outSec, speed: pc.clip.speed ?? 1, t0: pc.startMs / 1000});
  for (const b of brolls) if (b.kind === 'video') out.push({kind: 'broll', id: b.id, src: b.src, from: 0, to: (b.endMs - b.startMs) / 1000, speed: 1, t0: b.startMs / 1000});
  return out;
}
export function sourceCutFindings(ranges, scores) {
  const out = [];
  for (const r of ranges) {
    const pts = (scores.get(r.src) ?? []).filter(([t]) => t >= r.from + T.srcEdgeSec && t <= r.to - T.srcEdgeSec);
    if (pts.length < 3) continue;
    const med = median(pts.map(([, sc]) => sc));
    const toTl = (t) => r2(r.t0 + (t - r.from) / r.speed);
    const hits = [];
    const hard = pts.filter(([, sc]) => sc >= T.srcCutScore);
    for (const [t, sc] of hard) hits.push({t, why: `corte aparente (scdet ${sc.toFixed(1)})`});
    // whips: runs of consecutive high frames, not already a hard cut, not a long continuous move
    const hi = Math.max(T.whipScore, T.whipRatio * med);
    let run = [];
    const flush = () => {
      if (run.length >= T.whipFrames && run.at(-1)[0] - run[0][0] <= T.whipMaxSec && !hard.some(([t]) => t >= run[0][0] - 0.1 && t <= run.at(-1)[0] + 0.1))
        hits.push({t: run[0][0], end: run.at(-1)[0], why: `movimiento brusco (whip / paneo / desenfoque, ${run.length} frames sobre ${hi.toFixed(1)}, pico ${Math.max(...run.map(([, sc]) => sc)).toFixed(1)})`});
      run = [];
    };
    for (let k = 0; k < pts.length; k++) {
      const gap = k && pts[k][0] - pts[k - 1][0] > 0.1; // a hole in the samples ends a run
      if (gap) flush();
      if (pts[k][1] >= hi) run.push(pts[k]); else flush();
    }
    flush();
    for (const h of hits) out.push(F('source-cut', 'major', 'candidate', toTl(h.t), h.end != null ? toTl(h.end) : null, `${h.why} DENTRO ${r.kind === 'broll' ? 'del B-roll' : 'de la toma'} ${r.id} (fuente ${sourceOf(r.src)} @${h.t.toFixed(2)} s): se ve como un corte que el plan no tiene`, {[r.kind === 'broll' ? 'broll' : 'clip']: r.id, sourceSec: r2(h.t), lookAt: [r2(toTl(h.t) - 0.2), r2(toTl(h.t) + 0.1)]},
      [{tool: 'motion_proof', note: 'watch the 24 frames around it; if it reads as a cut, shorten the range before it (trim_clip / edit_broll) or use another asset — a human decision, never automatic', args: {at_sec: r2(Math.max(0, toTl(h.t) - 0.4))}}]));
  }
  return out;
}
// merge [a, b] intervals
export function mergeRanges(xs) {
  const out = [];
  for (const [a, b] of [...xs].sort((p, q) => p[0] - q[0])) { const l = out.at(-1); if (l && a <= l[1] + 0.05) l[1] = Math.max(l[1], b); else out.push([a, b]); }
  return out;
}
// what of `need` is not yet in `have` (both merged interval lists)
export function missingRanges(need, have) {
  const out = [];
  for (const [a0, b] of need) {
    let a = a0;
    for (const [c, d] of have) { if (d <= a || c >= b) continue; if (c > a) out.push([a, c]); a = Math.max(a, d); if (a >= b) break; }
    if (a < b - 0.02) out.push([a, b]);
  }
  return out;
}

// ---------- what the voice-over promises to SHOW (heuristic, the judge's eyes) ----------
// "tope magnético", "acabado en roble": a sentence that names a concrete feature is a promise the
// picture must keep. Code only gathers the evidence — each sentence, the inserts on screen while it
// is said, the frames to look at; the judge agent reads them and decides (claim-image, major,
// tagged heuristic). Sentences with a proof cue come first. Never a fix.
export const PROOF_CUES = ['acabado', 'acabados', 'tope', 'topes', 'magnetico', 'roble', 'marmol', 'cuarzo', 'granito', 'porcelanato', 'madera', 'piso', 'pisos', 'cocina', 'isla', 'alberca', 'jacuzzi', 'roof', 'rooftop', 'terraza', 'gimnasio', 'gym', 'vista', 'domotica', 'inteligente', 'automatico', 'automatica', 'electrico', 'electrica', 'solar', 'solares', 'cancel', 'vestidor', 'closet', 'balcon', 'altura', 'ventanal', 'ventanales', 'iluminacion', 'insonorizado', 'cerradura', 'elevador', 'estacionamiento', 'cajon', 'bodega', 'amenidades', 'asador', 'cine', 'spa', 'sauna', 'vapor', 'cowork', 'petpark', 'jardin', 'regadera', 'tina', 'lavabo', 'cubierta', 'cubiertas', 'herraje', 'herrajes', 'ducto', 'minisplit', 'clima', 'calentador', 'blindada', 'blindado'];
export function claimEvidence(sentences, brolls, gfx, extraCues = []) {
  const cues = new Set([...PROOF_CUES, ...extraCues].map(fold));
  return sentences.map((s) => {
    const hit = s.ws.map((w) => fold(w.word)).filter((t) => cues.has(t));
    const on = (x) => x.startMs / 1000 < s.t1 && x.endMs / 1000 > s.t0;
    const cuesOn = brolls.filter(on), gOn = gfx.filter((g) => on(g) && g.template !== 'layout');
    const lookAt = [...cuesOn, ...gOn].map((x) => r2((Math.max(x.startMs / 1000, s.t0) + Math.min(x.endMs / 1000, s.t1)) / 2));
    return {text: s.text, t0: r2(s.t0), t1: r2(s.t1), cues: hit, inserts: [...cuesOn.map((b) => `${b.id} ${sourceOf(b.src)}`), ...gOn.map((g) => `${g.id} ${g.template}`)], lookAt: lookAt.length ? lookAt : [r2((s.t0 + s.t1) / 2)]};
  }).filter((c) => c.cues.length || c.inserts.length).sort((a, b) => (b.cues.length > 0) - (a.cues.length > 0) || a.t0 - b.t0);
}

// 64-bit difference hash of a 9×8 grayscale frame
export function dhash(px) {
  let h = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) h = (h << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
  return h;
}
export function hamming(a, b) { let x = a ^ b, n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; }

// verdict: 0 blockers and 0 majors; 3+ minors of one check count as a major (a pattern, not a nit).
// Candidates count only once the judge confirms them on the frame (`confirmed`).
// The label never says "aprobado": only the client approves.
export const counts = (f) => !f.dismissed && (f.kind !== 'candidate' || f.confirmed);
export function verdictOf(findings, {reduced = false} = {}) {
  const live = findings.filter(counts);
  const n = Object.fromEntries(SEVERITIES.map((s) => [s, live.filter((f) => f.severity === s).length]));
  const byCheck = {};
  for (const f of live) if (f.severity === 'minor') byCheck[f.check] = (byCheck[f.check] ?? 0) + 1;
  const patterns = Object.entries(byCheck).filter(([, k]) => k >= 3).map(([c]) => c);
  const pass = n.blocker === 0 && n.major === 0 && patterns.length === 0;
  const toConfirm = findings.filter((f) => !f.dismissed && f.kind === 'candidate' && !f.confirmed).length;
  const label = pass ? `QC técnico superado${reduced ? ' (evidencia reducida)' : ''}` : `QC técnico: ${n.blocker + n.major + patterns.length} hallazgo(s) que corregir (${n.blocker} bloqueantes, ${n.major} mayores${patterns.length ? `, ${patterns.length} patrones` : ''})`;
  return {verdict: pass ? 'PASS' : 'FAIL', label, counts: n, patterns, toConfirm};
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
  const regressions = findings.filter((f) => f.seen === 1 && counts(f) && (f.severity === 'blocker' || f.severity === 'major'));
  return {fixed: fixed.map((f) => `${f.check} @${tc(f.at)}: ${f.msg}`), regressions: regressions.map((f) => f.id), stuck: findings.filter((f) => f.seen >= 3).map((f) => f.id)};
}

// tools that renumber caption pages or change clip ids: every other id in the same report is
// stale after one of them — apply them last, one at a time, and run the judge again in between
export const ID_CHANGERS = new Set(['add_caption', 'delete_captions', 'set_caption_style', 'run_ai_step', 'cut_words', 'split_clip', 'delete_clips', 'set_speed_ramp', 'reorder_clips', 'duplicate_project']);
function F(check, severity, kind, at, end, msg, evidence = {}, fix = []) {
  const ref = evidence.page ?? evidence.broll ?? evidence.clip ?? evidence.wid ?? evidence.from ?? null;
  return {id: `${check}@${at == null ? '-' : at.toFixed(1)}`, check, severity, kind, at: at == null ? null : r2(at), end: end == null ? null : r2(end), msg, ref, evidence, fix: fix.map((x) => (ID_CHANGERS.has(x.tool) ? {...x, changesIds: true} : x))};
}

// ---------- evidence from the mp4 ----------
function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt,sample_rate,channels:format=duration,bit_rate', '-of', 'json', file], {encoding: 'utf8'});
  return r.status === 0 ? JSON.parse(r.stdout) : null;
}
// One decode per file, not one per measurement (the VM has 2 vCPU): every video number comes
// from a single ffmpeg graph, every audio number from another; each meter writes its own
// metadata file (one graph with several loggers on stderr interleaves their lines).
// JUDGE_TIMING=1 prints how long each stage took (stderr)
const timed = (label, fn) => { if (!process.env.JUDGE_TIMING) return fn(); const t0 = performance.now(); try { return fn(); } finally { console.error(`[judge] ${label} ${((performance.now() - t0) / 1000).toFixed(2)} s`); } };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'judge-'));
const fesc = (f) => f.replace(/[\\':]/g, '\\$&'); // a path inside a filtergraph argument
// metadata=print output → [{t, key: value…}]
function readMeta(file, re) {
  const out = [];
  let cur = null;
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of txt.split('\n')) {
    const f = line.match(/pts_time:([\d.]+)/);
    if (f) { cur = {t: +f[1]}; out.push(cur); continue; }
    const m = line.match(re);
    if (m && cur) cur[m[1]] = m[2] === '-inf' ? -Infinity : +m[2];
  }
  return out;
}
// video, one decode: per-frame luma/chroma at `rate` fps (signalstats), a 9×8 dHash of the same
// frames, and — when asked — the scene cuts and the black runs at full frame rate (blackFps =
// the file's fps: a run as short as ONE frame is caught, d = half a frame)
export function analyzeVideo(file, {rate = 2, hashes = true, scenes = false, blackFps = null} = {}) {
  const dir = tmpDir();
  const stats = path.join(dir, 'stats.txt'), cuts = path.join(dir, 'scene.txt'), black = path.join(dir, 'black.txt');
  try {
    // scene cuts and black frames need every frame; the stats and hashes only `rate` per second — thin out first
    const full = [scenes && `[sc]select='gt(scene,0.35)',metadata=print:file=${fesc(cuts)},nullsink`, blackFps && `[bk]blackdetect=d=${(0.5 / blackFps).toFixed(4)}:pix_th=${BLACK.pix}:pic_th=${BLACK.pic},metadata=print:file=${fesc(black)},nullsink`].filter(Boolean);
    const labels = [scenes && '[sc]', blackFps && '[bk]'].filter(Boolean).join('');
    const g = (full.length
      ? [`[0:v]scale=160:-2,split=${full.length + 1}${labels}[v0]`, ...full, `[v0]fps=${rate},split=2[st][h]`]
      : [`[0:v]fps=${rate},scale=270:-2,split=2[st][h]`])
      .concat([`[st]signalstats,metadata=print:file=${fesc(stats)},nullsink`, '[h]scale=9:8:flags=area,format=gray[out]']).join(';');
    const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-i', file, '-an', '-filter_complex', g, '-map', '[out]', '-f', 'rawvideo', '-'], {maxBuffer: 1 << 28});
    const frames = readMeta(stats, /lavfi\.signalstats\.(YAVG|YHIGH|YLOW|UAVG|VAVG|SATAVG)=([\d.]+)/);
    const buf = r.stdout ?? Buffer.alloc(0);
    const hs = [];
    if (hashes) for (let i = 0, k = 0; i + 72 <= buf.length; i += 72, k++) hs.push({t: frames[k]?.t ?? k / rate, h: dhash(buf.subarray(i, i + 72))});
    return {stats: frames, hashes: hs, cuts: scenes ? readMeta(cuts, /^$/).map((x) => x.t).filter((t) => t > 0.05) : [], black: blackFps ? blackRuns(readMeta(black, /lavfi\.(black_start|black_end)=([\d.]+)/)) : []};
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}
// signalstats of the first `n` frames (frame 0 is the thumbnail): a decode of n frames, nothing more
export function firstFrames(file, n = 2) {
  const dir = tmpDir(), meta = path.join(dir, 'f0.txt');
  try {
    spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-i', file, '-an', '-vf', `select='lt(n\\,${n})',signalstats,metadata=print:file=${fesc(meta)}`, '-frames:v', String(n), '-f', 'null', '-']);
    return readMeta(meta, /lavfi\.signalstats\.(YAVG|YMIN|YMAX|UMIN|UMAX|VMIN|VMAX)=([\d.]+)/).map((f, i) => ({...f, n: i}));
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}
// audio, one decode: momentary loudness (EBU R128, per 100 ms) of the full band and — for the
// phone-filter check — under 300 Hz and over 3.4 kHz, plus the peak statistics (astats)
function analyzeAudio(file, {bands = true} = {}) {
  const dir = tmpDir();
  const meter = (name, pre) => `${pre}asetnsamples=n=4800:p=0,ebur128=metadata=1:framelog=quiet,ametadata=print:key=lavfi.r128.M:file=${fesc(path.join(dir, `${name}.txt`))},anullsink`;
  try {
    const legs = bands ? 4 : 2;
    const g = [`[0:a]aresample=48000,asplit=${legs}${['[full]', '[pk]', '[low]', '[high]'].slice(0, legs).join('')}`, `[full]${meter('full', '')}`, '[pk]astats=metadata=0[out]',
      ...(bands ? [`[low]${meter('low', 'lowpass=f=300,lowpass=f=300,')}`, `[high]${meter('high', 'highpass=f=3400,highpass=f=3400,')}`] : [])].join(';');
    const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-filter_complex', g, '-map', '[out]', '-f', 'null', '-'], {encoding: 'utf8', maxBuffer: 1 << 28});
    const o = r.stderr.slice(r.stderr.lastIndexOf('Overall'));
    const num = (re) => { const m = o.match(re); return m ? (m[1] === '-inf' ? -Infinity : +m[1]) : NaN; };
    const series = (name) => readMeta(path.join(dir, `${name}.txt`), /(lavfi\.r128\.M)=(-?[\d.]+|-inf)/).map((x) => ({t: r2(x.t + 0.1), M: x['lavfi.r128.M'] ?? -Infinity}));
    const M = series('full');
    let phone = [];
    if (bands) {
      const byT = (xs) => new Map(xs.map((x) => [Math.round(x.t * 10), x.M]));
      const low = byT(series('low')), high = byT(series('high'));
      phone = M.map((x) => ({t: x.t, full: x.M, low: low.get(Math.round(x.t * 10)) ?? -Infinity, high: high.get(Math.round(x.t * 10)) ?? -Infinity}));
    }
    return {M, bands: phone, peaks: {peakDb: num(/Peak level dB:\s*(-?[\d.]+|-inf)/), peakCount: num(/Peak count:\s*([\d.]+)/), flat: num(/Flat factor:\s*([\d.]+)/)}};
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}
// scdet over the used ranges of the source files, incremental: per file (path + size + mtime) the
// cache keeps the ranges already decoded and their per-frame scores; a run decodes only what is
// new (an edit that moves a cut decodes a few seconds, not the take). One decoder thread
// (REEL_JUDGE_THREADS) and the judge's own nice (REEL_JUDGE_NICE) keep the shared VM rendering.
const SRC_CACHE = path.join(ROOT, '.captions-tmp', 'judge', 'source-scan.json');
function scanSources(ranges, publicDir, skipped) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(SRC_CACHE, 'utf8')); } catch {}
  const out = new Map();
  let dirty = false;
  const bySrc = new Map();
  for (const r of ranges) bySrc.set(r.src, [...(bySrc.get(r.src) ?? []), r]);
  for (const [src, rs] of bySrc) {
    if (/^https?:/i.test(src)) { skipped.push(`source-cut: ${src} is remote (stock) — not scanned`); continue; }
    const file = path.isAbsolute(src) ? src : path.join(publicDir, src.replace(/^\//, ''));
    if (!fs.existsSync(file)) { skipped.push(`source-cut: ${src} not found under public/`); continue; }
    const st = fs.statSync(file);
    const key = `${file}|${st.size}|${Math.round(st.mtimeMs)}`;
    const entry = cache[key] ?? {covered: [], scores: []};
    const need = mergeRanges(rs.map((r) => [Math.max(0, r.from - 0.2), r.to + 0.2]));
    for (const [a, b] of missingRanges(need, entry.covered)) {
      const dir = tmpDir(), meta = path.join(dir, 'scd.txt');
      try {
        spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-threads', THREADS(), '-ss', a.toFixed(3), '-t', (b - a).toFixed(3), '-copyts', '-i', file, '-an', '-vf', `scale=160:-2,scdet=threshold=0,metadata=print:file=${fesc(meta)}`, '-f', 'null', '-']);
        const pts = readMeta(meta, /lavfi\.scd\.(score)=([\d.]+)/).filter((x) => x.score != null).map((x) => [r2(x.t * 1000) / 1000, Math.round(x.score * 1000) / 1000]);
        entry.scores.push(...pts.slice(1)); // the first frame of a range has nothing before it
      } finally { fs.rmSync(dir, {recursive: true, force: true}); }
      entry.covered = mergeRanges([...entry.covered, [a, b]]);
      dirty = true;
    }
    entry.scores = [...new Map(entry.scores.map((x) => [x[0], x])).values()].sort((x, y) => x[0] - y[0]);
    cache[key] = entry;
    out.set(src, entry.scores);
  }
  if (dirty) try { fs.mkdirSync(path.dirname(SRC_CACHE), {recursive: true}); fs.writeFileSync(SRC_CACHE, JSON.stringify(cache)); } catch {} // read-only sandbox: no cache, still correct
  return out;
}
const THREADS = () => String(process.env.REEL_JUDGE_THREADS || 1);
const MEDIA = /\.(mp4|mov|m4v|mkv|webm|jpe?g|png|webp|tiff?)$/i;
function refFiles(paths) {
  const out = [], missing = [];
  for (const rel of paths) {
    const f = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
    if (!fs.existsSync(f)) { missing.push(rel); continue; }
    if (fs.statSync(f).isDirectory()) out.push(...fs.readdirSync(f).filter((x) => MEDIA.test(x)).sort().map((x) => path.join(f, x)));
    else out.push(f);
  }
  return {files: out, missing};
}
// the approved references do not change between runs: their frame statistics are cached per
// file (path + size + mtime) so a folder of reels is decoded once, not on every judge run
const REF_CACHE = path.join(ROOT, '.captions-tmp', 'judge', 'refs-cache.json');
function refStats(files) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(REF_CACHE, 'utf8')); } catch {}
  let dirty = false;
  const out = files.flatMap((f) => {
    const st = fs.statSync(f);
    const key = `${f}|${st.size}|${Math.round(st.mtimeMs)}`;
    if (!cache[key]) { cache[key] = analyzeVideo(f, {rate: 1, hashes: false}).stats; dirty = true; }
    return cache[key];
  });
  if (dirty) try { fs.mkdirSync(path.dirname(REF_CACHE), {recursive: true}); fs.writeFileSync(REF_CACHE, JSON.stringify(cache)); } catch {} // read-only sandbox: no cache, still correct
  return out;
}
// Several contact sheets of ONE file from one decode: `select` picks the exact frames of each
// sheet, `tile` lays them out, drawtext labels each with its own timestamp (unlabeled when
// ffmpeg has no drawtext). groups: [{times, cols, out}]. Returns the sheets written.
function sheetsOf(file, groups, fps = FPS, width = 270) {
  groups = groups.filter((g) => g.times.length);
  if (!groups.length) return [];
  const h = Math.round((width * 16) / 9);
  const chain = (g, label) => {
    const sel = [...new Set(g.times.map((t) => Math.max(0, Math.round(t * fps))))].map((n) => `eq(n\\,${n})`).join('+');
    const lab = label ? `,pad=iw:ih+26:0:0:color=0xFFE500,drawtext=text='%{pts\\:hms}':fontcolor=black:fontsize=18:x=6:y=h-22` : '';
    return `select='${sel}',scale=${width}:${h}:force_original_aspect_ratio=decrease,pad=${width}:${h}:(ow-iw)/2:(oh-ih)/2${lab},tile=${g.cols}x${Math.ceil(g.times.length / g.cols)}:padding=4:color=0x303030`;
  };
  for (const label of [true, false]) {
    const graph = [`[0:v]split=${groups.length}${groups.map((_, i) => `[s${i}]`).join('')}`, ...groups.map((g, i) => `[s${i}]${chain(g, label)}[o${i}]`)].join(';');
    const outs = groups.flatMap((g, i) => ['-map', `[o${i}]`, '-fps_mode', 'vfr', '-frames:v', '1', '-q:v', '4', g.out]);
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-an', '-filter_complex', graph, ...outs]);
    if (r.status === 0 && groups.every((g) => fs.existsSync(g.out))) return groups.map((g) => g.out);
  }
  return groups.map((g) => sheet(file, g.times, g.cols, g.out, width)); // the slow path: one seek per frame
}
// labeled frames tiled into one sheet (drawtext needs freetype: unlabeled otherwise).
// times: seconds of `file`, or [{file, t, label}] to mix files (references, the paired version)
function sheet(file, times, cols, out, width = 270) {
  const dir = fs.mkdtempSync(path.join(path.dirname(out), '.f-'));
  const items = times.map((x) => (typeof x === 'number' ? {file, t: x, label: tc(x)} : x));
  try {
    items.forEach(({file: f0, t, label}, i) => {
      const f = path.join(dir, `${String(i).padStart(2, '0')}.jpg`);
      const base = ['-v', 'error', '-y', ...(MEDIA.test(f0) && !/\.(jpe?g|png|webp|tiff?)$/i.test(f0) ? ['-ss', String(t)] : []), '-i', f0, '-frames:v', '1'];
      const pad = `scale=${width}:${Math.round(width * 16 / 9)}:force_original_aspect_ratio=decrease,pad=${width}:${Math.round(width * 16 / 9)}:(ow-iw)/2:(oh-ih)/2`;
      const lab = `${pad},pad=iw:ih+26:0:0:color=0xFFE500,drawtext=text='${String(label).replace(/[\\':,;[\]=]/g, (c) => `\\${c}`).slice(0, 40)}':fontcolor=black:fontsize=18:x=6:y=h-22`;
      if (spawnSync('ffmpeg', [...base, '-vf', lab, '-q:v', '4', f]).status !== 0) spawnSync('ffmpeg', [...base, '-vf', pad, '-q:v', '4', f]);
    });
    const rows = Math.ceil(items.length / cols);
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-framerate', '1', '-i', path.join(dir, '%02d.jpg'), '-vf', `tile=${cols}x${rows}:padding=4:color=0x303030`, '-frames:v', '1', '-q:v', '4', out]);
    return r.status === 0 ? out : null;
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

// ---------- the pass ----------
// role: master = the clean master (no captions on screen), captioned = the version with
// captions, extra = an alternate version (must live in its own project: duplicate_project).
// The project is read NOW: run this right after the render, before editing again.
export async function judge({projectId, render, publicDir = path.join(ROOT, 'public'), outDir, prev, sheets = true, role = null, pair = null, profile: profileName = null, stateDir = null, sourceScan = true}) {
  const findings = [];
  const skipped = [];
  const p = JSON.parse(fs.readFileSync(path.join(publicDir, 'projects', `${projectId}.json`), 'utf8'));
  p.clips ??= []; p.captions = (p.captions ?? []).map(normalizeCaption); p.brolls ??= []; p.graphics ??= []; p.mattes ??= []; p.captionStyle ??= 'palabra';
  if (role === 'master') p.captionsOff = true; // what is on screen in this render, whatever the project says now
  if (role === 'captioned') p.captionsOff = false;
  const profile = pickProfile(p, profileName);
  Object.assign(T, DEFAULT_T, profile?.thresholds ?? {});
  const reel = reelOf(profile, p.name);
  const resolve = (f) => (path.isAbsolute(f) ? f : fs.existsSync(f) ? path.resolve(f) : path.join(publicDir, f.replace(/^\//, '')));
  const file = resolve(render);
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

  // --- versions: an extra is its own project, never the master's ---
  if (role === 'extra' && stateDir && fs.existsSync(path.join(stateDir, 'master.json'))) findings.push(F('version', 'major', 'rule', null, null, `versión EXTRA renderizada desde el proyecto del master (${projectId}): el master base cambia con ella`, {}, [{tool: 'duplicate_project', note: 'name it "<reel> — EXTRA n (<what changes>)", redo the extra there, keep the master project as delivered', args: {project_id: projectId}}]));
  if ((role === 'master' || role === 'captioned') && /\bextra\b/i.test(p.name ?? '')) findings.push(F('version', 'major', 'rule', null, null, `el proyecto "${p.name}" es una versión EXTRA, no el master base`, {}, []));

  // --- tech + QC gate (scripts/qc.mjs) ---
  const info = probe(file);
  const v = info?.streams.find((s) => s.codec_type === 'video');
  const a = info?.streams.find((s) => s.codec_type === 'audio');
  const q = timed('qc gate', () => qc(file, {expectSec: total, draft}));
  for (const c of q.checks) {
    if (c.ok) continue;
    if (c.name === 'silence') { findings.push(F('audio-silence', 'major', 'rule', null, null, `silencio en el render: ${c.value}`, {qc: c.value}, [{tool: 'run_ai_step', args: {step: 'autocut'}}])); continue; }
    if (c.name === 'black') { for (const m of String(c.value).matchAll(/([\d.]+)–([\d.]+) s/g)) findings.push(F('black', +m[1] < 0.1 ? 'blocker' : 'major', 'heuristic', +m[1], +m[2], `negro en pantalla ${m[1]}–${m[2]} s${+m[1] < 0.1 ? ' (el primer frame / miniatura es negro)' : ''}`, {}, [{tool: 'suggest_broll', note: 'black footage must be covered', args: {}}])); continue; }
    const sev = c.blocking ? 'blocker' : draft && /loudness|true peak/.test(c.name) ? 'nit' : 'minor';
    findings.push(F(`tech-${c.name.replace(/\s+/g, '-')}`, sev, 'rule', null, null, `${c.name}: ${c.value} (want ${c.want})${sev === 'nit' ? ' — draft sin normalizar; el final lo normaliza' : ''}${c.name === 'duration' ? ' — ¿el proyecto cambió después del render?' : ''}`, {}, c.name === 'duration' ? [{tool: 'render', args: {draft}}] : []));
  }
  const fps = v?.r_frame_rate ? v.r_frame_rate.split('/').reduce((n, d) => n / +d) : null; // "30/1"
  if (fps && Math.abs(fps - FPS) > 0.5) findings.push(F('tech-fps', 'major', 'rule', null, null, `${fps.toFixed(2)} fps (want ${FPS})`, {}, []));

  // --- audio ---
  let audio = null;
  let M = [];
  let audioBands = [];
  if (a) {
    const au = timed('audio', () => analyzeAudio(file, {bands: haveTr && (!!(parsePhone(p.plan) ?? reel?.phone) || profile?.detectPhone !== false)}));
    const pk = au.peaks;
    if (pk.peakDb >= -0.1 && (pk.flat > 0 || pk.peakCount > 8)) findings.push(F('clipping', 'major', 'rule', null, null, `clipping: pico ${pk.peakDb.toFixed(2)} dBFS, ${pk.peakCount} muestras en el pico`, pk, [{tool: 'set_clip', note: 'lower the hot clip (volume 0.8) or the music (set_music volume)', args: {}}]));
    M = au.M;
    audioBands = au.bands;
    const Ms = M.filter((m) => Number.isFinite(m.M) && m.M > -70);
    const inWord = (t) => words.some((w) => !w.off && t >= w.t0 && t <= w.t1);
    const speechM = Ms.filter((m) => inWord(m.t - 0.2));
    const voice = median(speechM.map((m) => m.M));
    // voice level take to take
    for (const pc of placed) {
      const own = speechM.filter((m) => m.t - 0.2 >= pc.startMs / 1000 && m.t - 0.2 < pc.endMs / 1000);
      const lv = median(own.map((m) => m.M));
      if (own.length < 5 || !Number.isFinite(voice) || Math.abs(lv - voice) < T.voiceJumpLU) continue;
      const vol = r2(Math.min(2, Math.max(0.1, (pc.clip.volume ?? 1) * 10 ** ((voice - lv) / 20))));
      findings.push(F('voice-level', 'major', 'rule', pc.startMs / 1000, pc.endMs / 1000, `la voz en ${pc.clip.id} está ${Math.abs(lv - voice).toFixed(1)} LU ${lv > voice ? 'más fuerte' : 'más baja'} que el resto`, {clip: pc.clip.id, lufs: r2(lv), reel: r2(voice)}, [{tool: 'set_clip', args: {clip_id: pc.clip.id, volume: vol}}]));
    }
    // music vs voice: the music alone (gaps ≥ 0.8 s) ducked by duckLevel = the bed under the voice
    if (p.music?.src) {
      const gaps = [];
      for (let k = 1; k < words.length; k++) if (words[k].t0 - words[k - 1].t1 >= 0.8) gaps.push([words[k - 1].t1 + 0.4, words[k].t0]);
      if (words.length && total - words.at(-1).t1 >= 1.2) gaps.push([words.at(-1).t1 + 0.4, total - (p.music.fadeOutSec ?? 0)]);
      const bedM = Ms.filter((m) => gaps.some(([s0, e]) => m.t - 0.4 >= s0 && m.t <= e));
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

  // --- transcript-based: pauses, repeats, hook start, off-mic vs crew talk, phone filter ---
  const emphasized = new Set(p.captions.flatMap((c) => c.words.filter((w) => (w.tier ?? 0) > 0 && w.wid).map((w) => w.wid)));
  if (haveTr) {
    findings.push(...pauseFindings(words, p.clips, emphasized), ...repeatFindings(words));
    const first = words.find((w) => !w.off);
    if (first && first.t0 * 1000 > T.deadStartMs) {
      const fix = first.clipIndex === 0 ? [{tool: 'trim_clip', args: {clip_id: first.clipId, in_sec: r2(Math.max(0, first.srcStartMs / 1000 - 0.1))}}] : [{tool: 'delete_clips', note: 'clips before the first word carry no speech', args: {clip_ids: placed.slice(0, first.clipIndex).map((x) => x.clip.id)}}];
      findings.push(F('hook-dead-start', 'major', 'rule', 0, first.t0, `la primera palabra llega a los ${first.t0.toFixed(2)} s — el reel arranca muerto`, {wid: first.wid}, fix));
    }
    for (const i of transcriptIssues(p, tr)) {
      if (i.code === 'off-mic') continue; // classified below: off-mic vs crew talk vs a read-through
      const pc = placed.find((x) => x.clip.id === i.ref);
      findings.push(F(i.code, 'major', 'rule', pc ? pc.startMs / 1000 : null, pc ? pc.endMs / 1000 : null, i.msg, {clip: i.ref}, [{tool: 'cut_words', note: 'or the trim_clip value in the message', args: {}}]));
    }
    if (p.offMic !== 'off') findings.push(...offMicFindings(words, [...CREW_WORDS, ...(profile?.crewWords ?? [])]));
    const expect = parsePhone(p.plan) ?? (reel?.phone ? parsePhone(`PHONE: ${reel.phone}`) : null);
    if (a && (expect || profile?.detectPhone !== false)) {
      const bands = audioBands;
      if (bands.length) findings.push(...phoneFindings(sentencesOf(words), bands, expect));
      else skipped.push('phone filter: could not measure the voice bands');
    }
  } else skipped.push('pauses, repeats, dead start, off-mic / crew talk, cut-in-word, phone filter (no transcript for this project)');

  // --- captions ---
  const pages = p.captionsOff ? [] : projectCaptions(p.captions, p.clips, FPS);
  const gfx = projectGraphics(p.graphics, p.clips, FPS);
  const glossary = profile?.glossary ?? [];
  if (p.captionsOff) skipped.push(role === 'master' ? 'captions (clean master: none on screen by design)' : 'captions (switched off with set_captions — check the brief wants that)');
  else {
    const rawWord = new Map(words.map((w) => [w.wid, w.word]));
    const rawOf = (w) => (w.wid && rawWord.get(w.wid)) || w.text; // the transcript keeps the periods captions drop
    findings.push(...splitNameFindings(pages, glossary, p.captionStyle, rawOf), ...overflowFindings(pages, p.captionStyle, p.brand?.fonts?.body));
    if (haveTr) findings.push(...captionTextFindings(pages, words, new Set(p.hiddenWids ?? [])));
    if (profile?.captions?.pagination === 'sentence') findings.push(...paginationFindings(pages, p.captionStyle, rawOf));
    if (profile?.captions?.accentSameSize) findings.push(...accentSizeFindings(p.captionStyle));
  }
  const texts = [
    ...pages.map((c) => ({text: c.words.map((w) => w.text).join(' '), ref: c.id, at: c.startMs / 1000})),
    ...gfx.map((g) => ({text: Object.values(g.props ?? {}).flatMap((x) => (typeof x === 'string' ? [x] : Array.isArray(x) ? x.map((l) => l?.text ?? '').filter(Boolean) : [])).join(' '), ref: g.id, at: g.startMs / 1000})),
  ];
  findings.push(...consistencyFindings(texts, glossary), ...glossaryFindings(texts, glossary));

  // --- hook: something written in the first second (a clean master has no captions by design) ---
  const firstText = Math.min(...pages.map((c) => c.startMs), ...gfx.filter((g) => g.template !== 'layout').map((g) => g.startMs), Infinity) / 1000;
  if (role !== 'master' && firstText * 1000 > T.firstTextMs && total > 5) findings.push(F('hook-text', 'major', 'rule', 0, Number.isFinite(firstText) ? firstText : null, `nada escrito en pantalla hasta ${Number.isFinite(firstText) ? `${firstText.toFixed(1)} s` : 'el final'} — el hook no se lee sin audio`, {}, [{tool: 'add_graphic', note: 'hook-stack / big-word at the first word (reel-edit step 5)', args: {template: 'hook-stack', at_wid: words[0]?.wid}}]));

  // --- validate (src/validate.ts) — estimated geometry: heuristic ---
  const sevOf = {matte: 'blocker', timing: 'major', 'overlap-captions': 'major', 'safe-top': 'major', 'safe-bottom': 'major', face: 'major', 'behind-hidden': 'major', 'overlap-graphic': 'major', hook: 'major', glue: 'minor', short: 'minor', long: 'minor', 'overlap-graphics': 'minor', 'tier2-density': 'minor', 'tier1-density': 'minor', 'emoji-density': 'minor'};
  const whenOf = (ref) => { const c = pages.find((x) => x.id === ref); if (c) return [c.startMs / 1000, c.endMs / 1000]; const g = gfx.find((x) => x.id === ref); return g ? [g.startMs / 1000, g.endMs / 1000] : [null, null]; };
  for (const i of validateProject(p, FPS)) {
    if (i.code === 'hook' && (role === 'master' || findings.some((f) => f.check === 'hook-text'))) continue;
    const [s0, e] = whenOf(i.ref);
    findings.push(F(`validate-${i.code}`, sevOf[i.code] ?? (i.level === 'error' ? 'major' : 'minor'), ['matte', 'timing', 'overlap-captions', 'glue', 'short', 'long'].includes(i.code) ? 'rule' : 'heuristic', s0, e, i.msg, {page: i.ref, lookAt: s0 != null ? r2((s0 + e) / 2) : undefined}, []));
  }

  // --- cuts ---
  const jumps = [];
  placed.forEach((pc, k) => {
    const c = pc.clip, dur = (pc.endMs - pc.startMs) / 1000;
    if (dur * 1000 < T.flashMs && (c.speed ?? 1) === 1 && placed.length > 1) findings.push(F('flash-cut', 'major', 'rule', pc.startMs / 1000, pc.endMs / 1000, `${c.id} dura ${dur.toFixed(2)} s — un parpadeo`, {clip: c.id}, [{tool: 'delete_clips', args: {clip_ids: [c.id]}}]));
    const prevClip = placed[k - 1]?.clip;
    if (prevClip && prevClip.src === c.src && (!c.enter || c.enter === 'cut') && !c.transform?.length && Math.abs(c.inSec - prevClip.outSec) < 4) jumps.push(pc);
  });
  if (jumps.length) findings.push(F('jump-cut', jumps.length >= 3 ? 'major' : 'minor', 'rule', jumps[0].startMs / 1000, null, `${jumps.length} jump cut(s) del mismo plano sin punch/transición: ${jumps.slice(0, 5).map((x) => `${x.clip.id} @${tc(x.startMs / 1000)}`).join(', ')}`, {clips: jumps.map((x) => x.clip.id)}, [{tool: 'set_transitions', args: {pattern: 'punch-alternate'}}]));
  // a long continuous take is a choice more often than a flaw: candidate nit
  const brolls = projectBrolls(p.brolls, p.clips, FPS);
  const changes = [0, ...placed.map((x) => x.startMs / 1000), ...brolls.flatMap((b) => [b.startMs / 1000, b.endMs / 1000]), ...gfx.map((g) => g.startMs / 1000), total].sort((x, y) => x - y);
  for (let k = 1; k < changes.length; k++) if (changes[k] - changes[k - 1] > T.staticSec) findings.push(F('static', 'nit', 'candidate', changes[k - 1], changes[k], `toma continua de ${(changes[k] - changes[k - 1]).toFixed(1)} s sin cambio de plano, B-roll ni gráfico — solo si se siente lenta`, {lookAt: r2((changes[k - 1] + changes[k]) / 2)}, [{tool: 'set_transitions', note: 'a punch inside the take, or suggest_broll for a cue', args: {pattern: 'punch-alternate'}}]));

  // --- B-roll: repeats, length, what is said under it, the script's inserts ---
  const video = timed('video', () => analyzeVideo(file, {scenes: !!pair, blackFps: fps ?? FPS}));
  const hashes = video.hashes;
  // black flashes from one frame, in this file's own frame rate (César: 3–5-frame blacks slipped through)
  // frame 0 (the thumbnail) black: measured on its own, so a one-frame black at t = 0 is named for what it is
  const f0 = frameZeroFindings(firstFrames(file), {fades: profile?.blackFades ?? {}, video: file});
  findings.push(...f0);
  findings.push(...blackFlashFindings(video.black, {fps: fps ?? FPS, duration: +info?.format?.duration || total, fades: profile?.blackFades ?? {}, placed, brolls, video: file})
    .filter((f) => !(f0.length && f.at === 0 && f.evidence.frames === 1)));
  // a cut or a whip inside a source clip (candidates): scdet over the used ranges, cached per file
  if (sourceScan) {
    const ranges = usedRanges(p.clips, brolls);
    findings.push(...sourceCutFindings(ranges, timed('source scan', () => scanSources(ranges, publicDir, skipped))));
  } else skipped.push('source-cut (--no-source-scan)');
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
    // tags are the library's words, not the narration's: no shared word proves nothing — the judge looks
    if (tags && said && !hit) findings.push(F('broll-fit', 'minor', 'candidate', at, end, `B-roll ${b.id} (${tags.slice(0, 50)}) no comparte palabras con lo que se dice: "${said.slice(0, 70)}" — mirar si el plano muestra lo dicho`, {broll: b.id, lookAt: r2((at + end) / 2)}, [{tool: 'suggest_broll', args: {}}]));
    return {id: b.id, at: r2(at), end: r2(end), mode: b.mode, src: sourceOf(b.src), tags: tags.slice(0, 80), said: said.slice(0, 140)};
  });
  const planInserts = parseInserts(p.plan);
  const inserts = [...(planInserts ?? []), ...(reel?.inserts ?? []).filter((r) => !(planInserts ?? []).some((x) => fold(x.what) === fold(r.what)))];
  if (inserts.length) findings.push(...insertFindings(inserts, words, brolls, gfx, lib));
  else if (profile?.requireInserts) findings.push(F('insert-missing', 'major', 'rule', null, null, 'el plan no lista los INSERTS del guion: no se puede verificar que cada escena/inserto esté cubierto', {}, [{tool: 'set_plan', note: 'add an INSERTS: block (reel-plan template) with every scene / insert the script names — in review mode an edited plan needs the user\'s approval again (src/plan.ts)', args: {}}]));

  // --- color: per A-roll clip (B-roll spans left out), rendered frames ---
  const stats = video.stats;
  const isBroll = (t) => brolls.some((b) => b.mode !== 'inset' && t >= b.startMs / 1000 && t < b.endMs / 1000);
  const aroll = stats.filter((x) => !isBroll(x.t));
  const clipLooks = placed.map((pc) => {
    const s0 = aroll.filter((x) => x.t >= pc.startMs / 1000 + 0.1 && x.t < pc.endMs / 1000 - 0.1);
    return {pc, n: s0.length, Y: median(s0.map((x) => x.YAVG)), YH: median(s0.map((x) => x.YHIGH)), U: median(s0.map((x) => x.UAVG)), V: median(s0.map((x) => x.VAVG))};
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
    // a bright sky or window trips the 90th percentile as easily as a burnt face: candidate, confirm on the frame
    if (x.YH >= T.burnt) findings.push(F('color-burnt', 'minor', 'candidate', x.pc.startMs / 1000, x.pc.endMs / 1000, `${x.pc.clip.id}: 10% del cuadro en blanco (${x.YH.toFixed(0)}/235) — ¿piel/pared quemada ("quemado") o solo cielo/ventana?`, {clip: x.pc.clip.id, lookAt: r2((x.pc.startMs + x.pc.endMs) / 2000)}, [{tool: 'set_grade', args: {target: src0(x), highlights: 0.8, exposure: -0.3}}]));
    if (x.Y <= T.dark) findings.push(F('color-dark', 'minor', 'heuristic', x.pc.startMs / 1000, x.pc.endMs / 1000, `${x.pc.clip.id}: subexpuesto (luma media ${x.Y.toFixed(0)})`, {clip: x.pc.clip.id, lookAt: r2((x.pc.startMs + x.pc.endMs) / 2000)}, [{tool: 'set_grade', args: {target: src0(x), auto: true}}]));
  }
  // against the client's approved references (profile colorRefs)
  const refSheets = [];
  const renderLook = lookOf(aroll);
  for (const g of profile?.colorRefs ?? []) {
    const {files, missing: gone} = refFiles(g.paths ?? []);
    if (gone.length) skipped.push(`color vs "${g.label}": no encuentro ${gone.join(', ')} — ${g.hint ?? 'put the approved references there'}`);
    if (!files.length) continue;
    const samples = timed(`refs ${g.label}`, () => refStats(files));
    findings.push(...colorRefFindings(renderLook, lookOf(samples), g.label));
    refSheets.push({label: g.label, items: files.slice(0, 4).map((f) => ({file: f, t: 1, label: `${g.label.slice(0, 18)}: ${path.basename(f).slice(0, 14)}`}))});
  }

  // --- clean master vs captioned version ---
  let pairFile = null;
  if (pair) {
    pairFile = resolve(pair);
    if (!fs.existsSync(pairFile)) skipped.push(`parity: ${pairFile} not found`);
    else {
      const other = {duration: +probe(pairFile)?.format?.duration || 0, cuts: analyzeVideo(pairFile, {hashes: false, scenes: true}).cuts, M: analyzeAudio(pairFile, {bands: false}).M.filter((m) => Number.isFinite(m.M))};
      findings.push(...parityFindings({duration: +info?.format?.duration || 0, cuts: video.cuts, M: M.filter((m) => Number.isFinite(m.M))}, other));
    }
  }

  // --- evidence for the judge's eyes ---
  const evidence = {sheets: {}, lookAt: []};
  if (sheets && outDir) {
    try {
      fs.mkdirSync(outDir, {recursive: true});
      const dur = +info?.format?.duration || total;
      timed('sheets', () => {
      const cutTimes = placed.slice(1).map((x) => r2(x.startMs / 1000 + 0.1)).slice(0, 16);
      const [overview, hook, cuts] = sheetsOf(file, [
        {times: Array.from({length: 16}, (_, k) => r2(((k + 0.5) * dur) / 16)), cols: 4, out: path.join(outDir, 'overview.jpg')},
        {times: Array.from({length: 9}, (_, k) => r2(Math.min(dur - 0.05, k * 0.25))), cols: 3, out: path.join(outDir, 'hook.jpg')},
        {times: cutTimes, cols: 4, out: path.join(outDir, 'cuts.jpg')},
      ], fps ?? FPS);
      Object.assign(evidence.sheets, {overview, hook, ...(cuts ? {cuts} : {})});
      for (const [k, g] of refSheets.entries()) {
        const mine = Array.from({length: g.items.length}, (_, i) => {
          const t = r2(((i + 0.5) * dur) / g.items.length);
          return {file, t, label: `render ${tc(t)}`};
        });
        evidence.sheets[`color-ref-${k + 1}`] = sheet(file, [...g.items, ...mine], g.items.length, path.join(outDir, `color-ref-${k + 1}.jpg`));
      }
      if (pairFile && fs.existsSync(pairFile)) {
        const ts = Array.from({length: 4}, (_, i) => r2(((i + 0.5) * dur) / 4));
        evidence.sheets.parity = sheet(file, [...ts.map((t) => ({file, t, label: `${role ?? 'this'} ${tc(t)}`})), ...ts.map((t) => ({file: pairFile, t, label: `${role === 'captioned' ? 'master limpio' : 'pair'} ${tc(t)}`}))], 4, path.join(outDir, 'parity.jpg'));
      }
      });
    } catch (e) { skipped.push(`contact sheets (${String(e.message ?? e).slice(0, 80)}) — use frame_at video=<render> at the times below`); }
  }
  evidence.lookAt = [...new Set(findings.flatMap((f) => [].concat(f.evidence?.lookAt ?? (f.at != null ? r2(f.at + 0.1) : []))))].sort((x, y) => x - y).slice(0, 24);
  evidence.captions = pages.map((c) => `${c.id} @${tc(c.startMs / 1000)} "${c.words.map((w) => (w.tier === 2 ? `**${w.text}**` : w.tier ? `*${w.text}*` : w.text)).join(' ')}"`);
  evidence.broll = brollEvidence;
  evidence.graphics = gfx.map((g) => `${g.id} @${tc(g.startMs / 1000)}–${tc(g.endMs / 1000)} ${g.template} ${JSON.stringify(g.props).slice(0, 100)}`);
  evidence.claims = haveTr ? claimEvidence(sentencesOf(words), brolls, gfx, profile?.proofCues ?? []).slice(0, 14) : [];
  evidence.inserts = inserts.map((x) => `${x.what} → ${x.need}: ${x.keywords.join(', ')}${x.anchor ? ` @${x.anchor}` : ''}`);
  evidence.audio = audio;
  // client rules only eyes can check (profiles/<id>.md): e.g. a word cascade → motion_proof at page starts
  evidence.profileDoc = profile ? path.join('.agents/skills/render-judge', profile.doc ?? `profiles/${profile.id}.md`) : null;
  evidence.motionAt = profile?.captions?.cascadeMs && pages.length ? pages.filter((c) => c.words.length >= 3).slice(0, 3).map((c) => r2(Math.max(0, c.startMs / 1000 - 0.05))) : [];
  evidence.tech = {size: v ? `${v.width}x${v.height}` : null, fps, vcodec: v?.codec_name, pix_fmt: v?.pix_fmt, acodec: a?.codec_name, sampleRate: a?.sample_rate, channels: a?.channels, durationSec: r2(+info?.format?.duration), expectedSec: r2(total)};

  const order = (f) => (counts(f) ? 0 : 1e8) + SEVERITIES.indexOf(f.severity) * 1e6 + (f.at ?? -1);
  const uniq = [...new Map(findings.map((f) => [`${f.id}|${f.msg}`, f])).values()];
  findings.length = 0; findings.push(...uniq);
  findings.sort((x, y) => order(x) - order(y));
  const diff = diffWithPrev(findings, prev);
  return {project: projectId, projectName: p.name ?? null, projectUpdatedAt: p.updatedAt ?? null, role, profile: profile?.id ?? null, reel: reel ? Object.keys(profile.reels).find((k) => profile.reels[k] === reel) : null, render: file, pair: pairFile, draft, iteration: (prev?.iteration ?? 0) + 1, at: new Date().toISOString(), durationSec: r2(total), ...verdictOf(findings, {reduced: skipped.length > 0}), findings, diff, skipped, evidence, plan: p.plan ?? null};
}

// ---------- report ----------
const line = (f) => `[${f.severity.toUpperCase()}] ${f.kind !== 'rule' ? `(${f.kind}) ` : ''}${f.check} @${tc(f.at)}${f.end != null ? `–${tc(f.end)}` : ''}${f.seen > 1 ? ` (seen ${f.seen}×)` : ''} — ${f.msg}`;
export function reportText(r) {
  const L = [];
  L.push(`QC TÉCNICO (reglas): ${r.label}  — iteración ${r.iteration}, ${r.role ?? 'render'} ${r.draft ? 'draft' : 'final'}, ${r.durationSec} s${r.profile ? `, perfil ${r.profile}${r.reel ? ` (${r.reel})` : ''}` : ''}`);
  L.push(`  ${r.counts.blocker} bloqueantes · ${r.counts.major} mayores · ${r.counts.minor} menores · ${r.counts.nit} nits · ${r.toConfirm} por confirmar en frame${r.patterns.length ? ` · patrones (3+ menores = mayor): ${r.patterns.join(', ')}` : ''}`);
  L.push('  Etiqueta para la entrega: la de arriba. Nunca "aprobado": solo el cliente aprueba. El master base se entrega igual; esto acompaña a la entrega.');
  L.push(`render: ${r.render}${r.pair ? `  (vs ${r.pair})` : ''}`);
  if (r.diff) L.push(`vs previous: fixed ${r.diff.fixed.length}, regressions ${r.diff.regressions.length ? r.diff.regressions.join(', ') : 'none'}, stuck (3+ iterations) ${r.diff.stuck.length ? r.diff.stuck.join(', ') : 'none'}`);
  const live = r.findings.filter(counts), cand = r.findings.filter((f) => !counts(f) && !f.dismissed);
  const top = live.filter((f) => f.severity === 'blocker' || f.severity === 'major');
  if (top.length) L.push('', 'PRIORIDAD (lo que corrige la siguiente iteración, en orden):', ...top.slice(0, 8).map((f, i) => `  ${i + 1}. ${f.check} @${tc(f.at)} — ${f.msg.slice(0, 110)}`));
  L.push('');
  const fixLine = (x, pre = 'fix') => `    ${pre}: ${x.changesIds ? '⟲ ' : ''}${x.tool} ${JSON.stringify(x.args)}${x.note ? `  // ${x.note}` : ''}`;
  for (const f of live) {
    L.push(line(f));
    for (const x of f.fix) L.push(fixLine(x));
  }
  const counted = top.concat(live.filter((f) => !top.includes(f)));
  const safe = counted.filter((f) => f.fix.length && !f.fix.some((x) => x.changesIds)), moving = counted.filter((f) => f.fix.some((x) => x.changesIds));
  if (moving.length) L.push('', 'ORDEN DE APLICACIÓN: primero los fixes sin ⟲ (ids estables): ' + (safe.map((f) => f.id).join(', ') || '—') + '. Después los ⟲ UNO POR VEZ, volviendo a correr judge.mjs entre cada uno (renumeran páginas o cambian ids de clip): ' + moving.map((f) => f.id).join(', ') + '.');
  if (!live.length) L.push('no rule findings that count');
  if (cand.length) {
    L.push('', 'POR CONFIRMAR EN EL FRAME (no cuentan hasta que el juez las confirme; ruido conocido):');
    for (const f of cand) { L.push(`  ${line(f)}`); for (const x of f.fix) L.push(`  ${fixLine(x, 'fix if confirmed')}`); }
  }
  if (r.skipped.length) L.push('', 'SKIPPED (no evidence — not checked, so not passed):', ...r.skipped.map((s) => `  - ${s}`));
  L.push('', 'EVIDENCE FOR THE JUDGE (snapshot of the project when the render was judged' + (r.projectUpdatedAt ? `, updatedAt ${r.projectUpdatedAt}` : '') + ')');
  for (const [k, f] of Object.entries(r.evidence.sheets)) if (f) L.push(`  sheet ${k}: ${f}`);
  L.push(`  look at (frame_at video=<render>): ${r.evidence.lookAt.map((t) => `${t}s`).join(', ') || '—'}`);
  L.push(`  tech: ${JSON.stringify(r.evidence.tech)}`, `  audio: ${JSON.stringify(r.evidence.audio)}`);
  if (r.evidence.profileDoc) L.push(`  client rules by eye: ${r.evidence.profileDoc}`);
  if (r.evidence.motionAt?.length) L.push(`  word cascade (profile): motion_proof at ${r.evidence.motionAt.map((t) => `${t}s`).join(', ')} — consecutive words must arrive the profile's cascade apart`);
  if (r.evidence.claims?.length) {
    L.push('', 'PROMESAS DEL VO A VERIFICAR (heuristic — no es regla: el juez mira los frames; claim-image = major con timestamp + la promesa sin ilustrar; nunca auto-fix):');
    for (const c of r.evidence.claims) L.push(`  @${tc(c.t0)}–${tc(c.t1)} "${c.text.slice(0, 90)}"${c.cues.length ? `  [prueba: ${c.cues.join(', ')}]` : ''}  en pantalla: ${c.inserts.join(', ') || 'solo el presentador'}  → frame_at ${c.lookAt.map((t) => `${t}s`).join(', ')}`);
  }
  if (r.evidence.inserts.length) L.push('  script inserts checked:', ...r.evidence.inserts.map((x) => `    ${x}`));
  L.push('  captions (proofread every one):', ...(r.evidence.captions.length ? r.evidence.captions.map((c) => `    ${c}`) : ['    (none on screen)']));
  if (r.evidence.graphics.length) L.push('  graphics:', ...r.evidence.graphics.map((g) => `    ${g}`));
  if (r.evidence.broll.length) L.push('  B-roll (what is said under each cue):', ...r.evidence.broll.map((b) => `    ${b.id} @${tc(b.at)}–${tc(b.end)} ${b.mode} ${b.src} [${b.tags}] ← "${b.said}"`));
  return L.join('\n');
}

// ---------- CLI ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const bool = (n) => { const i = args.indexOf(n); if (i >= 0) args.splice(i, 1); return i >= 0; };
  const prevPath = flag('--prev'), outArg = flag('--out'), publicDir = flag('--public'), role = flag('--role') ?? null, pair = flag('--pair') ?? null, profile = flag('--profile') ?? null;
  const asJson = bool('--json'), fresh = bool('--fresh'), noSourceScan = bool('--no-source-scan');
  // the judge runs next to renders on a shared 2-vCPU VM: niced like the asset catalog (ffmpeg inherits it)
  const nice = Number(process.env.REEL_JUDGE_NICE ?? 15);
  try { if (nice > 0) os.setPriority(0, Math.min(19, nice)); } catch {}
  const [projectId, render] = args;
  const usage = 'usage: judge.mjs <project_id> <render.mp4> [--role master|captioned|extra] [--pair other.mp4] [--profile client] [--prev report.json | --fresh] [--out dir] [--json] [--no-source-scan]';
  if (!projectId || !render) { console.error(usage); process.exit(2); }
  if (!/^[\w-]+$/.test(projectId)) { console.error(`bad project id: ${projectId}`); process.exit(2); }
  if (role && !['master', 'captioned', 'extra'].includes(role)) { console.error(usage); process.exit(2); }
  const base = path.join(ROOT, '.captions-tmp', 'judge', projectId);
  const latest = path.join(base, `latest${role ? `-${role}` : ''}.json`); // each version iterates against its own history
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(prevPath ?? latest, 'utf8')); } catch {}
  if (fresh || (!prevPath && prev && Date.now() - Date.parse(prev.at) > 12 * 3600e3)) prev = null; // a new loop, not the next iteration
  const outDir = outArg ?? path.join(base, `${path.basename(render, '.mp4')}-${Date.now()}`);
  const r = await judge({projectId, render, publicDir: publicDir ?? undefined, outDir, prev, role, pair, profile, stateDir: base, sourceScan: !noSourceScan});
  const txt = reportText(r);
  const json = JSON.stringify(r, (k, x) => (typeof x === 'bigint' ? x.toString(16) : x), 2);
  try {
    fs.mkdirSync(outDir, {recursive: true}); fs.mkdirSync(base, {recursive: true});
    fs.writeFileSync(path.join(outDir, 'report.json'), json);
    fs.writeFileSync(path.join(outDir, 'report.md'), txt);
    fs.writeFileSync(latest, json);
    if (role) fs.writeFileSync(path.join(base, `${role}.json`), json);
  } catch (e) { console.error(`(report not saved: ${e.message}; read-only sandbox?)`); }
  console.log(asJson ? json : `${txt}\n\nreport: ${path.join(outDir, 'report.json')}`);
  process.exit(0);
}
