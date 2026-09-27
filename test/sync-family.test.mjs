// sync_family (CEO-5, D17; plan phase 20): a fix to the body of a script reaches its other variants — only what sits
// on the body clips, matched by source + time range, re-timed to each sibling's timeline; hooks and CTAs untouched;
// never across families or clients; graphics with data the sibling's audio does not say stay behind; the siblings'
// stages go stale; a sibling another agent holds is a line of a partial report.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {inferPieces, placeClips, syncFamily} from '../src/timeline.ts';
import {familyTargets, unbackedData} from '../src/validate.ts';
import {projectCaptions} from '../src/captions.ts';
import {projectBrolls} from '../src/brollModel.ts';
import {projectGraphics} from '../src/graphicTemplates.ts';
import {STAGES} from '../src/stages.ts';
import {readProject, readStages, saveProject} from '../scripts/stages.mjs';
import {acquireLock, releaseLock} from '../scripts/project-lock.mjs';
import {backendStub} from './backend-stub.mjs';

const clip = (id, src, inSec, outSec, x = {}) => ({id, src: `clips/${src}.mp4`, inSec, outSec, sourceDurationSec: 100, ...x});
const page = (id, src, ms, words, x = {}) => ({id, src: `clips/${src}.mp4`, startMs: ms, endMs: ms + 400 * words.length, topPct: 60,
  words: words.map((text, i) => ({text, wid: `${src}:${ms / 100 + i}`, startMs: ms + 400 * i, endMs: ms + 400 * i + 350, tier: 0})), ...x});
const gfx = (id, src, ms, template, props) => ({id, src: `clips/${src}.mp4`, startMs: ms, endMs: ms + 2000, template, props});
const cue = (id, clipId, ms) => ({id, clipId, startMs: ms, endMs: ms + 1500, kind: 'video', mode: 'fullscreen', src: 'broll/x.mp4'});
const ID = (variant, x = {}) => ({client: 'acme', family: 'acme-G2', script: 2, variant, ...x});
const FPS = 30;

// G2 as César shot it: H1's hook is two pieces of one file, the body two pieces of another, the close a third.
// No piece set: the identity tells them (inferPieces).
const from = () => ({
  identity: ID({hook: 1, cta: 1}),
  clips: [clip('g02-hook', 'g02-hook', 3.0, 6.8), clip('g02-hook-c1', 'g02-hook', 7.3, 15.4), clip('g02-body', 'g02-body', 4.8, 8.3, {volume: 0.8, jSec: 0.4}),
    clip('g02-body-c1', 'g02-body', 9.0, 14.2), clip('g02-close', 'g02-close', 14.7, 21.8)],
  captions: [page('c0', 'g02-hook', 3100, ['Tu', 'propia']), page('c1', 'g02-body', 5000, ['Una', 'cava'], {covers: ['g02-body:50']}), page('c2', 'g02-body', 9500, ['en', 'Montealbán']), page('c3', 'g02-close', 15000, ['Agenda'])],
  graphics: [gfx('g0', 'g02-hook', 3200, 'big-word', {text: 'cava'}), gfx('g1', 'g02-body', 5100, 'big-word', {text: 'amenidades'}), gfx('g2', 'g02-body', 10000, 'stat', {value: '70', label: ''})],
  brolls: [cue('b0', 'g02-hook-c1', 8000), cue('b1', 'g02-body-c1', 9600)],
  mattes: [{src: 'clips/g02-body.mp4', startMs: 4800, endMs: 7000, file: 'clips/mattes/g02-body-4800.webm'}],
  grade: {look: 'none', intensity: 0.8, auto: false, bySrc: {}, overrides: {'clips/g02-body.mp4': {adjust: {exposure: 0.2}}, 'g02-body-c1': {look: 'warm', intensity: 0.5}, 'g02-hook': {look: 'cool'}}},
  hiddenWids: ['g02-body:3', 'g02-hook:1'],
});
// H2_C1: another hook (another file, 5 s against H1's 11.9 s), the same body cut apart under other ids, the same close
const sibling = () => ({
  name: 'H2_C1', identity: ID({hook: 2, cta: 1}),
  clips: [clip('h2', 'g02-hook2', 0, 5.0, {piece: 'hook', volume: 1.2}), clip('body-x', 'g02-body', 4.8, 8.3, {piece: 'body'}), clip('body-y', 'g02-body', 9.0, 14.2, {piece: 'body', muted: true}),
    clip('close', 'g02-close', 14.7, 21.8, {piece: 'cta', jSec: 0.3})],
  captions: [page('c0', 'g02-hook2', 500, ['Otro', 'hook']), page('c1', 'g02-body', 5000, ['una', 'caba']), page('c2', 'g02-body', 9500, ['en', 'montealban']), page('c3', 'g02-close', 15000, ['Llama']), page('c4', 'g02-hook2', 2500, ['ya'])],
  graphics: [gfx('g0', 'g02-hook2', 600, 'big-word', {text: 'hook'}), gfx('g1', 'g02-body', 5100, 'big-word', {text: 'viejo'})],
  brolls: [cue('b0', 'h2', 1000), cue('b1', 'body-y', 12000)],
  mattes: [],
  grade: {look: 'none', intensity: 0.8, auto: false, bySrc: {}, overrides: {h2: {look: 'cool'}}},
  hiddenWids: ['g02-body:7', 'g02-hook2:2'],
});
// the sibling's audio says the 70 of g2 (Deepgram spells it out) — unless `said` is false
const words = (said = true) => [{clipId: 'body-y', source: 'g02-body', words: said ? [{i: 99, word: 'setenta', startMs: 9900, endMs: 10300}] : []}];
const sync = (f, s, said) => syncFamily(f, s, {unbacked: (q) => unbackedData(q, words(said))});
const onSrc = (items, re) => items.filter((x) => re.test(x.src));

