// The stages of a reel (docs/designs/cesar-etapas-bandeja.md §3, CEO-13): which stage owns each project
// field and each MCP tool, what an edit leaves stale, the rules each stage's gate reads and what the job asks
// for (scope). Pure data and functions: the backend keeps each stage's state with them (scripts/stages.mjs), and
// the MCP wrapper logs or refuses a tool by them (toolGate, project.stagesMode — plan phase 11).
//
//   ingest → corte → guion (the client's script against the ASR, #35: only captions and script coverage
//                    depend on it, so set_guion never reopens the cut, the color or the audio)
//                  → color, audio, captions → broll → entregables (the final render)
import {layerBlockers, supersBlockers} from './layers.ts';
import {validateIdentity, type Issue} from './validate.ts';
import type {Caption} from './captions.ts';
import type {Graphic} from './graphicTemplates.ts';
import type {Clip} from './timeline.ts';

export const STAGES = ['ingest', 'corte', 'guion', 'color', 'audio', 'captions', 'broll', 'entregables'] as const; // in dependency order
export type Stage = (typeof STAGES)[number];

// what each stage reads from the ones before it
export const DEPS: Record<Stage, Stage[]> = {
  ingest: [],
  corte: ['ingest'],
  guion: ['corte'], // script coverage runs over the words the cut keeps
  color: ['corte'],
  audio: ['corte'],
  captions: ['corte', 'guion'],
  broll: ['corte', 'captions'], // B-roll and graphics step around the pages
  entregables: ['color', 'audio', 'captions', 'broll'],
};
const dependsOn = (d: Stage, s: Stage): boolean => DEPS[d].some((x) => x === s || dependsOn(x, s));
export const dependents = (s: Stage): Stage[] => STAGES.filter((d) => dependsOn(d, s));
export const upstream = (s: Stage): Stage[] => STAGES.filter((d) => dependsOn(s, d));

// What the job asks for (Felipe, 2026-09-26: the tool stays open — "solo captions" is a whole job):
// project.scope lists the stages the brief requests. ingest and entregables always run (the footage, the
// delivery) and guion goes with captions (it feeds only them). No scope — every project before it — is all.
// A stage outside it is 'omitida': never red, never a blocking dependency, its gate does not run, and what
// the checks or the render judge find about it is advisory (stageFindings, scopeFindings).
export const SCOPABLE = ['corte', 'color', 'audio', 'captions', 'broll'] as const;
export type Scopable = (typeof SCOPABLE)[number];
const scopable = (s: unknown): s is Scopable => (SCOPABLE as readonly unknown[]).includes(s);
// set_scope and the editor's Stages section: the stages asked → what project.scope stores (null = all) or why not
export function scopeInput(asked: unknown): {scope: Scopable[] | null; error?: string} {
  if (!Array.isArray(asked) || !asked.length) return {scope: null, error: `scope: a list of stages (${SCOPABLE.join(', ')}), at least one`};
  const bad = asked.filter((s) => !scopable(s));
  if (bad.length) return {scope: null, error: `scope: ${bad.join(', ')} is not a stage a job asks for (${SCOPABLE.join(', ')}; ingest and the delivery always run)`};
  const scope = SCOPABLE.filter((s) => asked.includes(s));
  return {scope: scope.length === SCOPABLE.length ? null : scope};
}
// the stages that run for a project's scope, in STAGES order (a hand-edited bad entry is ignored)
export function inScope(scope: unknown): Stage[] {
  const asked: unknown[] = Array.isArray(scope) ? scope.filter(scopable) : [];
  if (!asked.length) return [...STAGES];
  return STAGES.filter((s) => s === 'ingest' || s === 'entregables' || asked.includes(s) || (s === 'guion' && asked.includes('captions')));
}
// a stage that holds back the ones after it: red, stale, or being checked (its result is not in: a check in flight — or
// one a backend restart cut short — never lets a tool through)
export const BLOCKING = ['rojo', 'stale', 'chequeando'];
// the stages upstream of `stage` that hold it back: in scope, and BLOCKING (records: stage → {status})
export const waitingOn = (records: Partial<Record<Stage, {status?: string}>>, scope: unknown, stage: Stage): Stage[] =>
  upstream(stage).filter((d) => inScope(scope).includes(d) && BLOCKING.includes(records[d]?.status ?? ''));

