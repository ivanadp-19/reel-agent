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
//                   A reel with no text graphic has no supers and no master_supers (it would be the master): both
//                   are left out and named in `omitted` {supers, masterSupers: why} — the pair stays master + captions
//     masterKey     the cached master it was cut from (scripts/layers.mjs masterKey); audioHash the sha256 of the final
//                   audio remuxed into it: an unchanged master — same key, same audio — is a hard link to the earlier
//                   version's (priorMaster: the runner links it instead of remuxing), never a copy
//     original      {src, sha256, bytes}: a captions-only job on the client's own export (src/layers.ts originalMaster) —
//                   the master IS that file (public/<src>), hard-linked, never re-encoded; no masterKey
//     qc            {lufs, truePeak, parity: {frames, fps}}: the final's loudness as the QC gate measured it and the
//                   frames / rate every file of the pair matched (scripts/render-runner.mjs)
//     judge         QC técnico (CEO-6): {label, findings, at, profile, report?, error?} (+ attempt, owner, pid while it
//                   runs) — see judgeVersion below
//     pruned        the files of it the retention removed (pruneVersions), prunedAt when
//   datosPorConfirmar  [{graphic, dato, src, atSec}]: figures / names its graphics show that its own audio does not
//                 say (CEO-21, src/validate.ts unbackedData) — the client confirms them; absent = none (the runner logs a check that failed)
//     approval      {by, at, ipHash, userAgent}: its client's reviewer approved it in the bandeja (server/review.mjs, the only
//                   writer); notes [{id, v, atSec, text, anchor: {clipId, src, srcSec, wordId}, by, at, state, history,
//                   afterApproval?, kind?, resolvedIn?, reason?, fixture?}]; log [{action, by, at, …}]: every bandeja step with its
//                   principal — the life cycle is scripts/review-states.mjs
//     colorRef      {state: confirmada | descartada, by, at, file?, development?}: the owner's answer to the proposal of
//                   an approved master as a color reference (addColorRef)
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
// never touches public/reviews/; the versions' own retention is pruneVersions / pruneAll below (and the CLI at the end:
// node scripts/reviews.mjs prune [--apply] [--keep N] [--json]), which honors this set.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {DELIVERABLES, deliverableName} from '../src/validate.ts';
import {killTree, pidAlive, pidCmdline} from './render-jobs.mjs';
import {AGENT_NOTE_STEPS, byVariant, judgeText, moveNote, variantName} from './review-states.mjs';
export {judgeText}; // the QC técnico label as people read it: one definition, next to versionQc (scripts/review-states.mjs)

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
// A deliverable left out (null: supers and master_supers of a reel with no text graphic) is named in `omitted`
// {key: why}; `original` {src, sha256, bytes}: the master is the client's own file (a captions-only job);
// `audioHash`: the sha256 of the final audio the master was remuxed with (priorMaster).
// `pause` (tests only, test/concurrency.test.mjs): awaited between the read and the write — inside the caller's
// reviews row, the window a writer outside the row would lose its write in; the version then comes as a promise.
// Production never passes it: read, numbered and written in one synchronous step, as above.
export function recordVersion(dir, projectId, o) {
  const r = loadReviews(dir, projectId, {strict: true});
  const v = r.versions.reduce((m, x) => Math.max(m, x.v), 0) + 1;
  return o.pause ? Promise.resolve(o.pause(v)).then(() => writeVersion(dir, projectId, r, v, o)) : writeVersion(dir, projectId, r, v, o);
}
function writeVersion(dir, projectId, r, v, {file, proxyTmp, posterTmp, durationSec, sizeBytes, publicDir, jobId, now = Date.now(), deliverables, identity, snapshot, masterKey, qc, datosPorConfirmar, omitted, original, audioHash}) {
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
      ...(datosPorConfirmar ? {datosPorConfirmar} : {}),
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
      if (audioHash) version.audioHash = audioHash;
      if (original) version.original = original;
      if (omitted && Object.keys(omitted).length) version.omitted = omitted;
      version.qc = qc ?? null;
      version.judge = {label: 'en curso', at: version.createdAt}; // at once (D18): the judge's rules run after, on this vN
      version.deliverables = {};
      for (const [key, src] of Object.entries(deliverables)) {
        if (!src) continue; // left out: `omitted` says why
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

// two files with the same bytes (a missing one: no), read 1 MB at a time — one file under two names at once
function sameBytes(a, b) {
  let fa, fb;
  try {
    const [sa, sb] = [fs.statSync(a), fs.statSync(b)];
    if (sa.ino === sb.ino && sa.dev === sb.dev) return true;
    if (sa.size !== sb.size) return false;
    fa = fs.openSync(a, 'r'); fb = fs.openSync(b, 'r');
    const x = Buffer.alloc(1 << 20), y = Buffer.alloc(1 << 20);
    for (let n; (n = fs.readSync(fa, x)) > 0;) if (fs.readSync(fb, y, 0, n) !== n || !x.subarray(0, n).equals(y.subarray(0, n))) return false;
    return true;
  } catch { return false; } finally { for (const fd of [fa, fb]) if (fd !== undefined) fs.closeSync(fd); }
}

// An unchanged master (plan phase 7): the newest earlier version's master cut from the same cached master (masterKey)
// with the same final audio (audioHash) is these very bytes — the runner hard-links it instead of remuxing a new file.
// → its absolute path, or null
export function priorMaster(dir, projectId, publicDir, {masterKey, audioHash}) {
  if (!masterKey || !audioHash) return null;
  return loadReviews(dir, projectId).versions.filter((x) => x.masterKey === masterKey && x.audioHash === audioHash && x.deliverables?.master).sort((a, b) => b.v - a.v)
    .map((x) => path.join(publicDir, x.deliverables.master)).find((f) => fs.existsSync(f)) ?? null;
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

// RETENTION of the versions (CEO-12, T6, plan phase 7): a pass run by hand or by cron — DRY-RUN unless --apply, like
// scripts/cleanup-exports.mjs, which never touches public/reviews/ (R-5). Per variant (byVariant: a project whose
// identity changed keeps each variant's versions apart), every approved version and the newest `keep` unapproved ones
// (REEL_REVIEW_KEEP_UNAPPROVED, default 3) stay whole. An older one loses its deliverables (the GBs of v<n>/); one
// without notes loses its proxy, poster and snapshot too — a version with notes keeps those for good (its anchors, the
// fixtures). Nothing a live /r/ link of the project names goes (retainedFiles). A hard-linked file (an unchanged master
// shared by two versions, a captions-only master that is the client's own clip) loses one name: its bytes stay while
// another name holds them. The entry stays, `pruned` saying what went.
export const KEEP_UNAPPROVED = 3;
export const keepUnapproved = (env = process.env.REEL_REVIEW_KEEP_UNAPPROVED) => (/^[1-9]\d*$/.test(env ?? '') ? +env : KEEP_UNAPPROVED);
// one project → [{v, stem, files: [{path, bytes, nlink, inode}]}]: what goes (apply) or would go (the dry run)
export function pruneVersions(dir, projectId, publicDir, {keep = keepUnapproved(), now = Date.now(), apply = true, retained = retainedFiles(dir, publicDir, {now})} = {}) {
  const r = loadReviews(dir, projectId, {strict: apply});
  const out = [];
  for (const [stem, versions] of byVariant(r.versions)) {
    for (const x of versions.filter((y) => !y.approval).sort((a, b) => b.v - a.v).slice(keep)) {
      const files = [...Object.values(x.deliverables ?? {}), ...(x.notes?.length ? [] : [x.proxy, x.poster, x.snapshot])]
        .filter((f, i, all) => f && all.indexOf(f) === i && !retained.has(f) && fs.existsSync(path.join(publicDir, f)));
      if (!files.length) continue;
      out.push({v: x.v, stem, files: files.map((f) => { const st = fs.statSync(path.join(publicDir, f)); return {path: f, bytes: st.size, nlink: st.nlink, inode: `${st.dev}:${st.ino}`}; })});
      if (!apply) continue;
      for (const f of files) fs.rmSync(path.join(publicDir, f), {force: true});
      try { fs.rmdirSync(path.join(dir, projectId, `v${x.v}`)); } catch {} // only when nothing of it is left
      x.pruned = [...new Set([...(x.pruned ?? []), ...files])];
      x.prunedAt = new Date(now).toISOString();
    }
  }
  if (apply && out.length) saveReviews(dir, r);
  return out.sort((a, b) => a.v - b.v);
}
// every project → {keep, apply, versions: [{projectId, v, stem, files}], bytes}: bytes = what the disk gets back (a file
// counts once every name of it goes). apply: each project written in its reviews row
export async function pruneAll(dir, publicDir, {keep = keepUnapproved(), apply = false, now = Date.now()} = {}) {
  const retained = retainedFiles(dir, publicDir, {now});
  const versions = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch {}
  for (const f of names) {
    const projectId = f.slice(0, -5);
    if (!ID_RE.test(projectId)) continue;
    const one = () => pruneVersions(dir, projectId, publicDir, {keep, now, apply, retained});
    for (const x of apply ? await inReviewsRow(dir, projectId, one) : one()) versions.push({projectId, ...x});
  }
  const inodes = new Map();
  for (const f of versions.flatMap((x) => x.files)) { const i = inodes.get(f.inode) ?? {...f, names: 0}; i.names++; inodes.set(f.inode, i); }
  return {keep, apply, versions, bytes: [...inodes.values()].filter((i) => i.names >= i.nlink).reduce((s, i) => s + i.bytes, 0)};
}
export const retentionText = (r) => {
  const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;
  const head = `reviews retention — ${r.apply ? 'APPLIED' : 'DRY RUN (nothing deleted; --apply deletes)'} · per variant: every approved version + the newest ${r.keep} unapproved stay whole`;
  const lines = r.versions.map((x) => `${x.projectId} ${x.stem} v${x.v}: ${x.files.map((f) => `${path.basename(f.path)} ${mb(f.bytes)}${f.nlink > 1 ? ' (hard link)' : ''}`).join(', ')}`);
  return [head, ...(lines.length ? lines : ['nothing to remove']), `${r.versions.length} version${r.versions.length === 1 ? '' : 's'}, ${mb(r.bytes)} ${r.apply ? 'freed' : 'to free'}`].join('\n');
};

// ---- notes → fixtures (T17, §7): a note the agent resolved becomes a regression case of its client, keyed by ids ----
// public/clients/<client>/fixtures/<projectId>-v<n>-<note>.json (the volume, never git): the note — its text is the
// client's words, data —, its anchor {clipId, src, srcSec, wordId} and a copy of the snapshot it was anchored on
// (<id>.snapshot.json: the retention never takes it); `media`, the files it needs. test/fixtures.test.mjs runs them
// through listFixtures and skips, with a warning, one whose media this machine lacks. → the fixture's public path, or
// null when there is nothing to key it by (no client, no anchor, no snapshot)
const CLIENT_RE = /^[a-z0-9-]{1,32}$/;
const writeJson = (f, x) => { fs.mkdirSync(path.dirname(f), {recursive: true}); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(x, null, 2)); fs.renameSync(t, f); };
const relOf = (publicDir, abs) => path.relative(publicDir, abs).split(path.sep).join('/');
export function writeFixture(publicDir, projectId, x, note, {now = Date.now()} = {}) {
  const client = x.identity?.client;
  if (!CLIENT_RE.test(client ?? '') || !note.anchor || !x.snapshot || !fs.existsSync(path.join(publicDir, x.snapshot))) return null;
  const id = `${projectId}-v${x.v}-${note.id}`, d = path.join(publicDir, 'clients', client, 'fixtures');
  fs.mkdirSync(d, {recursive: true});
  fs.copyFileSync(path.join(publicDir, x.snapshot), path.join(d, `${id}.snapshot.json`));
  writeJson(path.join(d, `${id}.json`), {id, client, projectId, stem: variantName(x.identity), v: x.v, resolvedIn: note.resolvedIn ?? null,
    note: {id: note.id, kind: note.kind ?? null, atSec: note.atSec, text: note.text, by: note.by}, anchor: note.anchor, snapshot: `${id}.snapshot.json`,
    media: [note.anchor.src].filter(Boolean), at: new Date(now).toISOString()});
  return relOf(publicDir, path.join(d, `${id}.json`));
}
// every client's fixtures → [{client, id, file, fixture, snapshot, missing: [media not on this machine]}]
export function listFixtures(publicDir) {
  const ls = (d) => { try { return fs.readdirSync(d).sort(); } catch { return []; } };
  const out = [];
  for (const client of ls(path.join(publicDir, 'clients'))) {
    const d = path.join(publicDir, 'clients', client, 'fixtures');
    for (const n of ls(d).filter((f) => f.endsWith('.json') && !f.endsWith('.snapshot.json'))) {
      const fixture = JSON.parse(fs.readFileSync(path.join(d, n), 'utf8')); // a broken fixture fails its test, never skips it
      let snapshot = null;
      try { snapshot = JSON.parse(fs.readFileSync(path.join(d, path.basename(String(fixture.snapshot))), 'utf8')); } catch {}
      const missing = (fixture.media ?? []).filter((m) => typeof m !== 'string' || m.includes('..') || !fs.existsSync(path.join(publicDir, m)));
      out.push({client, id: fixture.id ?? n.slice(0, -5), file: path.join(d, n), fixture, snapshot, missing});
    }
  }
  return out;
}

// ---- the agent's steps on a client's note (T17): POST /api/reviews/<id>/versions/<v>/notes/<note> {step, kind?, v?} ----
// clasificar {kind} and resolver {v: the later version that fixes it — rendered already} (AGENT_NOTE_STEPS): a token may
// take these two, as the agent it is (actor). confirmar / descartar / verificar are a human's, in the bandeja only
// (E-2): 403 here. A note resolved becomes a fixture of its client (writeFixture), a fixture that fails to write never
// undoes the step. → [status, body]
export async function agentNoteStep(dir, publicDir, projectId, v, noteId, body, actor, {now = Date.now()} = {}) {
  const step = body?.step;
  if (!AGENT_NOTE_STEPS.includes(step)) return [403, {error: `${step ?? 'that step'} is not an agent's: confirmar and descartar are the owner's, verificar the client's — in the bandeja, with their login`, code: 'human_only'}];
  let note, fixture = null, fixtureError;
  try {
    const x = await withVersion(dir, projectId, v, (y, r) => {
      if (step === 'resolver') fixedIn(r, y, String(noteId), body.v);
      note = moveNote(y, String(noteId), step, actor, {at: new Date(now).toISOString(), kind: body.kind, v: body.v});
      if (step !== 'resolver') return;
      try { fixture = writeFixture(publicDir, projectId, y, note, {now}); if (fixture) note.fixture = fixture; } catch (e) { fixtureError = e.message; }
    });
    if (!x) return [404, {error: `no version v${v} of ${projectId}`, code: 'not_found'}];
  } catch (e) {
    if (!e.status) throw e;
    return [e.status, {error: e.message, code: e.code}];
  }
  return [200, {projectId, v, note, ...(fixture ? {fixture} : {}), ...(fixtureError ? {fixtureError} : {})}];
}

// the version a confirmed note is resolved in: one that exists, of the note's variant, whole (not stripped by the
// retention) and rendered after the owner confirmed the note — an earlier one cannot hold the fix. Else it throws
function fixedIn(r, x, noteId, fv) {
  if (!Number.isInteger(fv) || fv <= x.v) return; // not a later version: moveNote says so
  const fix = r.versions.find((y) => y.v === fv);
  const confirmed = (x.notes ?? []).find((n) => n.id === noteId)?.history?.findLast((h) => h.state === 'confirmada')?.at;
  const why = !fix ? `there is no v${fv}`
    : variantName(fix.identity) !== variantName(x.identity) ? `v${fv} is another variant (${variantName(fix.identity) ?? 'none'})`
    : fix.pruned ? `v${fv} was stripped by the retention`
    : confirmed && !(Date.parse(fix.createdAt) > Date.parse(confirmed)) ? `v${fv} was rendered before the note was confirmed (${confirmed}): render the fix, then resolve it with that version`
    : null;
  if (why) throw Object.assign(new Error(`resolver needs the version that fixes it: ${why}`), {status: fix ? 409 : 400, code: 'bad_version'});
}

// ---- an approved master as a color reference (§7, T17): proposed in the owner's inbox, written on the owner's confirm ----
// The master is linked (copied across filesystems) into public/clients/<client>/refs/ and listed in the client's
// profile.json colorRefs with the identity's development: the render judge's color-ref compares a reel only with the
// references of its own development (judge.mjs colorRefGroups). Idempotent. A profile that does not parse throws —
// never written over. → {file, label, development}
export function addColorRef(publicDir, projectId, x) {
  const client = x.identity?.client;
  const master = x.deliverables?.master ? path.join(publicDir, x.deliverables.master) : null;
  if (!CLIENT_RE.test(client ?? '') || !master || !fs.existsSync(master)) throw Object.assign(new Error(`v${x.v}: su master ya no está en disco`), {status: 409, code: 'no_master'});
  // named by project too: v<n> and the variant's name repeat across projects (one identity can move to another project)
  const base = path.join(publicDir, 'clients', client), name = `${projectId}-${path.basename(master)}`, ref = path.join(base, 'refs', name);
  fs.mkdirSync(path.dirname(ref), {recursive: true});
  if (!fs.existsSync(ref)) { try { fs.linkSync(master, ref); } catch { fs.copyFileSync(master, ref); } }
  const pf = path.join(base, 'profile.json');
  const profile = fs.existsSync(pf) ? JSON.parse(fs.readFileSync(pf, 'utf8')) : {id: client};
  const development = x.identity.development ?? null;
  const entry = {label: `${variantName(x.identity)} v${x.v} aprobado`, paths: [`refs/${name}`], ...(development ? {development} : {})};
  profile.colorRefs = Array.isArray(profile.colorRefs) ? profile.colorRefs : [];
  if (!profile.colorRefs.some((g) => g.paths?.includes(entry.paths[0]))) { profile.colorRefs.push(entry); writeJson(pf, profile); }
  return {file: relOf(publicDir, ref), label: entry.label, development};
}

// The step after a render: only a FINAL whose QC passed, rendered for a known project,
// becomes a version (proxy + poster made next to their final place under temporary
// names, then numbered). Drafts, QC failures and project-less renders → null.
// signal: the render job's — a cancel kills the proxy's ffmpeg and records nothing.
// deliverables / identity / snapshot / masterKey / qc: the pair of a project with an identity (recordVersion).
// verify: run in the row right before the version is numbered — throws to record nothing (the
// runner checks the pair's identity is still the project's). pause: recordVersion's (tests only).
export async function recordFinal({draft, qcOk, projectId, outFile, dir, publicDir, jobId = String(Date.now()), signal, deliverables, identity, snapshot, masterKey, qc, verify, datosPorConfirmar, omitted, original, audioHash, makeProxy: proxy = makeProxy, pause}) {
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
      return recordVersion(dir, projectId, {file: outFile, proxyTmp: `${tmp}.mp4`, posterTmp: `${tmp}.jpg`, durationSec, sizeBytes, publicDir, jobId, datosPorConfirmar, pause, ...(deliverables ? {deliverables, identity, snapshot, masterKey, qc, omitted, original, audioHash} : {})});
    });
  } finally {
    fs.rmSync(`${tmp}.mp4`, {force: true}); fs.rmSync(`${tmp}.jpg`, {force: true});
  }
}

