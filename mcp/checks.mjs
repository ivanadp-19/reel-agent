// A new project, a saved project as the tools read it, and the checks before a render — shared by
// the MCP (load, validate, caption_proof) and the backend's GET /api/validate/<id>
// (the reel CLI): src/validate.ts over the project, with the face boxes the captions
// job found and the words of the last transcript run.
import fs from 'node:fs';
import path from 'node:path';
import {normalizeCaption} from '../src/captions.ts';
import {transcriptIssues, validateProject} from '../src/validate.ts';

// a new, empty project (MCP add_clips without a project, `reel projects create`)
export const newProject = (name) => ({name: name || 'Untitled project', clips: [], captions: [], brolls: [], graphics: [], mattes: [], brollAssets: [], music: null, accentColor: '#FFB020', lang: 'auto', captionStyle: 'palabra'});

export function withDefaults(p) {
  p.clips ??= []; p.captions ??= []; p.brolls ??= []; p.brollAssets ??= []; p.music ??= null; p.accentColor ??= '#FFB020'; p.lang ??= 'auto'; p.captionStyle ??= 'palabra'; p.captions = p.captions.map(normalizeCaption); p.graphics ??= []; p.mattes ??= []; p.offMic ??= 'mark'; p.hiddenWids ??= []; p.brand ??= null; p.grade ??= null; p.audio ??= {clean: 'off'}; p.plan ??= ''; p.planApproved ??= false; p.planReviews ??= []; p.planMode ??= null; p.planModeLog ??= []; p.captionsOff ??= false;
  return p;
}

// face boxes the captions job detected (public/clips/faces/<source>.json), by clip src
export const facesOf = (p, publicDir) => Object.fromEntries(p.clips.map((c) => { try { return [c.src, JSON.parse(fs.readFileSync(path.join(publicDir, 'clips', 'faces', `${path.basename(c.src).replace(/\.[^.]+$/, '')}.json`), 'utf8'))]; } catch { return [c.src, undefined]; } }));

// every issue: layout / timing / emphasis (validateProject), then off-mic words left in
// the cut and clip edges inside a word, from the last transcript run
export function projectIssues(p, publicDir, fps = 30) {
  let tr = null;
  try { tr = JSON.parse(fs.readFileSync(path.join(publicDir, 'transcript.json'), 'utf8')); } catch {}
  return [...validateProject(p, fps, facesOf(p, publicDir)), ...(tr ? transcriptIssues(p, tr) : [])];
}
