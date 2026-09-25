import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {applyCleanup, cleanupOptions, DEFAULTS, formatPlan, planCleanup} from '../scripts/cleanup-exports.mjs';
import {readRenderRecord, recordPath, writeRenderRecord} from '../scripts/render-records.mjs';

const H = 3600e3;
const NOW = Date.now();
const id = (n) => `17902${String(n).padStart(8, '0')}ab`; // Date.now() + 1 random byte, like the backend

// a project root with public/, exports aged by mtime, records, references and temps
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-'));
  const pub = path.join(root, 'public');
  const ex = path.join(pub, 'exports');
  for (const d of ['exports/masters', 'projects', 'reviews/p1', 'cache', 'clips']) fs.mkdirSync(path.join(pub, d), {recursive: true});
  fs.mkdirSync(path.join(root, '.captions-tmp'), {recursive: true});
  const put = (p, hoursOld, body = 'x') => {
    fs.writeFileSync(p, body);
    const t = new Date(NOW - hoursOld * H);
    fs.utimesSync(p, t, t);
    return p;
  };
  const exp = (name, hoursOld, rec) => {
    const p = put(path.join(ex, name), hoursOld, 'video'.repeat(100));
    if (rec) writeRenderRecord(p, {...rec, now: new Date(NOW - hoursOld * H)});
    return p;
  };
  const f = {root, ex, put, exp};
  // drafts / qcfail
  f.oldDraft = exp(`edited-${id(1)}-draft.mp4`, 100, {projectId: 'p1', kind: 'draft'});
  f.youngDraft = exp(`edited-${id(2)}-draft.mp4`, 10, {projectId: 'p1', kind: 'draft'});
  f.oldQcfail = exp(`edited-${id(3)}-qcfail.mp4`, 100, {projectId: 'p1', kind: 'qcfail'});
  f.oldDraftNoRecord = exp(`edited-${id(4)}-draft.mp4`, 100);
  f.draftInProject = exp(`edited-${id(5)}-draft.mp4`, 100, {projectId: 'p1', kind: 'draft'});
  // finals of project p1: two old good ones (the newer one is its latest good final) and a newer QC failure
  f.p1Older = exp(`edited-${id(10)}.mp4`, 50 * 24, {projectId: 'p1', kind: 'final'});
  f.p1Latest = exp(`edited-${id(11)}.mp4`, 40 * 24, {projectId: 'p1', kind: 'final'});
  f.p1Fail = exp(`edited-${id(12)}-qcfail.mp4`, 1, {projectId: 'p1', kind: 'qcfail'});
  f.p2Young = exp(`edited-${id(13)}.mp4`, 5 * 24, {projectId: 'p2', kind: 'final'});
  f.p2Old = exp(`edited-${id(14)}.mp4`, 60 * 24, {projectId: 'p2', kind: 'final'});
  f.unattributed = exp(`edited-${id(15)}.mp4`, 90 * 24);
  f.nullProject = exp(`edited-${id(16)}.mp4`, 90 * 24, {projectId: null, kind: 'final'});
  f.inReview = exp(`edited-${id(17)}.mp4`, 60 * 24, {projectId: 'p3', kind: 'final'});
  f.linkedFromReview = exp(`edited-${id(18)}.mp4`, 60 * 24, {projectId: 'p3', kind: 'final'});
  f.inManifest = exp(`edited-${id(19)}.mp4`, 60 * 24, {projectId: 'p3', kind: 'final'});
  f.legacyName = exp('edited-1790270211345.mp4', 60 * 24, {projectId: 'p4', kind: 'final'}); // before the random suffix
  f.legacyNewer = exp('edited-1790270211999.mp4', 50 * 24, {projectId: 'p4', kind: 'final'});
  // p3's latest good final is a young one, so the three above are only protected by their references
  f.p3Latest = exp(`edited-${id(20)}.mp4`, 2, {projectId: 'p3', kind: 'final'});
  // references
  put(path.join(root, 'public/projects/p1.json'), 1, JSON.stringify({name: 'P1', notes: {export: `/exports/edited-${id(5)}-draft.mp4`}}));
  put(path.join(root, 'public/projects/p1.lock'), 1, `edited-${id(1)}-draft.mp4`); // not a project file: protects nothing
  f.review = put(path.join(root, 'public/reviews/p1/versions.jsonl'), 1, `{"v":1,"file":"public/exports/edited-${id(17)}.mp4"}\n`);
  fs.symlinkSync(f.linkedFromReview, path.join(root, 'public/reviews/p1/v2.mp4'));
  f.reviewProxy = put(path.join(root, 'public/reviews/p1/v1-720p.mp4'), 100 * 24, 'binary');
  f.manifest = put(path.join(root, 'public/cache/masters-manifest.json'), 100 * 24, JSON.stringify({abc123: {file: `exports/edited-${id(19)}.mp4`}}));
  // things that are not ours to touch
  f.unknown = put(path.join(ex, 'proxy-720p.mp4'), 100 * 24);
  f.master = put(path.join(ex, 'masters', `edited-${id(30)}.mp4`), 100 * 24);
  f.orphanRecord = put(path.join(ex, `edited-${id(40)}.mp4.json`), 100, '{"kind":"draft"}');
  f.youngOrphanRecord = put(path.join(ex, `edited-${id(41)}.mp4.json`), 2, '{"kind":"draft"}');
  // render temps
  f.oldProps = put(path.join(root, `.props-${id(50)}.json`), 30);
  f.youngProps = put(path.join(root, `.props-${id(51)}.json`), 2);
  f.oldLutIn = put(path.join(root, `.lut-${id(52)}.json`), 30);
  f.oldLutOut = put(path.join(root, `.captions-tmp/lut-${id(52)}.json`), 30);
  f.otherDot = put(path.join(root, '.backend-token'), 1000);
  f.proof = put(path.join(root, '.captions-tmp/proof-1790200000000'), 1000);
  const links = path.join(root, `.captions-tmp/render-public-${id(53)}`);
  fs.mkdirSync(links);
  for (const e of fs.readdirSync(pub)) fs.symlinkSync(path.join(pub, e), path.join(links, e));
  fs.utimesSync(links, new Date(NOW - 30 * H), new Date(NOW - 30 * H));
  f.oldLinks = links;
  const dirty = path.join(root, `.captions-tmp/render-public-${id(54)}`);
  fs.mkdirSync(dirty);
  fs.writeFileSync(path.join(dirty, 'real.mp4'), 'x');
  fs.utimesSync(dirty, new Date(NOW - 30 * H), new Date(NOW - 30 * H));
  f.dirtyLinks = dirty;
  return f;
}

