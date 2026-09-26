// The backend's project write (server/index.mjs POST /api/projects/<id>) for tests that drive the MCP
// server: the MCP saves only through the backend, never the project file itself. Same order as the
// real route — compare-and-swap on updatedAt, the identity check, merge, write + rename — over
// public/projects/ of the cwd. Anything else answers 404.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {identityWrite} from '../mcp/checks.mjs';

export async function backendStub(projectsDir = path.join('public', 'projects')) {
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const send = (code, x) => res.writeHead(code, {'content-type': 'application/json'}).end(JSON.stringify(x));
      if (req.method === 'GET' && req.url === '/api/projects') return send(200, []);
      const id = req.method === 'POST' && req.url.match(/^\/api\/projects\/([\w-]+)$/)?.[1];
      if (!id) return send(404, {error: `not in the stub: ${req.method} ${req.url}`});
      const file = path.join(projectsDir, `${id}.json`);
      let prev = {};
      try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      const incoming = JSON.parse(b || '{}');
      if (incoming.updatedAt && prev.updatedAt && incoming.updatedAt !== prev.updatedAt) return send(409, {error: 'stale: project changed since you read it', updatedAt: prev.updatedAt});
      const bad = identityWrite(projectsDir, id, prev, incoming);
      if (bad) return send(400, {error: bad, code: 'bad_identity'});
      const updatedAt = new Date().toISOString();
      fs.writeFileSync(`${file}.stub.tmp`, JSON.stringify({...prev, ...incoming, createdAt: prev.createdAt || updatedAt, updatedAt}));
      fs.renameSync(`${file}.stub.tmp`, file);
      send(200, {ok: true, updatedAt});
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r))};
}
