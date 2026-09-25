// The MCP over HTTP (/mcp): the gate takes only the backend token, a session is
// opened with initialize and bound to its token, and the tool surface is the one
// the stdio server (`node mcp/server.mjs`) exposes. Tokens here are random per run.
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {gate, tokenOk} from '../server/http.mjs';
import {createMcpHttp} from '../server/mcp-http.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
process.env.REEL_API = 'http://127.0.0.1:9'; // no backend: the tools listed and called here do not need it
const {createReelServer, releaseSession} = await import('../mcp/server.mjs');

const tokA = crypto.randomBytes(16).toString('hex'), tokB = crypto.randomBytes(16).toString('hex');
const TOKENS = [tokA, tokB];
const req = (url, headers = {}) => ({headers: {host: 'localhost:3333', ...headers}, url});
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

test('gate: /mcp needs a listed x-reel-token in both modes — basic auth does not open it', async () => {
  const u = new URL('http://x/mcp');
  for (const publicMode of [true, false]) {
    const none = await gate(req('/mcp'), u, {publicMode, tokens: TOKENS});
    assert.equal(none.kind, 'deny'); assert.equal(none.status, 401);
    assert.equal((await gate(req('/mcp', {'x-reel-token': 'nope'}), u, {publicMode, tokens: TOKENS})).status, 401);
    assert.equal((await gate(req('/mcp', {'x-reel-token': tokB}), u, {publicMode, tokens: TOKENS})).kind, 'mcp', 'any client token of the list');
  }
  // an editor login (basic auth) that opens /api/* does not open /mcp
  const auth = {editor: '$2a$04$invalidhashinvalidhashinvalidhashinvalidhashinv'};
  assert.equal((await gate(req('/mcp', {authorization: basic('editor', 'x')}), u, {publicMode: true, auth, tokens: TOKENS})).status, 401);
  assert.equal((await gate(req('/mcp', {'x-reel-token': ''}), u, {publicMode: true, tokens: TOKENS})).status, 401, 'an empty header is no token');
  // local mode keeps its host check on top of the token
  assert.equal((await gate(req('/mcp', {'x-reel-token': tokA, host: 'evil.example'}), u, {publicMode: false, tokens: TOKENS})).status, 403);
  // other paths keep their gate
  assert.equal((await gate(req('/api/projects', {'x-reel-token': tokA}), new URL('http://x/api/projects'), {publicMode: true, tokens: TOKENS})).kind, 'ok');
});

test('tokenOk: a listed token, compared by digest — empty, missing, non-string and prefixes are not', () => {
  assert.equal(tokenOk(TOKENS, tokA), true);
  assert.equal(tokenOk(TOKENS, tokB), true);
  for (const t of ['', undefined, null, [tokA], tokA.slice(0, -1), tokA + 'x', `${tokA},${tokB}`]) assert.equal(tokenOk(TOKENS, t), false, String(t));
  assert.equal(tokenOk([], tokA), false);
  assert.equal(tokenOk(['', tokA], ''), false, 'an empty entry never matches');
});

// Over /mcp the tools run inside the backend: a synchronous child (spawnSync / execSync)
// would freeze the editor, the other sessions and /api/ping for as long as ffmpeg runs.
// The QC gate's own spawnSync (scripts/qc.mjs) is reached only as a child process.
test('the modules the MCP tools run in-process never spawn synchronously', () => {
  for (const f of ['mcp/server.mjs', 'mcp/broll.mjs', 'mcp/proof.mjs', 'mcp/assets.mjs', 'mcp/music.mjs', 'mcp/stock.mjs', 'server/mcp-http.mjs']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /\b(spawnSync|execSync|execFileSync)\b/, f);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'mcp/server.mjs'), 'utf8'), /import \{[^}]*\bqc\b[^}]*\} from '..\/scripts\/qc\.mjs'/, 'qc() runs as scripts/qc.mjs --json');
});

