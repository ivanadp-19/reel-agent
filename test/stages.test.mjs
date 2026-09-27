// The stage map (src/stages.ts): what each field and tool reopens, invalidate(), and the rules of each gate.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {CLIP_FIELD_STAGE, FIELD_STAGE, JUDGE_STAGE, RULES, SCOPABLE, STAGES, TOOL_STAGE, inScope, invalidate, scopeFindings, scopeInput, stageFindings, stageSlice, waitingOn} from '../src/stages.ts';
import {splitClip, trimClip} from '../src/timeline.ts';
import {validateProject} from '../src/validate.ts';
import {newProject, stageChecks, withDefaults} from '../mcp/checks.mjs';
import {SERVER_FIELDS, checkStage, readProject, readStages, recordProof, saveProject, sliceHash, stageView, stagesDir} from '../scripts/stages.mjs';
import {createRenderJobs, jobsDir, readJob, writeJob} from '../scripts/render-jobs.mjs';
import {backendStub} from './backend-stub.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ALL = [...STAGES];
const AFTER_INGEST = ALL.filter((s) => s !== 'ingest');
const CAPTIONS_ON = ['captions', 'broll', 'entregables'];

// every row of the map and what editing it leaves stale — a new row needs its line here
const FIELDS = {
  identity: ALL, lang: ALL,
  offMic: AFTER_INGEST, hiddenWids: AFTER_INGEST,
  guion: ['guion', ...CAPTIONS_ON],
  grade: ['color', 'entregables'],
  audio: ['audio', 'entregables'], music: ['audio', 'entregables'],
  captions: CAPTIONS_ON, captionStyle: CAPTIONS_ON, captionsOff: CAPTIONS_ON,
  brolls: ['broll', 'entregables'], brollAssets: ['broll', 'entregables'], graphics: ['broll', 'entregables'], mattes: ['broll', 'entregables'],
  accentColor: CAPTIONS_ON,
  brand: ['color', ...CAPTIONS_ON],
  name: [], plan: [], planMode: [], planModeLog: [], planApproved: [], planReviews: [], createdAt: [], updatedAt: [],
  scope: [],
};
const CLIP_FIELDS = {
  sourceDurationSec: ALL, ingest: ALL,
  id: AFTER_INGEST, src: AFTER_INGEST, inSec: AFTER_INGEST, outSec: AFTER_INGEST, speed: AFTER_INGEST, enter: AFTER_INGEST, jSec: AFTER_INGEST, lSec: AFTER_INGEST,
  volume: ['audio', 'entregables'], muted: ['audio', 'entregables'],
  transform: ['broll', 'entregables'],
  graded: ['color', 'entregables'], location: ['color', 'entregables'],
  label: [], srcKey: [],
};

test('every map row has its expected line in this test (and no line is left over)', () => {
  assert.deepEqual(Object.keys(FIELD_STAGE).sort(), Object.keys(FIELDS).sort());
  assert.deepEqual(Object.keys(CLIP_FIELD_STAGE).sort(), Object.keys(CLIP_FIELDS).sort());
});

for (const [field, stale] of Object.entries(FIELDS)) {
  test(`project field ${field} → ${stale.join(', ') || 'nothing'} stale`, () => {
    assert.deepEqual(invalidate({[field]: 'a'}, {[field]: 'b'}), {stale, unmapped: []});
  });
}

const clip = (x = {}) => ({id: 'a', src: 'clips/a.mp4', label: 'a', inSec: 0, outSec: 4, sourceDurationSec: 10, ...x});
const B = {id: 'b', src: 'clips/b.mp4', inSec: 0, outSec: 3, sourceDurationSec: 3};
const CHANGED = {sourceDurationSec: 11, ingest: 'HDR', id: 'a2', src: 'clips/b.mp4', inSec: 1, outSec: 3, speed: 1.5, enter: 'whip', jSec: 0.5, lSec: 0.5, volume: 0.8, muted: true, transform: [{t: 0, scale: 1.2, x: 0, y: 0}], label: 'take 1', srcKey: 'a.mp4:1:2', graded: true, location: 'rooftop'};
for (const [field, stale] of Object.entries(CLIP_FIELDS)) {
  test(`clip field ${field} → ${stale.join(', ') || 'nothing'} stale`, () => {
    assert.deepEqual(invalidate({clips: [clip(), B]}, {clips: [clip({[field]: CHANGED[field]}), B]}), {stale, unmapped: []});
  });
}

test('clips: a new source is ingest; a clip moved, removed or split from a known source is corte', () => {
  assert.deepEqual(invalidate({clips: [clip()]}, {clips: [clip(), B]}).stale, ALL);
  assert.deepEqual(invalidate({clips: [clip(), B]}, {clips: [B, clip()]}).stale, AFTER_INGEST);
  assert.deepEqual(invalidate({clips: [clip(), B]}, {clips: [clip()]}).stale, AFTER_INGEST);
  assert.deepEqual(invalidate({clips: [clip()]}, {clips: splitClip([clip()], 'a', 2).clips}).stale, AFTER_INGEST);
});

