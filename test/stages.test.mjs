// The stage map (src/stages.ts): what each field and tool reopens, invalidate(), and the rules of each gate.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {CLIP_FIELD_STAGE, FIELD_STAGE, JUDGE_STAGE, RULES, SCOPABLE, STAGES, TOOL_STAGE, callStages, inScope, invalidate, scopeFindings, scopeInput, scopeSkips, stageFindings, stageSlice, toolGate, waitingOn, waiverOf} from '../src/stages.ts';
import {projectRenderProps, withDeliveryFps} from '../src/renderProps.ts';
import {normalizeCaption} from '../src/captions.ts';
import {splitClip, trimClip} from '../src/timeline.ts';
import {validateProject} from '../src/validate.ts';
import {newProject, stageChecks, withDefaults} from '../mcp/checks.mjs';
import {SERVER_FIELDS, checkStage, finalStageHash, logStage, readProject, readStages, recordProof, saveProject, setStagesMode, sliceHash, stageReport, stageView, stagesDir, waive} from '../scripts/stages.mjs';
import {gate} from '../server/http.mjs';
import {SESSION_COOKIE, createLoginLimiter, parseRoles, signSession} from '../server/session.mjs';
import {createTokenStore} from '../server/tokens.mjs';
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
  scope: [], stagesMode: [],
};
const CLIP_FIELDS = {
  sourceDurationSec: ALL, ingest: ALL,
  id: AFTER_INGEST, src: AFTER_INGEST, inSec: AFTER_INGEST, outSec: AFTER_INGEST, speed: AFTER_INGEST, enter: AFTER_INGEST, jSec: AFTER_INGEST, lSec: AFTER_INGEST,
  volume: ['audio', 'entregables'], muted: ['audio', 'entregables'],
  transform: ['broll', 'entregables'],
  graded: ['color', 'entregables'], location: ['color', 'entregables'],
  label: [], srcKey: [], take: [], piece: [],
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
const CHANGED = {sourceDurationSec: 11, ingest: 'HDR', id: 'a2', src: 'clips/b.mp4', inSec: 1, outSec: 3, speed: 1.5, enter: 'whip', jSec: 0.5, lSec: 0.5, volume: 0.8, muted: true, transform: [{t: 0, scale: 1.2, x: 0, y: 0}], label: 'take 1', srcKey: 'a.mp4:1:2', take: {script: 2, variant: {hook: 1}}, graded: true, location: 'rooftop', piece: 'body'};
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
  assert.deepEqual(invalidate({}, {wobble: 'enforce'}), {stale: AFTER_INGEST, unmapped: ['wobble']});
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
  assert.deepEqual(waitingOn({corte: {status: 'chequeando'}}, null, 'broll'), ['corte'], 'a check in flight (or one a restart cut short) is no green');
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
  const {verdictOf, versionSummary} = await import('../.agents/skills/render-judge/judge.mjs');
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
  // the label the render queue writes on the version (scripts/reviews.mjs judgeVersion, judge.mjs --summary)
  const s = versionSummary({...v, findings: [...kept, ...advisory], skipped: [], profile: null});
  assert.deepEqual([s.label, s.findings.map((f) => f.check)], ['superado', ['sync', 'black-flash']]);
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

test('scope: without broll, broll\'s rules about the caption pages (layer-blocker, matte, safe-*) stay the captions\' — red, and a judge FAIL', async () => {
  const {verdictOf} = await import('../.agents/skills/render-judge/judge.mjs');
  const p = {clips: [clip()], identity: {client: 'acme', script: 2}, scope: ['captions'], captions: [page('c1', [w('hola', 100, 400)], {behind: true})], graphics: []};
  const issues = [{level: 'error', code: 'matte', msg: 'no matte'}, {level: 'warn', code: 'safe-bottom', msg: 'low', ref: 'c1'}, {level: 'warn', code: 'face', msg: 'on the face', ref: 'g1'}];
  const f = stageFindings({p, fps: 30000 / 1001, issues});
  assert.ok(f.captions.some((i) => i.code === 'layer-blocker' && i.level === 'error' && /behind the presenter/.test(i.msg)), JSON.stringify(f.captions));
  assert.deepEqual(f.captions.filter((i) => i.code !== 'layer-blocker').map((i) => `${i.code}:${i.level}`), ['matte:error', 'safe-bottom:warn']);
  assert.deepEqual(f.entregables.map((i) => `${i.code}:${i.omitted}`), ['face:broll'], 'a graphic\'s own rule stays advisory');
  assert.deepEqual(stageFindings({p: {...p, scope: ['color']}, fps: 30000 / 1001, issues}).captions, [], 'captions omitted too: advisory');
  assert.ok(stageFindings({p: {...p, scope: null}, fps: 30000 / 1001, issues}).broll.some((i) => i.code === 'layer-blocker'), 'everything asked: broll\'s, as before');
  const judged = [{check: 'validate-matte', severity: 'blocker', kind: 'rule', msg: 'no matte'}, {check: 'validate-safe-bottom', severity: 'major', kind: 'rule', msg: 'low'}, {check: 'claim-image', severity: 'major', kind: 'heuristic', msg: 'no gym'}];
  const s = scopeFindings(judged, ['captions']);
  assert.deepEqual([s.inScope.map((x) => x.check), s.advisory.map((x) => x.check)], [['validate-matte', 'validate-safe-bottom'], ['claim-image']]);
  assert.equal(verdictOf([...s.inScope, ...s.advisory]).verdict, 'FAIL');
});

test('scope: a check the judge skipped for an omitted stage never makes the label "evidencia reducida"; the report states the scope', async () => {
  const {reportText, verdictOf} = await import('../.agents/skills/render-judge/judge.mjs');
  const judgeSrc = fs.readFileSync(path.join(ROOT, '.agents', 'skills', 'render-judge', 'judge.mjs'), 'utf8');
  const notes = ['color-ref: the project has no identity.development — set_identity development', 'color vs "Thula": no encuentro a.jpg — put the approved references there',
    'grade-coverage: k0 — every frame under B-roll', 'source-cut (--no-source-scan)', 'music vs voice: no music-only stretch ≥ 0.8 s to measure the bed',
    'phone filter: could not measure the voice bands', 'parity: x.mp4 not found', 'contact sheets (boom) — use frame_at', 'audio analysis did not finish in 60 s — its checks are partial'];
  for (const n of notes) assert.ok(judgeSrc.includes(n.replace(/"[^"]*"/, '').split(/[:(]/)[0].split(' ').slice(0, 3).join(' ')), `the judge still skips "${n}"`);
  const s = scopeSkips(notes, ['captions']);
  assert.deepEqual([s.omitted, s.inScope], [notes.slice(0, 6), notes.slice(6)]);
  assert.deepEqual(scopeSkips(notes, ['color']).omitted, notes.slice(3, 6));
  assert.deepEqual(scopeSkips(notes, null), {inScope: notes, omitted: []});
  // judge(): only checks of the omitted stages skipped → not reduced
  const r = {label: '', iteration: 1, role: null, draft: false, durationSec: 9, profile: null, scope: ['captions'], ...verdictOf([], {reduced: scopeSkips(notes.slice(0, 6), ['captions']).inScope.length > 0}), findings: [], diff: null,
    skipped: [], skippedOmitted: s.omitted, evidence: {sheets: {}, lookAt: [], tech: {}, audio: {}, claims: [{t0: 1, t1: 2, text: 'con gimnasio', cues: [], inserts: [], lookAt: [1.5]}], inserts: ['gimnasio @0:34'], captions: [], graphics: [], broll: []}};
  assert.equal(r.label, 'QC técnico superado');
  const text = reportText(r);
  assert.match(text, /ALCANCE: ingest → guion → captions → entregables — omitidas: corte, color, audio, broll/);
  assert.match(text, /SKIPPED FUERA DEL ALCANCE[^\n]*\n {2}- color-ref/);
  assert.match(text, /PROMESAS DEL VO \(AVISO — broll fuera del alcance/);
  assert.match(text, /script inserts checked \(AVISO/);
  assert.doesNotMatch(reportText({...r, scope: null, skippedOmitted: []}), /ALCANCE|AVISO — broll/);
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

// a check that stops between its rules and its write until released (checkStage's `pause`)
const paused = () => {
  let reached, release;
  const at = new Promise((r) => { reached = r; }), gate = new Promise((r) => { release = r; });
  return {at, release, pause: () => { reached(); return gate; }};
};

test('two checks of one stage: the newest started settles it — an older one ending last never overwrites it', async () => {
  const pub = pubDir();
  try {
    saveProject(pub, 'p1', PROJ());
    // A reads R and waits; set_grade (not corte's) moves the project to R+1; B checks corte there and ends first
    const a = paused();
    const A = checkStage(pub, 'p1', 'corte', {...ENV, actor: 'A', pause: a.pause});
    await a.at;
    saveProject(pub, 'p1', {grade: {look: 'warm', intensity: 0.5}, updatedAt: readProject(pub, 'p1').updatedAt});
    const [, b] = await checkStage(pub, 'p1', 'corte', {...ENV, actor: 'B'});
    assert.ok(['verde', 'rojo'].includes(b.status), b.status);
    a.release();
    const [, ra] = await A;
    assert.ok(ra.superseded, 'A\'s result is dropped unwritten');
    assert.deepEqual([readStages(pub, 'p1').corte.status, readStages(pub, 'p1').corte.by], [b.status, 'B']);
    assert.ok(!log(pub, 'p1').some((e) => e.stage === 'corte' && e.to === 'stale'), 'nothing reopened corte');
    // one revision: A reads the final render while it is queued, it ends, B settles the delivery — A's trabajando is dropped
    const dir = jobsDir(pub);
    writeJob(dir, {id: 'job000001', seq: 1, status: 'queued', draft: false, projectId: 'p1', stageHash: sliceHash(readProject(pub, 'p1'), 'entregables'), attempts: 0, createdAt: new Date().toISOString()});
    const c = paused();
    const C = checkStage(pub, 'p1', 'entregables', {...ENV, pause: c.pause});
    await c.at;
    writeJob(dir, {...readJob(dir, 'job000001'), status: 'done', result: {file: '/exports/x.mp4'}});
    const [, d] = await checkStage(pub, 'p1', 'entregables', ENV);
    c.release();
    const [, rc] = await C;
    assert.equal(rc.superseded.status, 'trabajando');
    assert.equal(d.job, 'job000001');
    assert.notEqual(d.status, 'trabajando');
    assert.equal(readStages(pub, 'p1').entregables.status, d.status);
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

test('a save that changes nothing (the editor\'s echo of an outside write) writes nothing and keeps the revision: the proof and the check of it stand', async () => {
  const pub = pubDir();
  try {
    const [, a] = saveProject(pub, 'p1', withDefaults(PROJ())); // saved by the MCP: defaults filled, pages normalized
    const file = path.join(pub, 'projects', 'p1.json'), before = fs.readFileSync(file, 'utf8');
    const c = paused();
    const check = checkStage(pub, 'p1', 'captions', {...ENV, pause: c.pause});
    await c.at;
    // the editor pulls the project (its 2 s poll) and its autosave sends the same content back, as it holds it
    const {createdAt: _c, ...held} = readProject(pub, 'p1');
    const [code, e] = saveProject(pub, 'p1', {...held, captions: held.captions.map(normalizeCaption), music: null, grade: null, brand: null, identity: undefined, scope: null}, {actor: 'editor'});
    assert.deepEqual([code, e.updatedAt, e.stale, e.unchanged], [200, a.updatedAt, [], true]);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'not written');
    assert.equal((await recordProof(pub, 'p1', 'captions', {kind: 'caption_proof', rev: a.updatedAt}))[1].recorded, true, 'a proof of the revision the agent read');
    c.release();
    const [, r] = await check;
    assert.ok(!r.discarded && r.rev === a.updatedAt, JSON.stringify(r));
    // a rename is a change: written, a new revision; a stale writer is still refused
    const [, n] = saveProject(pub, 'p1', {name: 'renamed', updatedAt: a.updatedAt});
    assert.ok(n.updatedAt > a.updatedAt && !n.unchanged);
    assert.equal(saveProject(pub, 'p1', {name: 'renamed', updatedAt: a.updatedAt})[0], 409);
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

test('the stale marks are written before the project: a failure between them never leaves a stage green over an edit that landed', {skip: process.getuid?.() === 0 && 'root ignores file modes'}, async () => {
  const pub = pubDir();
  try {
    const [, a] = saveProject(pub, 'p1', PROJ());
    await checkStage(pub, 'p1', 'color', ENV);
    const was = readStages(pub, 'p1').color.status;
    const grade = {grade: {look: 'warm', intensity: 0.5}, updatedAt: a.updatedAt};
    const readOnly = (dir, fn) => { fs.chmodSync(dir, 0o555); try { return fn(); } finally { fs.chmodSync(dir, 0o755); } };
    // the records cannot be written (disk full, a read-only volume): the save fails and nothing of it lands
    assert.throws(() => readOnly(stagesDir(pub), () => saveProject(pub, 'p1', grade)), /EACCES|EPERM/);
    assert.deepEqual([readProject(pub, 'p1').updatedAt, readStages(pub, 'p1').color.status], [a.updatedAt, was]);
    // the project cannot be written after its marks: the stage is left stale — over-stale, the safe side
    assert.throws(() => readOnly(path.join(pub, 'projects'), () => saveProject(pub, 'p1', grade)), /EACCES|EPERM/);
    assert.deepEqual([readProject(pub, 'p1').updatedAt, readStages(pub, 'p1').color.status], [a.updatedAt, 'stale']);
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

test('a final render counts for the delivery only when it renders the project as saved — not the editor before its poll, nor a load() an edit overtook', () => {
  for (const identity of [undefined, {client: 'acme', script: 2}]) {
    const saved = {...PROJ(), identity, updatedAt: '2026-09-27T00:00:00.000Z'};
    const route = (props) => finalStageHash(withDeliveryFps(props, saved), saved); // as POST /api/render: the saved project's fps
    const want = sliceHash(saved, 'entregables');
    // the MCP (render, start_render) and the reel CLI: projectRenderProps of the project loaded with its defaults
    assert.equal(route({...projectRenderProps(withDefaults(structuredClone(saved))), draft: false, project_id: 'p1', mode: 'full'}), want);
    // the editor: its store, pages normalized, nulls where the project has nothing
    const store = {clips: saved.clips, music: null, captions: saved.captions.map(normalizeCaption), brolls: [], graphics: [], mattes: [], accentColor: '#FFB020', captionStyle: 'palabra', brand: null, grade: null, audio: null, captionsOff: false};
    assert.equal(route({...store, draft: false, mode: 'layers', project_id: 'p1'}), want);
    // an agent changed a word; the editor exports before its poll pulls it (or the MCP's load() came before the edit)
    const edited = {...saved, captions: [page('c1', [w('HOLA', 100, 400, {wid: 'a:0'}), w('amigos', 500, 900, {wid: 'a:1'})])]};
    assert.equal(finalStageHash(withDeliveryFps(store, edited), edited), null);
    // the editor's own edit not autosaved yet: the render is of a newer version than the saved one — none either
    assert.equal(route({...store, grade: {look: 'warm', intensity: 0.5}}), null);
  }
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
    // no proofs: red. The same version checked again (the editor's Check, the agent's check_stage, both at once) is
    // no new attempt; three versions red in a row (three fixes that did not fix it) escalate
    const red = async () => (await checkStage(pub, 'p1', 'captions', ENV))[1];
    const both = await Promise.all([red(), red()]); // the first is superseded by the second, started after it
    assert.deepEqual(both.map((r) => (r.superseded ? 'superseded' : r.reds)), ['superseded', 1]);
    assert.equal((await red()).reds, 1);
    let rev = b.updatedAt;
    for (const text of ['hola!', 'hola!!']) {
      rev = saveProject(pub, 'p1', {captions: [page('c1', [w(text, 100, 400, {wid: 'a:0'}), w('amigos', 500, 900, {wid: 'a:1'})])], updatedAt: rev})[1].updatedAt;
      await red(); await red();
    }
    const cap = stageView(pub, 'p1', readProject(pub, 'p1')).stages.find((s) => s.stage === 'captions');
    assert.deepEqual([cap.status, cap.reds, cap.escalate], ['rojo', 3, true]);
    saveProject(pub, 'p1', {clips: 'broken', updatedAt: rev});
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

// ---- plan phase 11: stagesMode, the MCP's gate (toolGate), waivers, the stage metrics of run-report ----
test('toolGate: off says nothing; advisory (the default) logs; enforce refuses a tool whose in-scope dependency is red or stale', () => {
  const recs = {ingest: {status: 'verde'}, corte: {status: 'stale'}, guion: {status: 'rojo'}, captions: {status: 'rojo'}};
  assert.equal(toolGate('edit_caption', {stagesMode: 'off'}, recs), null);
  for (const p of [{}, {stagesMode: 'advisory'}, {stagesMode: 'bogus'}]) assert.deepEqual(toolGate('edit_caption', p, recs), {mode: 'advisory', stages: ['captions'], deps: {corte: 'stale', guion: 'rojo'}}, JSON.stringify(p));
  const r = toolGate('edit_caption', {stagesMode: 'enforce'}, recs);
  assert.deepEqual([r.mode, r.deps], ['enforce', {corte: 'stale', guion: 'rojo'}]);
  assert.equal(r.refuse, 'edit_caption refused (stages enforce): it works in captions, which waits on corte (stale), guion (rojo). Fix what guion reports, then check_stage corte (then guion) and call edit_caption again; stage_status shows every stage. A warning you keep: waive_finding with the reason; a blocker only Felipe waives.');
  assert.equal(toolGate('edit_caption', {stagesMode: 'enforce'}, {captions: {status: 'rojo'}, corte: {status: 'pendiente'}}), null, 'its own stage red is how it gets fixed; never checked holds nothing');
  assert.equal(toolGate('get_project', {stagesMode: 'enforce'}, recs), null, 'a tool of no stage');
  assert.deepEqual(toolGate('add_broll', {stagesMode: 'enforce'}, {corte: {status: 'chequeando'}}).deps, {corte: 'chequeando'}, 'a check in flight lets nothing through');
});

test('toolGate gates a call by the work it does (callStages): run_ai_step by its step, set_clip by its fields, set_brand fonts as captions; one of its stages waiting on another counts', () => {
  const E = {stagesMode: 'enforce'};
  assert.deepEqual([callStages('run_ai_step', {step: 'autocut'}), callStages('run_ai_step', {step: 'captions'})], [['corte'], ['captions']]);
  assert.deepEqual(toolGate('run_ai_step', E, {corte: {status: 'rojo'}, guion: {status: 'verde'}}, {step: 'captions'}).deps, {corte: 'rojo'}, 'a captions pass on a red cut');
  assert.equal(toolGate('run_ai_step', E, {corte: {status: 'verde'}, guion: {status: 'stale'}}, {step: 'autocut'}), null, 'autocut never waits on the guion after it');
  assert.equal(toolGate('run_ai_step', E, {corte: {status: 'rojo'}}, {step: 'autocut'}), null, 'autocut is how a red cut gets fixed');
  assert.deepEqual([callStages('set_clip', {clip_id: 'a', speed: 2}), callStages('set_clip', {clip_id: 'a', volume: 0.5, muted: true}), callStages('set_clip', {clip_id: 'a', graded: null}), callStages('set_clip', {clip_id: 'a'})], [['corte'], ['audio'], ['color'], []]);
  assert.deepEqual(toolGate('set_clip', E, {corte: {status: 'rojo'}}, {clip_id: 'a', volume: 0.5}).deps, {corte: 'rojo'}, 'audio work on a red cut');
  assert.equal(toolGate('set_clip', E, {corte: {status: 'rojo'}}, {clip_id: 'a', speed: 2}), null);
  assert.deepEqual(toolGate('set_clip', E, {corte: {status: 'rojo'}}, {clip_id: 'a', speed: 2, volume: 1}).deps, {corte: 'rojo'}, 'speed + volume: the audio part waits');
  const Z = {apply_style: true, clear: false}; // zod's defaults reach the wrapper
  assert.deepEqual([callStages('set_brand', {...Z, font_files: [{path: 'f.ttf'}], caption_font: 'F'}), callStages('set_brand', {...Z, glossary: []})], [['captions'], ['captions']]);
  assert.deepEqual([callStages('set_brand', {...Z, from: 'vibem'}), callStages('set_brand', {...Z}), callStages('set_brand', {apply_style: true, clear: true})].map((x) => x.length), [4, 4, 4]);
  assert.equal(toolGate('set_brand', E, {captions: {status: 'rojo'}}, {...Z, font_files: [{path: 'f.ttf'}]}), null, 'the fix for font-missing');
  assert.deepEqual(toolGate('set_brand', E, {captions: {status: 'rojo'}}, {...Z, from: 'vibem'}).deps, {captions: 'rojo'}, 'a kit\'s broll / color / audio work waits on the red captions');
  assert.deepEqual(toolGate('set_accent_color', E, {captions: {status: 'rojo'}}, {color: '#FFFFFF'}).deps, {captions: 'rojo'}, 'broll waits on captions');
  assert.equal(toolGate('edit_caption', E, {captions: {status: 'rojo'}}), null, 'a call working only in the red stage: its fix');
});

test('toolGate: a final render needs every in-scope stage before the delivery verde — a never-checked one too; drafts are never gated', () => {
  const E = {stagesMode: 'enforce'}, green = Object.fromEntries(['ingest', 'corte', 'guion', 'color', 'audio', 'captions', 'broll'].map((s) => [s, {status: 'verde'}]));
  const r = toolGate('start_render', E, {});
  assert.deepEqual(r.deps, {ingest: 'pendiente', corte: 'pendiente', guion: 'pendiente', color: 'pendiente', audio: 'pendiente', captions: 'pendiente', broll: 'pendiente'});
  assert.match(r.refuse, /^start_render refused \(stages enforce\): it works in entregables, which waits on ingest \(pendiente\), .* — a final render needs every stage it delivers checked green\. check_stage ingest \(then corte, guion, color, audio, captions, broll\) and call start_render again/);
  assert.equal(toolGate('render', E, green, {draft: false}), null);
  assert.equal(toolGate('start_render', E, {}, {draft: true}), null, 'a draft is for looking');
  assert.deepEqual(toolGate('render', E, {...green, captions: {status: 'chequeando'}}).deps, {captions: 'chequeando'});
  assert.deepEqual(toolGate('start_render', {stagesMode: 'enforce', scope: ['captions']}, {ingest: {status: 'verde'}, guion: {status: 'verde'}, captions: {status: 'verde'}}), null, 'omitted stages are not the delivery\'s');
  assert.equal(toolGate('start_render', {}, {}), null, 'advisory: nothing checked is no log line (every project before the stages)');
  assert.deepEqual(toolGate('start_render', {}, {...green, captions: {status: 'stale'}}).deps, {captions: 'stale'}, 'advisory logs a red or stale one');
});

test('toolGate: set_scope may not drop a red, stale or still-checking stage in enforce (a blocker\'s waiver: Felipe\'s); a pendiente or verde one it may', () => {
  const E = {stagesMode: 'enforce'}, recs = {corte: {status: 'rojo'}, color: {status: 'verde'}, audio: {status: 'stale'}};
  const r = toolGate('set_scope', E, recs, {stages: ['captions', 'broll']});
  assert.deepEqual(r.deps, {corte: 'rojo', audio: 'stale'});
  assert.match(r.refuse, /^set_scope refused \(stages enforce\): it leaves out corte \(rojo\), audio \(stale\): .*only Felipe does that/);
  assert.equal(toolGate('set_scope', E, recs, {stages: ['corte', 'audio', 'captions']}), null, 'keeps them');
  assert.equal(toolGate('set_scope', E, {}, {stages: ['captions']}), null, 'nothing checked yet: scope first');
  assert.equal(toolGate('set_scope', {...E, scope: ['captions']}, recs, {stages: ['captions']}), null, 'already out');
  assert.deepEqual(toolGate('set_scope', {}, recs, {stages: ['captions']}).deps, {corte: 'rojo', audio: 'stale'}, 'advisory logs it');
});

test('toolGate enforce: an omitted stage never blocks (Felipe\'s rule) — only the dependencies the job asked for', () => {
  const recs = {corte: {status: 'rojo'}, color: {status: 'stale'}, captions: {status: 'stale'}};
  assert.equal(toolGate('edit_caption', {stagesMode: 'enforce', scope: ['captions']}, recs), null, 'corte omitted');
  assert.deepEqual(toolGate('start_render', {stagesMode: 'enforce', scope: ['captions']}, recs).deps, {ingest: 'pendiente', guion: 'pendiente', captions: 'stale'}, 'the delivery: color and corte omitted');
  assert.deepEqual(toolGate('share_version', {stagesMode: 'enforce', scope: ['captions']}, recs).deps, {captions: 'stale'});
  assert.deepEqual(toolGate('start_render', {stagesMode: 'enforce'}, recs).deps, {ingest: 'pendiente', corte: 'rojo', guion: 'pendiente', color: 'stale', audio: 'pendiente', captions: 'stale', broll: 'pendiente'}, 'no scope: all of them');
  assert.deepEqual(toolGate('start_render', {scope: ['captions']}, recs).deps, {captions: 'stale'}, 'advisory');
});

test('toolGate: a tool with no TOOL_STAGE row is refused in enforce (default-deny, like the plan gate), let through in advisory and off', () => {
  assert.match(toolGate('brand_new_tool', {stagesMode: 'enforce'}, {}).refuse, /^brand_new_tool refused \(stages enforce\): it has no stage in src\/stages\.ts TOOL_STAGE/);
  assert.ok(toolGate('toString', {stagesMode: 'enforce'}, {}).refuse, 'not the prototype\'s');
  assert.equal(toolGate('brand_new_tool', {}, {}), null);
  assert.equal(toolGate('brand_new_tool', {stagesMode: 'off'}, {}), null);
});

const ACME = {client: 'acme', script: 2, variant: {hook: 1}};
test('the first identity writes stagesMode enforce, logged; a project that had one, or a mode already, keeps its mode; a body never sets it', async () => {
  const pub = pubDir();
  try {
    const [, a] = saveProject(pub, 'p1', {...PROJ(), stagesMode: 'off'}, {actor: 'editor'});
    assert.deepEqual([readProject(pub, 'p1').stagesMode, stageView(pub, 'p1', readProject(pub, 'p1')).mode], [undefined, 'advisory'], 'no identity: advisory; the body\'s mode dropped');
    const [, b] = saveProject(pub, 'p1', {identity: ACME, updatedAt: a.updatedAt}, {actor: 'agent'});
    assert.deepEqual([b.stagesMode, readProject(pub, 'p1').stagesMode], ['enforce', 'enforce']);
    const modes = () => log(pub, 'p1').filter((e) => e.event === 'stagesMode').map((e) => [e.from, e.to, e.actor, e.why]);
    assert.deepEqual(modes(), [[null, 'enforce', 'agent', 'first identity']]);
    assert.ok(!log(pub, 'p1').some((e) => e.event === 'UnmappedField'), 'the mode is no content');
    // cleared and set again: still enforce, nothing new logged; a body's mode is dropped
    const [, c] = saveProject(pub, 'p1', {identity: null, stagesMode: 'off', updatedAt: b.updatedAt});
    saveProject(pub, 'p1', {identity: ACME, updatedAt: c.updatedAt});
    assert.deepEqual([readProject(pub, 'p1').stagesMode, modes().length], ['enforce', 1]);
    // before phase 11: an identity and no mode — a new identity is no first one, it stays advisory
    fs.writeFileSync(path.join(pub, 'projects', 'old.json'), JSON.stringify({...PROJ(), identity: {client: 'acme', script: 3}}));
    saveProject(pub, 'old', {identity: {client: 'acme', script: 4}});
    assert.equal(readProject(pub, 'old').stagesMode, undefined);
    // a mode the owner set before any identity stays
    fs.writeFileSync(path.join(pub, 'projects', 'mine.json'), JSON.stringify({...PROJ(), stagesMode: 'advisory'}));
    saveProject(pub, 'mine', {identity: {client: 'acme', script: 5}});
    assert.equal(readProject(pub, 'mine').stagesMode, 'advisory');
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

const TOKEN = crypto.randomBytes(16).toString('hex'), SECRET = crypto.randomBytes(32).toString('hex');
test('the mode route: only the owner\'s login session changes stagesMode — loopback, basic auth, every token and a reviewer get 403; logged with who', async () => {
  const pub = pubDir(), pass = crypto.randomBytes(8).toString('hex');
  try {
    const auth = {boss: bcrypt.hashSync(pass, 4)};
    const roles = parseRoles(JSON.stringify({boss: {role: 'owner'}}));
    const users = createTokenStore(path.join(pub, 't.json'));
    const {token: bossToken} = users.create({user: 'boss', admin: true});
    const at = (headers, publicMode = true) => gate({method: 'POST', headers: {host: '127.0.0.1:3333', ...headers}, socket: {}}, new URL('http://x/api/projects/p1/stages/mode'), {publicMode, auth, tokens: [TOKEN, 'second'], sessionSecret: SECRET, users, roles, limiter: createLoginLimiter({max: 50})});
    const session = {cookie: `${SESSION_COOKIE}=${signSession(SECRET, 'boss', {hash: auth.boss})}`};
    const callers = {
      loopback: await at({}, false),
      'the backend token in local mode': await at({'x-reel-token': TOKEN}, false),
      'the owner\'s session cookie in local mode': await at(session, false),
      'basic auth of the owner': await at({authorization: 'Basic ' + Buffer.from(`boss:${pass}`).toString('base64')}),
      'the primary backend token': await at({'x-reel-token': TOKEN}),
      'another backend token': await at({'x-reel-token': 'second'}),
      'the owner\'s own user token': await at({'x-reel-token': bossToken}),
      'a reviewer\'s login': {kind: 'ok', user: 'rev', via: 'session', role: 'reviewer', clients: ['acme']},
    };
    fs.mkdirSync(path.join(pub, 'projects'));
    const [, a] = saveProject(pub, 'p1', {...PROJ(), identity: ACME});
    for (const [who, g] of Object.entries(callers)) {
      assert.equal(g.kind, 'ok', `${who}: the gate lets it through`);
      const [code, r] = await setStagesMode(pub, 'p1', 'off', g);
      assert.deepEqual([code, r.code], [403, 'human_only'], who);
    }
    assert.equal(readProject(pub, 'p1').stagesMode, 'enforce', 'nobody but the owner relaxes enforce');
    const boss = await at(session);
    assert.deepEqual([boss.via, boss.role], ['session', 'owner']);
    assert.equal((await setStagesMode(pub, 'p1', 'strict', boss))[0], 400);
    assert.deepEqual(await setStagesMode(pub, 'p1', 'advisory', boss), [200, {mode: 'advisory', from: 'enforce', changed: true}]);
    assert.deepEqual(await setStagesMode(pub, 'p1', 'advisory', boss), [200, {mode: 'advisory', changed: false}]);
    const p = readProject(pub, 'p1');
    assert.deepEqual([p.stagesMode, p.updatedAt], ['advisory', a.updatedAt], 'no content changed: the revision stays (checks and proofs of it stand)');
    assert.deepEqual(log(pub, 'p1').filter((e) => e.event === 'stagesMode').map((e) => [e.from, e.to, e.actor]), [[null, 'enforce', null], ['enforce', 'advisory', 'boss']]);
    assert.equal((await setStagesMode(pub, 'nope', 'off', boss))[0], 404);
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

const AGENT = {kind: 'ok', admin: true, via: 'backend-token', primary: true}, OWNER = {kind: 'ok', user: 'boss', via: 'session', role: 'owner', clients: []};
const GUION = 'Hola amigos dos. Una frase que el corte no guarda nunca jamás.';
test('waivers: the agent waives a warning with a reason; a blocker only the owner\'s login — and a waived blocker leaves the stage green', async () => {
  const pub = pubDir();
  try {
    saveProject(pub, 'p1', {...PROJ(), guion: GUION});
    const pause = {rule: 'pause', ref: 'a:1', reason: 'la pausa es dramática'};
    assert.equal((await waive(pub, 'p1', 'corte', pause, OWNER))[0], 404, 'only what a check found');
    assert.equal((await checkStage(pub, 'p1', 'corte', ENV))[1].status, 'rojo');
    for (const g of [AGENT, {kind: 'ok', via: 'loopback'}, {kind: 'ok', user: 'rev', via: 'session', role: 'reviewer', clients: ['acme']}]) {
      const [code, r] = await waive(pub, 'p1', 'corte', pause, g);
      assert.deepEqual([code, r.code], [403, 'human_only'], g.via);
      assert.match(r.error, /pause is a blocker: only Felipe waives it/);
    }
    assert.equal((await waive(pub, 'p1', 'corte', {...pause, reason: '  '}, OWNER))[0], 400, 'a waiver says why');
    const [code, r] = await waive(pub, 'p1', 'corte', pause, OWNER);
    assert.deepEqual([code, r.waiver.by, r.waiver.level, r.waiver.reason], [200, 'boss', 'error', 'la pausa es dramática']);
    const [, g] = await checkStage(pub, 'p1', 'corte', ENV);
    assert.deepEqual([g.status, g.findings.map((f) => [f.code, f.waived?.by])], ['verde', [['pause', 'boss']]]);
    // a warning: the agent's to decide
    await checkStage(pub, 'p1', 'captions', ENV);
    const [cw, rw] = await waive(pub, 'p1', 'captions', {rule: 'guion-missing', ref: 'c1', reason: 'that line is the other variant\'s CTA'}, AGENT);
    assert.deepEqual([cw, rw.waiver.level, rw.waiver.by], [200, 'warn', 'backend-token']);
    const [, c] = await checkStage(pub, 'p1', 'captions', ENV);
    assert.deepEqual(c.findings.map((f) => [f.code, !!f.waived]), [['guion-missing', true], ['proof-missing', false], ['proof-missing', false]]);
    assert.equal(c.status, 'rojo', 'the blockers it did not waive still count');
    // one finding by code, ref and what it said; an agent's waiver of a warning never covers that rule as a blocker
    const said = c.findings[0].msg;
    assert.deepEqual(rw.waiver.msgs, [said]);
    assert.ok(waiverOf([rw.waiver], {code: 'guion-missing', ref: 'c1', level: 'warn', msg: said}));
    assert.equal(waiverOf([rw.waiver], {code: 'guion-missing', ref: 'c2', level: 'warn', msg: said}), undefined);
    assert.equal(waiverOf([rw.waiver], {code: 'guion-missing', ref: 'c1', level: 'warn', msg: 'another line'}), undefined, 'a later finding on a reused ref');
    assert.equal(waiverOf([rw.waiver], {code: 'guion-missing', ref: 'c1', level: 'error', msg: said}), undefined);
    const l = log(pub, 'p1');
    assert.deepEqual(l.filter((e) => e.event === 'waiver').map((e) => [e.stage, e.rule, e.ref, e.by, e.level]), [['corte', 'pause', 'a:1', 'boss', 'error'], ['captions', 'guion-missing', 'c1', 'backend-token', 'warn']]);
    assert.deepEqual(l.filter((e) => e.stage === 'corte' && e.to === 'verde').map((e) => e.findings), [[{level: 'error', code: 'pause', ref: 'a:1', waived: true}]]);
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

test('a waiver without a ref holds only for the version of the stage it was given on: proof-missing waived, the captions edited → back', async () => {
  const pub = pubDir();
  try {
    const [, a] = saveProject(pub, 'p1', PROJ());
    await checkStage(pub, 'p1', 'captions', ENV);
    const [code, r] = await waive(pub, 'p1', 'captions', {rule: 'proof-missing', reason: 'Felipe watched it in the editor'}, OWNER);
    assert.deepEqual([code, r.waiver.ref, typeof r.waiver.hash, r.waiver.msgs.length], [200, undefined, 'string', 2]);
    const proofs = async () => (await checkStage(pub, 'p1', 'captions', ENV))[1].findings.filter((f) => f.code === 'proof-missing').map((f) => !!f.waived);
    assert.deepEqual(await proofs(), [true, true]);
    saveProject(pub, 'p1', {captions: [page('c1', [w('hola', 100, 450, {wid: 'a:0'}), w('amigos', 500, 900, {wid: 'a:1'})])], updatedAt: a.updatedAt});
    assert.deepEqual(await proofs(), [false, false], 'other captions: the owner decides again');
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

test('run-report stage metrics: each stage green, waived or its status, and every tool started or refused on a red or stale stage', async () => {
  const pub = pubDir();
  try {
    saveProject(pub, 'p1', PROJ());
    for (const s of ['ingest', 'corte', 'guion', 'color', 'audio', 'captions']) await checkStage(pub, 'p1', s, ENV);
    await waive(pub, 'p1', 'corte', {rule: 'pause', ref: 'a:1', reason: 'dramática'}, OWNER);
    await checkStage(pub, 'p1', 'corte', ENV);
    logStage(pub, 'p1', {event: 'dependency', tool: 'add_broll', stages: ['broll'], deps: {captions: 'rojo'}, mode: 'advisory', actor: 'a'});
    logStage(pub, 'p1', {event: 'dependency', tool: 'start_render', stages: ['entregables'], deps: {captions: 'rojo', broll: 'stale'}, mode: 'enforce', refused: true, actor: 'a'});
    const r = stageReport(pub, 'p1', readProject(pub, 'p1'));
    assert.deepEqual(r.stages, {ingest: 'green', corte: 'waived', guion: 'green', color: 'green', audio: 'green', captions: 'rojo', broll: 'pendiente', entregables: 'pendiente'});
    assert.deepEqual([r.mode, r.allGreenOrWaived], ['advisory', false]);
    assert.deepEqual(r.startsOnRedOrStale, ['add_broll on captions rojo']);
    assert.deepEqual(r.refused, ['start_render on captions rojo, broll stale']);
    assert.deepEqual(r.waivers, ['corte pause (a:1) by boss: dramática']);
    // a captions-only job: the omitted stages count as done
    saveProject(pub, 'p1', {scope: ['captions'], updatedAt: readProject(pub, 'p1').updatedAt});
    assert.deepEqual(Object.entries(stageReport(pub, 'p1', readProject(pub, 'p1')).stages).filter(([, v]) => v === 'omitida').map(([k]) => k), ['corte', 'color', 'audio', 'broll']);
    assert.deepEqual(stageReport(pub, 'nolog', {}).startsOnRedOrStale, [], 'no log yet');
    // a stage the scope dropped while red (the editor, or anyone past the MCP's refusal) is logged and never counts as done
    saveProject(pub, 'p2', PROJ());
    assert.equal((await checkStage(pub, 'p2', 'corte', ENV))[1].status, 'rojo');
    saveProject(pub, 'p2', {scope: ['captions'], updatedAt: readProject(pub, 'p2').updatedAt}, {actor: 'editor'});
    assert.deepEqual(log(pub, 'p2').filter((e) => e.event === 'scope').map((e) => [e.from, e.to, e.actor, e.dropped]), [[null, ['captions'], 'editor', {corte: 'rojo', color: 'pendiente', audio: 'pendiente', broll: 'pendiente'}]]);
    const hid = stageReport(pub, 'p2', readProject(pub, 'p2'));
    assert.deepEqual([hid.stages.corte, hid.stages.color, hid.allGreenOrWaived], ['omitida (dropped rojo)', 'omitida', false]);
    saveProject(pub, 'p2', {scope: null, updatedAt: readProject(pub, 'p2').updatedAt});
    assert.equal(stageReport(pub, 'p2', readProject(pub, 'p2')).stages.corte, 'rojo', 'back in the job: its own status again');
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

test('MCP enforce: a tool on a red dependency is refused with the reason and logged; a blocker is not the agent\'s to waive; off lets it run; set_identity says enforce', async () => {
  const id = `p-stagetest-${process.pid}-${Math.random().toString(36).slice(2, 8)}`, id2 = `${id}-b`;
  const file = (x) => path.join('public', 'projects', `${x}.json`);
  fs.mkdirSync(path.dirname(file(id)), {recursive: true});
  const KEEP = {src: 'music/keep.mp3', volume: 0.25, startSec: 0, fadeOutSec: 1.5, duck: true, duckLevel: 0.25};
  const base = {...PROJ(), name: 'stage enforce test', clips: [clip({src: 'clips/stagetest-none.mp4', outSec: 5})], captions: []};
  fs.writeFileSync(file(id), JSON.stringify({...base, stagesMode: 'enforce', music: KEEP}));
  fs.writeFileSync(file(id2), JSON.stringify(base));
  const backend = await backendStub();
  const client = new Client({name: 'test', version: '0'});
  await client.connect(new StdioClientTransport({command: 'node', args: ['mcp/server.mjs'], cwd: process.cwd(), env: {...process.env, REEL_API: backend.url, REEL_AGENT: 'stages-test'}}));
  const call = async (name, args, pid = id) => { const r = await client.callTool({name, arguments: {project_id: pid, ...args}}); return {err: !!r.isError, text: r.content.map((c) => c.text ?? '').join('\n')}; };
  const saved = (x = id) => JSON.parse(fs.readFileSync(file(x), 'utf8'));
  const deps = (x = id) => { try { return fs.readFileSync(path.join('public', 'stages', `${x}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.event === 'dependency'); } catch { return []; } };
  try {
    assert.match((await call('check_stage', {stage: 'ingest'})).text, /^ingest: ROJO/);
    const no = await call('set_accent_color', {color: '#00FF00'});
    assert.equal(no.err, true);
    assert.match(no.text, /set_accent_color refused \(stages enforce\): it works in captions \+ broll, which waits on ingest \(rojo\)\. Fix what ingest reports, then check_stage ingest/);
    assert.notEqual(saved().accentColor, '#00FF00', 'nothing written');
    assert.deepEqual(deps().map((e) => [e.tool, e.deps, e.mode, e.refused]), [['set_accent_color', {ingest: 'rojo'}, 'enforce', true]]);
    { const gp = await call('get_project', {}); assert.equal(gp.err, false, gp.text); }
    assert.match((await call('stage_status', {})).text, /mode enforce: a tool whose stage depends on a red, stale or still-checking stage is refused, and a final render until every stage before it is verde/);
    // gated by what the call does (its arguments reach the gate): set_clip volume is audio work, a bare set_clip reads
    assert.match((await call('set_clip', {clip_id: 'a', volume: 0.5})).text, /^set_clip refused \(stages enforce\): it works in audio, which waits on ingest \(rojo\)/);
    assert.equal((await call('set_clip', {clip_id: 'a'})).err, false);
    // a tool that writes several projects gates each one: set_music targets is audio work on a red ingest too
    const many = await client.callTool({name: 'set_music', arguments: {targets: {project_ids: [id]}, file: null}});
    const said = many.content.map((c) => c.text ?? '').join('\n');
    assert.match(said, /0 of 1 project\(s\) set:\n {2}p-stagetest-\S+: error — set_music refused \(stages enforce\): it works in audio, which waits on ingest \(rojo\)/);
    assert.deepEqual(saved().music, KEEP, 'the music stays');
    assert.deepEqual(deps().map((e) => [e.tool, e.refused]), [['set_accent_color', true], ['set_clip', true], ['set_music', true]]);
    const w = await call('waive_finding', {stage: 'ingest', rule: 'untranscribed', ref: 'stagetest-none', reason: 'no audio in this clip'});
    assert.equal(w.err, true);
    assert.match(w.text, /untranscribed is a blocker: only Felipe waives it, with his login \(solo con login en la VM\)/);
    // off (what the owner's login sets): the same tool runs and nothing is logged
    fs.writeFileSync(file(id), JSON.stringify({...saved(), stagesMode: 'off'}));
    assert.equal((await call('set_accent_color', {color: '#00FF00'})).err, false);
    assert.equal(deps().length, 3);
    // a first identity through the MCP: the backend writes enforce and the tool says so
    const si = await call('set_identity', {client: `zzst${process.pid % 100000}`, script: 7, hook: 1}, id2);
    assert.equal(si.err, false, si.text);
    assert.match(si.text, /Stages: enforce — a tool whose stage depends on a red or stale stage is refused/);
    assert.equal(saved(id2).stagesMode, 'enforce');
  } finally {
    await client.close(); await backend.close();
    for (const x of [id, id2]) {
      for (const f of ['.json', '.lock', '.timing.jsonl']) fs.rmSync(file(x).replace(/\.json$/, f), {force: true});
      for (const f of ['.json', '.jsonl']) fs.rmSync(path.join('public', 'stages', `${x}${f}`), {force: true});
    }
  }
});
