// Decorative assets for the agent: SEARCH (Iconify, Fluent Emoji 3D, Openverse)
// and GENERATE (OpenAI Images, transparent PNG). Nothing is drawn by hand.
// Results are downloaded into public/assets/<source>/ so the render reads local
// files; attribution is returned when the license asks for it.
// See research/asset-sourcing.md for the license reasoning.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import https from 'node:https';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const ASSETS = path.join(PUBLIC, 'assets');
const UA = 'reel-agent (https://github.com/ivanadp-19/reel-agent)';

// ---------- safe downloads ----------
const PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^::1$/, /^f[cd]/i, /^fe80/i, /^::ffff:/i];
export const isPrivateAddress = (ip) => PRIVATE.some((r) => r.test(ip));

// https only, no IP literals, no private ranges, redirects re-checked hop by
// hop. The address that passed the check is PINNED for the connection (a
// rebinding DNS cannot answer differently for the real request); TLS still
// verifies the hostname.
function requestPinned(u, address, family) {
  return new Promise((resolve, reject) => {
    const req = https.request(u, {
      method: 'GET',
      headers: {'User-Agent': UA, Accept: '*/*'},
      // net may ask for one address or (options.all) a list — answer both with the pinned one
      lookup: (_host, opts, cb) => (opts?.all ? cb(null, [{address, family}]) : cb(null, address, family)),
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks)}));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
export async function fetchPublic(url, hops = 0) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error(`refusing ${url}: https only`);
  if (net.isIP(u.hostname) || u.hostname === 'localhost') throw new Error(`refusing ${url}: no IP literals`);
  const {address, family} = await dns.lookup(u.hostname);
  if (isPrivateAddress(address)) throw new Error(`refusing ${url}: resolves to a private address`);
  const r = await requestPinned(u, address, family);
  if ([301, 302, 303, 307, 308].includes(r.status)) {
    if (hops >= 3) throw new Error('too many redirects');
    return fetchPublic(new URL(r.headers.location ?? '', u).href, hops + 1);
  }
  if (r.status < 200 || r.status >= 300) throw new Error(`${r.status} fetching ${url}`);
  // fetch-like surface for the callers
  return {ok: true, status: r.status, json: async () => JSON.parse(r.body.toString('utf8')), arrayBuffer: async () => r.body};
}
async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  fs.mkdirSync(path.dirname(dest), {recursive: true});
  const r = await fetchPublic(url);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  return dest;
}
const rel = (abs) => path.relative(PUBLIC, abs).split(path.sep).join('/');

// ---------- the local library ----------
// Everything searched or generated is registered in public/assets/library.json
// (per machine, gitignored) so it can be found again without hitting APIs or
// paying for another generation. Entries: {id, src, format, kind, source,
// license, credit, tags[], prompt?, title?, addedAt}
const LIBRARY = path.join(ASSETS, 'library.json');
const loadLibrary = () => { try { return JSON.parse(fs.readFileSync(LIBRARY, 'utf8')); } catch { return []; } };
const STOP = new Set(['a', 'an', 'the', 'of', 'with', 'and', 'or', 'in', 'on', 'for', 'to', 'is', 'it', 'de', 'la', 'el', 'los', 'las', 'un', 'una', 'con', 'y', 'o', 'en', 'del', 'al', 'que', 'por', 'para']);
const tokens = (s) => (String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9]{2,}/g) ?? []).filter((t) => !STOP.has(t));
// how much two prompts share (Jaccard on content words)
export const similarity = (a, b) => { const A = new Set(tokens(a)), B = new Set(tokens(b)); if (!A.size || !B.size) return 0; let n = 0; for (const t of A) if (B.has(t)) n++; return n / (A.size + B.size - n); };
export function libraryAdd(entry) {
  const lib = loadLibrary();
  if (lib.some((e) => e.src === entry.src)) return;
  fs.mkdirSync(ASSETS, {recursive: true});
  lib.push({...entry, addedAt: new Date().toISOString()});
  fs.writeFileSync(LIBRARY, JSON.stringify(lib, null, 1));
}
// rank library entries by how many query words hit their tags/title/prompt/id
export function librarySearch(query, {kind, limit = 6} = {}) {
  const q = new Set(tokens(query));
  if (!q.size) return [];
  return loadLibrary()
    .filter((e) => fs.existsSync(path.join(PUBLIC, e.src)) && (!kind || e.kind === kind || (kind === 'sticker' && e.kind !== 'texture')))
    .map((e) => ({e, hits: [...new Set([...tokens(e.tags?.join(' ')), ...tokens(e.title), ...tokens(e.prompt), ...tokens(e.id)])].filter((t) => q.has(t)).length}))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map((x) => ({...x.e, fromLibrary: true}));
}
export const listLibrary = () => loadLibrary();

