// The real backend for test/concurrency.test.mjs: server/index.mjs itself, booted in this process from the suite's temp
// root (symlinks to the code, its own public/), plus what the suite drives in-process over IPC — a check_stage and a
// version's recording that stop at their pause point (checkStage's and recordVersion's `pause` option) until the test
// answers, on the very modules the backend's routes use (the same project and reviews rows). It also says when each
// request's body has been read and one turn of the event loop has passed — a POST's step is then queued on its row —
// so the test orders things without a clock. Picked up by `node --test` on its own (from the repo, not forked by the
// suite): nothing runs.
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
if (process.send && process.env.REEL_CONCURRENCY_ROOT === ROOT) {
  const dc = await import('node:diagnostics_channel');
  const fs = await import('node:fs');
  const {checkStage} = await import('../scripts/stages.mjs');
  const {recordFinal, reviewsDir} = await import('../scripts/reviews.mjs');
  const PUBLIC = path.join(ROOT, 'public');
  const waits = new Map(); // call id → release its pause
  const pause = (id) => (v) => new Promise((go) => { waits.set(id, go); process.send({id, paused: v ?? true}); }); // v: the version recordVersion numbered
  // the 720p proxy and poster of a version (ffmpeg in production): what recordVersion moves into place
  const makeProxy = async (input, proxyOut, posterOut) => { fs.writeFileSync(proxyOut, 'proxy'); fs.writeFileSync(posterOut, 'poster'); return {durationSec: 10}; };
  process.on('message', async (m) => {
    if (m.go) return waits.get(m.go)?.();
    try {
      const out = m.do === 'check' ? await checkStage(PUBLIC, m.project, m.stage, {actor: m.actor, env: process.env, pause: pause(m.id)})
        : await recordFinal({...m.record, dir: reviewsDir(PUBLIC), publicDir: PUBLIC, makeProxy, pause: pause(m.id)});
      process.send({id: m.id, done: out});
    } catch (e) { process.send({id: m.id, error: String(e?.message ?? e)}); }
  });
  process.on('disconnect', () => process.exit(0)); // the suite went away: no backend left behind
  dc.subscribe('tracing:net.server.listen:asyncEnd', ({server}) => process.send({ready: server.address().port}));
  dc.subscribe('http.server.request.start', ({request}) => request.once('end', () => setImmediate(() => process.send({arrived: `${request.method} ${request.url}`}))));
  await import('../server/index.mjs');
}
