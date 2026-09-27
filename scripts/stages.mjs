// Stage records (docs/designs/cesar-etapas-bandeja.md §3, CEO-1, CEO-11, CEO-13; plan phase 10): each stage's
// state and its log, OUTSIDE the project JSON — the editor's compare-and-swap on updatedAt never sees them, and
// GET /api/projects, list_projects and projectRows (every *.json of public/projects/) never list them.
//   public/stages/<id>.json    {projectId, stages: {<stage>: {status, rev, hash, at, by, findings, reds, redHash?, check, infra?, job?, proofs?}}}
//   public/stages/<id>.jsonl   append-only: {at, stage, from, to, actor, rev, findings?, discarded?}, and
//                              {at, event: 'UnmappedField' | 'proof' | 'dependency', actor, …}
// status: pendiente → trabajando → chequeando → verde | rojo, plus stale (an edit reopened it); the view adds
// omitida (outside project.scope: src/stages.ts inScope). reds = red checks of the stage in a row, one per version of
// what it reads (hash: a re-check of the same edit is no new attempt) — 3 → stop and ask Felipe; the machine's
// failures (infra) never count. Written in the backend only, inside the project's row:
//   saveProject / writeProject  the one project write (POST /api/projects/<id>, PUT …/captions): the server's
//                               own fields dropped, invalidate() → the stages it reopens marked stale
//   checkStage                  the only writer of verde / rojo / trabajando / chequeando, bound to the
//                               revision it read (CEO-11)
//   recordProof                 a proof (caption_proof, motion_proof) of the revision it showed
// and the MCP appends its dependency lines (logStage). Advisory: nothing is refused yet (plan phase 11).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {STAGES, canon, changedFields, inScope, invalidate, stageSlice, waitingOn} from '../src/stages.ts';
import {projectRenderProps} from '../src/renderProps.ts';
import {identityWrite, stageChecks, withDefaults} from '../mcp/checks.mjs';
import {ACTIVE, jobsDir, listJobs} from './render-jobs.mjs';

// a project's fields only the backend writes (stage records, approvals, notes, the stages mode): a POST's are dropped
export const SERVER_FIELDS = ['stages', 'approval', 'notes', 'stagesMode'];
// the proofs a stage's gate needs of its current slice (§3); the other stages' come with their tools
export const PROOFS = {captions: ['caption_proof', 'motion_proof']};
const INFRA = new Set(['OOM', 'STALLED', 'DIED', 'INTERRUPTED']); // scripts/render-jobs.mjs errorCode
const ID_RE = /^[\w-]+$/;

export const stagesDir = (publicDir) => path.join(publicDir, 'stages');
const fileOf = (publicDir, id, ext = '.json') => {
  if (!ID_RE.test(id ?? '')) throw new Error(`bad project id: ${id}`);
  return path.join(stagesDir(publicDir), `${id}${ext}`);
};
const writeJson = (file, x) => { // write + rename: a reader never sees half a file
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(x, null, 2));
  fs.renameSync(`${file}.${process.pid}.tmp`, file);
};
// what a proof or a render of a stage showed: the hash of its slice (the captionsRevision style)
export const sliceHash = (p, stage) => crypto.createHash('sha256').update(JSON.stringify(stageSlice(p, stage))).digest('hex').slice(0, 16);
export const readProject = (publicDir, id) => { try { return JSON.parse(fs.readFileSync(path.join(publicDir, 'projects', `${id}.json`), 'utf8')); } catch { return null; } };
export function readStages(publicDir, id) { try { return JSON.parse(fs.readFileSync(fileOf(publicDir, id), 'utf8')).stages ?? {}; } catch { return {}; } }
const writeStages = (publicDir, id, stages) => writeJson(fileOf(publicDir, id), {projectId: id, stages});
export function logStage(publicDir, id, entry) {
  fs.mkdirSync(stagesDir(publicDir), {recursive: true});
  fs.appendFileSync(fileOf(publicDir, id, '.jsonl'), `${JSON.stringify({at: new Date().toISOString(), ...entry})}\n`);
}
const brief = (list) => list?.map((f) => ({level: f.level, code: f.code, ...(f.ref ? {ref: f.ref} : {}), ...(f.omitted ? {omitted: f.omitted} : {})}));

