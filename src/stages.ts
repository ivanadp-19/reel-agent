// The stages of a reel (docs/designs/cesar-etapas-bandeja.md §3, CEO-13): which stage owns each project
// field and each MCP tool, what an edit leaves stale, and the rules each stage's gate reads. Pure data and
// functions — nothing here is enforced yet: the backend and the MCP wire it in (plan phases 10–11).
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
};
// inside a clip (matched by id). A source the project did not have is ingest; a clip added, removed or moved is corte
export const CLIP_FIELD_STAGE: Record<string, Stage[]> = {
  sourceDurationSec: ['ingest'],
  ingest: ['ingest'], // the ingest's note (HDR tone-mapped, reused source)
  id: ['corte'], src: ['corte'], inSec: ['corte'], outSec: ['corte'], speed: ['corte'], enter: ['corte'], jSec: ['corte'], lSec: ['corte'],
  volume: ['audio'], muted: ['audio'],
  transform: ['broll'], // framing: zoom / pan keyframes
  graded: ['color'], location: ['color'], // a head's grade fixed by hand; where the shot is (color-jump compares only within one)
  label: [], srcKey: [], // the reel CLI's key of the file it came from
};

// the stage(s) each MCP tool (mcp/server.mjs) works in; [] = reads, searches, libraries, the plan, project
// admin and render jobs. test/stages.test.mjs fails when a tool is added without a row here.
export const TOOL_STAGE: Record<string, Stage[]> = {
  add_clips: ['ingest'], set_language: ['ingest'], set_identity: ['ingest'], get_transcript: ['ingest'],
  reorder_clips: ['corte'], trim_clip: ['corte'], delete_clips: ['corte'], split_clip: ['corte'], cut_words: ['corte'], set_audio_cut: ['corte'],
  set_transitions: ['corte'], set_speed_ramp: ['corte'], set_off_mic: ['corte'], duplicate_project: ['corte'], // variants are made in corte
  set_guion: ['guion'],
  set_grade: ['color'], create_lut: ['color'],
  set_audio: ['audio'], set_music: ['audio'],
  edit_caption: ['captions'], add_caption: ['captions'], delete_captions: ['captions'], set_captions: ['captions'], set_caption_style: ['captions'],
  annotate_captions: ['captions'], caption_proof: ['captions'], motion_proof: ['captions'], // the proofs its gate asks for
  add_broll: ['broll'], edit_broll: ['broll'], delete_brolls: ['broll'], add_graphic: ['broll'], edit_graphic: ['broll'], delete_graphics: ['broll'],
  set_keyframes: ['broll'], prepare_mattes: ['broll'],
  set_clip: ['corte', 'audio'], // speed; volume, muted
  set_accent_color: ['captions', 'broll'],
  set_brand: ['captions', 'broll', 'color', 'audio'], // a kit brings its captions, color and audio
  run_ai_step: ['corte', 'captions'], // autocut; captions
  render: ['entregables'], start_render: ['entregables'], share_version: ['entregables'],
  list_projects: [], get_project: [], rename_project: [], set_plan: [], approve_plan: [], request_plan_changes: [], set_plan_mode: [], style_kits: [],
  find_cut_candidates: [], search_stock: [], add_broll_assets: [], tag_broll_asset: [], broll_library: [], suggest_broll: [], catalog_assets: [],
  search_catalog: [], search_music: [], search_asset: [], list_assets: [], generate_asset: [], timing_report: [], validate: [], frame_at: [], qc: [],
  render_status: [], list_render_jobs: [], cancel_render: [], list_versions: [], revoke_review_link: [], health: [],
};

