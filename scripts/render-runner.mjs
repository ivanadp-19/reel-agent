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
// Every render that settles leaves a record next to its mp4 (<file>.mp4.json,
// scripts/render-records.mjs): the project (job.projectId) and what it is — final,
// draft or qcfail. scripts/cleanup-exports.mjs reads it to keep each project's latest
// good final and to purge drafts and QC failures after their TTL.
//
// Progress is one 0–100 number over the whole job (STAGES below: the share of each
// stage), plus the stage, a label, frames {done, total} and etaSec.
//
// TWO MODES (src/layers.ts chooseRenderMode picks, scripts/layers.mjs builds — #17):
//   full    one Remotion pass, captions included
//   layers  the master (the reel without captions) from the cache in .render-cache/masters/,
//           keyed by masterKey (the code, the frame format, every prop and media file it
//           draws), rendered only when it is not there; a transparent caption layer (PNG
//           frames, or VP9 / ProRes with REEL_CAPTION_ALPHA); an ffmpeg composite. A reel
//           the caption layer cannot carry (captions that blur or scale the footage, or sit
//           behind the presenter) falls back to full, and the job says why (fallback).
// The queue and the cache work together, never rendering one master twice: jobs are
// serial by default, so the next one finds the master cached; with REEL_RENDER_WORKERS > 1
// a job that needs a master another job of this backend is rendering waits for it
// (single flight per key) instead of rendering it again. A master enters the cache only
// when it is complete (rename of its .part-<job> file); a cancelled or failed one never.
// The job result says {mode, fallback?, master: 'cached' | 'rendered', stages (s)}, and
// every stage goes to the project's timing log (scripts/timing.mjs, logStage): queue,
// prepare, render | master / captions / encode / composite, qc.
//
// CANCEL (or the stall control) aborts ctx.signal. Every stage follows it: prepare gets
// the signal (and is raced against it, so a step that ignores it still frees the queue
// slot), the child processes are killed, and on the way out the job's files are removed
// (every exports/edited-<id>*: the render, finalize's .loudnorm.mp4, the render record; the master's .part,
// the caption frames) — and a review
// version recorded while the cancel came in is taken back (unrecord): a cancelled job
// leaves no file and no version.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {renderArgs} from './render-queue.mjs';
import {ALPHA, alphaEncodeArgs, captionArgs, codeVersion, compositeArgs, masterArgs, masterKey, probeColor} from './layers.mjs';
import {blankLead, openingReport, parseStats, repairArgs, statsArgs} from './first-frame.mjs';
import {chooseRenderMode} from '../src/layers.ts';
import {lutBakes} from '../src/grade.ts';
import {localBrollName} from './remote-broll.mjs';
import {linkPublic} from './public-links.mjs';
import {recordFinal, removeVersion} from './reviews.mjs';
import {killTree} from './render-jobs.mjs';
import {writeRenderRecord} from './render-records.mjs';

// [from, to] of the overall percentage per stage; a draft has no finalizing / review
export const STAGES = {
  final: {preparing: [0, 4], master: [4, 5], bundling: [5, 10], rendering: [10, 84], encoding: [84, 88], finalizing: [88, 96], review: [96, 99]},
  draft: {preparing: [0, 4], master: [4, 5], bundling: [5, 10], rendering: [10, 96], encoding: [96, 99.5]},
};
export const STAGE_LABEL = {preparing: 'Preparing media', master: 'Master from the cache', bundling: 'Bundling', rendering: 'Rendering', encoding: 'Encoding', compositing: 'Compositing', finalizing: 'Loudness + QC', review: 'Review proxy'};
export const FPS = 30;
// where each Remotion pass sits in the overall %, per mode: [from, to] (inside a pass:
// bundling the first 7 %, frames up to 95 %, the encode the rest); then compositing
export function passRanges({mode, captions, draft}) {
  const end = draft ? 99 : STAGES.final.encoding[1];
  const start = STAGES.final.bundling[0];
  if (mode !== 'layers') return {render: [start, end]};
  if (!captions) return {master: [start, end]};
  return {master: [start, 60], captions: [60, end - 5], compositing: [end - 5, end]};
}
const inPass = ([a, b], stage, frac) => {
  const [x, y] = stage === 'bundling' ? [0, 0.07] : stage === 'rendering' ? [0.07, 0.95] : [0.95, 1];
  return Math.min(99, Math.round(a + (b - a) * (x + (y - x) * Math.max(0, Math.min(1, frac)))));
};
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

