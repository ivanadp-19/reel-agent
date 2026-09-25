// Purge old renders and orphaned render temp files, conservatively and by age.
//
//   node scripts/cleanup-exports.mjs            → DRY-RUN: prints what it would delete, deletes nothing
//   node scripts/cleanup-exports.mjs --apply    → deletes it
//
// What can go (and only once it is older than its TTL):
//   public/exports/edited-<id>-draft.mp4, -qcfail.mp4   drafts and QC failures   (--draft-ttl-h, 72 h)
//   public/exports/edited-<id>.mp4                      finals                   (--final-ttl-d, 30 days)
//   .props-<id>.json, .lut-<id>.json, .captions-tmp/render-public-<id>/, .captions-tmp/lut-<id>.json
//                                                       temp files of a render that died   (--temp-ttl-h, 24 h)
// What never goes:
//   - an export whose name appears in a project (public/projects/), anywhere under
//     public/reviews/ (review links and their versions) or in a cache manifest (any
//     *manifest*.json/.jsonl under public/ or .cache/, plus --protect / REEL_CLEANUP_PROTECT)
//   - the latest final that passed QC of each project (from the render records, scripts/render-records.mjs)
//   - a final with no record saying which project it belongs to (renders from before the records
//     existed, a render still being written): only a human deletes those
//   - anything whose name is not one the backend gives (other files, subfolders of exports/,
//     caches, proxies, posters) — they are counted, never touched
// If a project, review or manifest file cannot be read the run stops before deleting anything.
// Deterministic: the same files and clock give the same plan. Ready for cron (see AGENTS.md).
import fs from 'node:fs';
import path from 'node:path';
import {EXPORT_NAME, readRenderRecord, recordPath} from './render-records.mjs';

export const DEFAULTS = {draftTtlH: 72, finalTtlD: 30, tempTtlH: 24};
const H = 3600e3;
const ID = '\\d{13}[0-9a-f]{0,6}';
const REF = new RegExp(`edited-${ID}(?:-draft|-qcfail)?\\.mp4`, 'g'); // how an export is named inside any file that references it
const RECORD = new RegExp(`^edited-${ID}(?:-draft|-qcfail)?\\.mp4\\.json$`);
const ROOT_TEMP = new RegExp(`^\\.(?:props-${ID}(?:-master|-captions)?|lut-${ID})\\.json$`); // .props-<id>[-master|-captions].json: one per Remotion pass (scripts/render-runner.mjs)
const TMP_TEMP = new RegExp(`^(?:render-public-${ID}|lut-${ID}\\.json)$`);
const MANIFEST = /manifest.*\.jsonl?$/i;
const SKIP_DIRS = new Set(['.hf', 'node_modules']);

// ---------- options (flags win over env, env over defaults) ----------
export function cleanupOptions(argv = [], env = {}) {
  const o = {apply: false, json: false, ...DEFAULTS, protect: (env.REEL_CLEANUP_PROTECT || '').split(',').map((s) => s.trim()).filter(Boolean)};
  const num = (name, v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1) throw new Error(`${name} must be a number ≥ 1 (got ${v})`);
    return n;
  };
  if (env.REEL_CLEANUP_DRAFT_TTL_H) o.draftTtlH = num('REEL_CLEANUP_DRAFT_TTL_H', env.REEL_CLEANUP_DRAFT_TTL_H);
  if (env.REEL_CLEANUP_FINAL_TTL_D) o.finalTtlD = num('REEL_CLEANUP_FINAL_TTL_D', env.REEL_CLEANUP_FINAL_TTL_D);
  if (env.REEL_CLEANUP_TEMP_TTL_H) o.tempTtlH = num('REEL_CLEANUP_TEMP_TTL_H', env.REEL_CLEANUP_TEMP_TTL_H);
  const flags = {'--draft-ttl-h': 'draftTtlH', '--final-ttl-d': 'finalTtlD', '--temp-ttl-h': 'tempTtlH'};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--json') o.json = true;
    else if (a === '--protect') { if (!argv[i + 1]) throw new Error('--protect needs a path'); o.protect.push(argv[++i]); }
    else if (flags[a]) o[flags[a]] = num(a, argv[++i]);
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