// the backend's composition (server/index.mjs): gate first, then /mcp
let srv, mcp, base;
const closed = [];
before(async () => {
  mcp = createMcpHttp({createServer: createReelServer, onSessionClosed: (id) => { closed.push(id); releaseSession(id); }});
  srv = http.createServer(async (rq, rs) => {
    const g = await gate(rq, new URL(rq.url, 'http://localhost'), {publicMode: true, tokens: TOKENS});
    if (g.kind === 'deny') { rs.writeHead(g.status, g.headers); return rs.end(g.body); }
    if (g.kind === 'mcp') return mcp.handle(rq, rs);
    rs.writeHead(404); rs.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => { await mcp?.close(); srv?.close(); });

const initBody = {jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'test', version: '0'}}};
const post = (headers, body = initBody) => fetch(`${base}/mcp`, {method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers}, body: JSON.stringify(body)});
const httpClient = async (token) => {
  const client = new Client({name: 'reel-test', version: '0'});
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {requestInit: {headers: {'x-reel-token': token}}});
  await client.connect(transport);
  return {client, transport};
};

test('HTTP: no token or a wrong one → 401 before any MCP work', async () => {
  const r1 = await post({});
  assert.equal(r1.status, 401);
  assert.deepEqual(await r1.json(), {error: 'x-reel-token required'});
  assert.equal((await post({'x-reel-token': 'wrong'})).status, 401);
  assert.equal(mcp.sessions(), 0);
});

test('HTTP: a valid token initializes a session; tools/list and a tool call work; the session is bound to its token', async () => {
  const r = await post({'x-reel-token': tokA});
  assert.equal(r.status, 200);
  const sid = r.headers.get('mcp-session-id');
  assert.ok(sid, 'initialize answers with a session id');
  await r.body?.cancel();
  // the same session with another client's token is not found
  const stolen = await post({'x-reel-token': tokB, 'mcp-session-id': sid}, {jsonrpc: '2.0', id: 2, method: 'tools/list'});
  assert.equal(stolen.status, 404);
  // no session and not an initialize → 400
  assert.equal((await post({'x-reel-token': tokA}, {jsonrpc: '2.0', id: 3, method: 'tools/list'})).status, 400);
  await fetch(`${base}/mcp`, {method: 'DELETE', headers: {'x-reel-token': tokA, 'mcp-session-id': sid}});

  const {client, transport} = await httpClient(tokB);
  assert.equal(client.getServerVersion()?.name, 'reel');
  const {tools} = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ['list_projects', 'get_project', 'set_plan', 'cut_words', 'start_render', 'render_status']) assert.ok(names.includes(n), n);
  const res = await client.callTool({name: 'style_kits', arguments: {}});
  assert.ok(!res.isError, JSON.stringify(res));
  assert.equal(res.content[0].type, 'text');
  const id = transport.sessionId;
  await transport.terminateSession();
  await client.close();
  assert.ok(closed.includes(id), 'closing the session frees what it held');
});

test('stdio still works and exposes exactly the tools HTTP does', async () => {
  const stdio = new Client({name: 'reel-test', version: '0'});
  await stdio.connect(new StdioClientTransport({command: process.execPath, args: ['mcp/server.mjs'], cwd: ROOT, env: {...process.env, REEL_API: 'http://127.0.0.1:9'}, stderr: 'ignore'}));
  const viaStdio = (await stdio.listTools()).tools;
  await stdio.close();
  const {client} = await httpClient(tokA);
  const viaHttp = (await client.listTools()).tools;
  await client.close();
  assert.ok(viaStdio.length > 50, `${viaStdio.length} tools`);
  assert.deepEqual(viaHttp.map((t) => t.name), viaStdio.map((t) => t.name));
  assert.deepEqual(viaHttp.map((t) => t.inputSchema), viaStdio.map((t) => t.inputSchema), 'same schemas');
});