// the defaults: the real remotion passes, ffmpeg and the real finalize; tests pass their own
const passOpts = ({outFile, propsFile, publicDir, draft, plan}) => ({outFile, propsFile, publicDir, draft, concurrency: plan.concurrency, cacheBytes: plan.cacheBytes});
export const defaultCommands = {
  render: (o) => ['npx', renderArgs(passOpts(o))],
  master: (o) => ['npx', masterArgs(passOpts(o))],
  captions: (o) => ['npx', captionArgs(passOpts(o))],
  encode: ({frames, outFile, alpha}) => { const a = alphaEncodeArgs({frames, outFile, alpha, fps: FPS}); return a && ['ffmpeg', a]; }, // null: png, nothing to encode
  composite: ({master, layer, alpha, outFile, draft}) => ['ffmpeg', compositeArgs({master, overlays: [{file: layer, alpha}], outFile, fps: FPS, draft, color: probeColor(master)})],
  finalize: ({outFile, expectSec, clean}) => ['node', ['scripts/qc.mjs', '--finalize', outFile, String(expectSec), String(clean)]],
  // the blank-first-frame guard (scripts/first-frame.mjs): stats of frames 0–2 on stdout, and the repair
  frameStats: ({file}) => ['ffmpeg', statsArgs(file)],
  fixFirstFrame: ({file, outFile, draft}) => ['ffmpeg', repairArgs({file, outFile, fps: FPS, color: probeColor(file), draft})],
};

