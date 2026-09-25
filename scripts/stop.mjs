// `npm run stop` — stop the app started with `npm start` (or a bare backend) by
// the pid it wrote, never by a process-name pattern: `pkill -f node` / `pkill -f
// reel` also matches the agent's own session (Claude Code, Codex, the MCP
// server) and kills it. See AGENTS.md, "Operating the VM".
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
let stopped = 0;
for (const f of ['.dev.pid', '.backend.pid']) {
  const file = path.join(ROOT, f);
  let pid;
  try { pid = +fs.readFileSync(file, 'utf8').trim(); } catch { continue; }
  if (!pid || pid === process.pid) continue;
  try { process.kill(pid, 'SIGTERM'); stopped++; console.log(`stopped ${f.slice(1, -4)} (pid ${pid})`); } catch { console.log(`${f.slice(1, -4)} was not running (stale ${f})`); }
  fs.rmSync(file, {force: true});
}
if (!stopped) console.log('nothing to stop (no running npm start / backend found)');
