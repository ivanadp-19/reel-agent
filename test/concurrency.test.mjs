// T21 (docs/designs/cesar-etapas-bandeja.md §11, plan phase 21): the backend as the only writer, under the load César's
// setup puts on it — agents editing (several on one project), check_stage, César's notes and approvals in the bandeja,
// a version being recorded, sync_family — all at once against ONE real backend: server/index.mjs, booted from a temp
// root (its own public/, public mode with test users and a test session secret) by test/concurrency-backend.mjs, which
// also runs the paused check_stage and version recording in the backend's own process (checkStage's and
// recordVersion's `pause` option, on the same project and reviews rows as the routes). No clock orders anything: a
// pause is a promise the test releases, and a request is known to be queued by its arrival message.
// Asserted: no write is lost; a 409 comes only from the updatedAt compare-and-swap (the revision that beat a writer is
// another writer's edit, never a server record); nothing crosses projects; a check overtaken by an edit ends stale,
// never green; an approval that arrives while vN+1 is recorded stays on vN.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO = path.resolve(import.meta.dirname, '..');
const TOKEN = crypto.randomBytes(16).toString('hex'), SECRET = crypto.randomBytes(32).toString('hex'), PASS = crypto.randomBytes(9).toString('base64url');
const G2 = {client: 'vibem', script: 2, variant: {hook: 1, cta: 1}}, G3 = {client: 'vibem', script: 3, variant: {hook: 1, cta: 1}};
const ENV = (root) => ({...process.env, REEL_CONCURRENCY_ROOT: root, REEL_PUBLIC: '1', REEL_PORT: '0', PORT: '', REEL_HOST: '127.0.0.1',
  REEL_BACKEND_TOKEN: TOKEN, REEL_SESSION_SECRET: SECRET, REEL_TRUST_PROXY: '', REEL_PUBLIC_URL: '', REEL_REQUIRE_TOKEN: '', REEL_TOKENS_FILE: '',
  REEL_AUTH_BCRYPT: ['felipe', 'cesar'].map((u) => `${u}:${bcrypt.hashSync(PASS, 4)}`).join(','),
  REEL_USER_ROLES: JSON.stringify({felipe: {role: 'owner'}, cesar: {role: 'reviewer', clients: ['vibem']}}),
  DEEPGRAM_API_KEY: '', REEL_STT: '', REEL_CLEANUP_EVERY_H: '', REEL_REVIEW_KEEP_UNAPPROVED: '', REEL_FACE_AWARE: '0'});

// ---- fixtures: sources a (words close together), p (a 3 s pause), x and y (other words); projects; review versions ----
const clip = (src, outSec, x = {}) => ({id: src, src: `clips/${src}.mp4`, label: src, inSec: 0, outSec, sourceDurationSec: 10, ...x});
const PROJ = (x = {}) => ({name: 'concurrency', lang: 'es', offMic: 'mark', captionStyle: 'palabra', clips: [clip('a', 1.6)], captions: [], brolls: [], graphics: [], mattes: [], ...x});
const version = (v, identity) => ({v, createdAt: `2026-09-27T00:00:0${v}.000Z`, durationSec: 10, sizeBytes: 1, file: `exports/f${v}.mp4`, proxy: `reviews/x/v${v}.mp4`, poster: null, proxyBytes: 1,
  generated: [], identity, judge: {label: 'superado', findings: [], at: `2026-09-27T00:01:0${v}.000Z`}});
function seed(pub) {
  const tr = path.join(pub, 'clips', 'transcripts');
  fs.mkdirSync(tr, {recursive: true});
  const words = (gap) => [{word: 'hola', startMs: 100, endMs: 400}, {word: 'amigos', startMs: 500, endMs: 900}, {word: 'dos', startMs: 1000 + gap, endMs: 1300 + gap}];
  fs.writeFileSync(path.join(tr, 'a.es.json'), JSON.stringify(words(0)));
  fs.writeFileSync(path.join(tr, 'p.es.json'), JSON.stringify(words(2900)));
  fs.writeFileSync(path.join(tr, 'x.es.json'), JSON.stringify(words(0)));
  fs.writeFileSync(path.join(tr, 'y.es.json'), JSON.stringify(words(0).map((w, i) => ({...w, word: ['adiós', 'amigas', 'tres'][i]}))));
  fs.mkdirSync(path.join(pub, 'reviews'), {recursive: true});
  const reviews = (id, versions) => fs.writeFileSync(path.join(pub, 'reviews', `${id}.json`), JSON.stringify({projectId: id, managedBy: 'review-link', versions, links: []}));
  reviews('n1', [version(1, G2), version(2, G2)]);
  reviews('r1', [version(1, G3)]);
}

