// A new project, a saved project as the tools read it, and the checks before a render — shared by
// the MCP (load, validate, caption_proof) and the backend's GET /api/validate/<id>
// (the reel CLI): src/validate.ts over the project, with the face boxes the captions
// job found and the words of the last transcript run.
import fs from 'node:fs';
import path from 'node:path';
import {normalizeCaption} from '../src/captions.ts';
import {deliveryFps} from '../src/timeline.ts';
import {fontFiles, identityTaken, transcriptIssues, validateIdentity, validateProject} from '../src/validate.ts';
import {readFont} from '../src/sfnt.ts';

// a new, empty project (MCP add_clips without a project, `reel projects create`)
export const newProject = (name) => ({name: name || 'Untitled project', clips: [], captions: [], brolls: [], graphics: [], mattes: [], brollAssets: [], music: null, accentColor: '#FFB020', lang: 'auto', captionStyle: 'palabra'});

export function withDefaults(p) {
  p.clips ??= []; p.captions ??= []; p.brolls ??= []; p.brollAssets ??= []; p.music ??= null; p.accentColor ??= '#FFB020'; p.lang ??= 'auto'; p.captionStyle ??= 'palabra'; p.captions = p.captions.map(normalizeCaption); p.graphics ??= []; p.mattes ??= []; p.offMic ??= 'mark'; p.hiddenWids ??= []; p.brand ??= null; p.grade ??= null; p.audio ??= {clean: 'off'}; p.plan ??= ''; p.planApproved ??= false; p.planReviews ??= []; p.planMode ??= null; p.planModeLog ??= []; p.captionsOff ??= false; p.guion ??= '';
  return p;
}

// face boxes the captions job detected (public/clips/faces/<source>.json), by clip src
export const facesOf = (p, publicDir) => Object.fromEntries(p.clips.map((c) => { try { return [c.src, JSON.parse(fs.readFileSync(path.join(publicDir, 'clips', 'faces', `${path.basename(c.src).replace(/\.[^.]+$/, '')}.json`), 'utf8'))]; } catch { return [c.src, undefined]; } }));

// this project's words, from its sources' transcript caches (scripts/lib-transcribe.mjs projectTranscript),
// never the machine's last transcription run. Imported here, not at the top: lib-transcribe loads the .env
// at import, and the reel CLI (it imports newProject) never reads the server's .env
export const projectWords = async (p, publicDir) => (await import('../scripts/lib-transcribe.mjs')).projectTranscript(p, publicDir);

// every issue: layout / timing / emphasis (validateProject), then off-mic words left in the cut and clip
// edges inside a word (projectWords) — at the fps the project renders at
export async function projectIssues(p, publicDir) {
  const fps = deliveryFps(p);
  // each font file the render loads: missing, or the face it is (validate compares a pack's with its expected name)
  const fonts = Object.fromEntries(fontFiles(p).map((f) => { const file = path.join(publicDir, f); if (!fs.existsSync(file)) return [f, false]; try { return [f, readFont(fs.readFileSync(file)).fullName ?? true]; } catch { return [f, '(not a font file)']; } }));
  return [...validateProject(p, fps, facesOf(p, publicDir), fonts), ...transcriptIssues(p, await projectWords(p, publicDir))];
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