// ---------- what protects an export ----------
// visit(path, isLink) for every file and symlink under dir (symlinks are not followed)
function walk(dir, visit) {
  let entries;
  try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, visit); }
    else if (e.isFile()) visit(p, false);
    else if (e.isSymbolicLink()) visit(p, true);
  }
}
const MEDIA = /\.(mp4|mov|m4v|webm|mkv|ts|m4s|mp3|m4a|aac|wav|jpe?g|png|webp|gif|tflite|onnx|bin)$/i;
// export name → the first place (relative to root) that names it. Sources: the projects, everything under
// public/reviews/ (review links and their versions, whatever their format: the text of every file, and the
// name and link target of every file or symlink), cache manifests, and the --protect paths.
function referencedExports(root, extra) {
  const pub = path.join(root, 'public');
  const refs = new Map();
  const add = (name, from) => { for (const m of String(name).matchAll(REF)) if (!refs.has(m[0])) refs.set(m[0], path.relative(root, from)); };
  const readText = (f) => {
    if (MEDIA.test(f)) return;
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return; throw new Error(`cannot read ${path.relative(root, f)}: ${e.message}`); } // deleted mid-run: it protects nothing any more
    add(text, f);
  };
  const everything = (f, isLink) => {
    add(path.basename(f), f);
    if (isLink) { try { add(path.basename(fs.readlinkSync(f)), f); } catch {} }
    if (!isLink) readText(f);
  };
  walk(path.join(pub, 'projects'), (f, isLink) => { if (!isLink && /\.json$/.test(f)) readText(f); });
  walk(path.join(pub, 'reviews'), everything);
  for (const dir of [pub, path.join(root, '.cache')]) walk(dir, (f, isLink) => { if (!isLink && MANIFEST.test(path.basename(f))) readText(f); });
  for (const p of extra) {
    const abs = path.resolve(root, p);
    if (!fs.existsSync(abs)) throw new Error(`protect path not found: ${p}`);
    if (fs.statSync(abs).isDirectory()) walk(abs, everything); else everything(abs, false);
  }
  return refs;
}

// ---------- the plan ----------
const ageH = (st, now) => Math.max(0, (now - st.mtimeMs) / H);
const dirBytes = (dir) => { let n = 0; for (const e of fs.readdirSync(dir)) n += fs.lstatSync(path.join(dir, e)).size; return n; };
// a render that ends mid-run removes its temps or renames its mp4: gone is not an error
const lstatOrNull = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