test('a field no stage owns: everything after ingest stale, and named', () => {
  assert.deepEqual(invalidate({}, {stagesMode: 'enforce'}), {stale: AFTER_INGEST, unmapped: ['stagesMode']});
  assert.deepEqual(invalidate({clips: [clip()]}, {clips: [clip({crop: 'x'})], name: 'n'}), {stale: AFTER_INGEST, unmapped: ['clips.crop']});
  assert.deepEqual(invalidate({constructor: 1}, {constructor: 2}).unmapped, ['constructor'], 'not the prototype\'s');
});

test('the identity changes the delivery fps: every stage is stale', () => {
  assert.deepEqual(invalidate({identity: null}, {identity: {client: 'acme', script: 2, variant: {hook: 1}}}).stale, ALL);
  assert.deepEqual(invalidate({identity: {client: 'acme', script: 2}}, {identity: {client: 'acme', script: 3}}).stale, ALL);
});

test('what is not a change: key order, and absent vs a default nothing (null, "", [], false)', () => {
  const p = {clips: [clip({enter: {kind: 'whip', ms: 200}})], music: {src: 'm.mp3', volume: 0.2}, captions: [], guion: ''};
  const q = {clips: [clip({enter: {ms: 200, kind: 'whip'}, lSec: undefined, muted: false})], music: {volume: 0.2, src: 'm.mp3'}, brand: null, hiddenWids: [], captionsOff: false};
  assert.deepEqual(invalidate(p, q), {stale: [], unmapped: []});
  assert.deepEqual(invalidate(null, undefined), {stale: [], unmapped: []});
});

test('a project saved without the defaults (no offMic, no audio) reopens nothing when a writer fills them', () => {
  const saved = {...newProject('x'), clips: [clip()]};
  assert.deepEqual(invalidate(saved, withDefaults(structuredClone(saved))), {stale: [], unmapped: []});
  assert.deepEqual(invalidate({}, withDefaults({})), {stale: [], unmapped: []}, 'a default withDefaults fills is missing from DEFAULTS');
  assert.deepEqual(invalidate({audio: null}, {audio: {clean: 'off'}}).stale, []);
  assert.deepEqual(invalidate({offMic: 'mark'}, {offMic: 'cut'}).stale, AFTER_INGEST, 'a real change still counts');
});

test('trim_clip → corte and everything after it, ingest green; set_grade → color and the delivery', () => {
  const p = {clips: [clip(), clip({id: 'a-s1', inSec: 4, outSec: 8})], grade: null};
  const r = trimClip(p.clips, 'a-s1', 4.5, undefined);
  assert.deepEqual(invalidate(p, {...p, clips: r.clips}).stale, ['corte', 'guion', 'color', 'audio', 'captions', 'broll', 'entregables']);
  assert.deepEqual(invalidate(p, {...p, grade: {look: 'warm', intensity: 0.5}}).stale, ['color', 'entregables']);
});