test('inferPieces: G2\'s hook is two pieces of one file, the close the last source; plain variants and set pieces are left alone', () => {
  const f = from();
  assert.deepEqual(inferPieces(f.clips, f.identity.variant).map((c) => c.piece), ['hook', 'hook', 'body', 'body', 'cta']);
  assert.deepEqual(inferPieces(f.clips, {cta: 1}).map((c) => c.piece), ['body', 'body', 'body', 'body', 'cta']); // a body + close variant: no hook
  assert.equal(inferPieces(f.clips, {v: 2}), f.clips);
  assert.equal(inferPieces(f.clips, null), f.clips);
  const take = [clip('a', 'take', 0, 3), clip('b', 'take', 4, 9)];
  assert.equal(inferPieces(take, {hook: 1, cta: 1}), take, 'one source: no body would be left');
  const set = sibling().clips;
  assert.equal(inferPieces(set, {hook: 1}), set, 'every clip has its piece: nothing to infer');
  const one = [...f.clips.slice(0, 2), {...f.clips[2], piece: 'cta'}, ...f.clips.slice(3)];
  assert.deepEqual(inferPieces(one, f.identity.variant).map((c) => c.piece), ['hook', 'hook', 'cta', 'body', 'cta'], 'a piece the user set stays, the others are inferred');
});

