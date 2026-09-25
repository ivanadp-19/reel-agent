#!/usr/bin/env node
// reel-agent MCP server — lets Claude (Code / Desktop) drive the editor:
// read a project, edit clips / captions / B-roll / music, run the pipeline steps,
// render, and look at frames. Talks to the same backend as the browser UI
// (`npm start`, port 3333) so results are identical; pure edits also work
// with the backend down (written straight to public/projects/<id>.json).
//
//   claude mcp add reel -- node /path/to/reel-agent/mcp/server.mjs
//
// Project model (see src/timeline.ts, src/captions.ts, src/Broll.tsx):
//   clips[]    ordered, back-to-back on the timeline; inSec/outSec trim the source
//   captions[] anchored to a clip, times are SOURCE-relative ms
//   brolls[]   same anchoring
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {applyAutocut, cutRange, locateSec, placeClips, reanchor, splitClip} from '../src/timeline.ts';
import {mergeCaptions, normalizeCaption, projectCaptions} from '../src/captions.ts';
import {isGlue, reapplyTiers} from '../src/paging.ts';
import {PRESETS} from '../src/captionPresets.ts';
import {PACKS} from '../src/stylePacks.ts';
import {TEMPLATES, MATTE_TEMPLATES, describeSchema, isTemplate, parseProps, projectGraphics, spansWithoutMatte, REVEAL_KINDS, OUT_KINDS, LIFE_KINDS} from '../src/graphicTemplates.ts';
import {searchAssets, findOrGenerate, listLibrary, librarySearch} from './assets.mjs';
import {searchStock} from './stock.mjs';
import {renderProof, renderStrip} from './proof.mjs';
import {transcriptIssues, validateProject} from '../src/validate.ts';
import {applyWordCuts, findCutCandidates, planWordCuts, SNAP_MS} from '../src/cuts.ts';
import {qc, qcText} from '../scripts/qc.mjs';
import {LOOKS, DEFAULT_LOOK} from '../src/grade.ts';
import {ENTERS, punchAlternate, speedRamp} from '../src/transitions.ts';
import {blackSpans, brollKind, brollSrc, loadLibrary, searchLibrary, sheetFor, upsertAsset} from './broll.mjs';
import {suggestBroll} from '../src/brollMatch.ts';
import {projectBrolls} from '../src/brollModel.ts';
import {creditOf, downloadMusic, loadMusicLibrary, searchMusic} from './music.mjs';
import {acquireLock, lockMessage, releaseLock} from '../scripts/project-lock.mjs';
import {CLEAN} from '../src/audio.ts';
import {brandSchema} from '../src/brand.ts';
import {FONT_FAMILIES} from '../src/fonts.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PROJECTS = path.join(PUBLIC, 'projects');
const API = process.env.REEL_API || 'http://127.0.0.1:3333';
const FPS = 30;

// ---------- .env ----------
const ENV = {};
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) ENV[m[1]] = m[2].trim();
  }
} catch {}

// ---------- project io ----------
const projFile = (id) => {
  if (!/^[\w-]+$/.test(id)) throw new Error(`bad project id: ${id}`);
  return path.join(PROJECTS, `${id}.json`);
};
function load(id) {
  const f = projFile(id);
  if (!fs.existsSync(f)) throw new Error(`project ${id} not found (use list_projects)`);
  const p = JSON.parse(fs.readFileSync(f, 'utf8'));
  p.clips ??= []; p.captions ??= []; p.brolls ??= []; p.brollAssets ??= []; p.music ??= null; p.accentColor ??= '#FFB020'; p.lang ??= 'auto'; p.captionStyle ??= 'palabra'; p.captions = p.captions.map(normalizeCaption); p.graphics ??= []; p.mattes ??= []; p.offMic ??= 'mark'; p.hiddenWids ??= []; p.brand ??= null; p.grade ??= null; p.audio ??= {clean: 'off'}; p.plan ??= ''; p.captionsOff ??= false;
  return p;
}
// one agent per project (scripts/project-lock.mjs): taken on the first write, freed on exit
const held = new Set();
const OWNER = process.env.REEL_AGENT || `mcp pid ${process.pid}`;
process.once('exit', () => { for (const id of held) releaseLock(PROJECTS, id); });
function lock(id) {
  const r = acquireLock(PROJECTS, id, {owner: OWNER});
  if (!r.ok) throw new Error(lockMessage(id, r.holder));
  held.add(id);
}
async function save(id, p) {
  lock(id);
  // prefer the backend (single writer, sets updatedAt the same way the UI does)
  try {
    const r = await fetch(`${API}/api/projects/${id}`, {method: 'POST', body: JSON.stringify(p)});
    if (r.ok) return (await r.json()).updatedAt;
    if (r.status === 409) throw new Error('project changed since you read it (the editor or another session saved) — call get_project and redo the edit');
  } catch (e) {
    if (/changed since you read it/.test(String(e))) throw e;
  }
  const now = new Date().toISOString();
  fs.mkdirSync(PROJECTS, {recursive: true});
  fs.writeFileSync(projFile(id), JSON.stringify({...p, createdAt: p.createdAt || now, updatedAt: now}, null, 2));
  return now;
}
async function backendUp() {
  try { return (await fetch(`${API}/api/projects`)).ok; } catch { return false; }
}
const needBackend = async () => {
  if (!(await backendUp())) throw new Error(`reel-agent backend is not running at ${API} — run \`npm start\` in the reel-agent folder`);
};

// ---------- timeline math (shared with the editor: src/timeline.ts) ----------
const place = (clips) => placeClips(clips, FPS);
const totalSec = (clips) => place(clips).at(-1)?.endMs / 1000 || 0;
// absolute timeline second → {clip, sourceSec} (src/timeline.ts)
function locate(p, atSec) {
  const r = locateSec(p.clips, FPS, atSec);
  if (!r) throw new Error('project has no clips');
  return r;
}
// source-relative ms on a clip → absolute seconds (null if trimmed away)
function toAbs(p, clipId, srcMs, clamp = false) {
  const pc = place(p.clips).find((x) => x.clip.id === clipId);
  if (!pc) return null;
  const inMs = pc.clip.inSec * 1000, outMs = pc.clip.outSec * 1000;
  if (clamp) srcMs = Math.min(outMs, Math.max(inMs, srcMs)); // ends may run past the clip (the player clips them)
  else if (srcMs < inMs || srcMs > outMs) return null;
  return (pc.startMs + (srcMs - inMs) / (pc.clip.speed ?? 1)) / 1000;
}
const f1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
const f2 = (n) => (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, '');
const capText = (c) => c.words.map((w) => (w.tier === 2 ? `**${w.text}**` : w.tier ? `*${w.text}*` : w.text) + (w.emoji ?? '')).join(' ');
// exactly one emoji (flags, skin tones and ZWJ sequences count as one)
const oneEmoji = (s) => [...new Intl.Segmenter('en', {granularity: 'grapheme'}).segment(s)].length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s);

function summary(id, p) {
  const out = [];
  out.push(`Project "${p.name || 'Untitled project'}" (id ${id}) — ${f1(totalSec(p.clips))}s, ${p.clips.length} clips, ${p.captions.length} captions${p.captionsOff ? ' (OFF — not rendered, set_captions)' : ''}, ${p.brolls.length} B-roll, music ${p.music ? path.basename(p.music.src) + ` vol ${p.music.volume}${p.music.credit ? ` (credit: ${p.music.credit})` : ''}` : 'none'}, voice cleanup ${p.audio?.clean ?? 'off'}, accent ${p.accentColor}, lang ${p.lang}, caption style ${p.captionStyle}, off-mic ${p.offMic}, brand ${p.brand ? `${p.brand.name ?? 'custom'} (accent ${p.brand.colors.accent}${p.brand.fonts?.display ? `, headlines ${p.brand.fonts.display}` : ''}${p.brand.fonts?.body ? `, captions ${p.brand.fonts.body}` : ''}${p.brand.logo ? `, logo ${p.brand.logo}` : ''})` : 'none'}, color ${p.grade ? `${p.grade.look} ${p.grade.intensity}${p.grade.auto ? ' + auto correction' : ''}` : 'ungraded'}`);
  if (p.plan) out.push('', 'PLAN (set_plan):', ...p.plan.split('\n').map((l) => `  ${l}`));
  out.push('', 'CLIPS (timeline order):');
  place(p.clips).forEach((pc, i) => {
    const c = pc.clip;
    const extra = [c.enter && c.enter !== 'cut' ? `enters with ${c.enter}` : '', c.speed && c.speed !== 1 ? `speed ${c.speed}x` : '', c.muted ? 'muted' : '', c.volume != null && c.volume !== 1 ? `vol ${c.volume}` : '', c.jSec ? `J-cut ${c.jSec}s` : '', c.lSec ? `L-cut ${c.lSec}s` : '', c.transform?.length ? `${c.transform.length} keyframes` : ''].filter(Boolean).join(', ');
    out.push(`  ${i + 1}. ${c.id}  @${f1(pc.startMs / 1000)}–${f1(pc.endMs / 1000)}s  source ${path.basename(c.src)} [${f1(c.inSec)}–${f1(c.outSec)} of ${f1(c.sourceDurationSec)}s]${extra ? '  ' + extra : ''}`);
  });
  out.push('', 'CAPTIONS (timeline time; *word* = tier 1 accent, **word** = tier 2 emphasis; word ids come from get_transcript):');
  const caps = projectCaptions(p.captions, p.clips, FPS);
  for (const c of caps) out.push(`  ${c.id}  @${f1(c.startMs / 1000)}s  top ${c.topPct}%${c.pin ? ' pinned' : ''}${c.scale && c.scale !== 1 ? ` scale ${c.scale}` : ''}${c.behind ? ' behind' : ''}  "${capText(c)}"`);
  const hidden = p.captions.filter((c) => !caps.some((x) => x.id === c.id)).length;
  if (hidden) out.push(`  (+${hidden} captions on trimmed-away parts, not shown)`);
  out.push('', 'B-ROLL:');
  for (const b of p.brolls) {
    const at = b.clipId ? toAbs(p, b.clipId, b.startMs) : b.startMs / 1000;
    const end = b.clipId ? toAbs(p, b.clipId, b.endMs, true) : b.endMs / 1000;
    out.push(`  ${b.id}  @${at == null ? '?' : f1(at)}–${end == null ? '?' : f1(end)}s  ${b.mode} ${b.kind}${b.enter && b.enter !== 'cut' ? ` enters with ${b.enter}` : ''}${b.scale && b.scale !== 1 ? ` scale ${b.scale}` : ''}  ${b.query ? `"${b.query}"` : ''} ${b.source ?? ''} ${/^https?:/.test(b.src) ? '' : path.basename(b.src)}`.replace(/\s+/g, ' '));
  }
  if (!p.brolls.length) out.push('  none');
  out.push('', 'GRAPHICS (timeline time):');
  for (const g of projectGraphics(p.graphics ?? [], p.clips, FPS)) out.push(`  ${g.id}  @${f1(g.startMs / 1000)}–${f1(g.endMs / 1000)}s  ${g.template}${g.behind ? ' (behind the presenter)' : ''}${g.yPct != null ? ` y ${g.yPct}%` : ''}  ${JSON.stringify(g.props)}`);
  if (!p.graphics?.length) out.push('  none');
  const need = spansWithoutMatte([...p.graphics, ...p.captions], p.mattes, p.clips);
  if (need.length) out.push(`  ⚠ ${need.length} behind-span(s) have no person matte yet — call prepare_mattes`);
  if (p.brollAssets.length) out.push('', `OWN FOOTAGE (for B-roll): ${p.brollAssets.map((a) => `${a.id} (${a.kind}, ${a.label})`).join(', ')}`);
  return out.join('\n');
}