test('every MCP tool has its stage row (add the row when you add a tool), and every row is a tool', () => {
  const src = fs.readFileSync(path.join(ROOT, 'mcp', 'server.mjs'), 'utf8');
  const tools = [...src.matchAll(/server\.registerTool\('([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(tools.length > 60, `found ${tools.length} tools`);
  assert.deepEqual(tools.filter((t) => !Object.hasOwn(TOOL_STAGE, t)), [], 'tools with no stage row in src/stages.ts TOOL_STAGE');
  assert.deepEqual(Object.keys(TOOL_STAGE).filter((t) => !tools.includes(t)), [], 'rows for tools that no longer exist');
  for (const [t, stages] of Object.entries(TOOL_STAGE)) assert.ok(stages.every((s) => STAGES.includes(s)), t);
});

test('every code validate and the transcript checks emit belongs to a stage\'s rules (none falls to the delivery by accident)', () => {
  const codes = ['validate.ts', 'guion.ts', 'audio.ts'].flatMap((f) => [...fs.readFileSync(path.join(ROOT, 'src', f), 'utf8').matchAll(/code: '([a-z0-9-]+)'/g)].map((m) => m[1]));
  const owned = new Set(Object.values(RULES).flat());
  assert.ok(codes.length > 20);
  assert.deepEqual([...new Set(codes)].filter((c) => !owned.has(c)), []);
});

// ---- the rules of each gate ----
const page = (id, words, x = {}) => ({id, src: 'clips/a.mp4', clipId: 'a', startMs: words[0].startMs, endMs: words.at(-1).endMs, words, ...x});
const w = (text, startMs, endMs, x = {}) => ({text, startMs, endMs, ...x});

test('stageFindings: validate issues by code, ingest and layer rules, the judge in the delivery', () => {
  const p = {clips: [clip()], captions: [page('c1', [w('hola', 100, 400)])], graphics: [{id: 'g1', template: 'big-word', clipId: 'a', startMs: 0, endMs: 1000, props: {}}]};
  const issues = [
    {level: 'warn', code: 'glue', msg: 'g', ref: 'c1'}, {level: 'warn', code: 'safe-top', msg: 'c', ref: 'c1'}, {level: 'warn', code: 'safe-top', msg: 'g', ref: 'g1'},
    {level: 'warn', code: 'cut-word', msg: 'w', ref: 'a'}, {level: 'error', code: 'matte', msg: 'm'}, {level: 'warn', code: 'guion-missing', msg: 'x'}, {level: 'warn', code: 'new-rule', msg: 'n'},
  ];
  const judged = [{level: 'error', code: 'black-flash', msg: 'b'}];
  const r = stageFindings({p, fps: 30, issues, untranscribed: ['a'], judged});
  const codes = (s) => r[s].map((i) => `${i.code}${i.ref ? `:${i.ref}` : ''}`);
  assert.deepEqual(codes('ingest'), ['untranscribed:a']);
  assert.deepEqual(codes('corte'), ['cut-word:a']);
  assert.deepEqual(codes('captions'), ['glue:c1', 'guion-missing']);
  assert.deepEqual(codes('broll'), ['safe-top:c1', 'safe-top:g1', 'matte'], 'where a page lands reads the graphics: broll');
  assert.deepEqual(codes('entregables'), ['new-rule', 'black-flash']);
  assert.deepEqual([codes('guion'), codes('color'), codes('audio')], [[], [], []]);
  // a bad identity is ingest's; a client's deliverables need captions that can be a layer of their own
  const behind = {...p, captions: [page('c1', [w('hola', 100, 400)], {behind: true})]};
  assert.deepEqual(stageFindings({p: {...behind, identity: {client: 'X'}}, fps: 30, issues: []}).ingest.map((i) => i.code), ['identity']);
  assert.deepEqual(stageFindings({p: behind, fps: 30, issues: []}).broll, [], 'no identity: a full render, nothing blocks');
  const pair = stageFindings({p: {...behind, identity: {client: 'acme', script: 2}}, fps: 30000 / 1001, issues: []}).broll;
  assert.equal(pair[0].code, 'layer-blocker');
  assert.match(pair[0].msg, /behind the presenter/);
});

test('a graphics edit changes only what broll reads: the page an end-card hid, never the captions\' density', () => {
  const p = {clips: [clip({outSec: 30, sourceDurationSec: 30})], identity: {client: 'acme', script: 2, variant: {hook: 1}}, captionStyle: 'palabra',
    captions: [page('c1', [w('fin', 2500, 3000, {wid: 'a:9'})], {behind: true}), ...[5, 9, 13].map((s) => page(`t${s}`, [w('x', s * 1000, s * 1000 + 400, {wid: `a:${s}`, tier: 2})]))],
    graphics: [{id: 'g1', template: 'end-card', src: 'clips/a.mp4', startMs: 2000, endMs: 30000, props: {}}]};
  const q = {...p, graphics: []};
  const f = (x) => stageFindings({p: x, fps: 30000 / 1001, issues: validateProject(x, 30000 / 1001)});
  assert.deepEqual(invalidate(p, q).stale, ['broll', 'entregables']);
  for (const s of STAGES.filter((s) => !invalidate(p, q).stale.includes(s))) assert.deepEqual(f(q)[s], f(p)[s], s);
  assert.deepEqual([p, q].map((x) => f(x).broll.some((i) => i.code === 'layer-blocker')), [false, true]);
});

test('stageChecks: a saved project\'s findings — a source with no transcript, the judge\'s dead air on the cut', async () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-stages-'));
  try {
    fs.mkdirSync(path.join(pub, 'clips', 'transcripts'), {recursive: true});
    const words = [{word: 'uno', startMs: 100, endMs: 400}, {word: 'dos', startMs: 3900, endMs: 4200}];
    fs.writeFileSync(path.join(pub, 'clips', 'transcripts', 'a.es.json'), JSON.stringify(words));
    const p = {lang: 'es', offMic: 'mark', clips: [clip({outSec: 5}), B], captions: [], graphics: [], mattes: [], captionStyle: 'palabra'};
    const r = await stageChecks(p, pub, {});
    assert.deepEqual(r.ingest.map((i) => `${i.code}:${i.ref}`), ['untranscribed:b']);
    const pause = r.corte.find((i) => i.code === 'pause');
    assert.equal(pause?.level, 'error', JSON.stringify(r.corte));
    assert.match(pause.msg, /aire muerto de 3\.50 s/);
    // the judge's findings on the final render: a rule that counts blocks, an advisory one only warns
    const judged = [{check: 'black-flash', severity: 'major', kind: 'rule', msg: 'b'}, {check: 'source-cut', severity: 'major', kind: 'rule', msg: 's'}];
    assert.deepEqual((await stageChecks(p, pub, {}, judged)).entregables.map((i) => `${i.code}:${i.level}`), ['black-flash:error', 'source-cut:warn']);
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

test('stageChecks: corte reads neither the key words (captions) nor the mix (audio) — edits there leave it as it was', async () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-stages-'));
  try {
    fs.mkdirSync(path.join(pub, 'clips', 'transcripts'), {recursive: true});
    fs.writeFileSync(path.join(pub, 'clips', 'transcripts', 'a.es.json'), JSON.stringify([{word: 'uno', startMs: 100, endMs: 400}, {word: 'dos', startMs: 1200, endMs: 1500}]));
    fs.writeFileSync(path.join(pub, 'clips', 'transcripts', 'b.es.json'), JSON.stringify([{word: 'tres', startMs: 0, endMs: 3000}]));
    const p = (tier, muted) => ({lang: 'es', offMic: 'mark', captionStyle: 'palabra', graphics: [], mattes: [],
      clips: [clip({outSec: 1.6}), {...B, muted}, clip({id: 'a2', inSec: 0, outSec: 0.5})],
      captions: [page('c1', [w('uno', 100, 400, {wid: 'a:0'}), w('dos', 1200, 1500, {wid: 'a:1', tier})])]});
    const corte = async (x) => (await stageChecks(x, pub, {})).corte.map((i) => `${i.code}:${i.level}`);
    const before = await corte(p(0, false));
    assert.ok(before.includes('pause:warn'), `a mid-sentence pause is a candidate for the cut: ${before}`);
    assert.deepEqual(invalidate(p(0, false), p(1, false)).stale, CAPTIONS_ON);
    assert.deepEqual(await corte(p(1, false)), before, 'a key word');
    assert.deepEqual(invalidate(p(0, false), p(0, true)).stale, ['audio', 'entregables']);
    assert.deepEqual(await corte(p(0, true)), before, 'a muted clip (its gap is the final render\'s judge\'s)');
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

// ---- what the job asks for (project.scope): omitted stages are never red nor blocking, their findings advisory ----
test('scope: the stages a job asks for; ingest and the delivery always run, guion goes with captions; none = all (every project before it)', () => {
  assert.deepEqual(inScope(undefined), ALL);
  assert.deepEqual(inScope(null), ALL);
  assert.deepEqual(inScope([]), ALL);
  assert.deepEqual(inScope(['captions']), ['ingest', 'guion', 'captions', 'entregables']);
  assert.deepEqual(inScope(['corte', 'captions']), ['ingest', 'corte', 'guion', 'captions', 'entregables']);
  assert.deepEqual(inScope(['color', 'nope']), ['ingest', 'color', 'entregables'], 'a hand-edited bad entry is ignored');
  assert.deepEqual(scopeInput(['captions', 'corte', 'captions']), {scope: ['corte', 'captions']});
  assert.deepEqual(scopeInput([...SCOPABLE]), {scope: null}, 'everything is the default');
  assert.match(scopeInput([]).error, /at least one/);
  assert.match(scopeInput(['ingest']).error, /ingest is not a stage a job asks for/);
});

test('scope: an omitted stage never holds another back', () => {
  const recs = {ingest: {status: 'verde'}, corte: {status: 'rojo'}, guion: {status: 'stale'}, captions: {status: 'verde'}};
  assert.deepEqual(waitingOn(recs, null, 'captions'), ['corte', 'guion']);
  assert.deepEqual(waitingOn(recs, ['captions'], 'captions'), ['guion'], 'corte is not the job\'s');
  assert.deepEqual(waitingOn(recs, ['captions'], 'entregables'), ['guion']);
});

test('scope: what the gates find in an omitted stage is a warning of the delivery naming it — never red; no scope changes nothing', () => {
  const p = {clips: [clip()], captions: [page('c1', [w('hola', 100, 400)])], graphics: []};
  const issues = [{level: 'error', code: 'cut-word', msg: 'w', ref: 'a'}, {level: 'error', code: 'half-graded', msg: 'h'}, {level: 'warn', code: 'glue', msg: 'g', ref: 'c1'}];
  const all = stageFindings({p, fps: 30, issues});
  assert.deepEqual([all.corte.length, all.color.length, all.captions.length, all.entregables.length], [1, 1, 1, 0], 'default scope = all: as before');
  const only = stageFindings({p: {...p, scope: ['captions']}, fps: 30, issues});
  assert.deepEqual([only.corte, only.color], [[], []]);
  assert.deepEqual(only.captions.map((i) => i.code), ['glue']);
  assert.deepEqual(only.entregables.map((i) => `${i.code}:${i.level}:${i.omitted}`), ['cut-word:warn:corte', 'half-graded:warn:color']);
});

test('scope: the render judge\'s findings on an omitted stage are advisory and never count in the QC label', async () => {
  const {verdictOf} = await import('../.agents/skills/render-judge/judge.mjs');
  const judged = [
    {check: 'grade-coverage', severity: 'blocker', kind: 'heuristic', msg: 'look changes inside a shot'},
    {check: 'insert-missing', severity: 'major', kind: 'rule', msg: 'no insert'},
    {check: 'repeat', severity: 'major', kind: 'heuristic', msg: 'said twice'},
    {check: 'validate-cut-word', severity: 'major', kind: 'rule', msg: 'cut inside a word'},
    {check: 'sync', severity: 'minor', kind: 'rule', msg: 'late'},
    {check: 'black-flash', severity: 'nit', kind: 'rule', msg: 'fade'},
  ];
  const {inScope: kept, advisory} = scopeFindings(judged, ['captions']);
  assert.deepEqual(kept.map((f) => f.check), ['sync', 'black-flash']);
  assert.deepEqual(advisory.map((f) => `${f.check}→${f.omitted}`), ['grade-coverage→color', 'insert-missing→broll', 'repeat→corte', 'validate-cut-word→corte']);
  assert.ok(advisory.every((f) => f.advisory));
  assert.equal(verdictOf(judged).verdict, 'FAIL', 'the whole pipeline: they count');
  const v = verdictOf([...kept, ...advisory]);
  assert.deepEqual([v.verdict, v.label, v.advisories], ['PASS', 'QC técnico superado', 4]);
  assert.deepEqual(scopeFindings(judged, null), {inScope: judged, advisory: []}, 'no scope: nothing advisory');
  // the gate of the delivery reads them the same way
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-stages-'));
  try {
    const p = {lang: 'es', offMic: 'mark', clips: [clip()], captions: [], graphics: [], mattes: [], captionStyle: 'palabra'};
    const lv = async (scope) => (await stageChecks({...p, scope}, pub, {}, judged.slice(0, 2))).entregables.map((i) => `${i.code}:${i.level}`);
    assert.deepEqual(await lv(undefined), ['grade-coverage:warn', 'insert-missing:error'], 'a heuristic warns, a rule that counts blocks');
    assert.deepEqual(await lv(['captions']), ['grade-coverage:warn', 'insert-missing:warn']);
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

test('every check the render judge emits has a stage (RULES or JUDGE_STAGE, never both), and every JUDGE_STAGE row is a judge check', () => {
  const judge = fs.readFileSync(path.join(ROOT, '.agents', 'skills', 'render-judge', 'judge.mjs'), 'utf8');
  const checksMd = fs.readFileSync(path.join(ROOT, '.agents', 'skills', 'render-judge', 'checks.md'), 'utf8');
  const emitted = [...new Set([...judge.matchAll(/\bF\('([a-z0-9-]+)'/g)].map((m) => m[1]))];
  assert.ok(emitted.length > 40, `found ${emitted.length}`);
  const ruled = new Set(Object.values(RULES).flat());
  assert.deepEqual(emitted.filter((c) => !ruled.has(c) && !Object.hasOwn(JUDGE_STAGE, c)), [], 'judge checks with no stage: add them to JUDGE_STAGE');
  assert.deepEqual(Object.keys(JUDGE_STAGE).filter((c) => ruled.has(c)), [], 'in RULES already');
  assert.deepEqual(Object.keys(JUDGE_STAGE).filter((c) => !emitted.includes(c) && !checksMd.includes(`\`${c}\``)), [], 'rows for checks the judge does not have');
});

// ---- the stage records (scripts/stages.mjs): the one project write, check_stage bound to the revision ----
// a throwaway public/ with a transcript for clips/a.mp4 (dead air in the middle: corte has something to say)
function pubDir() {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-stages-'));
  fs.mkdirSync(path.join(pub, 'clips', 'transcripts'), {recursive: true});
  fs.writeFileSync(path.join(pub, 'clips', 'transcripts', 'a.es.json'), JSON.stringify([{word: 'hola', startMs: 100, endMs: 400}, {word: 'amigos', startMs: 500, endMs: 900}, {word: 'dos', startMs: 3900, endMs: 4200}]));
  return pub;
}
const PROJ = () => ({name: 'stages', lang: 'es', offMic: 'mark', captionStyle: 'palabra', clips: [clip({outSec: 5})], captions: [page('c1', [w('hola', 100, 400, {wid: 'a:0'}), w('amigos', 500, 900, {wid: 'a:1'})])], brolls: [], graphics: [], mattes: []});
const log = (pub, id) => fs.readFileSync(path.join(stagesDir(pub), `${id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const ENV = {env: {}};

test('the project write drops the server\'s fields, keeps the compare-and-swap, and reopens only the stages that were checked', async () => {
  const pub = pubDir();
  try {
    const [c0, a] = saveProject(pub, 'p1', {...PROJ(), stages: {ingest: {status: 'verde'}}, approval: {by: 'x'}, notes: ['n'], stagesMode: 'off'});
    assert.equal(c0, 200);
    assert.deepEqual(a.dropped, SERVER_FIELDS);
    const saved = readProject(pub, 'p1');
    assert.ok(SERVER_FIELDS.every((k) => !(k in saved)), 'none of them reaches the project');
    assert.ok(!fs.existsSync(path.join(pub, 'projects', 'stages')) && !fs.readdirSync(path.join(pub, 'projects')).some((f) => f !== 'p1.json'), 'the records never sit among the projects');
    assert.deepEqual(readStages(pub, 'p1'), {}, 'a new project: nothing checked, nothing stale');
    // a stale writer is refused and writes nothing
    const [c409] = saveProject(pub, 'p1', {name: 'late', updatedAt: '2000-01-01T00:00:00.000Z'});
    assert.equal(c409, 409);
    for (const s of ['ingest', 'corte', 'color']) assert.notEqual((await checkStage(pub, 'p1', s, ENV))[1].status, 'stale');
    // set_grade: color and the delivery stale — corte (checked) stays, captions (never checked) stays pendiente
    const [, b] = saveProject(pub, 'p1', {grade: {look: 'warm', intensity: 0.5}, updatedAt: a.updatedAt});
    assert.deepEqual(b.stale, ['color', 'entregables']);
    const st = readStages(pub, 'p1');
    assert.deepEqual([st.ingest.status !== 'stale', st.corte.status !== 'stale', st.color.status, st.captions], [true, true, 'stale', undefined]);
    assert.ok(b.updatedAt > a.updatedAt, 'every write moves the revision, even in the same millisecond');
    assert.equal(saveProject(pub, 'p1', {name: 'same ms', updatedAt: b.updatedAt}, {now: a.updatedAt})[1].updatedAt > b.updatedAt, true);
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

test('a field no stage owns: everything after ingest stale, and logged UnmappedField', async () => {
  const pub = pubDir();
  try {
    const [, a] = saveProject(pub, 'p1', PROJ());
    await checkStage(pub, 'p1', 'ingest', ENV); await checkStage(pub, 'p1', 'corte', ENV);
    const [, b] = saveProject(pub, 'p1', {wobble: 3, updatedAt: a.updatedAt}, {actor: 'editor'});
    assert.deepEqual(b.stale, AFTER_INGEST);
    assert.equal(readStages(pub, 'p1').corte.status, 'stale');
    assert.notEqual(readStages(pub, 'p1').ingest.status, 'stale');
    assert.deepEqual(log(pub, 'p1').filter((e) => e.event === 'UnmappedField').map((e) => [e.fields, e.actor]), [[['wobble'], 'editor']]);
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

test('CEO-11: a check that read R while an edit moved the project to R+1 ends stale and R\'s result is discarded; the edit gets no 409', async () => {
  const pub = pubDir();
  try {
    const [, a] = saveProject(pub, 'p1', PROJ());
    const R = a.updatedAt;
    let reached, release;
    const atPause = new Promise((r) => { reached = r; }), gate = new Promise((r) => { release = r; });
    const run = checkStage(pub, 'p1', 'corte', {...ENV, actor: 'agent A', pause: () => { reached(); return gate; }});
    await atPause; // the rules have run on R; the result is not written yet
    assert.equal(readStages(pub, 'p1').corte.status, 'chequeando');
    assert.equal(readProject(pub, 'p1').updatedAt, R, 'a check never touches the project');
    // agent B (or the editor), which read R, trims a clip: the check does not make it stale — 200, not 409
    const trimmed = trimClip(readProject(pub, 'p1').clips, 'a', 0.2, undefined).clips;
    const [code, b] = saveProject(pub, 'p1', {clips: trimmed, updatedAt: R}, {actor: 'agent B'});
    assert.equal(code, 200);
    assert.ok(b.stale.includes('corte'));
    release();
    const [, r] = await run;
    assert.equal(r.status, 'stale');
    assert.equal(r.discarded.rev, R, 'the result of R is thrown away');
    assert.equal(readStages(pub, 'p1').corte.status, 'stale');
    assert.deepEqual(log(pub, 'p1').filter((e) => e.stage === 'corte').map((e) => `${e.from}→${e.to}${e.discarded ? ` (discarded ${e.discarded === R ? 'R' : e.discarded})` : ''}`), ['pendiente→chequeando', 'chequeando→stale', 'stale→stale (discarded R)']);
    // with no edit meanwhile the result stands, bound to the revision it read
    const [, c] = await checkStage(pub, 'p1', 'corte', ENV);
    assert.ok(['verde', 'rojo'].includes(c.status), c.status);
    assert.equal(c.rev, b.updatedAt);
    // the editor that read R+1 before that check saves again: still no 409 (the records are outside its compare-and-swap)
    assert.equal(saveProject(pub, 'p1', {name: 'renamed', updatedAt: b.updatedAt})[0], 200);
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

test('check_stage during an edit through the backend (HTTP) gives the edit no 409, and the check result follows the revision', async () => {
  const id = `p-stagetest-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join('public', 'projects', `${id}.json`);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const backend = await backendStub();
  const call = (route, body) => fetch(`${backend.url}/api/projects/${id}${route}`, {method: 'POST', body: JSON.stringify(body ?? {})}).then(async (r) => [r.status, await r.json()]);
  try {
    const [, a] = await call('', {...PROJ(), clips: [clip({src: 'clips/stagetest-none.mp4', outSec: 5})]});
    // both at once: the check (seconds of rules) and an edit made on the revision read before it
    const [[c1, r1], [c2, r2]] = await Promise.all([call('/stages/ingest/check'), call('', {accentColor: '#00FF00', updatedAt: a.updatedAt})]);
    assert.equal(c2, 200, JSON.stringify(r2));
    assert.equal(c1, 200);
    assert.ok(r1.status === 'stale' || r1.rev === r2.updatedAt || r1.rev === a.updatedAt, JSON.stringify(r1));
    const [, rr] = await call('/stages/ingest/check');
    assert.equal(rr.status, 'rojo');
    assert.deepEqual(rr.findings.map((f) => f.code), ['untranscribed']);
    const [c3, dropped] = await call('', {stagesMode: 'enforce', stages: {ingest: {status: 'verde'}}, updatedAt: r2.updatedAt});
    assert.deepEqual([c3, dropped.dropped], [200, ['stages', 'stagesMode']]);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).stagesMode, undefined);
  } finally {
    await backend.close();
    for (const f of [file, path.join('public', 'stages', `${id}.json`), path.join('public', 'stages', `${id}.jsonl`)]) fs.rmSync(f, {force: true});
  }
});

test('captions: its gate needs a caption_proof and a motion_proof of the captions as they are now — one from before a trim does not count', async () => {
  const pub = pubDir();
  try {
    const [, a] = saveProject(pub, 'p1', PROJ());
    const proofs = async () => (await checkStage(pub, 'p1', 'captions', ENV))[1].findings.filter((f) => f.code === 'proof-missing').length;
    assert.equal(await proofs(), 2);
    assert.deepEqual((await recordProof(pub, 'p1', 'captions', {kind: 'caption_proof', rev: '2000-01-01T00:00:00.000Z'}))[1].recorded, false, 'a proof of another revision is not kept');
    assert.equal((await recordProof(pub, 'p1', 'color', {kind: 'caption_proof', rev: a.updatedAt}))[0], 400);
    for (const kind of ['caption_proof', 'motion_proof']) assert.equal((await recordProof(pub, 'p1', 'captions', {kind, rev: a.updatedAt}))[1].recorded, true);
    assert.equal(await proofs(), 0);
    // an edit outside what captions read (the grade) leaves the proofs valid; a trim (the cut under them) does not
    const [, b] = saveProject(pub, 'p1', {grade: {look: 'warm', intensity: 0.4}, updatedAt: a.updatedAt});
    assert.equal(await proofs(), 0);
    saveProject(pub, 'p1', {clips: [clip({outSec: 4.5})], updatedAt: b.updatedAt});
    assert.equal(await proofs(), 2);
    assert.notEqual(sliceHash(readProject(pub, 'p1'), 'captions'), readStages(pub, 'p1').captions.proofs.caption_proof.hash);
    assert.deepEqual(stageSlice({name: 'x', plan: 'y', grade: null, clips: [clip({muted: false})]}, 'captions'), {clips: [{id: 'a', inSec: 0, outSec: 4, sourceDurationSec: 10, src: 'clips/a.mp4'}]}, 'context, defaults and other stages\' fields are not in the slice');
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

test('the delivery after a backend restart: its re-queued final keeps entregables trabajando; the retry failing too is a red of the machine, not counted', async () => {
  const pub = pubDir();
  try {
    saveProject(pub, 'p1', PROJ());
    const dir = jobsDir(pub), iso = new Date().toISOString();
    assert.equal((await checkStage(pub, 'p1', 'entregables', ENV))[1].status, 'pendiente', 'no final of this version yet');
    // the final the dead backend was rendering (its pid 999999 is not alive for the queue)
    writeJob(dir, {id: 'job000001', seq: 1, status: 'running', stage: 'rendering', draft: false, projectId: 'p1', stageHash: sliceHash(readProject(pub, 'p1'), 'entregables'), attempts: 1, owner: 999999, createdAt: iso});
    fs.writeFileSync(path.join(dir, 'job000001.props.json'), '{}');
    const q = createRenderJobs({dir, run: () => new Promise(() => {}), isAlive: (pid) => pid === process.pid, log: () => {}});
    q.recover();
    assert.equal(readJob(dir, 'job000001').status, 'queued', 're-queued once');
    let [, r] = await checkStage(pub, 'p1', 'entregables', ENV);
    assert.equal(r.status, 'trabajando');
    assert.match(r.findings.find((f) => f.code === 'render-running').msg, /after a backend restart \(its single retry\)/);
    // the retry dies with its backend too: failed, INTERRUPTED — red, of the machine, the 3-reds count untouched
    writeJob(dir, {...readJob(dir, 'job000001'), status: 'running', attempts: 2, owner: 999999});
    q.recover();
    assert.deepEqual([readJob(dir, 'job000001').status, readJob(dir, 'job000001').errorCode], ['failed', 'INTERRUPTED']);
    [, r] = await checkStage(pub, 'p1', 'entregables', ENV);
    assert.deepEqual([r.status, r.infra, r.reds], ['rojo', true, 0]);
    // a failure of the reel counts; a done final of this version is green (and clears the count)
    writeJob(dir, {...readJob(dir, 'job000001'), errorCode: undefined, error: 'QC failed: loudness'});
    [, r] = await checkStage(pub, 'p1', 'entregables', ENV);
    assert.deepEqual([r.status, r.infra, r.reds], ['rojo', undefined, 1]);
    writeJob(dir, {...readJob(dir, 'job000001'), status: 'done', error: undefined, result: {file: '/exports/x.mp4'}});
    [, r] = await checkStage(pub, 'p1', 'entregables', ENV);
    assert.deepEqual([r.status, r.reds, r.job], ['verde', 0, 'job000001']);
    // the project changes: that render no longer counts
    saveProject(pub, 'p1', {accentColor: '#00FF00', updatedAt: readProject(pub, 'p1').updatedAt});
    assert.equal(readStages(pub, 'p1').entregables.status, 'stale');
    assert.equal((await checkStage(pub, 'p1', 'entregables', ENV))[1].status, 'pendiente');
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

test('an omitted stage: check_stage runs nothing and writes nothing; the view says omitida, 3 reds in a row escalate, a rule that throws is infra', async () => {
  const pub = pubDir();
  try {
    const [, a] = saveProject(pub, 'p1', {...PROJ(), scope: ['captions']});
    assert.deepEqual((await checkStage(pub, 'p1', 'color', ENV))[1], {stage: 'color', status: 'omitida', rev: a.updatedAt, findings: []});
    assert.equal(readStages(pub, 'p1').color, undefined);
    const v = stageView(pub, 'p1', readProject(pub, 'p1'));
    assert.deepEqual(v.stages.map((s) => `${s.stage}:${s.status}`), ['ingest:pendiente', 'corte:omitida', 'guion:pendiente', 'color:omitida', 'audio:omitida', 'captions:pendiente', 'broll:omitida', 'entregables:pendiente']);
    assert.deepEqual([v.mode, v.scope, v.runs], ['advisory', ['captions'], ['ingest', 'guion', 'captions', 'entregables']]);
    // default scope: nothing omitted
    const [, b] = saveProject(pub, 'p1', {scope: null, updatedAt: a.updatedAt});
    assert.ok(stageView(pub, 'p1', readProject(pub, 'p1')).stages.every((s) => s.status !== 'omitida'));
    assert.deepEqual(b.stale, [], 'the scope changes no content');
    for (let i = 0; i < 3; i++) await checkStage(pub, 'p1', 'captions', ENV); // no proofs: red three times
    const cap = stageView(pub, 'p1', readProject(pub, 'p1')).stages.find((s) => s.stage === 'captions');
    assert.deepEqual([cap.status, cap.reds, cap.escalate], ['rojo', 3, true]);
    saveProject(pub, 'p1', {clips: 'broken', updatedAt: b.updatedAt});
    const [, t] = await checkStage(pub, 'p1', 'corte', ENV);
    assert.deepEqual([t.status, t.infra, t.findings[0].code], ['rojo', true, 'check-failed']);
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

test('MCP: set_scope, check_stage and stage_status through the backend; a tool started on a red dependency is logged (advisory: it runs)', async () => {
  const id = `p-stagetest-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join('public', 'projects', `${id}.json`);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify({...PROJ(), name: 'stage tools test', clips: [clip({src: 'clips/stagetest-none.mp4', outSec: 5})], captions: []}));
  const backend = await backendStub();
  const client = new Client({name: 'test', version: '0'});
  await client.connect(new StdioClientTransport({command: 'node', args: ['mcp/server.mjs'], cwd: process.cwd(), env: {...process.env, REEL_API: backend.url, REEL_AGENT: 'stages-test'}}));
  const call = async (name, args) => { const r = await client.callTool({name, arguments: {project_id: id, ...args}}); return {err: !!r.isError, text: r.content.map((c) => c.text ?? '').join('\n')}; };
  const saved = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  try {
    const sc = await call('set_scope', {stages: ['captions']});
    assert.equal(sc.err, false, sc.text);
    assert.match(sc.text, /runs ingest → guion → captions → entregables; omitida: corte, color, audio, broll/);
    assert.deepEqual(saved().scope, ['captions']);
    assert.match((await call('get_project', {})).text, /SCOPE \(set_scope\): runs ingest/);
    assert.match((await call('check_stage', {stage: 'color'})).text, /^color: OMITIDA/);
    const ing = await call('check_stage', {stage: 'ingest'});
    assert.match(ing.text, /^ingest: ROJO/);
    assert.match(ing.text, /ERR  untranscribed/);
    // advisory: a captions tool on a red ingest runs, and the start is logged
    assert.equal((await call('set_accent_color', {color: '#00FF00'})).err, false);
    const dep = fs.readFileSync(path.join('public', 'stages', `${id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.event === 'dependency');
    assert.deepEqual(dep.map((e) => [e.tool, e.deps, e.mode, e.actor]), [['set_accent_color', {ingest: 'rojo'}, 'advisory', 'stages-test']]);
    const st = await call('stage_status', {});
    assert.match(st.text, /scope captions/);
    assert.match(st.text, /ingest\s+rojo/);
    assert.match(st.text, /corte\s+omitida/);
    assert.match(st.text, /captions\s+pendiente\s+— waits on ingest/);
    assert.equal((await call('set_scope', {stages: [...SCOPABLE]})).err, false);
    assert.equal(saved().scope, null, 'everything = the default');
    assert.ok((await call('set_scope', {stages: ['ingest']})).err, 'ingest is not asked for');
  } finally {
    await client.close(); await backend.close();
    for (const f of ['.json', '.lock', '.timing.jsonl']) fs.rmSync(file.replace(/\.json$/, f), {force: true});
    for (const f of ['.json', '.jsonl']) fs.rmSync(path.join('public', 'stages', `${id}${f}`), {force: true});
  }
});