// One writer at a time per project (the shape of scripts/reviews.mjs inReviewsRow): the project write, a check's
// start and its result, a proof. ponytail: in-process only — one backend per public/, the reviews' ceiling too
const rows = new Map();
export function inRow(id, fn) {
  const run = (rows.get(id) ?? Promise.resolve()).then(fn);
  rows.set(id, run.catch(() => {}));
  return run;
}

// one stage's new state, written and logged (from → to)
function setStage(publicDir, id, stage, next, actor, extra = {}) {
  const all = readStages(publicDir, id);
  const prev = all[stage] ?? {status: 'pendiente'};
  const counted = next.status === 'rojo' && !next.infra && next.hash !== prev.redHash; // a new version of the stage, red again
  const reds = next.status === 'verde' ? 0 : (prev.reds ?? 0) + (counted ? 1 : 0);
  const rec = {...prev, ...next, reds, redHash: next.status === 'verde' ? undefined : counted ? next.hash : prev.redHash, at: new Date().toISOString(), by: actor};
  all[stage] = JSON.parse(JSON.stringify(rec)); // an undefined infra / job clears the previous one
  writeStages(publicDir, id, all);
  logStage(publicDir, id, {stage, from: prev.status, to: rec.status, actor, rev: rec.rev ?? null, ...(next.findings ? {findings: brief(next.findings)} : {}), ...(next.infra ? {infra: true} : {}), ...extra});
  return all[stage];
}

// Write a project and reopen what the change reaches: invalidate(prev, next) → its stages stale (one never
// checked stays pendiente), a field no stage owns logged (UnmappedField). The stale marks go first: a failure or a
// crash before the project is written leaves a stage stale over an edit that did not land (the safe side), never
// green over one that did. → {stale, unmapped}
export function writeProject(publicDir, id, prev, next, actor = null) {
  const r = invalidate(prev, next), rev = next.updatedAt ?? null;
  const all = readStages(publicDir, id), at = new Date().toISOString();
  const hit = r.stale.filter((s) => all[s] && !['pendiente', 'stale'].includes(all[s].status)).map((s) => [s, all[s].status]);
  for (const [s] of hit) all[s] = {...all[s], status: 'stale', at, by: actor};
  if (hit.length) writeStages(publicDir, id, all);
  if (r.unmapped.length) logStage(publicDir, id, {event: 'UnmappedField', fields: r.unmapped, actor, rev});
  for (const [s, from] of hit) logStage(publicDir, id, {stage: s, from, to: 'stale', actor, rev});
  writeJson(path.join(publicDir, 'projects', `${id}.json`), next);
  return r;
}

// the updatedAt of a write after `prev`: now, or 1 ms after prev's — two writes in one millisecond must not share a
// revision (the compare-and-swap and a check's binding would both miss the second)
export const nextRev = (prev, now = new Date().toISOString()) => new Date(Math.max(Date.parse(now), (Date.parse(prev?.updatedAt) || 0) + 1)).toISOString();

// POST /api/projects/<id> — the editor's autosave, every MCP edit, the reel CLI → [status, body]. Compare-and-swap
// on updatedAt (a writer that read an older version is refused instead of overwriting the other's work), the
// identity check (mcp/checks.mjs), the server's fields dropped, merge (a field the writer does not know is kept;
// clearing is null / []), write, invalidate. A save that changes nothing (the editor's echo of an outside write)
// writes nothing and keeps the revision: proofs and checks of it stay current. Synchronous from the read to the
// write; the backend runs it in the row.
export function saveProject(publicDir, id, incoming, {actor = null, now} = {}) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return [400, {error: 'bad json: a project object'}];
  const was = readProject(publicDir, id), prev = was ?? {}; // missing, or corrupt: overwritten
  if (incoming.updatedAt && prev.updatedAt && incoming.updatedAt !== prev.updatedAt) return [409, {error: 'stale: project changed since you read it', updatedAt: prev.updatedAt}];
  const dropped = SERVER_FIELDS.filter((k) => Object.hasOwn(incoming, k));
  for (const k of dropped) delete incoming[k];
  // a new or changed identity must be valid and not another project's client + script + variant
  const badIdentity = identityWrite(path.join(publicDir, 'projects'), id, prev, incoming);
  if (badIdentity) return [400, {error: badIdentity, code: 'bad_identity'}];
  const kept = dropped.length ? {dropped} : {};
  if (was && !changedFields(prev, {...prev, ...incoming, createdAt: prev.createdAt, updatedAt: prev.updatedAt}).length) return [200, {ok: true, updatedAt: prev.updatedAt ?? null, stale: [], unchanged: true, ...kept}];
  now = nextRev(prev, now);
  const saved = {...prev, ...incoming, createdAt: prev.createdAt || now, updatedAt: now};
  const {stale} = writeProject(publicDir, id, prev, saved, actor);
  return [200, {ok: true, updatedAt: now, stale, ...kept}];
}