const byPath = (plan) => Object.fromEntries(plan.actions.map((a) => [a.path, a]));

test('plan: drafts and QC failures go after 72 h, finals after 30 days, temps after 24 h', () => {
  const f = fixture();
  const a = byPath(planCleanup({root: f.root, now: NOW}));
  for (const p of [f.oldDraft, f.oldQcfail, f.oldDraftNoRecord, f.p1Older, f.p2Old, f.legacyName, f.orphanRecord, f.oldProps, f.oldLutIn, f.oldLutOut, f.oldLinks]) assert.equal(a[p]?.action, 'delete', path.basename(p));
  for (const p of [f.youngDraft, f.p1Fail, f.youngOrphanRecord, f.youngProps]) assert.match(a[p].reason, /younger than/, path.basename(p));
});

test('plan: never the latest good final of a project, a referenced export or an unattributed final', () => {
  const f = fixture();
  const a = byPath(planCleanup({root: f.root, now: NOW}));
  assert.match(a[f.p1Latest].reason, /latest good final of project p1/);
  assert.match(a[f.legacyNewer].reason, /latest good final of project p4/);
  assert.match(a[f.p3Latest].reason, /latest good final of project p3/);
  assert.equal(a[f.p2Young].action, 'keep');
  assert.match(a[f.draftInProject].reason, /referenced by public\/projects\/p1\.json/);
  assert.match(a[f.inReview].reason, /referenced by public\/reviews\/p1\/versions\.jsonl/);
  assert.match(a[f.linkedFromReview].reason, /referenced by public\/reviews\/p1\/v2\.mp4/, 'a review symlink protects its target');
  assert.match(a[f.inManifest].reason, /referenced by public\/cache\/masters-manifest\.json/);
  assert.match(a[f.unattributed].reason, /unattributed/);
  assert.match(a[f.nullProject].reason, /unattributed/);
  assert.equal(a[f.oldDraft].action, 'delete', 'a .lock naming a draft protects nothing');
  assert.match(a[f.dirtyLinks].reason, /real files/);
});

test('plan: reviews, manifests, unknown names, subfolders and other temp files are never candidates', () => {
  const f = fixture();
  const plan = planCleanup({root: f.root, now: NOW});
  const paths = new Set(plan.actions.map((a) => a.path));
  for (const p of [f.review, f.reviewProxy, f.manifest, f.unknown, f.master, f.otherDot, f.proof]) assert.ok(!paths.has(p), path.relative(f.root, p));
  assert.ok(plan.actions.every((a) => !a.rel.startsWith('public/reviews') && !a.rel.startsWith('public/cache') && !a.rel.startsWith('public/projects')));
  assert.equal(plan.ignored, 2, 'proxy-720p.mp4 and the masters/ folder');
});

test('dry-run is the default and a plan deletes nothing; the report says what it would delete', () => {
  assert.equal(cleanupOptions([], {}).apply, false);
  const f = fixture();
  const before = fs.readdirSync(f.ex).length;
  const plan = planCleanup({root: f.root, now: NOW});
  assert.equal(fs.readdirSync(f.ex).length, before);
  assert.ok(fs.existsSync(f.oldProps) && fs.existsSync(f.oldLinks));
  const text = formatPlan(plan);
  assert.match(text, /DRY-RUN — nothing is deleted/);
  assert.match(text, new RegExp(`would delete  draft   public/exports/edited-${id(1)}-draft\\.mp4`));
  assert.match(text, /summary: would delete 11 /);
});

