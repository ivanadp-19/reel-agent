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