// ---------- Iconify (icons, emoji, hand-drawn) ----------
// sets we search, by kind/style; licenses checked live against /collections
const SETS = {
  emoji: ['fluent-emoji', 'fluent-emoji-flat', 'noto', 'twemoji'],
  icon: ['lucide', 'ph', 'tabler', 'hugeicons', 'mdi', 'iconoir', 'mingcute', 'material-symbols'],
  sticker: ['fluent-emoji', 'streamline-freehand-color', 'streamline-plump-color', 'fluent-color', 'flat-color-icons', 'icon-park'],
  illustration: ['streamline-freehand-color', 'streamline-plump-color', 'icon-park', 'fluent-color'],
};
const STYLE_SETS = {
  'hand-drawn': ['streamline-freehand-color', 'streamline-freehand'],
  // Iconify's search does not index fluent-emoji; emoji names are shared across
  // sets, so 3D searches noto and maps each name onto Microsoft's 3D PNG
  '3d': ['noto', 'fluent-emoji-flat'],
  flat: ['fluent-emoji-flat', 'flat-color-icons', 'fluent-color', 'noto'],
  outline: ['lucide', 'ph', 'tabler', 'iconoir', 'streamline-freehand'],
};
const OK_LICENSES = /^(MIT|Apache-2\.0|ISC|CC0-1\.0|CC-BY-4\.0|CC-BY-3\.0|OFL-1\.1)$/i;
const NEEDS_CREDIT = /^CC-BY/i;

let collections = null;
async function iconifyCollections() {
  if (!collections) collections = await (await fetchPublic('https://api.iconify.design/collections')).json();
  return collections;
}

// Fluent Emoji 3D PNG for an iconify fluent-emoji name ("grinning-face" → assets/Grinning face/3D/grinning_face_3d.png)
export const fluentPngUrl = (name) => {
  const words = name.split('-');
  const folder = words.join(' ').replace(/^./, (c) => c.toUpperCase());
  return `https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji@main/assets/${encodeURIComponent(folder)}/3D/${words.join('_')}_3d.png`;
};

