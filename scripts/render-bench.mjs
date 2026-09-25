// Render benchmark: how long an export takes on this machine, and whether
// renders in parallel beat renders one after the other. Synthetic but shaped like
// a real reel: two 1080×1920 30 fps phone-like sources (h264 with grain, so the
// decoder works), cut every ~5 s, a caption page every ~1.2 s with accents, the
// color grade on. Same queue and `remotion render` arguments as the backend
// (scripts/render-queue.mjs). Results: research/render-benchmark.md.
// It never competes with real work: it waits until no other `remotion render`
// runs on the machine (a client's export must not slow down for a benchmark).
//
//   node scripts/render-bench.mjs [--sec 69] [--renders 1] [--workers 1] [--concurrency 2] [--final]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {createQueue, renderArgs, renderPlan} from './render-queue.mjs';
import {linkPublic} from './public-links.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const BENCH = path.join(PUBLIC, 'bench'); // public/ is gitignored: fixtures never reach the repo
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1] ?? true; };
const plan = renderPlan();
const SEC = +arg('sec', 69), RENDERS = +arg('renders', 1), WORKERS = +arg('workers', plan.workers), CONC = +arg('concurrency', plan.concurrency);
const DRAFT = !process.argv.includes('--final');

function fixture(name, sec, hue) {
  const f = path.join(BENCH, `${name}.mp4`);
  if (fs.existsSync(f)) return `bench/${name}.mp4`;
  fs.mkdirSync(BENCH, {recursive: true});
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=1080x1920:r=30:d=${sec},hue=h=${hue},noise=alls=8:allf=t`, '-f', 'lavfi', '-i', `sine=f=220:d=${sec}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '16M', '-maxrate', '20M', '-bufsize', '32M', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-ar', '48000', '-shortest', '-movflags', '+faststart', `${f}.part.mp4`]);
  if (r.status !== 0) throw new Error(`fixture: ${r.stderr}`);
  fs.renameSync(`${f}.part.mp4`, f); // an interrupted run never leaves a half fixture behind
  return `bench/${name}.mp4`;
}

function project(sec) {
  const srcs = [fixture('bench-a', 60, 0), fixture('bench-b', 60, 120)];
  const clips = [];
  for (let t = 0, i = 0; t < sec - 0.1; i++) {
    const len = Math.min(5 + (i % 3) * 0.7, sec - t);
    const src = srcs[i % 2], inSec = (i * 3.1) % 50;
    clips.push({id: `k${i}`, src, inSec, outSec: inSec + len, sourceDurationSec: 60, ...(i % 2 ? {enter: 'punch'} : {})});
    t += len;
  }
  const captions = [];
  for (const c of clips) for (let ms = c.inSec * 1000; ms < c.outSec * 1000 - 600; ms += 1200) {
    const words = ['esta', 'cava', 'es', 'tuya'].map((text, k) => ({text, startMs: Math.round(ms + k * 280), endMs: Math.round(ms + k * 280 + 250), tier: k === 1 ? 1 : 0}));
    captions.push({id: `c${captions.length}`, src: c.src, startMs: words[0].startMs, endMs: words[3].endMs, topPct: 58, words});
  }
  return {clips, music: null, captions, brolls: [], graphics: [], mattes: [], accentColor: '#FFE500', captionStyle: 'palabra', brand: null, grade: {look: 'clean', intensity: 0.8, auto: false, bySrc: {}}, audio: null};
}

// someone else's export running? wait for the machine to be free
// (an export, or any ffmpeg: the client's own processing counts too)
const othersRendering = () => ['-f remotion render', '-x ffmpeg'].some((a) => spawnSync('pgrep', a.split(/ (.+)/).filter(Boolean), {encoding: 'utf8'}).stdout.trim().length > 0);
for (let waited = 0; othersRendering(); waited++) {
  if (waited % 10 === 0) console.log('another render / ffmpeg is running on this machine — waiting for it to finish');
  await new Promise((r) => setTimeout(r, 30000));
}
const props = project(SEC);
const runOne = (id) => new Promise((resolve, reject) => {
  const propsFile = path.join(ROOT, `.props-bench-${id}.json`);
  fs.writeFileSync(propsFile, JSON.stringify(props));
  const links = linkPublic(PUBLIC, path.join(ROOT, '.captions-tmp', `render-public-bench-${id}`));
  const out = path.join(ROOT, '.captions-tmp', `bench-${id}.mp4`);
  const t0 = Date.now();
  const child = spawn('npx', renderArgs({outFile: out, propsFile, publicDir: links, draft: DRAFT, concurrency: CONC, cacheBytes: plan.cacheBytes}), {cwd: ROOT});
  let tail = '', bundledAt = null;
  const on = (d) => { const s = String(d); tail = (tail + s).slice(-1500); if (bundledAt == null && /Rendered\s+\d+\//.test(s)) bundledAt = Date.now(); };
  child.stdout.on('data', on); child.stderr.on('data', on);
  child.on('close', (code) => {
    fs.rmSync(propsFile, {force: true}); fs.rmSync(links, {recursive: true, force: true}); fs.rmSync(out, {force: true});
    if (code !== 0) return reject(new Error(tail));
    resolve(results.push({id, sec: (Date.now() - t0) / 1000, setupSec: bundledAt ? (bundledAt - t0) / 1000 : null}));
  });
});

const results = [];
const t0 = Date.now();
// each render settles its own promise; the queue only decides when it starts
const q = createQueue(WORKERS, (job, id) => runOne(id).then(job.resolve, job.reject));
await Promise.all(Array.from({length: RENDERS}, (_, i) => new Promise((resolve, reject) => q.push(String(i), {resolve, reject}))));
const total = (Date.now() - t0) / 1000;
const load = os.loadavg()[0].toFixed(2);
const line = {date: new Date().toISOString(), cpus: os.cpus().length, memGB: +(os.totalmem() / 1e9).toFixed(1), videoSec: SEC, draft: DRAFT, renders: RENDERS, workers: WORKERS, concurrency: CONC, totalSec: +total.toFixed(1), perRender: results.map((r) => +r.sec.toFixed(1)), setupSec: results.map((r) => r.setupSec && +r.setupSec.toFixed(1)), load1: +load};
console.log(`${RENDERS} × ${SEC}s ${DRAFT ? 'draft' : 'final'} · ${WORKERS} worker(s) × concurrency ${CONC}: ${total.toFixed(0)} s total (${(total / RENDERS).toFixed(0)} s per reel, ${(total / RENDERS / SEC).toFixed(2)} s per video second), load ${load}`);
console.log(JSON.stringify(line));
