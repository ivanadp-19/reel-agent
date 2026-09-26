// The music bed (set_music, the editor's Settings, MusicTrack): the level in dB over the linear gain the
// project keeps, the fade-in next to the fade-out and the ducking; and one edit on several projects —
// a family or ids minus except, never across clients, a result per project (src/validate.ts).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {interpolate} from 'remotion';
import {dbToGain, fmtDb, gainToDb, musicGain, musicOf} from '../src/audio.ts';
import {eachTarget, projectTargets} from '../src/validate.ts';
import {claimIdentity, projectRows} from '../mcp/checks.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('dB ↔ gain: 20·log10, one conversion for the MCP, the editor and get_project', () => {
  near(dbToGain(-30), 0.0316227766, 1e-9);
  near(dbToGain(0), 1);
  near(gainToDb(0.25), -12.0412, 1e-4);
  for (const db of [-60, -30, -12, -0.5]) near(gainToDb(dbToGain(db)), db);
  assert.equal(gainToDb(0), -Infinity);
  assert.equal(fmtDb(0.25), '-12.0 dB');
  assert.equal(fmtDb(dbToGain(-30)), '-30.0 dB');
  assert.equal(fmtDb(1), '0.0 dB');
  assert.equal(fmtDb(0), '-∞ dB');
});

test('musicOf: volume or volume_db (never both), fade-in 0–10 s, the old defaults when nothing is given', () => {
  // what set_music and the editor's pick wrote before: no fadeInSec key, so old projects keep their master key
  assert.deepEqual(musicOf({}), {volume: 0.25, startSec: 0, fadeOutSec: 1.5, duck: true, duckLevel: 0.25});
  near(musicOf({volume_db: -30}).volume, 0.0316227766, 1e-9);
  assert.equal(musicOf({volume: 0.4}).volume, 0.4);
  assert.throws(() => musicOf({volume: 0.4, volume_db: -30}), /volume.*or volume_db, not both/);
  assert.throws(() => musicOf({fade_in_sec: 11}), /fade_in_sec: 0–10/);
  assert.throws(() => musicOf({fade_in_sec: -1}), /fade_in_sec/);
  assert.throws(() => musicOf({volume_db: 6}), /volume/); // louder than the track: not a bed
  assert.deepEqual(musicOf({volume_db: -20, fade_in_sec: 2, fade_out_sec: 3, duck: false}), {volume: dbToGain(-20), startSec: 0, fadeInSec: 2, fadeOutSec: 3, duck: false, duckLevel: 0.25});
});

test('musicGain: without a fade-in it is the old MusicTrack curve; the fade-in ramps 0 → volume and still ducks under speech', () => {
  const fps = 30, total = 300, speech = [[2000, 4000], [6000, 6500]];
  // MusicTrack's callback before fade_in_sec (src/MultiClipVideo.tsx), kept here as the reference
  const old = (music, f) => {
    const fadeFrames = Math.round((music.fadeOutSec ?? 0) * fps);
    let v = fadeFrames > 0 ? interpolate(f, [total - fadeFrames, total], [music.volume, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}) : music.volume;
    if (music.duck && speech.length) {
      const ms = (f / fps) * 1000;
      let dist = Infinity;
      for (const [a, b] of speech) { if (ms >= a && ms <= b) { dist = 0; break; } dist = Math.min(dist, ms < a ? a - ms : ms - b); }
      const k = Math.min(1, dist / 250), duckLevel = music.duckLevel ?? 0.25;
      v *= duckLevel + (1 - duckLevel) * k;
    }
    return v;
  };
  const plain = {src: 'music/x.mp3', volume: 0.3, startSec: 0, fadeOutSec: 1.5, duck: true, duckLevel: 0.2};
  for (const m of [plain, {...plain, duck: false}, {...plain, fadeOutSec: 0}, {...plain, fadeInSec: 0}]) {
    for (let f = 0; f <= total; f += 7) near(musicGain(m, f, fps, total, speech), old(m, f), 1e-12);
  }
  const faded = {...plain, fadeInSec: 2, duck: false};
  assert.equal(musicGain(faded, 0, fps, total, speech), 0);
  near(musicGain(faded, 30, fps, total, speech), 0.15); // half way through the 2 s ramp
  near(musicGain(faded, 60, fps, total, speech), 0.3);
  near(musicGain(faded, 120, fps, total, speech), 0.3);
  // in speech during the fade-in: volume × fade × ducked level — the dip is not lost
  const both = {...faded, duck: true, fadeInSec: 5};
  near(musicGain(both, 90, fps, total, speech), 0.3 * (90 / 150) * 0.2); // 3 s: inside [2, 4] s of speech
  // the fade-out still closes to silence
  assert.equal(musicGain(both, total, fps, total, speech), 0);
});