// the stage(s) a changed project field reopens; [] = context, nothing to re-check. A field not listed
// here reopens everything after ingest and is reported (invalidate → unmapped). `clips` goes by what
// changed inside it (CLIP_FIELD_STAGE).
export const FIELD_STAGE: Record<string, Stage[]> = {
  identity: ['ingest'], // the delivery fps changes: every stage after it too
  lang: ['ingest'], // re-transcribes
  offMic: ['corte'],
  hiddenWids: ['corte'],
  guion: ['guion'],
  grade: ['color'],
  audio: ['audio'], // clean, sfx
  music: ['audio'],
  captions: ['captions'],
  captionStyle: ['captions'],
  captionsOff: ['captions'],
  brolls: ['broll'],
  brollAssets: ['broll'],
  graphics: ['broll'],
  mattes: ['broll'],
  accentColor: ['captions', 'broll'],
  brand: ['captions', 'broll', 'color'],
  name: [], plan: [], planMode: [], planModeLog: [], planApproved: [], planReviews: [], createdAt: [], updatedAt: [],
  scope: [], // what the job asks for changes no content: a stage it brings back in shows the state it had
  stagesMode: [], // how the gates are enforced (the backend's, never a body's)
};
// inside a clip (matched by id). A source the project did not have is ingest; a clip added, removed or moved is corte
export const CLIP_FIELD_STAGE: Record<string, Stage[]> = {
  sourceDurationSec: ['ingest'],
  ingest: ['ingest'], // the ingest's note (HDR tone-mapped, reused source)
  id: ['corte'], src: ['corte'], inSec: ['corte'], outSec: ['corte'], speed: ['corte'], enter: ['corte'], jSec: ['corte'], lSec: ['corte'],
  volume: ['audio'], muted: ['audio'],
  transform: ['broll'], // framing: zoom / pan keyframes
  graded: ['color'], location: ['color'], // a head's grade fixed by hand; where the shot is (color-jump compares only within one)
  label: [], srcKey: [], // the reel CLI's key of the file it came from (the Drive import's: drive:<fileId>:<modifiedTime>:<size>)
  take: [], // the Drive import's {script, variant} the user confirmed for the file (server/drive.mjs)
};

// the stage(s) each MCP tool (mcp/server.mjs) works in; [] = reads, searches, libraries, the plan, project
// admin and render jobs. test/stages.test.mjs fails when a tool is added without a row here.
export const TOOL_STAGE: Record<string, Stage[]> = {
  add_clips: ['ingest'], import_drive: ['ingest'], set_language: ['ingest'], set_identity: ['ingest'], get_transcript: ['ingest'],
  reorder_clips: ['corte'], trim_clip: ['corte'], delete_clips: ['corte'], split_clip: ['corte'], cut_words: ['corte'], set_audio_cut: ['corte'],
  set_transitions: ['corte'], set_speed_ramp: ['corte'], set_off_mic: ['corte'], duplicate_project: ['corte'], // variants are made in corte
  set_guion: ['guion'],
  set_grade: ['color'], create_lut: ['color'],
  set_audio: ['audio'], set_music: ['audio'],
  edit_caption: ['captions'], add_caption: ['captions'], delete_captions: ['captions'], set_captions: ['captions'], set_caption_style: ['captions'],
  annotate_captions: ['captions'], caption_proof: ['captions'], motion_proof: ['captions'], // the proofs its gate asks for
  add_broll: ['broll'], edit_broll: ['broll'], delete_brolls: ['broll'], add_graphic: ['broll'], edit_graphic: ['broll'], delete_graphics: ['broll'],
  set_keyframes: ['broll'], prepare_mattes: ['broll'],
  set_clip: ['corte', 'audio', 'color'], // speed; volume, muted; graded, location — by its arguments (callStages)
  set_accent_color: ['captions', 'broll'],
  set_brand: ['captions', 'broll', 'color', 'audio'], // a kit brings its captions, color and audio; its fonts / glossary alone: captions
  run_ai_step: ['corte', 'captions'], // autocut; captions — by its step (callStages)
  render: ['entregables'], start_render: ['entregables'], share_version: ['entregables'],
  list_projects: [], get_project: [], rename_project: [], set_plan: [], approve_plan: [], request_plan_changes: [], set_plan_mode: [], style_kits: [],
  find_cut_candidates: [], search_stock: [], add_broll_assets: [], tag_broll_asset: [], broll_library: [], suggest_broll: [], catalog_assets: [],
  search_catalog: [], search_music: [], search_asset: [], list_assets: [], generate_asset: [], timing_report: [], validate: [], frame_at: [], qc: [],
  render_status: [], list_render_jobs: [], cancel_render: [], list_versions: [], rejudge: [], revoke_review_link: [], health: [], list_drive: [],
  set_scope: [], check_stage: [], stage_status: [], waive_finding: [], // what the job asks for, and the gates themselves
};

