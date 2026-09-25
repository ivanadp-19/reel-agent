// LUT jobs (the backend's /api/lut, shared by set_grade / create_lut and the Styles tab):
//
//   {bake: [{key, src, lut, mix}]}   bake a .cube into a graded copy of each file
//     (public/clips/lut/<name>-<hash>.mp4 or .webm for person mattes, alpha kept),
//     cached by content; → public/lut.json {baked: {key: file}}
//   {make: {name, refs: [public paths], clips: [{src}], strength}}  make a .cube
//     from reference photos: the footage's color statistics (frames of the
//     project's clips) matched to the references' (src/lut.ts) → public/luts/<name>.cube;
//     → public/lut.json {lut: 'luts/<name>.cube'}
//
// Input: JSON (argv[2]); output file argv[3] (default public/lut.json). Deterministic ffmpeg + math, no model, no network.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {cubeFromReferences, labStats, mixCube, parseCube} from '../src/lut.ts';

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(PUBLIC, 'clips', 'lut');
const progress = (pct, label) => console.log(`PROGRESS:${pct}:${label}`);
const inPublic = (rel) => {
  const abs = path.resolve(PUBLIC, rel);
  if (!abs.startsWith(PUBLIC + path.sep) || !fs.existsSync(abs)) throw new Error(`not found under public/: ${rel}`);
  return abs;
};

// decode images / frames to small RGB24 pixels (ffmpeg), as 0–1 floats
export function pixels(file, {frames = 0, width = 160} = {}) {
  const args = ['-v', 'error', '-i', file, ...(frames ? ['-vf', `fps=1/2,scale=${width}:-2`, '-frames:v', String(frames)] : ['-vf', `scale=${width}:-2`, '-frames:v', '1']), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'];
  const r = spawnSync('ffmpeg', args, {maxBuffer: 1 << 28});
  if (r.status !== 0) throw new Error(`could not decode ${path.basename(file)}: ${String(r.stderr).trim().split('\n').pop()}`);
  const out = new Float32Array(r.stdout.length);
  for (let i = 0; i < r.stdout.length; i++) out[i] = r.stdout[i] / 255;
  return out;
}
const concat = (arrs) => { const out = new Float32Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };

export function makeLut({name, refs, clips = [], strength = 0.7}) {
  if (!/^[\w-]{1,40}$/.test(name)) throw new Error('LUT name: letters, digits, - and _ (≤ 40)');
  if (!refs?.length) throw new Error('give at least one reference photo');
  if (!clips.length) throw new Error('the project has no clips to measure the footage from');
  progress(10, `Measuring ${refs.length} reference photo(s)`);
  const ref = labStats(concat(refs.map((r) => pixels(inPublic(r)))));
  progress(40, 'Measuring the footage');
  const srcs = [...new Set(clips.map((c) => c.src))];
  const foot = labStats(concat(srcs.map((s) => pixels(inPublic(s), {frames: 12}))));
  progress(80, 'Writing the LUT');
  const file = path.join(PUBLIC, 'luts', `${name}.cube`);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, cubeFromReferences(foot, ref, name, {strength}));
  return `luts/${name}.cube`;
}

export function bake({key, src, lut, mix}) {
  const input = inPublic(src);
  const text = fs.readFileSync(inPublic(lut), 'utf8');
  const cubeText = mix >= 1 ? text : mixCube(parseCube(text), mix);
  parseCube(cubeText); // refuse a broken .cube before ffmpeg does
  const alpha = /\.webm$/i.test(src); // a person matte: VP9 with alpha, as scripts/matte.mjs writes it
  const hash = crypto.createHash('sha1').update(cubeText).update(String(fs.statSync(input).mtimeMs)).update(src).digest('hex').slice(0, 10);
  const rel = `clips/lut/${path.basename(src).replace(/\.[^.]+$/, '')}-${hash}.${alpha ? 'webm' : 'mp4'}`;
  const out = path.join(PUBLIC, rel);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return rel;
  fs.mkdirSync(OUT, {recursive: true});
  const cubeFile = path.join(OUT, `.${hash}.cube`);
  fs.writeFileSync(cubeFile, cubeText);
  const vf = alpha ? `format=rgba,lut3d=file=${cubeFile}:interp=tetrahedral,format=yuva420p` : `lut3d=file=${cubeFile}:interp=tetrahedral,format=yuv420p`;
  const enc = alpha
    ? ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30', '-row-mt', '1', '-an']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart'];
  const tmp = out + '.part' + path.extname(out);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...(alpha ? ['-c:v', 'libvpx-vp9'] : []), '-i', input, '-vf', vf, ...enc, tmp]);
  fs.rmSync(cubeFile, {force: true});
  if (r.status !== 0) { fs.rmSync(tmp, {force: true}); throw new Error(`LUT bake failed for ${path.basename(src)}: ${String(r.stderr).trim().split('\n').pop()}`); }
  fs.renameSync(tmp, out);
  return rel;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const result = {};
  if (job.make) result.lut = makeLut(job.make);
  if (job.bake?.length) {
    result.baked = {};
    job.bake.forEach((b, i) => {
      progress(5 + Math.round((i / job.bake.length) * 90), `Applying ${path.basename(b.lut)} to ${path.basename(b.src)}`);
      result.baked[b.key] = bake(b);
    });
  }
  // argv[3]: where to write the result (the render bakes into its own file; jobs use public/lut.json)
  fs.writeFileSync(process.argv[3] ?? path.join(PUBLIC, 'lut.json'), JSON.stringify(result, null, 2));
  progress(100, 'Done');
}