test('only the body is copied; the sibling\'s hook and CTA stay deep-equal', () => {
  const s0 = sibling(), r = sync(from(), sibling());
  assert.ok(!r.error, r.error);
  const s = r.project;
  // hook and CTA: clips, pages, graphics, cues, grade overrides, hidden words — as they were
  for (const id of ['h2', 'close']) assert.deepEqual(s.clips.find((c) => c.id === id), s0.clips.find((c) => c.id === id));
  assert.deepEqual(onSrc(s.captions, /hook2|close/), onSrc(s0.captions, /hook2|close/));
  assert.deepEqual(onSrc(s.graphics, /hook2/), onSrc(s0.graphics, /hook2/));
  assert.deepEqual(s.brolls.find((b) => b.clipId === 'h2'), s0.brolls[0]);
  assert.deepEqual(s.grade.overrides.h2, {look: 'cool'});
  assert.ok(s.hiddenWids.includes('g02-hook2:2') && !s.hiddenWids.includes('g02-hook:1'), 'the from\'s hook words stay the from\'s');
  // the body: the from's pages (their key words and hand edits with them), graphics, cues on the matching clip
  const f = from();
  assert.deepEqual(onSrc(s.captions, /g02-body/), onSrc(f.captions, /g02-body/));
  assert.deepEqual(onSrc(s.graphics, /g02-body/).map((g) => g.props), [{text: 'amenidades'}, {value: '70', label: ''}]);
  assert.deepEqual(s.brolls.find((b) => b.id === 'b1'), {...f.brolls[1], clipId: 'body-y'}, 'matched by source + time, never by id');
  assert.deepEqual(s.mattes, f.mattes);
  // per-clip audio and the clip / source grade overrides onto the body clip showing the same footage
  const [x, y] = ['body-x', 'body-y'].map((id) => s.clips.find((c) => c.id === id));
  assert.deepEqual([x.volume, x.jSec, x.muted, y.volume, y.muted], [0.8, 0.4, undefined, undefined, undefined]);
  assert.deepEqual(s.grade.overrides, {h2: {look: 'cool'}, 'body-y': {look: 'warm', intensity: 0.5}, 'clips/g02-body.mp4': {adjust: {exposure: 0.2}}});
  assert.deepEqual([...s.hiddenWids].sort(), ['g02-body:3', 'g02-hook2:2']);
  assert.match(r.said, /2 body clips, 2 caption pages, 2 graphics, 1 B-roll cue, grade overrides/);
  // nothing else of the sibling moves (its name, identity), and a second sync changes nothing
  assert.deepEqual([s.name, s.identity], [s0.name, s0.identity]);
  assert.deepEqual(sync(from(), s).project, s);
});

test('re-timed: the sibling\'s hook is 5 s, the from\'s 11.9 s — each body item lands on the sibling\'s own timeline', () => {
  const f = from(), s = sync(f, sibling()).project;
  const hook = (p) => placeClips(p.clips, FPS).find((pc) => pc.clip.piece !== 'hook' && !/hook/.test(pc.clip.src)).startMs;
  assert.equal(hook(f), 11900);
  assert.equal(hook(s), 5000);
  const at = (items, id) => items.find((x) => x.id === id).startMs;
  for (const [proj, id] of [[projectCaptions, 'c1'], [projectCaptions, 'c2'], [projectGraphics, 'g1'], [projectBrolls, 'b1']]) {
    const fromMs = at(proj(f[proj === projectCaptions ? 'captions' : proj === projectGraphics ? 'graphics' : 'brolls'], f.clips, FPS), id);
    const sibMs = at(proj(s[proj === projectCaptions ? 'captions' : proj === projectGraphics ? 'graphics' : 'brolls'], s.clips, FPS), id);
    assert.ok(Math.abs(fromMs - 11900 - (sibMs - 5000)) < 1, `${id}: ${fromMs} on the from, ${sibMs} on the sibling`);
  }
  assert.equal(Math.round(at(projectBrolls(s.brolls, s.clips, FPS), 'b1')), 9100); // 5 s hook + 3.5 s body-x + 0.6 s into body-y
});

test('a graphic whose figure the sibling\'s audio does not say stays behind (data from this reel\'s audio)', () => {
  const r = sync(from(), sibling(), false);
  assert.deepEqual(onSrc(r.project.graphics, /g02-body/).map((g) => g.id), ['g1']);
  assert.match(r.said, /1 graphic, .*g2 left out \("70": dato sin respaldo en el audio de este reel\)/);
  assert.deepEqual(onSrc(sync(from(), sibling(), true).project.graphics, /g02-body/).map((g) => g.id), ['g1', 'g2']);
});

