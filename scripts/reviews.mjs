// Review links: a private, expiring link per project that plays its final renders
// on a phone (/r/<token>). One module for the rule, used by the backend's
// /api/reviews routes and the /r/ pages; the editor's Share button and the MCP
// tools (share_version, list_versions, revoke_review_link) both go through that API.
//
// Store: public/reviews/<projectId>.json — outside the project JSON on purpose
// (the editor's compare-and-swap on updatedAt and the project list never see it):
//   {projectId, managedBy: 'review-link', versions: [...], links: [...]}
//   version: {v, createdAt, durationSec, sizeBytes, file, proxy, poster, proxyBytes, job?, generated: [...]}
//     job       the render job that made it (public/render-jobs/<job>.json while its state is kept)
//     file      the full final render (exports/edited-<job>.mp4), download only
//     proxy     720p H.264 CRF 26 +faststart (reviews/<projectId>/v<n>.mp4), what the page streams
//     poster    one frame (reviews/<projectId>/v<n>.jpg)
//     generated the files this feature created (proxy, poster, the pair) — the full render belongs to the export
//   a final of a project with an identity (src/validate.ts) adds its deliverables (scripts/render-runner.mjs):
//     identity      {client, family, script, variant} it was rendered under
//     deliverables  {master, captions, captionsPng, supers, masterSupers}: reviews/<projectId>/v<n>/<NAME>_master.mp4,
//                   _captions.mov, _captions.png.zip, _supers.mov, _master_supers.mp4 (src/validate.ts
//                   DELIVERABLES), NAME the system name (deliverableName: VIBEM_G2_H1_C1_v3)
//     snapshot      reviews/<projectId>/v<n>/project.json — the props that were rendered
//     masterKey     the cached master it was cut from (scripts/layers.mjs masterKey): an unchanged master —
//                   same key, same bytes (the final audio too) — is a hard link to the earlier version's, not a copy
//     pruned        the files of it the retention removed (pruneVersions), prunedAt when
//   link: {id, hash, createdAt, expiresAt, revokedAt} — the token itself is never stored, only sha256(token)
//
// Only finals that passed the QC gate are recorded (the backend calls recordVersion
// after QC), never drafts.
//
// RETENTION (for any purge of public/exports or public/reviews from outside this module): public/reviews/*.json
// and every file a version references (file, proxy, poster, the pair and its snapshot) must stay while a link of
// that project lives (not revoked, not expired). retainedFiles() lists them; a purge
// skips that set. The /r/ page hides a version whose proxy is gone and drops the
// download button when the full render is gone, so purging an unlinked project's
// files never breaks a page — it only shortens its version list. scripts/cleanup-exports.mjs
// never touches public/reviews/; the versions' own retention is pruneVersions below.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {DELIVERABLES, deliverableName} from '../src/validate.ts';

export const LINK_DAYS = 30;
export const MANAGED_BY = 'review-link';
const DAY = 86400e3;
export const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/; // 16 random bytes, base64url
const ID_RE = /^[\w-]+$/;

export const reviewsDir = (publicDir) => path.join(publicDir, 'reviews');
export const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const fileOf = (dir, projectId) => {
  if (!ID_RE.test(projectId ?? '')) throw new Error(`bad project id: ${projectId}`);
  return path.join(dir, `${projectId}.json`);
};

// strict: for a write (load → modify → save) — only a missing file reads as empty; one that cannot
// be read or parsed throws, so the write never saves over versions and links it did not see
export function loadReviews(dir, projectId, {strict = false} = {}) {
  const f = fileOf(dir, projectId);
  let r = {};
  try { r = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (strict && e.code !== 'ENOENT') throw new Error(`reviews of ${projectId} unreadable, nothing written: ${e.message}`); }
  return {projectId, managedBy: MANAGED_BY, versions: Array.isArray(r.versions) ? r.versions : [], links: Array.isArray(r.links) ? r.links : []};
}
function saveReviews(dir, r) {
  fs.mkdirSync(dir, {recursive: true});
  const f = fileOf(dir, r.projectId);
  const tmp = `${f}.${process.pid}.tmp`; // write + rename: a reader never sees half a file
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2));
  fs.renameSync(tmp, f);
}

// One writer at a time per project's reviews JSON: fn (load → modify → save) runs after the
// previous one of that project settled (the shape of the MCP's inTurn). The version recorded
// after a render, a link made or revoked through the backend and a cancel taking a version
// back all go through it. → fn's result.
// ponytail: in-process only — two backends over one public/ can still interleave; a file lock if that happens.
const rows = new Map();
export function inReviewsRow(dir, projectId, fn) {
  const k = fileOf(dir, projectId);
  const run = (rows.get(k) ?? Promise.resolve()).then(fn);
  rows.set(k, run.catch(() => {})); // a failed write does not block the next one
  return run;
}