// rows as GET /api/projects and projectRows give them: {id, identity}
const rows = [
  {id: 'g2a', identity: {client: 'acme', script: 2, variant: {hook: 1}}},
  {id: 'g2b', identity: {client: 'acme', script: 2, variant: {hook: 2}}},
  {id: 'g5', identity: {client: 'acme', script: 5}},
  {id: 'g6', identity: {client: 'acme', script: 6}},
  {id: 'l1', identity: {client: 'acme', script: 7, family: 'launch'}},
  {id: 'l2', identity: {client: 'casa', script: 1, family: 'launch'}}, // a family is free text: another client may use it
  {id: 'loose'},
  {id: 'loose2', identity: null},
];

test('projectTargets: a family or ids, minus except (ids or families); unknown ids and stray excepts are errors', () => {
  assert.deepEqual(projectTargets(rows, {family: 'acme-G2'}), {ids: ['g2a', 'g2b']});
  assert.deepEqual(projectTargets(rows, {family: 'acme-G2'}, ['g2b']), {ids: ['g2a']});
  // "the whole client but G5 and G6": the ids, minus their families
  assert.deepEqual(projectTargets(rows, {project_ids: ['g2a', 'g2b', 'g5', 'g6', 'l1']}, ['acme-G5', 'g6']), {ids: ['g2a', 'g2b', 'l1']});
  assert.deepEqual(projectTargets(rows, {project_ids: ['g5', 'g5']}), {ids: ['g5']});
  assert.deepEqual(projectTargets(rows, {project_ids: ['loose', 'loose2']}), {ids: ['loose', 'loose2']}); // none has an identity: one "client"
  assert.match(projectTargets(rows, {project_ids: ['g5', 'nope']}).error, /no project nope/);
  assert.match(projectTargets(rows, {family: 'acme-G9'}).error, /no project in family acme-G9/);
  assert.match(projectTargets(rows, {family: 'acme-G2'}, ['acme-G5']).error, /except: acme-G5 is none of the targets/); // a typo never widens
  assert.match(projectTargets(rows, {family: 'acme-G2'}, ['acme-G2']).error, /except leaves no project/);
  assert.match(projectTargets(rows, {}).error, /family or project_ids/);
  assert.match(projectTargets(rows, {family: 'acme-G2', project_ids: ['g5']}).error, /family or project_ids, not both/);
  assert.match(projectTargets(rows, {project_ids: []}).error, /^targets: no project$/);
});

test('projectTargets never crosses clients: a shared family, a list of ids, a project without identity', () => {
  const shared = projectTargets(rows, {family: 'launch'});
  assert.deepEqual(shared.ids, []);
  assert.match(shared.error, /targets cross clients \(acme: l1; casa: l2\)/);
  assert.deepEqual(projectTargets(rows, {family: 'launch'}, ['l2']), {ids: ['l1']}); // except leaves one client
  assert.match(projectTargets(rows, {project_ids: ['g5', 'l2']}).error, /cross clients/);
  assert.match(projectTargets(rows, {project_ids: ['g5', 'loose']}).error, /cross clients \(acme: g5; \(no identity\): loose\)/);
});

test('eachTarget: every project written in turn, one failing never stops the others, a line each', async () => {
  const done = [];
  const r = await eachTarget(['a', 'b', 'c'], async (id) => { if (id === 'b') throw new Error('project changed since you read it'); done.push(id); });
  assert.deepEqual(done, ['a', 'c']);
  assert.deepEqual(r, {failed: 1, lines: ['a: ok', 'b: error — project changed since you read it', 'c: ok']});
  assert.deepEqual(await eachTarget([], async () => {}), {failed: 0, lines: []});
});

