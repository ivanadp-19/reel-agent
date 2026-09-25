// Final-render audio + QC gate.
//   normalizeLoudness(file): two-pass EBU R128 loudnorm to −14 LUFS / −1.5 dBTP
//     (margin under the −1 dBTP gate for the AAC re-encode), video stream copied.
//   qc(file, {expectSec, draft}): blocking checks (loudness, true peak, audio present,
//     frame size, duration) + warnings (black or silent stretches).
//   CLI: node scripts/qc.mjs <file.mp4> [expectSec]
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

export const TARGET = {I: -14, tolerance: 1, TP: -1, tpAim: -1.5, LRA: 11};

// optional voice cleanup before loudness (final render only): src/audio.ts
import {CLEAN} from '../src/audio.ts';
import {blankLead, frameStats} from './first-frame.mjs';
export {CLEAN};

const ff = (args) => spawnSync('ffmpeg', ['-hide_banner', '-nostats', ...args], {encoding: 'utf8', maxBuffer: 1 << 26});

// EBU R128 measurement (loudnorm analysis pass); null when there is no audio stream
export function measureLoudness(file) {
  const r = ff(['-i', file, '-vn', '-af', `loudnorm=I=${TARGET.I}:TP=${TARGET.tpAim}:LRA=${TARGET.LRA}:print_format=json`, '-f', 'null', '-']);
  const m = r.stderr.match(/\{[^{}]*"input_i"[^{}]*\}/);
  if (!m) return null;
  const j = JSON.parse(m[0]);
  const num = (v) => (v === '-inf' ? -Infinity : v === 'inf' ? Infinity : parseFloat(v));
  return {I: num(j.input_i), TP: num(j.input_tp), LRA: num(j.input_lra), thresh: num(j.input_thresh), offset: num(j.target_offset)};
}

// Two passes: measure, then apply with the measured values (linear gain when
// possible; a source that already clips makes loudnorm limit instead). The
// encoded result is measured again: AAC overshoot and the limiter's own slack
// can leave the true peak above the gate (pruebaeditoria: aim −1.5, got −0.7),
// so the aim is lowered by the excess and the pass repeated, at most twice.
export function normalizeLoudness(file, clean = 'off') {
  const pre = CLEAN[clean]?.af ? `${CLEAN[clean].af},` : '';
  const before = measureLoudness(file);
  if (!before || !Number.isFinite(before.I)) return {ok: false, error: before ? 'the audio is silent' : 'no audio stream'};
  let m = before, aim = TARGET.tpAim;
  const passes = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const tmp = file.replace(/\.mp4$/, '.loudnorm.mp4');
    // the cleanup runs once (first pass); later passes only re-normalize
    const af = `${attempt === 0 ? pre : ''}loudnorm=I=${TARGET.I}:TP=${aim.toFixed(1)}:LRA=${TARGET.LRA}:measured_I=${m.I}:measured_TP=${m.TP}:measured_LRA=${m.LRA}:measured_thresh=${m.thresh}:offset=${m.offset}:linear=true`;
    const r = ff(['-y', '-i', file, '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-af', af, '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp]);
    if (r.status !== 0) { fs.rmSync(tmp, {force: true}); return {ok: false, error: `loudnorm failed: ${r.stderr.trim().split('\n').pop()}`}; }
    fs.renameSync(tmp, file);
    m = measureLoudness(file);
    passes.push({aim, I: m.I, TP: m.TP});
    if (m.TP <= TARGET.TP) break;
    aim -= m.TP - TARGET.TP + 0.4;
  }
  return {ok: true, before, after: m, passes};
}

function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate:format=duration', '-of', 'json', file], {encoding: 'utf8'});
  if (r.status !== 0) return null;
  return JSON.parse(r.stdout);
}
// stretches of [start, end] seconds reported by blackdetect / silencedetect
function stretches(args, re) {
  const out = [];
  for (const m of ff(args).stderr.matchAll(re)) out.push([+m[1], +m[2]]);
  return out;
}

