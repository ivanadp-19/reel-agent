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
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {captionLayout} from '../src/layers.ts';

export const LAYERS_VERSION = 1;
// back to front, as MultiClipVideo stacks them; `captions` is the one layer drawn apart
export const LAYER_ORDER = ['footage', 'focus-pull', 'behind-graphics', 'person-matte', 'broll', 'transitions', 'graphics', 'music', 'sfx', 'captions'];
const CODE_PATHS = ['src', 'remotion.config.ts', 'package-lock.json', 'scripts/layers.mjs', 'scripts/sfx.mjs'];

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
  prores: {ext: 'mov', encode: ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le'], decode: []},
};
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

// what the master draws: the props minus the caption pages, the switch, the render options and voice cleanup
export function masterInputs(props, fps) {
  const {captions, captionsOff, draft, mode, layer, project_id, audio, ...rest} = props;
  const {clean, ...audioRest} = audio ?? {};
  const out = {...rest, audio: audio ? audioRest : null};
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
// the caption layer: PNG frames into a folder (its props carry layer: 'captions'), no audio
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
// full-range master would come out washed out. The master's audio is copied
// (loudness runs on the result). `overlays` is a list so more layers can stack
// later; each is {file, alpha} (png: `file` is the frames folder).
export function compositeArgs({master, overlays, outFile, fps, draft = false, color = {}}) {
  const full = color.range === 'pc';
  const inputs = ['-i', master];
  const renumber = `settb=1/${fps},setpts=N`;
  const chains = [`[0:v]${renumber}[l0]`];
  let last = 'l0';
  overlays.forEach((o, i) => {
    const alpha = o.alpha ?? 'png';
    inputs.push(...(alpha === 'png' ? framesInput(o.file, fps) : [...ALPHA[alpha].decode, '-i', o.file]));
    chains.push(`[${i + 1}:v]${renumber},scale=out_range=${full ? 'pc' : 'tv'},format=yuva420p[o${i}]`, `[${last}][o${i}]overlay=eof_action=pass:format=auto:ts_sync_mode=nearest[l${i + 1}]`);
    last = `l${i + 1}`;
  });
  chains.push(`[${last}]format=${full ? 'yuvj420p' : 'yuv420p'}[v]`);
  const tags = [['-color_range', color.range], ['-colorspace', color.space], ['-color_primaries', color.primaries], ['-color_trc', color.trc]].filter(([, v]) => v && v !== 'unknown').flat();
  return [
    '-hide_banner', '-nostats', '-y', ...inputs,
    '-filter_complex', chains.join(';'),
    '-map', '[v]', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', draft ? 'ultrafast' : 'veryfast', '-crf', String(COMPOSITE_CRF), '-video_track_timescale', '90000', ...tags,
    '-c:a', 'copy', '-movflags', '+faststart', outFile,
  ];
}

// the master's pixel format and color tags, for compositeArgs' `color` (ffprobe)
export function probeColor(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt,color_range,color_space,color_primaries,color_transfer', '-of', 'json', file], {encoding: 'utf8'});
  const st = r.status === 0 ? JSON.parse(r.stdout).streams?.[0] ?? {} : {};
  return {range: st.color_range ?? (st.pix_fmt?.startsWith('yuvj') ? 'pc' : undefined), space: st.color_space, primaries: st.color_primaries, trc: st.color_transfer};
}
