// One agent per project: a lock file next to the project JSON
// (public/projects/<id>.lock) so two agents — two MCP servers, e.g. two headless
// runs started on the same project — cannot edit one timeline at once. The MCP
// server takes it on its first write and refreshes it on every write; it frees
// itself when that process exits, or after LOCK_TTL_MS without a write (a session
// left open all day must not block the project forever). The editor is not
// locked out: a human and an agent are already kept apart by the backend's
// compare-and-swap on updatedAt. The MCP over HTTP (server/mcp-http.mjs) runs many
// sessions in the backend's one process: `session` names which one holds a lock
// (absent for stdio, which is one agent per process).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LOCK_TTL_MS = 15 * 60 * 1000;
const lockFile = (dir, id) => path.join(dir, `${id}.lock`);
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// {ok: true} when this process holds the lock now; {ok: false, holder} when another live one does
export function acquireLock(dir, id, {pid = process.pid, owner = `pid ${pid}`, session, now = Date.now(), ttlMs = LOCK_TTL_MS} = {}) {
  fs.mkdirSync(dir, {recursive: true});
  const f = lockFile(dir, id);
  const mine = {pid, host: os.hostname(), owner, ...(session ? {session} : {}), since: now, beat: now};
  try {
    fs.writeFileSync(f, JSON.stringify(mine), {flag: 'wx'}); // atomic: only one creator wins
    return {ok: true};
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const cur = read(f);
  const same = cur && cur.pid === pid && cur.host === mine.host && (cur.session ?? null) === (session ?? null);
  const live = cur && !same && cur.host === mine.host && alive(cur.pid) && now - cur.beat < ttlMs;
  if (live) return {ok: false, holder: cur};
  // ours (refresh), or stale: a dead process, another host's leftover, or silent past the TTL
  const tmp = `${f}.${pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(same ? {...cur, beat: now} : mine));
  fs.renameSync(tmp, f);
  return {ok: true};
}

export function releaseLock(dir, id, pid = process.pid, session) {
  const f = lockFile(dir, id);
  const cur = read(f);
  if (cur && cur.pid === pid && cur.host === os.hostname() && (cur.session ?? null) === (session ?? null)) fs.rmSync(f, {force: true});
}

export const lockMessage = (id, h, now = Date.now()) =>
  `project ${id} is being edited by another agent (${h.owner}, pid ${h.pid}, last write ${Math.round((now - h.beat) / 1000)} s ago). Two agents must not edit one timeline: work on a copy (duplicate_project) or wait — the lock frees itself when that session ends or after ${LOCK_TTL_MS / 60000} min without edits.`;
