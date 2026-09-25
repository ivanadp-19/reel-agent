import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {blackRanges, buildCatalog, catalogDir, daylight, frameStats, loadCatalog, loadEntries, motion, searchCatalog, silenceRanges, staleFiles, tagsFor} from '../scripts/catalog.mjs';

// ---------- pure analysis ----------

const frame = (fn, n = 32) => { const b = Buffer.alloc(n * n * 3); for (let i = 0; i < n * n; i++) b.set(fn(i % n, Math.floor(i / n)), i * 3); return b; };

test('frameStats: black, sky-topped day frame, dark frame with lit windows', () => {
  const black = frameStats(frame(() => [3, 3, 3]));
  assert.equal(black.black, true);
  const day = frameStats(frame((x, y) => (y < 14 ? [140, 185, 235] : [110, 90, 70])));
  assert.equal(day.black, false); assert.equal(day.sky, true);
  // 90 % dark but lamps in 10 % of the frame: night, not black
  const night = frameStats(frame((x, y) => (y < 3 ? [255, 220, 150] : [12, 12, 20])));
  assert.equal(night.black, false); assert.equal(night.sky, false);
  assert.ok(night.mean < 0.2);
});

test('blackRanges: runs of ≥ 0.4 s, sample k covers [k/fps, (k+1)/fps), clipped to the duration', () => {
  const f = [1, 1, 1, 1, 0, 0, 1, 0, 0, 1, 1, 1].map(Boolean);
  // 4 samples/s: 0–1 s black, a lone black sample (0.25 s) is dropped, the tail runs to the real end
  assert.deepEqual(blackRanges(f, 4, 2.9), [{startSec: 0, endSec: 1}, {startSec: 2.25, endSec: 2.9}]);
  assert.deepEqual(blackRanges([], 4, 0), []);
});

test('daylight / motion heuristics', () => {
  const lit = (mean, sky = false, luma = new Float32Array(4).fill(mean * 255)) => ({mean, black: false, sky, luma});
  assert.equal(daylight([lit(0.6), lit(0.55)]).label, 'day');
  assert.equal(daylight([lit(0.3, true), lit(0.3, true)]).label, 'day'); // dim but sky seen
  assert.equal(daylight([lit(0.1), lit(0.12)]).label, 'night');
  assert.equal(daylight([lit(0.3)]).label, 'uncertain');
  assert.equal(daylight([{mean: 0, black: true, sky: false, luma: new Float32Array(4)}]).label, 'unknown');
  assert.equal(motion([lit(0.5), lit(0.5)]).label, 'static');
  assert.equal(motion([lit(0.2), lit(0.6)]).label, 'moving');
});

test('silenceRanges parses silencedetect, an open silence runs to the end', () => {
  const err = '[silencedetect @ 0x1] silence_start: 0\n[silencedetect @ 0x1] silence_end: 1.5 | silence_duration: 1.5\n[silencedetect @ 0x1] silence_start: 4.2\n';
  assert.deepEqual(silenceRanges(err, 6), [{startSec: 0, endSec: 1.5}, {startSec: 4.2, endSec: 6}]);
});

test('tags: a voice over black is audio-over-black; a silent black hold is not', () => {
  const base = {kind: 'video', durationSec: 10, hasAudio: true, orientation: 'portrait', black: {spans: [{startSec: 0, endSec: 6}], totalSec: 6, ratio: 0.6}, daylight: {label: 'night', skyRatio: 0}, motion: {label: 'static'}};
  const voiced = tagsFor({...base, silence: {spans: [], totalSec: 0}});
  for (const t of ['has-black', 'mostly-black', 'starts-black', 'audio-over-black', 'night', 'static', 'portrait']) assert.ok(voiced.includes(t), t);
  assert.ok(!tagsFor({...base, silence: {spans: [{startSec: 0, endSec: 6}], totalSec: 6}}).includes('audio-over-black'));
});

