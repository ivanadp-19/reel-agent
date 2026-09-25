// Person mattes for the spans that need one (graphics placed BEHIND the presenter).
//
// Input : JSON (argv[2]) = {spans:[{src, startMs, endMs}]}  (source-relative)
// Output: public/mattes/<source>-<startMs>-<endMs>.webm (VP9 + alpha) per span,
//         argv[3] (public/mattes.json by hand) = [{src, startMs, endMs, file}]
// Runs scripts/matte.py (MediaPipe selfie segmenter, CPU, ~30 fps at 1080p).
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(PUBLIC, 'mattes');
const progress = (pct, label) => console.log(`PROGRESS:${pct}:${label}`);

const {spans = []} = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
fs.mkdirSync(OUT, {recursive: true});
if (!fs.existsSync(path.join(ROOT, '.models', 'selfie_segmenter.tflite'))) {
  console.error('selfie_segmenter.tflite missing — run `npm run setup`');
  process.exit(1);
}
const done = [];
spans.forEach((s, i) => {
  const key = path.basename(s.src).replace(/\.[^.]+$/, '');
  const file = `mattes/${key}-${s.startMs}-${s.endMs}.webm`;
  progress(5 + Math.round((i / spans.length) * 90), `Matting ${key} ${(s.startMs / 1000).toFixed(1)}–${(s.endMs / 1000).toFixed(1)}s`);
  if (!fs.existsSync(path.join(PUBLIC, file))) {
    const r = spawnSync('.venv/bin/python', ['scripts/matte.py', path.join(PUBLIC, s.src), String(s.startMs / 1000), String(s.endMs / 1000), path.join(PUBLIC, file)], {cwd: ROOT});
    if (r.status !== 0) { console.error(`matte failed for ${key}: ${String(r.stderr).trim().split('\n').pop()?.slice(0, 200)}`); return; }
  }
  done.push({src: s.src, startMs: s.startMs, endMs: s.endMs, file});
});
fs.writeFileSync(process.argv[3] ?? path.join(PUBLIC, 'mattes.json'), JSON.stringify(done)); // argv[3]: the backend's file for this job
progress(100, `Done — ${done.length} matte(s)`);
