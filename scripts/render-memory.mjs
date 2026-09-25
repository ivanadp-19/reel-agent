// The render memory guard (scripts/render-jobs.mjs + scripts/render-runner.mjs):
//
//   heap cap     every Remotion pass runs with NODE_OPTIONS=--max-old-space-size=REEL_RENDER_HEAP_MB
//                (default 1536). `npx remotion render` is node (npm exec) → node (the CLI: bundler,
//                frame orchestration) → Chrome + the Rust compositor (`remotion`) + ffmpeg; the node
//                processes inherit NODE_OPTIONS (no worker of Remotion's resets it). Measured on a 30 s
//                final: the CLI peaks at 360–600 MB RSS, so 1536 MB (a V8 heap limit of ~1.7 GB with the
//                young generation) never binds a sane render, while a runaway one dies with V8's "heap
//                out of memory" below the ~2 GB RSS the kernel OOM-killed on Sep 24 — an exit of its
//                own, not a kernel oom-kill of the service. Chrome and the compositor are not node: the
//                compositor's frame cache, the biggest process of a render (3.98 GB RSS with the old
//                4 GB cache on a 32 GB box, 1.57 GB now), is bounded by REEL_RENDER_CACHE_MB
//                (scripts/render-queue.mjs renderPlan, default 1024).
//   start floor  a queued render starts only while the memory available is at least
//                REEL_RENDER_START_MIN_MEM_MB (default 2560: what one render takes as it gets going — the compositor with its
//                1 GB cache ~1.6 GB, Chrome ~0.7 GB, the CLI ~0.4 GB — so it does not start into a squeeze);
//                below it the job stays queued, says so, and is checked again on every tick (5 s).
//                Available = MemAvailable (/proc/meminfo), and — when the backend runs in a cgroup
//                with a limit (systemd MemoryMax) — no more than that limit minus what the cgroup
//                uses (its reclaimable page cache not counted).
//   OOM          a pass that ends by SIGKILL / 137 (the kernel's OOM killer), SIGABRT / 134 or V8's
//                heap-limit message, or while the cgroup's oom_kill counter went up, fails its job
//                with an out-of-memory message; the backend stays up.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const num = (v, dflt) => (v == null || v === '' || !Number.isFinite(+v) ? dflt : +v);
export const heapMb = (env = process.env) => Math.max(0, num(env.REEL_RENDER_HEAP_MB, 1536)); // 0 = no cap
export const startMinMemMb = (env = process.env) => Math.max(0, num(env.REEL_RENDER_START_MIN_MEM_MB, 2560)); // 0 = no floor

// the env of a render child: NODE_OPTIONS with the heap cap appended (an operator's own options kept;
// a --max-old-space-size already there wins — the last one counts in node, so it is not appended twice)
export function renderEnv(env = process.env, mb = heapMb(env)) {
  if (!(mb > 0)) return env;
  const cur = env.NODE_OPTIONS ?? '';
  if (/--max-old-space-size[= ]/.test(cur)) return env;
  return {...env, NODE_OPTIONS: `${cur} --max-old-space-size=${Math.round(mb)}`.trim()};
}

// ---- the memory available to a render, in MB ----
export function memAvailableMb(meminfo) {
  const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo ?? '');
  return m ? Math.round(+m[1] / 1024) : null;
}
// the cgroup v2 directories of this process, from its own up to the root (a limit may sit on any of them)
export function cgroupDirs({procSelf = '/proc/self/cgroup', root = '/sys/fs/cgroup'} = {}) {
  let rel;
  try { rel = /^0::(\/.*)$/m.exec(fs.readFileSync(procSelf, 'utf8'))?.[1]; } catch { return []; }
  if (!rel) return [];
  const dirs = [];
  for (let p = rel; ; p = path.posix.dirname(p)) {
    if (p !== '/') dirs.push(path.join(root, p));
    if (p === '/') break;
  }
  return dirs;
}
const readNum = (f) => { try { const s = fs.readFileSync(f, 'utf8').trim(); return s === 'max' ? Infinity : +s; } catch { return null; } };
// headroom under the tightest memory.max of those cgroups (MB), or null when none is set
export function cgroupHeadroomMb(dirs = cgroupDirs()) {
  let best = null;
  for (const d of dirs) {
    const max = readNum(path.join(d, 'memory.max'));
    const cur = readNum(path.join(d, 'memory.current'));
    if (!Number.isFinite(max) || !Number.isFinite(cur)) continue;
    // page cache (file, minus shmem, which cannot be dropped) is reclaimed before the kernel OOM-kills:
    // not a squeeze — reading source videos fills it, and it must not keep renders waiting
    let cache = 0;
    try {
      const st = fs.readFileSync(path.join(d, 'memory.stat'), 'utf8');
      const stat = (k) => +(new RegExp(`^${k} (\\d+)$`, 'm').exec(st)?.[1] ?? 0);
      cache = Math.max(0, stat('file') - stat('shmem'));
    } catch {}
    const room = Math.round((max - Math.max(0, cur - cache)) / 2 ** 20);
    best = best == null ? room : Math.min(best, room);
  }
  return best;
}
// what a render may use now: min(MemAvailable, cgroup headroom); null where it cannot be measured
// (macOS: os.freemem counts only never-used pages, so no floor there)
export function availableMemMb({meminfo = () => fs.readFileSync('/proc/meminfo', 'utf8'), cgroup = cgroupHeadroomMb, platform = process.platform} = {}) {
  if (platform !== 'linux') return null;
  let sys = null;
  try { sys = memAvailableMb(meminfo()); } catch {}
  if (sys == null) sys = Math.round(os.freemem() / 2 ** 20);
  let cg = null;
  try { cg = cgroup(); } catch {}
  return cg == null ? sys : Math.min(sys, cg);
}

// the oom_kill counter of this process's cgroups (their sum), or null — read before and after a pass
export function oomKills(dirs = cgroupDirs()) {
  let n = null;
  for (const d of dirs) {
    try {
      const m = /^oom_kill (\d+)$/m.exec(fs.readFileSync(path.join(d, 'memory.events'), 'utf8'));
      if (m) n = (n ?? 0) + +m[1];
    } catch {}
  }
  return n;
}

// Did a child die of memory? → a message for the job, or null. `oomDelta` = how much the cgroup's
// oom_kill counter moved while it ran (the kernel may have killed Chrome or the compositor below it,
// and the CLI then exits 1 with "Target closed").
export function oomReason({code, signal, tail = '', oomDelta = 0, heap = heapMb(), what = 'render'} = {}) {
  if (/JavaScript heap out of memory|Reached heap limit|Allocation failed - process out of memory/i.test(tail)) {
    return `out of memory: the ${what}'s node process reached its heap limit${heap ? ` (--max-old-space-size=${heap} MB, REEL_RENDER_HEAP_MB)` : ''} and aborted`;
  }
  if (signal === 'SIGKILL' || code === 137) return `out of memory: the ${what} process was killed (SIGKILL${code === 137 ? ', exit 137' : ''}) — most likely by the kernel's OOM killer`;
  if (oomDelta > 0) return `out of memory: the kernel OOM-killed a ${what} process (cgroup oom_kill +${oomDelta}) — exit ${signal ?? code}`;
  if (signal === 'SIGABRT' || code === 134) return `out of memory: the ${what} process aborted (SIGABRT${code === 134 ? ', exit 134' : ''}) — most likely its heap limit`;
  return null;
}
// exit code of a child that died of a signal, shell style (SIGKILL → 137)
export const signalCode = (sig) => 128 + (os.constants.signals[sig] ?? 0);