// ---------- backend jobs ----------
async function runJob(route, body, maxSec = 1800) {
  await needBackend();
  const {jobId, error} = await fetch(`${API}${route}`, {method: 'POST', body: JSON.stringify(body)}).then((r) => r.json());
  if (!jobId) throw new Error(error || `${route} did not start`);
  let t0 = Date.now();
  let misses = 0; // a busy backend may miss a poll or two; only a run of failures is fatal
  for (;;) {
    let s;
    try { s = await fetch(`${API}${route}/${jobId}`).then((r) => r.json()); misses = 0; }
    catch (e) { if (++misses >= 8) throw new Error(`lost the backend while waiting for ${route}: ${e.message}`); await new Promise((r) => setTimeout(r, 2000)); continue; }
    if (s.status === 'done') return s;
    if (s.status === 'error') throw new Error(s.error || `${route} failed`);
    if (s.status === 'unknown') throw new Error('job vanished (backend restarted?)');
    if (s.queued) { t0 = Date.now(); await new Promise((r) => setTimeout(r, 3000)); continue; } // waiting in the render queue does not count against the timeout
    if ((Date.now() - t0) / 1000 > maxSec) throw new Error(`${route} timed out`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}
const readPublic = (f) => JSON.parse(fs.readFileSync(path.join(PUBLIC, f), 'utf8'));

const renumber = (items, prefix) => items.map((x, i) => ({...x, id: `${prefix}${i}`}));

// New text for a page. Same word count → each word keeps its id, timing and
// tier (a spelling fix stays anchored); otherwise the words are re-timed evenly.
// Either way the page is now hand-edited: `covers` remembers the transcript
// words it stands for, so re-paging never duplicates it.
function retext(cap, text) {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error('empty caption text');
  const covers = [...new Set([...(cap.covers ?? []), ...cap.words.map((w) => w.wid).filter(Boolean)])];
  if (words.length === cap.words.length) return {...cap, covers, words: cap.words.map((w, i) => ({...w, text: words[i]}))};
  const step = (cap.endMs - cap.startMs) / words.length;
  return {...cap, covers, words: words.map((t, i) => ({text: t, startMs: Math.round(cap.startMs + i * step), endMs: Math.round(cap.startMs + (i + 1) * step), tier: 0}))};
}
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9%$]/gi, '');

// ---------- Pexels (mcp/stock.mjs, shared with /api/stock) ----------
const pexels = (query, kind, count) => searchStock(query, kind, count, ENV.PEXELS_API_KEY || process.env.PEXELS_API_KEY);

// ---------- server ----------
const server = new McpServer({name: 'reel', version: '0.1.0'});
const text = (s) => ({content: [{type: 'text', text: s}]});
const pid = z.string().describe('project id from list_projects (e.g. "p-1789542691547")');
const sec = (d) => z.number().describe(d);

server.registerTool('list_projects', {description: 'List reel-agent projects (id, name, clip count, last update).', inputSchema: {}}, async () => {
  fs.mkdirSync(PROJECTS, {recursive: true});
  const rows = fs.readdirSync(PROJECTS).filter((f) => f.endsWith('.json')).map((f) => {
    try { const p = JSON.parse(fs.readFileSync(path.join(PROJECTS, f), 'utf8')); return {id: f.slice(0, -5), name: p.name || 'Untitled project', clips: p.clips?.length ?? 0, updatedAt: p.updatedAt}; } catch { return null; }
  }).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return text(rows.length ? rows.map((r) => `${r.id}  "${r.name}"  ${r.clips} clips  updated ${r.updatedAt ?? '?'}`).join('\n') : 'No projects yet — drop clips into the editor (npm start → http://localhost:5173) or use add_clips.');
});

server.registerTool('get_project', {description: 'Full readable state of a project: clips on the timeline, every caption with its text/accents/position, B-roll cues, music. Call this before editing and again after to verify.', inputSchema: {project_id: pid}}, async ({project_id}) => text(summary(project_id, load(project_id))));

server.registerTool('duplicate_project', {description: 'Copy a project under a new id/name (safe sandbox for experiments).', inputSchema: {project_id: pid, name: z.string().optional()}}, async ({project_id, name}) => {
  const p = load(project_id); const id = `p-${Date.now()}`;
  await save(id, {...p, name: name || `${p.name || 'Untitled project'} (copy)`, createdAt: undefined});
  return text(`Created ${id} "${name || (p.name || 'Untitled project') + ' (copy)'}"`);
});

server.registerTool('rename_project', {description: 'Rename a project.', inputSchema: {project_id: pid, name: z.string()}}, async ({project_id, name}) => { const p = load(project_id); p.name = name; await save(project_id, p); return text(`Renamed to "${name}"`); });
server.registerTool('set_plan', {description: 'Write the editorial plan BEFORE touching the timeline (the reel-plan skill has the template): the one idea of the reel and its hero word (by word id), the beats (hook, claims, close), the cuts you intend, the caption pack and why, the key words to emphasize (ids), graphics, B-roll moments (ids), music and transitions. get_project shows it from then on; every later step follows it, and the final message notes where you departed from it.', inputSchema: {project_id: pid, plan: z.string().min(40).max(6000)}}, async ({project_id, plan}) => {
  const p = load(project_id); p.plan = plan.trim(); await save(project_id, p);
  const wids = [...new Set(p.plan.match(/\b[\w.-]+:\d+\b/g) ?? [])];
  const unknown = wids.filter((w) => !transcriptHas(w));
  return text(`Plan saved (${p.plan.split('\n').length} lines, ${wids.length} word ids${unknown.length ? `; NOT in the transcript, fix them: ${unknown.join(', ')}` : ''}).`);
});
// a word id present in the last transcript run (get_transcript); nothing to check against before one
function transcriptHas(wid) {
  let tr; try { tr = readPublic('transcript.json'); } catch { return true; }
  const k = wid.lastIndexOf(':'); const source = wid.slice(0, k), i = wid.slice(k + 1);
  return tr.some((t) => t.source === source && t.words.some((w) => String(w.i) === i));
}

