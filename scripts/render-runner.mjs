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
//   (after)     a client's version (the pair, below) is judged: the `judge` hook (the backend's: scripts/reviews.mjs
//               judgeVersion — the render judge's rules in a niced child) starts on it and the job is done
//               without waiting; the version reads 'en curso' until the judge answers (CEO-6)
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
//
// THE PAIR: a FINAL of a project with an identity (job.identity, read by the backend from
// the saved project — src/validate.ts) delivers five files next to its review version
// (src/validate.ts DELIVERABLES):
//   master         the cached master's picture + the composite's finished audio, remuxed after QC. A
//                  client's master draws no text: no caption, no text graphic (textOff, its own master
//                  key); decor graphics and the camera pushes of titles stay in it
//   captions       the caption layer as ProRes 4444 (alpha), whatever REEL_CAPTION_ALPHA says, and the
//                  same frames as a PNG sequence zipped with fps.json (captions.png.zip, CEO-14)
//   supers         the text graphics (src/graphicTemplates.ts isTextGraphic) as ProRes 4444 (alpha),
//                  a Remotion pass of their own (layer: 'supers')
//   master_supers  the master with the supers burnt in (the composite, audio copied)
// A reel with no text graphic has neither (no supers pass, no second composite): the version names them in
// `omitted`, and the pair is master + captions. An unchanged master — the same cached master and the same final audio
// (its sha256, audioHash) as an earlier version's — is that version's file, hard-linked, not a new remux.
// CAPTIONS ONLY on the client's finished export (src/layers.ts originalMaster: scope ['captions'], one whole untouched
// clip, nothing else drawn or heard): the master is the client's own file (public/clips/…) — no master pass, no
// cache, no remux, never re-encoded; hard-linked into v<n>/ and checked byte for byte (sha256, the version's `original`).
// Its rate and frame count must be the caption layer's (probed first), else the master is rendered as usual and the
// result says why (`original`). The export and the review proxy are that file + the captions.
// The export (and the review proxy) is master + supers + captions, stacked as MultiClipVideo draws
// them. It always runs layers: a reel the caption or supers layer cannot carry (a text graphic behind
// the presenter: src/layers.ts supersBlockers) fails with the reasons, never falls back to full. Every
// file must match the master frame for frame at the delivery fps (ffprobe: frames, fps, length; the zip:
// its PNG count and fps.json) and they are moved into
// reviews/<projectId>/v<n>/ under their system names with a snapshot
// of the rendered props (scripts/reviews.mjs recordVersion) and its qc: the loudness the gate measured and the
// frames / rate the files matched ({lufs, truePeak, parity: {frames, fps}}). v<n> exists only when all of
// it passed and the project still has that identity; a failure, a QC failure or a cancel
// leaves no file of the pair and no version (a backend that died mid-render: its leftovers
// go when the queue ends the job, runRender.abandon). Drafts and projects without identity
// render exactly as before.
//
// THE FPS: the props carry it (src/renderProps.ts withDeliveryFps, from the saved project) —
// 30000/1001 for a project with an identity, drafts included; none (30) for the rest. Root.tsx renders
// at it, and the caption encode, the composite, the first-frame repair and the master key use the same
// number (src/timeline.ts renderFps); the pair's parity wants the identity's rate (deliveryFps), so a job
// queued without it fails instead of delivering a client 30 fps files.
//
// A PROOF (job.kind 'proof', the queue's proof lane — POST /api/proof, the MCP's caption_proof / motion_proof):
// no export, no QC, no version. mcp/proof.mjs renders the stills (or the 24-frame strip) of the job's props in a
// child — niced (REEL_PROOF_NICE, 10) when a render holds a slot as it starts — into .captions-tmp/proof-<id>/,
// and the result names the contact sheet there ({sheet, dir, rev, …}); a failed or cancelled proof leaves nothing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {renderArgs} from './render-queue.mjs';
import {ALPHA, alphaEncodeArgs, captionArgs, codeVersion, compositeArgs, masterArgs, masterKey, masterProps, parityIssues, parityProbeArgs, parseParity, probeColor, rateOf, remuxArgs, zipFrames, zipParity} from './layers.mjs';
import {blankLead, openingReport, parseStats, repairArgs, statsArgs} from './first-frame.mjs';
import {captionLayout, chooseRenderMode, originalMaster} from '../src/layers.ts';
import {deliveryFps, renderFps, totalDurationFrames} from '../src/timeline.ts';
import {lutBakes} from '../src/grade.ts';
import {localBrollName} from './remote-broll.mjs';
import {linkPublic} from './public-links.mjs';
import {inReviewsRow, priorMaster, recordFinal, removeVersion} from './reviews.mjs';
import {datosPorConfirmar, pairIdentity, savedProject} from '../mcp/checks.mjs';
import {killTree} from './render-jobs.mjs';
import {writeRenderRecord} from './render-records.mjs';
import {oomKills, oomReason, renderEnv, signalCode} from './render-memory.mjs';

