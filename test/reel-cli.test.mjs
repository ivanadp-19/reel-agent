// The reel CLI (cli/reel.mjs) against a fake backend: the JSON contract (output,
// {error, code, hint}, exit codes, help --json), tokens never printed, and the long
// paths surviving dropped connections — a chunked upload and a download both resume.
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {main, checkCaptions, diffCaptions, slug} from '../cli/reel.mjs';
import {serveFile} from '../server/http.mjs';

const TOKEN = 'reel_test-secret-0123456789abcdefghij';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-cli-'));
after(() => fs.rmSync(tmp, {recursive: true, force: true}));

// ---- the fake backend ----
const S = {projects: new Map(), parts: new Map(), puts: 0, dropPut: 2, stalePosts: 0, renders: [], polls: 0, dropDownload: true, captionsCalls: 0};
fs.mkdirSync(path.join(tmp, 'server'));
const exportFile = path.join(tmp, 'server', 'edited-job.mp4');
fs.writeFileSync(exportFile, crypto.randomBytes(3 * 2 ** 20));
const send = (res, code, obj) => { res.writeHead(code, {'content-type': 'application/json'}); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.headers['x-reel-token'] !== TOKEN) return send(res, 401, {error: 'invalid or revoked token', code: 'bad_token', hint: 'ask an admin'});
  if (p === '/api/whoami') return send(res, 200, {user: 'ana', admin: false, via: 'user-token'});
  let m;
  if (p === '/api/projects') return send(res, 200, [...S.projects].map(([id, x]) => ({id, name: x.name, clips: x.clips?.length ?? 0, updatedAt: x.updatedAt, thumb: null})));
  if (p === '/api/captions' && req.method === 'POST') { S.captionsBody = JSON.parse(await readBody(req)); return send(res, 200, {jobId: '17'}); }
  if (p === '/api/captions/17') return send(res, 200, ++S.captionsCalls < 2 ? {status: 'running', progress: 50, label: 'Transcribing'} : {status: 'done', progress: 100, label: 'Ready', result: [{id: 'n0', src: 'clips/take1.mp4', startMs: 1000, endMs: 1600, topPct: 62, words: [{wid: 'take1:5', text: 'nuevo', startMs: 1000, endMs: 1600}]}]});
  if ((m = p.match(/^\/api\/projects\/([\w-]+)$/))) {
    const cur = S.projects.get(m[1]);
    if (req.method === 'GET') return cur ? send(res, 200, cur) : send(res, 404, {error: 'not found'});
    if (req.method === 'DELETE') { S.projects.delete(m[1]); return send(res, 200, {ok: true}); }
    const inc = JSON.parse(await readBody(req));
    if (S.stalePosts > 0) { S.stalePosts--; const bumped = {...cur, updatedAt: `t${Date.now()}x`}; S.projects.set(m[1], bumped); return send(res, 409, {error: 'stale: project changed since you read it', updatedAt: bumped.updatedAt}); }
    if (inc.updatedAt && cur?.updatedAt && inc.updatedAt !== cur.updatedAt) return send(res, 409, {error: 'stale'});
    const now = `t${process.hrtime.bigint()}`;
    S.projects.set(m[1], {...cur, ...inc, updatedAt: now});
    return send(res, 200, {ok: true, updatedAt: now});
  }
  if (p === '/api/add-clip') {
    if (url.searchParams.get('path')) return send(res, 403, {error: 'not yours', code: 'path_not_allowed'});
    const part = S.parts.get(url.searchParams.get('upload')) ?? Buffer.alloc(0);
    if (part.length !== +url.searchParams.get('size')) return send(res, 409, {error: 'incomplete', code: 'upload_incomplete'});
    S.ingested = part;
    return send(res, 200, {id: 'take1', src: 'clips/take1.mp4', label: 'take1', inSec: 0, outSec: 2, sourceDurationSec: 2});
  }
  if ((m = p.match(/^\/api\/uploads\/(\w+)$/))) {
    const have = S.parts.get(m[1]) ?? Buffer.alloc(0);
    if (req.method === 'GET') return send(res, 200, {size: have.length});
    const body = await readBody(req);
    if (+url.searchParams.get('offset') !== have.length) return send(res, 409, {error: 'offset', code: 'offset_mismatch', size: have.length});
    S.parts.set(m[1], Buffer.concat([have, body]));
    if (++S.puts === S.dropPut) return req.socket.destroy(); // the chunk landed, the answer is lost
    return send(res, 200, {size: have.length + body.length});
  }
  if (p === '/api/validate/bad') return send(res, 200, {ok: false, issues: [{level: 'error', code: 'safe-zone', msg: 'caption c0 under the UI'}, {level: 'warn', code: 'glue', msg: 'ends on "de"'}]});
  if (p === '/api/render' && req.method === 'POST') {
    const b = JSON.parse(await readBody(req));
    const plan = {mode: 'layers', full: false, master: 'cached', captions: true, reasons: []};
    if (url.searchParams.get('plan') === '1') return send(res, 200, {plan});
    if (S.renders.length && b.draft) return send(res, 409, {status: 409, code: 'render_busy', jobId: 'job123456', error: 'ana already has render job123456 running', hint: 'reel render wait job123456'});
    S.renders.push(b);
    return send(res, 200, {jobId: 'job123456', status: 'queued', ahead: 0, plan});
  }
  if (p === '/api/render-jobs/job123456') return send(res, 200, ++S.polls < 3 ? {id: 'job123456', status: 'running', progress: 40, stage: 'rendering'} : {id: 'job123456', status: 'done', progress: 100, projectId: 'promo', result: {file: '/exports/edited-job.mp4', mode: 'layers', master: 'cached'}});
  if (p === '/api/render-jobs/slow1234') return send(res, 200, {id: 'slow1234', status: 'running', progress: 1});
  if (p === '/api/render-jobs/fail1234') return send(res, 200, {id: 'fail1234', status: 'failed', error: 'QC failed'});
  if (p === '/api/render-jobs/job123456/file') {
    if (req.method === 'GET' && !req.headers.range && S.dropDownload) {
      S.dropDownload = false;
      res.writeHead(200, {'content-length': fs.statSync(exportFile).size, 'content-type': 'video/mp4'});
      res.write(fs.readFileSync(exportFile).subarray(0, 2 ** 20));
      return setTimeout(() => req.socket.destroy(), 20); // a third of the file, then the connection drops
    }
    return serveFile(req, res, exportFile, {'Content-Disposition': 'attachment; filename="edited-job.mp4"'});
  }
  send(res, 404, {error: 'not found'});
});
let base;
before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
after(() => server.close());

