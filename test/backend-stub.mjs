// The backend's project write (server/index.mjs POST /api/projects/<id>) and its stage routes for tests that drive
// the MCP server: the MCP saves only through the backend, never the project file itself. The same functions as the
// real routes (scripts/stages.mjs: saveProject — compare-and-swap on updatedAt, the identity check, the server's
// fields dropped, merge, write + rename, invalidation — checkStage, recordProof, stageView), inside the same row,
// over the public/ of the cwd. Anything else answers 404.
import http from 'node:http';
import path from 'node:path';
import {checkStage, inRow, readProject, recordProof, saveProject, stageView} from '../scripts/stages.mjs';

export async function backendStub(projectsDir = path.join('public', 'projects')) {
  const pub = path.dirname(projectsDir);
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', async () => {
      const send = ([code, x]) => res.writeHead(code, {'content-type': 'application/json'}).end(JSON.stringify(x));
      if (req.method === 'GET' && req.url === '/api/projects') return send([200, []]);
      const st = req.url.match(/^\/api\/projects\/([\w-]+)\/stages(?:\/([a-z]+)\/(check|proof))?$/);
      if (st && req.method === 'GET' && !st[2]) { const p = readProject(pub, st[1]); return send(p ? [200, stageView(pub, st[1], p)] : [404, {error: 'not found'}]); }
      if (st?.[3] === 'check' && req.method === 'POST') return send(await checkStage(pub, st[1], st[2], {actor: 'stub'}));
      if (st?.[3] === 'proof' && req.method === 'POST') return send(await recordProof(pub, st[1], st[2], JSON.parse(b || '{}'), 'stub'));
      const id = req.method === 'POST' && req.url.match(/^\/api\/projects\/([\w-]+)$/)?.[1];
      if (!id) return send([404, {error: `not in the stub: ${req.method} ${req.url}`}]);
      send(await inRow(id, () => saveProject(pub, id, JSON.parse(b || '{}'), {actor: 'stub'})));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r))};
}