// ---- QC técnico on a version (CEO-6, D18 "De inmediato") ----
// A client's vN is delivered at once, labeled 'en curso' (recordVersion), and the judge's rules run after it on
// that version: judgeVersion spawns .agents/skills/render-judge/judge.mjs where it lives (D31) as a child — it
// renices itself (REEL_JUDGE_NICE) and every ffmpeg of it decodes on one thread (REEL_JUDGE_THREADS) — on the version's
// render and the props it was rendered from (its snapshot), and writes version.judge through the reviews row:
//   {label, findings, at, profile, report?, error?}  label 'en curso' → 'superado' | 'superado (evidencia reducida)' |
//   '<n> hallazgo(s)' | 'no disponible'
// 'superado (evidencia reducida)': a PASS of every check that ran, with some skipped (no color references on the box, no
// music-only stretch to measure, an analysis past its deadline — the report lists them); phase 5 may approve from it
// as from 'superado', and the suffix stays wherever the label is shown, so it never reads as a full pass.
// 'no disponible': the judge crashed, ran past REEL_JUDGE_RUN_MS (30 min) or answered no verdict — an
// [owner-alert] log line says why. Never 'aprobado': only the client approves. The judge never edits the project or a
// file of the version. One function for the render runner (after the version is recorded; the job is done without
// waiting for it), POST /api/reviews/<id>/versions/<v>/judge (MCP rejudge, the editor's Re-judge: no re-render) and
// resumeJudges on start. → {version (now 'en curso'), done: Promise<judge>}, or null when there is no such version; a
// version without a snapshot (no identity, or recorded before them) is refused (code 'no_snapshot'): it cannot be
// judged as it was rendered. A pass of that version already running in this process is returned. Judges run one at a
// time (a restart or a burst of re-judges queues them, 'en curso' meanwhile); the deadline counts from its start.
// ponytail: deduped and serialized per process — two backends over one public/ may judge a version twice (the last
// write wins) or two judges at once.
export const JUDGE_CMD = [process.execPath, path.join(import.meta.dirname, '..', '.agents', 'skills', 'render-judge', 'judge.mjs')];
const VERDICT = /^(superado( \(evidencia reducida\))?|\d+ hallazgos?)$/; // what a pass may answer; the queue itself says 'en curso' / 'no disponible'
const passes = new Map(); // `<reviews json>|<v>` → {version, done} of this process
const kids = new Set(); // judge processes of this process, stopped with it (the next start judges again); a SIGKILL
process.once('exit', () => { for (const pid of kids) killTree(pid, 'SIGKILL'); }); // skips this: version.judge.pid, resumeJudges
let lane = Promise.resolve(); // one judge at a time
// fn(the version) in the reviews row, then saved → the version, or null when it is not there. fn throws → nothing
// is written (the bandeja's steps, scripts/review-states.mjs, check the state they write over this way)
export const withVersion = (dir, projectId, v, fn) => inReviewsRow(dir, projectId, () => {
  const r = loadReviews(dir, projectId, {strict: true});
  const x = r.versions.find((y) => y.v === v);
  if (!x) return null;
  fn(x, r);
  saveReviews(dir, r);
  return x;
});
export function judgeVersion(o) {
  const k = `${fileOf(o.dir, o.projectId)}|${o.v}`;
  if (!passes.has(k)) passes.set(k, startJudge(o, () => passes.delete(k))); // released before its answer is out: a re-judge right after starts anew
  return passes.get(k);
}
async function startJudge({dir, publicDir, projectId, v, cmd = JUDGE_CMD, timeoutMs = +(process.env.REEL_JUDGE_RUN_MS || 1800e3), fresh = false, log = console.error, now = Date.now}, release) {
  const at = () => new Date(now()).toISOString();
  // fresh (asked for): attempt 1; a restart's second try counts on (resumeJudges)
  let version = null;
  try {
    version = await withVersion(dir, projectId, v, (x) => {
      if (!x.snapshot) throw Object.assign(new Error(`v${v} of ${projectId} has no snapshot of the props it was rendered from (a version without an identity, or from before them): it cannot be judged as it was rendered — render it again`), {code: 'no_snapshot'});
      x.judge = {label: 'en curso', at: at(), attempt: fresh ? 1 : (x.judge?.attempt ?? 0) + 1, owner: process.pid};
    });
  } finally { if (!version) release(); }
  if (!version) return null;
  // its pid, for the next start to stop it if this backend dies without its exit hook (SIGKILL, OOM)
  const spawned = (pid) => withVersion(dir, projectId, v, (x) => { if (x.judge?.label === 'en curso' && x.judge.owner === process.pid) x.judge.pid = pid; }).catch(() => {});
  const done = (async () => {
    let judge;
    try {
      const run = lane.then(() => runJudge(cmd, [projectId, path.join(publicDir, version.file), '--summary', '--public', publicDir, '--snapshot', path.join(publicDir, version.snapshot)], timeoutMs, spawned));
      lane = run.catch(() => {});
      const s = await run;
      judge = {label: s.label, findings: s.findings, at: at(), profile: s.profile ?? null, ...(s.report ? {report: s.report} : {})};
    } catch (e) {
      const why = String(e?.message ?? e).slice(0, 300);
      judge = {label: 'no disponible', findings: [], at: at(), profile: null, error: why};
      log(`[owner-alert] QC técnico no disponible — ${projectId} v${v}: ${why}`);
    }
    try { await withVersion(dir, projectId, v, (x) => { x.judge = judge; }); } catch (e) { log(`[owner-alert] QC técnico of ${projectId} v${v} not written: ${e.message}`); } finally { release(); }
    return judge;
  })();
  return {version, done};
}
// the judge's one line of --summary JSON; a crash, the deadline (its process group killed: ffmpeg under it
// too) or anything but a verdict rejects with why
function runJudge([bin, ...pre], args, timeoutMs, spawned = () => {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, [...pre, ...args], {cwd: path.join(import.meta.dirname, '..'), detached: true, stdio: ['ignore', 'pipe', 'pipe']});
    if (c.pid) { kids.add(c.pid); spawned(c.pid); }
    let out = '', err = '', late = false;
    const t = setTimeout(() => { late = true; killTree(c.pid, 'SIGKILL'); }, timeoutMs);
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    c.on('error', (e) => { clearTimeout(t); kids.delete(c.pid); reject(new Error(`the judge could not start: ${e.message}`)); });
    c.on('close', (code, sig) => {
      clearTimeout(t); kids.delete(c.pid);
      if (late) return reject(new Error(`the judge did not finish in ${Math.round(timeoutMs / 1000)} s`));
      // why: the judge's own `judge: …` line or an uncaught error's `…Error: …` line — never the stack or Node's banner
      const lines = err.split('\n').map((l) => l.trim()).filter((l) => l && !/^Node\.js v\d/.test(l));
      if (code !== 0) return reject(new Error(`the judge failed (${sig ?? `exit ${code}`}): ${lines.findLast((l) => /^(judge: |[\w.]*Error\b)/.test(l)) ?? lines.at(-1) ?? ''}`));
      let s = null;
      try { s = JSON.parse(out.trim().split('\n').pop()); } catch {}
      if (!VERDICT.test(s?.label ?? '') || !Array.isArray(s.findings)) return reject(new Error('the judge answered no verdict'));
      resolve(s);
    });
  });
}
// On backend start: a version a dead backend left 'en curso' (its owner process gone) is judged again once, then
// 'no disponible' (+ the owner alert). The judge that backend left behind (its exit hook never ran: SIGKILL, OOM) is
// killed first — by pid, only once its command line names judge.mjs and this version's render (pid reuse), like a
// render's orphan (scripts/render-jobs.mjs). → the passes started
export async function resumeJudges({dir, publicDir, log = console.error, now = Date.now, ...o}) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch {}
  const started = [];
  for (const f of files) {
    const projectId = f.slice(0, -5);
    if (!ID_RE.test(projectId)) continue;
    for (const x of loadReviews(dir, projectId).versions) {
      const j = x.judge;
      if (j?.label !== 'en curso' || passes.has(`${fileOf(dir, projectId)}|${x.v}`) || (j.owner !== process.pid && pidAlive(j.owner))) continue;
      const cmd = pidAlive(j.pid) ? pidCmdline(j.pid) ?? '' : '';
      if (cmd.includes('judge.mjs') && cmd.includes(path.join(publicDir, x.file))) killTree(j.pid, 'SIGKILL');
      if ((j.attempt ?? 0) < 2 && x.snapshot) { started.push(await judgeVersion({...o, dir, publicDir, projectId, v: x.v, log, now})); continue; }
      const why = x.snapshot ? `its judge was interrupted twice (backend pid ${j.owner} stopped)` : 'no snapshot of the props it was rendered from: it cannot be judged as it was rendered';
      await withVersion(dir, projectId, x.v, (y) => { y.judge = {label: 'no disponible', findings: [], at: new Date(now()).toISOString(), profile: null, error: why}; });
      log(`[owner-alert] QC técnico no disponible — ${projectId} v${x.v}: ${why}`);
    }
  }
  return started.filter(Boolean);
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

