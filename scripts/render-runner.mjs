// One render job, stage by stage — what the queue in scripts/render-jobs.mjs runs:
//
//   preparing   remote B-roll downloaded, missing LUT bakes (the backend's prepare hook)
//   master      a cached master for these exact props, if the layered pipeline has one
//   bundling    remotion bundles the composition
//   rendering   frames (Rendered x/y) — most of the time, the ETA comes from here
//   encoding    the last frames muxed (Encoded x/y)
//   finalizing  final only: two-pass loudness to −14 LUFS + the QC gate (scripts/qc.mjs)
//   review      final that passed QC for a project: 720p proxy + poster, recorded as the
//               next review version (scripts/reviews.mjs recordFinal)
//
// Progress is one 0–100 number over the whole job (STAGES below: the share of each
// stage), plus the stage, a label, frames {done, total} and etaSec.
//
// MASTER CACHE HOOK (the layered pipeline, "Paso 1", caches masters by hash — built on
// another branch). A master = the Remotion render of a set of composition props,
// BEFORE loudness and QC. When `scripts/master-cache.mjs` exists the backend passes it
// here as `master`; its contract:
//   lookupMaster({props, raw, draft}) → {file, key} | null   file = an absolute mp4 path
//   storeMaster({props, raw, draft, file, key?}) → void       COPY file (finalize rewrites
//                                                            it in place after this call)
// A hit copies the master to the export and skips bundling + rendering (the final still
// goes through loudness + QC + review version); the job result says master {hit, key}.
// A miss renders and then offers the fresh master to storeMaster. A hook that throws is
// logged and treated as a miss: the cache can never fail a render.
//
// CANCEL (or the stall control) aborts ctx.signal. Every stage follows it: prepare gets
// the signal (and is raced against it, so a step that ignores it still frees the queue
// slot), the child processes are killed, and on the way out the job's files are removed
// (every exports/edited-<id>*: the render, finalize's .loudnorm.mp4) — and a review
// version recorded while the cancel came in is taken back (unrecord): a cancelled job
// leaves no file and no version.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {renderArgs} from './render-queue.mjs';
import {linkPublic} from './public-links.mjs';
import {recordFinal, removeVersion} from './reviews.mjs';
import {killTree} from './render-jobs.mjs';

// [from, to] of the overall percentage per stage; a draft has no finalizing / review
export const STAGES = {
  final: {preparing: [0, 4], master: [4, 5], bundling: [5, 10], rendering: [10, 84], encoding: [84, 88], finalizing: [88, 96], review: [96, 99]},
  draft: {preparing: [0, 4], master: [4, 5], bundling: [5, 10], rendering: [10, 96], encoding: [96, 99.5]},
};
export const STAGE_LABEL = {preparing: 'Preparing media', master: 'Using cached master', bundling: 'Bundling', rendering: 'Rendering', encoding: 'Encoding', finalizing: 'Loudness + QC', review: 'Review proxy'};
export function overall(stage, frac = 0, draft = false) {
  const r = STAGES[draft ? 'draft' : 'final'][stage];
  if (!r) return 0;
  return Math.min(99, Math.round(r[0] + (r[1] - r[0]) * Math.max(0, Math.min(1, frac))));
}

// A line of `remotion render` output (non-TTY: one message per update) → {stage, frac, frames?}
export function parseRemotion(line) {
  let m;
  if ((m = line.match(/Bundling\s+(\d+)%/))) return {stage: 'bundling', frac: +m[1] / 100};
  if (/Bundled code|Copying public dir|Getting compositions/.test(line)) return {stage: 'bundling', frac: 1};
  if ((m = line.match(/Rendered\s+(\d+)\/(\d+)/))) return {stage: 'rendering', frac: +m[1] / +m[2], frames: {done: +m[1], total: +m[2]}};
  if ((m = line.match(/Encoded\s+(\d+)\/(\d+)/))) return {stage: 'encoding', frac: +m[1] / +m[2], frames: {done: +m[2], total: +m[2]}};
  return null;
}

// frames/s since the first rendered frame → seconds left for the rest of the job
// (the frames still to render + a rough allowance for encode and, on a final, loudness + QC)
export function etaFor({done, total, sinceFirstFrameSec, draft, expectSec = 0}) {
  if (!(done > 0) || !(sinceFirstFrameSec > 0) || !(total > 0)) return null;
  const rate = done / sinceFirstFrameSec;
  const rest = (total - done) / rate;
  const tail = draft ? 2 : 8 + (expectSec || total / 30) * 0.35;
  return Math.round(rest + tail);
}

class RenderError extends Error { constructor(msg, result) { super(msg); this.result = result; } }