// → {actions: [{action: 'delete'|'keep', kind, path, rel, bytes, ageH, mtimeMs, reason}], ignored, options}
export function planCleanup({root, now = Date.now(), draftTtlH = DEFAULTS.draftTtlH, finalTtlD = DEFAULTS.finalTtlD, tempTtlH = DEFAULTS.tempTtlH, protect = []}) {
  const exportsDir = path.join(root, 'public', 'exports');
  const refs = referencedExports(root, protect);
  const actions = [];
  let ignored = 0;
  const push = (a) => actions.push({...a, rel: path.relative(root, a.path), ageH: Math.round(a.ageH * 10) / 10});

  // exports: top level only; subfolders and unknown names are never touched
  let names = [];
  try { names = fs.readdirSync(exportsDir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const exportsFound = [];
  for (const name of names.sort()) {
    const p = path.join(exportsDir, name);
    const st = lstatOrNull(p);
    if (!st) continue;
    if (!st.isFile()) { ignored++; continue; }
    const m = name.match(EXPORT_NAME);
    if (m) { exportsFound.push({name, p, st, suffix: m[2], rec: readRenderRecord(p)}); continue; }
    if (RECORD.test(name)) {
      if (fs.existsSync(p.slice(0, -'.json'.length))) continue; // handled with its mp4
      const a = ageH(st, now);
      push({action: a > tempTtlH ? 'delete' : 'keep', kind: 'record', path: p, bytes: st.size, ageH: a, mtimeMs: st.mtimeMs, reason: a > tempTtlH ? `render record whose mp4 is gone, older than ${tempTtlH}h` : `render record whose mp4 is gone, younger than ${tempTtlH}h`});
      continue;
    }
    ignored++;
  }

  // the latest final that passed QC of each project, from the records
  const latest = new Map();
  for (const e of exportsFound) {
    if (e.suffix || e.rec?.kind !== 'final' || !e.rec.projectId) continue;
    const cur = latest.get(e.rec.projectId);
    const key = `${e.rec.createdAt ?? ''}\u0000${e.name}`;
    if (!cur || key > cur.key) latest.set(e.rec.projectId, {key, name: e.name});
  }
  const latestOf = new Map([...latest].map(([pid, v]) => [v.name, pid]));

  for (const e of exportsFound) {
    const kind = e.suffix === '-draft' ? 'draft' : e.suffix === '-qcfail' ? 'qcfail' : 'final';
    const a = ageH(e.st, now);
    const recBytes = fs.existsSync(recordPath(e.p)) ? fs.lstatSync(recordPath(e.p)).size : 0;
    const base = {kind, path: e.p, bytes: e.st.size + recBytes, ageH: a, mtimeMs: e.st.mtimeMs};
    const ttlH = kind === 'final' ? finalTtlD * 24 : draftTtlH;
    const ttlText = kind === 'final' ? `${finalTtlD}d` : `${draftTtlH}h`;
    let keep = null;
    if (refs.has(e.name)) keep = `referenced by ${refs.get(e.name)}`;
    else if (latestOf.has(e.name)) keep = `latest good final of project ${latestOf.get(e.name)}`;
    else if (kind === 'final' && !e.rec?.projectId) keep = 'final with no project record (unattributed) — never purged automatically';
    else if (a <= ttlH) keep = `younger than ${ttlText}`;
    push(keep ? {...base, action: 'keep', reason: keep} : {...base, action: 'delete', reason: `${kind} older than ${ttlText}${e.rec?.projectId ? ` (project ${e.rec.projectId})` : ''}`});
  }

  // temp files of renders that never cleaned up after themselves
  const temps = [];
  for (const n of safeList(root)) if (ROOT_TEMP.test(n)) temps.push(path.join(root, n));
  const tmpDir = path.join(root, '.captions-tmp');
  for (const n of safeList(tmpDir)) if (TMP_TEMP.test(n)) temps.push(path.join(tmpDir, n));
  for (const p of temps.sort()) {
    const st = lstatOrNull(p);
    if (!st) continue;
    const a = ageH(st, now);
    const isDir = st.isDirectory();
    if (!isDir && !st.isFile()) continue;
    let bytes, onlyLinks = true;
    try {
      bytes = isDir ? dirBytes(p) : st.size;
      // a render-public dir only ever holds symlinks into public/; anything else in it is not ours to delete
      if (isDir) onlyLinks = fs.readdirSync(p).every((e) => fs.lstatSync(path.join(p, e)).isSymbolicLink());
    } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const base = {kind: 'temp', path: p, bytes, ageH: a, mtimeMs: st.mtimeMs, dir: isDir};
    if (!onlyLinks) push({...base, action: 'keep', reason: 'holds real files, not only links — left for a human'});
    else if (a <= tempTtlH) push({...base, action: 'keep', reason: `younger than ${tempTtlH}h (a render may still be using it)`});
    else push({...base, action: 'delete', reason: `render temp older than ${tempTtlH}h`});
  }
  return {actions, ignored, options: {draftTtlH, finalTtlD, tempTtlH}};
}
function safeList(dir) { try { return fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } }

// ---------- apply ----------
// Re-checks every file before deleting it: one that changed since the plan was made is left alone.
// A render-public dir is removed without following its links (fs.rm does not follow symlinks).
export function applyCleanup(plan) {
  const out = {deleted: [], skipped: [], failed: [], freed: 0};
  for (const a of plan.actions) {
    if (a.action !== 'delete') continue;
    try {
      const st = fs.lstatSync(a.path);
      if (st.mtimeMs !== a.mtimeMs) { out.skipped.push({...a, why: 'changed since the plan'}); continue; }
      if (a.dir) fs.rmSync(a.path, {recursive: true});
      else {
        fs.unlinkSync(a.path);
        if (a.kind !== 'record') fs.rmSync(recordPath(a.path), {force: true});
      }
      out.deleted.push(a); out.freed += a.bytes;
    } catch (e) {
      if (e.code === 'ENOENT') out.skipped.push({...a, why: 'already gone'});
      else out.failed.push({...a, why: e.message});
    }
  }
  return out;
}

// ---------- report ----------
const mb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
export function formatPlan(plan, {apply = false} = {}) {
  const {draftTtlH, finalTtlD, tempTtlH} = plan.options;
  const del = plan.actions.filter((a) => a.action === 'delete');
  const keep = plan.actions.filter((a) => a.action === 'keep');
  const lines = [
    `cleanup-exports: ${apply ? 'APPLY — deleting' : 'DRY-RUN — nothing is deleted (pass --apply to delete)'}`,
    `TTL: drafts/qcfail ${draftTtlH}h · finals ${finalTtlD}d · render temps ${tempTtlH}h`,
  ];
  for (const a of del) lines.push(`${apply ? 'delete' : 'would delete'}  ${a.kind.padEnd(6)}  ${a.rel}  ${mb(a.bytes)}  age ${a.ageH}h — ${a.reason}`);
  for (const a of keep) lines.push(`keep  ${a.kind.padEnd(6)}  ${a.rel}  ${mb(a.bytes)}  age ${a.ageH}h — ${a.reason}`);
  const freed = del.reduce((s, a) => s + a.bytes, 0);
  lines.push(`summary: ${apply ? 'deleting' : 'would delete'} ${del.length} (${mb(freed)}), keep ${keep.length}, ignored ${plan.ignored} (other names / subfolders of public/exports)`);
  return lines.join('\n');
}

// ---------- CLI ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const root = path.resolve(import.meta.dirname, '..');
  let o, plan;
  try {
    o = cleanupOptions(process.argv.slice(2), process.env);
    plan = planCleanup({root, ...o});
  } catch (e) {
    console.error(`cleanup-exports: ${e.message} — nothing deleted`);
    process.exit(2);
  }
  const stamp = new Date().toISOString();
  if (!o.apply) {
    console.log(o.json ? JSON.stringify({at: stamp, apply: false, ...plan}) : `[${stamp}] ${formatPlan(plan)}`);
  } else {
    const r = applyCleanup(plan);
    if (o.json) console.log(JSON.stringify({at: stamp, apply: true, ...plan, result: r}));
    else {
      console.log(`[${stamp}] ${formatPlan(plan, {apply: true})}`);
      for (const s of r.skipped) console.log(`skipped  ${s.rel} — ${s.why}`);
      for (const f of r.failed) console.error(`FAILED  ${f.rel} — ${f.why}`);
      console.log(`freed ${mb(r.freed)} in ${r.deleted.length} deletions`);
    }
    if (r.failed.length) process.exit(1);
  }
}
