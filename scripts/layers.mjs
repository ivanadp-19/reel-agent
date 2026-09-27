// Layered render: a clean master (everything but the captions) rendered once and
// cached by what it is made of, a transparent caption layer rendered each time,
// and an ffmpeg composite of the two. A caption edit then costs the caption layer
// and the composite instead of the whole reel. Loudness + QC run after, on the
// composite (server/index.mjs). src/layers.ts decides whether a reel can take this
// path (captions that blur or scale the footage, or sit behind the presenter, need
// the one-pass render).
//
// The master key: a sha256 over
//   - the code that draws the picture (src/, the Remotion config, the lockfile that
//     pins Remotion, this file and the SFX synthesizer) — a code change is a new master
//   - the layer order below (the stacking lives in MultiClipVideo, so the code hash
//     covers it; it is written here so the key says so)
//   - fps, frame size, draft scale and the master's encoder settings
//   - every prop the master draws — clips and cuts, B-roll, graphics, mattes, music,
//     brand, grade, caption pack (it also styles titles, B-roll motion and the accent),
//     SFX — with arrays kept in order (their order is z-order and timeline order)
//   - the speech spans the music ducks under, when the music ducks
//   - size + mtime of every public/ file those props name (a clip replaced under the
//     same name is a new master)
// Not in it: the caption pages themselves, the captions switch and voice cleanup
// (applied after the composite).
// A client's master (a final of a project with an identity) draws no text graphic either: its props carry
// textOff (masterProps), which stays in the key — a text-free master is never one with text, and a master
// without identity keeps the key it always had. Nor the solid plates the text graphics sit on (solidPlates):
// in the key only of a master that draws text. Its text graphics are a third layer, the supers
// (scripts/render-runner.mjs), laid between the master and the captions as MultiClipVideo stacks them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {captionLayout} from '../src/layers.ts';

export const LAYERS_VERSION = 1;
// back to front, as MultiClipVideo stacks them; `captions` is the one layer drawn apart
export const LAYER_ORDER = ['footage', 'focus-pull', 'behind-graphics', 'person-matte', 'broll', 'transitions', 'graphics', 'music', 'sfx', 'captions'];
// first-frame.mjs: a master is checked (and repaired) by it before it is cached — a change there is a new master
const CODE_PATHS = ['src', 'remotion.config.ts', 'package-lock.json', 'scripts/layers.mjs', 'scripts/sfx.mjs', 'scripts/first-frame.mjs'];

// master encode: a touch above Remotion's default (crf 18) — the composite encodes it once more
export const MASTER_CRF = 16;
export const COMPOSITE_CRF = 18;
// The caption layer: Chrome draws PNG frames (they keep the alpha); what the composite
// reads them as is `alpha` (REEL_CAPTION_ALPHA): the PNG sequence itself (lossless and
// the fastest — no intermediate encode), or a VP9 yuva420p / ProRes 4444 file encoded
// by ffmpeg from those frames (a single file, for a layer that has to travel).
// Measured in research/layers-benchmark.md: Remotion's own VP9 encode was the slowest
// step of the whole layer, hence the frames-first path.
export const ALPHA = {
  png: {ext: null},
  vp9: {ext: 'webm', encode: ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-crf', '18', '-b:v', '0'], decode: ['-c:v', 'libvpx-vp9']},
  // a delivered file (the pair's captions.mov / supers.mov): Rec.709, tagged (setparams: ffmpeg 8 drops the
  // -colorspace output options here) — an NLE reads untagged HD as 709, and swscale's untagged default (601)
  // turned the kit's #FFE500 into #FFDA00 there
  prores: {ext: 'mov', encode: ['-c:v', 'prores_ks', '-profile:v', '4444', '-vf', 'scale=out_color_matrix=bt709:out_range=tv,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709', '-pix_fmt', 'yuva444p10le'], decode: []},
};
// fps is a Number (src/timeline.ts renderFps): 30000/1001 → '29.97002997002997', which ffmpeg reads as 30000/1001
const framesInput = (dir, fps) => ['-framerate', String(fps), '-pattern_type', 'glob', '-i', path.join(dir, '*.png')];

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}
// the version of the code that draws the picture (content, not mtimes: a checkout does not invalidate)
export function codeVersion(root, paths = CODE_PATHS) {
  const h = crypto.createHash('sha256');
  for (const rel of paths) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    const files = fs.statSync(abs).isDirectory() ? walk(abs, []) : [abs];
    for (const f of files) h.update(path.relative(root, f)).update('\0').update(fs.readFileSync(f)).update('\0');
  }
  return h.digest('hex');
}

