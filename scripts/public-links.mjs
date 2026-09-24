// Remotion's bundler COPIES the public folder into every bundle (clips, mattes,
// earlier exports: hundreds of MB each time) and `bundle()` never deletes its
// temp dir. A folder of symlinks to public/'s entries is forwarded as links
// instead, so a bundle stays a few MB. Used by the MCP proof and the renderer.
import fs from 'node:fs';
import path from 'node:path';

export function linkPublic(publicDir, linksDir) {
  fs.rmSync(linksDir, {recursive: true, force: true});
  fs.mkdirSync(linksDir, {recursive: true});
  for (const e of fs.readdirSync(publicDir)) fs.symlinkSync(path.join(publicDir, e), path.join(linksDir, e));
  return linksDir;
}

// remove per-process work dirs (<prefix><pid>) whose process is gone
export function sweepDead(parent, prefix) {
  let entries = [];
  try { entries = fs.readdirSync(parent); } catch { return; }
  for (const e of entries) {
    if (!e.startsWith(prefix)) continue;
    const pid = +e.slice(prefix.length);
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch {}
    if (!alive) fs.rmSync(path.join(parent, e), {recursive: true, force: true});
  }
}