const SEARCH_STOP = new Set(['the', 'and', 'with', 'for', 'from', 'una', 'uno', 'los', 'las', 'del', 'con', 'para', 'por', 'que']);
async function iconifyQuery(query, prefixes, limit) {
  const url = `https://api.iconify.design/search?query=${encodeURIComponent(query)}&limit=${Math.min(64, limit * 4)}&prefixes=${prefixes.join(',')}`;
  return (await fetchPublic(url)).json();
}
async function searchIconify(query, kind, style, limit) {
  // a requested style is searched on its own sets first; the kind's sets are the fallback
  const styled = style ? STYLE_SETS[style] ?? [] : [];
  let d = styled.length ? await iconifyQuery(query, styled, limit) : {icons: []};
  if (!d.icons?.length) d = await iconifyQuery(query, SETS[kind] ?? SETS.sticker, limit);
  // Iconify ANDs the words of a query: "credit card money" finds nothing while each word does
  if (!d.icons?.length) {
    const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !SEARCH_STOP.has(w));
    if (words.length > 1) {
      const sets = [...new Set([...styled, ...(SETS[kind] ?? SETS.sticker)])];
      const icons = new Set();
      for (const w of words) for (const ic of (await iconifyQuery(w, sets, limit)).icons ?? []) icons.add(ic);
      d = {icons: [...icons]};
    }
  }
  const cols = await iconifyCollections();
  const out = [];
  const seen = new Set(); // several sets share emoji names → one 3D PNG each
  for (const full of d.icons ?? []) {
    const [prefix, name] = full.split(':');
    const lic = cols[prefix]?.license?.spdx ?? '';
    if (!OK_LICENSES.test(lic)) continue;
    const credit = NEEDS_CREDIT.test(lic) ? `${cols[prefix].name} by ${cols[prefix].author?.name ?? prefix} (${lic})` : null;
    // 3D style: try Microsoft's 3D PNG for this emoji name first, fall back to the SVG
    if (style === '3d') {
      try {
        const dest = path.join(ASSETS, 'fluent-3d', `${name}.png`);
        if (seen.has(dest)) continue;
        await download(fluentPngUrl(name), dest);
        seen.add(dest);
        const row = {id: `fluent-3d:${name}`, src: rel(dest), format: 'png', kind: 'emoji', source: 'Fluent Emoji 3D (MIT)', license: 'MIT', credit: null, tags: [...name.split('-'), ...tokens(query), '3d']};
        libraryAdd(row); out.push(row);
        if (out.length >= limit) break;
        continue;
      } catch {}
    }
    const dest = path.join(ASSETS, 'iconify', `${prefix}--${name}.svg`);
    try { await download(`https://api.iconify.design/${prefix}/${name}.svg`, dest); } catch { continue; }
    const row = {id: full, src: rel(dest), format: 'svg', kind, source: `${cols[prefix]?.name ?? prefix} via Iconify`, license: lic, credit, tags: [...name.split('-'), ...tokens(query), ...(style ? [style] : [])]};
    libraryAdd(row); out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------- Openverse (CC illustrations / stickers) ----------
async function searchOpenverse(query, limit) {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&license=cc0,pdm,by&license_type=commercial,modification&category=illustration&extension=png,svg,jpg&page_size=${Math.min(20, limit * 2)}`;
  const d = await (await fetchPublic(url)).json();
  const out = [];
  for (const r of d.results ?? []) {
    const ext = (r.filetype || r.url.match(/\.(png|svg|jpe?g)(\?|$)/i)?.[1] || 'png').toLowerCase().replace('jpeg', 'jpg');
    if (!/^(png|svg|jpg)$/.test(ext)) continue;
    const dest = path.join(ASSETS, 'openverse', `${r.id}.${ext}`);
    try { await download(r.url, dest); } catch { continue; }
    const credit = /^cc0|pdm/i.test(r.license) ? null : r.attribution?.replace(/\s+To view.*$/s, '') ?? `${r.creator ?? 'unknown'} (${r.license.toUpperCase()} ${r.license_version})`;
    const row = {id: `openverse:${r.id}`, src: rel(dest), format: ext, kind: 'illustration', source: `${r.source} via Openverse`, license: `${r.license.toUpperCase()} ${r.license_version ?? ''}`.trim(), credit, title: r.title, tags: [...tokens(query), ...tokens(r.title), ...(r.tags ?? []).map((t) => t.name).filter(Boolean).slice(0, 12)]};
    libraryAdd(row); out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

export async function searchAssets({query, kind = 'sticker', style, limit = 6}) {
  // what we already have comes first (free, instant, license already known)
  const local = librarySearch(query, {kind, limit});
  if (local.length >= limit) return local;
  const jobs = [];
  if (kind === 'icon' || kind === 'emoji') jobs.push(searchIconify(query, kind, style, limit));
  else {
    jobs.push(searchIconify(query, kind, style, Math.ceil(limit / 2)));
    jobs.push(searchOpenverse(query, Math.ceil(limit / 2)));
  }
  const results = (await Promise.allSettled(jobs)).flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const seen = new Set(local.map((e) => e.src));
  return [...local, ...results.filter((r) => !seen.has(r.src))].slice(0, limit);
}

// ---------- OpenAI Images (generate what does not exist) ----------
export const wrapPrompt = (kind, prompt) => ({
  sticker: `${prompt}. Die-cut sticker illustration, bold flat vector style with a thick white outline, centered, isolated on a transparent background, no text.`,
  doodle: `${prompt}. Simple hand-drawn doodle in loose marker strokes, single color, isolated on a transparent background, no text.`,
  texture: `Seamless tileable ${prompt} texture, flat even lighting, fills the entire frame, no objects, no text.`,
  ui: `${prompt}. Clean flat UI element mockup, isolated on a transparent background.`,
}[kind] ?? prompt);

export async function generateAsset({prompt, kind = 'sticker', size = '1024x1024', quality = 'medium', apiKey, model}) {
  if (!apiKey) throw new Error('OPENAI_API_KEY missing in .env — generate_asset needs it (search_asset works without keys)');
  const full = wrapPrompt(kind, prompt);
  const transparent = kind !== 'texture';
  const hash = crypto.createHash('sha1').update(`${model}|${size}|${quality}|${full}`).digest('hex').slice(0, 12);
  const dest = path.join(ASSETS, 'gen', `${kind}-${hash}.png`);
  if (fs.existsSync(dest)) return {src: rel(dest), cached: true, model};
  // same idea already generated (any wording, model or quality)? reuse it instead of paying again
  const prev = loadLibrary().filter((e) => e.kind === kind && e.prompt && fs.existsSync(path.join(PUBLIC, e.src))).map((e) => ({e, s: similarity(e.prompt, prompt)})).filter((x) => x.s >= 0.6).sort((a, b) => b.s - a.s)[0]?.e;
  if (prev) return {src: prev.src, cached: true, model: prev.model ?? model, reusedPrompt: prev.prompt};
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({model, prompt: full, n: 1, size, quality, output_format: 'png', ...(transparent ? {background: 'transparent'} : {})}),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${d.error?.message ?? 'image generation failed'}`);
  const b64 = d.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI returned no image');
  fs.mkdirSync(path.dirname(dest), {recursive: true});
  fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
  libraryAdd({id: `gen:${kind}-${hash}`, src: rel(dest), format: 'png', kind, source: `OpenAI ${model}`, license: 'generated (owned by the user)', credit: null, prompt, model, tags: [kind, ...tokens(prompt)]});
  return {src: rel(dest), cached: false, model, usage: d.usage};
}