server.registerTool('set_accent_color', {description: 'Set the caption accent (highlight) color, hex like #FFB020 (also the brand kit accent when the project has one — see set_brand).', inputSchema: {project_id: pid, color: z.string().regex(/^#[0-9a-fA-F]{6}$/)}}, async ({project_id, color}) => { const p = load(project_id); p.accentColor = color; if (p.brand) p.brand.colors.accent = color; await save(project_id, p); return text(`Accent color ${color}`); });

// ---------- brand kit ----------
const BRANDS = path.join(PUBLIC, 'brands');
const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const savedBrands = () => { try { return fs.readdirSync(BRANDS).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch { return []; } };
const IMAGE = /\.(png|jpe?g|webp|svg)$/i;
server.registerTool('set_brand', {description: `Brand kit of the project (a client's look): accent / dark / light colors, headline font (graphics templates) and caption font, logo. Captions, templates and layout canvases all read it; the brand accent overrides a caption pack's own color. Fonts (OFL catalog): ${FONT_FAMILIES.join(', ')}. Change only what you pass. from = start from a saved kit; save_as = save this kit for other projects; clear = remove the kit.${savedBrands().length ? ` Saved kits: ${savedBrands().join(', ')}.` : ''}`, inputSchema: {project_id: pid, accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), dark: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), light: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), display_font: z.enum(FONT_FAMILIES).optional(), caption_font: z.enum(FONT_FAMILIES).optional(), logo: z.string().optional().describe('image path under public/ or an absolute file path (copied in)'), name: z.string().max(40).optional(), from: z.string().optional(), save_as: z.string().optional(), clear: z.boolean().default(false)}}, async ({project_id, accent, dark, light, display_font, caption_font, logo, name, from, save_as, clear}) => {
  const p = load(project_id);
  if (clear) { p.brand = null; await save(project_id, p); return text('Brand kit removed (caption packs use their own palette again)'); }
  let b;
  if (from) {
    const f = path.join(BRANDS, `${slug(from)}.json`);
    if (!fs.existsSync(f)) throw new Error(`no saved kit "${from}"${savedBrands().length ? ` — saved: ${savedBrands().join(', ')}` : ' (none saved yet)'}`);
    b = JSON.parse(fs.readFileSync(f, 'utf8'));
  } else b = structuredClone(p.brand ?? {colors: {accent: p.accentColor}, fonts: {}});
  b.fonts ??= {};
  if (name) b.name = name;
  if (accent) b.colors.accent = accent; if (dark) b.colors.dark = dark; if (light) b.colors.light = light;
  if (display_font) b.fonts.display = display_font; if (caption_font) b.fonts.body = caption_font;
  if (logo) {
    if (!IMAGE.test(logo)) throw new Error('logo must be a png, jpg, webp or svg');
    if (path.isAbsolute(logo)) {
      if (!fs.existsSync(logo)) throw new Error(`file not found: ${logo}`);
      const dir = path.join(BRANDS, 'logos'); fs.mkdirSync(dir, {recursive: true});
      const dest = path.join(dir, path.basename(logo).replace(/[^\w.\-]/g, '_')); fs.copyFileSync(logo, dest);
      b.logo = path.relative(PUBLIC, dest);
    } else {
      const abs = path.resolve(PUBLIC, logo);
      if (!abs.startsWith(PUBLIC + path.sep) || !fs.existsSync(abs)) throw new Error(`not found under public/: ${logo}`);
      b.logo = path.relative(PUBLIC, abs);
    }
  }
  const r = brandSchema.safeParse(b);
  if (!r.success) throw new Error(`brand: ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  p.brand = r.data; p.accentColor = r.data.colors.accent;
  let saved = '';
  if (save_as) { fs.mkdirSync(BRANDS, {recursive: true}); fs.writeFileSync(path.join(BRANDS, `${slug(save_as)}.json`), JSON.stringify({...r.data, name: r.data.name ?? save_as}, null, 2)); saved = ` — saved as "${slug(save_as)}"`; }
  await save(project_id, p);
  return text(`Brand kit: ${JSON.stringify(p.brand)}${saved}`);
});

server.registerTool('add_clips', {description: 'Add video files to a project (absolute paths on this machine). Uploads through the backend (remux + thumbnail). New project if project_id is omitted.', inputSchema: {project_id: pid.optional(), files: z.array(z.string()).min(1), name: z.string().optional()}}, async ({project_id, files, name}) => {
  await needBackend();
  const id = project_id || `p-${Date.now()}`;
  const p = project_id ? load(project_id) : {name: name || 'Untitled project', clips: [], captions: [], brolls: [], graphics: [], mattes: [], brollAssets: [], music: null, accentColor: '#FFB020', lang: 'auto', captionStyle: 'palabra'};
  const added = [];
  for (const f of files) {
    if (!fs.existsSync(f)) throw new Error(`file not found: ${f}`);
    // same machine: hand the backend the path instead of streaming the file through memory
    const token = (() => { try { return fs.readFileSync(path.join(ROOT, '.backend-token'), 'utf8').trim(); } catch { return ''; } })();
    const r = await fetch(`${API}/api/add-clip?name=${encodeURIComponent(path.basename(f))}&path=${encodeURIComponent(f)}`, {method: 'POST', headers: {'x-reel-token': token}}).then((x) => x.json());
    if (!r.id) throw new Error(`upload failed for ${f}: ${r.error ?? ''}`);
    const {ingest, ...clip} = r;
    p.clips.push(clip); added.push(`${r.id} (${f1(r.outSec)}s${ingest ? `, ${ingest}` : ''})`);
  }
  await save(id, p);
  return text(`Project ${id}: added ${added.join(', ')}\n\n${summary(id, p)}`);
});

server.registerTool('reorder_clips', {description: 'Set the timeline order. Clips not listed keep their relative order after the listed ones.', inputSchema: {project_id: pid, clip_ids: z.array(z.string()).min(1)}}, async ({project_id, clip_ids}) => {
  const p = load(project_id); const byId = new Map(p.clips.map((c) => [c.id, c]));
  for (const id of clip_ids) if (!byId.has(id)) throw new Error(`no clip ${id}`);
  p.clips = [...clip_ids.map((id) => byId.get(id)), ...p.clips.filter((c) => !clip_ids.includes(c.id))];
  await save(project_id, p); return text(summary(project_id, p));
});

server.registerTool('trim_clip', {description: 'Change where a clip starts/ends inside its source file (seconds, source time). Captions and B-roll on trimmed-away parts disappear automatically.', inputSchema: {project_id: pid, clip_id: z.string(), in_sec: sec('new start inside the source').optional(), out_sec: sec('new end inside the source').optional()}}, async ({project_id, clip_id, in_sec, out_sec}) => {
  const p = load(project_id); const c = p.clips.find((x) => x.id === clip_id); if (!c) throw new Error(`no clip ${clip_id}`);
  if (in_sec != null) c.inSec = Math.max(0, in_sec); if (out_sec != null) c.outSec = Math.min(c.sourceDurationSec, out_sec);
  if (c.outSec - c.inSec < 0.2) throw new Error('clip would be shorter than 0.2 s');
  await save(project_id, p); return text(`${clip_id}: ${f1(c.inSec)}–${f1(c.outSec)}s (${f1(clipDur(c))}s on the timeline)`);
});

server.registerTool('set_clip', {description: 'Per-clip playback: speed (0.25–4), volume (0–2), muted.', inputSchema: {project_id: pid, clip_id: z.string(), speed: z.number().min(0.25).max(4).optional(), volume: z.number().min(0).max(2).optional(), muted: z.boolean().optional()}}, async ({project_id, clip_id, speed, volume, muted}) => {
  const p = load(project_id); const c = p.clips.find((x) => x.id === clip_id); if (!c) throw new Error(`no clip ${clip_id}`);
  if (speed != null) c.speed = speed; if (volume != null) c.volume = volume; if (muted != null) c.muted = muted;
  await save(project_id, p); return text(`${clip_id}: speed ${c.speed ?? 1}x, volume ${c.volume ?? 1}, ${c.muted ? 'muted' : 'audio on'}`);
});

server.registerTool('set_audio_cut', {description: 'J-cuts and L-cuts (per clip, seconds of TIMELINE time; 0 clears). j_sec = J-cut: this clip\'s audio starts that early, under the previous clip\'s tail — you hear the next take before you see it (its first j seconds of audio lead; they are muted in place so the sound flows straight through the cut). l_sec = L-cut: this clip\'s audio keeps playing after its video ends, under the next clip — the voice walks the viewer into the next shot. Classic use: 0.5–1.5 s on a change of take/place; j on the clip you enter, l on the one you leave. A J-cut is clamped to the clip\'s own length and the previous clip\'s, an L-cut to the audio left in the source after out_sec and the next clip\'s length. Muted clips stay silent. Set them after cutting: pieces made by later cuts start plain.', inputSchema: {project_id: pid, clip_id: z.string(), j_sec: z.number().min(0).max(4).optional(), l_sec: z.number().min(0).max(4).optional()}}, async ({project_id, clip_id, j_sec, l_sec}) => {
  const p = load(project_id); const i = p.clips.findIndex((x) => x.id === clip_id); if (i < 0) throw new Error(`no clip ${clip_id}`);
  const c = p.clips[i];
  if (j_sec != null) c.jSec = j_sec > 0 ? j_sec : undefined;
  if (l_sec != null) c.lSec = l_sec > 0 ? l_sec : undefined;
  await save(project_id, p);
  const pc = place(p.clips)[i]; // the same frames the render uses
  const j = pc.jFrames / FPS, l = pc.lFrames / FPS;
  return text(`${clip_id}: J-cut ${f2(j)}s${j < (c.jSec ?? 0) ? ' (clamped)' : ''}, L-cut ${f2(l)}s${l < (c.lSec ?? 0) ? ' (clamped)' : ''}`);
});

server.registerTool('delete_clips', {description: 'Remove clips from the timeline (their captions/B-roll go with them).', inputSchema: {project_id: pid, clip_ids: z.array(z.string()).min(1)}}, async ({project_id, clip_ids}) => {
  const p = load(project_id); const gone = new Set(clip_ids);
  p.clips = p.clips.filter((c) => !gone.has(c.id)); p.captions = p.captions.filter((c) => p.clips.some((k) => k.src === c.src)); p.graphics = p.graphics.filter((g) => p.clips.some((k) => k.src === g.src)); p.brolls = p.brolls.filter((b) => !b.clipId || !gone.has(b.clipId));
  await save(project_id, p); return text(summary(project_id, p));
});

server.registerTool('split_clip', {description: 'Split a clip in two: at a timeline time (at_sec, like pressing S at the playhead) or in the pause right before a word (before_wid). To REMOVE words use cut_words instead — it snaps the boundaries for you.', inputSchema: {project_id: pid, at_sec: sec('timeline time in seconds').optional(), before_wid: z.string().optional().describe('word id from get_transcript')}}, async ({project_id, at_sec, before_wid}) => {
  const p = load(project_id);
  let clip, sourceSec;
  if (before_wid) { const w = await wordAt(p, before_wid); clip = w.clip; sourceSec = (w.prev ? Math.max(w.prev.endMs + 40, w.word.startMs - SNAP_MS) : w.word.startMs - 100) / 1000; }
  else if (at_sec != null) ({clip, sourceSec} = locate(p, at_sec));
  else throw new Error('give at_sec or before_wid');
  if (sourceSec - clip.inSec < 0.2 || clip.outSec - sourceSec < 0.2) throw new Error('too close to the clip edge (min 0.2 s each side)');
  const r = splitClip(p.clips, clip.id, sourceSec); if (!r) throw new Error('could not split');
  p.clips = r.clips; p.brolls = reanchor(p.brolls, r.remap); // captions follow their source on their own
  await save(project_id, p); return text(`Split ${clip.id} at source ${f1(sourceSec)}s → ${clip.id} + ${r.newId}\n\n${summary(project_id, p)}`);
});

server.registerTool('cut_words', {description: 'Remove speech by word id: from_wid … to_wid (inclusive, same clip), or many stretches in ONE call with ranges (e.g. the ones find_cut_candidates suggested and you approved). Cut points snap into the pauses around the words so no syllable is clipped. Word ids stay valid after cuts; clip ids change (re-read get_transcript before using clip ids).', inputSchema: {project_id: pid, from_wid: z.string().optional().describe('first word to remove, "<source>:<i>"'), to_wid: z.string().optional().describe('last word to remove; defaults to from_wid'), ranges: z.array(z.object({from_wid: z.string(), to_wid: z.string().optional()})).max(80).optional().describe('several stretches at once')}}, async ({project_id, from_wid, to_wid, ranges}) => {
  const p = load(project_id);
  const list = ranges?.length ? ranges : from_wid ? [{from_wid, to_wid}] : null;
  if (!list) throw new Error('give from_wid (and to_wid), or ranges');
  const tr = await transcript(p);
  // the same planner and cutter the editor's Transcript panel uses (src/cuts.ts)
  const {spans, errors} = planWordCuts(tr, p.clips, list);
  if (errors.length) throw new Error(errors.join('; '));
  const r = applyWordCuts(p.clips, p.brolls, spans, tr);
  p.clips = r.clips; p.brolls = r.brolls;
  await save(project_id, p);
  return text(`${r.lines.join('\n')}\n\n${summary(project_id, p)}`);
});

server.registerTool('find_cut_candidates', {description: 'Suggest what to cut, by word id (nothing is cut): retakes — a line the speaker said more than once, including the quiet read-through she does before performing it; the kept take is the LAST complete one (rehearsal first, take last), attempts are whole sentences even when said with a pause inside —, off-mic lines, meta talk ("sorry", "say it again", "otra vez", "corta") and fillers (um, uh, eh, mmm, "you know", "o sea"; "este"/"like" only between pauses). Review the list against the transcript, drop what should stay, then pass the rest to cut_words ranges in one call.', inputSchema: {project_id: pid}}, async ({project_id}) => {
  const p = load(project_id); if (!p.clips.length) throw new Error('project has no clips');
  const tr = await transcript(p);
  const cands = findCutCandidates(tr.map((t) => ({clipId: t.clipId, source: t.source, words: t.words})));
  if (!cands.length) return text('No cut candidates: no retakes, fillers, meta talk or off-mic lines on the timeline.');
  const lines = cands.map((c) => `${c.kind.padEnd(7)} ${c.from}${c.to !== c.from ? `…${c.to}` : ''}  "${c.text}"${c.note ? `  (${c.note})` : ''}${c.keep ? `  — kept take starts at ${c.keep.from}: "${c.keep.text.slice(0, 60)}"` : ''}`);
  return text(`${cands.length} candidates:\n${lines.join('\n')}\n\nAll of them as cut_words ranges (remove the ones to keep):\n${JSON.stringify(cands.map((c) => (c.to === c.from ? {from_wid: c.from} : {from_wid: c.from, to_wid: c.to})))}`);
});

server.registerTool('set_transitions', {description: 'How each clip — or B-roll cue — starts (the cut from what was on screen): cut = plain; punch = the whole clip sits 12 % closer — hides a jump cut inside a take (alternate them); zoom = quick eased push-in with a short blur — a beat of emphasis; whip = motion-blurred slide out of the previous clip and into this one; whipDiag = Prism Pro\'s whip: a diagonal smear out (5 frames) and a landing from 1.3× that clears in 8 — the cleanest change of place; card = the previous clip shrinks into a card and slides off, revealing this one; split = the previous clip breaks into 2×2 tiles flying to the corners. The Captions.ai pack: flash (2 white frames + fade, Stack); crossBlur (both clips blur through each other, Prime/Linen); spin (a twist under a white flash, Prime); rgbFlash (blur + chromatic split + flash, Impact II); bands (three stacked accent bands sweep through, Focus); polyWipe (a diagonal sweep with an accent edge, Lift); clock (a pie in a light tone covers then uncovers, Y2K); mosaic (squares grow and shrink, Y2K); disc (a disc from a corner covers, then retires, Orbit); blinds (accent bars close and open with a horizontal smear, Form); particles (the old shot dissolves left to right, Form); diagWipe (a ~20° edge comes down, Linen); blocks (the new shot rises with a stepped edge, Vista); cardDrop (the new shot falls in as a card, Pop); lightLeak (warm and pink flares over the cut, Lens). Any of them marks a change of topic or place — one or two per reel; pick the family of the caption pack (prism → whipDiag, focus → bands, lift → polyWipe, stack → flash, prime → spin, impact → rgbFlash, orbit → disc, evo → crossBlur). pattern punch-alternate punches every other jump cut inside each take; items set single clips by id (get_project). Set them after cutting: pieces made by later cuts start plain. set_audio sfx=true adds a whoosh to whip/zoom/card/split.', inputSchema: {project_id: pid, pattern: z.enum(['punch-alternate', 'none']).optional(), items: z.array(z.object({clip_id: z.string(), type: z.enum([...ENTERS, 'pack']).describe('a kind, or pack = the style pack\'s own family')})).optional()}}, async ({project_id, pattern, items}) => {
  const p = load(project_id);
  const packKind = PACKS[p.captionStyle]?.transition ?? 'whip';
  items = items?.map((it) => (it.type === 'pack' ? {...it, type: packKind} : it));
  if (!pattern && !items?.length) throw new Error('give a pattern or items');
  if (pattern === 'none') p.clips = p.clips.map(({enter, ...c}) => c);
  if (pattern === 'punch-alternate') p.clips = punchAlternate(p.clips);
  for (const it of items ?? []) {
    const c = p.clips.find((x) => x.id === it.clip_id) ?? p.brolls.find((x) => x.id === it.clip_id);
    if (!c) throw new Error(`no clip or B-roll cue ${it.clip_id}`);
    if ('kind' in c && (it.type === 'card' || it.type === 'split')) throw new Error(`${it.clip_id} is a B-roll cue: it can enter with punch, zoom or whip (card/split are for clips)`);
    if (it.type === 'cut') delete c.enter; else c.enter = it.type;
  }
  await save(project_id, p);
  const set = [...p.clips, ...p.brolls].filter((c) => c.enter && c.enter !== 'cut');
  return text(`Transitions: ${set.length ? set.map((c) => `${c.id} ${c.enter}`).join(', ') : 'all plain cuts'}`);
});

server.registerTool('set_keyframes', {description: 'Replace a clip\'s zoom/pan keyframes. t = source-time seconds; scale 1 = none; x/y = pan in px of the 1080x1920 frame. Empty list removes the animation. Two keyframes = smooth move between them.', inputSchema: {project_id: pid, clip_id: z.string(), keyframes: z.array(z.object({t: z.number(), scale: z.number().min(0.5).max(4), x: z.number().default(0), y: z.number().default(0)}))}}, async ({project_id, clip_id, keyframes}) => {
  const p = load(project_id); const c = p.clips.find((x) => x.id === clip_id); if (!c) throw new Error(`no clip ${clip_id}`);
  c.transform = keyframes.length ? [...keyframes].sort((a, b) => a.t - b.t) : undefined;
  await save(project_id, p); return text(`${clip_id}: ${keyframes.length} keyframes`);
});

server.registerTool('edit_caption', {description: 'Edit one caption page: new text (words are re-timed evenly across the page), which words to accent (gold), vertical position top_pct (0–100, % from top), size scale (1 = default), behind = draw the page BEHIND the presenter (big words over the head/shoulders; needs prepare_mattes afterwards). Position, size and behind follow the words when the style changes.', inputSchema: {project_id: pid, caption_id: z.string(), text: z.string().optional(), accent_words: z.array(z.string()).optional().describe('exact words to highlight; [] clears accents'), top_pct: z.number().min(0).max(95).optional(), scale: z.number().min(0.5).max(2).optional(), behind: z.boolean().optional()}}, async ({project_id, caption_id, text: t, accent_words, top_pct, scale, behind}) => {
  const p = load(project_id); const i = p.captions.findIndex((c) => c.id === caption_id); if (i < 0) throw new Error(`no caption ${caption_id}`);
  let cap = p.captions[i];
  if (t != null) cap = retext(cap, t);
  if (accent_words) { const set = new Set(accent_words.map(norm)); cap = {...cap, words: cap.words.map((w) => ({...w, tier: set.has(norm(w.text)) ? Math.max(1, w.tier ?? 0) : 0}))}; }
  if (top_pct != null) { cap.topPct = top_pct; cap.pin = true; } if (scale != null) cap.scale = scale;
  if (behind != null) { if (behind) cap.behind = true; else delete cap.behind; }
  p.captions[i] = cap; await save(project_id, p);
  const floats = PRESETS[p.captionStyle]?.position === 'float';
  const needMatte = cap.behind && spansWithoutMatte([cap], p.mattes, p.clips).length;
  return text(`${caption_id}: "${capText(cap)}" top ${cap.topPct}%${cap.pin ? ' (pinned)' : ''}${cap.scale ? ` scale ${cap.scale}` : ''}${cap.behind ? ' behind the presenter' : ''}${top_pct != null && floats ? ` — style ${p.captionStyle} floats its pages around the frame; this one now stays at ${cap.topPct}%` : ''}${needMatte ? ' — run prepare_mattes before rendering' : ''}`);
});

server.registerTool('add_caption', {description: 'Add a caption page at a timeline time (seconds) lasting duration_sec.', inputSchema: {project_id: pid, at_sec: sec('timeline start'), duration_sec: z.number().min(0.3).default(2), text: z.string(), accent_words: z.array(z.string()).optional(), top_pct: z.number().min(0).max(95).optional()}}, async ({project_id, at_sec, duration_sec, text: t, accent_words, top_pct}) => {
  const p = load(project_id); const {clip, sourceSec} = locate(p, at_sec);
  const startMs = Math.round(sourceSec * 1000); const endMs = Math.round(Math.min(clip.outSec, sourceSec + duration_sec * (clip.speed ?? 1)) * 1000);
  let cap = retext({id: 'x', src: clip.src, startMs, endMs, topPct: top_pct ?? p.captions.find((c) => c.src === clip.src)?.topPct ?? 58, words: []}, t);
  if (accent_words) { const set = new Set(accent_words.map(norm)); cap.words = cap.words.map((w) => ({...w, tier: set.has(norm(w.text)) ? 1 : 0})); }
  p.captions = renumber([...p.captions, cap], 'c'); await save(project_id, p);
  return text(`Added caption on ${clip.id} @${f1(at_sec)}s: "${capText(cap)}" (id ${p.captions.at(-1).id})`);
});

server.registerTool('set_captions', {description: 'Switch the captions of the reel off (or back on) without deleting them: off = the render, the proofs and validate show no caption page, while the pages, their emphasis and positions are kept for when they come back on. Use it when the brief asks for a reel without subtitles (instead of duplicating the project or deleting pages). Music still ducks under the speech.', inputSchema: {project_id: pid, off: z.boolean()}}, async ({project_id, off}) => {
  const p = load(project_id); p.captionsOff = off; await save(project_id, p);
  return text(`Captions ${off ? `OFF (${p.captions.length} pages kept, none rendered)` : `ON (${p.captions.length} pages)`}`);
});

server.registerTool('delete_captions', {description: 'Delete caption pages by id. Their words stay uncaptioned even after set_caption_style or regenerating (to change wording use edit_caption instead).', inputSchema: {project_id: pid, caption_ids: z.array(z.string()).min(1)}}, async ({project_id, caption_ids}) => {
  const p = load(project_id); const gone = new Set(caption_ids); const before = p.captions.length;
  const wids = p.captions.filter((c) => gone.has(c.id)).flatMap((c) => c.words.map((w) => w.wid).filter(Boolean));
  p.hiddenWids = [...new Set([...p.hiddenWids, ...wids])];
  p.captions = p.captions.filter((c) => !gone.has(c.id)); await save(project_id, p);
  return text(`Deleted ${before - p.captions.length} caption(s); ${p.captions.length} left (ids unchanged)${wids.length ? `; ${wids.length} words now stay uncaptioned` : ''}`);
});

server.registerTool('search_stock', {description: 'Search Pexels for portrait stock video/photos to use as B-roll. Returns URLs for add_broll / edit_broll.', inputSchema: {query: z.string(), kind: z.enum(['video', 'image']).default('video'), count: z.number().min(1).max(10).default(5)}}, async ({query, kind, count}) => {
  const rows = await pexels(query, kind, count);
  return text(rows.length ? rows.map((r, i) => `${i + 1}. ${r.src}${r.duration ? `  ${r.duration}s ${r.size}` : r.alt ? `  "${r.alt}"` : ''}`).join('\n') : 'nothing found');
});

server.registerTool('add_broll', {description: 'Overlay B-roll for duration_sec, starting at a word (at_wid, from get_transcript — preferred) or a timeline time (at_sec). What to show: asset_id from the own library (broll_library / suggest_broll), or src = Pexels URL (from search_stock), a path inside public/ (e.g. "broll/x.mp4"), or an absolute file path (copied in). mode: fullscreen | top (upper 45%) | inset (small card top-right) | card (Prism: a square card that rises and settles over the blurred footage, then leaves upwards — pair it with the prism captions) | carousel (Prime: three foreshortened panels in the lower half that step along every 2.4 s). arrive / leave = how its box comes and goes: slideUp + slideDown (Elevate, Impact, Form, Focus), popFrom + shrink (Evo), slideRight + fall (Y2K, Chalk); cut = a plain fade. Rules: start on the mention, 0.5–8 s, one insert per ~9 s, never over the hook or the closing line — suggest_broll already applies them.', inputSchema: {project_id: pid, at_wid: z.string().optional(), at_sec: sec('timeline start').optional(), duration_sec: z.number().min(0.3).max(8), asset_id: z.string().optional().describe('id from broll_library'), src: z.string().optional(), kind: z.enum(['video', 'image']).optional(), mode: z.enum(['fullscreen', 'top', 'inset', 'card', 'carousel']).default('inset'), arrive: z.enum(['cut', 'slideUp', 'popFrom', 'slideRight']).optional(), leave: z.enum(['cut', 'slideDown', 'shrink', 'fall']).optional(), label: z.string().optional()}}, async ({project_id, at_wid, at_sec, duration_sec, asset_id, src, kind, mode, label, arrive, leave}) => {
  const p = load(project_id);
  let clip, sourceSec;
  if (at_wid) { const w = await wordAt(p, at_wid); clip = w.clip; sourceSec = Math.max(clip.inSec, w.word.startMs / 1000 - 0.3); }
  else if (at_sec != null) ({clip, sourceSec} = locate(p, at_sec));
  else throw new Error('give at_wid or at_sec');
  let s = src, source = 'own', query = label;
  if (asset_id) {
    const a = loadLibrary().find((x) => x.id === asset_id); if (!a) throw new Error(`no library asset ${asset_id} (see broll_library)`);
    s = a.src; kind = a.kind; query = label ?? a.label;
  } else if (!src) throw new Error('give asset_id or src');
  else s = brollSrc(src);
  if (/^https?:/.test(s)) source = 'pexels';
  if (!kind) kind = brollKind(s);
  const b = {id: 'x', clipId: clip.id, startMs: Math.round(sourceSec * 1000), endMs: Math.round(Math.min(clip.outSec, sourceSec + duration_sec * (clip.speed ?? 1)) * 1000), kind, mode, src: s, source, query, alternatives: [], ...(asset_id ? {assetId: asset_id} : {}), ...(arrive ? {arrive} : {}), ...(leave ? {leave} : {})};
  p.brolls = renumber([...p.brolls, b], 'b'); await save(project_id, p);
  const abs = toAbs(p, clip.id, b.startMs) ?? 0;
  return text(`Added B-roll ${p.brolls.at(-1).id} on ${clip.id} @${f1(abs)}–${f1(abs + (b.endMs - b.startMs) / 1000 / (clip.speed ?? 1))}s (${mode} ${kind}${asset_id ? `, library ${asset_id}` : ''})`);
});

// ---------- the user's own B-roll library ----------
const sheetContent = (a) => { const f = sheetFor(a); return {type: 'image', data: fs.readFileSync(f).toString('base64'), mimeType: 'image/jpeg'}; };
const assetLine = (a) => `${a.id}  ${a.kind}${a.durationSec ? ` ${f1(a.durationSec)}s` : ''}  "${a.label}"${a.tags?.length ? `  tags: ${a.tags.join(', ')}` : '  (untagged)'}${a.desc ? `  — ${a.desc}` : ''}`;

server.registerTool('add_broll_assets', {description: "Bring the client's own footage / photos into the B-roll library (absolute paths on this machine; normalized to 1080p, thumbnails made). Returns a contact sheet of each so you can tag it right away with tag_broll_asset — untagged assets are never suggested. Needs the backend.", inputSchema: {files: z.array(z.string()).min(1).max(20)}}, async ({files}) => {
  await needBackend();
  const token = (() => { try { return fs.readFileSync(path.join(ROOT, '.backend-token'), 'utf8').trim(); } catch { return ''; } })();
  const content = [];
  for (const f of files) {
    if (!fs.existsSync(f)) throw new Error(`file not found: ${f}`);
    const kind = /\.(jpe?g|png|webp|heic)$/i.test(f) ? 'image' : 'video';
    const r = await fetch(`${API}/api/add-broll-asset?name=${encodeURIComponent(path.basename(f))}&kind=${kind}&path=${encodeURIComponent(f)}`, {method: 'POST', headers: {'x-reel-token': token}}).then((x) => x.json());
    if (!r.id) throw new Error(`ingest failed for ${f}: ${r.error ?? ''}`);
    const a = upsertAsset({id: r.id, src: r.src, kind: r.kind, label: r.label, durationSec: r.durationSec ?? null});
    content.push({type: 'text', text: `${assetLine(a)}\ncontact sheet (6 frames, left→right, top→bottom):`}, sheetContent(a));
  }
  content.push({type: 'text', text: 'Now tag each one: tag_broll_asset(id, tags, desc) — what is in the shot (room, object, mood, time of day), in the language of the reel.'});
  return {content};
});

server.registerTool('tag_broll_asset', {description: 'Describe a library asset so suggest_broll can match it to the transcript: tags = 3–8 nouns for what is in the shot (in the reel language, e.g. "cava", "vino", "salón"), desc = one line (room, mood, time of day, camera move). Replaces earlier tags.', inputSchema: {asset_id: z.string(), tags: z.array(z.string().trim().min(2).max(30)).min(1).max(12), desc: z.string().trim().max(200).default('')}}, async ({asset_id, tags, desc}) => {
  if (!loadLibrary().some((a) => a.id === asset_id)) throw new Error(`no library asset ${asset_id}`);
  return text(assetLine(upsertAsset({id: asset_id, tags, desc})));
});

server.registerTool('broll_library', {description: "The client's own B-roll library (footage and photos ingested with add_broll_assets, with the tags you gave them). query narrows by tags/description; sheet=true attaches each asset's contact sheet.", inputSchema: {query: z.string().optional(), sheet: z.boolean().default(false)}}, async ({query, sheet}) => {
  const rows = searchLibrary(query);
  if (!rows.length) return text(query ? `Nothing in the library matches "${query}".` : 'The B-roll library is empty — add_broll_assets with the client footage.');
  if (!sheet) return text(rows.map(assetLine).join('\n'));
  return {content: rows.flatMap((a) => [{type: 'text', text: assetLine(a)}, sheetContent(a)])};
});

server.registerTool('suggest_broll', {description: 'Where the own library should go, by word id: an asset over the mention its tags match (start on the word, 0.5–8 s, one per ~9 s, never over the hook or the closing line), plus every black stretch of footage — with the best asset, or a search_stock query when nothing in the library fits. Nothing is placed: apply what you approve with add_broll (asset_id + at_wid, or search_stock + src). Needs the backend.', inputSchema: {project_id: pid}}, async ({project_id}) => {
  const p = load(project_id); if (!p.clips.length) throw new Error('project has no clips');
  const lib = loadLibrary().filter((a) => a.tags?.length);
  const tr = await transcript(p);
  const placed = place(p.clips);
  const mentions = [];
  for (const pc of placed) {
    const t = tr.find((x) => x.clipId === pc.clip.id); if (!t) continue;
    const inMs = pc.clip.inSec * 1000, speed = pc.clip.speed ?? 1;
    for (const w of t.words) if (!w.off) mentions.push({wid: `${t.source}:${w.i}`, word: w.word, startMs: pc.startMs + (Math.max(w.startMs, inMs) - inMs) / speed, endMs: pc.startMs + (Math.min(w.endMs, pc.clip.outSec * 1000) - inMs) / speed});
  }
  mentions.sort((a, b) => a.startMs - b.startMs);
  const black = [];
  for (const pc of placed) for (const s of blackSpans(pc.clip.src)) {
    const inMs = pc.clip.inSec * 1000, outMs = pc.clip.outSec * 1000, speed = pc.clip.speed ?? 1;
    const a = Math.max(s.startMs, inMs), b = Math.min(s.endMs, outMs);
    if (b > a) black.push({startMs: pc.startMs + (a - inMs) / speed, endMs: pc.startMs + (b - inMs) / speed});
  }
  const existing = projectBrolls(p.brolls, p.clips, FPS).map((b) => ({startMs: b.startMs, endMs: b.endMs}));
  const lastK = mentions.findLastIndex((m, i) => i > 0 && /[.!?]$/.test(mentions[i - 1].word));
  const totalMs = totalSec(p.clips) * 1000;
  const out = suggestBroll(mentions, lib, {totalMs, black, existing, lastSentenceStartMs: lastK > 0 ? mentions[lastK].startMs : undefined});
  if (!out.length) return text(`${lib.length ? 'No mention matches the library tags' : 'The library has no tagged assets'}${black.length ? '' : ', and there is no black footage to cover'}.${lib.length ? '' : ' add_broll_assets + tag_broll_asset first, or use search_stock.'}`);
  const lines = out.map((s) => `${s.cover ? 'COVER ' : '      '}${f1(s.startMs / 1000)}–${f1(s.endMs / 1000)}s  ${s.assetId ? `asset ${s.assetId}` : `search_stock "${s.query}"`}${s.atWid ? `  at_wid ${s.atWid}` : ''}  — ${s.why}`);
  return text(`${out.length} suggestion(s) (COVER = black footage that must be covered):\n${lines.join('\n')}\n\nApply with add_broll {asset_id, at_wid, duration_sec, mode: 'fullscreen' for covers}.`);
});

server.registerTool('edit_broll', {description: 'Change a B-roll cue: mode, size scale, source URL/path, or move/resize it on the timeline (seconds).', inputSchema: {project_id: pid, broll_id: z.string(), mode: z.enum(['fullscreen', 'top', 'inset', 'card', 'carousel']).optional(), arrive: z.enum(['cut', 'slideUp', 'popFrom', 'slideRight']).optional(), leave: z.enum(['cut', 'slideDown', 'shrink', 'fall']).optional(), scale: z.number().min(0.3).max(3).optional(), src: z.string().optional(), start_sec: sec('new timeline start').optional(), end_sec: sec('new timeline end').optional()}}, async ({project_id, broll_id, mode, scale, src, start_sec, end_sec, arrive, leave}) => {
  const p = load(project_id); const b = p.brolls.find((x) => x.id === broll_id); if (!b) throw new Error(`no B-roll ${broll_id}`);
  if (mode) b.mode = mode; if (scale != null) b.scale = scale; if (src) { b.src = brollSrc(src); b.source = /^https?:/.test(b.src) ? 'pexels' : 'own'; b.kind = brollKind(b.src); delete b.assetId; }
  if (arrive) b.arrive = arrive; if (leave) b.leave = leave;
  if (start_sec != null) { const {clip, sourceSec} = locate(p, start_sec); b.clipId = clip.id; const len = b.endMs - b.startMs; b.startMs = Math.round(sourceSec * 1000); b.endMs = Math.min(Math.round(clip.outSec * 1000), b.startMs + len); }
  if (end_sec != null) { const {clip, sourceSec} = locate(p, end_sec); if (clip.id !== b.clipId) throw new Error('end must be on the same clip as the start'); b.endMs = Math.max(b.startMs + 300, Math.round(sourceSec * 1000)); }
  await save(project_id, p); return text(`${broll_id}: ${b.mode} ${b.kind}${b.scale ? ` scale ${b.scale}` : ''} @${f1(toAbs(p, b.clipId, b.startMs, true) ?? 0)}–${f1(toAbs(p, b.clipId, b.endMs, true) ?? 0)}s`);
});

server.registerTool('delete_brolls', {description: 'Delete B-roll cues by id.', inputSchema: {project_id: pid, broll_ids: z.array(z.string()).min(1)}}, async ({project_id, broll_ids}) => {
  const p = load(project_id); const gone = new Set(broll_ids); const before = p.brolls.length;
  p.brolls = p.brolls.filter((b) => !gone.has(b.id)); await save(project_id, p); return text(`Deleted ${before - p.brolls.length} B-roll cue(s)`);
});

let lastMusic = []; // the last search_music results, so set_music can take an id
server.registerTool('search_music', {description: 'Find music with a clean license (Openverse: CC0 and CC BY, commercial use allowed): mood or genre words ("upbeat corporate", "lo-fi chill", "cinematic piano", "reggaeton"). Nothing is downloaded until set_music picks an id; the credit line is kept with the project and must ship with the reel for CC BY tracks.', inputSchema: {query: z.string().min(2), limit: z.number().int().min(1).max(10).default(6), min_sec: z.number().min(5).default(20)}}, async ({query, limit, min_sec}) => {
  lastMusic = await searchMusic(query, {limit, minSec: min_sec});
  if (!lastMusic.length) return text(`No tracks for "${query}" — try other mood/genre words.`);
  return text(lastMusic.map((r) => `${r.id}  ${r.durationSec}s  ${r.license}  "${r.title}" — ${r.creator} (${r.source})`).join('\n'));
});

server.registerTool('set_music', {description: 'Set or remove the music track: music_id from search_music (downloaded, credit kept), or file = absolute path (copied into public/music) / "music/<name>" already there. volume 0–1 (0.25 under speech is plenty), fade_out_sec, duck = lower under speech. null file removes it.', inputSchema: {project_id: pid, music_id: z.string().optional(), file: z.string().nullable().optional(), volume: z.number().min(0).max(1).default(0.25), fade_out_sec: z.number().min(0).default(1.5), duck: z.boolean().default(true)}}, async ({project_id, music_id, file, volume, fade_out_sec, duck}) => {
  const p = load(project_id);
  if (file === null && !music_id) { p.music = null; await save(project_id, p); return text('Music removed'); }
  let src, credit;
  if (music_id) {
    const row = lastMusic.find((r) => r.id === music_id) ?? loadMusicLibrary().find((r) => r.id === music_id);
    if (!row) throw new Error(`no track ${music_id} — search_music first`);
    const entry = row.src && fs.existsSync(path.join(PUBLIC, row.src)) ? row : await downloadMusic(row);
    src = entry.src; credit = entry.credit ?? creditOf(entry);
  } else if (!file) throw new Error('give music_id or file');
  else if (path.isAbsolute(file)) { if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`); const dir = path.join(PUBLIC, 'music'); fs.mkdirSync(dir, {recursive: true}); const name = path.basename(file).replace(/[^\w.\-]/g, '_'); fs.copyFileSync(file, path.join(dir, name)); src = `music/${name}`; }
  else if (!fs.existsSync(path.join(PUBLIC, file))) throw new Error(`not found in public/: ${file}`);
  else src = file;
  p.music = {src, volume, startSec: 0, fadeOutSec: fade_out_sec, duck, duckLevel: 0.25, ...(credit ? {credit} : {})}; await save(project_id, p);
  return text(`Music ${src} vol ${volume}, fade ${fade_out_sec}s, duck ${duck}${credit ? `\nCredit to ship with the reel: ${credit}` : ''}`);
});

server.registerTool('set_audio', {description: `Audio options. clean = voice cleanup on the final render (drafts are untouched): ${Object.entries(CLEAN).map(([k, v]) => `${k} = ${v.desc}`).join('; ')} — light is safe on phone recordings with room noise, strong can dull sibilants. sfx = sound effects (synthesized, license-free): a whoosh on whip/zoom/card/split cuts and a pop on stickers/starbursts; off by default.`, inputSchema: {project_id: pid, clean: z.enum(Object.keys(CLEAN)).optional(), sfx: z.boolean().optional()}}, async ({project_id, clean, sfx}) => {
  const p = load(project_id); p.audio = {...(p.audio ?? {}), ...(clean != null ? {clean} : {}), ...(sfx != null ? {sfx} : {})}; await save(project_id, p);
  return text(`Audio: voice cleanup ${p.audio.clean ?? 'off'}, sfx ${p.audio.sfx ? 'on' : 'off'}`);
});

server.registerTool('set_speed_ramp', {description: 'Speed ramp across a clip, as steps (Remotion plays a clip at one rate): the clip becomes 2–6 pieces whose speed eases from from_speed to to_speed, e.g. 1 → 2.5 to rush through a walk-through, 2 → 1 to land on a reveal. Captions and graphics follow their words. Pieces start plain (add transitions after).', inputSchema: {project_id: pid, clip_id: z.string(), from_speed: z.number().min(0.25).max(4), to_speed: z.number().min(0.25).max(4), steps: z.number().int().min(2).max(6).default(3)}}, async ({project_id, clip_id, from_speed, to_speed, steps}) => {
  const p = load(project_id); const c = p.clips.find((x) => x.id === clip_id); if (!c) throw new Error(`no clip ${clip_id}`);
  const speeds = speedRamp(from_speed, to_speed, steps);
  const span = c.outSec - c.inSec; if (span / speeds.length < 0.3) throw new Error(`${clip_id} is too short for ${speeds.length} pieces`);
  let id = clip_id; const ids = [id];
  for (let k = 1; k < speeds.length; k++) {
    const r = splitClip(p.clips, id, c.inSec + (span * k) / speeds.length); if (!r) throw new Error('could not split');
    p.clips = r.clips; p.brolls = reanchor(p.brolls, r.remap); id = r.newId; ids.push(id);
  }
  ids.forEach((pid2, k) => { const piece = p.clips.find((x) => x.id === pid2); piece.speed = speeds[k]; });
  await save(project_id, p);
  return text(`Speed ramp on ${clip_id}: ${ids.map((x, k) => `${x} ×${speeds[k]}`).join(' → ')}\n\n${summary(project_id, p)}`);
});

// words of every clip (trim window), source-relative; `${source}:${i}` is a stable word id
async function transcript(p) {
  await runJob('/api/transcribe', {clips: p.clips, lang: p.lang ?? 'auto', offMic: p.offMic});
  return readPublic('transcript.json');
}
// a transcript word by id → the clip whose trim window holds it, with its neighbours on that clip
async function wordAt(p, wid, tr) {
  const [source, i] = String(wid).split(':');
  tr ??= await transcript(p);
  const t = tr.filter((x) => x.source === source).find((x) => x.words.some((w) => String(w.i) === i));
  if (!t) throw new Error(`no word ${wid} on the timeline (see get_transcript)`);
  const k = t.words.findIndex((w) => String(w.i) === i);
  return {clip: p.clips.find((c) => c.id === t.clipId), entry: t, word: t.words[k], k, prev: t.words[k - 1], next: t.words[k + 1]};
}
// off-mic words left in the cut + clip edges inside a word (src/validate.ts), from the last transcript run
function transcriptIssuesOf(p) {
  let tr; try { tr = readPublic('transcript.json'); } catch { return []; }
  return transcriptIssues(p, tr);
}

server.registerTool('get_transcript', {description: 'Word-level transcript of every clip, in timeline order. Each word is `i:word` where i indexes the clip\'s SOURCE transcript; refer to words as "<source>:<i>" in other tools — never by seconds. `[pause 0.8s]` marks gaps; `[spk1]` / `[spk2]` mark a change of speaker when the clip has more than one voice (diarization); `[off-mic: …]` wraps words of a quieter second voice away from the mic (someone behind the camera feeding lines — not the presenter). Transcribes on first call (cached per source; needs the backend).', inputSchema: {project_id: pid}}, async ({project_id}) => {
  const p = load(project_id); if (!p.clips.length) throw new Error('project has no clips');
  const tr = await transcript(p);
  const out = [];
  let offCount = 0;
  for (const pc of place(p.clips)) {
    const t = tr.find((x) => x.clipId === pc.clip.id);
    out.push(`clip ${pc.clip.id} (source ${t?.source ?? path.basename(pc.clip.src)}, @${f1(pc.startMs / 1000)}–${f1(pc.endMs / 1000)}s):`);
    if (!t?.words.length) { out.push('  (no speech)'); continue; }
    const toks = [];
    let inOff = false, spk = null;
    const multi = new Set(t.words.map((w) => w.speaker).filter(Boolean)).size > 1;
    t.words.forEach((w, k) => {
      const prev = t.words[k - 1];
      if (inOff && !w.off) { toks.push(']'); inOff = false; }
      if (prev && w.startMs - prev.endMs > 400) toks.push(`[pause ${f1((w.startMs - prev.endMs) / 1000)}s]`);
      if (multi && w.speaker && w.speaker !== spk) { toks.push(`[${w.speaker}]`); spk = w.speaker; }
      if (!inOff && w.off) { toks.push('[off-mic:'); inOff = true; }
      toks.push(`${w.i}:${w.word}`);
      if (w.off) offCount++;
    });
    if (inOff) toks.push(']');
    out.push('  ' + toks.join(' '));
  }
  if (offCount) out.unshift(`${offCount} words are [off-mic: …]: a quieter second voice away from the microphone (someone behind the camera feeding lines), NOT the presenter, who usually repeats the line right after. Keep the presenter's take; cut_words the off-mic one unless the brief says otherwise.${p.offMic === 'cut' ? ' (off-mic mode "cut": autocut removes them for you.)' : ''}`, '');
  return text(out.join('\n'));
});

server.registerTool('set_off_mic', {description: 'How to treat a quieter second voice away from the mic (a director feeding lines from behind the camera). With diarization (HF_TOKEN) the voice is identified by speaker and only its words are flagged; without it, by loudness per take. mark = flag those words as [off-mic: …] in get_transcript and let you decide (default); cut = autocut and captions drop them automatically; off = no detection (one-voice clips, or a presenter who whispers on purpose).', inputSchema: {project_id: pid, mode: z.enum(['mark', 'cut', 'off'])}}, async ({project_id, mode}) => {
  const p = load(project_id); p.offMic = mode; await save(project_id, p); return text(`Off-mic voice: ${mode}`);
});

server.registerTool('set_language', {description: 'Set the transcription language of the project: es, en, or auto (detect per clip). Transcripts are cached per language.', inputSchema: {project_id: pid, lang: z.enum(['auto', 'es', 'en'])}}, async ({project_id, lang}) => {
  const p = load(project_id); p.lang = lang; await save(project_id, p); return text(`Language: ${lang}`);
});

// ---------- motion graphics ----------
const TEMPLATE_HELP = Object.entries(TEMPLATES).map(([id, t]) => `${id} = ${t.desc}; props ${describeSchema(t.schema)}`).join('\n');
const nextId = (items, prefix) => { let n = 0; while (items.some((x) => x.id === `${prefix}${n}`)) n++; return `${prefix}${n}`; };
// where a graphic goes: a word id (start of that word) or a timeline second
async function anchorFor(p, {at_wid, at_sec}) {
  if (at_wid) { const {clip, word} = await wordAt(p, at_wid); return {src: clip.src, startMs: word.startMs}; }
  if (at_sec == null) throw new Error('give at_wid or at_sec');
  const {clip, sourceSec} = locate(p, at_sec);
  return {src: clip.src, startMs: Math.round(sourceSec * 1000)};
}

const MOTION_HELP = {
  reveal: 'how it arrives (the caption pack decides when omitted): blur = the template\'s own blur-in; letters = one character every ~42 ms, blurred (Elevate, Prime); typewriter = ~30 ms per character (Paper II, Lens, Align); shuffle = random glyphs resolving left→right in 290 ms (Align); tracking = letter-spacing settles 0.7→0.38 em (Align, Elevate); drop = falls in from above with a 1.3× zoom-out in 3 f (Stack); slideBlur = in from the right with motion blur (Prime GROWTH); slideDown = slides in from the top edge (Orbit); band = rises from the bottom edge (Focus band-title); wipe = a slanted sweep from the left (Lift); fade',
  out: 'how it leaves: fade (default) | cut | blur = wiped right→left through blur (Elevate) | letters = last character first, each scaling to 0 (Form) | slideUp (Lift) | band = drops out through the bottom edge (Focus)',
  life: 'what it does while on screen: grow = swells 1→1.3× over 1.2 s (Prime script) | marquee = slides ~17 px per frame, for oversized / word walls (Stack) | drift = slow ~65 px/s pan (Form) | oscillate = rocks ±3° (Prime) | none',
};
server.registerTool('add_graphic', {description: `Add a motion-graphics overlay (headline, label, stat, chapter) anchored to the footage. Templates:\n${TEMPLATE_HELP}\nAnchor with at_wid (word id from get_transcript, the graphic starts when that word starts) or at_sec. Keep the hook headline in the first 3 s; labels on room/feature mentions; ≤ 1 graphic on screen at a time.`, inputSchema: {project_id: pid, template: z.enum(Object.keys(TEMPLATES)), props: z.record(z.string(), z.any()), at_wid: z.string().optional(), at_sec: sec('timeline start').optional(), duration_sec: z.number().min(0.5).max(15).optional(), y_pct: z.number().min(0).max(90).optional().describe('block top, % of frame height; template default when omitted'), behind: z.boolean().default(false).describe('draw it BEHIND the presenter (big-word / word walls). Needs prepare_mattes afterwards'), reveal: z.enum(REVEAL_KINDS).optional().describe(MOTION_HELP.reveal), out: z.enum(OUT_KINDS).optional().describe(MOTION_HELP.out), life: z.enum(LIFE_KINDS).optional().describe(MOTION_HELP.life), camera: z.enum(['none', 'punch']).optional().describe('punch = the footage pushes in 1.4× with the title and settles back when it leaves (Orbit)')}}, async ({project_id, template, props, at_wid, at_sec, duration_sec, y_pct, behind, reveal, out, life, camera}) => {
  const p = load(project_id); if (!p.clips.length) throw new Error('project has no clips');
  const clean = parseProps(template, props);
  if (template === 'sticker' && !/^https?:/.test(clean.src) && !fs.existsSync(path.join(PUBLIC, clean.src))) throw new Error(`sticker src not found under public/: ${clean.src} (use search_asset or generate_asset first)`);
  const {src, startMs} = await anchorFor(p, {at_wid, at_sec});
  const g = {id: nextId(p.graphics, 'g'), src, startMs, endMs: startMs + Math.round((duration_sec ? duration_sec * 1000 : TEMPLATES[template].defaultMs)), template, props: clean};
  if (y_pct != null) g.yPct = y_pct;
  if (reveal) g.reveal = reveal; if (out) g.out = out; if (life) g.life = life; if (camera) g.camera = camera;
  if (behind) g.behind = true;
  p.graphics.push(g); await save(project_id, p);
  const warn = validateProject(p, FPS, facesOf(p)).filter((i) => i.ref === g.id);
  const wantsMatte = behind || MATTE_TEMPLATES.has(template) || (template === 'layout' && clean.cutout);
  return text(`Added ${g.id} ${template}${wantsMatte ? ' (needs the person matte — run prepare_mattes before rendering)' : ''}${warn.length ? '\n' + issuesText(warn) : ''}\n\n${summary(project_id, p)}`);
});

server.registerTool('search_asset', {description: 'Find decorative assets with clean licenses: icons and emoji (Iconify: Fluent Emoji, Noto, Lucide, Phosphor…), stickers and illustrations (Iconify hand-drawn sets + Openverse CC0/CC-BY). Files are downloaded under public/assets/ so you can use them with add_graphic template=sticker. Returns license and, when required, the credit line to keep.', inputSchema: {query: z.string().min(1), kind: z.enum(['icon', 'emoji', 'sticker', 'illustration']).default('sticker'), style: z.enum(['flat', '3d', 'hand-drawn', 'outline']).optional(), limit: z.number().int().min(1).max(12).default(6)}}, async ({query, kind, style, limit}) => {
  const rows = await searchAssets({query, kind, style, limit});
  if (!rows.length) return text(`No assets found for "${query}" — try other words, another kind/style, or generate_asset.`);
  return text(rows.map((r) => `${r.id}${r.fromLibrary ? '  [library]' : ''}\n  src: ${r.src}  (${r.format}, ${r.license}, ${r.source})${r.credit ? `\n  credit: ${r.credit}` : ''}${r.title ? `\n  title: ${r.title}` : ''}`).join('\n'));
});

server.registerTool('list_assets', {description: 'Browse the local asset library (everything ever searched or generated on this machine, with license and credit). Reuse before searching or generating again.', inputSchema: {query: z.string().optional().describe('words to match against tags/title/prompt; omit for the newest 30'), kind: z.enum(['icon', 'emoji', 'sticker', 'illustration', 'doodle', 'texture', 'ui']).optional()}}, async ({query, kind}) => {
  const rows = query ? librarySearch(query, {kind, limit: 30}) : listLibrary().filter((e) => !kind || e.kind === kind).slice(-30).reverse();
  if (!rows.length) return text('Library is empty for that query.');
  return text(rows.map((r) => `${r.id}  src: ${r.src}  (${r.kind}, ${r.license})${r.credit ? `  credit: ${r.credit}` : ''}${r.prompt ? `  prompt: ${r.prompt}` : ''}`).join('\n'));
});

server.registerTool('generate_asset', {description: 'LAST RESORT: generate an image asset with the OpenAI Images API (transparent PNG; the user pays per image). Searching is free, so this tool first looks in the local library and the search sources for the same idea and returns those instead of generating; pass force=true only when none of them fits. kind wraps the prompt: sticker (die-cut flat vector), doodle (hand-drawn marker), texture (seamless, opaque), ui (flat mockup). Describe the object only — style comes from kind. Then place it with add_graphic template=sticker.', inputSchema: {prompt: z.string().min(3).max(400), kind: z.enum(['sticker', 'doodle', 'texture', 'ui']).default('sticker'), size: z.enum(['1024x1024', '1024x1536', '1536x1024']).default('1024x1024'), quality: z.enum(['low', 'medium', 'high']).default('medium'), force: z.boolean().default(false).describe('generate even if existing assets match')}}, async ({prompt, kind, size, quality, force}) => {
  const r = await findOrGenerate({prompt, kind, size, quality, force, apiKey: ENV.OPENAI_API_KEY || process.env.OPENAI_API_KEY, model: ENV.REEL_IMAGE_MODEL || process.env.REEL_IMAGE_MODEL || 'gpt-image-1.5'});
  if (r.found) return text(`Not generated — ${r.found.length} existing asset(s) match "${prompt}". Use one of these, or call again with force=true if none fits:\n` + r.found.map((x) => `${x.id}${x.fromLibrary ? '  [library]' : ''}\n  src: ${x.src}  (${x.format}, ${x.license}${x.source ? ', ' + x.source : ''})${x.credit ? `\n  credit: ${x.credit}` : ''}${x.prompt ? `\n  prompt: ${x.prompt}` : ''}`).join('\n'));
  const g = r.generated;
  return text(`${g.cached ? `Reused ${g.src} (already generated${g.reusedPrompt ? ` for "${g.reusedPrompt}"` : ''})` : `Generated ${g.src} (${g.model}${g.usage?.output_tokens ? `, ${g.usage.output_tokens} output tokens` : ''})`}`);
});

server.registerTool('set_grade', {description: `Color for the whole reel: a bounded automatic correction per source (measured on its lit frames: stretches flat footage, nudges exposure and color cast, lifts dull saturation — never restyles) plus one look. Looks: ${Object.values(LOOKS).map((l) => `${l.id} = ${l.desc}`).join('; ')}. intensity 0–1 (0.8 default). Look at the result with caption_proof (frame_at shows the raw source). Needs the backend the first time a source is analyzed.`, inputSchema: {project_id: pid, look: z.enum(Object.keys(LOOKS)).default(DEFAULT_LOOK), intensity: z.number().min(0).max(1).default(0.8), auto: z.boolean().default(true).describe('the per-source correction; false = look only')}}, async ({project_id, look, intensity, auto}) => {
  const p = load(project_id); if (!p.clips.length) throw new Error('project has no clips');
  let bySrc = {}, notes = [];
  if (auto) {
    await runJob('/api/grade', {clips: p.clips});
    const r = readPublic('grade.json');
    bySrc = r.bySrc ?? {};
    for (const [src, g] of Object.entries(bySrc)) {
      const s = r.stats[src];
      notes.push(`${path.basename(src)}: tones ${Math.round(s.yLow)}–${Math.round(s.yHigh)} → contrast ×${g.slope[0]}, saturation ×${g.saturation}${g.intercept.some((i, c) => Math.abs(i - g.intercept[1]) > 0.004) ? ', color cast corrected' : ''}`);
    }
  }
  p.grade = {look, intensity, auto, bySrc};
  await save(project_id, p);
  return text(`Color: look ${look} at ${intensity}${auto ? `, automatic correction per source:\n  ${notes.join('\n  ') || 'nothing measurable'}` : ' (no automatic correction)'}`);
});

server.registerTool('prepare_mattes', {description: 'Cut the presenter out of the footage (MediaPipe, local, ~30 fps) for every span that has a graphic or caption page marked behind=true, so they render behind the person. Idempotent; only new spans are computed. Needs the backend.', inputSchema: {project_id: pid}}, async ({project_id}) => {
  const p = load(project_id);
  const spans = spansWithoutMatte([...p.graphics, ...p.captions], p.mattes, p.clips);
  if (!spans.length) return text('Nothing to matte: every behind-span already has a matte (or no graphic is marked behind).');
  await runJob('/api/matte', {spans});
  const done = readPublic('mattes.json');
  p.mattes = [...p.mattes, ...(Array.isArray(done) ? done : [])];
  await save(project_id, p);
  return text(`Matted ${done.length} span(s): ${done.map((m) => `${path.basename(m.src)} ${f1(m.startMs / 1000)}–${f1(m.endMs / 1000)}s`).join(', ')}`);
});

server.registerTool('edit_graphic', {description: 'Change a graphic: props (validated for its template), timing (seconds, timeline), y position, or its motion (reveal / out / life / camera, see add_graphic).', inputSchema: {project_id: pid, graphic_id: z.string(), props: z.record(z.string(), z.any()).optional(), start_sec: sec('new timeline start').optional(), duration_sec: z.number().min(0.5).max(15).optional(), y_pct: z.number().min(0).max(90).optional(), reveal: z.enum(REVEAL_KINDS).optional(), out: z.enum(OUT_KINDS).optional(), life: z.enum(LIFE_KINDS).optional(), camera: z.enum(['none', 'punch']).optional()}}, async ({project_id, graphic_id, props, start_sec, duration_sec, y_pct, reveal, out, life, camera}) => {
  const p = load(project_id); const g = p.graphics.find((x) => x.id === graphic_id); if (!g) throw new Error(`no graphic ${graphic_id}`);
  if (props) g.props = parseProps(g.template, {...g.props, ...props});
  if (start_sec != null) { const a = await anchorFor(p, {at_sec: start_sec}); const len = g.endMs - g.startMs; g.src = a.src; g.startMs = a.startMs; g.endMs = a.startMs + len; }
  if (duration_sec != null) g.endMs = g.startMs + Math.round(duration_sec * 1000);
  if (y_pct != null) g.yPct = y_pct;
  if (reveal) g.reveal = reveal; if (out) g.out = out; if (life) g.life = life; if (camera) g.camera = camera;
  await save(project_id, p); return text(`${graphic_id}: ${g.template} ${JSON.stringify(g.props)}`);
});

server.registerTool('delete_graphics', {description: 'Delete graphics by id.', inputSchema: {project_id: pid, graphic_ids: z.array(z.string()).min(1)}}, async ({project_id, graphic_ids}) => {
  const p = load(project_id); const gone = new Set(graphic_ids); p.graphics = p.graphics.filter((g) => !gone.has(g.id)); await save(project_id, p); return text(`Deleted ${graphic_ids.join(', ')}`);
});

server.registerTool('set_caption_style', {description: `The STYLE PACK of the reel — one of the 20 Captions.ai looks, or the three real-estate references. A pack sets the caption look, the palette and faces (unless a brand kit or a project accent is set), the family of transitions, how B-roll cues arrive and leave, and the frame the style lives in. Packs: ${Object.values(PACKS).map((x) => `${x.id} = ${x.desc} [cuts: ${x.transition}${x.brollMode ? `, B-roll: ${x.brollMode}` : ''}${x.layout ? `, frame: ${x.layout.shape} on ${x.layout.canvas}` : ''}]`).join('; ')}. References: ${['palabra', 'caja', 'tracked'].map((id) => `${id} = ${PRESETS[id].desc}`).join('; ')}. Re-pages the generated captions for the new pack, keeping word tiers and hand-added pages. Needs the backend.`, inputSchema: {project_id: pid, style: z.enum(Object.keys(PRESETS))}}, async ({project_id, style}) => {
  const p = load(project_id); p.captionStyle = style;
  if (p.clips.length && p.captions.length) {
    await runJob('/api/captions', {clips: p.clips, lang: p.lang ?? 'auto', style, offMic: p.offMic});
    const fresh = readPublic('captions.multi.json');
    // generated pages are re-paged; hand-made ones, deleted words and tiers survive
    // (a project from before word ids has no way to tell: everything is re-paged)
    const legacy = !p.captions.some((c) => c.words.some((w) => w.wid));
    const merged = mergeCaptions(legacy ? [] : p.captions, Array.isArray(fresh) ? fresh : [], p.clips, {hidden: p.hiddenWids, replace: true});
    p.captions = reapplyTiers(p.captions, merged.captions);
  }
  await save(project_id, p);
  return text(`Caption style: ${style} (${p.captions.length} pages)\n\n${summary(project_id, p)}`);
});

server.registerTool('annotate_captions', {description: 'Set per-word emphasis by word id ("<source>:<i>" from get_transcript). tier 0 = plain; 1 = the pack\'s key-word treatment (bigger, bold italic gradient, pill or block, script…) — sparing, 1–2 per sentence, only meaning words (numbers, names, claims, the punchline); 2 = the pack\'s hero treatment (largest; in prism the footage blurs behind the word) — rare, at most one per 10 s, on the one word the reel is about. Never on function words. emoji = one emoji that pops in after the word (money → 💰; "" removes it) — a few per reel, on concrete nouns and feelings, never on function words. Returns each word it touched (check the text matches what you meant) plus warnings.', inputSchema: {project_id: pid, items: z.array(z.object({wid: z.string(), tier: z.number().int().min(0).max(2).optional(), emoji: z.string().max(16).optional()})).min(1)}}, async ({project_id, items}) => {
  const p = load(project_id);
  for (const x of items) if (x.emoji && !oneEmoji(x.emoji)) throw new Error(`${x.wid}: emoji must be exactly one emoji, got "${x.emoji}"`);
  const want = new Map(items.map((x) => [x.wid, x]));
  const applied = []; const warn = [];
  for (const c of p.captions) for (const w of c.words) if (w.wid && want.has(w.wid)) {
    const {tier, emoji} = want.get(w.wid);
    if ((tier || emoji) && isGlue(w.text)) warn.push(`${w.wid} "${w.text}": ${emoji ? 'emoji' : 'emphasis'} on a function word`);
    if (tier != null) w.tier = tier;
    if (emoji != null) { if (emoji) w.emoji = emoji; else delete w.emoji; }
    applied.push(`${w.wid} "${w.text}"${tier != null ? ` tier ${tier}` : ''}${emoji != null ? ` ${emoji || 'no emoji'}` : ''}`); want.delete(w.wid);
  }
  for (const wid of want.keys()) warn.push(`${wid}: no caption word with that id (generate captions first, or it was cut away)`);
  const t2 = p.captions.flatMap((c) => c.words).filter((w) => w.tier === 2).length;
  const dur = totalSec(p.clips);
  if (t2 > Math.max(1, dur / 10)) warn.push(`${t2} tier-2 words in ${f1(dur)}s — aim for at most one per 10 s`);
  await save(project_id, p);
  return text(`Applied ${applied.length}: ${applied.join('; ')}${warn.length ? '\nWARN ' + warn.join('\nWARN ') : ''}\n\n${summary(project_id, p)}`);
});

server.registerTool('run_ai_step', {description: 'Run one deterministic pipeline step on the project, exactly like the editor buttons, and apply the result. autocut = remove silence/pauses (splits clips into segments); captions = WhisperX words → caption pages + face-aware placement (keeps existing captions on clips that already have them). Ordering takes, emphasis and B-roll are YOUR job: use get_transcript, reorder_clips/delete_clips, edit_caption, search_stock/add_broll. Needs the backend (npm start).', inputSchema: {project_id: pid, step: z.enum(['autocut', 'captions'])}}, async ({project_id, step}) => {
  let p = load(project_id); if (!p.clips.length) throw new Error('project has no clips');
  const lang = p.lang ?? 'auto';
  if (step === 'autocut') {
    await runJob('/api/trim-silence', {clips: p.clips, lang, offMic: p.offMic}); const {plan} = readPublic('trim-silence.json');
    if (!Array.isArray(plan) || !plan.length) return text('Nothing to cut');
    const r = applyAutocut(p.clips, plan); p.clips = r.clips; p.brolls = reanchor(p.brolls, r.remap); await save(project_id, p);
    return text(`Autocut: ${plan.reduce((n, x) => n + (x.segments?.length ?? 0), 0)} segments${p.offMic === 'cut' ? ' (off-mic voice removed)' : ''}\n\n${summary(project_id, p)}`);
  }
  await runJob('/api/captions', {clips: p.clips, lang, style: p.captionStyle, offMic: p.offMic}); const fresh = readPublic('captions.multi.json');
  const {captions, added} = mergeCaptions(p.captions, Array.isArray(fresh) ? fresh : [], p.clips, {hidden: p.hiddenWids}); p.captions = captions; await save(project_id, p);
  return text(`Captions: +${added} new (${p.captions.length} total)\n\n${summary(project_id, p)}`);
});

// ---------- verification ----------
const issuesText = (issues) => (issues.length ? issues.map((i) => `${i.level === 'error' ? 'ERR ' : 'WARN'} ${i.code}: ${i.msg}`).join('\n') : 'OK — no issues');
// face boxes the captions job detected (public/clips/faces/<source>.json), by clip src
const facesOf = (p) => Object.fromEntries(p.clips.map((c) => { try { return [c.src, JSON.parse(fs.readFileSync(path.join(PUBLIC, 'clips', 'faces', `${path.basename(c.src).replace(/\.[^.]+$/, '')}.json`), 'utf8'))]; } catch { return [c.src, undefined]; } }));
const allIssues = (p) => [...validateProject(p, FPS, facesOf(p)), ...transcriptIssuesOf(p)];
const projectProps = (p) => ({clips: p.clips, music: p.music, captions: p.captions, brolls: p.brolls, graphics: p.graphics, mattes: p.mattes, accentColor: p.accentColor, captionStyle: p.captionStyle, brand: p.brand, grade: p.grade, audio: p.audio, captionsOff: p.captionsOff});

server.registerTool('validate', {description: 'Deterministic checks before rendering: Reels safe zones, captions ending on function words, timing, emphasis density, caption/graphic overlaps, graphics on screen at the same time, behind-graphics without a matte, missing hook. Geometry is estimated — confirm visually with caption_proof.', inputSchema: {project_id: pid}}, async ({project_id}) => {
  const p = load(project_id);
  return text(issuesText(allIssues(p)));
});

server.registerTool('caption_proof', {description: 'LOOK at the result without a full render: renders up to 8 stills of the current project (default: spread over the pages with emphasis and every graphic) and returns them as one contact sheet plus the validate report. Use it after annotating captions or adding graphics; fix what looks wrong and call again.', inputSchema: {project_id: pid, at_secs: z.array(sec('timeline time')).max(8).optional().describe('times to look at; omit to pick automatically')}}, async ({project_id, at_secs}) => {
  const p = load(project_id); if (!p.clips.length) throw new Error('project has no clips');
  let times = at_secs;
  if (!times?.length) {
    const caps = p.captionsOff ? [] : projectCaptions(p.captions, p.clips, FPS);
    const gfx = projectGraphics(p.graphics, p.clips, FPS).filter((g) => g.template !== 'layout');
    const picks = [...gfx.map((g) => (g.startMs + Math.min(1200, (g.endMs - g.startMs) * 0.6)) / 1000), ...caps.filter((c) => c.words.some((w) => w.tier)).map((c) => (c.startMs + (c.endMs - c.startMs) * 0.7) / 1000)];
    const total = totalSec(p.clips);
    if (!picks.length) picks.push(...[0.15, 0.4, 0.65, 0.9].map((f) => f * total));
    times = [...new Set(picks.map((t) => Math.round(t * 10) / 10))].sort((a, b) => a - b).slice(0, 8);
  }
  const outDir = path.join(ROOT, '.captions-tmp', `proof-${Date.now()}`);
  const {sheet, cols} = await renderProof(projectProps(p), times, outDir);
  const data = fs.readFileSync(sheet).toString('base64');
  fs.rmSync(outDir, {recursive: true, force: true});
  return {content: [
    {type: 'text', text: `Contact sheet of STILLS (not the render: each still is labeled on a yellow strip below the frame; gray tiles are empty slots — the video itself is full-frame 1080x1920, no bars), ${cols} per row, left→right top→bottom at ${times.map((t) => f1(t) + 's').join(', ')}. When you show this to the user, say it is a still proof.\n\nvalidate:\n${issuesText(allIssues(p))}`},
    {type: 'image', data, mimeType: 'image/jpeg'},
  ]};
});

server.registerTool('motion_proof', {description: 'SEE the motion: 24 consecutive frames (0.8 s at 30 fps) from a timeline time, tiled 8 per row left→right, top→bottom. Use it on a word arrival, a transition, a title or a B-roll cue to check timing and easing; caption_proof shows single stills.', inputSchema: {project_id: pid, at_sec: sec('timeline time to start from')}}, async ({project_id, at_sec}) => {
  const p = load(project_id); if (!p.clips.length) throw new Error('project has no clips');
  const outDir = path.join(ROOT, '.captions-tmp', `strip-${Date.now()}`);
  const {sheet, first, fps} = await renderStrip(projectProps(p), at_sec, outDir);
  const data = fs.readFileSync(sheet).toString('base64');
  fs.rmSync(outDir, {recursive: true, force: true});
  return {content: [{type: 'text', text: `24 frames from ${f1(first / fps)}s (1 frame = ${Math.round(1000 / fps)} ms), 8 per row, left→right then down`}, {type: 'image', data, mimeType: 'image/jpeg'}]};
});

server.registerTool('render', {description: 'Export the project to mp4 (1080x1920). draft = half resolution, fast, audio untouched. A final render is loudness-normalized (two-pass, −14 LUFS, true peak ≤ −1 dBTP) and must pass the QC gate (size, duration, audio, loudness); if it does not, the render fails with the reasons. Returns the file path.', inputSchema: {project_id: pid, draft: z.boolean().default(false)}}, async ({project_id, draft}) => {
  const p = load(project_id); if (!p.clips.length) throw new Error('project has no clips');
  const r = await runJob('/api/render', {...projectProps(p), draft});
  const file = path.join(PUBLIC, r.file.replace(/^\//, ''));
  return text(`Rendered ${draft ? '(draft) ' : ''}→ ${file}  (${(fs.statSync(file).size / 1e6).toFixed(1)} MB, ${f1(totalSec(p.clips))}s)${r.qc ? `\nQC passed:\n${r.qc}` : ''}`);
});

server.registerTool('qc', {description: 'Check a rendered mp4 from render: frame size, duration against the project, audio present, loudness −14 ±1 LUFS and true peak ≤ −1 dBTP (blocking on final renders; drafts are not normalized, so there they are only reported), plus warnings for silent (≥ 2 s) or black (≥ 0.5 s) stretches. Final renders already run this gate.', inputSchema: {project_id: pid, file: z.string().describe('path returned by render')}}, async ({project_id, file}) => {
  const p = load(project_id);
  const f = path.isAbsolute(file) && fs.existsSync(file) ? path.resolve(file) : path.join(PUBLIC, file.replace(/^\//, '')); // absolute (from render) or /exports/…
  if (!f.startsWith(path.join(PUBLIC, 'exports') + path.sep)) throw new Error('file must be a render under public/exports/');
  const draft = /-draft\.mp4$/.test(f);
  const r = qc(f, {expectSec: totalSec(p.clips), draft});
  return text(`${r.ok ? 'QC passed' : 'QC FAILED'}${draft ? ' (draft: loudness is normalized on the final render only)' : ''}\n${qcText(r)}`);
});

server.registerTool('frame_at', {description: 'Look at a frame. Without `video`: the raw source frame at that timeline time (no captions/B-roll). With `video` = a rendered mp4 path from render: the finished frame with everything on it.', inputSchema: {project_id: pid, at_sec: sec('timeline time in seconds'), video: z.string().optional()}}, async ({project_id, at_sec, video}) => {
  const p = load(project_id);
  let file, t;
  if (video) { file = video; t = at_sec; } else { const {clip, sourceSec} = locate(p, at_sec); file = path.join(PUBLIC, clip.src); t = sourceSec; }
  if (!fs.existsSync(file)) throw new Error(`not found: ${file}`);
  const out = path.join(ROOT, '.captions-tmp', `mcp-frame-${Date.now()}.jpg`); fs.mkdirSync(path.dirname(out), {recursive: true});
  const ff = spawnSync('ffmpeg', ['-y', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=540:-2', '-q:v', '4', out]);
  if (ff.status !== 0 || !fs.existsSync(out)) throw new Error('ffmpeg could not extract the frame');
  const data = fs.readFileSync(out).toString('base64'); fs.rmSync(out, {force: true});
  return {content: [{type: 'text', text: `${video ? 'rendered' : 'source'} frame @${f1(at_sec)}s`}, {type: 'image', data, mimeType: 'image/jpeg'}]};
});

server.registerTool('health', {description: 'Check the reel-agent environment (backend, ffmpeg, WhisperX, API keys).', inputSchema: {}}, async () => {
  if (!(await backendUp())) return text(`Backend not running at ${API}. Run \`npm start\` in ${ROOT}. Pure edits still work; AI steps and render need it.`);
  const h = await fetch(`${API}/api/health`).then((r) => r.json());
  return text(h.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.label}${c.ok ? '' : ' — ' + c.hint}`).join('\n'));
});

await server.connect(new StdioServerTransport());