test('searchCatalog filters on content and never on the file name', () => {
  const entries = [
    {src: 'clips/skybar_night.mp4', dir: 'clips', kind: 'video', durationSec: 1.5, daylight: {label: 'day'}, tags: ['day', 'short'], desc: '1.5 s portrait video · day (heuristic)'},
    {src: 'clips/hook.mp4', dir: 'clips', kind: 'video', durationSec: 40, daylight: {label: 'night'}, black: {spans: [{startSec: 0, endSec: 33}], ratio: 0.82}, tags: ['has-black', 'night'], desc: '40 s · black 0–33 s', speech: {words: 80, text: 'bienvenidos a la terraza'}},
  ];
  assert.deepEqual(searchCatalog(entries, {daylight: 'night'}).map((e) => e.src), ['clips/hook.mp4']);
  assert.deepEqual(searchCatalog(entries, {text: 'skybar'}), []); // the name is not content
  assert.deepEqual(searchCatalog(entries, {text: 'terraza'}).map((e) => e.src), ['clips/hook.mp4']);
  assert.deepEqual(searchCatalog(entries, {maxBlackRatio: 0.1}).map((e) => e.src), ['clips/skybar_night.mp4']);
  assert.deepEqual(searchCatalog(entries, {minSec: 2, hasSpeech: true}).map((e) => e.src), ['clips/hook.mp4']);
  assert.deepEqual(searchCatalog(entries, {tags: ['day', 'short']}).map((e) => e.src), ['clips/skybar_night.mp4']);
});

// ---------- extraction on synthetic clips (ffmpeg lavfi) ----------