test('projectRows: {id, identity} of every saved project (unreadable skipped); claimIdentity reads the same rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-music-'));
  try {
    fs.writeFileSync(path.join(dir, 'p1.json'), JSON.stringify({name: 'one', identity: {client: 'acme', script: 2}}));
    fs.writeFileSync(path.join(dir, 'p2.json'), JSON.stringify({name: 'two'}));
    fs.writeFileSync(path.join(dir, 'bad.json'), '{');
    fs.writeFileSync(path.join(dir, 'p1.lock'), 'x');
    const got = projectRows(dir).sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(got, [{id: 'p1', identity: {client: 'acme', script: 2}}, {id: 'p2', identity: undefined}]);
    assert.deepEqual(projectTargets(got, {family: 'acme-G2'}), {ids: ['p1']});
    assert.match(claimIdentity(dir, 'p2', {client: 'acme', script: 2}).error, /already project p1/);
    assert.equal(claimIdentity(dir, 'p1', {client: 'acme', script: 2}).error, undefined); // its own row does not count
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('editor parity: Settings takes the level, the targets and the per-project result from the shared functions', () => {
  const src = fs.readFileSync(new URL('../editor/SettingsTab.tsx', import.meta.url), 'utf8');
  const mcp = fs.readFileSync(new URL('../mcp/server.mjs', import.meta.url), 'utf8');
  for (const [file, text, re] of [
    ['SettingsTab', src, /import \{[^}]*\bdbToGain\b[^}]*\bfmtDb\b[^}]*\bgainToDb\b[^}]*\bmusicOf\b[^}]*\} from '\.\.\/src\/audio'/],
    ['SettingsTab', src, /import \{[^}]*\beachTarget\b[^}]*\bprojectTargets\b[^}]*\} from '\.\.\/src\/validate'/],
    ['SettingsTab', src, /projectTargets\(.*\{family\}/],
    ['SettingsTab', src, /eachTarget\(others/],
    ['mcp/server', mcp, /projectTargets\(projectRows\(PROJECTS\), targets, except\)/],
    ['mcp/server', mcp, /eachTarget\(picked\.ids/],
    ['mcp/server', mcp, /musicOf\(\{volume, volume_db, fade_in_sec, fade_out_sec, duck\}\)/],
    // an uploaded track is the same bed as set_music file (it used to be 0.8, ≈ −1.9 dB, no ducking)
    ['AssetsSidebar', fs.readFileSync(new URL('../editor/AssetsSidebar.tsx', import.meta.url), 'utf8'), /setMusic\(\{src: r\.src, \.\.\.musicOf\(\{\}\)\}\)/],
    // musicGain takes the reel's frame: Remotion's default ('repeat') restarts the volume curve on every pass of a
    // looping track — silence and a new fade-in at each seam, no fade-out, ducking on the wrong words
    ['MultiClipVideo', fs.readFileSync(new URL('../src/MultiClipVideo.tsx', import.meta.url), 'utf8'), /<Audio[^>]*\bloop\b[^>]*loopVolumeCurveBehavior="extend"[^>]*volume=\{\(f\) => musicGain\(/],
  ]) assert.ok(re.test(text), `${file} does not use ${re}`);
});

test('set_music takes no argument it does not know: an except nested in targets (or misspelled) is an error, never dropped into a family-wide write', async () => {
  const {Client} = await import('@modelcontextprotocol/sdk/client/index.js');
  const {StdioClientTransport} = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({name: 'test', version: '0'});
  // no project_id and refused by the schema before the handler: nothing is read, locked or written (a family no
  // project has: were the schema to let it through, the handler stops at "no project in family", still no write)
  await client.connect(new StdioClientTransport({command: 'node', args: ['mcp/server.mjs'], cwd: process.cwd(), env: {...process.env, REEL_API: 'http://127.0.0.1:9', REEL_AGENT: 'music-test'}}));
  try {
    for (const args of [{targets: {family: 'none-G999', except: ['g5']}, file: null}, {targets: {family: 'none-G999'}, exclude: ['g5'], file: null}]) {
      const r = await client.callTool({name: 'set_music', arguments: args});
      const said = r.content.map((c) => c.text ?? '').join('\n');
      assert.ok(r.isError && /unrecognized/i.test(said) && !/no project in family/.test(said), `${JSON.stringify(args)} → ${said}`);
    }
  } finally { await client.close(); }
});