// How a project's gates are enforced (CEO-20, D29; plan phase 11): off = nothing is logged nor refused; advisory
// (the default: every project before it) = a tool started while a stage it depends on is red or stale is logged;
// enforce = it is refused. The backend writes enforce on a project's first identity; only the owner's login
// session changes it (scripts/stages.mjs setStagesMode) — no MCP tool, no token.
export const STAGES_MODES = ['off', 'advisory', 'enforce'] as const;
export type StagesMode = (typeof STAGES_MODES)[number];
export const stagesModeOf = (p: {stagesMode?: unknown} | null | undefined): StagesMode =>
  (STAGES_MODES as readonly unknown[]).includes(p?.stagesMode) ? (p!.stagesMode as StagesMode) : 'advisory';
// The stage(s) one call works in: its TOOL_STAGE row, narrowed by the arguments where a tool spans several — the gate
// is about the work the call does: run_ai_step captions is no cut, autocut no captions; set_clip volume is audio work,
// graded color, speed the cut; a set_brand of fonts or glossary only is the captions' own fix (font-missing, font-wrong,
// spelling). A draft render is for looking (like frame_at): none.
const BRAND_CAPTIONS = ['font_files', 'caption_font', 'display_font', 'drop_fonts', 'glossary'];
export function callStages(name: string, a: Record<string, unknown> = {}): Stage[] {
  const given = Object.keys(a).filter((k) => a[k] !== undefined && k !== 'project_id');
  if (name === 'run_ai_step') return a.step === 'autocut' ? ['corte'] : ['captions'];
  if (name === 'set_clip') return STAGES.filter((s) => given.some((f) => row(CLIP_FIELD_STAGE, f)?.includes(s)));
  const kit = given.filter((k) => k !== 'apply_style' && k !== 'clear');
  if (name === 'set_brand' && !a.clear && kit.length && kit.every((k) => BRAND_CAPTIONS.includes(k))) return ['captions'];
  if ((name === 'render' || name === 'start_render') && a.draft) return [];
  return TOOL_STAGE[name] ?? [];
}
const FINAL = new Set(['render', 'start_render']);
// What the MCP wrapper does with a tool call on a project → null (nothing to say) or {mode, stages, deps, refuse?}:
// deps = what holds the call back — the in-scope stages its stages depend on that are BLOCKING (waitingOn: an omitted
// stage never holds anything back; one stage of the call waiting on another of them counts too); for a final render in
// enforce, every in-scope stage before the delivery that is not verde (a stage nobody checked holds it too — advisory
// logs only its red / stale ones, as for any tool: a project that never ran a gate is not a log line); for set_scope, a
// stage it would leave out that is BLOCKING (dropping it would hide a red: that is a blocker's waiver, Felipe's).
// refuse = the message when enforce refuses it. Default-deny, like the plan gate: a tool with no TOOL_STAGE row is
// refused in enforce.
export function toolGate(name: string, p: {stagesMode?: unknown; scope?: unknown}, records: Partial<Record<Stage, {status?: string}>>, args: Record<string, unknown> = {}) {
  const mode = stagesModeOf(p);
  if (mode === 'off') return null;
  if (!Object.hasOwn(TOOL_STAGE, name)) return mode === 'enforce' ? {mode, stages: [] as Stage[], deps: {}, refuse: `${name} refused (stages enforce): it has no stage in src/stages.ts TOOL_STAGE, and a tool without one is refused until it gets its row.`} : null;
  const own = callStages(name, args), on = inScope(p.scope), st = (s: Stage) => records[s]?.status ?? 'pendiente';
  const held = FINAL.has(name) && own.length && mode === 'enforce' ? upstream('entregables').filter((d) => on.includes(d) && st(d) !== 'verde')
    : name === 'set_scope' ? (Array.isArray(args.stages) ? on.filter((d) => !inScope(args.stages).includes(d) && BLOCKING.includes(st(d))) : [])
    : STAGES.filter((d) => own.some((s) => waitingOn(records, p.scope, s).includes(d)));
  if (!held.length) return null;
  const deps = Object.fromEntries(held.map((d) => [d, st(d)])), list = held.map((d) => `${d} (${deps[d]})`).join(', ');
  const red = held.filter((d) => deps[d] === 'rojo');
  const why = name === 'set_scope' ? `it leaves out ${list}: a stage dropped from the job stops holding anything back, so dropping one that is red, stale or being checked is a blocker's waiver — only Felipe does that (his login, the editor's Stages section).`
    : `it works in ${own.join(' + ')}, which waits on ${list}${FINAL.has(name) ? ' — a final render needs every stage it delivers checked green' : ''}.`;
  return {mode, stages: own, deps, ...(mode === 'enforce' ? {refuse: `${name} refused (stages enforce): ${why} ${red.length ? `Fix what ${red.join(', ')} reports, then ` : ''}check_stage ${held[0]}${held.length > 1 ? ` (then ${held.slice(1).join(', ')})` : ''} and call ${name} again; stage_status shows every stage. A warning you keep: waive_finding with the reason; a blocker only Felipe waives.`} : {})};
}