// [from, to] of the overall percentage per stage; a draft has no finalizing / review
export const STAGES = {
  final: {preparing: [0, 4], master: [4, 5], bundling: [5, 10], rendering: [10, 84], encoding: [84, 88], finalizing: [88, 96], review: [96, 99]},
  draft: {preparing: [0, 4], master: [4, 5], bundling: [5, 10], rendering: [10, 96], encoding: [96, 99.5]},
};
export const STAGE_LABEL = {preparing: 'Preparing media', master: 'Master from the cache', bundling: 'Bundling', rendering: 'Rendering', encoding: 'Encoding', compositing: 'Compositing', finalizing: 'Loudness + QC', review: 'Review proxy'};
// where each Remotion pass sits in the overall %, per mode: [from, to] (inside a pass:
// bundling the first 7 %, frames up to 95 %, the encode the rest); then compositing.
// supers: a client's deliverables render their text graphics as a pass of its own
export function passRanges({mode, captions, draft, supers = false}) {
  const end = draft ? 99 : STAGES.final.encoding[1];
  const start = STAGES.final.bundling[0];
  if (mode !== 'layers') return {render: [start, end]};
  if (!captions) return {master: [start, end]};
  if (supers) return {master: [start, 50], supers: [50, 64], captions: [64, end - 5], compositing: [end - 5, end]};
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
// line by line to onLine; resolves {code, signal, out, tail, oomDelta}; the signal kills it.
// A child that exits while something below it still holds its pipes open (Chrome left behind
// after the kernel OOM-killed the CLI) settles EXIT_GRACE_MS after its exit, its group killed.
const EXIT_GRACE_MS = 3000;
function runChild(cmd, args, {cwd, signal, onLine, onPid, env, nice = 0}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const oom0 = oomKills();
    let child;
    try { child = spawn(cmd, args, {cwd, env: env ?? process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe']}); } catch (e) { return reject(new Error(`${cmd} could not start: ${e.message}`)); }
    // before it starts anything of its own (Chrome, ffmpeg inherit it)
    if (nice > 0 && child.pid) try { os.setPriority(child.pid, nice); } catch {}
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
    // a pipe error must never become an uncaught exception in the backend
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    let killTimer = null, graceTimer = null, settled = false;
    const onAbort = () => {
      killTree(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => killTree(child.pid, 'SIGKILL'), 5000); killTimer.unref?.();
    };
    signal?.addEventListener('abort', onAbort, {once: true});
    const settle = (code, sig) => {
      if (settled) return;
      settled = true;
      onPid?.(null); // no process to watch until the next one starts (the heartbeat checks only a live pid)
      signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (buf.trim()) onLine?.(buf);
      if (signal?.aborted) return reject(signal.reason);
      const oom1 = oomKills();
      resolve({code: code ?? (sig ? signalCode(sig) : 1), signal: sig, out, tail, oomDelta: oom0 != null && oom1 != null ? oom1 - oom0 : 0});
    };
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      onPid?.(null);
      signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      reject(new Error(`${cmd} could not start: ${e.message}`));
    });
    child.on('exit', (code, sig) => {
      graceTimer = setTimeout(() => {
        killTree(child.pid, 'SIGKILL'); // its group: whatever it left behind holding the pipes
        child.stdout.destroy(); child.stderr.destroy();
        settle(code, sig);
      }, EXIT_GRACE_MS);
      graceTimer.unref?.();
    });
    child.on('close', settle);
  });
}
// a child that died of memory → the job's error names it (null: not a memory death)
const memoryFailure = (r) => oomReason({code: r.code, signal: r.signal, tail: r.tail, oomDelta: r.oomDelta});

