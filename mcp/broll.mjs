// The user's own B-roll library: footage and photos ingested through the
// backend into public/broll-assets/, indexed in public/broll-assets/library.json
// with the tags and description the agent writes after looking at a contact
// sheet. Black stretches of a source (an intentional hold) are detected once
// per file so suggest_broll can insist they get covered.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
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

// 6 frames across a video (or the image itself), 3 × 2, cached
export function sheetFor(asset) {
  fs.mkdirSync(SHEETS, {recursive: true});
  const out = path.join(SHEETS, `${asset.id}.jpg`);
  if (fs.existsSync(out)) return out;
  const src = path.join(PUBLIC, asset.src);
  if (asset.kind === 'image') { spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', 'scale=540:-2', out]); return out; }
  const dur = asset.durationSec || 1;
  const n = 6;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', `fps=${(n - 0.01) / dur},scale=300:-2,tile=3x2`, '-frames:v', '1', out]);
  if (r.status !== 0) throw new Error(`contact sheet failed: ${r.stderr.toString().trim().split('\n').pop()}`);
  return out;
}

// black stretches (≥ 0.4 s) of a source, source-relative ms, cached per file
export function blackSpans(src) {
  fs.mkdirSync(BLACK, {recursive: true});
  const cache = path.join(BLACK, `${path.basename(src).replace(/\.[^.]+$/, '')}.json`);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', path.join(PUBLIC, src), '-an', '-vf', 'blackdetect=d=0.4:pix_th=0.10', '-f', 'null', '-'], {encoding: 'utf8', maxBuffer: 1 << 26});
  const spans = [...r.stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => ({startMs: Math.round(+m[1] * 1000), endMs: Math.round(+m[2] * 1000)}));
  fs.writeFileSync(cache, JSON.stringify(spans));
  return spans;
}
