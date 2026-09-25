// A small caption correction on a reel that was already rendered: the edit goes through the
// real MCP server, the re-render through the real render runner (mode choice, master key and
// cache are the real ones; only Remotion, ffmpeg and QC are stand-ins). A correction must
// land whole and must cost the caption layer only — never the master.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {pageWords} from '../src/paging.ts';
import {projectCaptions} from '../src/captions.ts';
import {PRESETS} from '../src/captionPresets.ts';
import {projectRenderProps} from '../src/renderProps.ts';
import {createRenderRunner} from '../scripts/render-runner.mjs';
import {createMasterCache} from '../scripts/layers.mjs';

// "Hola soy Ana, | hoy te enseño la casa | en Playa del Carmen. | Tiene tres recámaras y alberca. | Llámame hoy."
const SAID = 'Hola soy Ana, hoy te enseño la casa en Playa del Carmen. Tiene tres recámaras y alberca. Llámame hoy.'.split(' ');
const SRC = 'clips/t.mp4';
function reel({duck = true} = {}) {
  let t = 200;
  const words = SAID.map((w, i) => { const s = t; t += 180 + (w.endsWith('.') ? 400 : 60); return {wid: `t:${i}`, word: w, src: SRC, clipId: 'k0', startMs: s, endMs: s + 170, srcStartMs: s, srcEndMs: s + 170}; });
  return {name: 'caption correction', clips: [{id: 'k0', src: SRC, inSec: 0, outSec: 6, sourceDurationSec: 6}], captions: pageWords(words, PRESETS.vibem), brolls: [], graphics: [], mattes: [],
    music: {src: 'music/m.mp3', volume: 0.25, startSec: 0, fadeOutSec: 1.5, duck, duckLevel: 0.25}, captionStyle: 'vibem', lang: 'es'};
}
const textOf = (c) => c.words.map((w) => w.text).join(' ');

