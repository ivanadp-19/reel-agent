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
import {applyAutocut, cutRange, placeClips, reanchor, splitClip} from '../src/timeline.ts';
import {mergeCaptions, normalizeCaption, projectCaptions} from '../src/captions.ts';
import {isGlue, reapplyTiers} from '../src/paging.ts';
import {PRESETS} from '../src/captionPresets.ts';
import {TEMPLATES, describeSchema, isTemplate, parseProps, projectGraphics, spansWithoutMatte} from '../src/graphicTemplates.ts';
import {searchAssets, generateAsset, listLibrary, librarySearch} from './assets.mjs';
import {renderProof} from './proof.mjs';
import {validateProject} from '../src/validate.ts';
import {findCutCandidates} from '../src/cuts.ts';
import {qc, qcText} from '../scripts/qc.mjs';
import {LOOKS, DEFAULT_LOOK} from '../src/grade.ts';
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
  p.clips ??= []; p.captions ??= []; p.brolls ??= []; p.brollAssets ??= []; p.music ??= null; p.accentColor ??= '#FFB020'; p.lang ??= 'auto'; p.captionStyle ??= 'palabra'; p.captions = p.captions.map(normalizeCaption); p.graphics ??= []; p.mattes ??= []; p.offMic ??= 'mark'; p.hiddenWids ??= []; p.brand ??= null; p.grade ??= null;
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
const capText = (c) => c.words.map((w) => (w.tier === 2 ? `**${w.text}**` : w.tier ? `*${w.text}*` : w.text) + (w.emoji ?? '')).join(' ');
// exactly one emoji (flags, skin tones and ZWJ sequences count as one)
const oneEmoji = (s) => [...new Intl.Segmenter('en', {granularity: 'grapheme'}).segment(s)].length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s);