// Waivers (§3 "Reglas de cada gate"): a finding of a stage's check waived with a reason — {rule, ref, msgs, hash?, reason,
// by, level}. A waiver covers the finding it was given for, never a later one that reuses its code and ref (ids are
// reused: graphic g0 deleted and made again): its code, ref AND message (msgs: what the check said then — an edit that
// changes what the finding says brings it back unwaived); one without a ref (proof-missing, layer-blocker, hook…) says
// nothing of where it is, so it holds only while the stage's slice is the one it was found in (hash, scripts/stages.mjs
// sliceHash). It covers a blocker only when it was a blocker's (level 'error': the owner's login, scripts/stages.mjs
// waive); the agent waives warnings. A waived finding stays listed, marked, and never makes its stage red.
export type Waiver = {rule: string; ref?: string; msgs: string[]; hash?: string; reason: string; by: string | null; level: 'error' | 'warn'};
type Found = {code: string; ref?: string; msg?: string; level: string};
export const waiverOf = (waivers: Waiver[] | undefined, f: Found, hash?: string) =>
  (waivers ?? []).find((w) => w.rule === f.code && (w.ref ?? null) === (f.ref ?? null) && (w.msgs ?? []).includes(f.msg ?? '')
    && (f.ref != null || w.hash === hash) && (f.level !== 'error' || w.level === 'error'));
export const withWaivers = <T extends Found>(findings: T[], waivers: Waiver[] | undefined, hash?: string) =>
  findings.map((f) => { const w = waiverOf(waivers, f, hash); return w ? {...f, waived: {reason: w.reason, by: w.by}} : f; });