export function qc(file, {expectSec, draft = false} = {}) {
  const checks = [];
  const add = (name, ok, value, want, blocking = true) => checks.push({name, ok, value, want, blocking});
  const info = fs.existsSync(file) ? probe(file) : null;
  if (!info) return {ok: false, checks: [{name: 'file', ok: false, value: 'unreadable', want: 'an mp4', blocking: true}]};
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  const dur = +info.format.duration;
  const [W, H] = draft ? [540, 960] : [1080, 1920];
  add('frame', v?.width === W && v?.height === H, v ? `${v.width}x${v.height}` : 'no video', `${W}x${H}`);
  if (expectSec != null) add('duration', Math.abs(dur - expectSec) <= 0.2, `${dur.toFixed(2)} s`, `${expectSec.toFixed(2)} s ±0.2`);
  add('audio', !!a, a ? `${a.codec_name} ${a.sample_rate} Hz` : 'none', 'an audio track');
  if (a) {
    const m = measureLoudness(file);
    const I = m?.I ?? -Infinity, TP = m?.TP ?? Infinity;
    add('loudness', Math.abs(I - TARGET.I) <= TARGET.tolerance, Number.isFinite(I) ? `${I.toFixed(1)} LUFS` : 'silent', `${TARGET.I} ±${TARGET.tolerance} LUFS`, !draft);
    add('true peak', TP <= TARGET.TP, Number.isFinite(TP) ? `${TP.toFixed(1)} dBTP` : '?', `≤ ${TARGET.TP} dBTP`, !draft);
    const silent = stretches(['-i', file, '-vn', '-af', 'silencedetect=noise=-50dB:d=2', '-f', 'null', '-'], /silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g);
    add('silence', !silent.length, silent.length ? silent.map(([s, e]) => `${s.toFixed(1)}–${e.toFixed(1)} s`).join(', ') : 'none ≥ 2 s', 'no silent stretch ≥ 2 s', false);
  }
  const black = stretches(['-i', file, '-an', '-vf', 'blackdetect=d=0.5:pix_th=0.08', '-f', 'null', '-'], /black_start:([\d.]+) black_end:([\d.]+)/g);
  // frame 0 a flat field while frame 1 is footage (scripts/first-frame.mjs; the render runner repairs it, this is the gate)
  const lead = frameStats(file);
  add('first frame', !blankLead(lead), lead[0] ? `Y ${lead[0].ymin}–${lead[0].ymax}, U ${lead[0].uavg}, V ${lead[0].vavg}` : 'unreadable', 'footage (not a flat field before the first real frame)', !draft);
  add('black', !black.length, black.length ? black.map(([s, e]) => `${s.toFixed(1)}–${e.toFixed(1)} s`).join(', ') : 'none ≥ 0.5 s', 'no black stretch ≥ 0.5 s (fine when intended)', false);
  return {ok: checks.every((c) => c.ok || !c.blocking), checks};
}

export const qcText = (r) => r.checks.map((c) => `${c.ok ? '✓' : c.blocking ? '✗' : '!'} ${c.name}: ${c.value}${c.ok ? '' : ` (want ${c.want})`}`).join('\n');

// CLI:
//   node scripts/qc.mjs <file.mp4> [expectSec]              → report, exit 1 on failure
//   node scripts/qc.mjs --json <file.mp4> [expectSec] [--draft] → QC only; JSON on stdout
//   node scripts/qc.mjs --finalize <file.mp4> <expectSec>   → normalize, then QC; JSON on stdout
//     (the backend runs this as a child process so its event loop never blocks)
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args[0] === '--json') { // node scripts/qc.mjs --json <file.mp4> [expectSec] [--draft] → the qc() report as JSON (the MCP qc tool)
    const [, file, expect, flag] = args;
    console.log(JSON.stringify(qc(path.resolve(file), {expectSec: expect ? +expect : undefined, draft: flag === '--draft'})));
    process.exit(0);
  }
  if (args[0] === '--finalize') {
    const [, file, expect, clean] = args;
    const ln = normalizeLoudness(path.resolve(file), clean && clean in CLEAN ? clean : 'off');
    const report = qc(path.resolve(file), {expectSec: expect ? +expect : undefined});
    console.log(JSON.stringify({ok: ln.ok && report.ok, error: ln.ok ? null : ln.error, checks: report.checks, text: qcText(report)}));
    process.exit(0);
  }
  const [file, expect] = args;
  const r = qc(path.resolve(file), {expectSec: expect ? +expect : undefined, draft: /-draft\.mp4$/.test(file)});
  console.log(qcText(r));
  process.exit(r.ok ? 0 : 1);
}