function summary(id, p) {
  const out = [];
  out.push(`Project "${p.name || 'Untitled project'}" (id ${id}) — ${f1(totalSec(p.clips))}s, ${p.clips.length} clips, ${p.captions.length} captions, ${p.brolls.length} B-roll, music ${p.music ? path.basename(p.music.src) + ` vol ${p.music.volume}` : 'none'}, accent ${p.accentColor}, lang ${p.lang}, caption style ${p.captionStyle}, off-mic ${p.offMic}, brand ${p.brand ? `${p.brand.name ?? 'custom'} (accent ${p.brand.colors.accent}${p.brand.fonts?.display ? `, headlines ${p.brand.fonts.display}` : ''}${p.brand.fonts?.body ? `, captions ${p.brand.fonts.body}` : ''}${p.brand.logo ? `, logo ${p.brand.logo}` : ''})` : 'none'}, color ${p.grade ? `${p.grade.look} ${p.grade.intensity}${p.grade.auto ? ' + auto correction' : ''}` : 'ungraded'}`);
  out.push('', 'CLIPS (timeline order):');
  place(p.clips).forEach((pc, i) => {
    const c = pc.clip;
    const extra = [c.speed && c.speed !== 1 ? `speed ${c.speed}x` : '', c.muted ? 'muted' : '', c.volume != null && c.volume !== 1 ? `vol ${c.volume}` : '', c.transform?.length ? `${c.transform.length} keyframes` : ''].filter(Boolean).join(', ');
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
    out.push(`  ${b.id}  @${at == null ? '?' : f1(at)}–${end == null ? '?' : f1(end)}s  ${b.mode} ${b.kind}${b.scale && b.scale !== 1 ? ` scale ${b.scale}` : ''}  ${b.query ? `"${b.query}"` : ''} ${b.source ?? ''} ${/^https?:/.test(b.src) ? '' : path.basename(b.src)}`.replace(/\s+/g, ' '));
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

const SNAP_MS = 150; // how far into the neighbouring pause a word cut reaches
server.registerTool('cut_words', {description: 'Remove speech by word id: from_wid … to_wid (inclusive, same clip), or many stretches in ONE call with ranges (e.g. the ones find_cut_candidates suggested and you approved). Cut points snap into the pauses around the words so no syllable is clipped. Word ids stay valid after cuts; clip ids change (re-read get_transcript before using clip ids).', inputSchema: {project_id: pid, from_wid: z.string().optional().describe('first word to remove, "<source>:<i>"'), to_wid: z.string().optional().describe('last word to remove; defaults to from_wid'), ranges: z.array(z.object({from_wid: z.string(), to_wid: z.string().optional()})).max(80).optional().describe('several stretches at once')}}, async ({project_id, from_wid, to_wid, ranges}) => {
  const p = load(project_id);
  const list = ranges?.length ? ranges : from_wid ? [{from_wid, to_wid}] : null;
  if (!list) throw new Error('give from_wid (and to_wid), or ranges');
  const tr = await transcript(p);
  // plan every stretch against the timeline as it is now, in source ms
  const plans = [];
  for (const r of list) {
    const a = await wordAt(p, r.from_wid, tr); const b = r.to_wid ? await wordAt(p, r.to_wid, tr) : a;
    if (a.entry.clipId !== b.entry.clipId) throw new Error(`${r.from_wid} and ${r.to_wid} sit on different clips (${a.entry.clipId}, ${b.entry.clipId}) — give them as two ranges`);
    if (b.k < a.k) throw new Error(`${r.to_wid} comes before ${r.from_wid}`);
    const inMs = a.clip.inSec * 1000, outMs = a.clip.outSec * 1000;
    const startMs = a.prev ? Math.min(a.word.startMs, Math.max(a.prev.endMs + 40, a.word.startMs - SNAP_MS)) : inMs;
    const endMs = b.next ? Math.max(b.word.endMs, Math.min(b.next.startMs - 40, b.word.endMs + SNAP_MS)) : outMs;
    plans.push({src: a.clip.src, startMs, endMs, text: a.entry.words.slice(a.k, b.k + 1).map((w) => w.word).join(' ')});
  }
  // overlapping stretches become one; each remaining span sits inside one clip
  // (earlier cuts only removed other spans), found again by source time
  plans.sort((x, y) => (x.src === y.src ? x.startMs - y.startMs : x.src < y.src ? -1 : 1));
  const merged = [];
  for (const c of plans) { const last = merged.at(-1); if (last && last.src === c.src && c.startMs <= last.endMs) { last.endMs = Math.max(last.endMs, c.endMs); last.text += ` ${c.text}`; } else merged.push({...c}); }
  const lines = [];
  const pieces = new Set(); // clips this call cut into
  for (const c of merged) {
    const clip = p.clips.find((k) => k.src === c.src && k.inSec * 1000 <= c.startMs + 1 && k.outSec * 1000 >= c.endMs - 1);
    const r = clip && cutRange(p.clips, clip.id, c.startMs / 1000, c.endMs / 1000);
    if (!r) { lines.push(`skipped "${c.text}" (not on the timeline any more)`); continue; }
    p.clips = r.clips; p.brolls = reanchor(p.brolls, r.remap);
    for (const s of r.remap) pieces.add(s.segId);
    lines.push(`cut "${c.text}" — ${f1((c.endMs - c.startMs) / 1000)}s of ${path.basename(c.src)} (${f1(c.startMs / 1000)}–${f1(c.endMs / 1000)})`);
  }
  // a piece left between two cuts that holds no word at all is dead air: drop it
  const words = new Map(tr.map((t) => [t.source, []]));
  for (const t of tr) words.get(t.source).push(...t.words);
  const silent = p.clips.filter((k) => pieces.has(k.id) && k.outSec - k.inSec < 4 && !(words.get(path.basename(k.src).replace(/\.[^.]+$/, '')) ?? []).some((w) => w.endMs > k.inSec * 1000 && w.startMs < k.outSec * 1000));
  if (silent.length) {
    p.clips = p.clips.filter((k) => !silent.includes(k));
    lines.push(`dropped ${silent.length} silent piece(s) left between cuts (${f1(silent.reduce((n, k) => n + k.outSec - k.inSec, 0))}s)`);
  }
  await save(project_id, p);
  return text(`${lines.join('\n')}\n\n${summary(project_id, p)}`);
});

server.registerTool('find_cut_candidates', {description: 'Suggest what to cut, by word id (nothing is cut): retakes — an attempt the speaker said again; the kept take is the last complete one —, off-mic lines, meta talk ("sorry", "say it again", "otra vez", "corta") and fillers (um, uh, eh, mmm, "you know", "o sea"; "este"/"like" only between pauses). Review the list against the transcript, drop what should stay, then pass the rest to cut_words ranges in one call.', inputSchema: {project_id: pid}}, async ({project_id}) => {
  const p = load(project_id); if (!p.clips.length) throw new Error('project has no clips');
  const tr = await transcript(p);
  const cands = findCutCandidates(tr.map((t) => ({clipId: t.clipId, source: t.source, words: t.words})));
  if (!cands.length) return text('No cut candidates: no retakes, fillers, meta talk or off-mic lines on the timeline.');
  const lines = cands.map((c) => `${c.kind.padEnd(7)} ${c.from}${c.to !== c.from ? `…${c.to}` : ''}  "${c.text}"${c.note ? `  (${c.note})` : ''}${c.keep ? `  — kept take starts at ${c.keep.from}: "${c.keep.text.slice(0, 60)}"` : ''}`);
  return text(`${cands.length} candidates:\n${lines.join('\n')}\n\nAll of them as cut_words ranges (remove the ones to keep):\n${JSON.stringify(cands.map((c) => (c.to === c.from ? {from_wid: c.from} : {from_wid: c.from, to_wid: c.to})))}`);
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
// off-mic words still inside the cut (from the last transcript run), per clip
function offMicIssues(p) {
  if (p.offMic === 'off') return [];
  let tr; try { tr = readPublic('transcript.json'); } catch { return []; }
  const bySource = new Map();
  for (const t of tr) { const m = bySource.get(t.source) ?? new Map(); for (const w of t.words) m.set(w.i, w); bySource.set(t.source, m); }
  const out = [];
  for (const c of p.clips) {
    const source = path.basename(c.src).replace(/\.[^.]+$/, '');
    const off = [...(bySource.get(source)?.values() ?? [])].filter((w) => w.off && w.endMs > c.inSec * 1000 && w.startMs < c.outSec * 1000).sort((a, b) => a.i - b.i);
    if (!off.length) continue;
    // contiguous runs of word indices → one cut_words call each
    const runs = [];
    for (const w of off) { const r = runs[runs.length - 1]; if (r && w.i === r.to + 1) r.to = w.i; else runs.push({from: w.i, to: w.i, text: []}); runs[runs.length - 1].text.push(w.word); }
    out.push({level: 'warn', code: 'off-mic', msg: `${c.id}: ${off.length} off-mic word(s) still in the cut: ${runs.slice(0, 4).map((r) => `cut_words ${source}:${r.from}${r.to !== r.from ? `…${source}:${r.to}` : ''} "${r.text.join(' ').slice(0, 40)}"`).join('; ')}${runs.length > 4 ? ` (+${runs.length - 4} more)` : ''} — or set_off_mic cut`, ref: c.id});
  }
  return out;
}

server.registerTool('get_transcript', {description: 'Word-level transcript of every clip, in timeline order. Each word is `i:word` where i indexes the clip\'s SOURCE transcript; refer to words as "<source>:<i>" in other tools — never by seconds. `[pause 0.8s]` marks gaps; `[off-mic: …]` wraps words of a quieter second voice away from the mic (someone behind the camera feeding lines — not the presenter). Transcribes on first call (cached per source; needs the backend).', inputSchema: {project_id: pid}}, async ({project_id}) => {
  const p = load(project_id); if (!p.clips.length) throw new Error('project has no clips');
  const tr = await transcript(p);
  const out = [];
  let offCount = 0;
  for (const pc of place(p.clips)) {
    const t = tr.find((x) => x.clipId === pc.clip.id);
    out.push(`clip ${pc.clip.id} (source ${t?.source ?? path.basename(pc.clip.src)}, @${f1(pc.startMs / 1000)}–${f1(pc.endMs / 1000)}s):`);
    if (!t?.words.length) { out.push('  (no speech)'); continue; }
    const toks = [];
    let inOff = false;
    t.words.forEach((w, k) => {
      const prev = t.words[k - 1];
      if (inOff && !w.off) { toks.push(']'); inOff = false; }
      if (prev && w.startMs - prev.endMs > 400) toks.push(`[pause ${f1((w.startMs - prev.endMs) / 1000)}s]`);
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

server.registerTool('set_off_mic', {description: 'How to treat a quieter second voice away from the mic (a director feeding lines from behind the camera). mark = flag those words as [off-mic: …] in get_transcript and let you decide (default); cut = autocut and captions drop them automatically; off = no detection (one-voice clips, or a presenter who whispers on purpose).', inputSchema: {project_id: pid, mode: z.enum(['mark', 'cut', 'off'])}}, async ({project_id, mode}) => {
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

server.registerTool('add_graphic', {description: `Add a motion-graphics overlay (headline, label, stat, chapter) anchored to the footage. Templates:\n${TEMPLATE_HELP}\nAnchor with at_wid (word id from get_transcript, the graphic starts when that word starts) or at_sec. Keep the hook headline in the first 3 s; labels on room/feature mentions; ≤ 1 graphic on screen at a time.`, inputSchema: {project_id: pid, template: z.enum(Object.keys(TEMPLATES)), props: z.record(z.string(), z.any()), at_wid: z.string().optional(), at_sec: sec('timeline start').optional(), duration_sec: z.number().min(0.5).max(15).optional(), y_pct: z.number().min(0).max(90).optional().describe('block top, % of frame height; template default when omitted'), behind: z.boolean().default(false).describe('draw it BEHIND the presenter (big-word / word walls). Needs prepare_mattes afterwards')}}, async ({project_id, template, props, at_wid, at_sec, duration_sec, y_pct, behind}) => {
  const p = load(project_id); if (!p.clips.length) throw new Error('project has no clips');
  const clean = parseProps(template, props);
  if (template === 'sticker' && !/^https?:/.test(clean.src) && !fs.existsSync(path.join(PUBLIC, clean.src))) throw new Error(`sticker src not found under public/: ${clean.src} (use search_asset or generate_asset first)`);
  const {src, startMs} = await anchorFor(p, {at_wid, at_sec});
  const g = {id: nextId(p.graphics, 'g'), src, startMs, endMs: startMs + Math.round((duration_sec ? duration_sec * 1000 : TEMPLATES[template].defaultMs)), template, props: clean};
  if (y_pct != null) g.yPct = y_pct;
  if (behind) g.behind = true;
  p.graphics.push(g); await save(project_id, p);
  const warn = validateProject(p, FPS, facesOf(p)).filter((i) => i.ref === g.id);
  return text(`Added ${g.id} ${template}${behind ? ' (behind the presenter — run prepare_mattes before rendering)' : ''}${warn.length ? '\n' + issuesText(warn) : ''}\n\n${summary(project_id, p)}`);
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
  if (!force) {
    // free options first: the library, then the search sources
    const searchKind = kind === 'texture' ? 'illustration' : 'sticker';
    const found = [...librarySearch(prompt, {kind: undefined, limit: 4}), ...(await searchAssets({query: prompt, kind: searchKind, limit: 4}).catch(() => []))]
      .filter((r, i, arr) => arr.findIndex((x) => x.src === r.src) === i).slice(0, 5);
    if (found.length) return text(`Not generated — ${found.length} existing asset(s) match "${prompt}". Use one of these, or call again with force=true if none fits:\n` + found.map((r) => `${r.id}${r.fromLibrary ? '  [library]' : ''}\n  src: ${r.src}  (${r.format}, ${r.license}${r.source ? ', ' + r.source : ''})${r.credit ? `\n  credit: ${r.credit}` : ''}${r.prompt ? `\n  prompt: ${r.prompt}` : ''}`).join('\n'));
  }
  const r = await generateAsset({prompt, kind, size, quality, apiKey: ENV.OPENAI_API_KEY || process.env.OPENAI_API_KEY, model: ENV.REEL_IMAGE_MODEL || process.env.REEL_IMAGE_MODEL || 'gpt-image-1.5'});
  return text(`${r.cached ? `Reused ${r.src} (already generated${r.reusedPrompt ? ` for "${r.reusedPrompt}"` : ''})` : `Generated ${r.src} (${r.model}${r.usage?.output_tokens ? `, ${r.usage.output_tokens} output tokens` : ''})`}`);
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

server.registerTool('annotate_captions', {description: 'Set per-word emphasis by word id ("<source>:<i>" from get_transcript). tier 0 = plain; 1 = accent color — sparing, 1–2 per sentence, only meaning words (numbers, names, claims, the punchline); 2 = big emphasis — rare, at most one per 10 s. Never on function words. emoji = one emoji that pops in after the word (money → 💰; "" removes it) — a few per reel, on concrete nouns and feelings, never on function words. Returns each word it touched (check the text matches what you meant) plus warnings.', inputSchema: {project_id: pid, items: z.array(z.object({wid: z.string(), tier: z.number().int().min(0).max(2).optional(), emoji: z.string().max(16).optional()})).min(1)}}, async ({project_id, items}) => {
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
const allIssues = (p) => [...validateProject(p, FPS, facesOf(p)), ...offMicIssues(p)];
const projectProps = (p) => ({clips: p.clips, music: p.music, captions: p.captions, brolls: p.brolls, graphics: p.graphics, mattes: p.mattes, accentColor: p.accentColor, captionStyle: p.captionStyle, brand: p.brand, grade: p.grade});

server.registerTool('validate', {description: 'Deterministic checks before rendering: Reels safe zones, captions ending on function words, timing, emphasis density, caption/graphic overlaps, graphics on screen at the same time, behind-graphics without a matte, missing hook. Geometry is estimated — confirm visually with caption_proof.', inputSchema: {project_id: pid}}, async ({project_id}) => {
  const p = load(project_id);
  return text(issuesText(allIssues(p)));
});

server.registerTool('caption_proof', {description: 'LOOK at the result without a full render: renders up to 8 stills of the current project (default: spread over the pages with emphasis and every graphic) and returns them as one contact sheet plus the validate report. Use it after annotating captions or adding graphics; fix what looks wrong and call again.', inputSchema: {project_id: pid, at_secs: z.array(sec('timeline time')).max(8).optional().describe('times to look at; omit to pick automatically')}}, async ({project_id, at_secs}) => {
  const p = load(project_id); if (!p.clips.length) throw new Error('project has no clips');
  let times = at_secs;
  if (!times?.length) {
    const caps = projectCaptions(p.captions, p.clips, FPS);
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
    {type: 'text', text: `Contact sheet, ${cols} per row, left→right top→bottom at ${times.map((t) => f1(t) + 's').join(', ')}\n\nvalidate:\n${issuesText(allIssues(p))}`},
    {type: 'image', data, mimeType: 'image/jpeg'},
  ]};
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
