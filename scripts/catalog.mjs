#!/usr/bin/env node
// Asset catalog: what is actually IN each media file of public/ (inputs/, clips/,
// broll/, broll-assets/, music/ …), so the agent picks footage by content and not
// by a file name that lies ("G3v2_skybar" = 1.5 s of a lounge by DAY; a hook with
// 33 s of black waiting for B-roll).
//
// Per file, deterministic (ffprobe + one ffmpeg pass, no model):
//   MEASURED   duration, resolution, fps, codec, audio stream, black stretches
//              (luma ≈ 0, 4 samples/s → ±0.25 s), silent stretches, loudness
//   HEURISTIC  day / night (luma of the non-black samples + a bright sky-like top
//              band), static / moving (frame difference), tags derived from all
//              of the above — labelled as heuristics everywhere they are shown
//   DESCRIPTION from the transcript cache (public/clips/transcripts) or metadata
//              (the dir's library.json, container title/comment) when there is
//              any; otherwise the heuristic tags alone
// plus a contact sheet (frames spread over the clip) as a JPEG.
//
// Output: public/catalog/<dir>.json + public/catalog/sheets/<dir>/<file>.jpg.
// Incremental: a file is analyzed again only when new or its size / mtime changed
// (transcripts and library tags are re-read every run — cheap, no ffmpeg).
// Nothing runs this on startup: only `node scripts/catalog.mjs` or the MCP tool
// catalog_assets. It renices itself (REEL_CATALOG_NICE, default 15) and decodes
// with one thread (REEL_CATALOG_THREADS) so a shared 2-vCPU VM keeps rendering.
//
//   node scripts/catalog.mjs [dir …] [--force] [--limit N] [--json] [--public DIR]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';

export const CATALOG_VERSION = 1;
export const DEFAULT_DIRS = ['inputs', 'clips', 'broll', 'broll-assets', 'music'];
export const SAMPLE_FPS = 4; // analysis samples per second (black ranges are ±1/SAMPLE_FPS)
const GRID = 32; // analysis frames are GRID × GRID RGB
const BLACK_PIX = 0.10 * 255; // a pixel is dark below 10 % luma (ffmpeg blackdetect's pix_th)
const BLACK_PIC = 0.98; // a frame is black when ≥ 98 % of its pixels are dark (blackdetect's pic_th)
export const MIN_BLACK_SEC = 0.4;
const SILENCE_DB = -40;
const ROOT = path.resolve(import.meta.dirname, '..');

const VIDEO = /\.(mp4|mov|m4v|webm|mkv|avi|mts)$/i;
const IMAGE = /\.(jpe?g|png|webp|heic)$/i;
const AUDIO = /\.(wav|mp3|m4a|aac|ogg|oga|flac|opus)$/i;
export const mediaKind = (name) => (VIDEO.test(name) ? 'video' : IMAGE.test(name) ? 'image' : AUDIO.test(name) ? 'audio' : null);

export const LEGEND = {
  measured: 'kind, durationSec, width, height, fps, codec, hasAudio, black (luma ≈ 0 stretches, ±0.25 s), silence, meanDb — ffprobe/ffmpeg, exact up to the sampling',
  heuristic: 'daylight (day / night / uncertain: median luma of non-black samples, sky = bright blue-or-white top band), motion (static / moving: mean frame difference), tags — rules of thumb, check the contact sheet before trusting them',
  desc: 'descSource says where the description comes from: transcript (words cached in clips/transcripts), metadata (library.json tags/desc, container title), or heuristic (tags only)',
};

// ---------- pure analysis (unit-tested on synthetic samples) ----------

const lumaOf = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// one GRID×GRID rgb24 frame → the numbers the rest works from
export function frameStats(buf, w = GRID, h = GRID) {
  const n = w * h;
  let sum = 0, dark = 0, topSum = 0, topSky = 0;
  const luma = new Float32Array(n);
  const top = Math.max(1, Math.floor(h / 3));
  for (let i = 0; i < n; i++) {
    const r = buf[i * 3], g = buf[i * 3 + 1], b = buf[i * 3 + 2];
    const y = lumaOf(r, g, b);
    luma[i] = y; sum += y;
    if (y < BLACK_PIX) dark++;
    if (i < top * w) {
      topSum += y;
      // sky: bright, and blue-dominant or near-white (overcast)
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      if (y > 140 && ((b > r + 12 && b >= g - 8) || (max - min < 24 && y > 185))) topSky++;
    }
  }
  return {mean: sum / n / 255, black: dark / n >= BLACK_PIC, sky: topSky / (top * w) >= 0.5, luma};
}

