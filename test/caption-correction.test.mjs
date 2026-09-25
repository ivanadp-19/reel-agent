// A small caption correction on a reel that was already rendered: the edit goes through the
// real MCP server, the re-render through the real render runner (mode choice, master key and
// cache are the real ones; only Remotion, ffmpeg and QC are stand-ins). A correction must
// land whole and must cost the caption layer only — never the master.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
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
// SAID as the pager takes it, word ids "<source>:<i>"
const said = (src = SRC) => { let t = 200; return SAID.map((w, i) => { const s = t; t += 180 + (w.endsWith('.') ? 400 : 60); return {wid: `${path.basename(src, '.mp4')}:${i}`, word: w, src, clipId: 'k0', startMs: s, endMs: s + 170, srcStartMs: s, srcEndMs: s + 170}; }); };
function reel() {
  return {name: 'caption correction', clips: [{id: 'k0', src: SRC, inSec: 0, outSec: 6, sourceDurationSec: 6}], captions: pageWords(said(), PRESETS.vibem), brolls: [], graphics: [], mattes: [],
    music: {src: 'music/m.mp3', volume: 0.25, startSec: 0, fadeOutSec: 1.5, duck: true, duckLevel: 0.25}, captionStyle: 'vibem', lang: 'es'};
}
const textOf = (c) => c.words.map((w) => w.text).join(' ');

// the project in public/projects/ (where the MCP server reads it), the server on stdio, no backend (or `api`)
async function withProject(fn, api = 'http://127.0.0.1:9', project = reel(), id = `p-captest-${process.pid}-${Math.random().toString(36).slice(2, 8)}`) {
  const file = path.join('public', 'projects', `${id}.json`);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(project));
  const client = new Client({name: 'test', version: '0'});
  await client.connect(new StdioClientTransport({command: 'node', args: ['mcp/server.mjs'], cwd: process.cwd(), env: {...process.env, REEL_API: api, REEL_AGENT: 'caption-test'}}));
  const call = async (name, args) => { const r = await client.callTool({name, arguments: {project_id: id, ...args}}); return {err: !!r.isError, text: r.content.map((c) => c.text ?? '').join('\n')}; };
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  try { await fn(call, read, id); } finally {
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
    // ducked music: the speech it ducks under is the words, not how they are paged
    assert.equal((await R.render(read())).master, 'cached');
    assert.equal(R.calls.master, 1);
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
    // the last page: where the voice (and the music's dip) ends — the nudge moves the text, not the voice
    assert.ok(!(await call('edit_caption', {caption_id: 'c4', shift_ms: -150})).err);
    const now = shown(read());
    assert.deepEqual([now.startMs, now.endMs, now.words[0].startMs], [was.startMs - 150, was.endMs - 150, was.words[0].startMs - 150]);
    assert.deepEqual(read().captions[4].words, said, 'the words keep the time they are said');
    assert.equal((await R.render(read())).master, 'cached');
    const bad = await call('edit_caption', {caption_id: 'c1', start_sec: 2.4});
    assert.ok(bad.err && /start_sec/.test(bad.text), bad.text);
  });
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

// a backend whose jobs are done at once and hand back `result` (null: a backend from before job results);
// results = {'/api/captions': …, '/api/transcribe': …}, or one result for the captions job
async function fakeBackend(results) {
  const byRoute = results && !Array.isArray(results) ? results : {'/api/captions': results};
  const srv = http.createServer((req, res) => {
    const send = (code, o) => { res.writeHead(code, {'Content-Type': 'application/json'}); res.end(JSON.stringify(o)); };
    if (req.url === '/api/projects') return send(200, []);
    if (req.method === 'POST' && req.url in byRoute) return send(200, {jobId: 'j1'});
    const route = req.url.replace(/\/j1$/, '');
    if (route in byRoute) return send(200, {status: 'done', progress: 100, ...(byRoute[route] ? {result: byRoute[route]} : {})});
    send(404, {error: 'not found'}); // a project save falls back to the file
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections(); srv.close(); }};
}

test('re-paging takes the pages its own job made (never a file every job writes); none → a clear error, nothing lost', async () => {
  const caja = pageWords(said(), PRESETS.caja);
  const [B, old] = [await fakeBackend(caja), await fakeBackend(null)];
  try {
    await withProject(async (call, read) => {
      const r = await call('set_caption_style', {style: 'caja'});
      assert.ok(!r.err, r.text);
      assert.deepEqual(read().captions.map(textOf), caja.map(textOf));
      assert.ok(read().captions.every((c) => +c.id.slice(1) >= 5), 'the re-paged pages get new ids');
    }, B.url);
    await withProject(async (call, read) => {
      const before = read();
      const r = await call('set_caption_style', {style: 'caja'});
      assert.ok(r.err && /without its result — restart the backend/.test(r.text), r.text);
      assert.deepEqual(read(), before, 'no page lost to an empty re-page');
    }, old.url);
  } finally { B.close(); old.close(); }
});