// the defaults: the real remotion passes, ffmpeg and the real finalize; tests pass their own
const passOpts = ({outFile, propsFile, publicDir, draft, plan}) => ({outFile, propsFile, publicDir, draft, concurrency: plan.concurrency, cacheBytes: plan.cacheBytes});
export const defaultCommands = {
  render: (o) => ['npx', renderArgs(passOpts(o))],
  master: (o) => ['npx', masterArgs(passOpts(o))],
  captions: (o) => ['npx', captionArgs(passOpts(o))],
  supers: (o) => ['npx', captionArgs(passOpts(o))], // the same transparent PNG frames, its props carry layer: 'supers'
  // fps: the job's (src/timeline.ts renderFps — 30, or 29.97 for a client's deliverables), a Number
  encode: ({frames, outFile, alpha, fps}) => { const a = alphaEncodeArgs({frames, outFile, alpha, fps}); return a && ['ffmpeg', a]; }, // null: png, nothing to encode
  // layers: [{file, alpha}] over the master, bottom to top
  composite: ({master, layers, outFile, draft, fps}) => ['ffmpeg', compositeArgs({master, overlays: layers, outFile, fps, draft, color: probeColor(master)})],
  finalize: ({outFile, expectSec, clean}) => ['node', ['scripts/qc.mjs', '--finalize', outFile, String(expectSec), String(clean)]],
  // the blank-first-frame guard (scripts/first-frame.mjs): stats of frames 0–2 on stdout, and the repair
  frameStats: ({file}) => ['ffmpeg', statsArgs(file)],
  fixFirstFrame: ({file, outFile, draft, fps}) => ['ffmpeg', repairArgs({file, outFile, fps, color: probeColor(file), draft})],
  // the pair: the master deliverable remuxed, and each file's frames / rate / length
  remux: (o) => ['ffmpeg', remuxArgs(o)],
  probe: ({file}) => ['ffprobe', parityProbeArgs(file)],
  // the sha256 of a file's audio packets ("SHA256=…"): the final audio a master is remuxed with (an unchanged master is linked)
  audioHash: ({file}) => ['ffmpeg', ['-hide_banner', '-v', 'error', '-i', file, '-map', '0:a:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-']],
  // a proof: the stills / strip of spec.json ({what, times | atSec, props}) → result.json next to it
  proof: ({spec}) => ['node', ['mcp/proof.mjs', spec]],
};
// 10, not the judge's 15: an agent waits on a proof — at 15 one next to a CPU-bound final gets ~3 % of a core (weight 36
// vs 1024) and would run into REEL_PROOF_TIMEOUT_SEC; at 10 ~10 % (110)
const PROOF_NICE = Math.min(19, Math.max(0, +(process.env.REEL_PROOF_NICE ?? 10) || 0));
const sha256Of = async (file) => { const h = crypto.createHash('sha256'); for await (const b of fs.createReadStream(file)) h.update(b); return h.digest('hex'); };