// the defaults a writer fills into a project that lacks them (mcp/checks.mjs withDefaults / newProject; a test
// holds them together): the same as absent
const DEFAULTS: Record<string, unknown> = {offMic: 'mark', audio: {clean: 'off'}, lang: 'auto', accentColor: '#FFB020', captionStyle: 'palabra'};
// equal for the gates: key order ignored, and absent / null / '' / [] / false / the field's default are one
// "nothing" (a writer that fills a default must not reopen a stage)
export const canon = (v: unknown) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const nothing = (v: unknown, dflt?: unknown) => v == null || v === '' || v === false || (Array.isArray(v) && !v.length) || (dflt !== undefined && canon(v) === canon(dflt));
const same = (a: unknown, b: unknown, dflt?: unknown) => (nothing(a, dflt) && nothing(b, dflt)) || canon(a) === canon(b);
const row = <T>(map: Record<string, T>, k: string) => (Object.hasOwn(map, k) ? map[k] : null);

type Fields = Record<string, any>;
// the fields an edit changes, by that equality — context fields included; none = a save that changes nothing
export const changedFields = (a: Fields, b: Fields): string[] =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !same(a[k], b[k], row(DEFAULTS, k) ?? undefined));
// What an edit leaves stale: the stages owning each changed field and every stage after them, in STAGES
// order; `unmapped` names the changed fields no stage owns (clips.<f> inside a clip) — they stale everything
// after ingest, the safe default, and the backend logs them (UnmappedField)
export function invalidate(prev: Fields | null | undefined, next: Fields | null | undefined): {stale: Stage[]; unmapped: string[]} {
  const a = prev ?? {}, b = next ?? {};
  const owners = new Set<Stage>(), unmapped: string[] = [];
  const own = (stages: Stage[] | null, field: string) => {
    if (!stages) unmapped.push(field);
    for (const s of stages ?? dependents('ingest')) owners.add(s);
  };
  for (const k of changedFields(a, b)) {
    if (k !== 'clips') { own(row(FIELD_STAGE, k), k); continue; }
    const was: Fields[] = Array.isArray(a.clips) ? a.clips : [], now: Fields[] = Array.isArray(b.clips) ? b.clips : [];
    const srcs = new Set(was.map((c) => c.src));
    if (now.some((c) => !srcs.has(c.src))) own(['ingest'], 'clips');
    if (!same(was.map((c) => c.id), now.map((c) => c.id))) own(['corte'], 'clips');
    const before = new Map(was.map((c) => [c.id, c]));
    for (const c of now) {
      const o = before.get(c.id);
      if (o) for (const f of new Set([...Object.keys(o), ...Object.keys(c)])) if (!same(o[f], c[f])) own(row(CLIP_FIELD_STAGE, f), `clips.${f}`);
    }
  }
  const stale = new Set([...owners].flatMap((s) => [s, ...dependents(s)]));
  return {stale: STAGES.filter((s) => stale.has(s)), unmapped: [...new Set(unmapped)]};
}

// What a stage reads of a project: every field whose edit reopens it (the rows above; an unmapped field reopens
// everything after ingest), defaults and "nothing" left out, keys sorted. A proof or a render of the stage is of
// this slice — its hash (scripts/stages.mjs) — so an edit elsewhere leaves it valid and one here does not.
// ponytail: the clips' order counts for ingest too; no ingest proof exists
export function stageSlice(p: Fields | null | undefined, stage: Stage): Fields {
  const reads = (owners: Stage[] | null) => (owners ?? dependents('ingest')).some((o) => o === stage || dependsOn(stage, o));
  const out: Fields = {};
  for (const k of Object.keys(p ?? {}).sort()) {
    const v = p![k];
    if (nothing(v, row(DEFAULTS, k) ?? undefined)) continue;
    if (k === 'clips' && Array.isArray(v)) out.clips = v.map((c: Fields) => Object.fromEntries(Object.keys(c).sort().filter((f) => !nothing(c[f]) && reads(row(CLIP_FIELD_STAGE, f))).map((f) => [f, c[f]])));
    else if (reads(row(FIELD_STAGE, k))) out[k] = v;
  }
  return JSON.parse(canon(out));
}