export const linkState = (l, now = Date.now()) => (l.revokedAt ? 'revoked' : Date.parse(l.expiresAt) <= now ? 'expired' : 'live');
// what the API hands out about a link: never the hash
export const publicLink = (l, now = Date.now()) => ({id: l.id, createdAt: l.createdAt, expiresAt: l.expiresAt, revokedAt: l.revokedAt ?? null, state: linkState(l, now)});

// Register a final render that passed QC. The proxy and poster were made under
// temporary names next to where they go; here they get the version number (read +
// numbered + written synchronously, so two renders of one project finishing
// together cannot take the same number). With `deliverables` (key → file, src/validate.ts DELIVERABLES: the
// pair's files, on this filesystem) and its `identity`, they move into v<n>/ under their
// system names next to the `snapshot` of the rendered props. The JSON is written last: a
// step that fails leaves no file of this version behind.
export function recordVersion(dir, projectId, {file, proxyTmp, posterTmp, durationSec, sizeBytes, publicDir, jobId, now = Date.now(), deliverables, identity, snapshot, masterKey}) {
  const r = loadReviews(dir, projectId, {strict: true});
  const v = r.versions.reduce((m, x) => Math.max(m, x.v), 0) + 1;
  const sub = path.join(dir, projectId);
  fs.mkdirSync(sub, {recursive: true});
  const proxyAbs = path.join(sub, `v${v}.mp4`), posterAbs = path.join(sub, `v${v}.jpg`), vdir = path.join(sub, `v${v}`);
  const rel = (abs) => path.relative(publicDir, abs).split(path.sep).join('/');
  try {
    fs.renameSync(proxyTmp, proxyAbs);
    if (posterTmp && fs.existsSync(posterTmp)) fs.renameSync(posterTmp, posterAbs);
    const version = {
      v, createdAt: new Date(now).toISOString(), durationSec: Math.round(durationSec * 100) / 100, sizeBytes,
      file: rel(file), proxy: rel(proxyAbs), poster: fs.existsSync(posterAbs) ? rel(posterAbs) : null, proxyBytes: fs.statSync(proxyAbs).size,
      ...(jobId ? {job: String(jobId)} : {}), // the render job it came from (public/render-jobs/<job>.json, scripts/render-jobs.mjs)
    };
    version.generated = [version.proxy, version.poster].filter(Boolean);
    if (deliverables) {
      fs.rmSync(vdir, {recursive: true, force: true}); // what a crash left under this number (never in the JSON)
      fs.mkdirSync(vdir);
      // the newest earlier master of the same key whose bytes are these: linked (the design's §5 cache)
      const sameMaster = (src) => masterKey && r.versions.filter((x) => x.masterKey === masterKey && x.deliverables?.master).sort((a, b) => b.v - a.v)
        .map((x) => path.join(publicDir, x.deliverables.master)).find((f) => sameBytes(f, src));
      const put = ({key, kind, ext}, src) => {
        const f = path.join(vdir, deliverableName({identity, v, kind, ext}));
        const prev = key === 'master' && sameMaster(src);
        if (prev) { fs.linkSync(prev, f); fs.rmSync(src); } else fs.renameSync(src, f);
        return rel(f);
      };
      version.identity = identity;
      if (masterKey) version.masterKey = masterKey;
      version.deliverables = {};
      for (const [key, src] of Object.entries(deliverables)) {
        const d = DELIVERABLES.find((x) => x.key === key);
        if (!d) throw new Error(`unknown deliverable: ${key}`);
        version.deliverables[key] = put(d, src);
      }
      fs.writeFileSync(path.join(vdir, 'project.json'), JSON.stringify(snapshot ?? null));
      version.snapshot = rel(path.join(vdir, 'project.json'));
      version.generated.push(...Object.values(version.deliverables), version.snapshot);
    }
    r.versions.push(version);
    saveReviews(dir, r);
    return version;
  } catch (e) {
    for (const f of [proxyAbs, posterAbs, vdir]) fs.rmSync(f, {recursive: true, force: true});
    throw e;
  }
}

// two files with the same bytes (a missing one: no), read 1 MB at a time
function sameBytes(a, b) {
  let fa, fb;
  try {
    if (fs.statSync(a).size !== fs.statSync(b).size) return false;
    fa = fs.openSync(a, 'r'); fb = fs.openSync(b, 'r');
    const x = Buffer.alloc(1 << 20), y = Buffer.alloc(1 << 20);
    for (let n; (n = fs.readSync(fa, x)) > 0;) if (fs.readSync(fb, y, 0, n) !== n || !x.subarray(0, n).equals(y.subarray(0, n))) return false;
    return true;
  } catch { return false; } finally { for (const fd of [fa, fb]) if (fd !== undefined) fs.closeSync(fd); }
}