// What a render will do, said before it is queued (POST /api/render answers with it,
// `reel render start` prints it): full or layers, and whether it is a complete render —
// one pass, or the master rendered again — and why. The job's own decisions:
// chooseRenderMode, then the master key of the props as prepare() will leave them
// (remote B-roll under its local name; a download or a LUT bake still to do changes
// them, so the master is rendered again), then the master cache.
// pair (a final of a project with an identity): it never falls back to full, so where the
// layers cannot run the plan says the render fails ({fails: true, reasons}) — the backend refuses it.
// scope (the saved project's): a captions-only job on the client's own export takes that file as its master
// ({master: 'original'}, src/layers.ts originalMaster) — no master to render, none to cache.
export function planRender(props, {requested = 'full', draft = false, root, publicDir, masterCache = null, pair = false, scope = null, keyOf = (p, o) => masterKey(p, {code: codeVersion(root), fps: renderFps(p), draft: o.draft, publicDir})} = {}) {
  if (requested !== 'layers' && !pair) return {mode: 'full', full: true, reasons: ['mode full: one pass over everything (mode layers reuses the cached master when only the captions change)']};
  const cannot = (reasons) => (pair ? {mode: 'layers', full: true, fails: true, reasons} : {mode: 'full', full: true, reasons});
  const choice = chooseRenderMode('layers', props, renderFps(props), {supers: pair});
  if (choice.mode === 'full') return cannot(choice.reasons);
  if (pair && originalMaster(props, scope, renderFps(props)).src) return {mode: 'layers', full: false, master: 'original', captions: true, reasons: ['captions only on the client\'s own export: that file is the master, never re-rendered or re-encoded (its rate and frame count are checked when the job runs)']};
  if (!masterCache) return cannot(['no master cache on this backend']);
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
  if (!reasons.length && !fs.existsSync(masterCache.file(keyOf(masterProps({...props, brolls}, {text: !pair}), {draft})))) reasons.push('no cached master for this cut: its first layered render, or something besides the captions changed (clips, trims, B-roll, graphics, music, grade…)');
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
  chooseMode = (requested, props, opts) => chooseRenderMode(requested, props, renderFps(props), opts), // opts {supers}: a client's deliverables
  keyOf = (props, {draft}) => masterKey(props, {code: codeVersion(root), fps: renderFps(props), draft, publicDir}),
  logStage = () => {}, // (project, stage, ms, extra) → the project's timing log
  commands = defaultCommands,
  record = recordFinal,
  unrecord = ({projectId, v}) => inReviewsRow(reviewsDir, projectId, () => removeVersion(reviewsDir, projectId, v, publicDir)), // a version recorded by a job cancelled meanwhile
  identityNow = (projectId) => pairIdentity(path.join(publicDir, 'projects'), projectId), // the saved project's identity when the pair is recorded
  judge = null, // ({projectId, v}) → the judge on a client's new version, not awaited (the backend: scripts/reviews.mjs judgeVersion)
  env = () => process.env, // the transcript engine's env: the backend passes its ROOT .env + process env, as validate reads it
  // the rendered graphics' data its own audio does not say (the saved project's language and off-mic mode pick the transcript)
  toConfirm = (projectId, props) => datosPorConfirmar({...savedProject(path.join(publicDir, 'projects'), projectId), ...props}, publicDir, env()),
  writeRecord = writeRenderRecord, // (mp4, {projectId, kind, renderSec}) → <mp4>.json, what scripts/cleanup-exports.mjs reads
  log = (m) => console.log(m),
  now = Date.now,
  childEnv = renderEnv(), // the Remotion passes' env: NODE_OPTIONS with the heap cap (scripts/render-memory.mjs)
} = {}) {
  fs.mkdirSync(exportsDir, {recursive: true});
  commands = {...defaultCommands, ...commands};
  const inflight = new Map(); // master key → the promise of the job of this backend rendering it (single flight)
  // what a run of a job leaves when its backend dies before the finally below (the queue calls it when
  // it ends such a job — scripts/render-jobs.mjs abandon): the pair's temp and the review proxy's under
  // reviews/<projectId>/, and its `.part-…-<id>.mp4` files next to the cached masters (GBs, never trimmed)
  runRender.abandon = (job) => {
    if (job.projectId) for (const f of [`.tmp-pair-${job.id}`, `.tmp-${job.id}.mp4`, `.tmp-${job.id}.jpg`]) fs.rmSync(path.join(reviewsDir, path.basename(job.projectId), f), {recursive: true, force: true});
    let names = [];
    try { names = fs.readdirSync(masterCache?.dir); } catch {}
    for (const n of names) if (n.includes('.part-') && n.endsWith(`-${job.id}.mp4`)) fs.rmSync(path.join(masterCache.dir, n), {force: true});
    for (const k of ['captions', 'supers']) fs.rmSync(path.join(os.tmpdir(), `reel-${k}-${job.id}`), {recursive: true, force: true}); // the layers' PNG frames
    fs.rmSync(path.join(tmpDir, `proof-${job.id}`), {recursive: true, force: true}); // a proof's stills
  };
  return runRender;
  async function runProof(job, ctx) {
    const t0 = now();
    const out = path.join(tmpDir, `proof-${job.id}`);
    try {
      fs.rmSync(out, {recursive: true, force: true}); // an earlier attempt's (re-queued after its backend died)
      fs.mkdirSync(out, {recursive: true});
      const spec = path.join(out, 'spec.json');
      fs.writeFileSync(spec, JSON.stringify({...job.proof, props: JSON.parse(ctx.props)}));
      ctx.update({stage: 'bundling', label: 'Proof: bundling', progress: 5});
      const [cmd, args] = commands.proof({spec, out});
      // ponytail: niced when it starts; a final that starts after it finds it at normal priority for its minute or two
      // (renice its tree from the heartbeat if that ever shows)
      const r = await runChild(cmd, args, {cwd: root, signal: ctx.signal, onPid: ctx.setPid, env: childEnv, nice: ctx.renderBusy?.() ? PROOF_NICE : 0, onLine: (l) => {
        const m = /^still (\d+)\/(\d+)/.exec(l);
        if (m) ctx.update({stage: 'rendering', label: `Proof: still ${m[1]}/${m[2]}`, progress: Math.round(10 + (85 * m[1]) / m[2]), frames: {done: +m[1], total: +m[2]}});
      }});
      if (r.code !== 0) {
        const oom = memoryFailure(r);
        throw Object.assign(new Error(oom ?? `proof failed (exit ${r.code}): ${r.tail.trim().split('\n').slice(-3).join(' | ')}`.slice(0, 400)), oom ? {code: 'OOM'} : {});
      }
      const res = JSON.parse(fs.readFileSync(path.join(out, 'result.json'), 'utf8'));
      return {...res, dir: out, rev: job.proof?.rev ?? null, renderSec: Math.round((now() - t0) / 100) / 10};
    } catch (e) {
      fs.rmSync(out, {recursive: true, force: true});
      throw e;
    }
  }
  async function runRender(job, ctx) {
    if (job.kind === 'proof') return runProof(job, ctx);
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
    // the pair (see the top): its identity, and its files until the version takes them — the layers
    // (captions and its PNG zip, supers), the remuxed master and master_supers in reviews/<projectId>/.tmp-pair-<id>/ (the filesystem of v<n>/), the
    // master held by a hard link next to the cache's (`.part-` keeps another job's trim off it)
    const pair = !draft && job.projectId && job.identity?.client ? job.identity : null;
    const pairTmp = pair ? path.join(reviewsDir, job.projectId, `.tmp-pair-${id}`) : null;
    // an earlier attempt's (re-queued after its backend died, no finally ran): its master.mp4 can be a hard link to an
    // earlier version's master or to the client's clip — never written through (ffmpeg -y truncates the inode in place)
    if (pairTmp) fs.rmSync(pairTmp, {recursive: true, force: true});
    let hold = null, pairKey = null, pairLayer = null, pairPng = null, pairMaster = null, pairSupers = null, pairMasterSupers = null, pairParity = null, pairAudio = null, pairOriginal = null;
    // cancelled: no file of this job stays in exports/, no version of it stays in reviews/
    const cleanUp = async () => {
      let names = [];
      try { names = fs.readdirSync(exportsDir); } catch {}
      for (const f of names) if (f.startsWith(`edited-${id}`) && /\.mp4(\.json)?$/.test(f)) fs.rmSync(path.join(exportsDir, f), {force: true});
      if (recorded) { try { await unrecord(recorded); } catch (e) { log(`render ${id}: could not take back review version v${recorded.v}: ${e.message}`); } }
    };
    // which project an export belongs to and what it is (final | draft | qcfail); a missing record only costs the cleanup's help
    const recordAs = (file, kind) => {
      try { writeRecord(file, {projectId: job.projectId ?? null, kind, renderSec: result.renderSec}); } catch (e) { log(`render ${id}: no render record: ${e.message}`); }
    };
    // a final that cannot ship: kept as *-qcfail.mp4 for inspection (cleanup-exports purges it after its TTL) → its name
    const shelve = () => {
      const failed = outName.replace(/\.mp4$/, '-qcfail.mp4');
      try { fs.renameSync(outFile, path.join(exportsDir, failed)); recordAs(path.join(exportsDir, failed), 'qcfail'); } catch {}
      return failed;
    };
    try {
      return await work();
    } catch (e) {
      if (signal.aborted) await cleanUp();
      throw e;
    } finally {
      // moved into reviews/<projectId>/v<n>/ when it became a version; otherwise nothing of the pair stays
      if (pairTmp) fs.rmSync(pairTmp, {recursive: true, force: true});
      if (hold) fs.rmSync(hold, {force: true});
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
      const fps = renderFps(props); // every pass, encode and composite at the one rate (Root.tsx reads the same props)

      const choice = chooseMode(pair || job.mode === 'layers' ? 'layers' : 'full', props, {supers: !!pair});
      // a captions-only job on the client's own export: that file is the master (src/layers.ts originalMaster) — no master
      // pass, no cache; its rate and frame count are checked before it is taken (below)
      const orig = pair ? originalMaster(props, savedProject(path.join(publicDir, 'projects'), job.projectId).scope, fps) : null;
      // the pair IS the layers: a reel they cannot carry fails with the reasons, never falls back to full
      if (pair && (choice.mode !== 'layers' || (!masterCache && !orig.src))) throw new RenderError(`deliverables need the layered render: ${(choice.reasons?.length ? choice.reasons : ['no master cache on this backend']).join('; ')}`);
      result.mode = choice.mode;
      if (choice.reasons?.length) { result.fallback = choice.reasons; log(`render ${id}: layers → full (${choice.reasons.join('; ')})`); }
      const layered = choice.mode === 'layers' && (masterCache || orig?.src);
      if (choice.mode === 'layers' && !layered) { result.mode = 'full'; result.fallback = ['no master cache on this backend']; }
      // the pair always has its caption layer — a transparent one when no caption is on screen (MultiClipVideo)
      const captions = choice.captions || !!pair;
      // the pair's master draws no text; its text graphics (the same list the supers layer draws) are the supers — a reel
      // with none has no supers layer and no master_supers (it would be the master): both left out, the version says why
      const mProps = masterProps(props, {text: !pair});
      const supersDrawn = !!pair && captionLayout(props, fps).supers.length > 0;
      const ranges = passRanges({mode: layered ? 'layers' : 'full', captions, draft, supers: supersDrawn});

      // public/ as symlinks: the CLI would otherwise copy every clip, matte and earlier export into its bundle
      const links = linkPublic(publicDir, path.join(tmpDir, `render-public-${id}`));
      const tmp = [links]; // removed whatever happens: props files, the master's .part, the caption (and supers) frames
      const propsFile = (name, p) => { const f = path.join(root, `.props-${id}${name}.json`); fs.writeFileSync(f, JSON.stringify(p)); tmp.push(f); return f; };
      // one Remotion pass: progress mapped into its range, frames and an ETA, the pid watched
      const pass = async (kind, range, outPath, pProps, what) => {
        set('bundling', 0, {progress: inPass(range, 'bundling', 0), label: `Bundling${what ? ` (${what})` : ''}`});
        let firstFrameAt = null, lastErr = '';
        const [cmd, args] = commands[kind]({outFile: outPath, propsFile: propsFile(kind === 'render' ? '' : `-${kind}`, pProps), publicDir: links, draft, plan, id});
        const r = await runChild(cmd, args, {
          cwd: root, signal, onPid: ctx.setPid, env: childEnv,
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
          const oom = memoryFailure(r);
          if (oom) { log(`render ${id} ${kind}: ${oom}`); throw Object.assign(new RenderError(oom), {code: 'OOM'}); }
          throw new RenderError(lastErr.slice(0, 300) || (r.signal ? `the render process was killed (${r.signal})` : `render exited ${r.code}`));
        }
      };
      const ffmpeg = async (argv, what) => {
        const r = await runChild(argv[0], argv[1], {cwd: root, signal, onPid: ctx.setPid});
        const oom = r.code !== 0 && memoryFailure(r);
        if (oom) throw Object.assign(new RenderError(`${what}: ${oom}`), {code: 'OOM'});
        if (r.code !== 0) throw new RenderError(`${what} failed: ${r.tail.trim().split('\n').pop() ?? ''}`.slice(0, 300));
      };
      // the pair's parity: a file's frames, rate and length (ffprobe, header only)
      const probeOf = async (file) => {
        const [pcmd, pargs] = commands.probe({file});
        const r = await runChild(pcmd, pargs, {cwd: root, signal, onPid: ctx.setPid});
        if (r.code !== 0) throw new RenderError(`cannot probe ${path.basename(file)}: ${r.tail.trim().split('\n').pop() ?? ''}`.slice(0, 300));
        return parseParity(r.out);
      };
      // the sha256 of a file's audio packets (null when it cannot be read: the master is remuxed as always)
      const audioHashOf = async (file) => {
        const [hcmd, hargs] = commands.audioHash({file});
        const r = await runChild(hcmd, hargs, {cwd: root, signal, onPid: ctx.setPid});
        return r.code === 0 ? r.out.match(/SHA256=([0-9a-f]{64})/)?.[1] ?? null : null;
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
        await timed('first-frame', () => ffmpeg(commands.fixFirstFrame({file, outFile: fixed, draft, fps}), 'first-frame repair'));
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
          // ---- a captions-only job: the client's own file, when it lays frame for frame under the caption layer ----
          let original = null;
          if (orig?.src) {
            const abs = path.join(publicDir, orig.src), want = totalDurationFrames(props.clips, fps);
            const m = fs.existsSync(abs) ? await probeOf(abs) : null;
            // the composition's size (src/Root.tsx), square pixels: compositeArgs lays the layer over at the file's own size
            const size = m && (m.w !== 1080 || m.h !== 1920 || !['1:1', '0:1', null].includes(m.sar)) ? `${orig.src} is ${m.w}x${m.h}${m.sar && m.sar !== '1:1' ? ` (SAR ${m.sar})` : ''}, the composition 1080x1920` : null;
            if (m && !size && Math.abs(rateOf(m.fps) - fps) < 1e-6 && m.frames === want) original = {src: orig.src, abs};
            else {
              result.original = `not the master: ${!m ? `${orig.src} is missing` : size ?? `${orig.src} is ${m.frames} frames at ${m.fps}, the caption layer ${want} at ${fps}`}`;
              log(`render ${id}: ${result.original} — the master is rendered`);
              if (!masterCache) throw new RenderError(`deliverables need the layered render: ${result.original}; no master cache on this backend`);
            }
          }
          // ---- the master: cached, being rendered by another job here (wait for it), or rendered now ----
          const key = original ? null : keyOf(mProps, {draft});
          const renderMaster = async () => {
            const part = path.join(masterCache.dir, `${key}.part-${id}.mp4`);
            tmp.push(part);
            await timed('master', () => pass('master', ranges.master, part, mProps, 'master'), {videoSec: expectSec});
            stop(); // a cancelled master never enters the cache
            await guardFirstFrame(part, 'master'); // a cached master is always a repaired one
            return masterCache.put(key, part);
          };
          let master = original?.abs ?? null;
          if (original) { result.master = 'original'; set('master', 1, {progress: ranges.master[1], label: 'The client\'s own file is the master (captions only)'}); }
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
          result.masterFile = master; // the reel without captions: the render judge's grade-coverage measures there (--clean)
          // the pair's master, held until the remux after QC (a copy where hard links are not possible)
          if (pair && !original) {
            hold = path.join(masterCache.dir, `${key}.part-pair-${id}.mp4`); pairKey = key;
            fs.rmSync(hold, {force: true}); // an earlier attempt's (re-queued after a crash)
            try { fs.linkSync(master, hold); } catch { await abortable(fs.promises.copyFile(master, hold)); }
          }
          if (original) pairOriginal = {src: original.src, abs: original.abs};
          if (supersDrawn) {
            // its supers: the text graphics on a transparent layer of their own (ProRes 4444), laid under the captions
            const frames = path.join(os.tmpdir(), `reel-supers-${id}`);
            tmp.push(frames);
            await timed('supers', () => pass('supers', ranges.supers, frames, {...props, layer: 'supers'}, 'supers layer'));
            fs.mkdirSync(pairTmp, {recursive: true});
            pairSupers = path.join(pairTmp, 'supers.mov');
            set('compositing', 0, {progress: ranges.supers[1], label: 'Encoding supers layer (prores)'});
            await timed('supers-encode', () => ffmpeg(commands.encode({frames, outFile: pairSupers, alpha: 'prores', fps}), 'supers layer encode'));
          }
          if (captions) {
            // Remotion reads any dot in a sequence folder's path as an extension and refuses it (.captions-tmp would): the OS temp dir
            const frames = path.join(os.tmpdir(), `reel-captions-${id}`);
            tmp.push(frames);
            await timed('captions', () => pass('captions', ranges.captions, frames, {...props, layer: 'captions'}, 'captions layer'));
            let layer = frames;
            // the pair delivers the layer itself: ProRes 4444 with its alpha, kept past this block
            const alpha = pair ? 'prores' : captionAlpha;
            const ext = ALPHA[alpha]?.ext;
            if (pair) fs.mkdirSync(pairTmp, {recursive: true});
            const enc = ext && commands.encode({frames, outFile: (layer = pair ? path.join(pairTmp, `captions.${ext}`) : `${frames}.${ext}`), alpha, fps});
            if (pair) pairLayer = layer;
            if (enc) {
              if (!pair) tmp.push(layer);
              set('compositing', 0, {progress: ranges.compositing[0], label: `Encoding captions layer (${alpha})`});
              await timed('encode', () => ffmpeg(enc, 'captions layer encode'));
            }
            // and the same frames as the PNG sequence (CEO-14), zipped with the rate to import them at
            if (pair) {
              pairPng = path.join(pairTmp, 'captions.png.zip');
              set('compositing', 0, {progress: ranges.compositing[0], label: 'Packing the captions PNG sequence'});
              await timed('captions-png', () => abortable(zipFrames(frames, pairPng, {fps})));
            }
            set('compositing', 0.5, {progress: Math.round((ranges.compositing[0] + ranges.compositing[1]) / 2), label: 'Compositing', frames: undefined, etaSec: undefined});
            // bottom to top as MultiClipVideo stacks them: the master, the supers (the pair's), the captions
            const layers = [...(pairSupers ? [{file: pairSupers, alpha: 'prores'}] : []), {file: layer, alpha}];
            await timed('composite', () => ffmpeg(commands.composite({master, layers, outFile, draft, fps}), 'composite'));
          } else await abortable(fs.promises.copyFile(master, outFile)); // nothing to lay over it: the master is the reel
          // what ships: the composite or the copy (a caption on frame 0 can hide a flat field from this check — hence the master's own)
          await guardFirstFrame(outFile, captions ? 'composite' : 'export');
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
        const oom = fin.code !== 0 && memoryFailure(fin);
        if (oom) throw Object.assign(new RenderError(`loudness + QC: ${oom}`), {code: 'OOM'});
        try { qc = JSON.parse(fin.out.trim().split('\n').pop()); } catch { qc = {ok: false, error: 'QC did not report', checks: [], text: ''}; }
        if (!qc.ok) throw new Error('qc'); // logged as ok: false
      }).catch((e) => { if (signal.aborted || !qc) throw e; });
      result.qc = qc.text;
      result.renderSec = Math.round((now() - t0) / 1000);
      if (!qc.ok) {
        // kept as *-qcfail.mp4 for inspection, reported as a failure
        const failed = shelve();
        const why = [qc.error, ...(qc.checks ?? []).filter((c) => !c.ok && c.blocking).map((c) => `${c.name} ${c.value}, want ${c.want}`)].filter(Boolean).join('; ');
        throw new RenderError(`QC failed (kept as /exports/${failed}): ${why}`, {qc: qc.text, file: `/exports/${failed}`, path: path.join(exportsDir, failed), mode: result.mode, stages});
      }
      stop();
      // ---- a final that passed QC for a project becomes its next review version ----
      if (job.projectId) {
        set('review', 0, {etaSec: 10, ...(pair ? {label: 'Deliverables: master + final audio, master + supers, parity'} : {})});
        try {
          if (pair) await timed('pair', async () => {
            pairMaster = path.join(pairTmp, 'master.mp4');
            if (pairOriginal) {
              // captions only: the client's file itself — a hard link (a copy across filesystems), checked byte for byte
              try { fs.linkSync(pairOriginal.abs, pairMaster); } catch { await abortable(fs.promises.copyFile(pairOriginal.abs, pairMaster)); }
              const [a, b] = await abortable(Promise.all([sha256Of(pairOriginal.abs), sha256Of(pairMaster)]));
              if (a !== b) throw new RenderError(`the master is not ${pairOriginal.src} byte for byte`);
              pairOriginal = {src: pairOriginal.src, sha256: a, bytes: fs.statSync(pairMaster).size};
            } else {
              // an unchanged master (the same cached master, the same final audio as an earlier version's): that file,
              // linked — no remux of a new one (scripts/reviews.mjs priorMaster)
              pairAudio = await audioHashOf(outFile);
              const prior = priorMaster(reviewsDir, job.projectId, publicDir, {masterKey: pairKey, audioHash: pairAudio});
              let linked = false;
              if (prior) try { fs.linkSync(prior, pairMaster); linked = true; result.masterLinked = path.relative(publicDir, prior).split(path.sep).join('/'); } catch {}
              if (!linked) await ffmpeg(commands.remux({video: hold, audio: outFile, outFile: pairMaster}), 'master remux');
            }
            // master_supers: the supers burnt into that master (its final audio copied) — none without a text graphic
            if (supersDrawn) {
              pairMasterSupers = path.join(pairTmp, 'master_supers.mp4');
              await ffmpeg(commands.composite({master: pairMaster, layers: [{file: pairSupers, alpha: 'prores'}], outFile: pairMasterSupers, draft: false, fps}), 'master + supers composite');
            }
            // every file against the master, at the client's rate whatever the props said
            const m = await probeOf(pairMaster), bad = new Set();
            pairParity = {frames: m.frames, fps: m.fps};
            for (const [name, file] of [['captions', pairLayer], ['captions.png.zip', pairPng], ['supers', pairSupers], ['master_supers', pairMasterSupers]].filter(([, f]) => f)) {
              for (const x of parityIssues(m, file === pairPng ? await zipParity(file) : await probeOf(file), {name, fps: deliveryFps({identity: pair})})) bad.add(x);
            }
            if (bad.size) throw new RenderError(`deliverables parity failed: ${[...bad].join('; ')}`);
          });
          // the names are the identity the job was submitted under: still the project's when the version is numbered
          // (checked in the reviews row), or another project may hold them by now
          const verify = () => {
            const cur = identityNow(job.projectId);
            if (JSON.stringify(cur) !== JSON.stringify(pair)) throw new RenderError(`the project's identity changed during the render (${cur ? JSON.stringify(cur) : 'none now'}): render again`);
          };
          let datos;
          try { datos = toConfirm(job.projectId, props); } catch (e) { log(`render ${id}: datos por confirmar not checked: ${e.message}`); }
          const deliverables = Object.fromEntries(Object.entries({master: pairMaster, captions: pairLayer, captionsPng: pairPng, supers: pairSupers, masterSupers: pairMasterSupers}).filter(([, f]) => f));
          const omitted = supersDrawn ? null : {supers: 'el reel no tiene gráficos de texto', masterSupers: 'sin supers sería el mismo master'};
          const v = await record({draft, qcOk: true, projectId: job.projectId, outFile, dir: reviewsDir, publicDir, jobId: id, signal, ...(datos?.length ? {datosPorConfirmar: datos} : {}), ...(pair ? {deliverables, omitted, original: pairOriginal, audioHash: pairAudio, identity: pair, snapshot: props, masterKey: pairKey, qc: {lufs: qc.lufs ?? null, truePeak: qc.truePeak ?? null, parity: pairParity}, verify} : {})});
          if (v) { recorded = {projectId: job.projectId, v: v.v}; result.version = v.v; result.projectId = job.projectId; if (v.deliverables) result.deliverables = v.deliverables; }
        } catch (e) {
          stop(); // cancelled while the proxy was made: not a version error, a cancel
          const why = String(e?.message ?? e).slice(0, 200);
          // a pair job without its pair and its version is not done (the render stays as a qcfail, never an unrecorded final)
          if (pair) {
            const failed = shelve();
            throw new RenderError(`no deliverables, no version: ${why} (the render is kept as /exports/${failed})`, {qc: qc.text, file: `/exports/${failed}`, path: path.join(exportsDir, failed), mode: result.mode, stages});
          }
          result.versionError = why;
        }
        stop(); // the cancel came in while it was being recorded: cleanUp takes the version back
        // past the last cancel point: the client's version is judged in the background (never awaited here)
        if (pair && recorded && judge) Promise.resolve().then(() => judge(recorded)).catch((e) => log(`render ${id}: the judge of v${recorded.v} did not start: ${e?.message ?? e}`));
      }
      recordAs(outFile, 'final');
      log(`render ${id} [${result.mode}${result.master ? `, master ${result.master}` : ''}] took ${result.renderSec}s for ${expectSec.toFixed?.(1)}s of video ${JSON.stringify(stages)}`);
      return result;
    }
  }
}
