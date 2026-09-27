// The stage map (src/stages.ts): what each field and tool reopens, invalidate(), and the rules of each gate.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CLIP_FIELD_STAGE, FIELD_STAGE, RULES, STAGES, TOOL_STAGE, invalidate, stageFindings} from '../src/stages.ts';
import {splitClip, trimClip} from '../src/timeline.ts';
import {stageChecks} from '../mcp/checks.mjs';

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
};
const CLIP_FIELDS = {
  sourceDurationSec: ALL, ingest: ALL,
  id: AFTER_INGEST, src: AFTER_INGEST, inSec: AFTER_INGEST, outSec: AFTER_INGEST, speed: AFTER_INGEST, enter: AFTER_INGEST, jSec: AFTER_INGEST, lSec: AFTER_INGEST,
  volume: ['audio', 'entregables'], muted: ['audio', 'entregables'],
  transform: ['broll', 'entregables'],
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
const CHANGED = {sourceDurationSec: 11, ingest: 'HDR', id: 'a2', src: 'clips/b.mp4', inSec: 1, outSec: 3, speed: 1.5, enter: 'whip', jSec: 0.5, lSec: 0.5, volume: 0.8, muted: true, transform: [{t: 0, scale: 1.2, x: 0, y: 0}], label: 'take 1', srcKey: 'a.mp4:1:2'};
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
  const codes = ['validate.ts', 'guion.ts'].flatMap((f) => [...fs.readFileSync(path.join(ROOT, 'src', f), 'utf8').matchAll(/code: '([a-z0-9-]+)'/g)].map((m) => m[1]));
  const owned = new Set(Object.values(RULES).flat());
  assert.ok(codes.length > 20);
  assert.deepEqual([...new Set(codes)].filter((c) => !owned.has(c)), []);
});

// ---- the rules of each gate ----
const page = (id, words, x = {}) => ({id, src: 'clips/a.mp4', clipId: 'a', startMs: words[0].startMs, endMs: words.at(-1).endMs, words, ...x});
const w = (text, startMs, endMs, x = {}) => ({text, startMs, endMs, ...x});

test('stageFindings: validate issues by code, safe zones by whose they are, ingest and layer rules, the judge in the delivery', () => {
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
  assert.deepEqual(codes('captions'), ['glue:c1', 'safe-top:c1', 'guion-missing']);
  assert.deepEqual(codes('broll'), ['safe-top:g1', 'matte']);
  assert.deepEqual(codes('entregables'), ['new-rule', 'black-flash']);
  assert.deepEqual([codes('guion'), codes('color'), codes('audio')], [[], [], []]);
  // a bad identity is ingest's; a client's deliverables need captions that can be a layer of their own
  const behind = {...p, captions: [page('c1', [w('hola', 100, 400)], {behind: true})]};
  assert.deepEqual(stageFindings({p: {...behind, identity: {client: 'X'}}, fps: 30, issues: []}).ingest.map((i) => i.code), ['identity']);
  assert.deepEqual(stageFindings({p: behind, fps: 30, issues: []}).captions, [], 'no identity: a full render, nothing blocks');
  const pair = stageFindings({p: {...behind, identity: {client: 'acme', script: 2}}, fps: 30000 / 1001, issues: []}).captions;
  assert.equal(pair[0].code, 'layer-blocker');
  assert.match(pair[0].msg, /behind the presenter/);
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