test('apply deletes exactly the plan (records with their mp4), never following render-public links', () => {
  const f = fixture();
  const plan = planCleanup({root: f.root, now: NOW});
  const r = applyCleanup(plan);
  assert.equal(r.deleted.length, plan.actions.filter((a) => a.action === 'delete').length);
  assert.equal(r.failed.length, 0);
  for (const a of plan.actions) assert.equal(fs.existsSync(a.path), a.action === 'keep', a.rel);
  assert.ok(!fs.existsSync(recordPath(f.oldDraft)), 'its record goes with it');
  assert.ok(readRenderRecord(f.p1Latest), 'kept exports keep their record');
  // the links pointed at public/ itself: everything there is intact
  for (const p of [f.review, f.reviewProxy, f.manifest, f.unknown, f.master, f.p1Latest, f.inManifest, path.join(f.root, 'public/projects/p1.json')]) assert.ok(fs.existsSync(p), path.relative(f.root, p));
  assert.ok(fs.existsSync(f.dirtyLinks) && fs.existsSync(f.otherDot) && fs.existsSync(f.proof));
});

test('apply leaves alone a file that changed after the plan', () => {
  const f = fixture();
  const plan = planCleanup({root: f.root, now: NOW});
  fs.utimesSync(f.oldDraft, new Date(), new Date()); // a render rewrote it meanwhile
  const r = applyCleanup(plan);
  assert.ok(fs.existsSync(f.oldDraft));
  assert.ok(r.skipped.some((s) => s.path === f.oldDraft && /changed/.test(s.why)));
});

test('TTLs are configurable: flags over env over defaults; --protect adds manifests', () => {
  assert.deepEqual({...cleanupOptions([], {}), protect: []}, {apply: false, json: false, ...DEFAULTS, protect: []});
  const o = cleanupOptions(['--draft-ttl-h', '200', '--apply'], {REEL_CLEANUP_DRAFT_TTL_H: '12', REEL_CLEANUP_FINAL_TTL_D: '7', REEL_CLEANUP_PROTECT: 'a.json, b'});
  assert.equal(o.draftTtlH, 200); assert.equal(o.finalTtlD, 7); assert.equal(o.tempTtlH, 24); assert.equal(o.apply, true);
  assert.deepEqual(o.protect, ['a.json', 'b']);
  assert.throws(() => cleanupOptions(['--final-ttl-d', '0'], {}), /≥ 1/);
  assert.throws(() => cleanupOptions(['--draft-ttl-h', 'x'], {}), /≥ 1/);
  assert.throws(() => cleanupOptions(['--force'], {}), /unknown option/);

  const f = fixture();
  let a = byPath(planCleanup({root: f.root, now: NOW, draftTtlH: 200}));
  assert.equal(a[f.oldDraft].action, 'keep');
  const extra = f.put(path.join(f.root, 'layers.lst'), 1, `edited-${id(1)}-draft.mp4`);
  a = byPath(planCleanup({root: f.root, now: NOW, protect: [extra]}));
  assert.match(a[f.oldDraft].reason, /referenced by layers\.lst/);
  assert.throws(() => planCleanup({root: f.root, now: NOW, protect: ['missing.json']}), /protect path not found/);
});

test('render records: project id sanitized, kind and time kept', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  const mp4 = path.join(d, 'edited-1.mp4');
  assert.equal(writeRenderRecord(mp4, {projectId: '../etc', kind: 'final'}).projectId, null);
  const r = writeRenderRecord(mp4, {projectId: 'abc-1', kind: 'final', renderSec: 12, now: new Date(0)});
  assert.deepEqual(readRenderRecord(mp4), r);
  assert.deepEqual(r, {projectId: 'abc-1', kind: 'final', createdAt: '1970-01-01T00:00:00.000Z', renderSec: 12});
  assert.equal(readRenderRecord(path.join(d, 'none.mp4')), null);
});

test('names of the render queue: job ids with 3 random bytes and one props file per Remotion pass', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-'));
  const ex = path.join(root, 'public', 'exports');
  fs.mkdirSync(ex, {recursive: true});
  const jid = '1790200000001a1b2c'; // scripts/render-jobs.mjs newJobId: Date.now() + 3 random bytes
  const old = (p, h) => { fs.writeFileSync(p, 'x'); const t = new Date(NOW - h * H); fs.utimesSync(p, t, t); return p; };
  const draft = old(path.join(ex, `edited-${jid}-draft.mp4`), 100);
  writeRenderRecord(draft, {projectId: 'p1', kind: 'draft'});
  const temps = ['', '-master', '-captions'].map((k) => old(path.join(root, `.props-${jid}${k}.json`), 30));
  const other = old(path.join(root, `.props-${jid}-other.json`), 30);
  const {actions} = planCleanup({root, now: NOW});
  const del = new Set(actions.filter((a) => a.action === 'delete').map((a) => a.path));
  assert.ok(del.has(draft), 'a draft of the new queue is purged after its TTL');
  for (const t of temps) assert.ok(del.has(t), `${path.basename(t)} is a dead render's temp`);
  assert.ok(!actions.some((a) => a.path === other), 'an unknown name is never a candidate');
  fs.rmSync(root, {recursive: true, force: true});
});