// sample flags → [{startSec, endSec}] of runs lasting ≥ minSec (sample k covers [k/fps, (k+1)/fps))
export function blackRanges(flags, fps = SAMPLE_FPS, durationSec = flags.length / fps, minSec = MIN_BLACK_SEC) {
  const out = [];
  let start = -1;
  for (let k = 0; k <= flags.length; k++) {
    if (k < flags.length && flags[k]) { if (start < 0) start = k; continue; }
    if (start < 0) continue;
    const s = start / fps, e = Math.min(durationSec, k / fps);
    if (e - s >= minSec - 1e-9) out.push({startSec: round2(s), endSec: round2(e)});
    start = -1;
  }
  return out;
}

export function daylight(frames) {
  const lit = frames.filter((f) => !f.black);
  if (!lit.length) return {label: 'unknown', medianLuma: null, skyRatio: 0, why: 'no non-black frame'};
  const med = median(lit.map((f) => f.mean));
  const skyRatio = lit.filter((f) => f.sky).length / lit.length;
  let label = 'uncertain', why = `median luma ${med.toFixed(2)} between 0.22 and 0.42`;
  if (skyRatio >= 0.3) { label = 'day'; why = `bright sky-like top band in ${Math.round(skyRatio * 100)} % of frames`; }
  else if (med >= 0.42) { label = 'day'; why = `median luma ${med.toFixed(2)} ≥ 0.42`; }
  else if (med <= 0.22) { label = 'night'; why = `median luma ${med.toFixed(2)} ≤ 0.22 (night or a dark interior)`; }
  return {label, medianLuma: round2(med), skyRatio: round2(skyRatio), why};
}

export function motion(frames) {
  const lit = frames.filter((f) => !f.black);
  if (lit.length < 2) return {label: lit.length ? 'static' : 'unknown', meanDiff: 0};
  let total = 0;
  for (let k = 1; k < lit.length; k++) {
    const a = lit[k - 1].luma, b = lit[k].luma;
    let d = 0;
    for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
    total += d / a.length / 255;
  }
  const meanDiff = total / (lit.length - 1);
  return {label: meanDiff < 0.012 ? 'static' : 'moving', meanDiff: Math.round(meanDiff * 1000) / 1000};
}

// silencedetect lines → silent spans (an open silence runs to the end)
export function silenceRanges(stderr, durationSec) {
  const out = [];
  let start = null;
  for (const m of stderr.matchAll(/silence_(start|end): *(-?[\d.]+)/g)) {
    if (m[1] === 'start') start = Math.max(0, +m[2]);
    else if (start != null) { out.push({startSec: round2(start), endSec: round2(+m[2])}); start = null; }
  }
  if (start != null && durationSec) out.push({startSec: round2(start), endSec: round2(durationSec)});
  return out;
}

const overlap = (a, b) => a.reduce((s, x) => s + b.reduce((t, y) => t + Math.max(0, Math.min(x.endSec, y.endSec) - Math.max(x.startSec, y.startSec)), 0), 0);

// the tags an agent filters on — every one derived from measured numbers or the heuristics above
export function tagsFor(e) {
  const t = [];
  if (e.kind === 'audio') t.push('audio-only');
  if (e.kind === 'image') t.push('still-image');
  if (e.kind === 'video' && !e.hasAudio) t.push('no-audio');
  if (e.orientation) t.push(e.orientation);
  if (e.kind === 'video' && e.durationSec != null && e.durationSec < 2) t.push('short');
  if (e.black?.spans?.length) {
    t.push('has-black');
    if (e.black.ratio >= 0.5) t.push('mostly-black');
    if (e.black.spans[0].startSec <= 0.25) t.push('starts-black');
    if (e.durationSec && e.black.spans.at(-1).endSec >= e.durationSec - 0.25) t.push('ends-black');
    // speech over black: a voice-over waiting for B-roll
    if (e.hasAudio && e.black.totalSec - overlap(e.black.spans, e.silence?.spans ?? []) >= 1) t.push('audio-over-black');
  }
  if (e.hasAudio && e.durationSec && e.silence && e.silence.totalSec >= e.durationSec * 0.95) t.push('silent-audio');
  if (e.daylight?.label === 'day' || e.daylight?.label === 'night') t.push(e.daylight.label);
  if (e.daylight?.skyRatio >= 0.3) t.push('sky');
  if (e.kind === 'video' && (e.motion?.label === 'static' || e.motion?.label === 'moving')) t.push(e.motion.label);
  if (e.speech?.words) t.push('speech');
  return t;
}