// spawn a command as its own process group (killTree reaches npx → node → Chrome),
// line by line to onLine; resolves {code, out, tail}; the signal kills it.
function runChild(cmd, args, {cwd, signal, onLine, onPid, env}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const child = spawn(cmd, args, {cwd, env: env ?? process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
    onPid?.(child.pid);
    let out = '', tail = '', buf = '';
    const feed = (d, isOut) => {
      const s = String(d);
      if (isOut) out += s;
      tail = (tail + s).slice(-4000);
      buf += s;
      const lines = buf.split(/\r?\n|\r/);
      buf = lines.pop();
      for (const l of lines) if (l.trim()) onLine?.(l);
    };
    child.stdout.on('data', (d) => feed(d, true));
    child.stderr.on('data', (d) => feed(d, false));
    let killTimer = null;
    const onAbort = () => {
      killTree(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => killTree(child.pid, 'SIGKILL'), 5000); killTimer.unref?.();
    };
    signal?.addEventListener('abort', onAbort, {once: true});
    child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(new Error(`${cmd} could not start: ${e.message}`)); });
    child.on('close', (code, sig) => {
      onPid?.(null); // no process to watch until the next one starts (the heartbeat checks only a live pid)
      signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      if (buf.trim()) onLine?.(buf);
      if (signal?.aborted) return reject(signal.reason);
      resolve({code: code ?? (sig ? 128 : 1), signal: sig, out, tail});
    });
  });
}

// the defaults: the real remotion render and the real finalize; tests pass their own
export const defaultCommands = {
  render: ({outFile, propsFile, publicDir, draft, plan}) => ['npx', renderArgs({outFile, propsFile, publicDir, draft, concurrency: plan.concurrency, cacheBytes: plan.cacheBytes})],
  finalize: ({outFile, expectSec, clean}) => ['node', ['scripts/qc.mjs', '--finalize', outFile, String(expectSec), String(clean)]],
};

