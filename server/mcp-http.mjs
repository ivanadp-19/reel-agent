// The MCP over HTTP: the same tools as `node mcp/server.mjs` (stdio), served by
// the backend at /mcp with the SDK's Streamable HTTP transport, so an agent on
// another machine connects with a URL and its token instead of a shell here.
// The gate (server/http.mjs) has already checked x-reel-token; this keeps one
// McpServer + transport per MCP session (the SDK's stateful pattern), each bound
// to the token that opened it, and closes sessions left idle.
import crypto from 'node:crypto';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {isInitializeRequest} from '@modelcontextprotocol/sdk/types.js';

const MAX_BODY = 4 * 1024 * 1024; // JSON-RPC only: files never travel through /mcp
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rpcError = (res, status, code, message) => {
  res.writeHead(status, {'Content-Type': 'application/json'});
  res.end(JSON.stringify({jsonrpc: '2.0', error: {code, message}, id: null}));
};
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), {status: 413})); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

// createServer: () => McpServer (mcp/server.mjs createReelServer); onSessionClosed(id)
// frees what the session held (its project locks). → {handle(req, res), sessions(), close()}
export function createMcpHttp({createServer, onSessionClosed = () => {}, idleMs = 60 * 60e3, maxSessions = 64} = {}) {
  const sessions = new Map(); // id → {transport, server, owner (sha of the token), seen}
  const drop = (id) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    try { onSessionClosed(id); } catch {}
    s.server.close().catch(() => {});
  };
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.seen > idleMs) s.transport.close().catch(() => {}).finally(() => drop(id));
  }, Math.min(idleMs, 5 * 60e3));
  sweep.unref();

  async function handle(req, res) {
    const owner = sha(req.headers['x-reel-token']);
    const sid = req.headers['mcp-session-id'];
    let body;
    if (req.method === 'POST') {
      let raw;
      try { raw = await readBody(req); } catch (e) { return rpcError(res, e.status || 400, -32000, e.message); }
      try { body = JSON.parse(raw); } catch { return rpcError(res, 400, -32700, 'Parse error'); }
    }
    if (sid) {
      const s = sessions.get(sid);
      // unknown, expired, or opened with another client's token: the client must initialize again
      if (!s || s.owner !== owner) return rpcError(res, 404, -32001, 'Session not found');
      s.seen = Date.now();
      return s.transport.handleRequest(req, res, body);
    }
    if (req.method !== 'POST' || !(Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body))) return rpcError(res, 400, -32000, 'Bad Request: no valid session id');
    if (sessions.size >= maxSessions) return rpcError(res, 503, -32000, 'Too many MCP sessions');
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => { sessions.set(id, {transport, server, owner, seen: Date.now()}); },
    });
    transport.onclose = () => { if (transport.sessionId) drop(transport.sessionId); };
    await server.connect(transport);
    return transport.handleRequest(req, res, body);
  }

  return {
    handle,
    sessions: () => sessions.size,
    async close() {
      clearInterval(sweep);
      for (const [id, s] of [...sessions]) { await s.transport.close().catch(() => {}); drop(id); }
    },
  };
}