// run the CLI in-process: {code, out (parsed JSON when --json), stdout, stderr}
const outputs = [];
async function reel(args, {token = TOKEN, env = {}, stdin} = {}) {
  let stdout = '', stderr = '';
  const code = await main(args, {env: {REEL_URL: base, ...(token ? {REEL_TOKEN: token} : {}), ...env}, stdout: {write: (s) => (stdout += s)}, stderr: {write: (s) => (stderr += s)}, cwd: tmp, home: tmp, pollMs: 5, uidOf: () => null});
  outputs.push(stdout, stderr);
  let out = null;
  if (args.includes('--json')) out = JSON.parse(stdout);
  return {code, out, stdout, stderr};
}
after(() => { for (const o of outputs) assert.ok(!o.includes(TOKEN), 'the token is never printed'); });

test('help --json: every command with usage, flags, output, examples; exit codes; one command alone', async () => {
  const {code, out} = await reel(['help', '--json'], {token: null});
  assert.equal(code, 0);
  assert.equal(out.schemaVersion, 1);
  for (const k of ['0', '2', '3', '5', '7', '124']) assert.ok(out.exitCodes[k]);
  const names = out.commands.map((c) => c.name);
  for (const n of ['whoami', 'doctor', 'projects list', 'projects create', 'projects show', 'projects delete', 'clips add', 'captions get', 'captions set', 'captions validate', 'captions diff', 'render start', 'render status', 'render wait', 'render download', 'review-link', 'jobs list', 'token create', 'token revoke']) assert.ok(names.includes(n), n);
  for (const c of out.commands) { assert.ok(c.usage.startsWith(`reel ${c.name}`) && c.summary && c.flags.json, c.name); assert.ok(c.examples.length, c.name); }
  const one = await reel(['help', 'render', 'start', '--json'], {token: null});
  assert.equal(one.out.name, 'render start');
  assert.ok(one.out.flags.timeout && one.out.flags.plan);
  assert.equal((await reel(['render', 'start', '--help', '--json'])).out.name, 'render start');
});