export function createRenderRunner({
  root,
  publicDir,
  exportsDir = path.join(publicDir, 'exports'),
  reviewsDir = path.join(publicDir, 'reviews'),
  tmpDir = path.join(root, '.captions-tmp'),
  plan = {concurrency: 1, cacheBytes: 5e8},
  prepare = async (raw) => raw, // (raw props, jobId, {signal, setPid, progress(frac, label)}) → raw props: localize remote B-roll, bake LUTs
  master = null, // {lookupMaster, storeMaster} — see MASTER CACHE HOOK above
  commands = defaultCommands,
  record = recordFinal,
  unrecord = ({projectId, v}) => removeVersion(reviewsDir, projectId, v, publicDir), // a version recorded by a job cancelled meanwhile
  log = (m) => console.log(m),
  now = Date.now,
} = {}) {
  fs.mkdirSync(exportsDir, {recursive: true});
  return async function runRender(job, ctx) {
    const {id, draft} = job;
    const {signal} = ctx;
    const expectSec = job.expectSec ?? 0;
    const t0 = now();
    const set = (stage, frac = 0, extra = {}) => ctx.update({stage, label: extra.label ?? STAGE_LABEL[stage], progress: overall(stage, frac, draft), ...extra});
    const stop = () => { if (signal.aborted) throw signal.reason; };
    // a step that does not follow the signal cannot hold the job (and the queue) past a cancel
    const abortable = (p) => new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, {once: true});
      Promise.resolve(p).then(
        (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
        (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
      );
    });

    const outName = `edited-${id}${draft ? '-draft' : ''}.mp4`;
    const outFile = path.join(exportsDir, outName);
    const result = {file: `/exports/${outName}`, path: outFile};
    let recorded = null; // {projectId, v} once a review version exists for this job
    // cancelled: no file of this job stays in exports/, no version of it stays in reviews/
    const cleanUp = () => {
      let names = [];
      try { names = fs.readdirSync(exportsDir); } catch {}
      for (const f of names) if (f.startsWith(`edited-${id}`) && /\.mp4$/.test(f)) fs.rmSync(path.join(exportsDir, f), {force: true});
      if (recorded) { try { unrecord(recorded); } catch (e) { log(`render ${id}: could not take back review version v${recorded.v}: ${e.message}`); } }
    };
    try {
      return await work();
    } catch (e) {
      if (signal.aborted) cleanUp();
      throw e;
    }

    async function work() {
      set('preparing', 0);
      const raw = await abortable(prepare(ctx.props, id, {signal, setPid: ctx.setPid, progress: (frac, label) => set('preparing', frac, {label})}));
      stop();
      const props = JSON.parse(raw);

      // ---- the master: from the cache, or rendered now ----
      let hit = null;
      if (master?.lookupMaster) {
        try { hit = await abortable(master.lookupMaster({props, raw, draft})); } catch (e) { stop(); log(`render ${id}: master cache lookup failed (${e.message}) — rendering`); }
        if (hit && !fs.existsSync(hit.file ?? '')) hit = null;
      }
      if (hit) {
        set('master', 0);
        await abortable(fs.promises.copyFile(hit.file, outFile));
        result.master = {hit: true, key: hit.key ?? null};
        set('master', 1);
      } else {
        const propsFile = path.join(root, `.props-${id}.json`);
        // public/ as symlinks: the CLI would otherwise copy every clip, matte and earlier export into its bundle
        const links = linkPublic(publicDir, path.join(tmpDir, `render-public-${id}`));
        fs.writeFileSync(propsFile, raw);
        set('bundling', 0);
        let firstFrameAt = null, lastErr = '';
        try {
          const [cmd, args] = commands.render({outFile, propsFile, publicDir: links, draft, plan, id});
          const r = await runChild(cmd, args, {
            cwd: root, signal, onPid: ctx.setPid,
            onLine: (l) => {
              if (/error/i.test(l)) lastErr = l.trim();
              const p = parseRemotion(l);
              if (!p) return;
              const extra = {};
              if (p.frames) {
                extra.frames = p.frames;
                if (p.stage === 'rendering' && p.frames.done > 0) {
                  firstFrameAt ??= now();
                  extra.etaSec = etaFor({done: p.frames.done, total: p.frames.total, sinceFirstFrameSec: (now() - firstFrameAt) / 1000, draft, expectSec});
                }
                if (p.stage === 'rendering') extra.label = `Rendering frame ${p.frames.done}/${p.frames.total}`;
              }
              set(p.stage, p.frac, extra);
            },
          });
          if (r.code !== 0 || !fs.existsSync(outFile)) {
            fs.rmSync(outFile, {force: true});
            log(`render ${id} failed:\n${r.tail.slice(-1200)}`);
            throw new RenderError(lastErr.slice(0, 300) || (r.signal ? `the render process was killed (${r.signal})` : `render exited ${r.code}`));
          }
        } finally {
          fs.rmSync(propsFile, {force: true});
          fs.rmSync(links, {recursive: true, force: true});
        }
        if (master?.storeMaster) {
          try { await abortable(master.storeMaster({props, raw, draft, file: outFile})); } catch (e) { stop(); log(`render ${id}: master cache store failed (${e.message})`); }
        }
        result.master = master ? {hit: false} : undefined;
      }
      result.renderSec = Math.round((now() - t0) / 1000);
      stop();
      if (draft) { log(`render ${id} draft took ${result.renderSec}s for ${expectSec.toFixed?.(1)}s of video`); return result; }

      // ---- final: loudness + QC, in a child process (a few seconds of ffmpeg must not block the backend) ----
      set('finalizing', 0, {frames: undefined, etaSec: Math.round(8 + expectSec * 0.35)});
      const [fcmd, fargs] = commands.finalize({outFile, expectSec, clean: job.clean ?? 'off'});
      const fin = await runChild(fcmd, fargs, {cwd: root, signal, onPid: ctx.setPid});
      let qc;
      try { qc = JSON.parse(fin.out.trim().split('\n').pop()); } catch { qc = {ok: false, error: 'QC did not report', checks: [], text: ''}; }
      result.qc = qc.text;
      result.renderSec = Math.round((now() - t0) / 1000);
      if (!qc.ok) {
        // kept as *-qcfail.mp4 for inspection, reported as a failure
        const failed = outName.replace(/\.mp4$/, '-qcfail.mp4');
        try { fs.renameSync(outFile, path.join(exportsDir, failed)); } catch {}
        const why = [qc.error, ...(qc.checks ?? []).filter((c) => !c.ok && c.blocking).map((c) => `${c.name} ${c.value}, want ${c.want}`)].filter(Boolean).join('; ');
        throw new RenderError(`QC failed (kept as /exports/${failed}): ${why}`, {qc: qc.text, file: `/exports/${failed}`, path: path.join(exportsDir, failed)});
      }
      stop();
      // ---- a final that passed QC for a project becomes its next review version ----
      if (job.projectId) {
        set('review', 0, {etaSec: 10});
        try {
          const v = await record({draft, qcOk: true, projectId: job.projectId, outFile, dir: reviewsDir, publicDir, jobId: id, signal});
          if (v) { recorded = {projectId: job.projectId, v: v.v}; result.version = v.v; result.projectId = job.projectId; }
        } catch (e) {
          stop(); // cancelled while the proxy was made: not a version error, a cancel
          result.versionError = String(e?.message ?? e).slice(0, 200);
        }
        stop(); // the cancel came in while it was being recorded: cleanUp takes the version back
      }
      log(`render ${id} took ${result.renderSec}s for ${expectSec.toFixed?.(1)}s of video`);
      return result;
    }
  };
}
