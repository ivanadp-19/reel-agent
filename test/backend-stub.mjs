// The backend's project write (server/index.mjs POST /api/projects/<id>) and its stage routes for tests that drive
// the MCP server: the MCP saves only through the backend, never the project file itself. The same functions as the
// real routes (scripts/stages.mjs: saveProject — compare-and-swap on updatedAt, the identity check, the server's
// fields dropped, merge, write + rename, invalidation — checkStage, recordProof, waive, setStagesMode, stageView), inside
// the same row, over the public/ of the cwd; the caller is the MCP's, the primary backend token. The reviews a project's
// notes live in: GET /api/reviews/<id> (its versions as stored) and the agent's note steps (POST …/versions/<v>/notes/<note>,
// scripts/reviews.mjs agentNoteStep, as the primary token). Anything else answers 404.
import http from 'node:http';
import path from 'node:path';
import {checkStage, inRow, readProject, recordProof, saveProject, setStagesMode, stageView, waive} from '../scripts/stages.mjs';
import {agentNoteStep, loadReviews} from '../scripts/reviews.mjs';
import {actorOf} from '../scripts/review-states.mjs';

export async function backendStub(projectsDir = path.join('public', 'projects')) {
  const pub = path.dirname(projectsDir);
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', async () => {
      const send = ([code, x]) => res.writeHead(code, {'content-type': 'application/json'}).end(JSON.stringify(x));
      if (req.method === 'GET' && req.url === '/api/projects') return send([200, []]);
      const rv = req.url.match(/^\/api\/reviews\/([\w-]+)(?:\/versions\/(\d+)\/notes\/(n\d+))?$/);
      if (rv && req.method === 'GET' && !rv[2]) { const r = loadReviews(path.join(pub, 'reviews'), rv[1]); return send([200, {projectId: rv[1], versions: [...r.versions].reverse(), links: []}]); }
      if (rv?.[2] && req.method === 'POST') return send(await agentNoteStep(path.join(pub, 'reviews'), pub, rv[1], +rv[2], rv[3], JSON.parse(b || '{}'), actorOf({via: 'backend-token', primary: true})));
      const st = req.url.match(/^\/api\/projects\/([\w-]+)\/stages(?:\/([a-z]+)(?:\/(check|proof|waive))?)?$/);
      const g = {kind: 'ok', admin: true, via: 'backend-token', primary: true};
      if (st?.[2] === 'mode' && !st[3] && req.method === 'POST') return send(await setStagesMode(pub, st[1], JSON.parse(b || '{}').mode, g));
      if (st?.[3] === 'waive' && req.method === 'POST') return send(await waive(pub, st[1], st[2], JSON.parse(b || '{}'), g));
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