// check_stage (POST /api/projects/<id>/stages/<stage>/check): a stage's gate on the project as saved now, its
// result recorded — the only writer of verde, rojo, trabajando and chequeando → [status, body]. Bound to the
// revision it read (CEO-11, D21): the rules run outside the row (other writers are never held), and when the
// project's updatedAt moved meanwhile the result is discarded and the stage left stale. The newest check of a
// stage settles it: one that started meanwhile (its id on the record) drops this result unwritten (superseded).
// A stage outside the scope is omitida: nothing runs, nothing is written. A rule that throws is a red of the
// machine (infra). `pause` (tests): awaited between the rules and the write.
export async function checkStage(publicDir, id, stage, {actor = null, env = process.env, pause} = {}) {
  if (!STAGES.includes(stage)) return [400, {error: `stage: one of ${STAGES.join(', ')}`, code: 'bad_request'}];
  const p = readProject(publicDir, id);
  if (!p) return [404, {error: `project ${id} not found`, code: 'not_found'}];
  const rev = p.updatedAt ?? null, check = crypto.randomUUID();
  if (!inScope(p.scope).includes(stage)) return [200, {stage, status: 'omitida', rev, findings: []}];
  await inRow(id, () => setStage(publicDir, id, stage, {status: 'chequeando', rev, check}, actor));
  let r;
  try { r = await gate(publicDir, id, p, stage, env); } catch (e) { r = {status: 'rojo', infra: true, findings: [{level: 'error', code: 'check-failed', msg: `the check itself failed: ${String(e?.message ?? e).slice(0, 300)}`}]}; }
  await pause?.();
  return inRow(id, () => {
    const rec = readStages(publicDir, id)[stage];
    if (rec?.check !== check) return [200, {stage, ...rec, superseded: {rev, ...r}}];
    const now = readProject(publicDir, id)?.updatedAt ?? null;
    if (now !== rev) return [200, {stage, ...setStage(publicDir, id, stage, {status: 'stale', rev: now}, actor, {discarded: rev}), discarded: {rev, ...r}}];
    return [200, {stage, ...setStage(publicDir, id, stage, {infra: undefined, job: undefined, ...r, rev, hash: sliceHash(p, stage)}, actor)}];
  });
}

