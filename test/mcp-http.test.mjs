// The MCP over HTTP (/mcp): the gate takes only the backend token, a session is
// opened with initialize and bound to its token, and the tool surface is the one
// the stdio server (`node mcp/server.mjs`) exposes. Tokens here are random per run.
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {gate} from '../server/http.mjs';
import {createMcpHttp} from '../server/mcp-http.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
process.env.REEL_API = 'http://127.0.0.1:9'; // no backend: the tools listed and called here do not need it
const {createReelServer, releaseSession} = await import('../mcp/server.mjs');

const tokA = crypto.randomBytes(16).toString('hex'), tokB = crypto.randomBytes(16).toString('hex');
const TOKENS = [tokA, tokB];
const req = (url, headers = {}) => ({headers: {host: 'localhost:3333', ...headers}, url});
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

test('gate: /mcp needs a listed x-reel-token in both modes — basic auth does not open it', () => {
  const u = new URL('http://x/mcp');
  for (const publicMode of [true, false]) {
    const none = gate(req('/mcp'), u, {publicMode, tokens: TOKENS});
    assert.equal(none.kind, 'deny'); assert.equal(none.status, 401);
    assert.equal(gate(req('/mcp', {'x-reel-token': 'nope'}), u, {publicMode, tokens: TOKENS}).status, 401);
    assert.equal(gate(req('/mcp', {'x-reel-token': tokB}), u, {publicMode, tokens: TOKENS}).kind, 'mcp', 'any client token of the list');
  }
  // an editor login (basic auth) that opens /api/* does not open /mcp
  const auth = {editor: '$2a$04$invalidhashinvalidhashinvalidhashinvalidhashinv'};
  assert.equal(gate(req('/mcp', {authorization: basic('editor', 'x')}), u, {publicMode: true, auth, tokens: TOKENS}).status, 401);
  assert.equal(gate(req('/mcp', {'x-reel-token': ''}), u, {publicMode: true, tokens: TOKENS}).status, 401, 'an empty header is no token');
  // local mode keeps its host check on top of the token
  assert.equal(gate(req('/mcp', {'x-reel-token': tokA, host: 'evil.example'}), u, {publicMode: false, tokens: TOKENS}).status, 403);
  // other paths keep their gate
  assert.equal(gate(req('/api/projects', {'x-reel-token': tokA}), new URL('http://x/api/projects'), {publicMode: true, tokens: TOKENS}).kind, 'ok');
});

// the backend's composition (server/index.mjs): gate first, then /mcp
let srv, mcp, base;
const closed = [];
before(async () => {
  mcp = createMcpHttp({createServer: createReelServer, onSessionClosed: (id) => { closed.push(id); releaseSession(id); }});
  srv = http.createServer(async (rq, rs) => {
    const g = gate(rq, new URL(rq.url, 'http://localhost'), {publicMode: true, tokens: TOKENS});
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
