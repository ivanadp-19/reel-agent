// Render sizing: every export (editor button, MCP render / start_render, the CLI,
// headless runs) goes through one queue in the backend (scripts/render-jobs.mjs: jobs
// on disk) instead of a spawn per request or renders chained by hand with nohup. `workers` renders run at once, each with
// `concurrency` Chrome tabs; the rest wait their turn (the status says how many
// are ahead). Sized for the machine by renderPlan — see research/render-benchmark.md
// for the numbers on the 2-vCPU VM. scripts/render-bench.mjs measures it.
import os from 'node:os';

// How many renders at once and how many tabs each. Default: SERIAL — one render at
// a time with all the cores (a second render only splits the same CPUs and doubles
// the RAM; the jobs wait in scripts/render-jobs.mjs). REEL_RENDER_WORKERS = N runs up
// to N at once (still capped by RAM); REEL_RENDER_CONCURRENCY sets the tabs.
export function renderPlan({cpus = os.cpus().length, memBytes = os.totalmem(), env = process.env} = {}) {
  const byRam = Math.max(1, Math.floor(memBytes / 3e9)); // a render with its Chrome and compositor peaks around 2–3 GB
  const workers = Math.max(1, Math.min(Math.floor(+env.REEL_RENDER_WORKERS) || 1, byRam));
  // leave a core per render for the encoder once there are cores to spare
  const perWorker = Math.floor(cpus / workers);
  const concurrency = Math.max(1, Math.min(16, +env.REEL_RENDER_CONCURRENCY || (perWorker > 4 ? perWorker - 2 : perWorker)));
  const cacheBytes = Math.min(4e9, Math.max(5e8, Math.floor(memBytes / 4 / workers)));
  return {workers, concurrency, cacheBytes};
}

// the `remotion render` arguments of one export (the backend and the benchmark share them)
export function renderArgs({outFile, propsFile, publicDir, draft, concurrency, cacheBytes}) {
  return [
    'remotion', 'render', 'MultiClip', outFile, `--props=${propsFile}`, `--public-dir=${publicDir}`,
    `--concurrency=${concurrency}`,
    `--x264-preset=${draft ? 'ultrafast' : 'veryfast'}`,
    `--offthreadvideo-cache-size-in-bytes=${cacheBytes}`,
    ...(draft ? ['--scale=0.5'] : []),
  ];
}

// In-memory FIFO with `workers` slots (scripts/render-bench.mjs; the backend's queue
// is the persistent one in scripts/render-jobs.mjs). run(job) returns a promise; the
// next job starts when a slot frees, whatever happened to the previous one.
export function createQueue(workers, run) {
  const waiting = [];
  let running = 0;
  const next = () => {
    while (running < workers && waiting.length) {
      const {id, job} = waiting.shift();
      running++;
      Promise.resolve().then(() => run(job, id)).catch(() => {}).finally(() => { running--; next(); });
    }
  };
  return {
    // → how many jobs are ahead of this one (0 = started now)
    push(id, job) { waiting.push({id, job}); next(); return this.ahead(id); },
    ahead(id) { return waiting.findIndex((w) => w.id === id) + 1; },
    get running() { return running; },
    get waiting() { return waiting.length; },
  };
}