test('two caption jobs at once (two projects): each one gets its own pages', async () => {
  const transcripts = path.join('public', 'clips', 'transcripts');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-jobs-'));
  fs.mkdirSync(transcripts, {recursive: true});
  // a source that said the first n words of SAID (a cached transcript: no WhisperX), paged by the real job
  const job = (name, n) => {
    const src = `clips/${name}.mp4`;
    fs.writeFileSync(path.join(transcripts, `${name}.es.json`), JSON.stringify(said(src).slice(0, n).map(({word, startMs, endMs}) => ({word, startMs, endMs}))));
    const [inFile, out] = [path.join(tmp, `${name}.in.json`), path.join(tmp, `${name}.out.json`)];
    fs.writeFileSync(inFile, JSON.stringify({clips: [{id: 'k0', src, inSec: 0, outSec: 6, sourceDurationSec: 6}], lang: 'es', style: 'vibem'}));
    const child = spawn(process.execPath, ['scripts/captions-multiclip.mjs', inFile, out], {env: {...process.env, REEL_FACE_AWARE: '0', OPENAI_API_KEY: '', HF_TOKEN: ''}, stdio: 'ignore'});
    return new Promise((resolve) => child.on('close', (code) => resolve({code, out, src, n})));
  };
  const names = [`cj-a-${process.pid}`, `cj-b-${process.pid}`];
  try {
    for (const r of await Promise.all([job(names[0], 12), job(names[1], 19)])) {
      assert.equal(r.code, 0);
      const pages = JSON.parse(fs.readFileSync(r.out, 'utf8'));
      assert.ok(pages.length && pages.every((c) => c.src === r.src), `${r.src}: only its own pages`);
      assert.equal(pages.flatMap((c) => c.words).length, r.n);
    }
  } finally {
    for (const n of names) fs.rmSync(path.join(transcripts, `${n}.es.json`), {force: true});
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

// ---- transcripts: the words a job just made, and each project's own last run ----
const said0 = (src) => said(src).map(({word, startMs, endMs}) => ({word, startMs, endMs})); // a transcript cache entry

test('get_transcript shows the words its own job made (never the file every job wrote)', async () => {
  const tr = [{clipId: 'k0', source: 't', words: ['Solo', 'mío', 'Zacatecas'].map((word, i) => ({i, word, startMs: 200 + i * 300, endMs: 400 + i * 300}))}];
  const B = await fakeBackend({'/api/transcribe': tr});
  try {
    await withProject(async (call) => {
      const r = await call('get_transcript', {});
      assert.ok(!r.err, r.text);
      assert.match(r.text, /0:Solo 1:mío 2:Zacatecas/);
    }, B.url);
  } finally { B.close(); }
});

test('two projects transcribed one after the other: each reads its own last run (set_plan checks word ids against it)', async () => {
  const transcripts = path.join('public', 'clips', 'transcripts');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-jobs-'));
  fs.mkdirSync(transcripts, {recursive: true});
  const [a, b] = [`tra-${process.pid}`, `trb-${process.pid}`];
  const ids = [`p-trtest-a-${process.pid}`, `p-trtest-b-${process.pid}`];
  const project = (name) => ({...reel(), clips: [{id: 'k0', src: `clips/${name}.mp4`, inSec: 0, outSec: 6, sourceDurationSec: 6}], captions: []});
  // the real transcribe job on a cached source (no WhisperX), as the backend runs it for a project
  const transcribe = (name, id) => {
    fs.writeFileSync(path.join(transcripts, `${name}.es.json`), JSON.stringify(said0(`clips/${name}.mp4`)));
    const inFile = path.join(tmp, `${name}.in.json`);
    fs.writeFileSync(inFile, JSON.stringify({clips: project(name).clips, lang: 'es', project_id: id}));
    const child = spawn(process.execPath, ['scripts/transcribe.mjs', inFile, path.join(tmp, `${name}.out.json`)], {env: {...process.env, HF_TOKEN: ''}, stdio: 'ignore'});
    return new Promise((resolve) => child.on('close', resolve));
  };
  try {
    assert.equal(await transcribe(a, ids[0]), 0);
    assert.equal(await transcribe(b, ids[1]), 0); // b ran last
    const plan = `Hook on ${a}:2 (Ana), close on ${a}:17. And ${b}:9 from the other reel.`;
    await withProject(async (call) => {
      const r = await call('set_plan', {plan});
      assert.match(r.text, new RegExp(`NOT in the transcript, fix them: ${b}:9\\)`), r.text);
      assert.match(r.text, new RegExp(`${a}:2 "Ana,"`), 'the words of its own transcript are quoted');
    }, undefined, project(a), ids[0]);
  } finally {
    for (const n of [a, b]) fs.rmSync(path.join(transcripts, `${n}.es.json`), {force: true});
    for (const id of ids) fs.rmSync(path.join('public', 'projects', 'transcripts', `${id}.json`), {force: true});
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});