// The rules each stage's gate reads, by the code of their findings: src/validate.ts (validateProject,
// transcriptIssues), the judge's rules on the words as heard (mcp/checks.mjs stageChecks) and the ones made
// here. entregables reads the judge's findings on the final render. A code in no list lands in entregables.
// A rule that reads the graphics too — where captions land around them (safe-*: avoidGraphics), the pages an
// end-card hides (layer-blocker) — is broll's: the first stage both captions and graphics edits reopen; a job
// without broll hands the ones about the pages to captions (CAPTION_READS below).
// ponytail: J rules and the wind scan only; the other probe (P) rules — durations, LUT copies, clipping, voice
// level — come with their phase (16)
export const RULES: Record<Stage, string[]> = {
  ingest: ['untranscribed', 'identity'],
  corte: ['cut-word', 'off-mic', 'pause', 'cut-tight', 'jcut-gap', 'crew-talk'], // crew-talk: src/cuts.ts isCrewRun, cut_words
  guion: ['script-coverage'], // src/validate.ts transcriptIssues: the guion against the kept words, before captions
  color: ['half-graded', 'half-graded-pending'], // src/validate.ts halfGradedIssues, mcp/checks.mjs (the scan not done yet)
  audio: ['wind'], // src/audio.ts windIssues: set_audio clean wind
  captions: ['font-missing', 'font-wrong', 'glue', 'short', 'long', 'timing', 'overlap-captions', 'fast-words',
    'tier1-density', 'tier2-density', 'emoji-density', 'guion-conflict', 'guion-missing', 'guion-altered', 'guion-extra', 'guion-timing',
    'caption-text'], // the judge's: a page word that is not the word said, edit_caption
  broll: ['safe-top', 'safe-bottom', 'face', 'behind-hidden', 'overlap-graphic', 'overlap-graphics', 'supers-order', 'matte', 'hook', 'layer-blocker', 'supers-blocker',
    'data-from-audio'], // src/validate.ts unbackedData: a graphic's figure / name its audio does not say, edit_graphic
  entregables: [],
};

// The stage whose work each check of the render judge (.agents/skills/render-judge/judge.mjs) is about, for
// the ones not in RULES. They are all read on the final render (entregables' gate); this only says which stage
// a finding belongs to when the job did not ask for it (scopeFindings). test/stages.test.mjs fails when the
// judge gains a check with no row here or in RULES; the QC gate's other tech-* checks are the delivery's too.
export const JUDGE_STAGE: Record<string, Stage> = {
  'read-through': 'corte', repeat: 'corte', 'repeated-footage': 'corte', 'jump-cut': 'corte', 'flash-cut': 'corte',
  'source-cut': 'corte', 'hook-dead-start': 'corte', 'audio-silence': 'corte',
  'grade-coverage': 'color', 'color-jump': 'color', 'color-ref': 'color', 'color-burnt': 'color', 'color-dark': 'color',
  clipping: 'audio', 'voice-level': 'audio', 'music-vs-voice': 'audio', 'phone-filter': 'audio',
  sync: 'captions', coverage: 'captions', pagination: 'captions', overflow: 'captions', 'split-name': 'captions', 'accent-size': 'captions',
  glossary: 'captions', spelling: 'captions', 'reading-speed': 'captions', 'wrong-pack': 'captions',
  'insert-missing': 'broll', 'broll-fit': 'broll', 'broll-hook': 'broll', 'broll-length': 'broll', 'claim-image': 'broll', black: 'broll',
  static: 'broll', 'hook-text': 'broll',
  'black-flash': 'entregables', 'frame0-black': 'entregables', parity: 'entregables', version: 'entregables', evidence: 'entregables',
  'tech-fps': 'entregables', 'tech-audio': 'entregables',
};
// the stage a finding code belongs to: a gate's rule (RULES; the judge's validate-<code> too), else the judge's row, else the delivery
export const findingStage = (code: string): Stage => {
  const c = code.replace(/^validate-/, '');
  return STAGES.find((s) => RULES[s].includes(c)) ?? row(JUDGE_STAGE, code) ?? 'entregables';
};
// broll's rules that read the caption pages too (where a page lands, pages behind the presenter and their matte,
// the caption effects a layer cannot draw): in a job without broll they are the captions' — the pages it asked for
const CAPTION_READS = new Set(['safe-top', 'safe-bottom', 'matte', 'layer-blocker']);
const ownerIn = (s: Stage, code: string, on: Stage[]): Stage =>
  !on.includes(s) && on.includes('captions') && CAPTION_READS.has(code.replace(/^validate-/, '')) ? 'captions' : s;
