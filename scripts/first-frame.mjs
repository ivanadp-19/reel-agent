// A blank first frame: production masters came out with frame 0 a flat, neutral
// field (G1: Y 25/25/25, U = V = 127; G10: Y 8–9) and frame 1 normal footage — one
// generated frame, not content. The render runner checks every Remotion pass right
// after it (the full render, and a master before it enters the cache), repairs it
// by showing frame 1 in its place (same frame count, audio copied, the file's own
// pixel format and color tags), and says so in the job result and the log with what
// the reel had at t = 0. qc.mjs blocks a final that still has one.
//
// Flat = no luma spread and no chroma: YMAX − YMIN ≤ 2 and U, V within 2 of 128.
// Only a flat frame 0 FOLLOWED by a frame that is not flat counts: a reel that opens
// on black on purpose (a fade from black) has a flat frame 1 too and is left alone.
import {spawnSync} from 'node:child_process';

export const FLAT = {ySpread: 2, chroma: 2};

export const isFlat = (s) => !!s && s.ymax - s.ymin <= FLAT.ySpread && Math.abs(s.uavg - 128) <= FLAT.chroma && Math.abs(s.vavg - 128) <= FLAT.chroma;
// [frame 0, frame 1, …] stats → a blank lead frame (frame 0 flat, frame 1 real)
export const blankLead = (stats) => stats.length >= 2 && isFlat(stats[0]) && !isFlat(stats[1]);

// ffmpeg: signalstats of the first n + 1 frames, printed to stdout
export const statsArgs = (file, n = 2) => ['-hide_banner', '-v', 'error', '-i', file, '-an', '-vf', `select='lte(n\\,${n})',signalstats,metadata=print:file=-`, '-f', 'null', '-'];

// the metadata=print output → [{n, ymin, ymax, yavg, uavg, vavg}] in frame order
export function parseStats(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    const f = line.match(/^frame:(\d+)/);
    if (f) { cur = {n: +f[1]}; out.push(cur); continue; }
    const m = line.match(/lavfi\.signalstats\.(YMIN|YMAX|YAVG|UAVG|VAVG)=([\d.]+)/);
    if (m && cur) cur[m[1].toLowerCase()] = +m[2];
  }
  return out.filter((s) => s.ymin != null && s.uavg != null);
}

export function frameStats(file, n = 2) {
  const r = spawnSync('ffmpeg', statsArgs(file, n), {encoding: 'utf8', maxBuffer: 1 << 24});
  return r.status === 0 ? parseStats(r.stdout) : [];
}

// ffmpeg: frame 0 replaced by frame 1 (the stream from frame 1 on, its first frame shown
// twice, renumbered at fps), every other frame and the audio as they were; encoded like a
// master (crf 16) in the file's own pixel format and color tags (layers.mjs probeColor)
export function repairArgs({file, outFile, fps = 30, color = {}, draft = false, crf = 16}) {
  const full = color.range === 'pc';
  const tags = [['-color_range', color.range], ['-colorspace', color.space], ['-color_primaries', color.primaries], ['-color_trc', color.trc]].filter(([, v]) => v && v !== 'unknown').flat();
  return [
    '-hide_banner', '-nostats', '-v', 'error', '-y', '-i', file,
    '-filter_complex', `[0:v]trim=start_frame=1,loop=loop=1:size=1:start=0,settb=1/${fps},setpts=N,format=${full ? 'yuvj420p' : 'yuv420p'}[v]`,
    '-map', '[v]', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', draft ? 'ultrafast' : 'veryfast', '-crf', String(crf), '-video_track_timescale', '90000', ...tags,
    '-c:a', 'copy', '-movflags', '+faststart', outFile,
  ];
}

// what the reel has at t = 0, for the log next to a repair: the evidence to find the cause
export function openingReport(props = {}) {
  const c = props.clips?.[0];
  const at0 = (xs) => (xs ?? []).filter((x) => (x.clipId ? x.clipId === c?.id : x.src === c?.src) && x.startMs <= (c?.inSec ?? 0) * 1000 + 50);
  const g = props.grade;
  return {
    clip: c ? {id: c.id, src: c.src, inSec: c.inSec, speed: c.speed ?? 1, enter: c.enter ?? null, transform: !!c.transform?.length, jSec: c.jSec ?? 0} : null,
    grade: g ? {look: g.look, auto: !!g.auto, lut: g.lut ?? null, media: g.baked && c ? Object.keys(g.baked).filter((k) => k.includes(c.src)) : []} : null,
    pack: props.captionStyle ?? null,
    brolls: at0(props.brolls).map((b) => `${b.id}:${b.mode}${b.enter ? `/${b.enter}` : ''}`),
    graphics: at0(props.graphics).map((x) => `${x.id}:${x.template}${x.template === 'layout' ? `/${x.props?.canvas ?? ''}` : ''}`),
    mattes: (props.mattes ?? []).filter((m) => m.src === c?.src && m.startMs <= (c?.inSec ?? 0) * 1000 + 50).length,
    music: !!props.music,
  };
}
