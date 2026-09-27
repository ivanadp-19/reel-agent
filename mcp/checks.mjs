// A new project, a saved project as the tools read it, and the checks before a render — shared by
// the MCP (load, validate, caption_proof) and the backend's GET /api/validate/<id>
// (the reel CLI): src/validate.ts over the project, with the face boxes the captions
// job found and the words of the last transcript run.
import fs from 'node:fs';
import path from 'node:path';
import {normalizeCaption} from '../src/captions.ts';
import {deliveryFps} from '../src/timeline.ts';
import {fontFiles, halfGradedIssues, identityTaken, transcriptIssues, unbackedData, validateIdentity, validateProject} from '../src/validate.ts';
import {readFont} from '../src/sfnt.ts';
import {cacheName, projectTranscript, sourceKey} from '../scripts/transcript-cache.mjs';
import {readScan} from '../scripts/grade-scan.mjs';
import {stageFindings} from '../src/stages.ts';
import {readWind} from '../scripts/wind-scan.mjs';
import {windIssues} from '../src/audio.ts';

// a new, empty project (MCP add_clips without a project, `reel projects create`)
export const newProject = (name) => ({name: name || 'Untitled project', clips: [], captions: [], brolls: [], graphics: [], mattes: [], brollAssets: [], music: null, accentColor: '#FFB020', lang: 'auto', captionStyle: 'palabra'});

export function withDefaults(p) {
  p.clips ??= []; p.captions ??= []; p.brolls ??= []; p.brollAssets ??= []; p.music ??= null; p.accentColor ??= '#FFB020'; p.lang ??= 'auto'; p.captionStyle ??= 'palabra'; p.captions = p.captions.map(normalizeCaption); p.graphics ??= []; p.mattes ??= []; p.offMic ??= 'mark'; p.hiddenWids ??= []; p.brand ??= null; p.grade ??= null; p.audio ??= {clean: 'off'}; p.plan ??= ''; p.planApproved ??= false; p.planReviews ??= []; p.planMode ??= null; p.planModeLog ??= []; p.captionsOff ??= false; p.guion ??= '';
  return p;
}

// face boxes the captions job detected (public/clips/faces/<source>.json), by clip src
export const facesOf = (p, publicDir) => Object.fromEntries(p.clips.map((c) => { try { return [c.src, JSON.parse(fs.readFileSync(path.join(publicDir, 'clips', 'faces', `${path.basename(c.src).replace(/\.[^.]+$/, '')}.json`), 'utf8'))]; } catch { return [c.src, undefined]; } }));

// this project's words, from its sources' transcript caches (scripts/transcript-cache.mjs projectTranscript),
// never the machine's last transcription run; `env` (the caller's ROOT .env + process env) picks the engine
export const projectWords = projectTranscript; // (p, publicDir, env)

// the figures and names a version's graphics show that its own audio does not say (CEO-21, src/validate.ts
// unbackedData): the review version lists them for the client to confirm — the agent never decides a figure
export const datosPorConfirmar = (p, publicDir, env) => unbackedData(p, projectWords(p, publicDir, env)).map(({ref, dato, src, atSec}) => ({graphic: ref, dato, src, atSec}));

// every issue: layout / timing / emphasis (validateProject), then what needs the words (projectWords: off-mic
// words left in the cut, clip edges inside a word, the guion against the cut, the graphics' data against the
// audio), then half-graded sources and wind (their scans) — at the fps the project renders at. A source not
// scanned yet is said so and handed to kick(srcs): the backend's background lane (scripts/grade-scan.mjs
// createGradeScans, which runs the wind scan too) — validate itself never decodes
export async function projectIssues(p, publicDir, env, {kick} = {}) {
  const fps = deliveryFps(p);
  // each font file the render loads: missing, or the face it is (validate compares a pack's with its expected name)
  const fonts = Object.fromEntries(fontFiles(p).map((f) => { const file = path.join(publicDir, f); if (!fs.existsSync(file)) return [f, false]; try { return [f, readFont(fs.readFileSync(file)).fullName ?? true]; } catch { return [f, '(not a font file)']; } }));
  const srcs = [...new Set(p.clips.map((c) => c.src))];
  const scans = Object.fromEntries(srcs.map((src) => [src, readScan(publicDir, src)]));
  const winds = Object.fromEntries(srcs.map((src) => [src, readWind(publicDir, src)]));
  const pending = srcs.filter((src) => scans[src] === null), failed = srcs.filter((src) => scans[src]?.error);
  const kicked = srcs.filter((src) => scans[src] === null || winds[src] === null);
  if (kicked.length) try { kick?.(kicked); } catch {}
  const words = await projectWords(p, publicDir, env);
  // wind is the take's: the quiet of each whole source (between its first and last word), not only what the cut keeps
  const takes = Object.fromEntries((await projectWords({...p, clips: srcs.map((src) => ({id: src, src, inSec: 0, outSec: Infinity}))}, publicDir, env)).map((t) => [t.clipId, t.words]));
  return [...validateProject(p, fps, facesOf(p, publicDir), fonts), ...transcriptIssues(p, words), ...halfGradedIssues(p, scans, fps), ...windIssues(p, winds, takes),
    ...(pending.length ? [{level: 'warn', code: 'half-graded-pending', msg: `${pending.join(', ')} not checked for a half-graded shot yet — the scan runs in the backend's background (about a third of the clip's length); validate again in a minute (or: node scripts/grade-scan.mjs ${pending.join(' ')})`}] : []),
    ...failed.map((src) => ({level: 'warn', code: 'half-graded-pending', msg: `${src} could not be checked for a half-graded shot (${scans[src].error}) — retry: node scripts/grade-scan.mjs ${src} --force`}))];
}