// ---- the retention pass from a terminal or cron: node scripts/reviews.mjs prune [--apply] [--keep N] [--json] ----
// DRY-RUN unless --apply. With the backend up it runs there (POST /api/review-retention: every write of a project's
// reviews JSON goes through that process's row); with it down, here. REEL_API / the primary token as the render CLI.
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--keep'), keep = at >= 0 ? keepUnapproved(argv[at + 1]) : keepUnapproved();
  if (argv[0] !== 'prune' || (at >= 0 && !/^[1-9]\d*$/.test(argv[at + 1] ?? ''))) { console.error('usage: node scripts/reviews.mjs prune [--apply] [--keep N ≥ 1] [--json]'); process.exit(2); }
  const apply = argv.includes('--apply');
  const root = path.join(import.meta.dirname, '..'), publicDir = path.join(root, 'public');
  const api = process.env.REEL_API || `http://127.0.0.1:${process.env.REEL_PORT || 3333}`;
  const tok = (process.env.REEL_BACKEND_TOKEN || (() => { try { return fs.readFileSync(path.join(root, '.backend-token'), 'utf8'); } catch { return ''; } })()).split(',')[0].trim();
  const headers = {'content-type': 'application/json', ...(tok ? {'x-reel-token': tok} : {})};
  let r = null;
  if (await fetch(`${api}/api/health`, {headers, signal: AbortSignal.timeout(2500)}).then((x) => x.ok, () => false)) {
    const res = await fetch(`${api}/api/review-retention`, {method: 'POST', headers, body: JSON.stringify({apply, ...(at >= 0 ? {keep} : {})})}); // no --keep: the backend's own REEL_REVIEW_KEEP_UNAPPROVED
    r = await res.json().catch(() => ({}));
    if (!res.ok) { console.error(`the backend refused the retention pass: ${r.error ?? res.status}`); process.exit(1); }
  } else r = await pruneAll(reviewsDir(publicDir), publicDir, {keep, apply});
  console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : retentionText(r));
}