export function describe(e) {
  const parts = [];
  const dims = e.width ? ` ${e.width}×${e.height}` : '';
  if (e.kind === 'audio') parts.push(`${fmt(e.durationSec)} s audio only`);
  else if (e.kind === 'image') parts.push(`still image${dims}`);
  else parts.push(`${fmt(e.durationSec)} s ${e.orientation ?? ''} video${dims}${e.fps ? ` ${e.fps}fps` : ''}${e.hasAudio ? '' : ', no audio'}`.replace(/  +/g, ' '));
  if (e.black?.spans?.length) parts.push(`black ${e.black.spans.map((s) => `${fmt(s.startSec)}–${fmt(s.endSec)} s`).join(', ')} (${Math.round(e.black.ratio * 100)} %)`);
  if (e.kind !== 'audio' && e.daylight && e.daylight.label !== 'unknown') parts.push(`${e.daylight.label === 'uncertain' ? 'day/night uncertain' : e.daylight.label} (heuristic)`);
  if (e.kind === 'video' && e.motion && e.motion.label !== 'unknown') parts.push(`${e.motion.label} (heuristic)`);
  if (e.speech?.text) parts.push(`speech: "${e.speech.text}"`);
  if (e.meta?.desc) parts.push(`metadata: ${e.meta.desc}`);
  if (e.meta?.tags?.length) parts.push(`metadata tags: ${e.meta.tags.join(', ')}`);
  return parts.join(' · ');
}

// ---------- ffmpeg ----------

const THREADS = () => String(process.env.REEL_CATALOG_THREADS || 1);

function runAsync(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, {stdio: ['ignore', 'pipe', 'pipe']});
    const out = [], err = [];
    p.stdout.on('data', (d) => out.push(d)); p.stderr.on('data', (d) => err.push(d));
    p.on('error', (e) => resolve({status: -1, stdout: Buffer.alloc(0), stderr: String(e)}));
    p.on('close', (status) => resolve({status, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString()}));
  });
}

export function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate:stream_side_data=rotation:format=duration:format_tags=title,comment,description', '-of', 'json', file], {encoding: 'utf8'});
  if (r.status !== 0) throw new Error(`ffprobe failed: ${(r.stderr || '').trim().split('\n').pop()}`);
  const d = JSON.parse(r.stdout);
  const streams = d.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  let w = v?.width ?? null, h = v?.height ?? null;
  if (v && (v.side_data_list ?? []).some((x) => x.rotation && Math.abs(x.rotation) % 180 === 90)) [w, h] = [h, w];
  const rate = (s) => { const [n, q] = String(s || '0/1').split('/').map(Number); return q ? n / q : 0; };
  const fps = v ? Math.round((rate(v.avg_frame_rate) || rate(v.r_frame_rate)) * 100) / 100 || null : null;
  const dur = parseFloat(d.format?.duration);
  const tags = d.format?.tags ?? {};
  const title = [tags.title, tags.description, tags.comment].filter((x) => x && String(x).trim()).map((x) => String(x).trim().slice(0, 160));
  return {durationSec: Number.isFinite(dur) ? round2(dur) : null, width: w, height: h, fps, codec: v?.codec_name ?? a?.codec_name ?? null, hasVideo: Boolean(v), hasAudio: Boolean(a), containerText: title};
}

export const sheetLayout = (e) => {
  const n = e.kind === 'image' ? 1 : (e.durationSec ?? 0) <= 20 ? 6 : (e.durationSec ?? 0) <= 90 ? 9 : 12;
  return {n, cols: Math.min(3, n), rows: Math.ceil(n / 3)};
};
// frame k of the sheet sits at the middle of the k-th n-th of the clip
export const sheetTimes = (durationSec, n) => Array.from({length: n}, (_, k) => round2(((k + 0.5) * durationSec) / n));
const cellWidth = (e) => (e.width && e.height && e.width > e.height ? 320 : 180);