// Take a version back (its render job was cancelled while it was being recorded):
// the entry and the files this feature made for it (proxy, poster); the full render
// belongs to the export. → whether it was there.
export function removeVersion(dir, projectId, v, publicDir) {
  const r = loadReviews(dir, projectId, {strict: true});
  const x = r.versions.find((y) => y.v === v);
  if (!x) return false;
  r.versions = r.versions.filter((y) => y !== x);
  for (const f of x.generated ?? []) fs.rmSync(path.join(publicDir, f), {force: true});
  if (x.deliverables) fs.rmSync(path.join(dir, projectId, `v${v}`), {recursive: true, force: true}); // the pair's folder
  saveReviews(dir, r);
  return true;
}

// a new link for the project → the token, shown once (only its hash is kept)
export function createLink(dir, projectId, {days = LINK_DAYS, now = Date.now()} = {}) {
  const r = loadReviews(dir, projectId, {strict: true});
  if (!r.versions.length) throw new Error('no final render to share yet — export a final (not a draft) first');
  const token = crypto.randomBytes(16).toString('base64url');
  const d = Math.min(LINK_DAYS, Math.max(1, Math.round(+days || LINK_DAYS)));
  const link = {id: crypto.randomBytes(4).toString('hex'), hash: hashToken(token), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + d * DAY).toISOString(), revokedAt: null};
  r.links.push(link);
  saveReviews(dir, r);
  return {token, path: `/r/${token}`, ...publicLink(link, now)};
}

export function revokeLink(dir, projectId, linkId, {now = Date.now()} = {}) {
  const r = loadReviews(dir, projectId, {strict: true});
  const l = r.links.find((x) => x.id === linkId);
  if (!l) return null;
  l.revokedAt ??= new Date(now).toISOString();
  saveReviews(dir, r);
  return publicLink(l, now);
}

// token → {state, projectId, reviews, link}; state 'unknown' | 'expired' | 'revoked' | 'live'
export function resolveToken(dir, token, {now = Date.now()} = {}) {
  if (!TOKEN_RE.test(token ?? '')) return {state: 'unknown'};
  const h = hashToken(token);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch {}
  for (const f of files) {
    const projectId = f.slice(0, -5);
    if (!ID_RE.test(projectId)) continue;
    const r = loadReviews(dir, projectId);
    const link = r.links.find((l) => typeof l.hash === 'string' && l.hash.length === h.length && crypto.timingSafeEqual(Buffer.from(l.hash), Buffer.from(h)));
    if (link) return {state: linkState(link, now), projectId, reviews: r, link};
  }
  return {state: 'unknown'};
}

// the versions a page can play: the proxy still on disk, newest first
export const playableVersions = (r, publicDir) =>
  r.versions.filter((x) => x.proxy && fs.existsSync(path.join(publicDir, x.proxy))).sort((a, b) => b.v - a.v);

// Files a purge must keep: every file referenced by a version of a project that
// has a live link, plus the reviews JSON itself (public-relative paths).
export function retainedFiles(dir, publicDir, {now = Date.now()} = {}) {
  const keep = new Set();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch {}
  for (const f of files) {
    const projectId = f.slice(0, -5);
    if (!ID_RE.test(projectId)) continue;
    const r = loadReviews(dir, projectId);
    if (!r.links.some((l) => linkState(l, now) === 'live')) continue;
    keep.add(path.relative(publicDir, path.join(dir, f)).split(path.sep).join('/'));
    for (const v of r.versions) for (const x of [v.file, v.proxy, v.poster, ...Object.values(v.deliverables ?? {}), v.snapshot]) if (x) keep.add(x);
  }
  return keep;
}

// RETENTION of the versions (CEO-12, T6): the newest `keep` unapproved versions of a project (one project =
// one variant) and every approved one stay whole — REEL_REVIEW_KEEP_UNAPPROVED, unset = all of them until the
// T2 measurements fix the number. An older one loses its deliverables (the GBs of v<n>/); one without notes
// loses its proxy, poster and snapshot too — a version with notes keeps those for good, and so does every
// version while a link of the project lives (its page plays the proxies). The entry stays, `pruned` saying
// what went. Runs in the reviews row after each new version (recordFinal) → the paths removed.
// (at least 1: the version just recorded is always whole)
export const keepUnapproved = (env = process.env.REEL_REVIEW_KEEP_UNAPPROVED) => (/^[1-9]\d*$/.test(env ?? '') ? +env : Infinity);
export function pruneVersions(dir, projectId, publicDir, {keep = keepUnapproved(), now = Date.now()} = {}) {
  if (keep === Infinity) return [];
  const r = loadReviews(dir, projectId, {strict: true});
  const linked = r.links.some((l) => linkState(l, now) === 'live');
  const gone = [];
  for (const x of r.versions.filter((y) => !y.approval).sort((a, b) => b.v - a.v).slice(keep)) {
    const files = [...Object.values(x.deliverables ?? {}), ...(x.notes?.length || linked ? [] : [x.proxy, x.poster, x.snapshot])].filter((f) => f && fs.existsSync(path.join(publicDir, f)));
    if (!files.length) continue;
    for (const f of files) fs.rmSync(path.join(publicDir, f), {force: true});
    try { fs.rmdirSync(path.join(dir, projectId, `v${x.v}`)); } catch {} // only when nothing of it is left
    x.pruned = [...new Set([...(x.pruned ?? []), ...files])];
    x.prunedAt = new Date(now).toISOString();
    gone.push(...files);
  }
  if (gone.length) saveReviews(dir, r);
  return gone;
}