// ---------- sessions, locks, limits and paths ----------
// A backend of its own per test: gate (publicMode, a token list the test can edit) + /mcp.
async function backend({publicMode = true, tokens = [...TOKENS], ...opts} = {}) {
  const closedIds = [];
  const m = createMcpHttp({createServer: createReelServer, onSessionClosed: (id) => { closedIds.push(id); releaseSession(id); }, ...opts});
  const s = http.createServer(async (rq, rs) => {
    const g = await gate(rq, new URL(rq.url, 'http://localhost'), {publicMode, tokens});
    if (g.kind === 'deny') { rs.writeHead(g.status, g.headers); return rs.end(g.body); }
    if (g.kind === 'mcp') return m.handle(rq, rs);
    rs.writeHead(404); rs.end();
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}/mcp`;
  const connect = async (token) => {
    const client = new Client({name: 'reel-test', version: '0'});
    const transport = new StreamableHTTPClientTransport(new URL(url), {requestInit: {headers: {'x-reel-token': token}}});
    await client.connect(transport);
    return {client, transport};
  };
  const raw = (headers, body = initBody) => fetch(url, {method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers}, body: JSON.stringify(body)});
  return {mcp: m, url, tokens, closed: closedIds, connect, raw, stop: async () => { await m.close(); s.close(); }};
}

// a throwaway project in public/projects (no backend: save() writes the file itself, lock first)
const PROJECTS = path.join(ROOT, 'public', 'projects');
function tempProject(t) {
  const id = `p-mcphttp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.mkdirSync(PROJECTS, {recursive: true});
  fs.writeFileSync(path.join(PROJECTS, `${id}.json`), JSON.stringify({name: 'mcp http test', clips: [], captions: [], brolls: [], graphics: []}));
  t.after(() => { for (const ext of ['.json', '.lock', '.timing.jsonl']) fs.rmSync(path.join(PROJECTS, id + ext), {force: true}); });
  return {id, lock: path.join(PROJECTS, `${id}.lock`), read: () => JSON.parse(fs.readFileSync(path.join(PROJECTS, `${id}.json`), 'utf8'))};
}
const tagOf = (sid) => crypto.createHash('sha256').update(sid).digest('hex').slice(0, 12);
const said = (r) => r.content.map((c) => c.text ?? '').join('\n');
const until = async (cond, ms = 3000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };

test('HTTP: a write takes the project lock for its session; another session is refused; closing the session frees it', async (t) => {
  const b = await backend(); t.after(b.stop);
  const p = tempProject(t);
  const a = await b.connect(tokA), other = await b.connect(tokB);
  const r = await a.client.callTool({name: 'rename_project', arguments: {project_id: p.id, name: 'renamed over http'}});
  assert.ok(!r.isError, said(r));
  assert.equal(p.read().name, 'renamed over http');
  const held = JSON.parse(fs.readFileSync(p.lock, 'utf8'));
  assert.equal(held.pid, process.pid);
  assert.equal(held.session, tagOf(a.transport.sessionId), 'the lock names the session, not only the process');
  assert.doesNotMatch(JSON.stringify(held), new RegExp(`${a.transport.sessionId}|${tokA}`), 'neither the session id nor the token is written');
  // same process, another session: a second agent, refused
  const refused = await other.client.callTool({name: 'rename_project', arguments: {project_id: p.id, name: 'stolen'}});
  assert.ok(refused.isError);
  assert.match(said(refused), /mcp http session/);
  assert.equal(p.read().name, 'renamed over http');
  // the holder closes its session → the lock is gone and the other session can write
  const sid = a.transport.sessionId;
  await a.transport.terminateSession(); await a.client.close();
  assert.ok(b.closed.includes(sid));
  assert.equal(fs.existsSync(p.lock), false, 'closing the session removed its lock file');
  const now = await other.client.callTool({name: 'rename_project', arguments: {project_id: p.id, name: 'second agent'}});
  assert.ok(!now.isError, said(now));
  assert.equal(JSON.parse(fs.readFileSync(p.lock, 'utf8')).session, tagOf(other.transport.sessionId));
  await other.transport.terminateSession(); await other.client.close();
  assert.equal(fs.existsSync(p.lock), false);
});

test('HTTP: a session left idle past idleMs is closed by the sweep and its locks are freed', async (t) => {
  const b = await backend({idleMs: 80}); t.after(b.stop);
  const p = tempProject(t);
  const a = await b.connect(tokA);
  const sid = a.transport.sessionId;
  const r = await a.client.callTool({name: 'rename_project', arguments: {project_id: p.id, name: 'then idle'}});
  assert.ok(!r.isError, said(r));
  assert.ok(fs.existsSync(p.lock));
  await until(() => b.mcp.sessions() === 0);
  assert.ok(b.closed.includes(sid));
  assert.equal(fs.existsSync(p.lock), false, 'the swept session left no lock behind');
  const late = await b.raw({'x-reel-token': tokA, 'mcp-session-id': sid}, {jsonrpc: '2.0', id: 9, method: 'tools/list'});
  assert.equal(late.status, 404, 'the expired session is gone: initialize again');
  await a.client.close().catch(() => {});
});

test('HTTP: a revoked token loses its open session at once', async (t) => {
  const tokC = crypto.randomBytes(16).toString('hex');
  const b = await backend({tokens: [tokA, tokC]}); t.after(b.stop);
  const c = await b.connect(tokC);
  const sid = c.transport.sessionId;
  assert.ok(!(await c.client.callTool({name: 'style_kits', arguments: {}})).isError);
  b.tokens.splice(b.tokens.indexOf(tokC), 1); // revoked: removed from REEL_BACKEND_TOKEN's list
  const r = await b.raw({'x-reel-token': tokC, 'mcp-session-id': sid}, {jsonrpc: '2.0', id: 5, method: 'tools/call', params: {name: 'style_kits', arguments: {}}});
  assert.equal(r.status, 401);
  await assert.rejects(c.client.callTool({name: 'style_kits', arguments: {}}));
  // another token cannot pick the session up either
  assert.equal((await b.raw({'x-reel-token': tokA, 'mcp-session-id': sid}, {jsonrpc: '2.0', id: 6, method: 'tools/list'})).status, 404);
  await c.client.close().catch(() => {});
});

test('HTTP: past maxSessions a new initialize gets 503; an existing session keeps working', async (t) => {
  const b = await backend({maxSessions: 2}); t.after(b.stop);
  const one = await b.connect(tokA), two = await b.connect(tokB);
  assert.equal(b.mcp.sessions(), 2);
  const third = await b.raw({'x-reel-token': tokA});
  assert.equal(third.status, 503);
  assert.match((await third.json()).error.message, /Too many MCP sessions/);
  assert.equal(b.mcp.sessions(), 2);
  assert.ok((await one.client.listTools()).tools.length > 0);
  // closing one makes room again
  await two.transport.terminateSession(); await two.client.close();
  const again = await b.connect(tokB);
  assert.equal(b.mcp.sessions(), 2);
  await again.client.close(); await one.client.close();
});

test('HTTP local mode: a foreign Origin on /mcp is refused (403) even with a valid token', async (t) => {
  const b = await backend({publicMode: false}); t.after(b.stop);
  const evil = await b.raw({'x-reel-token': tokA, origin: 'https://evil.example'});
  assert.equal(evil.status, 403);
  assert.deepEqual(await evil.json(), {error: 'bad origin'});
  assert.equal(b.mcp.sessions(), 0);
  assert.equal((await b.raw({origin: 'http://localhost:5173'})).status, 401, 'a local origin still needs the token');
  const ok = await b.raw({'x-reel-token': tokA, origin: 'http://localhost:5173'});
  assert.equal(ok.status, 200);
  await ok.body?.cancel();
});

test('HTTP: a file outside public/ is refused — by path, through a symlink in public/, and a secret by type', async (t) => {
  const b = await backend(); t.after(b.stop);
  const p = tempProject(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-mcphttp-'));
  const outside = path.join(dir, 'track.mp3'); fs.writeFileSync(outside, 'not really audio');
  const logo = path.join(dir, 'logo.png'); fs.writeFileSync(logo, 'png');
  const link = path.join(ROOT, 'public', 'music', `mcphttp-link-${process.pid}.mp3`);
  fs.mkdirSync(path.dirname(link), {recursive: true}); fs.symlinkSync(outside, link);
  t.after(() => { try { fs.unlinkSync(link); } catch {} fs.rmSync(dir, {recursive: true, force: true}); }); // unlink: rmSync follows a symlink
  const a = await b.connect(tokA);
  t.after(() => a.client.close());
  const call = async (name, args) => { const r = await a.client.callTool({name, arguments: {project_id: p.id, ...args}}); return {err: !!r.isError, text: said(r)}; };
  const refused = /must be under public\//;
  for (const [name, args] of [
    ['set_music', {file: outside}],
    ['set_music', {file: link}], // inside public/ by name, outside by target
    ['set_brand', {logo}],
    ['frame_at', {at_sec: 0, video: '/etc/hostname'}],
  ]) {
    const r = await call(name, args);
    assert.ok(r.err, `${name} ${JSON.stringify(args)} was accepted`);
    assert.match(r.text, refused, `${name}: ${r.text}`);
  }
  // the server's own secrets: not audio, refused before any path check
  const env = await call('set_music', {file: path.join(ROOT, '.env')});
  assert.ok(env.err); assert.match(env.text, /audio file/);
  const rel = await call('set_music', {file: '../.env.mp3'});
  assert.ok(rel.err); assert.match(rel.text, /not found in public\//);
  // nothing was copied in and the project was not touched
  assert.equal(fs.existsSync(path.join(ROOT, 'public', 'music', 'track.mp3')), false);
  assert.equal(p.read().music, undefined);
  assert.equal(fs.existsSync(p.lock), false);
});