test('errors: JSON {error, code, hint} and an exit code per family; nothing interactive', async () => {
  const unknown = await reel(['frobnicate', '--json']);
  assert.deepEqual([unknown.code, unknown.out.code], [2, 'bad_usage']);
  const flag = await reel(['projects', 'list', '--bogus', '--json']);
  assert.deepEqual([flag.code, flag.out.code], [2, 'bad_usage']);
  const bad = await reel(['whoami', '--json'], {token: 'reel_revoked'});
  assert.deepEqual([bad.code, bad.out.code, bad.out.hint], [3, 'bad_token', 'ask an admin']);
  const down = await reel(['whoami', '--json'], {env: {REEL_URL: 'http://127.0.0.1:9'}});
  assert.deepEqual([down.code, down.out.code], [7, 'backend_unreachable']);
  assert.ok(down.out.hint);
  const human = await reel(['whoami'], {token: 'reel_revoked'});
  assert.equal(human.stdout, '');
  assert.match(human.stderr, /^error: invalid or revoked token\nhint: /);
  const del = await reel(['projects', 'delete', 'promo', '--json']);
  assert.deepEqual([del.code, del.out.code], [2, 'confirm_required']);
});

test('the token file: read from ~/.config/reel/token only when no one else can read it', async () => {
  const dir = path.join(tmp, '.config', 'reel');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'token'), `${TOKEN}\n`, {mode: 0o644});
  fs.chmodSync(path.join(dir, 'token'), 0o644);
  const loose = await reel(['whoami', '--json'], {token: null});
  assert.deepEqual([loose.code, loose.out.code], [3, 'token_file_mode']);
  assert.match(loose.out.hint, /chmod 600/);
  fs.chmodSync(path.join(dir, 'token'), 0o600);
  const ok = await reel(['whoami', '--json'], {token: null});
  assert.deepEqual([ok.code, ok.out.user, ok.out.tokenSource], [0, 'ana', path.join(dir, 'token')]);
  fs.rmSync(path.join(dir, 'token'));
});

test('projects create is safe to retry; another project under the same id is a conflict', async () => {
  assert.equal(slug('Promo Café!'), 'promo-cafe');
  const a = await reel(['projects', 'create', 'Promo Café', '--id', 'promo', '--json']);
  assert.deepEqual(a.out, {id: 'promo', name: 'Promo Café', created: true});
  assert.equal(S.projects.get('promo').captionStyle, 'palabra', 'the same defaults as the MCP');
  assert.equal((await reel(['projects', 'create', 'Promo Café', '--id', 'promo', '--json'])).out.created, false);
  const clash = await reel(['projects', 'create', 'Otra', '--id', 'promo', '--json']);
  assert.deepEqual([clash.code, clash.out.code], [5, 'exists']);
  assert.deepEqual((await reel(['projects', 'list', '--json'])).out.projects.map((x) => x.id), ['promo']);
});

test('clips add: path refused → chunked upload that resumes after a lost answer; a second run skips the file; a stale write is redone', async () => {
  const file = path.join(tmp, 'take1.mp4');
  const bytes = crypto.randomBytes(20 * 2 ** 20 + 123); // three 8 MB chunks
  fs.writeFileSync(file, bytes);
  S.stalePosts = 1; // the editor saves between our read and our write
  const r = await reel(['clips', 'add', 'promo', 'take1.mp4', '--json']);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.out.added.map((a) => [a.clip, a.via]), [['take1', 'upload']]);
  assert.ok(S.ingested.equals(bytes), 'the server got the file byte for byte');
  assert.ok(S.puts >= 3);
  const clips = S.projects.get('promo').clips;
  assert.equal(clips.length, 1);
  assert.match(clips[0].srcKey, /^take1\.mp4:20971643:\d+$/);
  const again = await reel(['clips', 'add', 'promo', '.', '--json']); // the folder: take1.mp4 is its only video
  assert.deepEqual([again.out.added.length, again.out.skipped.length, S.projects.get('promo').clips.length], [0, 1, 1]);
  const none = await reel(['clips', 'add', 'promo', path.join(tmp, 'nope.mp4'), '--json']);
  assert.deepEqual([none.code, none.out.code], [4, 'not_found']);
});

