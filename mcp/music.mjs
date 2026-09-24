// Music with clean licenses: Openverse audio (CC0 and CC BY, commercial use)
// searched live, downloaded through the same SSRF-guarded fetch as the other
// assets into public/music/, indexed with attribution in public/music/library.json.
import fs from 'node:fs';
import path from 'node:path';
import {fetchPublic} from './assets.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MUSIC = path.join(ROOT, 'public', 'music');
const INDEX = path.join(MUSIC, 'library.json');

export const loadMusicLibrary = () => { try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { return []; } };
const saveMusicLibrary = (lib) => { fs.mkdirSync(MUSIC, {recursive: true}); fs.writeFileSync(INDEX, JSON.stringify(lib, null, 2)); };

// rows: {id, title, creator, license, durationSec, url, page, source}
export async function searchMusic(query, {limit = 6, minSec = 20, maxSec = 600} = {}) {
  const u = `https://api.openverse.org/v1/audio/?q=${encodeURIComponent(query)}&license=cc0,by&license_type=commercial&page_size=${Math.min(20, limit * 3)}`;
  const d = await (await fetchPublic(u)).json();
  return (d.results ?? [])
    .filter((r) => r.url && r.duration && r.duration / 1000 >= minSec && r.duration / 1000 <= maxSec && /^https:\/\//.test(r.url))
    .slice(0, limit)
    .map((r) => ({id: `ov-${r.id}`, title: r.title ?? 'untitled', creator: r.creator ?? r.source ?? 'unknown', license: String(r.license).toUpperCase() + (r.license_version ? ` ${r.license_version}` : ''), durationSec: Math.round(r.duration / 1000), url: r.url, page: r.foreign_landing_url ?? '', source: r.source ?? 'openverse'}));
}

// credit line to keep with the reel (CC BY requires it; CC0 does not, but we keep it anyway)
export const creditOf = (row) => `"${row.title}" by ${row.creator} (${row.license}, via Openverse${row.page ? `, ${row.page}` : ''})`;

export async function downloadMusic(row) {
  fs.mkdirSync(MUSIC, {recursive: true});
  const ext = /\.(ogg|wav|flac|m4a)(\?|$)/i.exec(row.url)?.[1]?.toLowerCase() ?? 'mp3';
  const file = path.join(MUSIC, `${row.id}.${ext}`);
  if (!fs.existsSync(file)) {
    const r = await fetchPublic(row.url);
    if (!r.ok) throw new Error(`music download ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 20000) throw new Error('music download too small to be a track');
    fs.writeFileSync(file, buf);
  }
  const entry = {...row, src: `music/${row.id}.${ext}`, credit: creditOf(row), addedAt: new Date().toISOString()};
  const lib = loadMusicLibrary().filter((e) => e.id !== row.id);
  lib.push(entry); saveMusicLibrary(lib);
  return entry;
}
