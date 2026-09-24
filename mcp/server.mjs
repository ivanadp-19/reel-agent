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
import {applyAutocut, placeClips, reanchor, splitClip} from '../src/timeline.ts';
import {mergeCaptions, normalizeCaption, projectCaptions} from '../src/captions.ts';
import {isGlue, reapplyTiers} from '../src/paging.ts';
import {PRESETS} from '../src/captionPresets.ts';
import {TEMPLATES, isTemplate, parseProps, projectGraphics} from '../src/graphicTemplates.ts';
import {searchAssets, generateAsset, listLibrary, librarySearch} from './assets.mjs';

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
  p.clips ??= []; p.captions ??= []; p.brolls ??= []; p.brollAssets ??= []; p.music ??= null; p.accentColor ??= '#FFB020'; p.lang ??= 'auto'; p.captionStyle ??= 'palabra'; p.captions = p.captions.map(normalizeCaption); p.graphics ??= [];
  return p;
}
async function save(id, p) {
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
// absolute timeline second → {clip, sourceSec}
function locate(p, atSec) {
  const ms = atSec * 1000;
  const pc = place(p.clips).find((x) => ms >= x.startMs && ms < x.endMs) ?? place(p.clips).at(-1);
  if (!pc) throw new Error('project has no clips');
  const speed = pc.clip.speed ?? 1;
  const sourceSec = pc.clip.inSec + ((ms - pc.startMs) / 1000) * speed;
  return {clip: pc.clip, sourceSec: Math.min(pc.clip.outSec, Math.max(pc.clip.inSec, sourceSec)), pc};
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
const capText = (c) => c.words.map((w) => (w.tier === 2 ? `**${w.text}**` : w.tier ? `*${w.text}*` : w.text)).join(' ');

function summary(id, p) {
  const out = [];
  out.push(`Project "${p.name || 'Untitled project'}" (id ${id}) — ${f1(totalSec(p.clips))}s, ${p.clips.length} clips, ${p.captions.length} captions, ${p.brolls.length} B-roll, music ${p.music ? path.basename(p.music.src) + ` vol ${p.music.volume}` : 'none'}, accent ${p.accentColor}, lang ${p.lang}, caption style ${p.captionStyle}`);
  out.push('', 'CLIPS (timeline order):');
  place(p.clips).forEach((pc, i) => {
    const c = pc.clip;
    const extra = [c.speed && c.speed !== 1 ? `speed ${c.speed}x` : '', c.muted ? 'muted' : '', c.volume != null && c.volume !== 1 ? `vol ${c.volume}` : '', c.transform?.length ? `${c.transform.length} keyframes` : ''].filter(Boolean).join(', ');
    out.push(`  ${i + 1}. ${c.id}  @${f1(pc.startMs / 1000)}–${f1(pc.endMs / 1000)}s  source ${path.basename(c.src)} [${f1(c.inSec)}–${f1(c.outSec)} of ${f1(c.sourceDurationSec)}s]${extra ? '  ' + extra : ''}`);
  });
  out.push('', 'CAPTIONS (timeline time; *word* = tier 1 accent, **word** = tier 2 emphasis; word ids come from get_transcript):');
  const caps = projectCaptions(p.captions, p.clips, FPS);
  for (const c of caps) out.push(`  ${c.id}  @${f1(c.startMs / 1000)}s  top ${c.topPct}%${c.scale && c.scale !== 1 ? ` scale ${c.scale}` : ''}  "${capText(c)}"`);
  const hidden = p.captions.filter((c) => !caps.some((x) => x.id === c.id)).length;
  if (hidden) out.push(`  (+${hidden} captions on trimmed-away parts, not shown)`);
  out.push('', 'B-ROLL:');
  for (const b of p.brolls) {
    const at = b.clipId ? toAbs(p, b.clipId, b.startMs) : b.startMs / 1000;
    const end = b.clipId ? toAbs(p, b.clipId, b.endMs, true) : b.endMs / 1000;
    out.push(`  ${b.id}  @${at == null ? '?' : f1(at)}–${end == null ? '?' : f1(end)}s  ${b.mode} ${b.kind}${b.scale && b.scale !== 1 ? ` scale ${b.scale}` : ''}  ${b.query ? `"${b.query}"` : ''} ${b.source ?? ''} ${/^https?:/.test(b.src) ? '' : path.basename(b.src)}`.replace(/\s+/g, ' '));
  }
  if (!p.brolls.length) out.push('  none');
  out.push('', 'GRAPHICS (timeline time):');
  for (const g of projectGraphics(p.graphics, p.clips, FPS)) out.push(`  ${g.id}  @${f1(g.startMs / 1000)}–${f1(g.endMs / 1000)}s  ${g.template}${g.yPct != null ? ` y ${g.yPct}%` : ''}  ${JSON.stringify(g.props)}`);
  if (!p.graphics.length) out.push('  none');
  if (p.brollAssets.length) out.push('', `OWN FOOTAGE (for B-roll): ${p.brollAssets.map((a) => `${a.id} (${a.kind}, ${a.label})`).join(', ')}`);
  return out.join('\n');
}

// ---------- backend jobs ----------
async function runJob(route, body, maxSec = 1800) {
  await needBackend();
  const {jobId, error} = await fetch(`${API}${route}`, {method: 'POST', body: JSON.stringify(body)}).then((r) => r.json());
  if (!jobId) throw new Error(error || `${route} did not start`);
  const t0 = Date.now();
  for (;;) {
    const s = await fetch(`${API}${route}/${jobId}`).then((r) => r.json());
    if (s.status === 'done') return s;
    if (s.status === 'error') throw new Error(s.error || `${route} failed`);
    if (s.status === 'unknown') throw new Error('job vanished (backend restarted?)');
    if ((Date.now() - t0) / 1000 > maxSec) throw new Error(`${route} timed out`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}
const readPublic = (f) => JSON.parse(fs.readFileSync(path.join(PUBLIC, f), 'utf8'));

const renumber = (items, prefix) => items.map((x, i) => ({...x, id: `${prefix}${i}`}));

// retime new words evenly across the old page span
function retext(cap, text) {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error('empty caption text');
  const span = cap.endMs - cap.startMs;
  const step = span / words.length;
  return {...cap, words: words.map((t, i) => ({text: t, startMs: Math.round(cap.startMs + i * step), endMs: Math.round(cap.startMs + (i + 1) * step), tier: 0}))};
}
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9%$]/gi, '');

// ---------- Pexels ----------
async function pexels(query, kind, count) {
  const key = ENV.PEXELS_API_KEY || process.env.PEXELS_API_KEY;
  if (!key) throw new Error('PEXELS_API_KEY missing in .env');
  const url = kind === 'video'
    ? `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=portrait`
    : `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=portrait`;
  const d = await fetch(url, {headers: {Authorization: key}}).then((r) => r.json());
  if (kind === 'video') {
    return (d.videos ?? []).map((v) => {
      const files = (v.video_files ?? []).filter((f) => f.file_type === 'video/mp4' && f.height);
      const tall = files.filter((f) => f.height >= 1920).sort((a, b) => a.height - b.height);
      const pick = tall[0] ?? files.sort((a, b) => b.height - a.height)[0];
      return pick ? {src: pick.link, duration: v.duration, size: `${pick.width}x${pick.height}`, page: v.url} : null;
    }).filter(Boolean);
  }
  return (d.photos ?? []).map((ph) => ({src: ph.src?.large2x || ph.src?.large, alt: ph.alt, page: ph.url})).filter((x) => x.src);
}

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

server.registerTool('set_accent_color', {description: 'Set the caption accent (highlight) color, hex like #FFB020.', inputSchema: {project_id: pid, color: z.string().regex(/^#[0-9a-fA-F]{6}$/)}}, async ({project_id, color}) => { const p = load(project_id); p.accentColor = color; await save(project_id, p); return text(`Accent color ${color}`); });

server.registerTool('add_clips', {description: 'Add video files to a project (absolute paths on this machine). Uploads through the backend (remux + thumbnail). New project if project_id is omitted.', inputSchema: {project_id: pid.optional(), files: z.array(z.string()).min(1), name: z.string().optional()}}, async ({project_id, files, name}) => {
  await needBackend();
  const id = project_id || `p-${Date.now()}`;
  const p = project_id ? load(project_id) : {name: name || 'Untitled project', clips: [], captions: [], brolls: [], brollAssets: [], music: null, accentColor: '#FFB020', lang: 'auto'};
  const added = [];
  for (const f of files) {
    if (!fs.existsSync(f)) throw new Error(`file not found: ${f}`);
    const r = await fetch(`${API}/api/add-clip?name=${encodeURIComponent(path.basename(f))}`, {method: 'POST', body: fs.readFileSync(f)}).then((x) => x.json());
    if (!r.id) throw new Error(`upload failed for ${f}: ${r.error ?? ''}`);
    p.clips.push(r); added.push(`${r.id} (${f1(r.outSec)}s)`);
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

server.registerTool('delete_clips', {description: 'Remove clips from the timeline (their captions/B-roll go with them).', inputSchema: {project_id: pid, clip_ids: z.array(z.string()).min(1)}}, async ({project_id, clip_ids}) => {
  const p = load(project_id); const gone = new Set(clip_ids);
  p.clips = p.clips.filter((c) => !gone.has(c.id)); p.captions = p.captions.filter((c) => p.clips.some((k) => k.src === c.src)); p.graphics = p.graphics.filter((g) => p.clips.some((k) => k.src === g.src)); p.brolls = p.brolls.filter((b) => !b.clipId || !gone.has(b.clipId));
  await save(project_id, p); return text(summary(project_id, p));
});

server.registerTool('split_clip', {description: 'Split the clip under a timeline time into two (like pressing S at the playhead). To cut a moment out: split twice, then delete_clips the middle piece.', inputSchema: {project_id: pid, at_sec: sec('timeline time in seconds')}}, async ({project_id, at_sec}) => {
  const p = load(project_id); const {clip, sourceSec} = locate(p, at_sec);
  if (sourceSec - clip.inSec < 0.2 || clip.outSec - sourceSec < 0.2) throw new Error('too close to the clip edge (min 0.2 s each side)');
  const r = splitClip(p.clips, clip.id, sourceSec); if (!r) throw new Error('could not split');
  p.clips = r.clips; p.brolls = reanchor(p.brolls, r.remap); // captions follow their source on their own
  await save(project_id, p); return text(`Split ${clip.id} at ${f1(at_sec)}s → ${clip.id} + ${r.newId}\n\n${summary(project_id, p)}`);
});

server.registerTool('set_keyframes', {description: 'Replace a clip\'s zoom/pan keyframes. t = source-time seconds; scale 1 = none; x/y = pan in px of the 1080x1920 frame. Empty list removes the animation. Two keyframes = smooth move between them.', inputSchema: {project_id: pid, clip_id: z.string(), keyframes: z.array(z.object({t: z.number(), scale: z.number().min(0.5).max(4), x: z.number().default(0), y: z.number().default(0)}))}}, async ({project_id, clip_id, keyframes}) => {
  const p = load(project_id); const c = p.clips.find((x) => x.id === clip_id); if (!c) throw new Error(`no clip ${clip_id}`);
  c.transform = keyframes.length ? [...keyframes].sort((a, b) => a.t - b.t) : undefined;
  await save(project_id, p); return text(`${clip_id}: ${keyframes.length} keyframes`);
});

server.registerTool('edit_caption', {description: 'Edit one caption page: new text (words are re-timed evenly across the page), which words to accent (gold), vertical position top_pct (0–100, % from top), size scale (1 = default).', inputSchema: {project_id: pid, caption_id: z.string(), text: z.string().optional(), accent_words: z.array(z.string()).optional().describe('exact words to highlight; [] clears accents'), top_pct: z.number().min(0).max(95).optional(), scale: z.number().min(0.5).max(2).optional()}}, async ({project_id, caption_id, text: t, accent_words, top_pct, scale}) => {
  const p = load(project_id); const i = p.captions.findIndex((c) => c.id === caption_id); if (i < 0) throw new Error(`no caption ${caption_id}`);
  let cap = p.captions[i];
  if (t != null) cap = retext(cap, t);
  if (accent_words) { const set = new Set(accent_words.map(norm)); cap = {...cap, words: cap.words.map((w) => ({...w, tier: set.has(norm(w.text)) ? Math.max(1, w.tier ?? 0) : 0}))}; }
  if (top_pct != null) cap.topPct = top_pct; if (scale != null) cap.scale = scale;
  p.captions[i] = cap; await save(project_id, p);
  return text(`${caption_id}: "${capText(cap)}" top ${cap.topPct}%${cap.scale ? ` scale ${cap.scale}` : ''}`);
});

server.registerTool('add_caption', {description: 'Add a caption page at a timeline time (seconds) lasting duration_sec.', inputSchema: {project_id: pid, at_sec: sec('timeline start'), duration_sec: z.number().min(0.3).default(2), text: z.string(), accent_words: z.array(z.string()).optional(), top_pct: z.number().min(0).max(95).optional()}}, async ({project_id, at_sec, duration_sec, text: t, accent_words, top_pct}) => {
  const p = load(project_id); const {clip, sourceSec} = locate(p, at_sec);
  const startMs = Math.round(sourceSec * 1000); const endMs = Math.round(Math.min(clip.outSec, sourceSec + duration_sec * (clip.speed ?? 1)) * 1000);
  let cap = retext({id: 'x', src: clip.src, startMs, endMs, topPct: top_pct ?? p.captions.find((c) => c.src === clip.src)?.topPct ?? 58, words: []}, t);
  if (accent_words) { const set = new Set(accent_words.map(norm)); cap.words = cap.words.map((w) => ({...w, accent: set.has(norm(w.text))})); }
  p.captions = renumber([...p.captions, cap], 'c'); await save(project_id, p);
  return text(`Added caption on ${clip.id} @${f1(at_sec)}s: "${capText(cap)}" (id ${p.captions.at(-1).id})`);
});

server.registerTool('delete_captions', {description: 'Delete caption pages by id.', inputSchema: {project_id: pid, caption_ids: z.array(z.string()).min(1)}}, async ({project_id, caption_ids}) => {
  const p = load(project_id); const gone = new Set(caption_ids); const before = p.captions.length;
  p.captions = p.captions.filter((c) => !gone.has(c.id)); await save(project_id, p);
  return text(`Deleted ${before - p.captions.length} caption(s); ${p.captions.length} left (ids unchanged)`);
});

server.registerTool('search_stock', {description: 'Search Pexels for portrait stock video/photos to use as B-roll. Returns URLs for add_broll / edit_broll.', inputSchema: {query: z.string(), kind: z.enum(['video', 'image']).default('video'), count: z.number().min(1).max(10).default(5)}}, async ({query, kind, count}) => {
  const rows = await pexels(query, kind, count);
  return text(rows.length ? rows.map((r, i) => `${i + 1}. ${r.src}${r.duration ? `  ${r.duration}s ${r.size}` : r.alt ? `  "${r.alt}"` : ''}`).join('\n') : 'nothing found');
});

server.registerTool('add_broll', {description: 'Overlay B-roll from at_sec for duration_sec. src = Pexels URL (from search_stock), a path inside public/ (e.g. "broll/x.mp4"), or an absolute file path (copied in). mode: fullscreen | top (upper 45%) | inset (small card top-right).', inputSchema: {project_id: pid, at_sec: sec('timeline start'), duration_sec: z.number().min(0.3), src: z.string(), kind: z.enum(['video', 'image']), mode: z.enum(['fullscreen', 'top', 'inset']).default('inset'), label: z.string().optional()}}, async ({project_id, at_sec, duration_sec, src, kind, mode, label}) => {
  const p = load(project_id); const {clip, sourceSec} = locate(p, at_sec);
  let s = src;
  if (!/^https?:/.test(src) && path.isAbsolute(src)) {
    if (!fs.existsSync(src)) throw new Error(`file not found: ${src}`);
    const dir = path.join(PUBLIC, 'broll'); fs.mkdirSync(dir, {recursive: true});
    const name = path.basename(src).replace(/[^\w.\-]/g, '_'); fs.copyFileSync(src, path.join(dir, name)); s = `broll/${name}`;
  } else if (!/^https?:/.test(src) && !fs.existsSync(path.join(PUBLIC, src))) throw new Error(`not found in public/: ${src}`);
  const b = {id: 'x', clipId: clip.id, startMs: Math.round(sourceSec * 1000), endMs: Math.round(Math.min(clip.outSec, sourceSec + duration_sec * (clip.speed ?? 1)) * 1000), kind, mode, src: s, source: /^https?:/.test(s) ? 'pexels' : 'own', query: label, alternatives: []};
  p.brolls = renumber([...p.brolls, b], 'b'); await save(project_id, p);
  return text(`Added B-roll ${p.brolls.at(-1).id} on ${clip.id} @${f1(at_sec)}s (${mode} ${kind})`);
});

server.registerTool('edit_broll', {description: 'Change a B-roll cue: mode, size scale, source URL/path, or move/resize it on the timeline (seconds).', inputSchema: {project_id: pid, broll_id: z.string(), mode: z.enum(['fullscreen', 'top', 'inset']).optional(), scale: z.number().min(0.3).max(3).optional(), src: z.string().optional(), start_sec: sec('new timeline start').optional(), end_sec: sec('new timeline end').optional()}}, async ({project_id, broll_id, mode, scale, src, start_sec, end_sec}) => {
  const p = load(project_id); const b = p.brolls.find((x) => x.id === broll_id); if (!b) throw new Error(`no B-roll ${broll_id}`);
  if (mode) b.mode = mode; if (scale != null) b.scale = scale; if (src) { b.src = src; b.source = /^https?:/.test(src) ? 'pexels' : 'own'; }
  if (start_sec != null) { const {clip, sourceSec} = locate(p, start_sec); b.clipId = clip.id; const len = b.endMs - b.startMs; b.startMs = Math.round(sourceSec * 1000); b.endMs = Math.min(Math.round(clip.outSec * 1000), b.startMs + len); }
  if (end_sec != null) { const {clip, sourceSec} = locate(p, end_sec); if (clip.id !== b.clipId) throw new Error('end must be on the same clip as the start'); b.endMs = Math.max(b.startMs + 300, Math.round(sourceSec * 1000)); }
  await save(project_id, p); return text(`${broll_id}: ${b.mode} ${b.kind}${b.scale ? ` scale ${b.scale}` : ''} @${f1(toAbs(p, b.clipId, b.startMs, true) ?? 0)}–${f1(toAbs(p, b.clipId, b.endMs, true) ?? 0)}s`);
});

server.registerTool('delete_brolls', {description: 'Delete B-roll cues by id.', inputSchema: {project_id: pid, broll_ids: z.array(z.string()).min(1)}}, async ({project_id, broll_ids}) => {
  const p = load(project_id); const gone = new Set(broll_ids); const before = p.brolls.length;
  p.brolls = p.brolls.filter((b) => !gone.has(b.id)); await save(project_id, p); return text(`Deleted ${before - p.brolls.length} B-roll cue(s)`);
});

server.registerTool('set_music', {description: 'Set or remove the music track. file = absolute path (copied into public/music) or "music/<name>" already there. volume 0–1, fade_out_sec, duck = lower under speech.', inputSchema: {project_id: pid, file: z.string().nullable(), volume: z.number().min(0).max(1).default(0.25), fade_out_sec: z.number().min(0).default(1.5), duck: z.boolean().default(true)}}, async ({project_id, file, volume, fade_out_sec, duck}) => {
  const p = load(project_id);
  if (file === null) { p.music = null; await save(project_id, p); return text('Music removed'); }
  let src = file;
  if (path.isAbsolute(file)) { if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`); const dir = path.join(PUBLIC, 'music'); fs.mkdirSync(dir, {recursive: true}); const name = path.basename(file).replace(/[^\w.\-]/g, '_'); fs.copyFileSync(file, path.join(dir, name)); src = `music/${name}`; }
  else if (!fs.existsSync(path.join(PUBLIC, file))) throw new Error(`not found in public/: ${file}`);
  p.music = {src, volume, startSec: 0, fadeOutSec: fade_out_sec, duck, duckLevel: 0.25}; await save(project_id, p);
  return text(`Music ${src} vol ${volume}, fade ${fade_out_sec}s, duck ${duck}`);
});

// words of every clip (trim window), source-relative; `${source}:${i}` is a stable word id
async function transcript(p) {
  await runJob('/api/transcribe', {clips: p.clips, lang: p.lang ?? 'auto'});
  return readPublic('transcript.json');
}

server.registerTool('get_transcript', {description: 'Word-level transcript of every clip, in timeline order. Each word is `i:word` where i indexes the clip\'s SOURCE transcript; refer to words as "<source>:<i>" in other tools — never by seconds. `[pause 0.8s]` marks gaps. Transcribes on first call (cached per source; needs the backend).', inputSchema: {project_id: pid}}, async ({project_id}) => {
  const p = load(project_id); if (!p.clips.length) throw new Error('project has no clips');
  const tr = await transcript(p);
  const out = [];
  for (const pc of place(p.clips)) {
    const t = tr.find((x) => x.clipId === pc.clip.id);
    out.push(`clip ${pc.clip.id} (source ${t?.source ?? path.basename(pc.clip.src)}, @${f1(pc.startMs / 1000)}–${f1(pc.endMs / 1000)}s):`);
    if (!t?.words.length) { out.push('  (no speech)'); continue; }
    const toks = [];
    t.words.forEach((w, k) => {
      const prev = t.words[k - 1];
      if (prev && w.startMs - prev.endMs > 400) toks.push(`[pause ${f1((w.startMs - prev.endMs) / 1000)}s]`);
      toks.push(`${w.i}:${w.word}`);
    });
    out.push('  ' + toks.join(' '));
  }
  return text(out.join('\n'));
});

server.registerTool('set_language', {description: 'Set the transcription language of the project: es, en, or auto (detect per clip). Transcripts are cached per language.', inputSchema: {project_id: pid, lang: z.enum(['auto', 'es', 'en'])}}, async ({project_id, lang}) => {
  const p = load(project_id); p.lang = lang; await save(project_id, p); return text(`Language: ${lang}`);
});

// ---------- motion graphics ----------
const TEMPLATE_HELP = Object.entries(TEMPLATES).map(([id, t]) => `${id} = ${t.desc}; props ${JSON.stringify(Object.fromEntries(Object.entries(t.schema.shape).map(([k, v]) => [k, v.description ?? (v.def?.type ?? 'value')])))}`).join('\n');
const nextId = (items, prefix) => { let n = 0; while (items.some((x) => x.id === `${prefix}${n}`)) n++; return `${prefix}${n}`; };
// where a graphic goes: a word id (start of that word) or a timeline second
async function anchorFor(p, {at_wid, at_sec}) {
  if (at_wid) {
    const [source, i] = at_wid.split(':');
    const tr = await transcript(p);
    // the source may be split over several clips; the word lives in one of them
    const t = tr.filter((x) => x.source === source).find((x) => x.words.some((w) => String(w.i) === i));
    const w = t?.words.find((x) => String(x.i) === i);
    if (!w) throw new Error(`no word ${at_wid} (see get_transcript)`);
    const clip = p.clips.find((c) => c.id === t.clipId);
    return {src: clip.src, startMs: w.startMs};
  }
  if (at_sec == null) throw new Error('give at_wid or at_sec');
  const {clip, sourceSec} = locate(p, at_sec);
  return {src: clip.src, startMs: Math.round(sourceSec * 1000)};
}

server.registerTool('add_graphic', {description: `Add a motion-graphics overlay (headline, label, stat, chapter) anchored to the footage. Templates:\n${TEMPLATE_HELP}\nAnchor with at_wid (word id from get_transcript, the graphic starts when that word starts) or at_sec. Keep the hook headline in the first 3 s; labels on room/feature mentions; ≤ 1 graphic on screen at a time.`, inputSchema: {project_id: pid, template: z.enum(Object.keys(TEMPLATES)), props: z.record(z.string(), z.any()), at_wid: z.string().optional(), at_sec: sec('timeline start').optional(), duration_sec: z.number().min(0.5).max(15).optional(), y_pct: z.number().min(0).max(90).optional().describe('block top, % of frame height; template default when omitted')}}, async ({project_id, template, props, at_wid, at_sec, duration_sec, y_pct}) => {
  const p = load(project_id); if (!p.clips.length) throw new Error('project has no clips');
  const clean = parseProps(template, props);
  if (template === 'sticker' && !/^https?:/.test(clean.src) && !fs.existsSync(path.join(PUBLIC, clean.src))) throw new Error(`sticker src not found under public/: ${clean.src} (use search_asset or generate_asset first)`);
  const {src, startMs} = await anchorFor(p, {at_wid, at_sec});
  const g = {id: nextId(p.graphics, 'g'), src, startMs, endMs: startMs + Math.round((duration_sec ? duration_sec * 1000 : TEMPLATES[template].defaultMs)), template, props: clean};
  if (y_pct != null) g.yPct = y_pct;
  p.graphics.push(g); await save(project_id, p);
  return text(`Added ${g.id} ${template}\n\n${summary(project_id, p)}`);
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

server.registerTool('generate_asset', {description: 'Generate an image asset that no library has, with the OpenAI Images API (transparent PNG; the user pays with their OPENAI_API_KEY). kind wraps the prompt: sticker (die-cut flat vector), doodle (hand-drawn marker), texture (seamless, opaque), ui (flat mockup). Describe the object only — style comes from kind. Cached by prompt. Then place it with add_graphic template=sticker.', inputSchema: {prompt: z.string().min(3).max(400), kind: z.enum(['sticker', 'doodle', 'texture', 'ui']).default('sticker'), size: z.enum(['1024x1024', '1024x1536', '1536x1024']).default('1024x1024'), quality: z.enum(['low', 'medium', 'high']).default('medium')}}, async ({prompt, kind, size, quality}) => {
  const r = await generateAsset({prompt, kind, size, quality, apiKey: ENV.OPENAI_API_KEY || process.env.OPENAI_API_KEY, model: ENV.REEL_IMAGE_MODEL || process.env.REEL_IMAGE_MODEL || 'gpt-image-1.5'});
  return text(`${r.cached ? 'Cached' : 'Generated'} ${r.src} (${r.model}${r.usage?.output_tokens ? `, ${r.usage.output_tokens} output tokens` : ''})`);
});

server.registerTool('edit_graphic', {description: 'Change a graphic: props (validated for its template), timing (seconds, timeline), y position.', inputSchema: {project_id: pid, graphic_id: z.string(), props: z.record(z.string(), z.any()).optional(), start_sec: sec('new timeline start').optional(), duration_sec: z.number().min(0.5).max(15).optional(), y_pct: z.number().min(0).max(90).optional()}}, async ({project_id, graphic_id, props, start_sec, duration_sec, y_pct}) => {
  const p = load(project_id); const g = p.graphics.find((x) => x.id === graphic_id); if (!g) throw new Error(`no graphic ${graphic_id}`);
  if (props) g.props = parseProps(g.template, {...g.props, ...props});
  if (start_sec != null) { const a = await anchorFor(p, {at_sec: start_sec}); const len = g.endMs - g.startMs; g.src = a.src; g.startMs = a.startMs; g.endMs = a.startMs + len; }
  if (duration_sec != null) g.endMs = g.startMs + Math.round(duration_sec * 1000);
  if (y_pct != null) g.yPct = y_pct;
  await save(project_id, p); return text(`${graphic_id}: ${g.template} ${JSON.stringify(g.props)}`);
});

server.registerTool('delete_graphics', {description: 'Delete graphics by id.', inputSchema: {project_id: pid, graphic_ids: z.array(z.string()).min(1)}}, async ({project_id, graphic_ids}) => {
  const p = load(project_id); const gone = new Set(graphic_ids); p.graphics = p.graphics.filter((g) => !gone.has(g.id)); await save(project_id, p); return text(`Deleted ${graphic_ids.join(', ')}`);
});

server.registerTool('set_caption_style', {description: `Caption preset for the whole project: ${Object.values(PRESETS).map((x) => `${x.id} = ${x.desc}`).join('; ')}. Re-pages the generated captions for the new preset, keeping word tiers and hand-added pages. Needs the backend.`, inputSchema: {project_id: pid, style: z.enum(Object.keys(PRESETS))}}, async ({project_id, style}) => {
  const p = load(project_id); p.captionStyle = style;
  if (p.clips.length && p.captions.length) {
    await runJob('/api/captions', {clips: p.clips, lang: p.lang ?? 'auto', style});
    const fresh = readPublic('captions.multi.json');
    // pages without word ids are hand-made and stay — unless NO page has ids
    // (a project from before word ids), in which case everything is re-paged
    const legacy = !p.captions.some((c) => c.words.some((w) => w.wid));
    p.captions = [...(legacy ? [] : p.captions.filter((c) => !c.words.some((w) => w.wid))), ...reapplyTiers(p.captions, Array.isArray(fresh) ? fresh : [])];
  }
  await save(project_id, p);
  return text(`Caption style: ${style} (${p.captions.length} pages)\n\n${summary(project_id, p)}`);
});

server.registerTool('annotate_captions', {description: 'Set per-word emphasis by word id ("<source>:<i>" from get_transcript). tier 0 = plain; 1 = accent color — sparing, 1–2 per sentence, only meaning words (numbers, names, claims, the punchline); 2 = big emphasis — rare, at most one per 10 s. Never on function words. Returns what was applied plus warnings.', inputSchema: {project_id: pid, items: z.array(z.object({wid: z.string(), tier: z.number().int().min(0).max(2)})).min(1)}}, async ({project_id, items}) => {
  const p = load(project_id);
  const want = new Map(items.map((x) => [x.wid, x.tier]));
  const applied = []; const warn = [];
  for (const c of p.captions) for (const w of c.words) if (w.wid && want.has(w.wid)) {
    const tier = want.get(w.wid);
    if (tier && isGlue(w.text)) warn.push(`${w.wid} "${w.text}": emphasis on a function word`);
    w.tier = tier; applied.push(w.wid); want.delete(w.wid);
  }
  for (const wid of want.keys()) warn.push(`${wid}: no caption word with that id (generate captions first, or it was cut away)`);
  const t2 = p.captions.flatMap((c) => c.words).filter((w) => w.tier === 2).length;
  const dur = totalSec(p.clips);
  if (t2 > Math.max(1, dur / 10)) warn.push(`${t2} tier-2 words in ${f1(dur)}s — aim for at most one per 10 s`);
  await save(project_id, p);
  return text(`Applied ${applied.length} annotation(s).${warn.length ? '\nWARN ' + warn.join('\nWARN ') : ''}\n\n${summary(project_id, p)}`);
});

server.registerTool('run_ai_step', {description: 'Run one deterministic pipeline step on the project, exactly like the editor buttons, and apply the result. autocut = remove silence/pauses (splits clips into segments); captions = WhisperX words → caption pages + face-aware placement (keeps existing captions on clips that already have them). Ordering takes, emphasis and B-roll are YOUR job: use get_transcript, reorder_clips/delete_clips, edit_caption, search_stock/add_broll. Needs the backend (npm start).', inputSchema: {project_id: pid, step: z.enum(['autocut', 'captions'])}}, async ({project_id, step}) => {
  let p = load(project_id); if (!p.clips.length) throw new Error('project has no clips');
  const lang = p.lang ?? 'auto';
  if (step === 'autocut') {
    await runJob('/api/trim-silence', {clips: p.clips, lang}); const {plan} = readPublic('trim-silence.json');
    if (!Array.isArray(plan) || !plan.length) return text('Nothing to cut');
    const r = applyAutocut(p.clips, plan); p.clips = r.clips; p.brolls = reanchor(p.brolls, r.remap); await save(project_id, p);
    return text(`Autocut: ${plan.reduce((n, x) => n + (x.segments?.length ?? 0), 0)} segments\n\n${summary(project_id, p)}`);
  }
  await runJob('/api/captions', {clips: p.clips, lang, style: p.captionStyle}); const fresh = readPublic('captions.multi.json');
  const {captions, added} = mergeCaptions(p.captions, Array.isArray(fresh) ? fresh : [], p.clips); p.captions = captions; await save(project_id, p);
  return text(`Captions: +${added} new (${p.captions.length} total)\n\n${summary(project_id, p)}`);
});

server.registerTool('render', {description: 'Export the project to mp4 (1080x1920). draft = half resolution, fast. Returns the file path.', inputSchema: {project_id: pid, draft: z.boolean().default(false)}}, async ({project_id, draft}) => {
  const p = load(project_id); if (!p.clips.length) throw new Error('project has no clips');
  const r = await runJob('/api/render', {clips: p.clips, music: p.music, captions: p.captions, brolls: p.brolls, graphics: p.graphics, accentColor: p.accentColor, captionStyle: p.captionStyle, draft});
  const file = path.join(PUBLIC, r.file.replace(/^\//, ''));
  return text(`Rendered ${draft ? '(draft) ' : ''}→ ${file}  (${(fs.statSync(file).size / 1e6).toFixed(1)} MB, ${f1(totalSec(p.clips))}s)`);
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