// the project in public/projects/ (where the MCP server reads it), the server on stdio, no backend
async function withProject(fn, project = reel()) {
  const id = `p-captest-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join('public', 'projects', `${id}.json`);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(project));
  const client = new Client({name: 'test', version: '0'});
  await client.connect(new StdioClientTransport({command: 'node', args: ['mcp/server.mjs'], cwd: process.cwd(), env: {...process.env, REEL_API: 'http://127.0.0.1:9', REEL_AGENT: 'caption-test'}}));
  const call = async (name, args) => { const r = await client.callTool({name, arguments: {project_id: id, ...args}}); return {err: !!r.isError, text: r.content.map((c) => c.text ?? '').join('\n')}; };
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  try { await fn(call, read); } finally {
    await client.close();
    for (const ext of ['.json', '.lock', '.timing.jsonl']) fs.rmSync(file.replace(/\.json$/, ext), {force: true});
  }
}

// the render runner over a throwaway root: every pass just writes its output
function renderer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-fix-'));
  const pub = path.join(root, 'public');
  fs.mkdirSync(path.join(pub, 'exports'), {recursive: true});
  const calls = {render: 0, master: 0, captions: 0, composite: 0};
  const write = (kind) => ({outFile}) => { if (kind) calls[kind]++; return [process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], "x")', outFile]]; };
  const run = createRenderRunner({
    root, publicDir: pub, masterCache: createMasterCache(path.join(root, 'masters')), log: () => {}, record: async () => null,
    commands: {
      render: write('render'), master: write('master'), captions: write('captions'), composite: write('composite'),
      finalize: () => [process.execPath, ['-e', 'console.log(JSON.stringify({ok: true, checks: [], text: "qc ok"}))']],
      frameStats: () => [process.execPath, ['-e', '']],
    },
  });
  let n = 0;
  const render = (p) => run({id: `${Date.now()}${n++}`, draft: false, mode: 'layers', projectId: null, expectSec: 6}, {signal: new AbortController().signal, props: JSON.stringify(projectRenderProps(p)), update() {}, setPid() {}});
  return {render, calls, done: () => fs.rmSync(root, {recursive: true, force: true})};
}

test('rendered reel, one word changed → the re-render redoes the caption layer only', async () => {
  const R = renderer();
  await withProject(async (call, read) => {
    assert.equal((await R.render(read())).master, 'rendered');
    const r = await call('edit_caption', {caption_id: 'c3', text: 'Tiene TRES recámaras y alberca'});
    assert.ok(!r.err, r.text);
    const again = await R.render(read());
    assert.deepEqual([again.mode, again.master], ['layers', 'cached']);
    assert.deepEqual(R.calls, {render: 0, master: 1, captions: 2, composite: 2});
  });
  R.done();
});

// The music ducks under the caption pages (src/layers.ts), so with ducked music a moved break or a
// nudged page changes the master: the tests that keep the master use music that does not duck.
test('rendered reel, a page break moved → both pages land, each word once, on its own time; the master is kept', async () => {
  const R = renderer();
  await withProject(async (call, read) => {
    await R.render(read());
    const before = read().captions;
    // "en" goes from c2 to the end of c1, in one call, by word id
    const r = await call('edit_caption', {caption_id: 'c2', starts_at_wid: 't:9'});
    assert.ok(!r.err, r.text);
    const [c1, c2] = read().captions.slice(1, 3);
    assert.deepEqual([textOf(c1), textOf(c2)], ['hoy te enseño la casa en', 'Playa del Carmen']);
    const en = before[2].words[0];
    assert.deepEqual(c1.words.at(-1), en, '"en" keeps its id and the time it is said');
    assert.deepEqual([c1.endMs, c2.startMs], [en.endMs, before[2].words[1].startMs], 'each page spans its own words');
    // and back: c2 takes "en" again
    assert.ok(!(await call('edit_caption', {caption_id: 'c2', starts_at_wid: 't:8'})).err);
    assert.deepEqual(read().captions.slice(1, 3).map(textOf), ['hoy te enseño la casa', 'en Playa del Carmen']);
    assert.match((await call('edit_caption', {caption_id: 'c2', starts_at_wid: 't:0'})).text, /not in c2 or the page before it/);
    await call('edit_caption', {caption_id: 'c2', starts_at_wid: 't:9'});
    assert.equal((await R.render(read())).master, 'cached');
    assert.equal(R.calls.master, 1);
  }, reel({duck: false}));
  R.done();
});

test('with ducked music a moved break re-renders the master: the dip follows the pages', async () => {
  const R = renderer();
  await withProject(async (call, read) => {
    await R.render(read());
    assert.ok(!(await call('edit_caption', {caption_id: 'c2', starts_at_wid: 't:9'})).err);
    const again = await R.render(read());
    assert.deepEqual([again.mode, again.master, R.calls.master], ['layers', 'rendered', 2]);
  });
  R.done();
});

test('the same move as two edits in one turn (parallel calls): neither is lost', async () => {
  await withProject(async (call, read) => {
    const r = await Promise.all([call('edit_caption', {caption_id: 'c1', text: 'hoy te enseño la casa en'}), call('edit_caption', {caption_id: 'c2', text: 'Playa del Carmen'})]);
    assert.ok(r.every((x) => !x.err), r.map((x) => x.text).join(' | '));
    assert.deepEqual(read().captions.slice(1, 3).map(textOf), ['hoy te enseño la casa en', 'Playa del Carmen']);
  });
});

test('a page nudged in time keeps the master; a timing the tool does not take is an error, never a silent no-op', async () => {
  const R = renderer();
  await withProject(async (call, read) => {
    await R.render(read());
    const shown = (p) => projectCaptions(p.captions, p.clips, 30).find((c) => c.id === 'c4');
    const [said, was] = [read().captions[4].words, shown(read())];
    // the last page: the nudge moves the text, not the voice
    assert.ok(!(await call('edit_caption', {caption_id: 'c4', shift_ms: -150})).err);
    const now = shown(read());
    assert.deepEqual([now.startMs, now.endMs, now.words[0].startMs], [was.startMs - 150, was.endMs - 150, was.words[0].startMs - 150]);
    assert.deepEqual(read().captions[4].words, said, 'the words keep the time they are said');
    assert.equal((await R.render(read())).master, 'cached');
    const bad = await call('edit_caption', {caption_id: 'c1', start_sec: 2.4});
    assert.ok(bad.err && /start_sec/.test(bad.text), bad.text);
  }, reel({duck: false}));
  R.done();
});

test('ids stay put: adding a page never renames the others', async () => {
  await withProject(async (call, read) => {
    await call('delete_captions', {caption_ids: ['c1']});
    const r = await call('add_caption', {at_sec: 0.9, duration_sec: 1.1, text: 'hoy te muestro la casa'});
    assert.match(r.text, /\(id c5\)/);
    const byId = Object.fromEntries(read().captions.map((c) => [c.id, textOf(c)]));
    assert.equal(byId.c4, 'Llámame hoy', 'c4 is still the page it was');
    assert.equal(byId.c5, 'hoy te muestro la casa');
    assert.match((await call('edit_caption', {caption_id: 'c1', text: 'x'})).text, /no caption c1/);
  });
});

// The editor polls the project while the agent saves: a save written in place was read half-way
// (89 of ~7000 reads failed). Backend down, so the MCP server writes the file itself; this process
// reads it in a loop meanwhile. A big project makes an in-place write take long enough to be seen.
test('a project read while the agent saves it is never half a file', async () => {
  const big = {...reel(), notes: 'x'.repeat(4e6)};
  await withProject(async (call, read) => {
    let reads = 0, torn = 0, saving = true;
    const saves = (async () => {
      for (let n = 0; n < 12; n++) assert.ok(!(await call('edit_caption', {caption_id: 'c4', text: `Llámame ${n % 2 ? 'hoy' : 'ya'}`})).err);
      saving = false;
    })();
    while (saving) {
      try { read(); reads++; } catch { torn++; }
      await new Promise((r) => setImmediate(r));
    }
    await saves;
    assert.equal(torn, 0, `${torn} of ${reads + torn} reads got half a project`);
    assert.ok(reads > 0);
    assert.equal(textOf(read().captions[4]), 'Llámame hoy');
    assert.equal(read().notes.length, 4e6);
  }, big);
});