// ---- the backend ----
let B;
async function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-concurrency-'));
  for (const n of ['server', 'scripts', 'src', 'mcp', '.agents', 'node_modules', 'package.json', 'test']) fs.symlinkSync(path.join(REPO, n), path.join(root, n));
  seed(path.join(root, 'public'));
  const child = fork(path.join(root, 'test', 'concurrency-backend.mjs'), {cwd: root, env: ENV(root), execArgv: ['--preserve-symlinks', '--preserve-symlinks-main'], stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
  let out = '';
  for (const s of [child.stdout, child.stderr]) s.on('data', (d) => { out = (out + d).slice(-20000); });
  const calls = new Map(), arrivals = [];
  const port = await new Promise((resolve, reject) => {
    child.once('exit', (code) => { // before it listens, or under a call: fail it with the backend's output, never hang
      const e = new Error(`backend exited ${code}:\n${out}`);
      reject(e);
      for (const c of calls.values()) c.fail(e);
    });
    child.on('message', (m) => {
      if (m.ready) return resolve(m.ready);
      if (m.arrived) { for (const w of arrivals.filter((x) => x.what === m.arrived)) { arrivals.splice(arrivals.indexOf(w), 1); w.resolve(); } return; }
      const c = calls.get(m.id);
      if (m.paused) c?.paused(m.paused); else if (m.error) c?.fail(new Error(m.error)); else { c?.done(m.done); calls.delete(m.id); }
    });
  });
  const url = `http://127.0.0.1:${port}`;
  let seq = 0;
  return {
    root, url, pub: path.join(root, 'public'),
    // a check_stage or a version's recording in the backend's process, stopped at its pause until go()
    inProcess(msg) {
      const id = ++seq, c = {};
      let failP;
      const x = {paused: new Promise((r, j) => { c.paused = r; failP = j; }), done: new Promise((r, j) => { c.done = r; c.fail = (e) => { j(e); failP(e); }; }), go: () => child.send({go: id})};
      x.paused.catch(() => {}); // a call that failed before its pause: its done says why
      calls.set(id, c);
      child.send({id, ...msg});
      return x;
    },
    // resolved once that request's body is read and its step queued (register before sending it)
    arrived: (what) => new Promise((resolve) => arrivals.push({what, resolve})),
    stop: () => new Promise((r) => { if (child.exitCode !== null || child.signalCode !== null) return r(); child.once('exit', r); child.kill('SIGTERM'); }),
  };
}
before(async () => { B = await boot(); });
after(async () => { await B?.stop(); if (B) fs.rmSync(B.root, {recursive: true, force: true}); });

// ---- clients: an agent (the backend token, as the MCP and the reel CLI), César and Felipe (login sessions) ----
async function api(method, p, body, headers = {'x-reel-token': TOKEN}) {
  const r = await fetch(B.url + p, {method, headers: {'content-type': 'application/json', ...headers}, body: body === undefined ? undefined : JSON.stringify(body)});
  return {status: r.status, body: await r.json().catch(() => null)};
}
const get = async (id) => (await api('GET', `/api/projects/${id}`)).body;
const post = (id, p, headers) => api('POST', `/api/projects/${id}`, p, headers);
async function create(id, p) { const r = await post(id, p); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.updatedAt; }
const checkStage = async (id, stage, headers) => (await api('POST', `/api/projects/${id}/stages/${stage}/check`, undefined, headers)).body;
const stageOf = async (id, stage) => (await api('GET', `/api/projects/${id}/stages`)).body.stages.find((s) => s.stage === stage);
const stageLog = (id) => fs.readFileSync(path.join(B.pub, 'stages', `${id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const reviews = (id) => JSON.parse(fs.readFileSync(path.join(B.pub, 'reviews', `${id}.json`), 'utf8'));
async function login(user) {
  const r = await fetch(`${B.url}/login`, {method: 'POST', headers: {'content-type': 'application/json', origin: B.url}, body: JSON.stringify({user, password: PASS})});
  assert.equal(r.status, 200, `login ${user}`);
  const cookie = r.headers.getSetCookie()[0].split(';')[0];
  const page = await (await fetch(`${B.url}/bandeja`, {headers: {cookie}})).text();
  const csrf = page.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf, 'the bandeja page carries the session\'s CSRF token');
  // a bandeja step: the form the page posts → [status, the ?ok= of its 303]
  const step = async (route, form) => {
    const res = await fetch(`${B.url}/bandeja/${route}`, {method: 'POST', redirect: 'manual', headers: {'content-type': 'application/x-www-form-urlencoded', origin: B.url, cookie}, body: new URLSearchParams({csrf, ...form})});
    return [res.status, new URL(res.headers.get('location') ?? '/', B.url).searchParams.get('ok') ?? (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300)];
  };
  return {headers: {cookie, origin: B.url}, step};
}

// An agent's K edits of a project, the editor's and the MCP's way: read, change, save the whole project with the
// updatedAt it read — on a 409, read again and redo. Each edit adds one marker graphic naming the project and the
// writer. → every save's answer
async function edits(id, who, k) {
  const saves = [];
  for (let i = 0; i < k; i++) {
    for (;;) {
      const p = await get(id);
      const r = await post(id, {...p, graphics: [...p.graphics, {id: `${who}-${i}`, project: id, who}]});
      saves.push({id, who, sent: p.updatedAt, ...r});
      if (r.status !== 409) break;
    }
  }
  return saves;
}
// what every saver of a project got: all 200 or 409, each 409 the compare-and-swap's answer naming a revision another
// writer's edit made (never a server record: a check, a proof, a note, an approval) — and every edit in the project once.
// others: the revisions of writers outside `saves` (sync_family's)
async function assertNoLostWrite(id, saves, markers, others = []) {
  const ok = saves.filter((s) => s.status === 200), revs = new Set(ok.map((s) => s.body.updatedAt));
  assert.deepEqual(saves.filter((s) => s.status !== 200 && s.status !== 409).map((s) => [s.status, s.body]), [], `${id}: only 200 and 409`);
  assert.equal(revs.size, ok.length, `${id}: every save its own revision`);
  for (const s of saves.filter((x) => x.status === 409)) {
    assert.match(s.body.error, /^stale: project changed since you read it/);
    assert.ok(s.body.updatedAt !== s.sent && (revs.has(s.body.updatedAt) || others.includes(s.body.updatedAt)), `${id}: the 409 of ${s.who} names ${s.body.updatedAt}, the revision of another writer's edit`);
  }
  const p = await get(id);
  assert.deepEqual(p.graphics.map((g) => g.id).sort(), [...markers].sort(), `${id}: every edit there once, no other`);
  assert.ok(p.graphics.every((g) => g.project === id), `${id}: nothing of another project`);
  return p;
}

test('10 agents at once — 5 on 5 projects, 5 on one — with check_stage running on that one: no lost write, a 409 only from the compare-and-swap, nothing crosses projects', async () => {
  const K = 6, solo = ['e1', 'e2', 'e3', 'e4', 'e5'], shared = 's1', five = ['A', 'B', 'C', 'D', 'E'];
  for (const id of [...solo, shared]) await create(id, PROJ({name: id}));
  const runs = await Promise.all([
    ...solo.map((id) => edits(id, `solo-${id}`, K)),
    ...five.map((who) => edits(shared, who, K)),
    ...['corte', 'guion', 'corte'].map((s) => checkStage(shared, s)), // server records only: never a 409 for anyone
  ]);
  const saves = runs.slice(0, 10).flat();
  for (const id of solo) {
    const mine = saves.filter((s) => s.id === id);
    assert.deepEqual(mine.map((s) => s.status), Array(K).fill(200), `${id}: its only writer never gets a 409`);
    await assertNoLostWrite(id, mine, Array.from({length: K}, (_, i) => `solo-${id}-${i}`));
  }
  const s = saves.filter((x) => x.id === shared);
  assert.equal(s.filter((x) => x.status === 200).length, five.length * K);
  await assertNoLostWrite(shared, s, five.flatMap((w) => Array.from({length: K}, (_, i) => `${w}-${i}`)));
  for (const c of runs.slice(10)) assert.ok(['verde', 'rojo', 'stale'].includes(c.status) || c.superseded, JSON.stringify(c));
});

test('a check_stage overtaken by an edit: at R, paused; the edit (made on R) saves 200 and moves the project to R+1; released, the stage is stale and R\'s green is discarded', async () => {
  const R = await create('k1', PROJ());
  const c = B.inProcess({do: 'check', project: 'k1', stage: 'corte', actor: 'agent A'});
  await c.paused; // R's rules have run; the result is not written
  assert.deepEqual(await stageOf('k1', 'corte').then((x) => [x.status, x.rev]), ['chequeando', R]);
  const p = await get('k1'); // agent B read R
  p.clips[0].outSec = 1.5;
  const e = await post('k1', p);
  assert.equal(e.status, 200, 'a check never makes an edit stale');
  assert.ok(e.body.stale.includes('corte'));
  c.go();
  const [code, r] = await c.done;
  assert.equal(code, 200);
  assert.deepEqual([r.status, r.rev, r.discarded.rev, r.discarded.status], ['stale', e.body.updatedAt, R, 'verde'], 'R was green, and that green never lands on R+1');
  assert.equal((await stageOf('k1', 'corte')).status, 'stale');
  assert.deepEqual(stageLog('k1').filter((x) => x.stage === 'corte').map((x) => `${x.from}→${x.to}${x.discarded ? ` (discarded ${x.discarded === R ? 'R' : x.discarded})` : ''}`),
    ['pendiente→chequeando', 'chequeando→stale', 'stale→stale (discarded R)']);
  const n = await checkStage('k1', 'corte');
  assert.deepEqual([n.status, n.rev], ['verde', e.body.updatedAt], 'checked again, R+1 settles');
});

test('two check_stage of one stage: the one started last settles it; the older, ending after, is dropped unwritten', async () => {
  await create('k2', PROJ());
  const a = B.inProcess({do: 'check', project: 'k2', stage: 'corte', actor: 'agent A'});
  await a.paused;
  const p = await get('k2'); // a grade (color's) meanwhile: corte keeps its revision binding but not its check
  const e = await post('k2', {...p, grade: {look: 'warm', intensity: 0.5}});
  assert.equal(e.status, 200);
  assert.ok(!e.body.stale.includes('corte'));
  const b = await checkStage('k2', 'corte');
  assert.deepEqual([b.status, b.rev], ['verde', e.body.updatedAt]);
  a.go();
  const [, ra] = await a.done;
  assert.ok(ra.superseded, JSON.stringify(ra));
  const now = await stageOf('k2', 'corte');
  assert.deepEqual([now.status, now.rev, now.by], ['verde', e.body.updatedAt, 'backend-token'], 'the newest check stands');
});

test('a waiver during a check: the agent may not waive a blocker; Felipe\'s (his login) lands while the check runs and survives its write; the next check applies it', async () => {
  await create('k3', PROJ({clips: [clip('p', 5)]}));
  const red = await checkStage('k3', 'corte');
  assert.equal(red.status, 'rojo');
  const pause = red.findings.find((f) => f.code === 'pause');
  assert.equal(pause.level, 'error');
  const a = B.inProcess({do: 'check', project: 'k3', stage: 'corte', actor: 'agent A'});
  await a.paused; // its rules ran before the waiver: rojo
  const body = {rule: 'pause', ref: pause.ref, reason: 'la pausa es dramática, César la pidió'};
  assert.equal((await api('POST', '/api/projects/k3/stages/corte/waive', body)).status, 403, 'a blocker: never a token');
  const felipe = await login('felipe');
  const w = await api('POST', '/api/projects/k3/stages/corte/waive', body, felipe.headers);
  assert.equal(w.status, 200, JSON.stringify(w.body));
  a.go();
  const [, ra] = await a.done;
  assert.equal(ra.status, 'rojo', 'what it read, before the waiver: never a green it did not see');
  assert.deepEqual((await stageOf('k3', 'corte')).waivers?.map((x) => [x.rule, x.ref, x.by]), [['pause', pause.ref, 'felipe']], 'the waiver is still there');
  const n = await checkStage('k3', 'corte');
  assert.equal(n.status, 'verde');
  assert.ok(n.findings.find((f) => f.code === 'pause').waived);
});

test('César\'s notes and approvals during agent edits: none gets a 409, nothing is lost — 1 note between an agent\'s read and its save, then 20 notes and 2 approvals while 5 agents edit the project', async () => {
  const cesar = await login('cesar');
  await create('n1', PROJ({identity: G2}));
  // the agent read R; César's note (the reviews, outside the project's compare-and-swap); the agent saves on R
  const read = await get('n1');
  assert.deepEqual(await cesar.step('nota', {project: 'n1', v: '2', atSec: '1', text: 'nota 0'}), [303, 'nota']);
  assert.equal((await post('n1', {...read, name: 'agent edit'})).status, 200, 'a note never makes the agent\'s edit stale');
  const K = 4, agents = ['A', 'B', 'C', 'D', 'E'];
  const [agentSaves, bandeja] = await Promise.all([
    Promise.all(agents.map((w) => edits('n1', w, K))).then((x) => x.flat()),
    Promise.all([
      ...Array.from({length: 20}, (_, i) => cesar.step('nota', {project: 'n1', v: '2', atSec: String(i % 10), text: `nota ${i + 1}`})),
      cesar.step('aprobar', {project: 'n1', v: '1', confirm: 'VIBEM_G2_H1_C1'}),
      cesar.step('aprobar', {project: 'n1', v: '2', confirm: 'VIBEM_G2_H1_C1'}),
    ]),
  ]);
  assert.deepEqual(bandeja, [...Array(20).fill([303, 'nota']), [303, 'aprobada'], [303, 'aprobada']]);
  const r = reviews('n1');
  assert.deepEqual(r.versions.map((x) => [x.v, x.approval?.by]), [[1, 'cesar'], [2, 'cesar']]);
  assert.deepEqual(r.versions[1].notes.map((n) => n.text).sort(), Array.from({length: 21}, (_, i) => `nota ${i}`).sort(), 'all 21 notes, once each');
  assert.equal(new Set(r.versions[1].notes.map((n) => n.id)).size, 21);
  await assertNoLostWrite('n1', agentSaves, agents.flatMap((w) => Array.from({length: K}, (_, i) => `${w}-${i}`)));
});

test('an approval that arrives while vN+1 is being recorded waits for it and stays on vN', async () => {
  const cesar = await login('cesar');
  await create('r1', PROJ({identity: G3}));
  const ex = path.join(B.pub, 'exports');
  fs.mkdirSync(ex, {recursive: true});
  const file = (n) => { const f = path.join(ex, n); fs.writeFileSync(f, n); return f; };
  const rec = B.inProcess({do: 'record', record: {draft: false, qcOk: true, projectId: 'r1', outFile: file('r1-final.mp4'), jobId: 'jobr1',
    deliverables: {master: file('r1-master.mp4'), captions: file('r1-captions.mov'), captionsPng: file('r1-captions.png.zip')},
    omitted: {supers: 'el reel no tiene gráficos de texto', masterSupers: 'sin supers sería el mismo master'},
    identity: {...G3, family: 'vibem-G3'}, snapshot: {clips: []}, masterKey: 'mk', qc: {lufs: -14, truePeak: -1.2, parity: {frames: 300, fps: 29.97}}}});
  assert.equal(await rec.paused, 2, 'v2 read and numbered, not written yet');
  const queued = B.arrived('POST /bandeja/aprobar');
  const approval = cesar.step('aprobar', {project: 'r1', v: '1', confirm: 'VIBEM_G3_H1_C1'});
  await queued; // its step is on the reviews row, behind the recording
  assert.equal(reviews('r1').versions[0].approval, undefined, 'not written while v2 is being recorded');
  rec.go();
  assert.equal((await rec.done).v, 2);
  assert.deepEqual(await approval, [303, 'aprobada']);
  const r = reviews('r1');
  assert.deepEqual(r.versions.map((x) => [x.v, x.approval?.by ?? null, x.judge.label]), [[1, 'cesar', 'superado'], [2, null, 'en curso']]);
  assert.ok(Object.values(r.versions[1].deliverables).every((f) => fs.existsSync(path.join(B.pub, f))));
});

// the real MCP server over stdio from the temp root (its public/ is the backend's), as an agent runs it
async function agent(name) {
  const c = new Client({name, version: '0'});
  await c.connect(new StdioClientTransport({command: process.execPath, args: ['--preserve-symlinks', '--preserve-symlinks-main', path.join(B.root, 'mcp', 'server.mjs')], cwd: B.root, stderr: 'ignore',
    env: {...process.env, REEL_API: B.url, REEL_BACKEND_TOKEN: TOKEN, REEL_AGENT: name, DEEPGRAM_API_KEY: ''}}));
  c.tool = async (tool, args) => { const r = await c.callTool({name: tool, arguments: args}); return {err: !!r.isError, text: r.content.map((x) => x.text ?? '').join('\n')}; };
  return c;
}

test('two agents run the captions step on two projects at once: each project gets the pages of its own job, never the other\'s', async () => {
  await create('c1', PROJ({clips: [clip('x', 1.6)]}));
  await create('c2', PROJ({clips: [clip('y', 1.6)]}));
  const [one, two] = await Promise.all([agent('agent c1'), agent('agent c2')]);
  try {
    const out = await Promise.all([one.tool('run_ai_step', {project_id: 'c1', step: 'captions'}), two.tool('run_ai_step', {project_id: 'c2', step: 'captions'})]);
    for (const r of out) assert.equal(r.err, false, r.text);
    const words = async (id) => (await get(id)).captions.flatMap((c) => c.words.map((w) => `${w.wid} ${w.text}`));
    assert.deepEqual(await words('c1'), ['x:0 hola', 'x:1 amigos', 'x:2 dos']);
    assert.deepEqual(await words('c2'), ['y:0 adiós', 'y:1 amigas', 'y:2 tres']);
  } finally { await Promise.all([one.close(), two.close()]); }
});

test('sync_family writing the siblings while an agent edits one of them: each sibling synced or reported, the agent\'s edits all there', async () => {
  const pieces = (hook, x = {}) => [clip(`sf-h${hook}`, 2, {piece: 'hook'}), {...clip('sf-body', 4, {piece: 'body'}), id: 'body', ...x}, {...clip('sf-c', 2, {piece: 'cta'}), id: 'cta'}];
  const G7 = (hook) => ({client: 'vibem', script: 7, variant: {hook, cta: 1}});
  await create('sf1', PROJ({identity: G7(1), clips: pieces(1, {volume: 0.7})}));
  await create('sf2', PROJ({identity: G7(2), clips: pieces(2)}));
  await create('sf3', PROJ({identity: G7(3), clips: pieces(3)}));
  const mcp = await agent('sync agent');
  try {
    const K = 8;
    const [saves, synced] = await Promise.all([edits('sf2', 'editor', K), mcp.tool('sync_family', {from: 'sf1'})]);
    const text = synced.text;
    const line = (id) => text.split('\n').find((l) => l.trim().startsWith(`${id}:`))?.trim();
    assert.match(line('sf3'), /^sf3: ok/, text);
    const two = line('sf2');
    assert.match(two, /^sf2: (ok|error — project changed since you read it)/, 'a sibling saved meanwhile: the compare-and-swap, reported');
    const syncRevs = stageLog('sf2').filter((e) => e.event === 'sync_family').map((e) => e.rev); // the sync's save, when it got one
    const p2 = await assertNoLostWrite('sf2', saves, Array.from({length: K}, (_, i) => `editor-${i}`), syncRevs);
    assert.equal(p2.clips.find((c) => c.id === 'body').volume, /: ok/.test(two) ? 0.7 : undefined, 'synced iff reported synced');
    assert.equal((await get('sf3')).clips.find((c) => c.id === 'body').volume, 0.7);
    for (const id of ['sf2', 'sf3']) assert.equal(stageLog(id).filter((e) => e.event === 'sync_family').length, /: ok/.test(line(id)) ? 1 : 0);
    assert.deepEqual((await get('sf3')).graphics, [], 'the editor\'s edits stay on sf2');
  } finally { await mcp.close(); }
});
