// Color analysis per source: ffmpeg signalstats at 1 fps over the whole file,
// black frames ignored (an intentional black hold must not skew the average),
// → bounded automatic correction (src/grade.ts). Cached per source.
//
// Input : JSON (argv[2]) = {clips:[{src,...}]}
// Output: argv[3] (public/grade.json by hand) = {bySrc: {<src>: Grade}, stats: {<src>: Stats}}
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {autoGrade} from '../src/grade.ts';

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');
const CACHE = path.join(PUBLIC, 'clips', 'grades');
const progress = (pct, label) => console.log(`PROGRESS:${pct}:${label}`);
const KEYS = {YLOW: 'yLow', YHIGH: 'yHigh', YAVG: 'yAvg', UAVG: 'uAvg', VAVG: 'vAvg', SATAVG: 'satAvg'};

export function measure(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-an', '-vf', 'fps=1,scale=270:-2,signalstats,metadata=print:file=-', '-f', 'null', '-'], {encoding: 'utf8', maxBuffer: 1 << 26});
  if (r.status !== 0) throw new Error(`signalstats failed: ${r.stderr.trim().split('\n').pop()}`);
  const frames = [];
  let cur = null;
  for (const l of r.stdout.split('\n')) {
    if (l.startsWith('frame:')) frames.push((cur = {}));
    const m = l.match(/signalstats\.(\w+)=([\d.]+)/);
    if (m && cur && KEYS[m[1]]) cur[KEYS[m[1]]] = +m[2];
  }
  const lit = frames.filter((f) => f.yAvg > 24);
  if (!lit.length) return null; // all black
  return Object.fromEntries(Object.values(KEYS).map((k) => [k, +(lit.reduce((n, f) => n + f[k], 0) / lit.length).toFixed(2)]));
}

if (import.meta.main) {
  const {clips = []} = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  fs.mkdirSync(CACHE, {recursive: true});
  const srcs = [...new Set(clips.map((c) => c.src))];
  const out = {bySrc: {}, stats: {}};
  srcs.forEach((src, i) => {
    progress(5 + Math.round((i / srcs.length) * 90), `Analyzing color of ${path.basename(src)}`);
    const cache = path.join(CACHE, `${path.basename(src).replace(/\.[^.]+$/, '')}.json`);
    let stats = fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, 'utf8')).stats : null;
    if (!stats) {
      stats = measure(path.join(PUBLIC, src));
      fs.writeFileSync(cache, JSON.stringify({stats}));
    }
    if (!stats) return;
    out.stats[src] = stats;
    out.bySrc[src] = autoGrade(stats);
  });
  fs.writeFileSync(process.argv[3] ?? path.join(PUBLIC, 'grade.json'), JSON.stringify(out, null, 2)); // argv[3]: the backend's file for this job
  progress(100, `Done — ${Object.keys(out.bySrc).length} source(s)`);
}