// What a render will do, said before it is queued (POST /api/render answers with it,
// `reel render start` prints it): full or layers, and whether it is a complete render —
// one pass, or the master rendered again — and why. The job's own decisions:
// chooseRenderMode, then the master key of the props as prepare() will leave them
// (remote B-roll under its local name; a download or a LUT bake still to do changes
// them, so the master is rendered again), then the master cache.
export function planRender(props, {requested = 'full', draft = false, root, publicDir, masterCache = null, keyOf = (p, o) => masterKey(p, {code: codeVersion(root), fps: FPS, draft: o.draft, publicDir})} = {}) {
  if (requested !== 'layers') return {mode: 'full', full: true, reasons: ['mode full: one pass over everything (mode layers reuses the cached master when only the captions change)']};
  const choice = chooseRenderMode('layers', props, FPS);
  if (choice.mode === 'full') return {mode: 'full', full: true, reasons: choice.reasons};
  if (!masterCache) return {mode: 'full', full: true, reasons: ['no master cache on this backend']};
  let downloads = 0;
  const brolls = (props.brolls ?? []).map((b) => {
    if (!/^https?:\/\//.test(b.src ?? '')) return b;
    const name = localBrollName(b);
    if (!fs.existsSync(path.join(publicDir, 'broll', name))) downloads++;
    return {...b, src: `broll/${name}`};
  });
  const g = props.grade;
  const bakes = lutBakes(g, props.clips ?? [], props.mattes ?? []).filter((b) => !g.baked?.[b.key] || !fs.existsSync(path.join(publicDir, g.baked[b.key]))).length;
  const reasons = [];
  if (downloads) reasons.push(`${downloads} remote B-roll to download first: the master is rendered again`);
  if (bakes) reasons.push(`${bakes} LUT bake${bakes === 1 ? '' : 's'} missing: the master is rendered again`);
  if (!reasons.length && !fs.existsSync(masterCache.file(keyOf({...props, brolls}, {draft})))) reasons.push('no cached master for this cut: its first layered render, or something besides the captions changed (clips, trims, B-roll, graphics, music, grade…)');
  return {mode: 'layers', full: reasons.length > 0, master: reasons.length ? 'render' : 'cached', captions: choice.captions, reasons};
}

export function createRenderRunner({
  root,
  publicDir,
  exportsDir = path.join(publicDir, 'exports'),
  reviewsDir = path.join(publicDir, 'reviews'),
  tmpDir = path.join(root, '.captions-tmp'),
  plan = {concurrency: 1, cacheBytes: 5e8},
  prepare = async (raw) => raw, // (raw props, jobId, {signal, setPid, progress(frac, label)}) → raw props: localize remote B-roll, bake LUTs
  masterCache = null, // scripts/layers.mjs createMasterCache (get / put / file / dir); no cache → every render is full
  captionAlpha = 'png', // REEL_CAPTION_ALPHA: png | vp9 | prores
  chooseMode = (requested, props) => chooseRenderMode(requested, props, FPS),
  keyOf = (props, {draft}) => masterKey(props, {code: codeVersion(root), fps: FPS, draft, publicDir}),
  logStage = () => {}, // (project, stage, ms, extra) → the project's timing log
  commands = defaultCommands,
  record = recordFinal,
  unrecord = ({projectId, v}) => removeVersion(reviewsDir, projectId, v, publicDir), // a version recorded by a job cancelled meanwhile
  writeRecord = writeRenderRecord, // (mp4, {projectId, kind, renderSec}) → <mp4>.json, what scripts/cleanup-exports.mjs reads
  log = (m) => console.log(m),
  now = Date.now,
} = {}) {
  fs.mkdirSync(exportsDir, {recursive: true});
  commands = {...defaultCommands, ...commands};
  const inflight = new Map(); // master key → the promise of the job of this backend rendering it (single flight)
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
      for (const f of names) if (f.startsWith(`edited-${id}`) && /\.mp4(\.json)?$/.test(f)) fs.rmSync(path.join(exportsDir, f), {force: true});
      if (recorded) { try { unrecord(recorded); } catch (e) { log(`render ${id}: could not take back review version v${recorded.v}: ${e.message}`); } }
    };
    // which project an export belongs to and what it is (final | draft | qcfail); a missing record only costs the cleanup's help
    const recordAs = (file, kind) => {
      try { writeRecord(file, {projectId: job.projectId ?? null, kind, renderSec: result.renderSec}); } catch (e) { log(`render ${id}: no render record: ${e.message}`); }
    };
    try {
      return await work();
    } catch (e) {
      if (signal.aborted) cleanUp();
      throw e;
    }

    async function work() {
      const project = job.projectId ?? null;
      const stages = {}; // seconds per stage, in the result and the timing log
      const timed = async (name, fn, extra = {}) => {
        const t = now();
        let ok = true;
        try { return await fn(); } catch (e) { ok = false; throw e; } finally {
          const ms = now() - t;
          stages[name] = +(ms / 1000).toFixed(1);
          if (!signal.aborted) logStage(project, name, ms, {job: id, mode: result.mode, draft, ...extra, ...(ok ? {} : {ok: false})});
        }
      };
      const queuedMs = Date.parse(job.startedAt ?? '') - Date.parse(job.createdAt ?? '');
      if (queuedMs > 1000) logStage(project, 'queue', queuedMs, {job: id});

      set('preparing', 0);
      const tPrep = now();
      const raw = await abortable(prepare(ctx.props, id, {signal, setPid: ctx.setPid, progress: (frac, label) => set('preparing', frac, {label})}));
      stop();
      if (now() - tPrep > 1000) logStage(project, 'prepare', now() - tPrep, {job: id});
      const props = JSON.parse(raw);

      const choice = chooseMode(job.mode === 'layers' ? 'layers' : 'full', props);
      result.mode = choice.mode;
      if (choice.reasons?.length) { result.fallback = choice.reasons; log(`render ${id}: layers → full (${choice.reasons.join('; ')})`); }
      const layered = choice.mode === 'layers' && masterCache;
      if (choice.mode === 'layers' && !masterCache) { result.mode = 'full'; result.fallback = ['no master cache on this backend']; }
      const ranges = passRanges({mode: layered ? 'layers' : 'full', captions: choice.captions, draft});

      // public/ as symlinks: the CLI would otherwise copy every clip, matte and earlier export into its bundle
      const links = linkPublic(publicDir, path.join(tmpDir, `render-public-${id}`));
      const tmp = [links]; // removed whatever happens: props files, the master's .part, the caption frames
      const propsFile = (name, p) => { const f = path.join(root, `.props-${id}${name}.json`); fs.writeFileSync(f, JSON.stringify(p)); tmp.push(f); return f; };
      // one Remotion pass: progress mapped into its range, frames and an ETA, the pid watched
      const pass = async (kind, range, outPath, pProps, what) => {
        set('bundling', 0, {progress: inPass(range, 'bundling', 0), label: `Bundling${what ? ` (${what})` : ''}`});
        let firstFrameAt = null, lastErr = '';
        const [cmd, args] = commands[kind]({outFile: outPath, propsFile: propsFile(kind === 'render' ? '' : `-${kind}`, pProps), publicDir: links, draft, plan, id});
        const r = await runChild(cmd, args, {
          cwd: root, signal, onPid: ctx.setPid,
          onLine: (l) => {
            if (/error/i.test(l)) lastErr = l.trim();
            const p = parseRemotion(l);
            if (!p) return;
            const extra = {progress: inPass(range, p.stage, p.frac), label: `${STAGE_LABEL[p.stage]}${what ? ` ${what}` : ''}`};
            if (p.frames) {
              extra.frames = p.frames;
              if (p.stage === 'rendering' && p.frames.done > 0) {
                firstFrameAt ??= now();
                extra.etaSec = etaFor({done: p.frames.done, total: p.frames.total, sinceFirstFrameSec: (now() - firstFrameAt) / 1000, draft, expectSec});
              }
              if (p.stage === 'rendering') extra.label = `Rendering ${what ? `${what} ` : ''}frame ${p.frames.done}/${p.frames.total}`;
            }
            set(p.stage, p.frac, extra);
          },
        });
        if (r.code !== 0 || !fs.existsSync(outPath)) {
          log(`render ${id} ${kind} failed:\n${r.tail.slice(-1200)}`);
          throw new RenderError(lastErr.slice(0, 300) || (r.signal ? `the render process was killed (${r.signal})` : `render exited ${r.code}`));
        }
      };
      const ffmpeg = async (argv, what) => {
        const r = await runChild(argv[0], argv[1], {cwd: root, signal, onPid: ctx.setPid});
        if (r.code !== 0) throw new RenderError(`${what} failed: ${r.tail.trim().split('\n').pop() ?? ''}`.slice(0, 300));
      };
      // a Remotion pass whose frame 0 is a flat, neutral field while frame 1 is footage
      // (scripts/first-frame.mjs): frame 1 takes its place before anything uses the file
      // (a master before it enters the cache). An unreadable file is left to the pass's
      // own checks and to QC. The result and the log say it happened and what was at t = 0.
      const guardFirstFrame = async (file, where) => {
        const [scmd, sargs] = commands.frameStats({file});
        const st = await runChild(scmd, sargs, {cwd: root, signal, onPid: ctx.setPid});
        const stats = st.code === 0 ? parseStats(st.out) : [];
        if (!blankLead(stats)) return;
        // `.part-` keeps the master cache's trim off it while it is written next to a cached master
        const fixed = file.replace(/\.mp4$/, '') + `.part-ff-${id}.mp4`;
        tmp.push(fixed);
        await timed('first-frame', () => ffmpeg(commands.fixFirstFrame({file, outFile: fixed, draft}), 'first-frame repair'));
        fs.renameSync(fixed, file);
        const f0 = stats[0];
        (result.firstFrame ??= []).push({pass: where, repaired: true, frame0: {y: f0.yavg, u: f0.uavg, v: f0.vavg}});
        log(`render ${id}: frame 0 of the ${where} was a flat field (Y ${f0.ymin}–${f0.ymax}, U ${f0.uavg}, V ${f0.vavg}; frame 1 Y ${stats[1].ymin}–${stats[1].ymax}) — replaced by frame 1. At t = 0: ${JSON.stringify(openingReport(props))}`);
      };
      try {
        if (!layered) {
          await timed('render', () => pass('render', ranges.render, outFile, props), {videoSec: expectSec});
          await guardFirstFrame(outFile, 'render');
        } else {
          // ---- the master: cached, being rendered by another job here (wait for it), or rendered now ----
          const key = keyOf(props, {draft});
          const renderMaster = async () => {
            const part = path.join(masterCache.dir, `${key}.part-${id}.mp4`);
            tmp.push(part);
            await timed('master', () => pass('master', ranges.master, part, {...props, captionsOff: true}, 'master'), {videoSec: expectSec});
            stop(); // a cancelled master never enters the cache
            await guardFirstFrame(part, 'master'); // a cached master is always a repaired one
            return masterCache.put(key, part);
          };
          let master = null;
          for (let waited = 0; !master;) {
            const cached = masterCache.get(key);
            if (cached) {
              // a master cached before the guard existed can hold a blank frame 0: repaired in place (atomic rename), so the cache heals
              await guardFirstFrame(cached, 'cached master');
              master = cached; result.master ??= 'cached'; break;
            }
            const other = inflight.get(key);
            if (other) {
              // same master, other job: wait (the label ticks, so the stall control sees it alive)
              const tick = setInterval(() => set('master', 0, {label: `Waiting for the same master (another render) · ${++waited * 5}s`}), 5000);
              set('master', 0, {label: 'Waiting for the same master (another render)'});
              try { await abortable(other); } catch { stop(); } finally { clearInterval(tick); }
              continue; // cached now — or its job failed: render it here
            }
            const mine = renderMaster();
            inflight.set(key, mine);
            mine.catch(() => {});
            try { master = await mine; result.master = 'rendered'; } finally { inflight.delete(key); }
          }
          if (result.master === 'cached') set('master', 1, {progress: ranges.master[1], label: 'Master reused from the cache'});
          if (choice.captions) {
            // Remotion reads any dot in a sequence folder's path as an extension and refuses it (.captions-tmp would): the OS temp dir
            const frames = path.join(os.tmpdir(), `reel-captions-${id}`);
            tmp.push(frames);
            await timed('captions', () => pass('captions', ranges.captions, frames, {...props, layer: 'captions'}, 'captions layer'));
            let layer = frames;
            const ext = ALPHA[captionAlpha]?.ext;
            const enc = ext && commands.encode({frames, outFile: (layer = `${frames}.${ext}`), alpha: captionAlpha});
            if (enc) {
              tmp.push(layer);
              set('compositing', 0, {progress: ranges.compositing[0], label: `Encoding captions layer (${captionAlpha})`});
              await timed('encode', () => ffmpeg(enc, 'captions layer encode'));
            }
            set('compositing', 0.5, {progress: Math.round((ranges.compositing[0] + ranges.compositing[1]) / 2), label: 'Compositing', frames: undefined, etaSec: undefined});
            await timed('composite', () => ffmpeg(commands.composite({master, layer, alpha: captionAlpha, outFile, draft}), 'composite'));
          } else await abortable(fs.promises.copyFile(master, outFile)); // nothing to lay over it: the master is the reel
          // what ships: the composite or the copy (a caption on frame 0 can hide a flat field from this check — hence the master's own)
          await guardFirstFrame(outFile, choice.captions ? 'composite' : 'export');
        }
      } finally {
        for (const f of tmp) fs.rmSync(f, {recursive: true, force: true});
      }
      result.stages = stages;
      result.renderSec = Math.round((now() - t0) / 1000);
      stop();
      if (draft) { recordAs(outFile, 'draft'); log(`render ${id} draft [${result.mode}${result.master ? `, master ${result.master}` : ''}] took ${result.renderSec}s for ${expectSec.toFixed?.(1)}s of video ${JSON.stringify(stages)}`); return result; }

      // ---- final: loudness + QC, in a child process (a few seconds of ffmpeg must not block the backend) ----
      set('finalizing', 0, {frames: undefined, etaSec: Math.round(8 + expectSec * 0.35)});
      const [fcmd, fargs] = commands.finalize({outFile, expectSec, clean: job.clean ?? 'off'});
      let qc;
      await timed('qc', async () => {
        const fin = await runChild(fcmd, fargs, {cwd: root, signal, onPid: ctx.setPid});
        try { qc = JSON.parse(fin.out.trim().split('\n').pop()); } catch { qc = {ok: false, error: 'QC did not report', checks: [], text: ''}; }
        if (!qc.ok) throw new Error('qc'); // logged as ok: false
      }).catch((e) => { if (signal.aborted || !qc) throw e; });
      result.qc = qc.text;
      result.renderSec = Math.round((now() - t0) / 1000);
      if (!qc.ok) {
        // kept as *-qcfail.mp4 for inspection, reported as a failure
        const failed = outName.replace(/\.mp4$/, '-qcfail.mp4');
        try { fs.renameSync(outFile, path.join(exportsDir, failed)); recordAs(path.join(exportsDir, failed), 'qcfail'); } catch {}
        const why = [qc.error, ...(qc.checks ?? []).filter((c) => !c.ok && c.blocking).map((c) => `${c.name} ${c.value}, want ${c.want}`)].filter(Boolean).join('; ');
        throw new RenderError(`QC failed (kept as /exports/${failed}): ${why}`, {qc: qc.text, file: `/exports/${failed}`, path: path.join(exportsDir, failed), mode: result.mode, stages});
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
      recordAs(outFile, 'final');
      log(`render ${id} [${result.mode}${result.master ? `, master ${result.master}` : ''}] took ${result.renderSec}s for ${expectSec.toFixed?.(1)}s of video ${JSON.stringify(stages)}`);
      return result;
    }
  };
}
