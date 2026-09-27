// The captions job (scripts/captions-multiclip.mjs) end to end on cached transcripts, in a throwaway cwd:
// no media, no model, no network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const JOB = path.resolve(import.meta.dirname, '../scripts/captions-multiclip.mjs');
const clips = [{id: 'a', src: 'clips/a.mp4', inSec: 0, outSec: 10, sourceDurationSec: 10}];
const said = (text) => text.split(' ').map((word, i) => ({word, startMs: i * 300, endMs: i * 300 + 250}));
function run(payload, files, env = {}, prep = () => {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'captions-job-'));
  try {
    for (const [f, data] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(cwd, f)), {recursive: true}); fs.writeFileSync(path.join(cwd, f), JSON.stringify(data)); }
    prep(cwd);
    fs.writeFileSync(path.join(cwd, 'job.json'), JSON.stringify({clips, lang: 'es', offMic: 'off', ...payload}));
    const e = {...process.env, REEL_FACE_AWARE: '0', REEL_STT: 'whisperx', ...env};
    for (const k of ['REEL_GUION', 'HF_TOKEN', ...(env.DEEPGRAM_API_KEY ? ['REEL_STT'] : ['DEEPGRAM_API_KEY'])]) delete e[k];
    const r = spawnSync(process.execPath, [JOB, 'job.json'], {cwd, env: e, encoding: 'utf8'});
    const pages = fs.existsSync(path.join(cwd, 'public/captions.multi.json')) ? JSON.parse(fs.readFileSync(path.join(cwd, 'public/captions.multi.json'), 'utf8')) : null;
    return {status: r.status, stderr: r.stderr, pages};
  } finally { fs.rmSync(cwd, {recursive: true, force: true}); }
}
const shown = (pages) => pages.flatMap((c) => c.words).map((w) => `${w.text}${w.tier ? '*' : ''}`).join(' ');

test('the kit glossary comes from the saved project when the caller sends none (the CLI); spelled-out figures become digits', () => {
  const files = {
    'public/clips/transcripts/a.es.json': said('Son cincuenta y cuatro departamentos en Alta Brisa.'),
    'public/projects/p1.json': {brand: {glossary: [{term: 'Altabrisa', variants: ['Alta Brisa']}]}},
  };
  const cli = run({style: 'vibem', project_id: 'p1'}, files);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(shown(cli.pages), 'Son 54* departamentos* en Altabrisa*');
  assert.equal(shown(run({style: 'vibem', project_id: 'p1', glossary: []}, files).pages), 'Son 54* departamentos* en Alta* Brisa*'); // [] = none
});

test('Deepgram configured: its own cache, each word naming its id in the WhisperX one; Deepgram down fails the job', () => {
  const files = {
    'public/clips/transcripts/a.es.json': said('Son 54 departamentos.'),
    'public/clips/transcripts/a.es.dg.json': said('Bueno, son cincuenta y cuatro departamentos.'),
  };
  const dg = run({style: 'vibem'}, files, {DEEPGRAM_API_KEY: 'test-never-sent'}); // cached: no request
  assert.equal(dg.status, 0, dg.stderr);
  assert.deepEqual(dg.pages.flatMap((c) => c.words).map((w) => [w.wid, w.text, w.was]), [['a:0', 'Bueno,', undefined], ['a:1', 'son', 'a:0'], ['a:2', '54', 'a:1'], ['a:5', 'departamentos', 'a:2']]);
  // nothing cached for Deepgram, and it answers 503: the job fails with why — the WhisperX file is not served instead
  const down = run({style: 'vibem'}, {'public/clips/transcripts/a.es.json': said('Son 54 departamentos.')}, {
    DEEPGRAM_API_KEY: 'test-never-sent',
    NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent("globalThis.fetch = async () => new Response('down', {status: 503})")}`,
  }, (cwd) => spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1', '-f', 'mp4', path.join(cwd, 'public/clips/a.mp4')]));
  assert.notEqual(down.status, 0);
  assert.match(down.stderr, /Deepgram could not transcribe a .*503.* set REEL_STT=whisperx/);
});

// G1 through the real pipeline, synthetic: a vibem reel whose presenter's face sits above the band (43–50 %, G1's) keeps
// 53 % on every take; the same reel with the face on the band later in a take moves that whole take, within the kit's ±12
test('captions clear of the faces: the job places the pages from the face scans (G1: 53 % on every take)', async () => {
  const {FACE_VERSION} = await import('../scripts/face-scan.mjs');
  const scanOf = (face) => (cwd) => {
    const file = path.join(cwd, 'public/clips/a.mp4');
    fs.writeFileSync(file, 'not a real video: the scan is cached for these bytes');
    const st = fs.statSync(file);
    const samples = Array.from({length: 20}, (_, k) => ({t: k / 2, faces: [face(k / 2)]}));
    fs.mkdirSync(path.join(cwd, 'public/clips/faces'), {recursive: true});
    fs.writeFileSync(path.join(cwd, 'public/clips/faces/a.json'), JSON.stringify({version: FACE_VERSION, src: 'clips/a.mp4', size: st.size, mtimeMs: Math.round(st.mtimeMs), rate: 2, width: 360, height: 640, cuts: [3.1, 6.2], samples}));
  };
  const files = {
    'public/clips/transcripts/a.es.json': said('Hola. Esta es la torre. Tiene alberca. Y un roof garden. Te espera. Ven hoy. Agenda tu cita.'),
    'public/projects/p1.json': {brand: {style: {faceShift: 12, faceHold: 'toma'}}},
  };
  const g1 = run({style: 'vibem', project_id: 'p1'}, files, {REEL_FACE_AWARE: '1'}, scanOf(() => ({left: 0.45, top: 0.43, right: 0.55, bottom: 0.5})));
  assert.equal(g1.status, 0, g1.stderr);
  assert.ok(g1.pages.length >= 5);
  assert.deepEqual([...new Set(g1.pages.map((c) => c.topPct))], [53]);
  // from 4 s on (the second take) the face comes down onto the band: that take moves, as one
  const low = run({style: 'vibem', project_id: 'p1'}, files, {REEL_FACE_AWARE: '1'}, scanOf((t) => (t >= 4 ? {left: 0.4, top: 0.52, right: 0.6, bottom: 0.6} : {left: 0.45, top: 0.43, right: 0.55, bottom: 0.5})));
  assert.equal(low.status, 0, low.stderr);
  const second = low.pages.filter((c) => c.startMs >= 3100 && c.startMs < 6200).map((c) => c.topPct);
  assert.ok(second.length && new Set(second).size === 1 && second[0] !== 53 && Math.abs(second[0] - 53) <= 12, JSON.stringify(low.pages.map((c) => [c.startMs, c.topPct])));
  assert.deepEqual([...new Set(low.pages.filter((c) => c.startMs < 3100).map((c) => c.topPct))], [53], 'the first take stays');
});