const ffmpeg = (...args) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args]); assert.equal(r.status, 0, String(r.stderr)); };
const X264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
function fixtures() {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-catalog-'));
  const d = path.join(pub, 'inputs'); fs.mkdirSync(d);
  // a hook: 3 s of black under a voice (tone), then 2 s of moving picture
  ffmpeg('-f', 'lavfi', '-i', 'color=c=black:s=360x640:r=30:d=3', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=2', '-f', 'lavfi', '-i', 'sine=f=300:d=5:sample_rate=48000', '-filter_complex', '[0][1]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2', ...X264, '-c:a', 'aac', '-shortest', path.join(d, 'hook_G2.mp4'));
  // named "night", shot by day: blue sky over a terrace
  ffmpeg('-f', 'lavfi', '-i', 'color=c=0x87B8E8:s=360x640:r=30:d=1.5,drawbox=y=320:w=360:h=320:c=0x6B5A45:t=fill', ...X264, path.join(d, 'G3v2_skybar_night.mp4'));
  // named "day", a dark street with two lit windows
  ffmpeg('-f', 'lavfi', '-i', 'color=c=0x0A0A12:s=360x640:r=30:d=2,drawbox=x=40:y=100:w=60:h=60:c=0xFFE9A0:t=fill,drawbox=x=200:y=300:w=80:h=50:c=0xFFD070:t=fill', ...X264, path.join(d, 'street_day.mp4'));
  ffmpeg('-f', 'lavfi', '-i', 'sine=f=200:d=2', path.join(d, 'voice.mp3'));
  ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=640x360', '-frames:v', '1', path.join(d, 'photo.png'));
  fs.writeFileSync(path.join(d, 'notes.txt'), 'not media');
  return pub;
}

test('catalog: measures black, day/night by content, audio-only, stills, contact sheets', async () => {
  const pub = fixtures();
  try {
    const [s] = await buildCatalog(pub, ['inputs']);
    assert.equal(s.files, 5); assert.equal(s.analyzed.length, 5); assert.deepEqual(s.errors, []);
    const cat = loadCatalog(pub, 'inputs');
    assert.match(cat.legend.heuristic, /daylight/);
    const f = cat.files;

    const hook = f['hook_G2.mp4'];
    assert.equal(hook.kind, 'video'); assert.equal(hook.width, 360); assert.equal(hook.height, 640); assert.equal(hook.fps, 30); assert.equal(hook.orientation, 'portrait');
    assert.ok(Math.abs(hook.durationSec - 5) < 0.1);
    assert.equal(hook.black.spans.length, 1);
    assert.equal(hook.black.spans[0].startSec, 0);
    assert.ok(Math.abs(hook.black.spans[0].endSec - 3) <= 0.25, JSON.stringify(hook.black));
    for (const t of ['has-black', 'mostly-black', 'starts-black', 'audio-over-black']) assert.ok(hook.tags.includes(t), t);
    assert.match(hook.desc, /black 0–3 s/);

    assert.equal(f['G3v2_skybar_night.mp4'].daylight.label, 'day');
    assert.ok(f['G3v2_skybar_night.mp4'].tags.includes('sky'));
    assert.equal(f['G3v2_skybar_night.mp4'].black.spans.length, 0);
    assert.equal(f['street_day.mp4'].daylight.label, 'night');
    assert.match(f['street_day.mp4'].desc, /night \(heuristic\)/);
    assert.equal(f['street_day.mp4'].descSource, 'heuristic');

    assert.equal(f['voice.mp3'].kind, 'audio'); assert.deepEqual(f['voice.mp3'].tags, ['audio-only']);
    assert.equal(f['voice.mp3'].sheet, undefined);
    assert.equal(f['photo.png'].kind, 'image'); assert.ok(f['photo.png'].tags.includes('still-image'));

    // contact sheets exist, frames at the middle of each sixth
    assert.ok(fs.existsSync(path.join(pub, hook.sheet.file)));
    assert.deepEqual(hook.sheet.times, [0.42, 1.25, 2.08, 2.92, 3.75, 4.58]);
    assert.ok(fs.existsSync(path.join(pub, f['photo.png'].sheet.file)));

    // by content: "night" finds the street, not the file named night
    const all = loadEntries(pub);
    assert.deepEqual(searchCatalog(all, {daylight: 'night'}).map((e) => e.src), ['inputs/street_day.mp4']);
    assert.deepEqual(searchCatalog(all, {hasBlack: true}).map((e) => e.src), ['inputs/hook_G2.mp4']);
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

test('catalog is incremental: only new or changed files are decoded; gone files and their sheets are dropped', async () => {
  const pub = fixtures();
  const d = path.join(pub, 'inputs');
  try {
    await catalogDir(pub, 'inputs');
    const first = loadCatalog(pub, 'inputs').files;
    const again = await catalogDir(pub, 'inputs');
    assert.deepEqual(again.analyzed, []); assert.equal(again.reused, 5);
    assert.equal(loadCatalog(pub, 'inputs').files['hook_G2.mp4'].analyzedAt, first['hook_G2.mp4'].analyzedAt);

    // mtime changed → only that file; a new file → decoded too
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(d, 'photo.png'), later, later);
    fs.copyFileSync(path.join(d, 'street_day.mp4'), path.join(d, 'street2.mp4'));
    assert.deepEqual(staleFiles(pub, 'inputs').sort(), ['photo.png', 'street2.mp4']);
    const changed = await catalogDir(pub, 'inputs');
    assert.deepEqual(changed.analyzed.sort(), ['photo.png', 'street2.mp4']);
    assert.deepEqual(staleFiles(pub, 'inputs'), []);

    // limit: the rest waits for the next call
    fs.utimesSync(path.join(d, 'voice.mp3'), later, new Date(Date.now() + 9000));
    fs.utimesSync(path.join(d, 'street2.mp4'), later, new Date(Date.now() + 9000));
    const capped = await catalogDir(pub, 'inputs', {limit: 1});
    assert.equal(capped.analyzed.length, 1); assert.equal(capped.pending, 1);
    assert.equal((await catalogDir(pub, 'inputs')).analyzed.length, 1);

    // removed file → out of the catalog with its contact sheet
    const sheet = path.join(pub, loadCatalog(pub, 'inputs').files['street2.mp4'].sheet.file);
    assert.ok(fs.existsSync(sheet));
    fs.rmSync(path.join(d, 'street2.mp4'));
    const gone = await catalogDir(pub, 'inputs');
    assert.deepEqual(gone.removed, ['street2.mp4']); assert.deepEqual(gone.analyzed, []);
    assert.ok(!fs.existsSync(sheet));
    assert.equal(loadCatalog(pub, 'inputs').files['street2.mp4'], undefined);

    // a transcript or library tags written later show up without decoding again
    const tr = path.join(pub, 'clips', 'transcripts'); fs.mkdirSync(tr, {recursive: true});
    fs.writeFileSync(path.join(tr, 'hook_G2.es.json'), JSON.stringify([{word: 'Bienvenidos', startMs: 0, endMs: 400}, {word: 'al', startMs: 400, endMs: 500}, {word: 'rooftop', startMs: 500, endMs: 900}]));
    fs.writeFileSync(path.join(tr, 'hook_G2.loud.json'), '[]');
    fs.writeFileSync(path.join(d, 'library.json'), JSON.stringify([{id: 'x', src: 'inputs/street_day.mp4', tags: ['calle', 'ventanas'], desc: 'calle de noche'}]));
    const meta = await catalogDir(pub, 'inputs');
    assert.deepEqual(meta.analyzed, []);
    const f = loadCatalog(pub, 'inputs').files;
    assert.equal(f['hook_G2.mp4'].descSource, 'transcript');
    assert.equal(f['hook_G2.mp4'].speech.words, 3); assert.equal(f['hook_G2.mp4'].speech.lang, 'es');
    assert.ok(f['hook_G2.mp4'].tags.includes('speech'));
    assert.match(f['hook_G2.mp4'].desc, /speech: "Bienvenidos al rooftop"/);
    assert.equal(f['street_day.mp4'].descSource, 'metadata');
    assert.deepEqual(f['street_day.mp4'].meta.tags, ['calle', 'ventanas']);
    assert.deepEqual(searchCatalog(loadEntries(pub), {text: 'rooftop'}).map((e) => e.src), ['inputs/hook_G2.mp4']);

    // --force decodes everything again
    assert.equal((await catalogDir(pub, 'inputs', {force: true})).analyzed.length, 5);
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

test('catalog refuses folders outside public/', async () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-catalog-'));
  try {
    for (const bad of ['..', '../etc', '/etc', 'catalog', '']) await assert.rejects(catalogDir(pub, bad), /not a media folder/, bad);
  } finally { fs.rmSync(pub, {recursive: true, force: true}); }
});

// ---------- MCP ----------

test('MCP: catalog_assets builds the catalog on request, search_catalog queries it by content', async () => {
  const pub = fixtures();
  const client = new Client({name: 'test', version: '0'});
  await client.connect(new StdioClientTransport({command: 'node', args: ['mcp/server.mjs'], cwd: process.cwd(), env: {...process.env, REEL_CATALOG_PUBLIC: pub, REEL_API: 'http://127.0.0.1:9'}}));
  const call = async (name, args) => { const r = await client.callTool({name, arguments: args}); assert.ok(!r.isError, JSON.stringify(r.content)); return r; };
  const txt = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  try {
    // nothing is analyzed until asked
    assert.equal(fs.existsSync(path.join(pub, 'catalog')), false);
    assert.match(txt(await call('search_catalog', {})), /No catalog yet — run catalog_assets/);

    const built = txt(await call('catalog_assets', {dirs: ['inputs', 'broll']}));
    assert.match(built, /inputs: 5 file\(s\) — 5 analyzed, 0 unchanged/);
    assert.match(built, /broll: no such folder/);
    assert.match(txt(await call('catalog_assets', {dirs: ['inputs']})), /0 analyzed, 5 unchanged/);

    const night = txt(await call('search_catalog', {daylight: 'night'}));
    assert.match(night, /inputs\/street_day\.mp4/);
    assert.doesNotMatch(night, /skybar/);
    assert.match(night, /night \(heuristic\)/);

    const black = await call('search_catalog', {tags: ['audio-over-black'], sheets: true});
    assert.match(txt(black), /inputs\/hook_G2\.mp4 — .*black 0–3 s/);
    assert.equal(black.content.filter((c) => c.type === 'image').length, 1);

    const one = txt(await call('search_catalog', {src: 'inputs/G3v2_skybar_night.mp4'}));
    assert.match(one, /"label": "day"/);

    assert.match(txt(await call('search_catalog', {max_sec: 1})), /Nothing in the catalog matches/);

    fs.copyFileSync(path.join(pub, 'inputs', 'photo.png'), path.join(pub, 'inputs', 'photo2.png'));
    assert.match(txt(await call('search_catalog', {kind: 'image'})), /1 file\(s\) new or changed since the catalog was built \(inputs\/photo2\.png\)/);

    const bad = await client.callTool({name: 'catalog_assets', arguments: {dirs: ['../etc']}});
    assert.ok(bad.isError);
  } finally { await client.close(); fs.rmSync(pub, {recursive: true, force: true}); }
});
