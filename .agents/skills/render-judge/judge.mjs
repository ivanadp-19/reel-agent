#!/usr/bin/env node
// Render judge — the deterministic half of the render-judge skill.
//   node .agents/skills/render-judge/judge.mjs <project_id> <render.mp4> [--role master|captioned|extra]
//        [--pair <other.mp4>] [--profile <client>] [--prev report.json | --fresh] [--out dir] [--json | --summary]
//        [--snapshot <v<n>/project.json>] [--clean <master.mp4>] [--public dir] [--no-source-scan]
//   --summary: one line of JSON, what a review version keeps (versionSummary) — the render queue's
//   judge on a client's vN (scripts/reviews.mjs judgeVersion, spawned niced after the version is recorded)
//   Niced (REEL_JUDGE_NICE, default 15); every ffmpeg it starts decodes and filters on one thread (REEL_JUDGE_THREADS).
//
// Everything a rule can decide is decided here, from evidence: the rendered mp4
// (ffprobe / ffmpeg: loudness, clipping, silences, black, per-frame luma/chroma,
// frame hashes), the project JSON and its own words (the per-source transcript caches,
// scripts/transcript-cache.mjs projectTranscript — never public/transcript.json, the machine's last
// run of ANY project), at the rate the project renders at (src/timeline.ts: 29.97 for a client's
// deliverables, else 30; --clean: the reel without captions (a version's _master.mp4, a layers render's master) —
// grade-coverage measures there; --snapshot: the props a review version was rendered from, its rate
// included). What needs eyes (hook strength, B-roll fit, look,
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
// Generic judge + client profiles: <public>/clients/<client>/profile.json turns on and
// tunes the client's own checks (glossary, sentence paging, accent size, color references,
// crew words, script inserts, known reels); profile.md next to it holds the rules for the
// judge's eyes. Client profiles live on the volume, never in git (the repo is public):
// profiles/ here keeps only the generic example. Chosen by --profile, the kit's
// style.judgeProfile, or the profile's `match` (caption style / brand name); a profile that is
// named but missing stops the judge with where it looked, never a silent generic run.
//
// Shared rules are imported, never re-implemented: placement (src/timeline.ts),
// caption projection (src/captions.ts), validate + transcript issues
// (src/validate.ts), QC gate (scripts/qc.mjs), text widths (src/textFit.ts).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {parseEnv} from 'node:util';

const SKILL = import.meta.dirname;
const ROOT = path.resolve(SKILL, '..', '..', '..');
const src = (f) => path.join(ROOT, 'src', f);
const {placeClips, continuesPrev, deliveryFps, renderFps, sampleTransform, MIN_PIECE_SEC, FLASH_SEC} = await import(src('timeline.ts'));
const {normalizeCaption, projectCaptions, shownUntilMs} = await import(src('captions.ts'));
const {validateProject, validateIdentity, transcriptIssues, unbackedData, dataIssue, SAFE} = await import(src('validate.ts'));
const {DUR_MS, heldScale, startScale} = await import(src('transitions.ts'));
const {paramsFor} = await import(src('grade.ts'));
const {presetOf} = await import(src('captionPresets.ts'));
const {captionPreset, fitPage, nameRuns, realAdvances, MIN_FONT_PX} = await import(src('captionLayout.ts'));
const {readFont} = await import(src('sfnt.ts'));
const {projectBrolls} = await import(src('brollModel.ts'));
const {projectGraphics} = await import(src('graphicTemplates.ts'));
const {contentWords} = await import(src('brollMatch.ts'));
const {CREW_WORDS, isCrewRun} = await import(src('cuts.ts'));
const {numberOf} = await import(src('guion.ts'));
const {toDisplay, endsSentence} = await import(src('paging.ts'));
const {STAGES, inScope, scopeFindings, scopeSkips} = await import(src('stages.ts'));
const {qc} = await import(path.join(ROOT, 'scripts', 'qc.mjs'));
// frame looks, the structure hash and the step rule: one implementation for the source scan and this judge
const gradeScan = await import(path.join(ROOT, 'scripts', 'grade-scan.mjs'));
export const {dhash, hamming} = gradeScan;
const {projectTranscript} = await import(path.join(ROOT, 'scripts', 'transcript-cache.mjs'));
const {threadArgs} = await import(path.join(ROOT, 'scripts', 'first-frame.mjs'));
// captions over a face (src/faces.ts): the same band rule validate places and warns by, on faces YuNet finds in the render
const {captionHits, facesIn} = await import(src('faces.ts'));
const {captionLayout} = await import(src('layers.ts'));
const {canScanFaces, scanFaces} = await import(path.join(ROOT, 'scripts', 'face-scan.mjs'));

const FPS = 30; // the pure rules' default; judge() passes the project's own rate
// the env the backend's jobs see: ROOT's .env under the process env (the transcript engine, scripts/transcript-cache.mjs)
const rootEnv = () => { let e = {}; try { e = parseEnv(fs.readFileSync(path.join(ROOT, '.env'), 'utf8')); } catch {} return {...e, ...process.env}; };
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
  flashMs: FLASH_SEC * 1000, // src/timeline.ts: a word cut never leaves a piece this short alone (applyWordCuts)
  staticSec: 7,
  voiceJumpLU: 4, // take-to-take voice level jump
  musicUnderVoiceLU: 12, musicUnderVoiceMajorLU: 8,
  expoJump: 18, wbJump: 5, burnt: 235, dark: 45, // 8-bit YUV
  gradeY: 2, gradeUV: 1, gradeSat: 0.8, gradeNoise: 4, gradeWin: 6, // a look step at a join: the residual a match leaves visible (|ΔY| 2, U/V 1, sat 0.8), ≥ 4× the local noise, levels over 6 frames each side (inside a clip: the source scan's rule, scripts/grade-scan.mjs)
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
// The volume's first — <publicDir>/clients/<client>/profile.json (+ profile.md), id = its `id`, else the
// folder — then the repo's profiles/*.json (the generic example). Each gets `file` (where it came from),
// `docFile` (its rules by eye) and `base` (what its colorRefs paths are relative to: its folder on the
// volume, the repo root here). A profile file that does not parse throws: a broken profile is never skipped.
const PROFILES = path.join(SKILL, 'profiles');
const repoRel = (f) => (f.startsWith(ROOT + path.sep) ? path.relative(ROOT, f) : f);
export function listProfiles(publicDir = path.join(ROOT, 'public')) {
  const load = (file, id, docFile, base) => {
    let x;
    try { x = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`judge profile ${repoRel(file)} cannot be read: ${e.message}`); }
    x.id ??= id;
    return {...x, file: repoRel(file), docFile: repoRel(docFile ?? path.join(SKILL, x.doc ?? `profiles/${x.id}.md`)), base};
  };
  const ls = (d) => { try { return fs.readdirSync(d).sort(); } catch { return []; } };
  const clients = path.join(publicDir, 'clients');
  return [
    ...ls(clients).filter((c) => fs.existsSync(path.join(clients, c, 'profile.json'))).map((c) => load(path.join(clients, c, 'profile.json'), c, path.join(clients, c, 'profile.md'), path.join(clients, c))),
    ...ls(PROFILES).filter((f) => f.endsWith('.json')).map((f) => load(path.join(PROFILES, f), f.slice(0, -5), null, ROOT)),
  ];
}
// explicit name > the brand kit's style.judgeProfile > a profile whose `match` names the caption style or the brand
export function pickProfile(p, name, all = listProfiles()) {
  const want = name ?? p.brand?.style?.judgeProfile;
  if (want) {
    const hit = all.find((x) => x.id === want);
    if (!hit) throw new Error(`no judge profile "${want}" (have: ${all.map((x) => x.id).join(', ') || 'none'}): a client's profile lives on the volume, public/clients/<client>/profile.json + profile.md — copy it to this machine's public/ (it is never in git)`);
    return hit;
  }
  const brand = fold(p.brand?.name ?? '');
  return all.find((x) => (x.match?.captionStyle ?? []).includes(p.captionStyle) || (brand && (x.match?.brand ?? []).some((b) => brand.includes(fold(b))))) ?? null;
}
// the brand kit (public/brands/*.json) whose style.judgeProfile is this profile: the client's kit
export function kitOf(publicDir, profileId) {
  if (!profileId) return null;
  const dir = path.join(publicDir, 'brands');
  for (const f of (() => { try { return fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort(); } catch { return []; } })()) {
    try { const k = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (k?.style?.judgeProfile === profileId) return k; } catch {}
  }
  return null;
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

// ---------- evidence: timeline speech ----------
// transcript words of every placed clip at the time the viewer HEARS them (seconds), in order.
// Audio follows MultiClipVideo: a J-cut plays the clip's first j seconds of source under the
// previous clip's tail (and mutes them after the cut), an L-cut plays the source past outSec
// under the next clip's head; the frames come from placeClips, like the render's. A muted clip
// is not heard at all. Words in a lead / trail carry `jl` ('lead' | 'trail'). A word a split runs through
// with nothing cut out (continuesPrev: a half-graded head split off) is heard once, whole — never "eso" → "eso".
// `take` = the first clip of such a run, the id projectCaptions gives its pages (a word is on a page of its take).
export function timelineSpeech(clips, tr, fps = FPS) {
  const out = [];
  const missing = [];
  const placed = placeClips(clips, fps);
  let take;
  for (const [k, pc] of placed.entries()) {
    const joined = continuesPrev(placed[k - 1]?.clip, pc.clip);
    if (!joined) take = pc.clip.id;
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
      const where = part(s0), last = out.at(-1);
      if (joined && where === 'main' && last?.wid === `${t.source}:${w.i}` && !last.jl) { last.t1 = Math.max(last.t1, heard(Math.max(s0, s1 - 1))); continue; }
      out.push({wid: `${t.source}:${w.i}`, word: w.word, t0: heard(s0), t1: Math.max(heard(s0), heard(Math.max(s0, s1 - 1))), srcStartMs: w.startMs, srcEndMs: w.endMs, clipId: pc.clip.id, take, clipIndex: k, off: !!w.off, ...(where !== 'main' ? {jl: where} : {}), ...(w.speaker ? {speaker: w.speaker} : {})});
    }
  }
  return {words: out.sort((a, b) => a.t0 - b.t0), missing};
}
const takeOf = (w) => w.take ?? w.clipId; // a word's take: the id pages carry (projectCaptions)

