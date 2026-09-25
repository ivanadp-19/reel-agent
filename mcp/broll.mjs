// The user's own B-roll library: footage and photos ingested through the
// backend into public/broll-assets/, indexed in public/broll-assets/library.json
// with the tags and description the agent writes after looking at a contact
// sheet. Black stretches of a source (an intentional hold) are detected once
// per file so suggest_broll can insist they get covered. ffmpeg runs as an async
// child: these run inside the backend (the editor's routes, the MCP over /mcp),
// whose event loop must keep serving while a long file is decoded.
import fs from 'node:fs';
import path from 'node:path';
import {runCmd} from '../scripts/remote-broll.mjs';
import {contentWords} from '../src/brollMatch.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const DIR = path.join(PUBLIC, 'broll-assets');
const INDEX = path.join(DIR, 'library.json');
const SHEETS = path.join(DIR, 'sheets');
const BLACK = path.join(PUBLIC, 'clips', 'black');

export const loadLibrary = () => { try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { return []; } };
const saveLibrary = (lib) => { fs.mkdirSync(DIR, {recursive: true}); fs.writeFileSync(INDEX, JSON.stringify(lib, null, 2)); };
export function upsertAsset(entry) {
  const lib = loadLibrary();
  const i = lib.findIndex((e) => e.id === entry.id);
  if (i >= 0) lib[i] = {...lib[i], ...entry}; else lib.push({tags: [], desc: '', addedAt: new Date().toISOString(), ...entry});
  saveLibrary(lib);
  return lib.find((e) => e.id === entry.id);
}
export function searchLibrary(query) {
  const lib = loadLibrary();
  if (!query) return lib;
  const q = new Set(contentWords(query));
  return lib.map((e) => ({e, n: contentWords([...e.tags, e.desc, e.label].join(' ')).filter((t) => q.has(t)).length})).filter((x) => x.n).sort((a, b) => b.n - a.n).map((x) => x.e);
}

// 6 frames across a video (or the image itself), 3 × 2, cached. ffmpeg writes a
// part file renamed into place, so sheets/<id>.jpg only ever exists complete: a
// failed pass leaves no sheet (a later trigger retries) and a concurrent reader
// never sees a half-written one.
export const sheetPath = (asset, sheetsDir = SHEETS) => path.join(sheetsDir, `${asset.id}.jpg`);
export async function sheetFor(asset, {publicDir = PUBLIC, sheetsDir = SHEETS} = {}) {
  fs.mkdirSync(sheetsDir, {recursive: true});
  const out = sheetPath(asset, sheetsDir);
  if (fs.existsSync(out)) return out;
  const src = path.join(publicDir, asset.src);
  const part = path.join(sheetsDir, `${asset.id}.${process.pid}.part.jpg`);
  const dur = asset.durationSec || 1;
  const n = 6;
  const vf = asset.kind === 'image' ? ['-vf', 'scale=540:-2'] : ['-vf', `fps=${(n - 0.01) / dur},scale=300:-2,tile=3x2`, '-frames:v', '1'];
  try {
    const r = await runCmd('ffmpeg', ['-v', 'error', '-y', '-i', src, ...vf, part]);
    if (r.code !== 0 || !fs.existsSync(part)) throw new Error(`contact sheet failed: ${r.stderr.trim().split('\n').pop() || `ffmpeg exit ${r.code}`}`);
    fs.renameSync(part, out);
  } finally { fs.rmSync(part, {force: true}); }
  return out;
}