// The findings (the render judge's {check}, or the gates' {code}) split by the project's scope: one about a
// stage the job did not ask for is advisory — marked `advisory` (judge.mjs isAdvisory: it never counts toward
// the verdict nor the version's QC label) and `omitted: <stage>`. No scope: nothing is advisory.
export function scopeFindings<T extends {check?: string; code?: string}>(findings: T[], scope: unknown): {inScope: T[]; advisory: (T & {advisory: true; omitted: Stage})[]} {
  const on = inScope(scope);
  const out = {inScope: [] as T[], advisory: [] as (T & {advisory: true; omitted: Stage})[]};
  for (const f of findings) {
    const code = f.check ?? f.code ?? '', s = ownerIn(findingStage(code), code, on);
    if (on.includes(s)) out.inScope.push(f);
    else out.advisory.push({...f, advisory: true, omitted: s});
  }
  return out;
}
// the check a note of the judge's `skipped` names: "source-cut: …", "music vs voice: …", "color vs "<ref>": …"
const skipCheck = (note: string) => note.split(/:| \(| —/)[0].trim().toLowerCase().replace(/^color vs .*/, 'color-ref').replace(/\s+/g, '-');
// The judge's skipped checks split the same way: one of a stage the job did not ask for (no references for the color
// of a captions-only job) was never the job's, so it never makes the label "(evidencia reducida)"
export function scopeSkips(notes: string[], scope: unknown): {inScope: string[]; omitted: string[]} {
  const on = inScope(scope), out = {inScope: [] as string[], omitted: [] as string[]};
  for (const n of notes) (on.includes(findingStage(skipCheck(n))) ? out.inScope : out.omitted).push(n);
  return out;
}

export type StageInput = {
  p: {clips: Clip[]; captions?: Caption[]; graphics?: Graphic[]; captionStyle?: string; captionsOff?: boolean; identity?: unknown; scope?: unknown};
  fps: number;
  issues: Issue[]; // validateProject + transcriptIssues + the judge's J rules
  untranscribed?: string[]; // sources with no transcript cache yet
  judged?: Issue[]; // the judge on the final render
};
export type StageIssue = Issue & {omitted?: Stage};
// every finding of the project by stage; a stage with an error is red. A stage outside the project's scope has
// none: what its rules found is handed to the delivery as a warning naming it (advisory, never red)
export function stageFindings({p, fps, issues, untranscribed = [], judged = []}: StageInput): Record<Stage, StageIssue[]> {
  const out = Object.fromEntries(STAGES.map((s) => [s, [] as StageIssue[]])) as Record<Stage, StageIssue[]>;
  const id = validateIdentity(p.identity);
  // a client's deliverables: the captions and the text graphics are layers of their own, or the render fails
  const layers = {clips: p.clips, captions: p.captions, graphics: p.graphics, captionStyle: p.captionStyle, captionsOff: p.captionsOff};
  const on = inScope(p.scope);
  for (const i of [
    ...untranscribed.map((s): Issue => ({level: 'error', code: 'untranscribed', msg: `${s} has no transcript yet — get_transcript`, ref: s})),
    ...(id.error ? [{level: 'error', code: 'identity', msg: id.error} as Issue] : []),
    ...(id.identity ? layerBlockers(layers, fps).map((msg): Issue => ({level: 'error', code: 'layer-blocker', msg})) : []),
    ...(id.identity ? supersBlockers(layers, fps).map((msg): Issue => ({level: 'error', code: 'supers-blocker', msg})) : []),
    ...issues,
  ]) out[ownerIn(STAGES.find((s) => RULES[s].includes(i.code)) ?? 'entregables', i.code, on)].push(i);
  out.entregables.push(...judged);
  for (const s of STAGES.filter((x) => !on.includes(x))) {
    out.entregables.push(...out[s].map((i) => ({...i, level: 'warn' as const, omitted: s})));
    out[s] = [];
  }
  return out;
}