// Every finding of a project by stage (src/stages.ts stageFindings): its issues (projectIssues), the judge's
// pause rules (dead air, tight cuts, J-cut holes) over the words as heard, the sources with no transcript cache
// yet, and `judged` — the render judge's findings on its final render, when there is one. Not enforced yet.
// ponytail: reads the transcript caches twice (projectIssues too); share the words if it shows
export async function stageChecks(p, publicDir, env, judged = []) {
  const {counts, pauseFindings, timelineSpeech} = await import('../.agents/skills/render-judge/judge.mjs');
  const fps = deliveryFps(p);
  // a judge finding as a gate reads it: a rule that counts toward its verdict blocks, the rest are warnings
  const asIssue = (f) => ({level: f.kind === 'rule' && counts(f) && ['blocker', 'major'].includes(f.severity) ? 'error' : 'warn', code: f.check, msg: f.msg, ...(f.ref ? {ref: f.ref} : {})});
  // corte judges the cut, never what later stages own: every clip heard (muting is the mix's, audio), and every
  // pause possibly dramatic (the key words are the captions') — only dead air blocks it; the judge on the final
  // render hears the rest
  const heard = timelineSpeech(p.clips.map(({muted, volume, ...c}) => c), await projectWords(p, publicDir, env), fps).words;
  const cached = (key) => [true, false].some((dg) => fs.existsSync(path.join(publicDir, 'clips', 'transcripts', cacheName(key, p.lang ?? 'auto', dg))));
  return stageFindings({p, fps, issues: [...await projectIssues(p, publicDir, env), ...pauseFindings(heard, p.clips, null).map(asIssue)],
    untranscribed: [...new Set(p.clips.map(sourceKey))].filter((k) => !cached(k)), judged: judged.map(asIssue)});
}

// A project's identity (set_identity) checked against the others saved here (public/projects/*.json):
// valid, and not another project's client + script + variant already (the rules: src/validate.ts).
// ponytail: reads every project, only when an identity changes; atomic because the backend is the only
// writer and its POST runs this and the write with no await between — two backends over one public/ could race.
export function claimIdentity(projectsDir, id, input) {
  const r = validateIdentity(input);
  if (!r.identity) return r;
  const error = identityTaken(projectRows(projectsDir), id, r.identity); // skips its own row
  return error ? {identity: null, error} : r;
}

// {id, identity} of every project saved here (an unreadable file is skipped) — what identityTaken and
// projectTargets (set_music targets) look at
export const projectRows = (projectsDir) => fs.readdirSync(projectsDir).filter((f) => f.endsWith('.json')).map((f) => {
  try { return {id: f.slice(0, -5), identity: JSON.parse(fs.readFileSync(path.join(projectsDir, f), 'utf8')).identity}; } catch { return null; }
}).filter(Boolean);

// POST /api/projects/<id>: a body that changes the identity must bring a valid, unrepeated one →
// the error for its 400, or null with the identity normalized in place. A body without one, or with
// the saved one, passes untouched (projects without identity save exactly as before).
export function identityWrite(projectsDir, id, prev, incoming) {
  if (incoming.identity === undefined || JSON.stringify(incoming.identity) === JSON.stringify(prev.identity ?? null)) return null;
  const r = claimIdentity(projectsDir, id, incoming.identity);
  if (r.error) return r.error;
  incoming.identity = r.identity;
  return null;
}

// a project as saved (public/projects/<id>.json); {} when it cannot be read
export function savedProject(projectsDir, id) {
  try { return JSON.parse(fs.readFileSync(path.join(projectsDir, `${id}.json`), 'utf8')); } catch { return {}; }
}

// POST /api/render: the identity a FINAL delivers its pair under (scripts/render-runner.mjs) — the
// SAVED project's, never the request's. null: no identity, a render like any other; a bad one throws.
export function pairIdentity(projectsDir, id) {
  const r = validateIdentity(savedProject(projectsDir, id).identity);
  if (r.error) throw new Error(r.error);
  return r.identity;
}