// Contact sheets off the request path (GET /api/broll-library, the upload): `kick`
// starts one in the background and never throws; one pass per asset id at a time
// (a second trigger while it runs joins it), `concurrency` passes at once over the
// whole library (a batch of 18 uploads must not start 18 ffmpegs on a 2-vCPU box).
// A failure is logged and remembered for `retryAfterMs` only — no permanent failure
// is cached, the next trigger after that tries again.
export function createSheetJobs({publicDir = PUBLIC, sheetsDir = SHEETS, generate = (a) => sheetFor(a, {publicDir, sheetsDir}), exists = (a) => fs.existsSync(sheetPath(a, sheetsDir)), concurrency = 1, retryAfterMs = 30_000, log = (m) => console.error(m), now = Date.now} = {}) {
  const inflight = new Map(); // id → promise (queued or running)
  const failedAt = new Map(); // id → ms of the last failure
  const waiting = [];
  let running = 0;
  const pump = () => {
    while (running < concurrency && waiting.length) {
      const {asset, resolve} = waiting.shift();
      running++;
      const settle = (f) => { running--; inflight.delete(asset.id); resolve(f); pump(); }; // free the id first: a trigger right after retries
      Promise.resolve().then(() => generate(asset)).then(
        (f) => { failedAt.delete(asset.id); settle(f); },
        (e) => { failedAt.set(asset.id, now()); settle(null); try { log(`broll sheet ${asset.id}: ${String(e?.message ?? e).slice(0, 300)}`); } catch {} },
      ).catch(() => {});
    }
  };
  const has = (a) => { try { return !!exists(a); } catch { return false; } };
  const kick = (asset) => {
    if (!asset?.id) return Promise.resolve(null);
    const cur = inflight.get(asset.id);
    if (cur) return cur;
    if (has(asset)) return Promise.resolve(sheetPath(asset, sheetsDir));
    const t = failedAt.get(asset.id);
    if (t != null && now() - t < retryAfterMs) return Promise.resolve(null);
    const p = new Promise((resolve) => waiting.push({asset, resolve}));
    inflight.set(asset.id, p);
    pump();
    return p; // resolves to the sheet's path, or null when it failed — never rejects
  };
  // the sheet's public URL when it is cached, else null
  const url = (a) => (has(a) ? '/' + path.relative(publicDir, sheetPath(a, sheetsDir)).split(path.sep).join('/') : null);
  return {kick, url, pending: (id) => inflight.has(id)};
}

// The library as GET /api/broll-library answers it: each asset with `sheet`, its
// public URL when the cached sheet exists, else null — and a background pass for
// every missing one. Never waits on ffmpeg.
export const withSheets = (rows, jobs) => rows.map((a) => {
  const sheet = jobs.url(a);
  if (!sheet) jobs.kick(a);
  return {...a, sheet};
});

// black stretches (≥ 0.4 s) of a source, source-relative ms, cached per file
export async function blackSpans(src) {
  fs.mkdirSync(BLACK, {recursive: true});
  const cache = path.join(BLACK, `${path.basename(src).replace(/\.[^.]+$/, '')}.json`);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const r = await runCmd('ffmpeg', ['-hide_banner', '-nostats', '-i', path.join(PUBLIC, src), '-an', '-vf', 'blackdetect=d=0.4:pix_th=0.10', '-f', 'null', '-'], {stderrMax: 1 << 26});
  const spans = [...r.stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => ({startMs: Math.round(+m[1] * 1000), endMs: Math.round(+m[2] * 1000)}));
  fs.writeFileSync(cache, JSON.stringify(spans));
  return spans;
}

// A B-roll src as the render reads it (add_broll and edit_broll): URLs stay (the
// backend downloads Pexels at render time), an absolute file is copied into
// public/broll/ — a cue must never point outside public/, the render cannot read
// it —, a path inside public/ must exist.
export function brollSrc(src, publicDir = PUBLIC) {
  if (/^https?:/.test(src)) return src;
  if (path.isAbsolute(src)) {
    if (!fs.existsSync(src)) throw new Error(`file not found: ${src}`);
    const dir = path.join(publicDir, 'broll'); fs.mkdirSync(dir, {recursive: true});
    const name = path.basename(src).replace(/[^\w.\-]/g, '_'); fs.copyFileSync(src, path.join(dir, name));
    return `broll/${name}`;
  }
  if (!path.resolve(publicDir, src).startsWith(path.resolve(publicDir) + path.sep) || !fs.existsSync(path.join(publicDir, src))) throw new Error(`not found in public/: ${src}`);
  return src;
}
export const brollKind = (src) => (/\.(jpe?g|png|webp)(\?|$)/i.test(src) ? 'image' : 'video');