// JSON with object keys sorted (arrays keep their order: it means something), undefined dropped
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

// the props of the master pass: no caption page; text: false (a client's deliverables) no text graphic either
export const masterProps = (props, {text = true} = {}) => ({...props, captionsOff: true, ...(text ? {} : {textOff: true})});

// what the master draws: the props minus the caption pages, the switch, the render options and voice cleanup
export function masterInputs(props, fps) {
  const {captions, captionsOff, draft, mode, layer, project_id, audio, solidPlates, ...rest} = props;
  const {clean, ...audioRest} = audio ?? {};
  // solid plates (src/renderProps.ts) are drawn with the text graphics: a text-free master (textOff) keys without them
  const out = {...rest, ...(solidPlates && !rest.textOff ? {solidPlates} : {}), audio: audio ? audioRest : null};
  // a clip's tags (graded, location, piece — src/timeline.ts clipTags) steer validate, the judge and sync_family, never a pixel
  if (rest.clips) out.clips = rest.clips.map(({graded, location, piece, ...c}) => c);
  // the music ducks under the speech spans (src/layers.ts), drawn or not
  if (props.music?.duck) out.duckSpeech = captionLayout(props, fps).speech;
  return out;
}

// size + mtime of every file under publicDir that a string in `obj` names
export function mediaStamps(obj, publicDir) {
  const seen = new Map();
  const visit = (v) => {
    if (typeof v === 'string') {
      if (seen.has(v) || v.length > 512 || /^[a-z]+:/i.test(v) || v.includes('..')) return;
      const abs = path.join(publicDir, v.replace(/^\/+/, ''));
      let st = null;
      try { st = fs.statSync(abs); } catch {}
      if (st?.isFile()) seen.set(v, [st.size, Math.round(st.mtimeMs)]);
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(obj);
  return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function masterKey(props, {code, fps, width = 1080, height = 1920, draft = false, publicDir}) {
  const inputs = masterInputs(props, fps);
  const doc = {v: LAYERS_VERSION, order: LAYER_ORDER, code, fps, width, height, draft, encode: {crf: MASTER_CRF, preset: draft ? 'ultrafast' : 'veryfast', scale: draft ? 0.5 : 1}, inputs, media: publicDir ? mediaStamps(inputs, publicDir) : []};
  return crypto.createHash('sha256').update(canonical(doc)).digest('hex');
}

// ---- the master cache: <dir>/<key>.mp4, least recently used dropped past `maxBytes` ----
export function createMasterCache(dir, maxBytes = (+process.env.REEL_MASTER_CACHE_GB || 4) * 1e9) {
  fs.mkdirSync(dir, {recursive: true});
  const file = (key) => path.join(dir, `${key}.mp4`);
  return {
    dir,
    file,
    get(key) {
      const f = file(key);
      if (!fs.existsSync(f)) return null;
      const now = new Date();
      try { fs.utimesSync(f, now, now); } catch {}
      return f;
    },
    // move a finished master in (same filesystem), then trim the cache
    put(key, src) {
      const f = file(key);
      fs.renameSync(src, f);
      this.trim(key);
      return f;
    },
    trim(keep) {
      const entries = fs.readdirSync(dir).filter((n) => n.endsWith('.mp4') && !n.includes('.part-')).map((n) => {
        const st = fs.statSync(path.join(dir, n));
        return {n, size: st.size, t: st.mtimeMs};
      }).sort((a, b) => b.t - a.t);
      let total = 0;
      for (const e of entries) {
        total += e.size;
        if (total > maxBytes && e.n !== `${keep}.mp4`) fs.rmSync(path.join(dir, e.n), {force: true});
      }
    },
  };
}

// ---- remotion arguments of the two layers ----
const common = ({outFile, propsFile, publicDir, concurrency, cacheBytes, draft}) => [
  'remotion', 'render', 'MultiClip', outFile, `--props=${propsFile}`, `--public-dir=${publicDir}`,
  `--concurrency=${concurrency}`, `--offthreadvideo-cache-size-in-bytes=${cacheBytes}`,
  ...(draft ? ['--scale=0.5'] : []),
];
// the master: the usual h264 export (its props carry captionsOff: true), a lower crf
export const masterArgs = (o) => [...common(o), `--x264-preset=${o.draft ? 'ultrafast' : 'veryfast'}`, `--crf=${MASTER_CRF}`];
// the caption layer: PNG frames into a folder (its props carry layer: 'captions'), no audio — the supers
// layer of a client's deliverables is rendered the same way (layer: 'supers')
export const captionArgs = (o) => [...common(o), '--sequence', '--image-format=png', '--muted'];
// the frames → one VP9 / ProRes file (null for png: the composite reads the frames)
export function alphaEncodeArgs({frames, outFile, alpha, fps}) {
  const a = ALPHA[alpha];
  if (!a?.encode) return null;
  return ['-hide_banner', '-nostats', '-y', ...framesInput(frames, fps), ...a.encode, outFile];
}

// ffmpeg: the layers over the master, frame by frame. Every stream is put on one
// timebase of a frame (settb=1/fps) and renumbered by frame index (setpts=N), and the
// overlay pairs equal timestamps (ts_sync_mode=nearest). Without both, WebM's ms
// timestamps (66.667 ms stored as 67) or framesync's default mode paired master
// frame n with layer frame n-1 at some page changes: a caption one frame late,
// measured on the bench reel (research/layers-benchmark.md).
// The result keeps the master's pixel format and color tags (`color`, from
// probeColor: Remotion writes full-range yuvj420p tagged bt470bg), and each layer is
// converted into that range before the overlay — a limited-range layer over a
// full-range master would come out washed out — and into the master's matrix, named (601 when the
// master is untagged, as ffmpeg reads it): unnamed, ffmpeg 5 keeps a tagged layer's own (the ProRes
// layers are 709). The master's audio is copied (loudness runs on the result). `overlays` is a list so more layers can stack
// later; each is {file, alpha} (png: `file` is the frames folder).
export function compositeArgs({master, overlays, outFile, fps, draft = false, color = {}}) {
  const full = color.range === 'pc';
  const matrix = {bt709: 'bt709', bt2020nc: 'bt2020'}[color.space] ?? 'bt601';
  const inputs = ['-i', master];
  const renumber = `settb=1/${fps},setpts=N`;
  // a full-range master goes into the overlay as yuva420p holding its full-range values, and back out to yuvj420p
  // the same way: ffmpeg < 7.1's overlay takes no yuvj420p main, and the conversion it inserts squeezed the master
  // to limited range, the full-range layer blended into it and the whole stretched back (#FFE500: Y 227, not 211)
  const keep = 'scale=in_range=pc:out_range=pc';
  const chains = [`[0:v]${renumber}${full ? `,${keep},format=yuva420p` : ''}[l0]`];
  let last = 'l0';
  overlays.forEach((o, i) => {
    const alpha = o.alpha ?? 'png';
    inputs.push(...(alpha === 'png' ? framesInput(o.file, fps) : [...ALPHA[alpha].decode, '-i', o.file]));
    chains.push(`[${i + 1}:v]${renumber},scale=out_color_matrix=${matrix}:out_range=${full ? 'pc' : 'tv'},format=yuva420p[o${i}]`, `[${last}][o${i}]overlay=eof_action=pass:format=auto:ts_sync_mode=nearest[l${i + 1}]`);
    last = `l${i + 1}`;
  });
  chains.push(`[${last}]${full ? `${keep},format=yuvj420p` : 'format=yuv420p'}[v]`);
  const tags = [['-color_range', color.range], ['-colorspace', color.space], ['-color_primaries', color.primaries], ['-color_trc', color.trc]].filter(([, v]) => v && v !== 'unknown').flat();
  return [
    '-hide_banner', '-nostats', '-y', ...inputs,
    '-filter_complex', chains.join(';'),
    '-map', '[v]', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', draft ? 'ultrafast' : 'veryfast', '-crf', String(COMPOSITE_CRF), '-video_track_timescale', '90000', ...tags,
    '-c:a', 'copy', '-movflags', '+faststart', outFile,
  ];
}

// ---- the delivered pair (a final of a project with an identity: scripts/render-runner.mjs, reviews.mjs) ----
// the master deliverable: the cached master's picture + the composite's finished audio (loudness + QC
// done), both copied — no re-encode
export const remuxArgs = ({video, audio, outFile}) => ['-hide_banner', '-nostats', '-y', '-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', outFile];
// frames, rate and length of a file's picture: mp4 and mov carry the frame count in their header (no decode)
export const parityProbeArgs = (file) => ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames,r_frame_rate,duration', '-of', 'json', file];
export function parseParity(stdout) {
  const s = JSON.parse(stdout).streams?.[0] ?? {};
  return {frames: +s.nb_frames, fps: s.r_frame_rate ?? null, sec: +s.duration};
}
// the master and another deliverable (`name`: the caption layer, the supers, master_supers) must lay over
// each other frame for frame, at the delivery fps when given (src/timeline.ts deliveryFps) → [] or what
// differs. Rates compare as numbers ('60000/2002' is '30000/1001'); the length within half a frame: the
// containers keep time on different scales
export const rateOf = (r) => { const [n, d = 1] = String(r).split('/').map(Number); return n > 0 && d > 0 ? n / d : NaN; };
const rateText = (fps) => (Math.abs(fps - 30000 / 1001) < 1e-9 ? '30000/1001' : String(fps));
export function parityIssues(master, layer, {fps, name = 'captions'} = {}) {
  const out = [];
  if (!(master.frames > 0) || master.frames !== layer.frames) out.push(`frames: master ${master.frames}, ${name} ${layer.frames}`);
  const rate = rateOf(master.fps);
  if (!(Math.abs(rate - rateOf(layer.fps)) < 1e-6)) out.push(`fps: master ${master.fps}, ${name} ${layer.fps}`);
  else if (fps && !(Math.abs(rate - fps) < 1e-6)) out.push(`fps: ${master.fps}, want ${rateText(fps)}`);
  if (!(Math.abs(master.sec - layer.sec) < 0.5 / rate)) out.push(`duration: master ${master.sec}s, ${name} ${layer.sec}s`);
  return out;
}

// ---- stored zips: the caption layer's PNG sequence (zipFrames) and the pair download (server/review.mjs) ----
// A plain zip, stored (a PNG or a video is compressed already), so at most 65 535 entries and 4 GB — past that it fails
// with the reason. zipLocal: an entry's local header (+ name), its data follows; zipCentral: the directory and its end,
// from the entries with the offset each was written at. ponytail: ZIP64 when a layer or a pair outgrows it.
const DATE = 0x21; // 1980-01-01: the same bytes for the same files
export function zipLocal({name, size, crc}) {
  const n = Buffer.from(name), h = Buffer.alloc(30); // version 2.0, no flags, stored
  h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(DATE, 12); h.writeUInt32LE(crc >>> 0, 14);
  h.writeUInt32LE(size, 18); h.writeUInt32LE(size, 22); h.writeUInt16LE(n.length, 26);
  return Buffer.concat([h, n]);
}
export function zipCentral(entries, at) {
  if (entries.length > 0xffff) throw new Error(`zip: ${entries.length} entries, a plain zip holds 65 535`);
  const cd = Buffer.concat(entries.flatMap(({name, crc, size, at: off}) => {
    const n = Buffer.from(name), c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(DATE, 14); c.writeUInt32LE(crc >>> 0, 16);
    c.writeUInt32LE(size, 20); c.writeUInt32LE(size, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    return [c, n];
  }));
  if (at + cd.length > 0xffffffff) throw new Error(`zip: ${Math.round(at / 2 ** 20)} MB, a plain zip holds 4 GB`);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(at, 16);
  return Buffer.concat([cd, end]);
}
// the caption layer as a PNG sequence (CEO-14): the pass's frames zipped with fps.json, the rate to import them at
const PNG = /\.png$/i;
export async function zipFrames(dir, outFile, {fps}) {
  const names = fs.readdirSync(dir).filter((n) => PNG.test(n)).sort(); // the order ffmpeg's glob reads them in
  const entries = [...names.map((n, i) => ({name: `captions_${String(i).padStart(6, '0')}.png`, file: path.join(dir, n)})),
    {name: 'fps.json', data: Buffer.from(JSON.stringify({fps: rateText(fps), frames: names.length}))}];
  if (entries.length > 0xffff) throw new Error(`captions PNG zip: ${names.length} frames, a plain zip holds 65 534`);
  const fh = await fs.promises.open(outFile, 'w');
  const central = [];
  let at = 0;
  try {
    for (const e of entries) {
      const data = e.data ?? await fs.promises.readFile(e.file);
      const x = {name: e.name, crc: zlib.crc32(data), size: data.length, at};
      await fh.write(Buffer.concat([zipLocal(x), data]));
      central.push(x);
      at += 30 + Buffer.byteLength(e.name) + data.length;
    }
    await fh.write(zipCentral(central, at));
  } finally { await fh.close(); }
}
// the zip's side of parityIssues: its PNG frames (central directory) and the rate its fps.json says — no extraction
export async function zipParity(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const {size} = await fh.stat();
    const read = async (at, n) => { const b = Buffer.alloc(n); await fh.read(b, 0, n, at); return b; };
    const end = await read(Math.max(0, size - 22), 22);
    if (end.readUInt32LE(0) !== 0x06054b50) throw new Error(`${path.basename(file)}: no zip directory at its end`);
    const cd = await read(end.readUInt32LE(16), end.readUInt32LE(12));
    let frames = 0, sidecar = null;
    for (let o = 0; o + 46 <= cd.length;) {
      const n = cd.readUInt16LE(o + 28), name = cd.toString('utf8', o + 46, o + 46 + n);
      if (PNG.test(name)) frames++;
      else if (name === 'fps.json') sidecar = {at: cd.readUInt32LE(o + 42), size: cd.readUInt32LE(o + 20)};
      o += 46 + n + cd.readUInt16LE(o + 30) + cd.readUInt16LE(o + 32);
    }
    let fps = null;
    if (sidecar) { const h = await read(sidecar.at, 30); fps = JSON.parse(await read(sidecar.at + 30 + h.readUInt16LE(26) + h.readUInt16LE(28), sidecar.size)).fps ?? null; }
    return {frames, fps, sec: frames / rateOf(fps)};
  } finally { await fh.close(); }
}

// the master's pixel format and color tags, for compositeArgs' `color` (ffprobe)
export function probeColor(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt,color_range,color_space,color_primaries,color_transfer', '-of', 'json', file], {encoding: 'utf8'});
  const st = r.status === 0 ? JSON.parse(r.stdout).streams?.[0] ?? {} : {};
  return {range: st.color_range ?? (st.pix_fmt?.startsWith('yuvj') ? 'pc' : undefined), space: st.color_space, primaries: st.color_primaries, trc: st.color_transfer};
}