// ---------- rules (pure, exported for tests) ----------
// odd pauses in the narration: gaps between consecutive spoken words as the viewer hears them.
// A pause that reads as dramatic — after a full stop, after "…" / "," / ":", or right before an
// emphasized word — is a candidate (the judge listens with the frame, it never auto-fails);
// a long gap mid-sentence is a rule, and so is dead air past T.deadAirMs. emphasized null: the key
// words are not known yet (the cut's gate, mcp/checks.mjs stageChecks) — any pause may be dramatic.
const DRAMATIC_BEFORE = /[,;:…—–-]["')\]]*$/;
export function pauseFindings(words, clips, emphasized = new Set(), fps = FPS) {
  const out = [];
  const byId = new Map(clips.map((c) => [c.id, c]));
  const jSec = new Map(placeClips(clips, fps).map((pc) => [pc.clip.id, pc.jFrames / fps]));
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
    const across = takeOf(a) !== takeOf(b); // a join where the take runs on is no cut
    const ended = SENT_END.test(a.word);
    const hot = emphasized?.has(b.wid) ?? true;
    const dramatic = ended || DRAMATIC_BEFORE.test(a.word) || hot;
    const fix = pauseFix(a, b, byId);
    const ev = {gapMs: Math.round(gap), from: a.wid, to: b.wid};
    const s1 = (gap / 1000).toFixed(2);
    if (gap >= T.deadAirMs) out.push(F('pause', 'major', 'rule', a.t1, b.t0, `aire muerto de ${s1} s entre "${a.word}" y "${b.word}"${across ? ' (en un corte)' : ''}`, ev, fix));
    else if (!dramatic && gap >= T.pauseMidMs) out.push(F('pause', 'major', 'rule', a.t1, b.t0, `pausa rara de ${s1} s a mitad de frase entre "${a.word}" y "${b.word}"${across ? ' (en un corte)' : ''}`, ev, fix));
    else if (dramatic && gap >= (ended ? T.pauseAfterMs : T.pauseMidMs)) out.push(F('pause', 'minor', 'candidate', a.t1, b.t0, `pausa de ${s1} s entre "${a.word}" y "${b.word}" — ¿dramática? ${ended ? '(tras punto)' : emphasized?.has(b.wid) ? '(antes de la palabra resaltada)' : DRAMATIC_BEFORE.test(a.word) ? '(tras coma / puntos suspensivos)' : '(¿antes de una palabra resaltada? aún no se sabe)'}; cuenta solo si suena a error`, ev, fix));
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
// glossaryOnly: the client's look splits names across pages (César v11: MONTEALBÁN | 326), so only a glossary term counts
export function splitNameFindings(pages, glossary = [], style, rawOf = rawText, glossaryOnly = false) {
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
    if (why) { /* glossary term found above */ } else if (glossaryOnly) continue;
    else if ((a.tier ?? 0) > 0 && (b.tier ?? 0) > 0) why = 'frase resaltada partida';
    else if (CAP.test(at) && /^\d/.test(bt)) { why = 'nombre + número partido'; kind = 'candidate'; }
    else if (CAP.test(at) && CAP.test(bt)) { why = 'posible nombre compuesto partido'; kind = 'candidate'; }
    else if (CONNECTORS.has(fold(at)) && CAP.test(bt) && A.words.length > 1 && CAP.test(clean(A.words.at(-2).text)) && consecutive([A.words.at(-2), a, b])) { why = 'posible nombre compuesto partido'; kind = 'candidate'; span = [A.words.at(-2), a, b]; } // "Playa del | Carmen"
    else if (CAP.test(at) && CONNECTORS.has(fold(bt)) && B.words.length > 1 && CAP.test(clean(B.words[1].text)) && consecutive([a, b, B.words[1]])) { why = 'posible nombre compuesto partido'; kind = 'candidate'; span = [a, b, B.words[1]]; } // "Playa | del Carmen"
    if (!why) continue;
    // Never delete_captions / add_caption to reshape pages: a deleted page hides its words for
    // good and a typed page loses word ids, accents and real timing. In an unbreakable pack a
    // highlighted span is one unit for the pager, and re-paging hands the pager the project's
    // tiers (projectTiers → captions job) BEFORE it pages: highlight the whole name, re-page.
    // a pack that does not bond names: move the page break (edit_caption starts_at_wid — every word keeps its id and
    // time) before the name, or after it when the name opens page A; a name that fills both pages escalates
    const head = A.words.indexOf(span[0]) > 0 ? span[0] : B.words[span.filter((w) => B.words.includes(w)).length];
    const fix = preset.layout.unbreakable
      ? [{tool: 'annotate_captions', note: 'the whole name as one highlighted span (names are key words anyway)', args: {items: span.map((w) => ({wid: w.wid, tier: Math.max(1, w.tier ?? 0)}))}},
         {tool: 'set_caption_style', note: 're-pages with the shared pager, which now sees those tiers; keeps word ids, emoji, real timing and hand-made pages', args: {style: preset.id}}]
      : head?.wid ? [{tool: 'edit_caption', note: `pack "${preset.id}" does not bond names: move the page break so the name is on one page (every word keeps its id and the time it is said)`, args: {caption_id: B.id, starts_at_wid: head.wid}}]
      : [{tool: 'escalate', note: `pack "${preset.id}" does not bond names across pages and the name fills both pages; last resort: edit_caption both pages (re-times them evenly, drops their word ids — re-judge sync)`, args: {}}];
    out.push(F('split-name', 'major', kind, A.startMs / 1000, B.endMs / 1000, `${why} entre páginas: "${A.words.map((w) => w.text).join(' ')}" | "${B.words.map((w) => w.text).join(' ')}"${kind === 'candidate' ? ' — confirmar en el frame del cambio de página' : ''}`, {pages: [A.id, B.id], words: span.map((w) => w.wid), lookAt: [r2(A.endMs / 1000 - 0.1), r2(B.startMs / 1000 + 0.1)]}, fix));
  }
  return out;
}

// caption text that runs off the frame / pages too tall (a failure César reported). The page
// layout is src/captionLayout.ts — the SAME function CaptionTrack renders with (bonded pairs,
// widths as rendered with their emoji, the shrink to fit, the page's lines: flex-wrap's, or balanced in a
// layout.balance pack) — so this only adds the verdict. Widths are a table estimate (heuristic) unless
// the pack's own font file was read (realAdvances): confirm flagged pages with frame_at on the render.
export function overflowFindings(pages, style, brandFont, glossary = []) {
  const preset = captionPreset(style, brandFont);
  const terms = glossary.flatMap((g) => [g.term, ...(g.variants ?? [])]).map((t) => String(t).split(/\s+/).map(fold).filter(Boolean)).filter((t) => t.length > 1);
  const out = [];
  pages.forEach((c, i) => {
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
    const starts = fit.lines;
    if (starts.length > T.maxLines) out.push(F('overflow', 'major', 'heuristic', c.startMs / 1000, c.endMs / 1000, `"${text}" (${c.id}) ocupa ~${starts.length} líneas — bloque demasiado alto`, {page: c.id, lines: starts.length, lookAt: r2(at)}, [{tool: 'edit_caption', args: {caption_id: c.id, scale: r2(Math.max(0.5, (c.scale ?? 1) * 0.85))}}]));
    else if (fit.fontSize < fit.baseSize * 0.75) out.push(F('overflow', 'minor', 'heuristic', c.startMs / 1000, c.endMs / 1000, `"${text}" (${c.id}) se encoge a ${Math.round((fit.fontSize / fit.baseSize) * 100)}% para caber`, {page: c.id, lookAt: r2(at)}, []));
    // a name the page's lines break: a glossary term (of any length) is a rule; a capitalized pair or a
    // name with a connector (captionLayout nameRuns: "Temozón / Norte", "PLAYA DEL / CARMEN") a candidate
    const names = fit.paired.size ? [] : nameRuns(c.words);
    for (const k of starts.slice(1)) {
      const cut = fit.units[k].from, left = c.words.slice(0, cut), right = c.words.slice(cut);
      if (SENT_END.test(left.at(-1).text)) continue;
      // a term whose first j + 1 words end the line and the rest open the next (span: its words)
      let span = [];
      const term = terms.find((t) => t.some((_, j) => j < t.length - 1 && j < left.length && t.length - j - 1 <= right.length && (span = [...left.slice(left.length - j - 1), ...right.slice(0, t.length - j - 1)]).every((w, i) => fold(w.text) === t[i])));
      const run = names.find(([a, b]) => a < cut && cut <= b);
      if (!term && !run) continue;
      const shown = (ws) => ws.map((w) => clean(w.text)).join(' ');
      out.push(term
        ? F('split-name', 'major', 'rule', c.startMs / 1000, c.endMs / 1000, `término del glosario "${shown(span)}" partido en dos líneas (${c.id})`, {page: c.id, words: span.map((w) => w.wid), lookAt: r2(at)}, preset.layout.balance && span.every((w) => w.wid)
          // the balanced lines never break inside a highlighted span unless nothing else fits (captionLayout breakLines)
          ? [{tool: 'annotate_captions', note: 'the whole term as one highlighted span: the page\'s balanced lines keep it together', args: {items: span.map((w) => ({wid: w.wid, tier: Math.max(1, w.tier ?? 0)}))}}]
          : [{tool: 'edit_caption', note: 'smaller, so the term fits one line (flex-wrap: no tool moves a line break)', args: {caption_id: c.id, scale: r2(Math.max(0.5, (c.scale ?? 1) * 0.85))}}])
        : F('split-name', 'minor', 'candidate', c.startMs / 1000, c.endMs / 1000, `nombre que puede partirse en dos líneas: "${shown(c.words.slice(run[0], cut))} / ${shown(c.words.slice(cut, run[1] + 1))}" (${c.id})`, {page: c.id, lookAt: r2(at)}, [{tool: 'edit_caption', args: {caption_id: c.id, text: '<break the page before the name>'}}]));
      break;
    }
    const dur = (shownUntilMs(pages, i, preset.holdMs) - c.startMs) / 1000; // on screen, the hold included
    if (dur > 0 && text.length / dur > T.cps) out.push(F('reading-speed', 'minor', 'rule', c.startMs / 1000, c.endMs / 1000, `"${text}" (${c.id}) — ${Math.round(text.length / dur)} caracteres/s, ilegible (≤ ${T.cps})`, {page: c.id}, []));
  });
  return out;
}

// caption ↔ audio sync, coverage, spelling and text against the aligned transcript.
// caption-text: a page word that is not the word said at its id (folded: case, accents, punctuation aside) —
// the audio wins (César). Allowed: what the captions pipeline made, which keeps what the ASR heard in `asr` —
// a guion adoption (#35), a glossary respelling, a figure joined into digits, the pieces of a split word (a hand
// edit that changes one drops its `asr`: src/captions.ts retext) — and, by hand, a glossary spelling (the
// profile's and the kit's, `glossary`: the term shown where one of its variants was said) or a figure in digits
// said in words. Only on a page whose timing agrees with the transcript's: a page timed on another transcript
// run has its ids on other words (a short word shifted by one still starts within the sync tolerance, so the
// page decides, not the word) — that is sync's finding (regenerate), not a text to copy.
export function captionTextFindings(pages, words, hidden = new Set(), glossary = []) {
  const out = [];
  const byWid = new Map(words.map((w) => [`${takeOf(w)}|${w.wid}`, w]));
  const covered = new Set();
  const seen = new Set(); // a word the guion split ("acomodan" → "acomoda" "a") shares its id: only its first piece starts with it
  const forms = (f) => [fold(f), ...String(f).split(/\s+/).map(fold)]; // a form whole and its tokens
  const terms = glossary.map((g) => ({term: new Set(forms(g.term)), variants: new Set((g.variants ?? []).flatMap(forms))}));
  const figure = (digits, words) => /^\d+$/.test(digits) && numberOf(words.split(/\s+/).filter(Boolean)) === +digits; // "setenta y cinco" is 75
  const sameWord = (shown, said) => shown === said || terms.some((t) => t.term.has(shown) && t.variants.has(said)) || figure(shown, said) || figure(said, shown);
  const shownWids = new Set(pages.flatMap((c) => c.words.map((w) => w.wid).filter(Boolean)));
  for (const c of pages) {
    const hand = c.words.filter((w) => !w.wid);
    let worst = null;
    const other = new Map(); // page word → what was said there
    for (const w of c.words) {
      if (!w.wid) continue;
      covered.add(w.wid);
      if (seen.has(`${c.clipId}|${w.wid}`)) continue;
      seen.add(`${c.clipId}|${w.wid}`);
      const s = byWid.get(`${c.clipId}|${w.wid}`);
      if (!s) continue;
      const d = w.startMs - s.t0 * 1000;
      if (Math.abs(d) >= T.syncMajorMs && (!worst || Math.abs(d) > Math.abs(worst.d))) worst = {w, s, d};
      const said = toDisplay(s.word);
      if (w.asr == null && fold(w.text)) {
        // a word the pipeline joined ("tres veintiséis" → 326) spans the ones it swallowed (shown on no page): all of them were said there
        const under = words.filter((x) => takeOf(x) === c.clipId && x !== s && !shownWids.has(x.wid) && x.t0 >= s.t0 && x.t0 * 1000 < w.endMs - 30);
        const all = [said, ...under.map((x) => toDisplay(x.word))].join(' ');
        if (!sameWord(fold(w.text), fold(all)) && !figure(fold(w.text), all.split(/\s+/).map(fold).filter(Boolean).join(' '))) other.set(w, all);
      }
      // a diacritic pair (esta/está) is grammar the ASR also gets wrong: the judge reads it in context
      if (fold(said) === fold(w.text) && said.toLowerCase() !== w.text.toLowerCase() && /[áéíóúñü]/i.test(said) && !/[áéíóúñü]/i.test(w.text))
        out.push(F('spelling', DIACRITIC.has(fold(said)) ? 'minor' : 'major', DIACRITIC.has(fold(said)) ? 'candidate' : 'rule', s.t0, s.t1, `"${w.text}" (${c.id}) sin tilde — el transcript dice "${said}"`, {page: c.id, wid: w.wid}, [{tool: 'edit_caption', args: {caption_id: c.id, text: c.words.map((x) => (x === w ? said : x.text)).join(' ')}}]));
    }
    if (other.size && !worst) { // a page off sync has its ids on another transcript run's words: sync says regenerate
      const list = [...other].map(([w, said]) => `"${w.text}" (se oye "${said}")`).join(', ');
      out.push(F('caption-text', 'major', 'rule', c.startMs / 1000, c.endMs / 1000, `${c.id} "${c.words.map((x) => x.text).join(' ')}" no dice lo que se oye: ${list} — el audio manda`, {page: c.id, wids: [...other.keys()].map((w) => w.wid)},
        [{tool: 'edit_caption', note: 'the words as said (same word count: ids and timing stay); a client spelling goes in the glossary, not here', args: {caption_id: c.id, text: c.words.map((x) => other.get(x) ?? x.text).join(' ')}}]));
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
      const cov = words.filter((w) => takeOf(w) === c.clipId && (c.covers ?? []).includes(w.wid));
      const d = cov.length ? c.startMs - cov[0].t0 * 1000 : 0;
      out.push(F('sync', Math.abs(d) >= T.syncMajorMs ? 'major' : 'minor', 'rule', c.startMs / 1000, c.endMs / 1000, `${c.id} fue reescrita con otro número de palabras: el tiempo de cada palabra es repartido, no el del audio${cov.length ? ` (inicio ${Math.round(d)} ms vs voz)` : ''}`, {page: c.id}, [{tool: 'edit_caption', note: 'same word count as the spoken words keeps the real timing', args: {caption_id: c.id, text: '<same number of words as spoken>'}}]));
    }
  }
  // spoken words with no caption (runs of 3+)
  const inPage = (w) => pages.some((c) => c.clipId === takeOf(w) && w.t0 * 1000 >= c.startMs - 30 && w.t0 * 1000 < c.endMs + 30);
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
export function repeatedFootageFindings(clips, brolls, hashes = [], fps = FPS) {
  const out = [];
  const placed = placeClips(clips, fps);
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
// read-through (a retake). Only what is neither stays off-mic (blocker). The crew rule is src/cuts.ts
// isCrewRun (find_cut_candidates proposes the same runs as 'meta' cuts); extra = the profile's crewWords.
export {CREW_WORDS};
export function offMicFindings(words, extra = []) {
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
    const echoed = r.length >= 3 && [...grams(r)].some((g) => mainGrams.has(g));
    const cut = [{tool: 'cut_words', args: {ranges: [{from_wid: r[0].wid, to_wid: r.at(-1).wid}]}}];
    const ev = {from: r[0].wid, to: r.at(-1).wid, clip: r[0].clipId};
    if (isCrewRun(toks, {off: true, extra})) return F('crew-talk', 'major', 'rule', r[0].t0, r.at(-1).t1, `plática de crew / cuenta regresiva en el corte (no es off-mic): "${text.slice(0, 60)}"`, ev, cut);
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
// the client's own pack (the brand kit's style.pack, the profile's captionStyle): a reel on another
// pack is switched back — never that pack's preset edited to look like the client's
export function packFindings(style, profile, kitPack) {
  const own = [...new Set([kitPack, ...(profile?.match?.captionStyle ?? [])])].filter((x) => x && presetOf(x).id === x);
  if (!own.length || own.includes(style)) return [];
  return [F('wrong-pack', 'major', 'rule', null, null, `los subtítulos usan el pack "${style}"; el de este cliente es "${own[0]}"`, {pack: style, want: own[0]},
    [{tool: 'set_caption_style', note: 're-pages the generated captions for the client\'s pack, keeping tiers and hand-made pages', args: {style: own[0]}}])];
}
// highlighted (accent) words at the client's size against the plain ones (César v11: 1.15×):
// preset data, so the fix is code, not a tool (on the client's own pack: packFindings covers any other)
export function accentScaleFindings(style, want) {
  const preset = presetOf(style);
  const plain = preset.tiers[0]?.scale ?? 1;
  const off = [1, 2].filter((t) => (preset.tiers[t]?.scale ?? 1) / plain !== want);
  if (!off.length) return [];
  return [F('accent-size', 'major', 'rule', null, null, `el acento (tier ${off.join('/')}) sale a ${off.map((t) => `${(preset.tiers[t]?.scale ?? 1) / plain}×`).join('/')} del texto blanco en el preset "${preset.id}" — debe ir a ${want}×`, {preset: preset.id},
    [{tool: 'escalate', note: `preset data (src/captionPresets.ts ${preset.id}.tiers scale → ${want * plain}): a code change, not an agent edit`, args: {}}])];
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
    // the mention: the anchor id, else the first spoken word that shares a stem with a keyword or the insert's name (plaza ~
    // plazas) — a super's name never: "super de calle" is not where "súper" (the supermarket) is said. No mention: anywhere
    const stems = [...ins.keywords, ...(ins.need === 'super' ? [] : ins.what.split(/\s+/))].filter((k) => !k.includes(' ')).map(fold).filter((k) => k.length >= 4);
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
// the approved references of the project's development (identity.development: "Montealbán 326", "Thula",
// "marca") — a reel of one building is never held to another's look. → {groups: the profile's colorRefs
// tagged with it, skip: the notes on what was not compared — no development, none of it, and every
// reference that names no development (never compared: it could show any building)}
export function colorRefGroups(profile, development) {
  const all = profile?.colorRefs ?? [];
  if (!development) return {groups: [], skip: all.length ? ['color-ref: the project has no identity.development — set_identity development (e.g. "Montealbán 326") to compare it with that development\'s approved references'] : []};
  const groups = all.filter((g) => g.development && fold(g.development) === fold(development));
  const untagged = all.filter((g) => !g.development).map((g) => `color-ref: "${g.label}" names no development (colorRefs[].development) — not compared`);
  return {groups, skip: [...(all.length && !groups.length ? [`color-ref: profile ${profile.id} has no approved reference of "${development}" (colorRefs[].development) — not compared`] : []), ...untagged]};
}

// ---------- color from clip to clip: an ADVISORY (two shots may look different on purpose) ----------
// clipLooks: [{pc, n, Y, U, V}] of the A-roll shots (pc: one of `shots`, shotsOf — a split the source runs on
// through is no cut to jump at). Each is compared with the duration-weighted median of the shots of its own
// location (set_clip location; clips without one are one group): a jump between two places is not a jump
export function colorJumpFindings(clipLooks, shots) {
  const out = [];
  const src0 = (x) => sourceOf(x.pc.clip.src);
  const cutAt = (x) => { const k = shots.indexOf(x.pc); return [k > 0 ? r2(x.pc.startMs / 1000 - 0.3) : null, r2(x.pc.startMs / 1000 + 0.3)].filter((t) => t != null); };
  const byPlace = new Map();
  for (const x of clipLooks) { const l = x.pc.clip.location ?? ''; byPlace.set(l, [...(byPlace.get(l) ?? []), x]); }
  for (const xs of byPlace.values()) {
    if (xs.length < 2) continue;
    const wmed = (key) => {
      const vs = xs.map((x) => ({v: x[key], w: x.n})).filter((x) => Number.isFinite(x.v)).sort((p1, p2) => p1.v - p2.v);
      const half = vs.reduce((n, x) => n + x.w, 0) / 2;
      let acc = 0;
      for (const x of vs) if ((acc += x.w) >= half) return x.v;
      return NaN;
    };
    const ref = {Y: wmed('Y'), U: wmed('U'), V: wmed('V')};
    for (const x of xs) {
      const dY = x.Y - ref.Y, dU = x.U - ref.U, dV = x.V - ref.V;
      if (Math.abs(dY) >= T.expoJump) out.push(F('color-jump', 'major', 'heuristic', x.pc.startMs / 1000, x.pc.endMs / 1000, `${x.pc.clip.id} (${src0(x)}) ${dY > 0 ? 'más claro' : 'más oscuro'} que el resto del reel (luma ${x.Y.toFixed(0)} vs ${ref.Y.toFixed(0)}) — salta en el corte`, {clip: x.pc.clip.id, lookAt: cutAt(x)}, [{tool: 'set_grade', args: {target: src0(x), exposure: r2(Math.max(-1, Math.min(1, Math.log2(ref.Y / x.Y))))}}, {tool: 'set_clip', note: 'or, when it was shot somewhere else on purpose: name its location', args: {clip_id: x.pc.clip.id, location: '<place>'}}]));
      if (Math.abs(dU) >= T.wbJump || Math.abs(dV) >= T.wbJump) out.push(F('color-jump', 'major', 'heuristic', x.pc.startMs / 1000, x.pc.endMs / 1000, `${x.pc.clip.id} (${src0(x)}) con otro balance de blancos (${dV > 0 ? 'más cálido' : dV < 0 ? 'más frío' : 'otro tinte'}: ΔU ${dU.toFixed(1)}, ΔV ${dV.toFixed(1)})`, {clip: x.pc.clip.id, lookAt: cutAt(x)}, [{tool: 'set_grade', args: {target: src0(x), temperature: r2(Math.max(-0.5, Math.min(0.5, -dV / 25)))}}]));
    }
  }
  return out;
}

// ---------- the edit's shots: what the viewer sees as one uninterrupted shot ----------
// placed: placeClips. Clips joined where the source runs on (continuesPrev: a split that removed nothing — a
// pre-edit split at its own shot change, a half-graded head split off by grade-coverage's fix) with a plain cut
// and the same framing either side are one shot: the edit adds nothing on screen there (whatever the source
// shows there is source-cut's). → [{clip (its first), startMs, endMs, ids}]. Every rule that counts shots uses
// this: flash-cut, color-jump, color-burnt / dark, static and the cuts sheet
export function shotsOf(placed) {
  const shots = [];
  placed.forEach((pc, k) => {
    const prev = placed[k - 1]?.clip, a = prev && sampleTransform(prev.transform, prev.outSec), b = sampleTransform(pc.clip.transform, pc.clip.inSec);
    if (continuesPrev(prev, pc.clip) && startScale(pc.clip) === heldScale(prev) && Math.abs(a.scale - b.scale) + Math.abs(a.x - b.x) + Math.abs(a.y - b.y) < 1e-3) Object.assign(shots.at(-1), {endMs: pc.endMs, ids: [...shots.at(-1).ids, pc.clip.id]});
    else shots.push({clip: pc.clip, startMs: pc.startMs, endMs: pc.endMs, ids: [pc.clip.id]});
  });
  return shots;
}

// ---------- cuts: a flash, jump cuts inside one take ----------
// a flash is a SHOT under flashMs (shotsOf: a 10-frame piece a split runs on through is no flash, two tiny pieces
// together still are); a jump cut is a join inside one take with something cut out (never a continuing one)
export function cutFindings(placed) {
  const out = [], jumps = [], shots = shotsOf(placed);
  for (const sh of shots) {
    const dur = (sh.endMs - sh.startMs) / 1000, name = sh.ids.length > 1 ? `${sh.ids[0]}…${sh.ids.at(-1)}` : sh.clip.id;
    if (dur * 1000 < T.flashMs && (sh.clip.speed ?? 1) === 1 && shots.length > 1) out.push(F('flash-cut', 'major', 'rule', sh.startMs / 1000, sh.endMs / 1000, `${name} dura ${dur.toFixed(2)} s — un parpadeo`, {clip: sh.clip.id}, [{tool: 'delete_clips', args: {clip_ids: sh.ids}}]));
  }
  placed.forEach((pc, k) => {
    const c = pc.clip, prevClip = placed[k - 1]?.clip;
    if (prevClip && !continuesPrev(prevClip, c) && prevClip.src === c.src && (!c.enter || c.enter === 'cut') && !c.transform?.length && Math.abs(c.inSec - prevClip.outSec) < 4) jumps.push(pc);
  });
  if (jumps.length) out.push(F('jump-cut', jumps.length >= 3 ? 'major' : 'minor', 'rule', jumps[0].startMs / 1000, null, `${jumps.length} jump cut(s) del mismo plano sin punch/transición: ${jumps.slice(0, 5).map((x) => `${x.clip.id} @${tc(x.startMs / 1000)}`).join(', ')}`, {clips: jumps.map((x) => x.clip.id)}, [{tool: 'set_transitions', args: {pattern: 'punch-alternate'}}]));
  return out;
}

// A piece under flashMs that shotsOf joins to a shot only through a continuing join where the RENDER cuts (its looks:
// structure hash over CUT_HASH — the source's own shot change), with the edit's cut (or the reel's edge) on its other
// side: what it continued is gone from the timeline, and alone between two cuts it flashes (a 3-frame half-graded tail
// whose shot a trim took). looks: the render's frames (analyzeVideo), placed at the render's rate.
export function strandedFlashes(placed, looks) {
  const shots = shotsOf(placed), shotOf = new Map(shots.flatMap((sh, i) => sh.ids.map((id) => [id, i])));
  const cutAt = (f) => !!looks?.[f] && !!looks[f - 1] && hamming(looks[f - 1].h, looks[f].h) > gradeScan.CUT_HASH;
  const out = [];
  placed.forEach((pc, i) => {
    const sh = shots[shotOf.get(pc.clip.id)];
    if (sh.ids.length < 2 || pc.endMs - pc.startMs >= T.flashMs || (pc.clip.speed ?? 1) !== 1) return;
    const first = sh.ids[0] === pc.clip.id, last = sh.ids.at(-1) === pc.clip.id;
    if (first === last) return; // inside a run of pieces: continuing on both sides
    const lone = first ? cutAt(placed[i + 1].fromFrame) : cutAt(pc.fromFrame);
    if (lone) out.push(F('flash-cut', 'major', 'rule', pc.startMs / 1000, pc.endMs / 1000, `${pc.clip.id} dura ${((pc.endMs - pc.startMs) / 1000).toFixed(2)} s entre un corte de la edición y el corte de la fuente — un parpadeo (lo que continuaba ya no está)`, {clip: pc.clip.id}, [{tool: 'delete_clips', args: {clip_ids: [pc.clip.id]}}]));
  });
  return out;
}

// ---------- grade-coverage: the look must not change INSIDE a shot (blocking) ----------
// looks: every frame of the render (analyzeVideo looks); placed: placeClips at the render's own fps;
// spans: [{startMs, endMs}] of what is drawn over the footage (B-roll, graphics, caption pages). Frames
// under them and around a cut with a transition are not measured. A step between two measured frames of
// one stretch of footage — the same clip, or a clip that continues it in its source — whose structure
// stays the same is part of a shot in another grade: a pre-edit's ungraded head, a grade that starts late.
// The source scan's rule everywhere; at a join of two clips in different grades (paramsFor: a match, an override),
// thresholds near what a fixed join leaves (T.grade*). grade: the project's. → {findings, skipped}: a clip with no
// measured frame is skipped with a note.
export function gradeCoverageFindings(looks, placed, spans = [], fps = FPS, grade = null) {
  const last = placed.at(-1);
  const n = Math.min(looks.length, last ? last.fromFrame + last.durFrames : 0);
  const clipOf = new Int32Array(n).fill(-1);
  placed.forEach((pc, i) => { for (let k = pc.fromFrame; k < Math.min(n, pc.fromFrame + pc.durFrames); k++) clipOf[k] = i; });
  const frameMs = 1000 / fps;
  const cover = [...spans.map((s) => [s.startMs - frameMs, s.endMs + frameMs]),
    ...placed.filter((pc, i) => pc.clip.enter && pc.clip.enter !== 'cut' && !(continuesPrev(placed[i - 1]?.clip, pc.clip) && startScale(pc.clip) === heldScale(placed[i - 1]?.clip))).map((pc) => { const w = pc.clip.enter === 'punch' ? 1.5 * frameMs : Math.max(DUR_MS[pc.clip.enter] ?? 0, 300); return [pc.startMs - w, pc.startMs + w]; })];
  const okA = Array.from({length: n}, (_, k) => clipOf[k] >= 0 && !cover.some(([a, b]) => k * frameMs >= a && k * frameMs < b));
  const joined = (k) => clipOf[k] === clipOf[k - 1] || continuesPrev(placed[clipOf[k - 1]]?.clip, placed[clipOf[k]]?.clip);
  const ch = [{key: 'luma', t: T.gradeY, of: (f) => f.y}, {key: 'U', t: T.gradeUV, of: (f) => f.u}, {key: 'V', t: T.gradeUV, of: (f) => f.v}, {key: 'sat', t: T.gradeSat, of: (f) => f.s}];
  const findings = [], L = looks.slice(0, n), opts = {win: T.gradeWin, noiseK: T.gradeNoise, ok: (i) => okA[i], joined};
  // one rule with the source scan (scripts/grade-scan.mjs SOURCE_NEED), so a render never passes a step validate reports
  // in its sources — and at a join of two clips whose grades differ (a match, an override: a fix's join), the residual it
  // leaves (T.grade*, the same picture: 6 bits). Where both sides play one grade — inside a clip, or a plain split — a
  // residual-size step is the source's own (a jump cut between takes moves one channel ~2: Morantes 10.1 at 14.7 s)
  const look = (c) => JSON.stringify(grade ? paramsFor(grade, c.src, c.id) : null);
  const fixJoin = (k) => clipOf[k] !== clipOf[k - 1] && look(placed[clipOf[k - 1]].clip) !== look(placed[clipOf[k]].clip);
  const steps = new Map([...gradeScan.lookSteps(L, gradeScan.SOURCE_CHANNELS, {...opts, need: gradeScan.SOURCE_NEED, maxHash: gradeScan.CUT_HASH}), ...gradeScan.lookSteps(L, ch, opts).filter((x) => fixJoin(x.k))].map((x) => [x.k, x]));
  for (const {k, from, to, by} of [...steps.values()].sort((x, y) => x.k - y.k)) {
    const a = placed[clipOf[k - 1]].clip, b = placed[clipOf[k]].clip;
    const head = k - from <= to - k; // the shorter side of the shot is the one in another grade
    const [s0, e0] = head ? [from, k] : [k, to];
    // that part becomes its own clip: split_clip where it starts / ends inside its clip (3 frames from an
    // edge at least, MIN_PIECE_SEC as split_clip wants), then it takes the grade of the rest of the shot (create_lut match: a head
    // its continuation's, a tail the shot's before it — a, which keeps its id through the split)
    const odd = placed[clipOf[head ? k - 1 : k]], at = (f) => Math.round((f / fps) * 1000) / 1000;
    const splits = [e0, s0].filter((f) => f - odd.fromFrame >= MIN_PIECE_SEC * fps && odd.fromFrame + odd.durFrames - f >= MIN_PIECE_SEC * fps); // the later first: a split moves what follows it by up to a frame (validate's halfGradedIssues)
    const piece = splits.includes(s0) ? `<the piece from ${at(s0)} s>` : odd.clip.id; // a split keeps the first piece's id
    const fix = [...splits.map((f) => ({tool: 'split_clip', args: {at_sec: at(f)}})), head
      ? {tool: 'create_lut', note: 'the head takes the grade of the clip continuing it', args: {clip_id: piece, ...(a === b ? {} : {to_clip_id: b.id}), match: true, name: `${a.id}-match`.slice(0, 40)}}
      : {tool: 'create_lut', note: 'the tail takes the grade of the shot it ends', args: {clip_id: piece, to_clip_id: a.id, match: true, name: `${odd.clip.id}-tail-match`.slice(0, 40)}}];
    const moves = Object.entries(by).map(([c, m]) => `${c} ${m > 0 ? '+' : ''}${m}`).join(', ');
    findings.push(F('grade-coverage', 'blocker', 'heuristic', s0 / fps, e0 / fps, `el color cambia dentro del plano en ${tc(k / fps)} (${a === b ? a.id : `${a.id} → ${b.id}`}): ${moves} — ${e0 - s0} cuadro(s) de ${head ? 'cabeza' : 'cola'} en otro grade`, {clip: (head ? a : b).id, frames: [from, k, to], by, lookAt: [r2((k - 1) / fps), r2(k / fps)]}, fix));
  }
  const bare = placed.filter((pc) => !okA.slice(pc.fromFrame, pc.fromFrame + pc.durFrames).some(Boolean)).map((pc) => pc.clip.id);
  return {findings, skipped: bare.length ? [`grade-coverage: ${bare.join(', ')} — every frame under B-roll, a graphic, a caption page or a transition: not measured`] : []};
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
export function blackFlashFindings(runs, {fps = FPS, duration, fades = {}, placed = [], brolls = [], video = null, qcBlack = []} = {}) {
  const out = [];
  const frame = 1 / fps, margin = 1.5 * frame;
  for (const r0 of runs) {
    const r = {start: r0.start, end: r0.end ?? duration};
    const len = r.end - r.start;
    if (!(len > 0)) continue;
    const frames = Math.max(1, Math.round(len * fps));
    const at = `${r.start.toFixed(2)}–${r.end.toFixed(2)} s`;
    if (fades.startSec && r.start <= margin && r.end <= fades.startSec + margin) { out.push(F('black-flash', 'nit', 'rule', r.start, r.end, `fundido desde negro al inicio (${frames} frames, ${at}) — permitido por el perfil`, {frames}, [])); continue; }
    if (fades.endSec && duration != null && r.end >= duration - margin && r.start >= duration - fades.endSec - margin) { out.push(F('black-flash', 'nit', 'rule', r.start, r.end, `fundido a negro al final (${frames} frames, ${at}) — permitido por el perfil`, {frames}, [])); continue; }
    if (len >= T.blackLongSec) {
      // a long run is the QC gate's `black` — but only if the gate saw it: it measures at 8 % luma, the
      // judge at 10 %, so a dirty black (8–10 %) would fall between the two. Report those here.
      if (qcBlack.some((b) => b.start < r.end && b.end > r.start)) continue;
      out.push(F('black', r.start < margin ? 'blocker' : 'major', 'rule', r.start, r.end, `negro de ${len.toFixed(2)} s (${r.start.toFixed(2)}–${r.end.toFixed(2)} s) que el QC gate no reporta — un negro sucio (gris muy oscuro, bajo el 10 % de luma)`, {lookAt: [r2(r.start + len / 2)]}, [{tool: 'frame_at', note: 'look at it; black footage must be covered (suggest_broll) or trimmed — never automatically', args: {at_sec: r2(r.start + len / 2), ...(video ? {video} : {})}}]));
      continue;
    }
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

// ---------- captions over a face, as rendered ----------
// YuNet (scripts/face-scan.mjs, 2 frames a second, niced, cached by the file's path + size + mtime under
// .captions-tmp/judge/faces/) on the CLEAN master — the pair's (--role captioned --pair) or the version's
// _master.mp4 next to its snapshot — where no caption hides a face; each page as the render lays it out (the pack's
// band, around the graphics: src/layers.ts, src/faces.ts captionHits) against the faces seen while it is up. One
// finding per page, at its worst moment. No clean master: the captioned render itself, said in skipped (a face the
// captions hide may not be seen); no venv or model: skipped, never a crash.
export async function captionFaceFindings({p, rate, file, role, pair, snapshot, publicDir, skipped}) {
  if (!canScanFaces()) { skipped.push('caption-face: no YuNet here (.venv / .models/yunet.onnx) — captions over a face not checked on the render'); return []; }
  const near = snapshot && fs.existsSync(path.dirname(snapshot)) ? fs.readdirSync(path.dirname(snapshot)).filter((f) => f.endsWith('_master.mp4')).map((f) => path.join(path.dirname(snapshot), f))[0] : null;
  const master = (role === 'captioned' && pair && fs.existsSync(pair) ? pair : null) ?? near;
  if (!master) skipped.push('caption-face: no clean master (--role captioned --pair <…_master.mp4>) — looked at the captioned render, where a face the captions hide may not be seen');
  const seen = master ?? file;
  let scan;
  try { scan = await scanFaces(publicDir, seen, {out: path.join(ROOT, '.captions-tmp', 'judge', 'faces', `${path.basename(seen).replace(/[^\w.-]+/g, '_')}.json`), cuts: false}); } catch (e) { skipped.push(`caption-face: ${String(e?.message ?? e).slice(0, 160)}`); return []; }
  const pages = captionLayout(p, rate).shownCaptions;
  const facesAt = (ms) => facesIn(scan, ms / 1000).map((f) => ({left: f.left * 100, top: f.top * 100, right: f.right * 100, bottom: f.bottom * 100}));
  const worst = new Map();
  for (const h of captionHits(pages, p.captionStyle, facesAt)) if (!(worst.get(h.i)?.area >= h.area)) worst.set(h.i, h);
  const pc = (x) => Math.round(x);
  return [...worst.values()].map((h) => {
    const c = pages[h.i], at = r2(h.ms / 1000);
    return F('caption-face', 'major', 'rule', r2(c.startMs / 1000), r2(c.endMs / 1000), `la página ${c.id} ("${c.words.map((w) => w.text).join(' ').slice(0, 40)}") tapa una cara a los ${at} s: cara ${pc(h.face.top)}–${pc(h.face.bottom)} %, subtítulos ${pc(h.top)}–${pc(h.bottom)} % de la altura (visto en ${master ? 'el master limpio' : 'el render con subtítulos'})`,
      {page: c.id, face: h.face, band: {top: h.top, bottom: h.bottom, left: h.x[0], right: h.x[1]}, lookAt: at, frames: path.basename(seen)},
      [{tool: 'validate', note: 'caption-face names the take and the fix: raise face_shift (set_captions), fewer lines, a smaller size, a B-roll over the face, or a position by hand (edit_caption top_pct)', args: {}}]);
  });
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
    for (const h of hits) out.push(F('source-cut', 'minor', 'candidate', toTl(h.t), h.end != null ? toTl(h.end) : null, `${h.why} DENTRO ${r.kind === 'broll' ? 'del B-roll' : 'de la toma'} ${r.id} (fuente ${sourceOf(r.src)} @${h.t.toFixed(2)} s): se ve como un corte que el plan no tiene`, {[r.kind === 'broll' ? 'broll' : 'clip']: r.id, sourceSec: r2(h.t), lookAt: [r2(toTl(h.t) - 0.2), r2(toTl(h.t) + 0.1)]},
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

// verdict: 0 blockers and 0 majors; 3+ minors of one check count as a major (a pattern, not a nit).
// Candidates count only once the judge confirms them on the frame (`confirmed`).
// The label never says "aprobado": only the client approves.
// Advisory checks go to the client for a decision and NEVER count toward the verdict — not when the
// judge confirms them, not as a pattern of minors. source-cut: César's rule, a whip / blur inside a
// source clip never auto-fails. validate-guion-conflict: the audio and the client's script say different
// things (70 vs 60 invitados) — the audio stays on screen (César: the audio wins on content) and the
// client confirms; the judge never fails a reel for it. color-jump: two shots may look different on
// purpose (CEO-15); a look that breaks INSIDE a shot is grade-coverage, which blocks. data-from-audio: a
// figure or name the reel's audio does not say goes to the client to confirm (datosPorConfirmar of the version,
// CEO-21) — the brief or the client may have given it; it never blocks (a warning in validate, filed under the
// broll stage). Matched by check name, so a finding written by hand is covered too.
export const ADVISORY = new Set(['source-cut', 'validate-guion-conflict', 'color-jump', 'data-from-audio']);
export const isAdvisory = (f) => !!f.advisory || ADVISORY.has(f.check);
export const counts = (f) => !f.dismissed && !isAdvisory(f) && (f.kind !== 'candidate' || f.confirmed);
export function verdictOf(findings, {reduced = false} = {}) {
  const live = findings.filter(counts);
  const n = Object.fromEntries(SEVERITIES.map((s) => [s, live.filter((f) => f.severity === s).length]));
  const byCheck = {};
  for (const f of live) if (f.severity === 'minor') byCheck[f.check] = (byCheck[f.check] ?? 0) + 1;
  const patterns = Object.entries(byCheck).filter(([, k]) => k >= 3).map(([c]) => c);
  const pass = n.blocker === 0 && n.major === 0 && patterns.length === 0;
  const toConfirm = findings.filter((f) => !f.dismissed && f.kind === 'candidate' && !f.confirmed && !isAdvisory(f)).length;
  const advisories = findings.filter((f) => !f.dismissed && isAdvisory(f)).length;
  const label = pass ? `QC técnico superado${reduced ? ' (evidencia reducida)' : ''}` : `QC técnico: ${n.blocker + n.major + patterns.length} hallazgo(s) que corregir (${n.blocker} bloqueantes, ${n.major} mayores${patterns.length ? `, ${patterns.length} patrones` : ''})`;
  return {verdict: pass ? 'PASS' : 'FAIL', label, counts: n, patterns, toConfirm, advisories};
}

// What a review version keeps of a pass (scripts/reviews.mjs judgeVersion, CEO-6): its label — 'superado', 'superado
// (evidencia reducida)' when checks were skipped (the report's `skipped`: not checked, so not passed), or
// '<n> hallazgo(s)', n = what the verdict counts (blockers + majors + minor patterns) — the findings that count
// (compact: the full report stays in its folder, `report`) and the profile it ran with. Never 'aprobado'.
export function versionSummary(r) {
  const n = r.counts.blocker + r.counts.major + r.patterns.length;
  return {label: r.verdict === 'PASS' ? `superado${r.skipped?.length ? ' (evidencia reducida)' : ''}` : `${n} hallazgo${n === 1 ? '' : 's'}`, findings: r.findings.filter(counts).map(({check, severity, at, end, msg}) => ({check, severity, at, end, msg})), profile: r.profile};
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
  return {id: `${check}@${at == null ? '-' : at.toFixed(1)}`, check, severity, kind, ...(ADVISORY.has(check) ? {advisory: true} : {}), at: at == null ? null : r2(at), end: end == null ? null : r2(end), msg, ref, evidence, fix: fix.map((x) => (ID_CHANGERS.has(x.tool) ? {...x, changesIds: true} : x))};
}

// ---------- evidence from the mp4 ----------
function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt,color_range,sample_rate,channels,duration:format=duration,bit_rate', '-of', 'json', file], {encoding: 'utf8'});
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
// the file's fps: a run as short as ONE frame is caught, d = half a frame), and every frame's look
// (looks: scripts/grade-scan.mjs frameLooks — grade-coverage — from the full frames, read in the file's own range and
// put on the limited scale: the source scan's numbers on any ffmpeg, a full-range render's included)
export function analyzeVideo(file, {rate = 2, hashes = true, scenes = false, blackFps = null, looks = false} = {}) {
  const dir = tmpDir();
  const stats = path.join(dir, 'stats.txt'), cuts = path.join(dir, 'scene.txt'), black = path.join(dir, 'black.txt'), lk = path.join(dir, 'looks.raw');
  try {
    // scene cuts, black frames and looks need every frame; the stats and hashes only `rate` per second — thin out first
    const full = [scenes && `[sc]select='gt(scene,0.35)',metadata=print:file=${fesc(cuts)},nullsink`, blackFps && `[bk]blackdetect=d=${(0.5 / blackFps).toFixed(4)}:pix_th=${BLACK.pix}:pic_th=${BLACK.pic},metadata=print:file=${fesc(black)},nullsink`].filter(Boolean);
    const labels = [scenes && '[sc]', blackFps && '[bk]'].filter(Boolean).join('');
    const src = looks ? '[in]' : '[0:v]', range = looks ? gradeScan.rangeOf(probe(file)?.streams?.find((s) => s.codec_type === 'video')) : 'tv';
    const g = [...(looks ? [`[0:v]split=2[lk][in]`, `[lk]${gradeScan.looksVf(range)}[looks]`] : []), ...(full.length
      ? [`${src}scale=160:-2,split=${full.length + 1}${labels}[v0]`, ...full, `[v0]fps=${rate},split=2[st][h]`]
      : [`${src}fps=${rate},scale=270:-2,split=2[st][h]`])]
      .concat([`[st]signalstats,metadata=print:file=${fesc(stats)},nullsink`, '[h]scale=9:8:flags=area,format=gray[out]']).join(';');
    const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', ...LIMIT(), '-i', file, '-an', '-filter_complex', g, '-map', '[out]', '-f', 'rawvideo', '-', ...(looks ? ['-map', '[looks]', '-fps_mode', 'passthrough', '-f', 'rawvideo', lk] : [])], {maxBuffer: 1 << 28, timeout: TIMEOUT(), killSignal: 'SIGKILL'});
    const frames = readMeta(stats, /lavfi\.signalstats\.(YAVG|YHIGH|YLOW|UAVG|VAVG|SATAVG)=([\d.]+)/);
    const buf = r.stdout ?? Buffer.alloc(0);
    const hs = [];
    if (hashes) for (let i = 0, k = 0; i + 72 <= buf.length; i += 72, k++) hs.push({t: frames[k]?.t ?? k / rate, h: dhash(buf.subarray(i, i + 72))});
    let fl = [];
    if (looks) try { fl = gradeScan.frameLooks(fs.readFileSync(lk), range); } catch {}
    return {timedOut: timedOut(r), stats: frames, hashes: hs, looks: fl, cuts: scenes ? readMeta(cuts, /^$/).map((x) => x.t).filter((t) => t > 0.05) : [], black: blackFps ? blackRuns(readMeta(black, /lavfi\.(black_start|black_end)=([\d.]+)/)) : []};
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}
// signalstats of the first `n` frames (frame 0 is the thumbnail): a decode of n frames, nothing more
export function firstFrames(file, n = 2) {
  const dir = tmpDir(), meta = path.join(dir, 'f0.txt');
  try {
    spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', ...LIMIT(), '-i', file, '-an', '-vf', `select='lt(n\\,${n})',signalstats,metadata=print:file=${fesc(meta)}`, '-frames:v', String(n), '-f', 'null', '-'], {timeout: TIMEOUT(), killSignal: 'SIGKILL'});
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
    const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', ...LIMIT(), '-i', file, '-vn', '-filter_complex', g, '-map', '[out]', '-f', 'null', '-'], {encoding: 'utf8', maxBuffer: 1 << 28, timeout: TIMEOUT(), killSignal: 'SIGKILL'});
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
    return {timedOut: timedOut(r), M, bands: phone, peaks: {peakDb: num(/Peak level dB:\s*(-?[\d.]+|-inf)/), peakCount: num(/Peak count:\s*([\d.]+)/), flat: num(/Flat factor:\s*([\d.]+)/)}};
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}
// scdet over the used ranges of the source files, incremental: per file (path + size + mtime) the
// cache keeps the ranges already decoded and their per-frame scores; a run decodes only what is
// new (an edit that moves a cut decodes a few seconds, not the take). One decoder thread
// (REEL_JUDGE_THREADS) and the judge's own nice (REEL_JUDGE_NICE) keep the shared VM rendering.
const SRC_CACHE = path.join(ROOT, '.captions-tmp', 'judge', 'source-scan.json');
export function scanSources(ranges, publicDir, skipped) {
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
        const run = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', ...LIMIT(), '-ss', a.toFixed(3), '-t', (b - a).toFixed(3), '-copyts', '-i', file, '-an', '-vf', `scale=160:-2,scdet=threshold=0,metadata=print:file=${fesc(meta)}`, '-f', 'null', '-'], {timeout: TIMEOUT(), killSignal: 'SIGKILL'});
        if (timedOut(run)) { skipped.push(`source-cut: ${src} ${a.toFixed(1)}–${b.toFixed(1)} s did not finish in ${Math.round(TIMEOUT() / 1000)} s (corrupt file?) — not scanned`); continue; } // not cached: tried again next run
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
// every ffmpeg the judge starts decodes and filters on THREADS: it runs beside the next render (the QC gate's too)
const LIMIT = () => threadArgs(THREADS());
const LATE = () => ({timeout: TIMEOUT(), killSignal: 'SIGKILL'});
// every ffmpeg the judge starts has a deadline (a corrupt file must not hang it; the catalog's 10 min)
const TIMEOUT = () => Number(process.env.REEL_JUDGE_TIMEOUT_MS || 600000);
const timedOut = (r) => !!(r.error?.code === 'ETIMEDOUT' || r.signal);
const MEDIA = /\.(mp4|mov|m4v|mkv|webm|jpe?g|png|webp|tiff?)$/i;
function refFiles(paths, base = ROOT) {
  const out = [], missing = [];
  for (const rel of paths) {
    const f = path.isAbsolute(rel) ? rel : path.join(base, rel);
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
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...LIMIT(), '-i', file, '-an', '-filter_complex', graph, ...outs], LATE());
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
      const base = ['-v', 'error', '-y', ...LIMIT(), ...(MEDIA.test(f0) && !/\.(jpe?g|png|webp|tiff?)$/i.test(f0) ? ['-ss', String(t)] : []), '-i', f0, '-frames:v', '1'];
      const pad = `scale=${width}:${Math.round(width * 16 / 9)}:force_original_aspect_ratio=decrease,pad=${width}:${Math.round(width * 16 / 9)}:(ow-iw)/2:(oh-ih)/2`;
      const lab = `${pad},pad=iw:ih+26:0:0:color=0xFFE500,drawtext=text='${String(label).replace(/[\\':,;[\]=]/g, (c) => `\\${c}`).slice(0, 40)}':fontcolor=black:fontsize=18:x=6:y=h-22`;
      if (spawnSync('ffmpeg', [...base, '-vf', lab, '-q:v', '4', f], LATE()).status !== 0) spawnSync('ffmpeg', [...base, '-vf', pad, '-q:v', '4', f], LATE());
    });
    const rows = Math.ceil(items.length / cols);
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...LIMIT(), '-framerate', '1', '-i', path.join(dir, '%02d.jpg'), '-vf', `tile=${cols}x${rows}:padding=4:color=0x303030`, '-frames:v', '1', '-q:v', '4', out], LATE());
    return r.status === 0 ? out : null;
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

// ---------- the pass ----------
// role: master = the clean master (no captions on screen), captioned = the version with
// captions, extra = an alternate version (must live in its own project: duplicate_project).
// The project is read NOW: run this right after the render, before editing again — or name the props
// the render was made from (`snapshot`: a review version's v<n>/project.json), which win over the
// project's (a version judged again after the project moved on is judged as it was rendered).
// env: which transcript engine's caches are read (scripts/transcript-cache.mjs) — ROOT's .env + the process env.
export async function judge({projectId, render, publicDir = path.join(ROOT, 'public'), outDir, prev, sheets = true, role = null, pair = null, profile: profileName = null, stateDir = null, sourceScan = true, snapshot = null, clean = null, env = rootEnv()}) {
  const findings = [];
  const skipped = [];
  const p = JSON.parse(fs.readFileSync(path.join(publicDir, 'projects', `${projectId}.json`), 'utf8'));
  if (snapshot) Object.assign(p, JSON.parse(fs.readFileSync(snapshot, 'utf8')));
  // the rate it renders at: the snapshot's props say it (renderFps); the project decides it otherwise (deliveryFps)
  const rate = snapshot ? renderFps(p) : deliveryFps(p);
  p.clips ??= []; p.captions = (p.captions ?? []).map(normalizeCaption); p.brolls ??= []; p.graphics ??= []; p.mattes ??= []; p.captionStyle ??= 'palabra';
  if (role === 'master') p.captionsOff = true; // what is on screen in this render, whatever the project says now
  if (role === 'captioned') p.captionsOff = false;
  const profile = pickProfile(p, profileName, listProfiles(publicDir));
  Object.assign(T, DEFAULT_T, profile?.thresholds ?? {});
  const glossary = [...(profile?.glossary ?? []), ...(p.brand?.glossary ?? [])]; // the profile's and the project's brand kit's
  // what caption-text and data-from-audio ALLOW as the client's spelling: a project with no kit glossary (César's G1 /
  // G2 predate the kit) also reads the kit that names this profile (style.judgeProfile), so a name the ASR spells
  // otherwise is never "corrected" back to the ASR's spelling.
  // ponytail: only as allowed, not as required (glossary / consistency keep the project's own) — a kit-less project
  // is not failed on the kit's terms; copy them into the profile (design §4: the glossary's home) to require them
  const spellings = p.brand?.glossary?.length ? glossary : [...glossary, ...(kitOf(publicDir, profile?.id)?.glossary ?? [])];
  const reel = reelOf(profile, p.name);
  const resolve = (f) => (path.isAbsolute(f) ? f : fs.existsSync(f) ? path.resolve(f) : path.join(publicDir, f.replace(/^\//, '')));
  const file = resolve(render);
  if (!fs.existsSync(file)) throw new Error(`render not found: ${file}`);
  const draft = /-draft\.mp4$/.test(file);
  const placed = placeClips(p.clips, rate);
  const total = (placed.at(-1)?.endMs ?? 0) / 1000;

  // transcript: this project's words, from its sources' caches — a clip whose source was never transcribed is missing
  const tr = projectTranscript(p, publicDir, env).filter((t) => !t.missing);
  const {words, missing} = timelineSpeech(p.clips, tr, rate);
  const haveTr = missing.length === 0 && p.clips.length > 0;
  if (!haveTr) findings.push(F('evidence', 'blocker', 'rule', null, null, `sin transcript para ${missing.length} clip(s) del proyecto: los checks de pausas, sync, cobertura y repeticiones no corrieron`, {missing: missing.slice(0, 6)}, [{tool: 'get_transcript', note: 'then run the judge again', args: {project_id: projectId}}]));

  // --- versions: an extra is its own project, never the master's ---
  if (role === 'extra' && stateDir && fs.existsSync(path.join(stateDir, 'master.json'))) findings.push(F('version', 'major', 'rule', null, null, `versión EXTRA renderizada desde el proyecto del master (${projectId}): el master base cambia con ella`, {}, [{tool: 'duplicate_project', note: 'name it "<reel> — EXTRA n (<what changes>)", redo the extra there, keep the master project as delivered', args: {project_id: projectId}}]));
  if ((role === 'master' || role === 'captioned') && /\bextra\b/i.test(p.name ?? '')) findings.push(F('version', 'major', 'rule', null, null, `el proyecto "${p.name}" es una versión EXTRA, no el master base`, {}, []));

  // --- tech + QC gate (scripts/qc.mjs) ---
  const info = probe(file);
  const v = info?.streams.find((s) => s.codec_type === 'video');
  const a = info?.streams.find((s) => s.codec_type === 'audio');
  const q = timed('qc gate', () => qc(file, {expectSec: total, draft, threads: THREADS()}));
  const qcBlack = []; // the black stretches the QC gate reported (pix_th 0.08): the judge's long runs defer to these only
  for (const c of q.checks) {
    if (c.ok) continue;
    if (c.name === 'silence') { findings.push(F('audio-silence', 'major', 'rule', null, null, `silencio en el render: ${c.value}`, {qc: c.value}, [{tool: 'run_ai_step', args: {step: 'autocut'}}])); continue; }
    if (c.name === 'black') { for (const m of String(c.value).matchAll(/([\d.]+)–([\d.]+) s/g)) qcBlack.push({start: +m[1], end: +m[2]}), findings.push(F('black', +m[1] < 0.1 ? 'blocker' : 'major', 'heuristic', +m[1], +m[2], `negro en pantalla ${m[1]}–${m[2]} s${+m[1] < 0.1 ? ' (el primer frame / miniatura es negro)' : ''}`, {}, [{tool: 'suggest_broll', note: 'black footage must be covered', args: {}}])); continue; }
    const sev = c.blocking ? 'blocker' : draft && /loudness|true peak/.test(c.name) ? 'nit' : 'minor';
    findings.push(F(`tech-${c.name.replace(/\s+/g, '-')}`, sev, 'rule', null, null, `${c.name}: ${c.value} (want ${c.want})${sev === 'nit' ? ' — draft sin normalizar; el final lo normaliza' : ''}${c.name === 'duration' ? ' — ¿el proyecto cambió después del render?' : ''}`, {}, c.name === 'duration' ? [{tool: 'render', args: {draft}}] : []));
  }
  const fps = v?.r_frame_rate ? v.r_frame_rate.split('/').reduce((n, d) => n / +d) : null; // "30/1"
  // the VIDEO stream's length: AAC padding makes the container 20–40 ms longer, which would push an allowed tail fade out of its margin
  const videoDur = +v?.duration || +info?.format?.duration || total;
  if (fps && Math.abs(fps - rate) > 0.5) findings.push(F('tech-fps', 'major', 'rule', null, null, `${fps.toFixed(2)} fps (want ${r2(rate)})`, {}, []));

  // --- audio ---
  let audio = null;
  let M = [];
  let audioBands = [];
  if (a) {
    const au = timed('audio', () => analyzeAudio(file, {bands: haveTr && (!!(parsePhone(p.plan) ?? reel?.phone) || profile?.detectPhone !== false)}));
    const pk = au.peaks;
    if (au.timedOut) skipped.push(`audio analysis did not finish in ${Math.round(TIMEOUT() / 1000)} s — its checks are partial`);
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
    findings.push(...pauseFindings(words, p.clips, emphasized, rate), ...repeatFindings(words));
    const first = words.find((w) => !w.off);
    if (first && first.t0 * 1000 > T.deadStartMs) {
      const fix = first.clipIndex === 0 ? [{tool: 'trim_clip', args: {clip_id: first.clipId, in_sec: r2(Math.max(0, first.srcStartMs / 1000 - 0.1))}}] : [{tool: 'delete_clips', note: 'clips before the first word carry no speech', args: {clip_ids: placed.slice(0, first.clipIndex).map((x) => x.clip.id)}}];
      findings.push(F('hook-dead-start', 'major', 'rule', 0, first.t0, `la primera palabra llega a los ${first.t0.toFixed(2)} s — el reel arranca muerto`, {wid: first.wid}, fix));
    }
    for (const i of transcriptIssues(p, tr, spellings)) { // a name the client spells otherwise is still said
      if (i.code === 'off-mic' || i.code === 'data-from-audio') continue; // classified below
      const pc = placed.find((x) => x.clip.id === i.ref);
      // script-coverage (no captions to check the guion on): a line may be cut on purpose — confirm against the brief
      const cov = i.code === 'script-coverage';
      findings.push(F(i.code, 'major', cov ? 'candidate' : 'rule', pc ? pc.startMs / 1000 : null, pc ? pc.endMs / 1000 : null, i.msg, {clip: i.ref},
        [cov ? {tool: 'get_transcript', note: 'the take that says the line (a retake cut away?) — or the brief drops it', args: {project_id: projectId}} : {tool: 'cut_words', note: 'or the trim_clip value in the message', args: {}}]));
    }
    // CEO-21: a figure or name on screen this reel's audio does not say — an advisory: it goes to the client as
    // datosPorConfirmar (the agent never decides a figure), never fails the verdict; a capitalized word taken for
    // a name is a candidate (is it one? on the frame), figures and glossary names are rule
    for (const d of unbackedData(p, tr, spellings)) {
      const g = projectGraphics(p.graphics ?? [], p.clips, rate).find((x) => x.id === d.ref);
      findings.push(F('data-from-audio', 'major', d.guess ? 'candidate' : 'rule', g ? g.startMs / 1000 : null, g ? g.endMs / 1000 : null, dataIssue(d).msg, {graphic: d.ref, dato: d.dato}, [{tool: 'edit_graphic', note: 'what the audio says; or the client confirms it (datosPorConfirmar)', args: {graphic_id: d.ref}}]));
    }
    if (p.offMic !== 'off') findings.push(...offMicFindings(words, profile?.crewWords ?? []));
    const expect = parsePhone(p.plan) ?? (reel?.phone ? parsePhone(`PHONE: ${reel.phone}`) : null);
    if (a && (expect || profile?.detectPhone !== false)) {
      const bands = audioBands;
      if (bands.length) findings.push(...phoneFindings(sentencesOf(words), bands, expect));
      else skipped.push('phone filter: could not measure the voice bands');
    }
  } else skipped.push('pauses, repeats, dead start, off-mic / crew talk, cut-in-word, phone filter (no transcript for this project)');

  // --- captions ---
  const pages = p.captionsOff ? [] : projectCaptions(p.captions, p.clips, rate);
  const gfx = projectGraphics(p.graphics, p.clips, rate);
  if (p.captionsOff) skipped.push(role === 'master' ? 'captions (clean master: none on screen by design)' : 'captions (switched off with set_captions — check the brief wants that)');
  else {
    // the pack's font file, as the renderer reads it (src/projectFont.ts): pages are sized by its real widths
    const custom = presetOf(p.captionStyle).font.custom;
    if (custom) try { realAdvances(custom.family, readFont(fs.readFileSync(path.join(publicDir, custom.file))).advance); } catch {} // missing or another face: the render stopped on it (validate: font-missing / font-wrong)
    const rawWord = new Map(words.map((w) => [w.wid, w.word]));
    const rawOf = (w) => (w.wid && rawWord.get(w.wid)) || w.text; // the transcript keeps the periods captions drop
    const namesMaySplit = !!profile?.captions?.namesMaySplit; // the client's look splits names across lines and pages (César v11)
    findings.push(...splitNameFindings(pages, glossary, p.captionStyle, rawOf, namesMaySplit), ...overflowFindings(pages, p.captionStyle, p.brand?.fonts?.body, glossary).filter((f) => !(namesMaySplit && f.check === 'split-name' && f.kind === 'candidate')));
    if (haveTr) findings.push(...captionTextFindings(pages, words, new Set(p.hiddenWids ?? []), spellings));
    if (profile?.captions?.pagination === 'sentence') findings.push(...paginationFindings(pages, p.captionStyle, rawOf));
    const offPack = packFindings(p.captionStyle, profile, p.brand?.style?.pack);
    findings.push(...offPack);
    if (profile?.captions?.accentScale && !offPack.length) findings.push(...accentScaleFindings(p.captionStyle, profile.captions.accentScale));
  }
  if (pages.length) findings.push(...await captionFaceFindings({p, rate, file, role, pair: pair && resolve(pair), snapshot, publicDir, skipped}));
  const texts = [
    ...pages.map((c) => ({text: c.words.map((w) => w.text).join(' '), ref: c.id, at: c.startMs / 1000})),
    ...gfx.map((g) => ({text: Object.values(g.props ?? {}).flatMap((x) => (typeof x === 'string' ? [x] : Array.isArray(x) ? x.map((l) => l?.text ?? '').filter(Boolean) : [])).join(' '), ref: g.id, at: g.startMs / 1000})),
  ];
  findings.push(...consistencyFindings(texts, glossary), ...glossaryFindings(texts, glossary));

  // --- hook: something written in the first second (a clean master has no captions by design) ---
  const firstText = Math.min(...pages.map((c) => c.startMs), ...gfx.filter((g) => g.template !== 'layout').map((g) => g.startMs), Infinity) / 1000;
  if (role !== 'master' && firstText * 1000 > T.firstTextMs && total > 5) findings.push(F('hook-text', 'major', 'rule', 0, Number.isFinite(firstText) ? firstText : null, `nada escrito en pantalla hasta ${Number.isFinite(firstText) ? `${firstText.toFixed(1)} s` : 'el final'} — el hook no se lee sin audio`, {}, [{tool: 'add_graphic', note: 'hook-stack / big-word at the first word (reel-edit step 5)', args: {template: 'hook-stack', at_wid: words[0]?.wid}}]));

  // --- validate (src/validate.ts) — estimated geometry: heuristic ---
  const sevOf = {'caption-face': 'major', matte: 'blocker', timing: 'major', 'overlap-captions': 'major', 'safe-top': 'major', 'safe-bottom': 'major', face: 'major', 'behind-hidden': 'major', 'overlap-graphic': 'major', hook: 'major', glue: 'minor', short: 'minor', long: 'minor', 'overlap-graphics': 'minor', 'tier2-density': 'minor', 'tier1-density': 'minor', 'emoji-density': 'minor', 'guion-timing': 'major', 'guion-missing': 'major', 'guion-conflict': 'major', 'guion-altered': 'minor', 'guion-extra': 'minor', 'fast-words': 'major'};
  const whenOf = (ref) => { const c = pages.find((x) => x.id === ref); if (c) return [c.startMs / 1000, c.endMs / 1000]; const g = gfx.find((x) => x.id === ref); return g ? [g.startMs / 1000, g.endMs / 1000] : [null, null]; };
  for (const i of validateProject(p, rate)) {
    if (i.code === 'hook' && (role === 'master' || findings.some((f) => f.check === 'hook-text'))) continue;
    const [s0, e] = whenOf(i.ref);
    findings.push(F(`validate-${i.code}`, sevOf[i.code] ?? (i.level === 'error' ? 'major' : 'minor'), ['matte', 'timing', 'overlap-captions', 'glue', 'short', 'long', 'guion-timing', 'guion-conflict'].includes(i.code) ? 'rule' : i.code === 'guion-missing' ? 'candidate' : 'heuristic', s0, e, i.msg, {page: i.ref, lookAt: s0 != null ? r2((s0 + e) / 2) : undefined}, []));
  }

  // --- cuts ---
  const shots = shotsOf(placed);
  findings.push(...cutFindings(placed));
  // a long continuous take is a choice more often than a flaw: candidate nit
  const brolls = projectBrolls(p.brolls, p.clips, rate);
  const changes = [0, ...shots.map((x) => x.startMs / 1000), ...brolls.flatMap((b) => [b.startMs / 1000, b.endMs / 1000]), ...gfx.map((g) => g.startMs / 1000), total].sort((x, y) => x - y);
  for (let k = 1; k < changes.length; k++) if (changes[k] - changes[k - 1] > T.staticSec) findings.push(F('static', 'nit', 'candidate', changes[k - 1], changes[k], `toma continua de ${(changes[k] - changes[k - 1]).toFixed(1)} s sin cambio de plano, B-roll ni gráfico — solo si se siente lenta`, {lookAt: r2((changes[k - 1] + changes[k]) / 2)}, [{tool: 'set_transitions', note: 'a punch inside the take, or suggest_broll for a cue', args: {pattern: 'punch-alternate'}}]));

  // --- B-roll: repeats, length, what is said under it, the script's inserts ---
  const video = timed('video', () => analyzeVideo(file, {scenes: !!pair, blackFps: fps ?? rate, looks: true}));
  const hashes = video.hashes;
  findings.push(...strandedFlashes(placeClips(p.clips, fps ?? rate), video.looks));
  // black flashes from one frame, in this file's own frame rate (César: 3–5-frame blacks slipped through)
  if (video.timedOut) skipped.push(`video analysis did not finish in ${Math.round(TIMEOUT() / 1000)} s — its checks are partial`);
  // frame 0 (the thumbnail) black, measured on its own. One black opening, one finding: a single black
  // frame is frame0-black (the renderer's bug), a longer black opening is the black-flash that covers it
  const flashes = blackFlashFindings(video.black, {fps: fps ?? rate, duration: videoDur, fades: profile?.blackFades ?? {}, placed, brolls, video: file, qcBlack});
  const opening = flashes.find((f) => f.at === 0 && f.check === 'black-flash');
  const f0 = frameZeroFindings(firstFrames(file), {fades: profile?.blackFades ?? {}, video: file});
  findings.push(...(opening && opening.evidence.frames > 1 ? [] : f0), ...flashes.filter((f) => !(f0.length && f === opening && f.evidence.frames === 1)));
  // a cut or a whip inside a source clip (candidates): scdet over the used ranges, cached per file
  if (sourceScan) {
    const ranges = usedRanges(p.clips, brolls, rate);
    findings.push(...sourceCutFindings(ranges, timed('source scan', () => scanSources(ranges, publicDir, skipped))));
  } else skipped.push('source-cut (--no-source-scan)');
  findings.push(...repeatedFootageFindings(p.clips, brolls, hashes, rate));
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

  // --- color: per A-roll shot (shotsOf; B-roll spans left out), rendered frames ---
  const stats = video.stats;
  const isBroll = (t) => brolls.some((b) => b.mode !== 'inset' && t >= b.startMs / 1000 && t < b.endMs / 1000);
  const aroll = stats.filter((x) => !isBroll(x.t));
  const clipLooks = shots.map((pc) => {
    const s0 = aroll.filter((x) => x.t >= pc.startMs / 1000 + 0.1 && x.t < pc.endMs / 1000 - 0.1);
    return {pc, n: s0.length, Y: median(s0.map((x) => x.YAVG)), YH: median(s0.map((x) => x.YHIGH)), U: median(s0.map((x) => x.UAVG)), V: median(s0.map((x) => x.VAVG))};
  }).filter((x) => x.n >= 1);
  const src0 = (x) => sourceOf(x.pc.clip.src);
  findings.push(...colorJumpFindings(clipLooks, shots));
  // inside a shot, every frame (the render's own fps): a part of a shot in another grade blocks. On the clean master
  // when there is one (--clean: a version's _master.mp4, a layers render's master): no caption page hides a frame there
  // — on a captioned render the pages cover most of the reel and the check measures next to nothing
  const cleanFile = clean ? resolve(clean) : null;
  if (cleanFile && !fs.existsSync(cleanFile)) skipped.push(`grade-coverage: the clean master ${repoRel(cleanFile)} is not there — measured on the captioned render`);
  const looks = cleanFile && fs.existsSync(cleanFile) ? timed('clean master', () => analyzeVideo(cleanFile, {hashes: false, looks: true})).looks : null;
  if (looks?.length || video.looks.length) {
    const rfps = fps ?? rate;
    const holdMs = presetOf(p.captionStyle).holdMs;
    const shown = p.captionsOff || looks?.length ? [] : projectCaptions(p.captions, p.clips, rfps);
    const spans = [...projectBrolls(p.brolls, p.clips, rfps), ...projectGraphics(p.graphics, p.clips, rfps), ...shown.map((c, i) => ({startMs: c.startMs, endMs: Math.max(c.endMs, shownUntilMs(shown, i, holdMs))}))];
    const gc = gradeCoverageFindings(looks?.length ? looks : video.looks, placeClips(p.clips, rfps), spans, rfps, p.grade);
    findings.push(...gc.findings); skipped.push(...gc.skipped);
  } else skipped.push('grade-coverage: the frames of the render could not be read');
  for (const x of clipLooks) {
    // a bright sky or window trips the 90th percentile as easily as a burnt face: candidate, confirm on the frame
    if (x.YH >= T.burnt) findings.push(F('color-burnt', 'minor', 'candidate', x.pc.startMs / 1000, x.pc.endMs / 1000, `${x.pc.clip.id}: 10% del cuadro en blanco (${x.YH.toFixed(0)}/235) — ¿piel/pared quemada ("quemado") o solo cielo/ventana?`, {clip: x.pc.clip.id, lookAt: r2((x.pc.startMs + x.pc.endMs) / 2000)}, [{tool: 'set_grade', args: {target: src0(x), highlights: 0.8, exposure: -0.3}}]));
    if (x.Y <= T.dark) findings.push(F('color-dark', 'minor', 'heuristic', x.pc.startMs / 1000, x.pc.endMs / 1000, `${x.pc.clip.id}: subexpuesto (luma media ${x.Y.toFixed(0)})`, {clip: x.pc.clip.id, lookAt: r2((x.pc.startMs + x.pc.endMs) / 2000)}, [{tool: 'set_grade', args: {target: src0(x), auto: true}}]));
  }
  // against the client's approved references of this development (profile colorRefs[].development)
  const refSheets = [];
  const renderLook = lookOf(aroll);
  const refs = colorRefGroups(profile, validateIdentity(p.identity).identity?.development);
  skipped.push(...refs.skip);
  for (const g of refs.groups) {
    const {files, missing: gone} = refFiles(g.paths ?? [], profile.base);
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
      const cutTimes = shots.slice(1).map((x) => r2(x.startMs / 1000 + 0.1)).slice(0, 16);
      const [overview, hook, cuts] = sheetsOf(file, [
        {times: Array.from({length: 16}, (_, k) => r2(((k + 0.5) * dur) / 16)), cols: 4, out: path.join(outDir, 'overview.jpg')},
        {times: Array.from({length: 9}, (_, k) => r2(Math.min(dur - 0.05, k * 0.25))), cols: 3, out: path.join(outDir, 'hook.jpg')},
        {times: cutTimes, cols: 4, out: path.join(outDir, 'cuts.jpg')},
      ], fps ?? rate);
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
  // client rules only eyes can check (the profile's .md)
  evidence.profileDoc = profile?.docFile ?? null;
  evidence.tech = {size: v ? `${v.width}x${v.height}` : null, fps, vcodec: v?.codec_name, pix_fmt: v?.pix_fmt, acodec: a?.codec_name, sampleRate: a?.sample_rate, channels: a?.channels, durationSec: r2(+info?.format?.duration), expectedSec: r2(total)};

  const order = (f) => (counts(f) ? 0 : 1e8) + SEVERITIES.indexOf(f.severity) * 1e6 + (f.at ?? -1);
  // a finding about a stage the job did not ask for (project.scope, src/stages.ts) is advisory: reported, never in the verdict
  const scoped = scopeFindings(findings, p.scope);
  const uniq = [...new Map([...scoped.inScope, ...scoped.advisory].map((f) => [`${f.id}|${f.msg}`, f])).values()];
  findings.length = 0; findings.push(...uniq);
  findings.sort((x, y) => order(x) - order(y));
  const diff = diffWithPrev(findings, prev);
  const skips = scopeSkips(skipped, p.scope); // a check of an omitted stage not run is not the job's: never "evidencia reducida"
  return {project: projectId, projectName: p.name ?? null, projectUpdatedAt: p.updatedAt ?? null, fps: rate, snapshot, role, profile: profile?.id ?? null, profileFile: profile?.file ?? null, reel: reel ? Object.keys(profile.reels).find((k) => profile.reels[k] === reel) : null, render: file, pair: pairFile, draft, iteration: (prev?.iteration ?? 0) + 1, at: new Date().toISOString(), durationSec: r2(total), scope: p.scope ?? null, ...verdictOf(findings, {reduced: skips.inScope.length > 0}), findings, diff, skipped: skips.inScope, skippedOmitted: skips.omitted, evidence, plan: p.plan ?? null};
}

// ---------- report ----------
const line = (f) => `[${f.severity.toUpperCase()}] ${f.kind !== 'rule' ? `(${f.kind}) ` : ''}${f.check} @${tc(f.at)}${f.end != null ? `–${tc(f.end)}` : ''}${f.seen > 1 ? ` (seen ${f.seen}×)` : ''} — ${f.msg}`;
export function reportText(r) {
  const L = [];
  L.push(`QC TÉCNICO (reglas): ${r.label}  — iteración ${r.iteration}, ${r.role ?? 'render'} ${r.draft ? 'draft' : 'final'}, ${r.durationSec} s${r.profile ? `, perfil ${r.profile}${r.reel ? ` (${r.reel})` : ''}` : ''}`);
  L.push(`  ${r.counts.blocker} bloqueantes · ${r.counts.major} mayores · ${r.counts.minor} menores · ${r.counts.nit} nits · ${r.toConfirm} por confirmar en frame${r.advisories ? ` · ${r.advisories} aviso(s) que no cuentan` : ''}${r.patterns.length ? ` · patrones (3+ menores = mayor): ${r.patterns.join(', ')}` : ''}`);
  L.push('  Etiqueta para la entrega: la de arriba. Nunca "aprobado": solo el cliente aprueba. El master base se entrega igual; esto acompaña a la entrega.');
  L.push(`render: ${r.render}${r.pair ? `  (vs ${r.pair})` : ''}`);
  L.push(r.profile ? `perfil de cliente: ${r.profile} (${r.profileFile})` : 'perfil de cliente: ninguno — solo la rúbrica genérica (el de un cliente va en public/clients/<cliente>/profile.json)');
  const on = inScope(r.scope), off = STAGES.filter((s) => !on.includes(s)), brollOff = off.includes('broll');
  if (off.length) L.push(`ALCANCE: ${on.join(' → ')} — omitidas: ${off.join(', ')} (set_scope: lo que se encuentre de ellas, por regla o a ojo, es un aviso: nunca cuenta para el veredicto ni la etiqueta, y no se corrige en este trabajo)`);
  if (r.diff) L.push(`vs previous: fixed ${r.diff.fixed.length}, regressions ${r.diff.regressions.length ? r.diff.regressions.join(', ') : 'none'}, stuck (3+ iterations) ${r.diff.stuck.length ? r.diff.stuck.join(', ') : 'none'}`);
  const live = r.findings.filter(counts), cand = r.findings.filter((f) => !counts(f) && !f.dismissed && !isAdvisory(f)), advice = r.findings.filter((f) => !f.dismissed && isAdvisory(f));
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
  if (advice.length) {
    L.push('', 'AVISOS PARA EL CLIENTE (nunca cuentan para el veredicto, ni confirmados: él decide):');
    for (const f of advice) { L.push(`  ${line(f)}${f.confirmed ? ' — confirmado en el frame' : ''}${f.omitted ? ` — fuera del alcance del trabajo (${f.omitted})` : ''}`); for (const x of f.fix) L.push(`  ${fixLine(x, 'if he wants it changed')}`); }
  }
  if (r.skipped.length) L.push('', 'SKIPPED (no evidence — not checked, so not passed):', ...r.skipped.map((s) => `  - ${s}`));
  if (r.skippedOmitted?.length) L.push('', `SKIPPED FUERA DEL ALCANCE (etapas omitidas: ${off.join(', ')} — no reducen la evidencia):`, ...r.skippedOmitted.map((s) => `  - ${s}`));
  L.push('', 'EVIDENCE FOR THE JUDGE (snapshot of the project when the render was judged' + (r.projectUpdatedAt ? `, updatedAt ${r.projectUpdatedAt}` : '') + ')');
  for (const [k, f] of Object.entries(r.evidence.sheets)) if (f) L.push(`  sheet ${k}: ${f}`);
  L.push(`  look at (frame_at video=<render>): ${r.evidence.lookAt.map((t) => `${t}s`).join(', ') || '—'}`);
  L.push(`  tech: ${JSON.stringify(r.evidence.tech)}`, `  audio: ${JSON.stringify(r.evidence.audio)}`);
  if (r.evidence.profileDoc) L.push(`  client rules by eye: ${r.evidence.profileDoc}`);
  if (r.evidence.claims?.length) {
    L.push('', brollOff ? 'PROMESAS DEL VO (AVISO — broll fuera del alcance: claim-image va a AVISOS, nunca cuenta ni se corrige en este trabajo):' : 'PROMESAS DEL VO A VERIFICAR (heuristic — no es regla: el juez mira los frames; claim-image = major con timestamp + la promesa sin ilustrar; nunca auto-fix):');
    for (const c of r.evidence.claims) L.push(`  @${tc(c.t0)}–${tc(c.t1)} "${c.text.slice(0, 90)}"${c.cues.length ? `  [prueba: ${c.cues.join(', ')}]` : ''}  en pantalla: ${c.inserts.join(', ') || 'solo el presentador'}  → frame_at ${c.lookAt.map((t) => `${t}s`).join(', ')}`);
  }
  if (r.evidence.inserts.length) L.push(`  script inserts checked${brollOff ? ' (AVISO — broll fuera del alcance: un inserto faltante no cuenta)' : ''}:`, ...r.evidence.inserts.map((x) => `    ${x}`));
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
  const prevPath = flag('--prev'), outArg = flag('--out'), publicDir = flag('--public'), role = flag('--role') ?? null, pair = flag('--pair') ?? null, profile = flag('--profile') ?? null, snapshot = flag('--snapshot') ?? null, clean = flag('--clean') ?? null;
  const asJson = bool('--json'), summary = bool('--summary'), fresh = bool('--fresh'), noSourceScan = bool('--no-source-scan');
  // the judge runs next to renders on a shared 2-vCPU VM: niced like the asset catalog (ffmpeg inherits it)
  const nice = Number(process.env.REEL_JUDGE_NICE ?? 15);
  try { if (nice > 0) os.setPriority(0, Math.min(19, nice)); } catch {}
  const [projectId, render] = args;
  const usage = 'usage: judge.mjs <project_id> <render.mp4> [--role master|captioned|extra] [--pair other.mp4] [--profile client] [--prev report.json | --fresh] [--out dir] [--json | --summary] [--snapshot project.json] [--clean master.mp4] [--public dir] [--no-source-scan]';
  if (!projectId || !render) { console.error(usage); process.exit(2); }
  if (!/^[\w-]+$/.test(projectId)) { console.error(`bad project id: ${projectId}`); process.exit(2); }
  if (role && !['master', 'captioned', 'extra'].includes(role)) { console.error(usage); process.exit(2); }
  const base = path.join(ROOT, '.captions-tmp', 'judge', projectId);
  const latest = path.join(base, `latest${role ? `-${role}` : ''}.json`); // each version iterates against its own history
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(prevPath ?? latest, 'utf8')); } catch {}
  if (fresh || (!prevPath && prev && Date.now() - Date.parse(prev.at) > 12 * 3600e3)) prev = null; // a new loop, not the next iteration
  const outDir = outArg ?? path.join(base, `${path.basename(render, '.mp4')}-${Date.now()}`);
  let r;
  // a failure says why in ONE line (the render queue keeps stderr's last line: never a stack or Node's version banner)
  try { r = await judge({projectId, render, publicDir: publicDir ?? undefined, outDir, prev, role, pair, profile, stateDir: base, sourceScan: !noSourceScan, snapshot, clean}); } catch (e) { console.error(`judge: ${String(e?.message ?? e).split('\n')[0]}`); process.exit(1); }
  const txt = reportText(r);
  const json = JSON.stringify(r, (k, x) => (typeof x === 'bigint' ? x.toString(16) : x), 2);
  try {
    fs.mkdirSync(outDir, {recursive: true}); fs.mkdirSync(base, {recursive: true});
    fs.writeFileSync(path.join(outDir, 'report.json'), json);
    fs.writeFileSync(path.join(outDir, 'report.md'), txt);
    fs.writeFileSync(latest, json);
    if (role) fs.writeFileSync(path.join(base, `${role}.json`), json);
  } catch (e) { console.error(`(report not saved: ${e.message}; read-only sandbox?)`); }
  console.log(summary ? JSON.stringify({...versionSummary(r), report: repoRel(path.join(outDir, 'report.json'))}) : asJson ? json : `${txt}\n\nreport: ${path.join(outDir, 'report.json')}`);
  process.exit(0);
}