// The step after a render: only a FINAL whose QC passed, rendered for a known project,
// becomes a version (proxy + poster made next to their final place under temporary
// names, then numbered). Drafts, QC failures and project-less renders → null.
// signal: the render job's — a cancel kills the proxy's ffmpeg and records nothing.
// deliverables / identity / snapshot / masterKey: the pair of a project with an identity (recordVersion).
// verify: run in the row right before the version is numbered — throws to record nothing (the
// runner checks the pair's identity is still the project's).
export async function recordFinal({draft, qcOk, projectId, outFile, dir, publicDir, jobId = String(Date.now()), signal, deliverables, identity, snapshot, masterKey, verify, makeProxy: proxy = makeProxy}) {
  if (draft || !qcOk || !projectId) return null;
  if (signal?.aborted) throw signal.reason;
  const tmp = path.join(dir, projectId, `.tmp-${jobId}`);
  fs.mkdirSync(path.dirname(tmp), {recursive: true});
  try {
    const {durationSec} = await proxy(outFile, `${tmp}.mp4`, `${tmp}.jpg`, {signal});
    if (signal?.aborted) throw signal.reason; // cancelled while the proxy was made: no version
    const sizeBytes = fs.statSync(outFile).size;
    // awaited here: the finally below must not remove the temps before the row gets to them
    return await inReviewsRow(dir, projectId, () => {
      if (signal?.aborted) throw signal.reason;
      verify?.();
      const version = recordVersion(dir, projectId, {file: outFile, proxyTmp: `${tmp}.mp4`, posterTmp: `${tmp}.jpg`, durationSec, sizeBytes, publicDir, jobId, ...(deliverables ? {deliverables, identity, snapshot, masterKey} : {})});
      try { pruneVersions(dir, projectId, publicDir); } catch (e) { console.error(`reviews of ${projectId}: retention not applied: ${e.message}`); } // never the new version's fault
      return version;
    });
  } finally {
    fs.rmSync(`${tmp}.mp4`, {force: true}); fs.rmSync(`${tmp}.jpg`, {force: true});
  }
}

// ---- the 720p proxy + poster (ffmpeg, async: the backend's event loop keeps serving) ----
const runFf = (cmd, args, {signal} = {}) => new Promise((resolve) => {
  const c = spawn(cmd, args, signal ? {signal} : {}); // aborted → killed, resolves with code 1
  let out = '', err = '';
  c.stdout.on('data', (d) => (out += d));
  c.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
  c.on('close', (code) => resolve({code, stdout: out, stderr: err}));
  c.on('error', (e) => resolve({code: 1, stdout: out, stderr: String(e.message)}));
});
// ~2.5–3 Mbps at 720x1280 for a talking-head reel; the cap keeps busy B-roll from spiking on mobile data
export const proxyArgs = (input, output) => [
  '-y', '-v', 'error', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=720:-2',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-maxrate', '3500k', '-bufsize', '7000k', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', output,
];
export async function makeProxy(input, proxyOut, posterOut, {signal} = {}) {
  const p = await runFf('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', input], {signal});
  const durationSec = parseFloat(p.stdout) || 0;
  const enc = await runFf('ffmpeg', proxyArgs(input, proxyOut), {signal});
  if (enc.code !== 0) { fs.rmSync(proxyOut, {force: true}); throw new Error(`review proxy failed: ${enc.stderr.trim().split('\n').pop() ?? ''}`.slice(0, 200)); }
  // a frame a moment in (the first frame is often a transition or black), small JPEG ≈ 50 KB
  const at = Math.min(1, durationSec / 3);
  await runFf('ffmpeg', ['-y', '-v', 'error', '-ss', at.toFixed(2), '-i', proxyOut, '-frames:v', '1', '-q:v', '6', posterOut], {signal});
  return {durationSec};
}