test('a speed ramp on the from\'s body: the sibling\'s uncut body clip is split to follow it; its own cue past the from\'s body is re-anchored', () => {
  const f = {...from(), clips: [clip('hook', 'g02-hook', 3, 6.8), clip('r0', 'g02-body', 4.8, 7.9), clip('r1', 'g02-body', 7.9, 11.0, {speed: 1.5}), clip('r2', 'g02-body', 11.0, 14.2, {speed: 2}), clip('close', 'g02-close', 14.7, 21.8)],
    brolls: [], graphics: [], grade: null};
  const s0 = {...sibling(), clips: [clip('body-x', 'g02-body', 4.8, 16, {piece: 'body'}), clip('close', 'g02-close', 14.7, 21.8, {piece: 'cta'})], brolls: [cue('b7', 'body-x', 15000)]};
  const r = sync(f, s0);
  assert.deepEqual(r.project.clips.map((c) => [c.id, c.inSec, c.outSec, c.speed]), [['body-x', 4.8, 7.9, undefined], ['body-x-s1', 7.9, 11, 1.5], ['body-x-s2', 11, 16, 2], ['close', 14.7, 21.8, undefined]]);
  assert.deepEqual(r.project.brolls, [{...cue('b7', 'body-x-s2', 15000)}], 'outside the from\'s body: the sibling\'s own, on the piece now under it');
  assert.match(r.said, /3 body clips \(2 splits to follow the from's\)/);
});

test('never across families or clients: syncFamily refuses, familyTargets picks the family\'s other projects only', () => {
  const other = (x) => ({...sibling(), identity: ID({hook: 2, cta: 1}, x)});
  assert.match(syncFamily(from(), other({family: 'acme-G3', script: 3})).error, /not the same family and client/);
  assert.match(syncFamily(from(), other({client: 'casa'})).error, /not the same family and client/);
  assert.match(syncFamily({...from(), identity: null}, sibling()).error, /not the same family/);
  const rows = [
    {id: 'a', identity: ID({hook: 1, cta: 1})}, {id: 'b', identity: ID({hook: 2, cta: 1})}, {id: 'c', identity: ID({cta: 1})},
    {id: 'd', identity: {client: 'acme', family: 'acme-G3', script: 3, variant: null}},
    {id: 'l1', identity: {client: 'acme', family: 'launch', script: 7, variant: null}}, {id: 'l2', identity: {client: 'casa', family: 'launch', script: 1, variant: null}},
    {id: 'l3', identity: {client: 'acme', family: 'launch', script: 7, variant: {v: 2}}}, {id: 'loose'},
  ];
  assert.deepEqual(familyTargets(rows, 'a'), {ids: ['b', 'c']});
  assert.deepEqual(familyTargets(rows, 'a', undefined, ['c']), {ids: ['b']});
  assert.deepEqual(familyTargets(rows, 'a', {project_ids: ['c']}), {ids: ['c']});
  assert.match(familyTargets(rows, 'a', {project_ids: ['b', 'd']}).error, /d: not of family acme-G2 of acme — sync_family never crosses/);
  assert.match(familyTargets(rows, 'a', {family: 'acme-G3'}).error, /d: not of family acme-G2/);
  assert.match(familyTargets(rows, 'l1').error, /cross clients/, 'a free-text family another client uses too: refused whole');
  assert.deepEqual(familyTargets(rows, 'l1', undefined, ['l2']), {ids: ['l3']});
  assert.match(familyTargets(rows, 'd').error, /no other project in family acme-G3/);
  assert.match(familyTargets(rows, 'loose').error, /loose has no identity/);
});

test('the sibling\'s stages go stale through the backend\'s write: a caption and the grade fixed on the body → captions, color, broll, entregables', () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-sync-'));
  fs.mkdirSync(path.join(pub, 'projects'));
  try {
    const f = from();
    assert.equal(saveProject(pub, 'sib', sync(f, sibling()).project)[0], 200);
    fs.mkdirSync(path.join(pub, 'stages'), {recursive: true});
    fs.writeFileSync(path.join(pub, 'stages', 'sib.json'), JSON.stringify({projectId: 'sib', stages: Object.fromEntries(STAGES.map((s) => [s, {status: 'verde'}]))}));
    f.captions[1].words[1].text = 'cava.'; // the fix on H1_C1's body: a caption…
    f.grade.overrides['clips/g02-body.mp4'].adjust.exposure = 0.1; // …and the grade on g02-body
    const saved = readProject(pub, 'sib');
    const [status, out] = saveProject(pub, 'sib', sync(f, saved).project);
    assert.equal(status, 200);
    assert.deepEqual(out.stale, ['color', 'captions', 'broll', 'entregables']);
    const st = readStages(pub, 'sib');
    assert.deepEqual(STAGES.filter((s) => st[s].status === 'stale'), ['color', 'captions', 'broll', 'entregables']);
    const now = readProject(pub, 'sib');
    assert.deepEqual(now.clips.find((c) => c.id === 'close'), saved.clips.find((c) => c.id === 'close'), 'its close piece is untouched');
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

test('editor parity: the Clip tab\'s Sync body and piece run the shared functions; the MCP too', () => {
  const ins = fs.readFileSync(new URL('../editor/Inspector.tsx', import.meta.url), 'utf8');
  const mcp = fs.readFileSync(new URL('../mcp/server.mjs', import.meta.url), 'utf8');
  for (const [file, text, re] of [
    ['Inspector', ins, /import \{[^}]*\bsyncFamily\b[^}]*\} from '\.\.\/src\/timeline'/],
    ['Inspector', ins, /import \{[^}]*\bfamilyTargets\b[^}]*\bunbackedData\b[^}]*\} from '\.\.\/src\/validate'/],
    ['Inspector', ins, /syncFamily\(from, await cur\.json\(\), \{unbacked: \(q\) => unbackedData\(q, tr\)\}\)/],
    ['Inspector', ins, /setClipTags\(selClip\.id, \{piece:/],
    ['Start', fs.readFileSync(new URL('../editor/Start.tsx', import.meta.url), 'utf8'), /inferPieces\(p\.clips \?\? \[\], p\.identity\?\.variant\)/],
    ['mcp/server', mcp, /familyTargets\(projectRows\(PROJECTS\), from, targets, except\)/],
    ['mcp/server', mcp, /syncFamily\(p, q, \{unbacked: \(x\) => unbackedData\(x, projectWords\(x, PUBLIC, JOB_ENV\)\)\}\)/],
    ['mcp/server', mcp, /clipTags\(p\.clips\[i\], \{graded, location, piece\}\)/],
  ]) assert.ok(re.test(text), `${file} does not use ${re}`);
});

// ---------- the MCP tool on throwaway projects, saved through the backend's write (test/backend-stub.mjs) ----------
test('sync_family (MCP): each sibling saved with its lock; one another agent holds is a line of a partial report; other families untouched', async () => {
  const PROJECTS = path.join('public', 'projects'), STAGE_DIR = path.join('public', 'stages');
  const tag = `${process.pid}${Math.random().toString(36).slice(2, 6)}`, client = `t${tag}`;
  const I = (x) => ({client, family: `${client}-G2`, script: 2, ...x});
  const ids = {from: `p-sync-${tag}-a`, sib: `p-sync-${tag}-b`, held: `p-sync-${tag}-c`, g3: `p-sync-${tag}-d`};
  const decor = (p) => ({...p, graphics: p.graphics.filter((g) => g.template === 'big-word')}); // untranscribed test sources: no figures to check
  const files = {
    [ids.from]: {...decor(from()), identity: I({variant: {hook: 1, cta: 1}})},
    [ids.sib]: {...decor(sibling()), identity: I({variant: {hook: 2, cta: 1}})},
    [ids.held]: {...decor(sibling()), identity: I({variant: {cta: 1}}), clips: sibling().clips.filter((c) => c.piece !== 'hook')},
    [ids.g3]: {...decor(sibling()), identity: {client, family: `${client}-G3`, script: 3, variant: null}},
  };
  fs.mkdirSync(PROJECTS, {recursive: true});
  for (const [id, p] of Object.entries(files)) fs.writeFileSync(path.join(PROJECTS, `${id}.json`), JSON.stringify({name: id, ...p, updatedAt: '2026-09-27T00:00:00.000Z'}));
  fs.mkdirSync(STAGE_DIR, {recursive: true});
  fs.writeFileSync(path.join(STAGE_DIR, `${ids.sib}.json`), JSON.stringify({projectId: ids.sib, stages: Object.fromEntries(STAGES.map((s) => [s, {status: 'verde'}]))}));
  assert.ok(acquireLock(PROJECTS, ids.held, {owner: 'another agent'}).ok); // this test process: a live holder that is not the MCP
  const backend = await backendStub();
  const mcp = new Client({name: 'test', version: '0'});
  await mcp.connect(new StdioClientTransport({command: 'node', args: ['mcp/server.mjs'], cwd: process.cwd(), env: {...process.env, REEL_API: backend.url, REEL_AGENT: 'sync-test'}}));
  const saved = (id) => JSON.parse(fs.readFileSync(path.join(PROJECTS, `${id}.json`), 'utf8'));
  const before = Object.fromEntries(Object.keys(files).map((id) => [id, saved(id)]));
  try {
    const r = await mcp.callTool({name: 'sync_family', arguments: {from: ids.from}});
    const said = r.content.map((c) => c.text ?? '').join('\n');
    assert.ok(!r.isError, said);
    assert.match(said, new RegExp(`1 of 2 sibling\\(s\\) of ${ids.from} synced`));
    assert.match(said, new RegExp(`${ids.sib}: ok — 2 body clips, 2 caption pages, 1 graphic, 1 B-roll cue, grade overrides`));
    assert.match(said, new RegExp(`${ids.held}: error — project ${ids.held} is being edited by another agent \\(another agent`));
    const s = saved(ids.sib);
    assert.deepEqual(onSrc(s.captions, /g02-body/).map((c) => c.words.map((w) => w.text).join(' ')), ['Una cava', 'en Montealbán']);
    assert.deepEqual(onSrc(s.captions, /hook2|close/), onSrc(before[ids.sib].captions, /hook2|close/));
    assert.deepEqual(s.clips.find((c) => c.id === 'h2'), before[ids.sib].clips.find((c) => c.id === 'h2'));
    const st = JSON.parse(fs.readFileSync(path.join(STAGE_DIR, `${ids.sib}.json`), 'utf8')).stages;
    assert.deepEqual(STAGES.filter((k) => st[k].status === 'stale'), ['corte', 'guion', 'color', 'audio', 'captions', 'broll', 'entregables'], 'J-cut and volume moved too: corte and after');
    for (const id of [ids.from, ids.held, ids.g3]) assert.deepEqual(saved(id), before[id], `${id} is not written`);
    assert.ok(!fs.existsSync(path.join(PROJECTS, `${ids.sib}.lock`)), 'a one-off write does not keep the sibling\'s lock');
    // a sibling named outside the family is refused whole, nothing written
    const bad = await mcp.callTool({name: 'sync_family', arguments: {from: ids.from, targets: {project_ids: [ids.g3]}}});
    assert.ok(bad.isError);
    assert.match(bad.content[0].text, /not of family/);
    assert.deepEqual(saved(ids.g3), before[ids.g3]);
  } finally {
    await mcp.close(); await backend.close();
    releaseLock(PROJECTS, ids.held);
    for (const id of Object.values(ids)) {
      for (const ext of ['.json', '.lock', '.timing.jsonl']) fs.rmSync(path.join(PROJECTS, id + ext), {force: true});
      for (const ext of ['.json', '.jsonl']) fs.rmSync(path.join(STAGE_DIR, id + ext), {force: true});
    }
  }
});