// the defaults a writer fills into a project that lacks them (mcp/checks.mjs withDefaults / newProject; a test
// holds them together): the same as absent
const DEFAULTS: Record<string, unknown> = {offMic: 'mark', audio: {clean: 'off'}, lang: 'auto', accentColor: '#FFB020', captionStyle: 'palabra'};
// equal for the gates: key order ignored, and absent / null / '' / [] / false / the field's default are one
// "nothing" (a writer that fills a default must not reopen a stage)
const canon = (v: unknown) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const nothing = (v: unknown, dflt?: unknown) => v == null || v === '' || v === false || (Array.isArray(v) && !v.length) || (dflt !== undefined && canon(v) === canon(dflt));
const same = (a: unknown, b: unknown, dflt?: unknown) => (nothing(a, dflt) && nothing(b, dflt)) || canon(a) === canon(b);
const row = <T>(map: Record<string, T>, k: string) => (Object.hasOwn(map, k) ? map[k] : null);

type Fields = Record<string, any>;
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
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (same(a[k], b[k], row(DEFAULTS, k) ?? undefined)) continue;
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

// The rules each stage's gate reads, by the code of their findings: src/validate.ts (validateProject,
// transcriptIssues), the judge's rules on the words as heard (mcp/checks.mjs stageChecks) and the ones made
// here. entregables reads the judge's findings on the final render. A code in no list lands in entregables.
// A rule that reads the graphics too — where captions land around them (safe-*: avoidGraphics), the pages an
// end-card hides (layer-blocker) — is broll's: the first stage both captions and graphics edits reopen.
// ponytail: J rules only; the probe (P) rules — durations, LUT copies, clipping, voice level, wind — and
// crew talk / script coverage / caption text come with their phases (12, 16, 18)
export const RULES: Record<Stage, string[]> = {
  ingest: ['untranscribed', 'identity'],
  corte: ['cut-word', 'off-mic', 'pause', 'cut-tight', 'jcut-gap'],
  guion: [],
  color: ['half-graded', 'half-graded-pending'], // src/validate.ts halfGradedIssues, mcp/checks.mjs (the scan not done yet)
  audio: [],
  captions: ['font-missing', 'font-wrong', 'glue', 'short', 'long', 'timing', 'overlap-captions', 'fast-words',
    'tier1-density', 'tier2-density', 'emoji-density', 'guion-conflict', 'guion-missing', 'guion-altered', 'guion-extra', 'guion-timing'],
  broll: ['safe-top', 'safe-bottom', 'face', 'behind-hidden', 'overlap-graphic', 'overlap-graphics', 'supers-order', 'matte', 'hook', 'layer-blocker', 'supers-blocker'],
  entregables: [],
};

export type StageInput = {
  p: {clips: Clip[]; captions?: Caption[]; graphics?: Graphic[]; captionStyle?: string; captionsOff?: boolean; identity?: unknown};
  fps: number;
  issues: Issue[]; // validateProject + transcriptIssues + the judge's J rules
  untranscribed?: string[]; // sources with no transcript cache yet
  judged?: Issue[]; // the judge on the final render
};
// every finding of the project by stage; a stage with an error is red
export function stageFindings({p, fps, issues, untranscribed = [], judged = []}: StageInput): Record<Stage, Issue[]> {
  const out = Object.fromEntries(STAGES.map((s) => [s, [] as Issue[]])) as Record<Stage, Issue[]>;
  const id = validateIdentity(p.identity);
  // a client's deliverables: the captions and the text graphics are layers of their own, or the render fails
  const layers = {clips: p.clips, captions: p.captions, graphics: p.graphics, captionStyle: p.captionStyle, captionsOff: p.captionsOff};
  for (const i of [
    ...untranscribed.map((s): Issue => ({level: 'error', code: 'untranscribed', msg: `${s} has no transcript yet — get_transcript`, ref: s})),
    ...(id.error ? [{level: 'error', code: 'identity', msg: id.error} as Issue] : []),
    ...(id.identity ? layerBlockers(layers, fps).map((msg): Issue => ({level: 'error', code: 'layer-blocker', msg})) : []),
    ...(id.identity ? supersBlockers(layers, fps).map((msg): Issue => ({level: 'error', code: 'supers-blocker', msg})) : []),
    ...issues,
  ]) out[STAGES.find((s) => RULES[s].includes(i.code)) ?? 'entregables'].push(i);
  out.entregables.push(...judged);
  return out;
}