// the contact sheet's filter: the first frame at or after each (k + ½)·dur/n — select on absolute times, so no drift
function sheetFilter(e) {
  const {n, cols, rows} = sheetLayout(e);
  const dur = e.durationSec || 1;
  const step = dur / n, t0 = step / 2;
  const pick = `select='gte(t,${t0})*(isnan(prev_selected_t)+gt(floor((t-${t0})/${step}),floor((prev_selected_t-${t0})/${step})))'`;
  return {vf: `${pick},scale=${cellWidth(e)}:-2,tile=${cols}x${rows}:padding=4:color=white`, times: sheetTimes(dur, n), cols, rows};
}

// ONE decode per file: tiny analysis frames on stdout, the contact sheet to its JPEG,
// silence / loudness from the audio — the decode is the expensive part, so it is never repeated
async function analyzeStreams(file, e, {hasAudio, sheetOut}) {
  const args = ['-hide_banner', '-nostats', '-v', 'info', '-threads', THREADS(), '-i', file];
  let sheet = null;
  const raw = ['-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'];
  const tiny = `scale=${GRID}:${GRID}:flags=area,format=rgb24`;
  if (e.kind === 'image') {
    args.push('-map', '0:v:0', '-vf', tiny, '-frames:v', '1', ...raw);
    if (sheetOut) { args.push('-map', '0:v:0', '-vf', `scale=${cellWidth(e) * 2}:-2`, '-frames:v', '1', '-y', sheetOut); sheet = {times: [], cols: 1, rows: 1}; }
  } else if (e.kind === 'video') {
    if (sheetOut) {
      sheet = sheetFilter(e);
      args.push('-filter_complex', `[0:v:0]split=2[a][b];[a]fps=${SAMPLE_FPS},${tiny}[raw];[b]${sheet.vf}[sheet]`, '-map', '[raw]', ...raw, '-map', '[sheet]', '-frames:v', '1', '-q:v', '4', '-y', sheetOut);
      delete sheet.vf;
    } else args.push('-map', '0:v:0', '-vf', `fps=${SAMPLE_FPS},${tiny}`, ...raw);
  }
  if (hasAudio) args.push('-map', '0:a:0', '-af', `silencedetect=n=${SILENCE_DB}dB:d=0.5,volumedetect`, '-f', 'null', '-');
  if (sheetOut) { fs.mkdirSync(path.dirname(sheetOut), {recursive: true}); fs.rmSync(sheetOut, {force: true}); }
  const r = await runAsync('ffmpeg', args);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.trim().split('\n').pop()}`);
  if (sheetOut && !fs.existsSync(sheetOut)) throw new Error('contact sheet was not written');
  const size = GRID * GRID * 3;
  const frames = [];
  for (let o = 0; o + size <= r.stdout.length; o += size) frames.push(frameStats(r.stdout.subarray(o, o + size)));
  const mean = r.stderr.match(/mean_volume: *(-?[\d.]+|-inf) dB/);
  return {frames, sheet, stderr: r.stderr, meanDb: mean ? (mean[1] === '-inf' ? -120 : +mean[1]) : null};
}

// everything that needs a decode (the expensive part — cached by size + mtime)
export async function analyzeFile(file, {sheetOut} = {}) {
  const kind = mediaKind(file);
  const pr = probe(file);
  const e = {kind, durationSec: kind === 'image' ? null : pr.durationSec, width: pr.width, height: pr.height, fps: kind === 'video' ? pr.fps : null, codec: pr.codec, hasAudio: pr.hasAudio, containerText: pr.containerText};
  if (e.width && e.height) e.orientation = e.width > e.height * 1.05 ? 'landscape' : e.height > e.width * 1.05 ? 'portrait' : 'square';
  if (kind === 'video' && !pr.hasVideo) e.kind = 'audio';
  if (e.kind === 'audio') { e.width = e.height = e.fps = null; delete e.orientation; } // an mp3's cover art is not footage
  const s = await analyzeStreams(file, e, {hasAudio: e.kind !== 'image' && pr.hasAudio, sheetOut: e.kind !== 'audio' ? sheetOut?.abs : null});
  if (e.kind === 'video') {
    const dur = e.durationSec ?? s.frames.length / SAMPLE_FPS;
    const spans = blackRanges(s.frames.map((f) => f.black), SAMPLE_FPS, dur);
    const totalSec = round2(spans.reduce((t, x) => t + x.endSec - x.startSec, 0));
    e.black = {spans, totalSec, ratio: dur ? round2(totalSec / dur) : 0, samples: s.frames.length, resolutionSec: 1 / SAMPLE_FPS};
  }
  if (e.kind !== 'audio') {
    e.daylight = daylight(s.frames);
    if (e.kind === 'video') e.motion = motion(s.frames);
  }
  if (e.kind !== 'image' && pr.hasAudio) {
    const spans = silenceRanges(s.stderr, e.durationSec);
    e.silence = {spans, totalSec: round2(spans.reduce((t, x) => t + x.endSec - x.startSec, 0)), thresholdDb: SILENCE_DB};
    e.meanDb = s.meanDb;
  }
  if (s.sheet) e.sheet = {...s.sheet, file: sheetOut.rel};
  return e;
}

// ---------- cheap context (re-read every run) ----------

const stem = (name) => name.replace(/\.[^.]+$/, '');

// words the transcription pipeline cached for this source (scripts/lib-transcribe.mjs: clips/transcripts/<stem>.<lang>.json)
export function transcriptFor(publicDir, name) {
  const dir = path.join(publicDir, 'clips', 'transcripts');
  let files = [];
  const key = `${stem(name)}.`;
  try { files = fs.readdirSync(dir).filter((f) => f.startsWith(key) && /^[\w-]+\.json$/.test(f.slice(key.length)) && !/^(loud|spk)\.json$/.test(f.slice(key.length))); } catch { return null; }
  for (const f of files) {
    try {
      const words = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!Array.isArray(words) || !words.length) continue;
      const all = words.map((w) => String(w.word ?? '').trim()).filter(Boolean);
      const text = all.slice(0, 30).join(' ');
      return {source: `clips/transcripts/${f}`, lang: f.slice(key.length, -5), words: all.length, text: all.length > 30 ? `${text} …` : text};
    } catch {}
  }
  return null;
}

// what someone already wrote about a file: the dir's library.json (B-roll tags, music titles) and container tags
function metadataFor(library, dir, name, containerText) {
  const rel = `${dir}/${name}`;
  const row = library.find((r) => r && (r.src === rel || r.src === name || (r.src && path.basename(String(r.src)) === name)));
  const tags = Array.isArray(row?.tags) ? row.tags.map(String).slice(0, 12) : [];
  const desc = [row?.desc, row?.title && `${row.title}${row.creator ? ` by ${row.creator}` : ''}`, row?.label && row.label !== stem(name) ? row.label : null, ...(containerText ?? [])].filter((x) => x && String(x).trim()).join(' — ').slice(0, 240);
  return tags.length || desc ? {tags, desc, source: row ? `${dir}/library.json` : 'container tags'} : null;
}

function annotate(entry, {publicDir, dir, name, library}) {
  const e = {...entry};
  delete e.speech; delete e.meta;
  const speech = e.kind === 'image' ? null : transcriptFor(publicDir, name);
  const meta = metadataFor(library, dir, name, e.containerText);
  if (speech) e.speech = speech;
  if (meta) e.meta = meta;
  e.descSource = speech ? 'transcript' : meta ? 'metadata' : 'heuristic';
  e.tags = e.error ? ['unreadable'] : tagsFor(e);
  e.desc = e.error ? `could not analyze: ${e.error}` : describe(e);
  return e;
}

// ---------- catalog files ----------

export const catalogName = (dir) => dir.replace(/[\\/]+/g, '__');
export const catalogFile = (publicDir, dir) => path.join(publicDir, 'catalog', `${catalogName(dir)}.json`);

export function safeDir(publicDir, dir) {
  const abs = path.resolve(publicDir, dir);
  const rel = path.relative(publicDir, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep)[0] === 'catalog') throw new Error(`not a media folder under public/: ${dir}`);
  return rel.split(path.sep).join('/');
}

export function loadCatalog(publicDir, dir) {
  try { return JSON.parse(fs.readFileSync(catalogFile(publicDir, dir), 'utf8')); } catch { return null; }
}
function saveCatalog(publicDir, dir, cat) {
  const f = catalogFile(publicDir, dir);
  fs.mkdirSync(path.dirname(f), {recursive: true});
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(cat, null, 2));
  fs.renameSync(`${f}.tmp`, f);
}

function listMedia(abs) {
  let names = [];
  try { names = fs.readdirSync(abs, {withFileTypes: true}).filter((d) => d.isFile() && mediaKind(d.name) && !d.name.startsWith('.')).map((d) => d.name).sort(); } catch {}
  return names.map((name) => { const st = fs.statSync(path.join(abs, name)); return {name, size: st.size, mtimeMs: Math.round(st.mtimeMs)}; });
}
const unchanged = (prev, f) => prev && prev.version === CATALOG_VERSION && prev.size === f.size && prev.mtimeMs === f.mtimeMs;

// files new or changed since the catalog was written (a stat per file, no decode)
export function staleFiles(publicDir, dir) {
  const cat = loadCatalog(publicDir, dir);
  const files = listMedia(path.join(publicDir, dir));
  return files.filter((f) => !unchanged(cat?.files?.[f.name], f)).map((f) => f.name);
}

// analyze what is new or changed in public/<dir>, drop what is gone; returns a summary
export async function catalogDir(publicDir, dir, {force = false, limit = Infinity, log = () => {}} = {}) {
  dir = safeDir(publicDir, dir);
  const abs = path.join(publicDir, dir);
  const prev = loadCatalog(publicDir, dir)?.files ?? {};
  let library = [];
  try { const l = JSON.parse(fs.readFileSync(path.join(abs, 'library.json'), 'utf8')); if (Array.isArray(l)) library = l; } catch {}
  const files = listMedia(abs);
  const sheetsDir = path.join(publicDir, 'catalog', 'sheets', catalogName(dir));
  const out = {};
  const summary = {dir, files: files.length, analyzed: [], reused: 0, removed: [], errors: [], pending: 0};
  const cat = () => ({version: CATALOG_VERSION, dir, generatedAt: new Date().toISOString(), legend: LEGEND, files: out});
  for (const f of files) {
    const old = prev[f.name];
    const sheetOk = !old?.sheet || fs.existsSync(path.join(publicDir, old.sheet.file));
    if (!force && unchanged(old, f) && sheetOk) { out[f.name] = annotate(old, {publicDir, dir, name: f.name, library}); summary.reused++; continue; }
    if (summary.analyzed.length >= limit) { if (old) out[f.name] = old; summary.pending++; continue; }
    log(`analyzing ${dir}/${f.name}`);
    let e;
    const sheetRel = `catalog/sheets/${catalogName(dir)}/${f.name}.jpg`;
    try {
      e = await analyzeFile(path.join(abs, f.name), {sheetOut: {abs: path.join(publicDir, sheetRel), rel: sheetRel}});
    } catch (err) {
      e = {kind: mediaKind(f.name), error: String(err.message ?? err).slice(0, 200)};
      summary.errors.push(`${f.name}: ${e.error}`);
    }
    out[f.name] = annotate({src: `${dir}/${f.name}`, ...e, size: f.size, mtimeMs: f.mtimeMs, version: CATALOG_VERSION, analyzedAt: new Date().toISOString()}, {publicDir, dir, name: f.name, library});
    summary.analyzed.push(f.name);
    saveCatalog(publicDir, dir, cat()); // progress survives a kill
  }
  for (const name of Object.keys(prev)) {
    if (out[name]) continue;
    summary.removed.push(name);
    const s = prev[name].sheet?.file;
    if (s) fs.rmSync(path.join(publicDir, s), {force: true});
  }
  if (files.length || Object.keys(prev).length) saveCatalog(publicDir, dir, cat());
  return summary;
}

export async function buildCatalog(publicDir, dirs = DEFAULT_DIRS, opts = {}) {
  const out = [];
  let left = opts.limit ?? Infinity;
  for (const d of dirs) {
    if (!fs.existsSync(path.join(publicDir, d))) { out.push({dir: d, files: 0, analyzed: [], reused: 0, removed: [], errors: [], pending: 0, missing: true}); continue; }
    const s = await catalogDir(publicDir, d, {...opts, limit: left});
    left -= s.analyzed.length;
    out.push(s);
  }
  return out;
}

// ---------- query (MCP search_catalog, GET /api/catalog) ----------

// every cataloged entry, with its dir
export function loadEntries(publicDir, dirs) {
  const catDir = path.join(publicDir, 'catalog');
  if (!dirs) { try { dirs = fs.readdirSync(catDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(catDir, f), 'utf8')).dir).filter(Boolean); } catch { dirs = []; } }
  return dirs.flatMap((d) => Object.entries(loadCatalog(publicDir, d)?.files ?? {}).map(([name, e]) => ({name, dir: d, src: `${d}/${name}`, ...e})));
}

const words = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9ñ]+/).filter((w) => w.length > 1);

// filters over content — never over the file name
export function searchCatalog(entries, q = {}) {
  const want = new Set(words(q.text));
  const rows = [];
  for (const e of entries) {
    if (e.error && !q.includeErrors) continue;
    if (q.dir && e.dir !== q.dir) continue;
    if (q.kind && e.kind !== q.kind) continue;
    // a duration filter asks for footage/audio of that length: stills (no duration) never match it
    if (q.minSec != null && !(typeof e.durationSec === 'number' && e.durationSec >= q.minSec)) continue;
    if (q.maxSec != null && !(typeof e.durationSec === 'number' && e.durationSec <= q.maxSec)) continue;
    if (q.daylight && e.daylight?.label !== q.daylight) continue;
    if (q.orientation && e.orientation !== q.orientation) continue;
    if (q.hasBlack != null && Boolean(e.black?.spans?.length) !== q.hasBlack) continue;
    if (q.maxBlackRatio != null && (e.black?.ratio ?? 0) > q.maxBlackRatio) continue;
    if (q.hasSpeech != null && Boolean(e.speech?.words) !== q.hasSpeech) continue;
    if (q.tags?.length && !q.tags.every((t) => e.tags?.includes(t))) continue;
    if (q.excludeTags?.length && q.excludeTags.some((t) => e.tags?.includes(t))) continue;
    let score = 0;
    if (want.size) {
      const have = new Set(words([e.desc, e.speech?.text, e.meta?.desc, ...(e.meta?.tags ?? []), ...(e.tags ?? [])].join(' ')));
      score = [...want].filter((w) => have.has(w)).length;
      if (!score) continue;
    }
    rows.push({e, score});
  }
  rows.sort((a, b) => b.score - a.score || a.e.src.localeCompare(b.e.src));
  return rows.slice(0, q.limit ?? 50).map((r) => r.e);
}

export const entryLine = (e) => `${e.src} — ${e.desc}${e.tags?.length ? `\n  tags: ${e.tags.join(', ')}` : ''}${e.sheet ? `\n  sheet: ${e.sheet.file}${e.sheet.times?.length ? ` (${e.sheet.cols}×${e.sheet.rows}, frames at ${e.sheet.times.map(fmt).join(', ')} s)` : ''}` : ''}${e.descSource ? `\n  description from: ${e.descSource}` : ''}`;

// ---------- helpers ----------

function median(xs) { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function round2(x) { return Math.round(x * 100) / 100; }
function fmt(x) { return x == null ? '?' : String(Math.round(x * 10) / 10); }

// ---------- CLI ----------

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
  const publicDir = path.resolve(opt('--public') ?? path.join(ROOT, 'public'));
  const limit = opt('--limit');
  const force = argv.includes('--force');
  const asJson = argv.includes('--json');
  const dirs = argv.filter((a) => !a.startsWith('--'));
  const nice = Number(process.env.REEL_CATALOG_NICE ?? 15);
  try { if (nice > 0) os.setPriority(0, Math.min(19, nice)); } catch {} // children (ffmpeg) inherit it
  const log = asJson ? () => {} : (m) => console.error(m);
  try {
    const res = await buildCatalog(publicDir, dirs.length ? dirs : DEFAULT_DIRS, {force, limit: limit ? Math.max(1, +limit) : Infinity, log});
    if (asJson) process.stdout.write(JSON.stringify(res));
    else for (const s of res) console.log(s.missing ? `${s.dir}: (no folder)` : `${s.dir}: ${s.files} file(s), ${s.analyzed.length} analyzed, ${s.reused} unchanged, ${s.removed.length} removed${s.pending ? `, ${s.pending} left for the next run` : ''}${s.errors.length ? `\n  errors: ${s.errors.join('; ')}` : ''} → ${path.relative(ROOT, catalogFile(publicDir, s.dir))}`);
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(1);
  }
}