test('captions: set checks the pages, the same pages change nothing, diff page by page, validate exits 9 on errors', async () => {
  const caps = [{id: 'c0', src: 'clips/take1.mp4', startMs: 0, endMs: 900, topPct: 62, words: [{text: 'Hola', startMs: 0, endMs: 400}, {text: 'café', startMs: 400, endMs: 900, tier: 2}]}];
  fs.writeFileSync(path.join(tmp, 'caps.json'), JSON.stringify({captions: caps}));
  const set = await reel(['captions', 'set', 'promo', 'caps.json', '--json']);
  assert.deepEqual([set.out.changed, set.out.count, set.out.diff.added], [true, 1, ['c0']]);
  assert.equal((await reel(['captions', 'set', 'promo', 'caps.json', '--json'])).out.changed, false);
  const edited = [{...caps[0], words: [{...caps[0].words[0], text: 'Buenas'}, caps[0].words[1]]}, {...caps[0], id: 'c1', startMs: 1000, endMs: 1500}];
  fs.writeFileSync(path.join(tmp, 'caps2.json'), JSON.stringify(edited));
  const d = await reel(['captions', 'diff', 'promo', 'caps2.json', '--json']);
  assert.deepEqual({added: d.out.added, removed: d.out.removed, changed: d.out.changed}, {added: ['c1'], removed: [], changed: [{id: 'c0', fields: ['words'], text: ['Hola café', 'Buenas café']}]});
  assert.deepEqual(diffCaptions(caps, []).removed, ['c0']);
  assert.throws(() => checkCaptions([{id: 'x', src: 's', startMs: 5, endMs: 1, words: []}]), /startMs < endMs/);
  assert.throws(() => checkCaptions([caps[0], caps[0]]), /duplicate id/);
  fs.writeFileSync(path.join(tmp, 'bad.json'), '[{"id": 3}]');
  const bad = await reel(['captions', 'set', 'promo', 'bad.json', '--json']);
  assert.deepEqual([bad.code, bad.out.code], [9, 'invalid']);
  const got = await reel(['captions', 'get', 'promo', '--json']);
  assert.deepEqual(got.out.captions, caps);
  const gen = await reel(['captions', 'generate', 'promo', '--json']);
  assert.deepEqual([gen.code, gen.out.added, gen.out.captions], [0, 1, 2], 'fresh pages merged next to the hand-set one');
  assert.deepEqual([S.captionsBody.project_id, S.captionsBody.style, S.captionsBody.clips.length], ['promo', 'palabra', 1]);
  const v = await reel(['captions', 'validate', 'bad', '--json']);
  assert.deepEqual([v.code, v.out.code, v.out.issues.length], [9, 'invalid', 2]);
});

test('render: start says the plan, busy is exit 5, wait ends done / failed / timeout, download resumes and is not fetched twice', async () => {
  const plan = await reel(['render', 'start', 'promo', '--plan', '--json']);
  assert.deepEqual([plan.out.plan.full, S.renders.length], [false, 0], '--plan queues nothing');
  const start = await reel(['render', 'start', 'promo']);
  assert.match(start.stdout, /^job123456 {2}final promo {2}STARTED\nlayers: master cached/);
  assert.deepEqual(S.renders[0], {project_id: 'promo', draft: false, mode: 'layers'}, 'layers by default: a captions edit reuses the master');
  const busy = await reel(['render', 'start', 'promo', '--draft', '--json']);
  assert.deepEqual([busy.code, busy.out.code, busy.out.jobId], [5, 'render_busy', 'job123456']);
  const wait = await reel(['render', 'wait', 'job123456', '--json']);
  assert.deepEqual([wait.code, wait.out.status, wait.out.result.master], [0, 'done', 'cached']);
  const failed = await reel(['render', 'wait', 'fail1234', '--json']);
  assert.deepEqual([failed.code, failed.out.code, failed.out.job.error], [8, 'render_failed', 'QC failed']);
  const slow = await reel(['render', 'wait', 'slow1234', '--timeout', '0.05', '--json']);
  assert.deepEqual([slow.code, slow.out.code, slow.out.job.status], [124, 'timeout', 'running']);
  const dl = await reel(['render', 'download', 'job123456', '--json']);
  assert.equal(dl.code, 0, dl.stdout);
  assert.equal(dl.out.file, path.join(tmp, 'edited-job.mp4'), 'named as the export, in the current folder');
  assert.ok(fs.readFileSync(path.join(tmp, 'edited-job.mp4')).equals(fs.readFileSync(exportFile)), 'resumed after the drop, byte for byte');
  assert.equal((await reel(['render', 'download', 'job123456', '--json'])).out.skipped, true);
});