// the rules of one stage (mcp/checks.mjs stageChecks), the proofs its gate needs, and for the delivery the newest
// final render of the project as it is now (its stageHash) → {status, findings, infra?, job?}
async function gate(publicDir, id, p, stage, env) {
  const findings = [...(await stageChecks(withDefaults(structuredClone(p)), publicDir, env))[stage]];
  if (stage === 'captions' && p.captions?.length && !p.captionsOff) {
    const have = readStages(publicDir, id).captions?.proofs ?? {}, hash = sliceHash(p, 'captions');
    for (const kind of PROOFS.captions) if (have[kind]?.hash !== hash) findings.push({level: 'error', code: 'proof-missing', msg: `no ${kind} of the captions as they are now — take one${kind === 'motion_proof' ? ' at a key word' : ''}, then check_stage captions`});
  }
  const red = findings.some((f) => f.level === 'error');
  if (stage !== 'entregables') return {status: red ? 'rojo' : 'verde', findings};
  const finals = listJobs(jobsDir(publicDir), {projectId: id}).filter((j) => !j.draft);
  const job = finals.find((j) => j.stageHash === sliceHash(p, 'entregables'));
  if (!job) return {status: red ? 'rojo' : 'pendiente', findings: [...findings, {level: 'warn', code: 'no-render', msg: finals.length ? `the last final render (${finals[0].id}) is not of the project as saved now — render a final again` : 'no final render yet — start_render (a final), then check_stage entregables'}]};
  // queued again after a backend restart = its single retry: still working, red only if that fails too
  if (ACTIVE.has(job.status)) return {status: 'trabajando', job: job.id, findings: [...findings, {level: 'warn', code: 'render-running', msg: job.requeuedAt ? `render ${job.id} runs again after a backend restart (its single retry)` : `render ${job.id} is ${job.status}`}]};
  if (job.status === 'done') return {status: red ? 'rojo' : 'verde', job: job.id, findings};
  const infra = job.status === 'cancelled' || INFRA.has(job.errorCode) || /ENOSPC|no space left/i.test(job.error ?? '');
  return {status: 'rojo', infra: infra || undefined, job: job.id, findings: [...findings, {level: 'error', code: infra ? 'render-infra' : 'render-failed', msg: `render ${job.id} ${job.status}${job.error ? `: ${job.error}` : ''}${infra ? ' (the machine, not the reel: render again)' : ''}`}]};
}

// POST /api/render: the version a final renders, for the delivery's gate — the saved project's entregables slice, only
// when the body's props are what that project renders. An editor store that has not pulled an outside edit yet (its
// 2 s poll) or not saved its own (600 ms autosave), or a load() an edit overtook, render another version: none (null)
export function finalStageHash(props, saved) {
  const renders = (x) => canon(projectRenderProps({...x, identity: saved?.identity}));
  return saved && renders(props) === renders(saved) ? sliceHash(saved, 'entregables') : null;
}

// A proof of the project at `rev` — the MCP's caption_proof / motion_proof, or the editor's Proofed (a person who
// watched the preview, which is the render): kept with the hash of the stage's slice, so it counts until an edit
// reaches that slice; one of an older revision is not recorded (CEO-11, R2-8).
export function recordProof(publicDir, id, stage, {kind, rev} = {}, actor = null) {
  if (!PROOFS[stage]?.includes(kind)) return Promise.resolve([400, {error: `proof: ${stage} takes ${PROOFS[stage]?.join(', ') || 'none'}`, code: 'bad_request'}]);
  return inRow(id, () => {
    const p = readProject(publicDir, id);
    if (!p) return [404, {error: `project ${id} not found`, code: 'not_found'}];
    if ((p.updatedAt ?? null) !== (rev ?? null)) return [200, {recorded: false, reason: `the project changed after the ${kind} (rev ${rev}, now ${p.updatedAt}) — take it again`}];
    const all = readStages(publicDir, id), rec = all[stage] ?? {status: 'pendiente'};
    const proof = {hash: sliceHash(p, stage), rev, at: new Date().toISOString()};
    all[stage] = {...rec, proofs: {...rec.proofs, [kind]: proof}};
    writeStages(publicDir, id, all);
    logStage(publicDir, id, {event: 'proof', stage, kind, rev, hash: proof.hash, actor});
    return [200, {recorded: true, ...proof}];
  });
}

// GET /api/projects/<id>/stages, stage_status: every stage as it stands for the project `p` now
export function stageView(publicDir, id, p) {
  const recs = readStages(publicDir, id), on = inScope(p.scope);
  return {project: id, rev: p.updatedAt ?? null, scope: p.scope ?? null, runs: on, mode: p.stagesMode ?? 'advisory',
    stages: STAGES.map((s) => (on.includes(s) ? {stage: s, ...recs[s], status: recs[s]?.status ?? 'pendiente', waitingOn: waitingOn(recs, p.scope, s), ...(recs[s]?.reds >= 3 ? {escalate: true} : {})} : {stage: s, status: 'omitida'}))};
}
